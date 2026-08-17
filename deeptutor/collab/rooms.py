"""In-memory rooms for real-time annotation sync (single-instance).

A room is the authoritative live state for one share: it owns ``revision``
(monotonic op sequence), the live-items map, and the connected members. Ops are
assigned a ``seq``, appended to disk, then broadcast to every member. Presence
(scroll / cursor / tool) is ephemeral and never persisted.

The registry is process-local, matching the Phase-1 single-worker deployment.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from fastapi import WebSocket

from deeptutor.collab.models import AnnotationOp, CollabDocument
from deeptutor.collab.storage import CollabStorage, get_collab_storage

logger = logging.getLogger(__name__)

_PRESENCE_KINDS = {"scroll", "cursor", "tool"}


class Member:
    __slots__ = ("member_id", "ws", "display_name", "is_owner", "presence", "closed")

    def __init__(self, member_id: str, ws: WebSocket, display_name: str, is_owner: bool) -> None:
        self.member_id = member_id
        self.ws = ws
        self.display_name = display_name or "匿名"
        self.is_owner = is_owner
        self.presence: dict[str, Any] = {}
        self.closed = False

    def role(self, allow_edit: bool) -> str:
        if self.is_owner:
            return "owner"
        return "editor" if allow_edit else "viewer"


class Room:
    def __init__(self, doc: CollabDocument, storage: CollabStorage) -> None:
        self.doc = doc
        self.storage = storage
        self.revision, self.live = storage.rebuild_state(doc.share_token)
        # Keep the manifest revision in lock-step with the reconstructed log.
        if self.revision != doc.revision:
            doc.revision = self.revision
            doc.updated_at = time.time()
            storage.save_manifest(doc)
        self.members: dict[str, Member] = {}
        self.presenter_id: str | None = None
        self._seq_lock = asyncio.Lock()
        self._flush_task: asyncio.Task[None] | None = None
        self._dirty = False

    # ── Membership ───────────────────────────────────────────────────────

    async def join(
        self, member_id: str, ws: WebSocket, display_name: str, is_owner: bool
    ) -> dict[str, Any]:
        member = Member(member_id, ws, display_name, is_owner)
        self.members[member_id] = member
        # The presenter (whose scroll everyone follows) defaults to the owner.
        if self.presenter_id is None and is_owner:
            self.presenter_id = member_id
        await self._broadcast(
            {
                "type": "member_join",
                "member_id": member_id,
                "display_name": member.display_name,
                "role": member.role(self.doc.permissions.allow_edit),
            },
            exclude=member_id,
        )
        return self.welcome(member)

    def welcome(self, member: Member) -> dict[str, Any]:
        return {
            "type": "welcome",
            "doc": self.doc.public_dict(),
            "revision": self.revision,
            "snapshot": {k: v.as_dict() for k, v in self.live.items()},
            "role": member.role(self.doc.permissions.allow_edit),
            "member_id": member.member_id,
            "presenter_id": self.presenter_id,
            "members": [
                {
                    "member_id": m.member_id,
                    "display_name": m.display_name,
                    "role": m.role(self.doc.permissions.allow_edit),
                    "presence": m.presence,
                }
                for m in self.members.values()
            ],
        }

    async def leave(self, member_id: str) -> None:
        member = self.members.pop(member_id, None)
        if member is None:
            return
        # If the presenter left, hand the role back to the owner (or the first
        # remaining member) so scroll-follow keeps working.
        if self.presenter_id == member_id:
            self.presenter_id = self._next_presenter(member_id)
            if self.presenter_id is not None:
                await self._broadcast(
                    {
                        "type": "presenter_changed",
                        "presenter_id": self.presenter_id,
                        "display_name": self.members[self.presenter_id].display_name,
                    },
                    exclude=None,
                )
        await self._broadcast(
            {"type": "member_leave", "member_id": member_id}, exclude=member_id
        )

    def _next_presenter(self, leaving_id: str) -> str | None:
        for m in self.members.values():
            if m.is_owner:
                return m.member_id
        for m in self.members.values():
            if m.member_id != leaving_id:
                return m.member_id
        return None

    @property
    def empty(self) -> bool:
        return not self.members

    # ── Ops ──────────────────────────────────────────────────────────────

    async def handle_op(self, author: Member, raw: dict[str, Any]) -> dict[str, Any] | None:
        # Server-enforced write gate: only owner/editor may annotate.
        if author.role(self.doc.permissions.allow_edit) not in {"owner", "editor"}:
            return {"type": "error", "code": "readonly", "message": "文档为只读，仅可查看"}

        async with self._seq_lock:
            self.revision += 1
            seq = self.revision
            op = AnnotationOp(
                seq=seq,
                id=raw.get("id") or _new_op_id(),
                kind=raw.get("kind") or "ink",
                page=int(raw.get("page") or 0),
                author=author.member_id,
                author_name=author.display_name,
                color=raw.get("color") or "#e11d48",
                width=float(raw.get("width") or 2.0),
                opacity=float(raw.get("opacity") or 0.9),
                points=raw.get("points") or [],
                text=raw.get("text") or "",
                target=raw.get("target"),
                created_at=time.time(),
            )
            # Apply + persist (sync, on the loop, serialized by the lock).
            _apply(self.live, op)
            self.storage.append_op(self.doc.share_token, op)
            self.doc.revision = seq
            self.doc.updated_at = time.time()
            self._schedule_flush()

        payload = {"type": "op", "seq": seq, "op": op.as_dict()}
        await self._broadcast(payload, exclude=None)  # echo back to author too
        return None

    async def update_permissions(self, *, allow_edit: bool | None = None) -> dict[str, Any]:
        if allow_edit is not None:
            self.doc.permissions.allow_edit = allow_edit
        self.doc.updated_at = time.time()
        self.storage.save_manifest(self.doc)
        perm = self.doc.public_dict()["permissions"]
        # Re-broadcast each member's effective role so the client can flip its
        # editing affordances immediately.
        roles = {
            m.member_id: m.role(self.doc.permissions.allow_edit) for m in self.members.values()
        }
        await self._broadcast(
            {"type": "permission_changed", "permissions": perm, "roles": roles},
            exclude=None,
        )
        return perm

    # ── Presence ─────────────────────────────────────────────────────────

    async def handle_presence(self, author: Member, raw: dict[str, Any]) -> None:
        kind = raw.get("kind")
        author.presence["kind"] = kind
        for key in ("page", "scroll_ratio", "scale", "tool", "x", "y"):
            if key in raw:
                author.presence[key] = raw[key]
        await self._broadcast(
            {
                "type": "presence",
                "member_id": author.member_id,
                "presence": author.presence,
            },
            exclude=author.member_id,
        )

    async def set_presenter(self, member_id: str) -> dict[str, Any] | None:
        """Make *member_id* the presenter whose scroll everyone follows."""
        if member_id not in self.members:
            return {"type": "error", "code": "bad_presenter", "message": "Presenter not in room"}
        self.presenter_id = member_id
        await self._broadcast(
            {
                "type": "presenter_changed",
                "presenter_id": member_id,
                "display_name": self.members[member_id].display_name,
            },
            exclude=None,
        )
        return None

    async def clear_annotations(self, author: Member) -> dict[str, Any] | None:
        """Owner-only: wipe all annotations and notify every client."""
        if not author.is_owner:
            return {"type": "error", "code": "owner_required", "message": "仅分享者可清除批注"}
        self.live.clear()
        self.revision = 0
        self.doc.revision = 0
        self.doc.updated_at = time.time()
        self.storage.clear_annotations(self.doc.share_token)
        await self._broadcast({"type": "annotations_cleared", "revision": 0}, exclude=None)
        return None

    # ── Broadcast helpers ────────────────────────────────────────────────

    async def _broadcast(self, payload: dict[str, Any], exclude: str | None) -> None:
        text = json.dumps(payload, ensure_ascii=False, default=str)
        targets = [m for mid, m in self.members.items() if mid != exclude]
        if not targets:
            return
        results = await asyncio.gather(
            *(_send_text(m, text) for m in targets), return_exceptions=True
        )
        # Drop members whose socket died mid-send; their leave is handled by the
        # WS handler's disconnect cleanup, but this prunes sooner.
        for m, res in zip(targets, results):
            if isinstance(res, Exception) or res is False:
                m.closed = True

    def _schedule_flush(self) -> None:
        self._dirty = True
        if self._flush_task is None or self._flush_task.done():
            self._flush_task = asyncio.create_task(self._flush_later())

    async def _flush_later(self) -> None:
        try:
            await asyncio.sleep(1.0)
            if not self._dirty:
                return
            self._dirty = False
            # Persist manifest (revision/updated_at) + compacted snapshot.
            self.storage.save_manifest(self.doc)
            self.storage.save_snapshot(
                self.doc.share_token,
                revision=self.revision,
                items={k: v.as_dict() for k, v in self.live.items()},
            )
        except Exception:
            logger.exception("collab room flush failed for %s", self.doc.share_token)

    async def flush(self) -> None:
        if self._flush_task is not None:
            try:
                await self._flush_task
            except Exception:
                pass
        if self._dirty:
            self._dirty = False
            self.storage.save_manifest(self.doc)
            self.storage.save_snapshot(
                self.doc.share_token,
                revision=self.revision,
                items={k: v.as_dict() for k, v in self.live.items()},
            )


async def _send_text(member: Member, text: str) -> bool:
    if member.closed:
        return False
    try:
        await member.ws.send_text(text)
        return True
    except Exception:
        member.closed = True
        return False


def _new_op_id() -> str:
    import uuid

    return "a_" + uuid.uuid4().hex[:12]


def _apply(live: dict[str, AnnotationOp], op: AnnotationOp) -> None:
    if op.kind == "erase":
        if op.target and op.target in live:
            del live[op.target]
        return
    if op.deleted:
        live.pop(op.id, None)
        return
    live[op.id] = op


class RoomRegistry:
    def __init__(self) -> None:
        self._rooms: dict[str, Room] = {}
        self._storage = get_collab_storage()

    def get_or_create(self, doc: CollabDocument) -> Room:
        room = self._rooms.get(doc.share_token)
        if room is None:
            room = Room(doc, self._storage)
            self._rooms[doc.share_token] = room
        return room

    def get(self, token: str) -> Room | None:
        return self._rooms.get(token)

    def load(self, token: str) -> Room | None:
        doc = self._storage.load_manifest(token)
        if doc is None:
            return None
        return self.get_or_create(doc)

    async def remove_if_empty(self, token: str) -> None:
        room = self._rooms.get(token)
        if room is not None and room.empty:
            await room.flush()
            self._rooms.pop(token, None)

    async def evict(self, token: str) -> None:
        """Drop a room unconditionally — used when its share is deleted, so a
        deleted share leaves no in-memory residue even if members are still
        connected. Their subsequent ops no-op until they disconnect."""
        room = self._rooms.pop(token, None)
        if room is not None:
            await room.flush()


_registry: RoomRegistry | None = None


def get_room_registry() -> RoomRegistry:
    global _registry
    if _registry is None:
        _registry = RoomRegistry()
    return _registry


__all__ = ["Room", "RoomRegistry", "get_room_registry"]
