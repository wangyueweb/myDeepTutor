"""Collaborative annotation over generated documents (Phase 1: PDF).

A "share" wraps a generated source file (attachment / outputs artifact) with an
append-only annotation log and an in-memory room for real-time sync. Annotations
never mutate the source file; export bakes them into a new PDF via PyMuPDF.
"""

from deeptutor.collab.models import (
    AnnotationOp,
    CollabDocument,
    Permissions,
    Point,
    SourceInfo,
)
from deeptutor.collab.storage import CollabStorage, get_collab_storage
from deeptutor.collab.rooms import RoomRegistry, get_room_registry

__all__ = [
    "AnnotationOp",
    "CollabDocument",
    "CollabStorage",
    "Permissions",
    "Point",
    "RoomRegistry",
    "SourceInfo",
    "get_collab_storage",
    "get_room_registry",
]
