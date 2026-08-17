"""Collaborative annotation over generated documents (Phase 1: PDF).

REST — create / read / update / delete a share and its permissions, plus the
owner-only export (bakes annotations into a new PDF) and download.

WebSocket — the room sync channel: ``join`` / ``op`` / ``presence`` in,
``welcome`` / ``op`` / ``presence`` / ``member_*`` / ``permission_changed`` out.

Security model (Phase 1, public-by-default):
- ``share_token`` (in the link) grants view + (when allowed) annotate.
- ``owner_token`` (returned only to the creator) grants owner powers —
  permission toggles, export, download, delete. It is compared with a constant-
  time check and never returned from public metadata endpoints.
"""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import re
import secrets
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel

from deeptutor.collab.convert import convert_to_pdf, is_pdf_source, soffice_path
from deeptutor.collab.export import export_annotated_pdf
from deeptutor.collab.models import AnnotationOp, SourceInfo
from deeptutor.collab.rooms import get_room_registry
from deeptutor.collab.storage import get_collab_storage
from deeptutor.multi_user.context import get_current_user_or_none
from deeptutor.services.path_service import get_path_service
from deeptutor.services.storage import LocalDiskAttachmentStore, get_attachment_store

router = APIRouter()
# WS upgrades can't use HTTP-style dependency injection (see unified_ws), so the
# room endpoint lives on its own router, registered without the ``_auth`` guard.
ws_router = APIRouter()
logger = logging.getLogger(__name__)

_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def _new_token() -> str:
    return secrets.token_urlsafe(16)


def _validate_token(token: str) -> str:
    if not _TOKEN_RE.fullmatch(token or ""):
        raise HTTPException(status_code=404, detail="Share not found")
    return token


def _owner_is(auth: str | None, doc) -> bool:
    return bool(auth) and secrets.compare_digest(auth, doc.owner_token)


def _content_disposition(filename: str, *, disposition: str = "inline") -> str:
    ascii_fallback = filename.encode("ascii", errors="replace").decode("ascii")
    ascii_fallback = ascii_fallback.replace('"', "_").replace("\\", "_")
    encoded = quote(filename, safe="")
    return f"{disposition}; filename=\"{ascii_fallback}\"; filename*=UTF-8''{encoded}"


# ── Source resolution (security-critical) ────────────────────────────────

def resolve_source_path(doc) -> Path | None:
    """Map a share's ``source.url`` back to a real file, reusing the same
    guards the public endpoints apply (no path traversal)."""
    url = doc.source.url or ""
    kind = doc.source.kind
    if kind == "outputs" or url.startswith("/api/outputs/"):
        rel = url.split("/api/outputs/", 1)[1] if "/api/outputs/" in url else url
        return get_path_service().resolve_public_output_path(unquote(rel))
    if kind == "attachment" or url.startswith("/api/attachments/"):
        rest = url.split("/api/attachments/", 1)[1]
        parts = rest.split("/", 2)
        if len(parts) < 3:
            return None
        session_id, attachment_id, filename = unquote(parts[0]), unquote(parts[1]), unquote(parts[2])
        store = get_attachment_store()
        if isinstance(store, LocalDiskAttachmentStore):
            return store.resolve_path(
                session_id=session_id, attachment_id=attachment_id, filename=filename
            )
        return None
    return None


def _live_items(doc) -> dict[str, AnnotationOp]:
    room = get_room_registry().get(doc.share_token)
    if room is not None:
        return dict(room.live)
    _rev, live = get_collab_storage().rebuild_state(doc.share_token)
    return live


# Per-share conversion locks. LibreOffice cannot run two headless conversions
# against the same profile concurrently — two clients hitting `/source` for an
# unconverted DOCX would both spawn soffice and hang each other. Serialise the
# conversion per share (the second caller waits, then reuses the cache).
_convert_locks: dict[str, asyncio.Lock] = {}


def _convert_lock(token: str) -> asyncio.Lock:
    lock = _convert_locks.get(token)
    if lock is None:
        lock = asyncio.Lock()
        _convert_locks[token] = lock
    return lock


async def _pdf_for_doc(doc) -> Path | None:
    """Resolve the annotation canvas: the source if already PDF, else a cached
    LibreOffice conversion (serialised per share). Returns ``None`` when the
    source is missing or the conversion is impossible."""
    source = resolve_source_path(doc)
    if source is None:
        return None
    if is_pdf_source(doc.source.mime, doc.source.filename):
        return source
    out_dir = get_collab_storage().share_root(doc.share_token)
    cache = out_dir / (source.stem + ".pdf")
    if cache.is_file():
        return cache
    async with _convert_lock(doc.share_token):
        # Re-check the cache now that we hold the lock (another caller may have
        # produced it while we waited).
        if cache.is_file():
            return cache
        return await asyncio.to_thread(convert_to_pdf, source, out_dir)


def _convert_help(doc) -> str:
    if not soffice_path():
        return (
            "此文档为 Word（.docx）格式，批注需要先用 LibreOffice 转成 PDF。"
            "请在终端运行 `brew install --cask libreoffice` 后重启 DeepTutor。"
        )
    return "文档转换失败，请稍后重试。"


