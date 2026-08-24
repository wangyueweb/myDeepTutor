"""File-system persistence for collaborative annotation shares.

Layout (relative to the user workspace)::

    workspace/collab/shares/
    └── share_<token>/
        ├── manifest.json        # CollabDocument + permissions (+ owner_token)
        ├── annotations.jsonl    # append-only op log (source of truth for ops)
        └── snapshot.json        # compacted live items + revision (fast cold join)

The jsonl is only ever appended, never rewritten; the snapshot is rewritten on
a debounce by the room. A cold join rebuilds state by loading the snapshot and
replaying the jsonl tail after ``snapshot.revision``.
"""

from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path
from typing import Any

from deeptutor.collab.models import AnnotationOp, CollabDocument, SourceInfo
from deeptutor.services.file_io import atomic_write_json, atomic_write_text
from deeptutor.services.path_service import get_path_service


def _read_json(path: Path) -> Any | None:
    if not path.exists():
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


class CollabStorage:
    """Synchronous file-backed store for collab shares."""

    def __init__(self, path_service=None) -> None:
        self._path_service = path_service

    @property
    def path_service(self):
        return self._path_service or get_path_service()

    # ── Path helpers ─────────────────────────────────────────────────────

    def shares_root(self) -> Path:
        return self.path_service.get_collab_shares_dir()

    def share_root(self, token: str) -> Path:
        return self.path_service.get_collab_share_root(token)

    def manifest_path(self, token: str) -> Path:
        return self.path_service.get_collab_manifest_file(token)

    def annotations_path(self, token: str) -> Path:
        return self.path_service.get_collab_annotations_file(token)

    def snapshot_path(self, token: str) -> Path:
        return self.path_service.get_collab_snapshot_file(token)

    def doc_exists(self, token: str) -> bool:
        return self.manifest_path(token).exists()

    # ── Manifest ─────────────────────────────────────────────────────────

    def create_share(
        self,
        *,
        share_token: str,
        owner_token: str,
        title: str,
        source: SourceInfo,
        owner_user_id: str,
        owner_display_name: str,
        allow_edit: bool = False,
    ) -> CollabDocument:
        from deeptutor.collab.models import Permissions

        doc = CollabDocument(
            id=f"col_{share_token[:12]}",
            share_token=share_token,
            title=title or "Untitled",
            source=source,
            owner_user_id=owner_user_id,
            owner_display_name=owner_display_name,
            owner_token=owner_token,
            permissions=Permissions(allow_edit=allow_edit),
            created_at=time.time(),
            updated_at=time.time(),
            revision=0,
        )
        self.save_manifest(doc)
        # Prime an empty snapshot so cold joins don't rebuild from nothing.
        self.save_snapshot(share_token, revision=0, items={})
        return doc

    def save_manifest(self, doc: CollabDocument) -> None:
        payload = doc.model_dump(mode="json")
        atomic_write_json(self.manifest_path(doc.share_token), payload)

    def load_manifest(self, token: str) -> CollabDocument | None:
        data = _read_json(self.manifest_path(token))
        if data is None:
            return None
        try:
            return CollabDocument.model_validate(data)
        except Exception:
            return None

    def delete_share(self, token: str) -> bool:
        root = self.share_root(token)
        if not root.exists():
            return False
        shutil.rmtree(root, ignore_errors=True)
        return not root.exists()

    def find_by_source_url(self, url: str) -> CollabDocument | None:
        """Return the most recently updated share whose source URL matches.

        One document = one stable share link, so repeated "share" clicks on the
        same source reuse the existing share instead of minting a new token.
        Prefer the newest match so the returned share is the "active" one, not
        a stale duplicate.
        """
        root = self.shares_root()
        if not root.exists():
            return None
        best: CollabDocument | None = None
        for child in root.iterdir():
            if not child.is_dir() or not child.name.startswith("share_"):
                continue
            doc = self.load_manifest(child.name[len("share_"):])
            if doc is None or doc.source.url != url:
                continue
            if best is None or doc.updated_at > best.updated_at:
                best = doc
        return best

    # ── Annotation op log (append-only) ──────────────────────────────────

    def append_op(self, token: str, op: AnnotationOp) -> None:
        path = self.annotations_path(token)
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(op.as_dict(), ensure_ascii=False, separators=(",", ":"))
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
            f.flush()
            # fsync is deliberately omitted: at worst a crash loses the last
            # partial line, which the reader tolerates. Keeps per-op latency
            # low under many concurrent annotators.

    def iter_ops(self, token: str) -> list[AnnotationOp]:
        """Read the full op log (tolerant of a torn trailing line)."""
        path = self.annotations_path(token)
        if not path.exists():
            return []
        ops: list[AnnotationOp] = []
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        ops.append(AnnotationOp.model_validate(json.loads(line)))
                    except (json.JSONDecodeError, Exception):
                        continue
        except OSError:
            return []
        return ops

    # ── Snapshot ─────────────────────────────────────────────────────────

    def save_snapshot(self, token: str, *, revision: int, items: dict[str, dict[str, Any]]) -> None:
        payload = {"revision": revision, "items": items}
        atomic_write_json(self.snapshot_path(token), payload)

    def load_snapshot(self, token: str) -> tuple[int, dict[str, dict[str, Any]]]:
        data = _read_json(self.snapshot_path(token))
        if data is None:
            return 0, {}
        revision = int(data.get("revision") or 0)
        items = data.get("items") or {}
        if not isinstance(items, dict):
            items = {}
        return revision, items

    def rebuild_state(self, token: str) -> tuple[int, dict[str, AnnotationOp]]:
        """Materialize (revision, live_items) from snapshot + op-log tail."""
        snapshot_rev, snapshot_items = self.load_snapshot(token)
        live: dict[str, AnnotationOp] = {}
        for op_id, raw in snapshot_items.items():
            try:
                live[op_id] = AnnotationOp.model_validate(raw)
            except Exception:
                continue
        revision = snapshot_rev
        for op in self.iter_ops(token):
            if op.seq <= snapshot_rev:
                continue
            revision = max(revision, op.seq)
            live = _apply_op(live, op)
        return revision, live

    def clear_annotations(self, token: str) -> None:
        """Delete every annotation and reset the revision to zero."""
        try:
            self.annotations_path(token).unlink(missing_ok=True)
        except OSError:
            pass
        self.save_snapshot(token, revision=0, items={})
        doc = self.load_manifest(token)
        if doc is not None:
            doc.revision = 0
            doc.updated_at = time.time()
            self.save_manifest(doc)


def _apply_op(
    live: dict[str, AnnotationOp], op: AnnotationOp
) -> dict[str, AnnotationOp]:
    """Apply one op to the live-items map (idempotent)."""
    if op.kind == "erase":
        if op.target and op.target in live:
            del live[op.target]
        # The erase op itself is not a visible item.
        return live
    if op.deleted:
        live.pop(op.id, None)
        return live
    live[op.id] = op
    return live


def get_collab_storage() -> CollabStorage:
    """One global store for all collab shares.

    Shares are cross-user by design (a token in a link is the credential), so
    they live in a single store anchored to the admin workspace — not the
    current viewer's scope. Existing data already sits in
    ``data/user/workspace/collab/shares``, so no migration is needed.
    """
    from deeptutor.multi_user.paths import get_admin_path_service

    return CollabStorage(path_service=get_admin_path_service())


__all__ = ["CollabStorage", "get_collab_storage"]
