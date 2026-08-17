"""Pydantic models for collaborative annotation shares."""

from __future__ import annotations

import time
from typing import Any, Literal

from pydantic import BaseModel, Field

SourceKind = Literal["attachment", "outputs", "markdown"]

# Annotation kinds. ``erase`` references an earlier op via ``target`` and marks
# it (and itself) deleted — tombstones, so erasing is conflict-free.
AnnotationKind = Literal["ink", "highlight", "textbox", "note", "erase"]


class Point(BaseModel):
    """A single ink sample in PDF page space (origin top-left, 1 unit = 1pt).

    Coordinates are device/zoom independent so any client re-projects them onto
    its own viewport.
    """

    x: float
    y: float
    pressure: float | None = None


class SourceInfo(BaseModel):
    """Reference to the original generated file. Never copied, never mutated."""

    kind: SourceKind = "outputs"
    url: str
    filename: str = "file"
    mime: str = "application/octet-stream"


class Permissions(BaseModel):
    """Access control. Public-by-default (token is the credential)."""

    allow_edit: bool = False
    require_login: bool = False
    password_hash: str | None = None
    expires_at: float | None = None


class CollabDocument(BaseModel):
    """Manifest for one share. ``owner_token`` is secret and must be excluded
    from any public response."""

    id: str
    share_token: str
    title: str = "Untitled"
    source: SourceInfo
    owner_user_id: str = ""
    owner_display_name: str = ""
    owner_token: str = ""
    permissions: Permissions = Field(default_factory=Permissions)
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)
    revision: int = 0

    def public_dict(self) -> dict[str, Any]:
        """Metadata safe to expose to anyone holding the share token."""
        return {
            "id": self.id,
            "share_token": self.share_token,
            "title": self.title,
            "source": {
                "kind": self.source.kind,
                "filename": self.source.filename,
                "mime": self.source.mime,
            },
            "owner_display_name": self.owner_display_name,
            "permissions": {
                "allow_edit": self.permissions.allow_edit,
                "require_login": self.permissions.require_login,
                "expires_at": self.permissions.expires_at,
            },
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "revision": self.revision,
        }


class AnnotationOp(BaseModel):
    """One append-only annotation op. ``seq`` is assigned by the room (the
    server), monotonically increasing per share."""

    seq: int
    id: str
    kind: AnnotationKind
    page: int = 0
    author: str = ""
    author_name: str = ""
    color: str = "#e11d48"
    width: float = 2.0
    opacity: float = 0.9
    points: list[Point] = Field(default_factory=list)
    text: str = ""
    target: str | None = None
    deleted: bool = False
    created_at: float = Field(default_factory=time.time)

    def as_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")