# ── Request models ──────────────────────────────────────────────────────

class ShareCreateRequest(BaseModel):
    source: dict[str, Any] = {}
    title: str | None = None
    allow_edit: bool = False
    force_new: bool = False


class ShareUpdateRequest(BaseModel):
    allow_edit: bool | None = None
    title: str | None = None
    owner_token: str | None = None


# ── REST ─────────────────────────────────────────────────────────────────

@router.post("/shares")
async def create_share(request: ShareCreateRequest) -> dict[str, Any]:
    storage = get_collab_storage()
    source_raw = request.source or {}
    url = str(source_raw.get("url") or "")
    kind = str(source_raw.get("kind") or "")
    if kind not in {"attachment", "outputs"}:
        raise HTTPException(status_code=400, detail="Unsupported source kind (Phase 1: attachment/outputs)")
    if not url:
        raise HTTPException(status_code=400, detail="source.url is required")

    # De-duplicate: one document → one stable share link. Reuse an existing
    # share for the same source so repeated "share" clicks don't mint new links.
    # `force_new` opts out (e.g. "new link" in the management page) so the same
    # document can be shared with different groups as independent copies.
    if not request.force_new:
        existing = storage.find_by_source_url(url)
        if existing is not None:
            return {
                "share_token": existing.share_token,
                "owner_token": existing.owner_token,
                "url": f"/share/{existing.share_token}",
                "doc": existing.public_dict(),
            }

    share_token = _new_token()
    owner_token = _new_token()

    user = get_current_user_or_none()
    owner_user_id = getattr(user, "id", "") if user else ""
    owner_display_name = getattr(user, "username", "") if user else ""

    filename = str(source_raw.get("filename") or "document")
    mime = str(source_raw.get("mime") or "") or (mimetypes.guess_type(filename)[0] or "application/octet-stream")

    doc = storage.create_share(
        share_token=share_token,
        owner_token=owner_token,
        title=request.title or filename,
        source=SourceInfo(kind=kind, url=url, filename=filename, mime=mime),
        owner_user_id=owner_user_id,
        owner_display_name=owner_display_name,
        allow_edit=request.allow_edit,
    )
    # Validate the source is actually servable before handing out a dead link.
    if resolve_source_path(doc) is None:
        storage.delete_share(share_token)
        raise HTTPException(status_code=400, detail="Source file is not servable")

    return {
        "share_token": share_token,
        "owner_token": owner_token,
        "url": f"/share/{share_token}",
        "doc": doc.public_dict(),
    }


@router.get("/shares")
async def list_shares() -> dict[str, Any]:
    storage = get_collab_storage()
    shares: list[dict[str, Any]] = []
    for doc in _iter_documents(storage):
        shares.append(doc.public_dict())
    shares.sort(key=lambda s: s["updated_at"], reverse=True)
    return {"shares": shares}


@router.get("/shares/manage")
async def list_shares_manage() -> dict[str, Any]:
    """Owner management list — includes ``owner_token`` so the local owner can
    delete shares from the "My shares" page. Single-user local only; in a
    multi-user deployment this must be scoped to the authenticated owner."""
    storage = get_collab_storage()
    shares: list[dict[str, Any]] = []
    for doc in _iter_documents(storage):
        item = doc.public_dict()
        item["owner_token"] = doc.owner_token
        item["source_url"] = doc.source.url
        shares.append(item)
    shares.sort(key=lambda s: s["updated_at"], reverse=True)
    return {"shares": shares}


@router.get("/shares/{token}")
async def get_share(token: str) -> dict[str, Any]:
    token = _validate_token(token)
    doc = get_collab_storage().load_manifest(token)
    if doc is None:
        raise HTTPException(status_code=404, detail="Share not found")
    return doc.public_dict()


@router.patch("/shares/{token}")
async def update_share(token: str, request: ShareUpdateRequest) -> dict[str, Any]:
    token = _validate_token(token)
    storage = get_collab_storage()
    registry = get_room_registry()
    room = registry.get(token)
    doc = room.doc if room else storage.load_manifest(token)
    if doc is None:
        raise HTTPException(status_code=404, detail="Share not found")
    if not _owner_is(request.owner_token, doc):
        raise HTTPException(status_code=403, detail="Owner required")

    if request.title is not None:
        doc.title = request.title.strip() or doc.title
        doc.updated_at = time.time()
        storage.save_manifest(doc)

    if room is not None:
        return await room.update_permissions(allow_edit=request.allow_edit)

    if request.allow_edit is not None:
        doc.permissions.allow_edit = request.allow_edit
    doc.updated_at = time.time()
    storage.save_manifest(doc)
    return doc.public_dict()["permissions"]


@router.delete("/shares/{token}")
async def delete_share(token: str, owner_token: str | None = None) -> dict[str, bool]:
    token = _validate_token(token)
    storage = get_collab_storage()
    doc = storage.load_manifest(token)
    if doc is None:
        raise HTTPException(status_code=404, detail="Share not found")
    if not _owner_is(owner_token, doc):
        raise HTTPException(status_code=403, detail="Owner required")
    deleted = storage.delete_share(token)
    # Evict any live room so a deleted share leaves no memory residue.
    await get_room_registry().evict(token)
    return {"deleted": deleted}


@router.get("/shares/{token}/source")
async def share_source(token: str):
    """Rendered PDF bytes for annotation (any participant with the token).

    Non-PDF sources (DOCX/PPTX/…) are converted once via LibreOffice and
    cached, so the annotation canvas is always PDF page space.
    """
    token = _validate_token(token)
    doc = get_collab_storage().load_manifest(token)
    if doc is None:
        raise HTTPException(status_code=404, detail="Share not found")
    path = await _pdf_for_doc(doc)
    if path is None:
        raise HTTPException(status_code=503, detail=_convert_help(doc))
    return FileResponse(
        path=str(path),
        media_type="application/pdf",
        headers={"Cache-Control": "private, max-age=0, must-revalidate"},
    )


@router.post("/shares/{token}/export")
async def export_share(token: str, owner_token: str | None = None):
    """Owner-only: bake all annotations into a new PDF."""
    token = _validate_token(token)
    storage = get_collab_storage()
    doc = storage.load_manifest(token)
    if doc is None:
        raise HTTPException(status_code=404, detail="Share not found")
    if not _owner_is(owner_token, doc):
        raise HTTPException(status_code=403, detail="Owner required")
    return await _merged_pdf_response(doc, disposition="attachment")


@router.get("/shares/{token}/download")
async def download_share(token: str, owner_token: str | None = None):
    """Owner-only: download the merged (annotated) PDF."""
    token = _validate_token(token)
    storage = get_collab_storage()
    doc = storage.load_manifest(token)
    if doc is None:
        raise HTTPException(status_code=404, detail="Share not found")
    if not _owner_is(owner_token, doc):
        raise HTTPException(status_code=403, detail="Owner required")
    return await _merged_pdf_response(doc, disposition="attachment")


async def _merged_pdf_response(doc, *, disposition: str) -> FileResponse:
    source = await _pdf_for_doc(doc)
    if source is None:
        raise HTTPException(status_code=503, detail=_convert_help(doc))
    out_dir = get_collab_storage().share_root(doc.share_token)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"export_r{doc.revision}.pdf"
    export_annotated_pdf(source, _live_items(doc), out_path)
    base = (doc.source.filename or "document")
    if not base.lower().endswith(".pdf"):
        base += ".pdf"
    filename = f"{Path(base).stem}_批注版.pdf"
    return FileResponse(
        path=str(out_path),
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition(filename, disposition=disposition)},
    )


def _iter_documents(storage):
    root = storage.shares_root()
    if not root.exists():
        return []
    for child in sorted(root.iterdir()):
        if not child.is_dir() or not child.name.startswith("share_"):
            continue
        token = child.name[len("share_"):]
        doc = storage.load_manifest(token)
        if doc is not None:
            yield doc


# ── WebSocket room ───────────────────────────────────────────────────────

@ws_router.websocket("/ws")
async def collab_ws(ws: WebSocket) -> None:
    await ws.accept()
    registry = get_room_registry()
    storage = get_collab_storage()
    member_id = uuid.uuid4().hex[:12]
    joined_token: str | None = None
    closed = False

    async def send(payload: dict[str, Any]) -> None:
        nonlocal closed
        if closed:
            return
        try:
            await ws.send_text(json.dumps(payload, ensure_ascii=False, default=str))
        except Exception:
            closed = True

    async def close_error(code: str, message: str) -> None:
        await send({"type": "error", "code": code, "message": message})
        try:
            await ws.close(code=4401)
        except Exception:
            pass

    try:
        while not closed:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            mtype = msg.get("type")

            if mtype == "ping":
                await send({"type": "pong"})
                continue

            if mtype == "join":
                token = _validate_token(str(msg.get("token") or ""))
                doc = storage.load_manifest(token)
                if doc is None:
                    await close_error("not_found", "Share not found")
                    break
                room = registry.get_or_create(doc)
                is_owner = bool(msg.get("owner_token")) and secrets.compare_digest(
                    str(msg.get("owner_token")), doc.owner_token
                )
                display_name = str(msg.get("display_name") or "匿名")
                welcome = await room.join(member_id, ws, display_name, is_owner)
                await send(welcome)
                joined_token = token
                continue

            if joined_token is None:
                continue
            room = registry.get(joined_token)
            if room is None:
                continue
            member = room.members.get(member_id)
            if member is None:
                continue

            if mtype == "op":
                error = await room.handle_op(member, msg)
                if error is not None:
                    await send(error)
            elif mtype == "presence":
                await room.handle_presence(member, msg)
            elif mtype == "set_presenter":
                error = await room.set_presenter(member.member_id)
                if error is not None:
                    await send(error)
            elif mtype == "clear_annotations":
                error = await room.clear_annotations(member)
                if error is not None:
                    await send(error)
            elif mtype == "leave":
                break
    except WebSocketDisconnect:
        pass
    finally:
        if joined_token is not None:
            room = registry.get(joined_token)
            if room is not None:
                await room.leave(member_id)
                await registry.remove_if_empty(joined_token)
