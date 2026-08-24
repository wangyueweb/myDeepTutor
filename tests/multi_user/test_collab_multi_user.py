"""Collaborative annotation shares across multi-user scopes.

Shares are cross-user by design: they live in one global store anchored to the
admin workspace, and their source files resolve through the *owner's* path
service — so a teacher opening a link created by another teacher lands on the
owner's file instead of a 404, and one user can never manage or take over
another's share.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import HTTPException

from deeptutor.api.routers.collab import (
    ShareCreateRequest,
    _owner_is,
    _owned_by_me,
    create_share,
    resolve_source_path,
)
from deeptutor.collab.models import SourceInfo
from deeptutor.collab.storage import get_collab_storage
from deeptutor.multi_user.paths import get_current_path_service

SHARE_TOKEN = "testshare0001"
OWNER_TOKEN = "owner-secret-token-0001"
REALM = "workspace/chat/chat/col_demo/exec/lesson.pdf"


def _source_url(ps) -> str:
    """A valid public output under *ps*, written to disk."""
    path = ps.get_public_outputs_root() / REALM
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"%PDF-1.4 fake lesson")
    return f"/api/outputs/{REALM}"


def _create(store, *, owner_user_id: str, url: str, display: str = "Teacher") -> None:
    store.create_share(
        share_token=SHARE_TOKEN,
        owner_token=OWNER_TOKEN,
        title="A share",
        source=SourceInfo(
            kind="outputs", url=url, filename="lesson.pdf", mime="application/pdf"
        ),
        owner_user_id=owner_user_id,
        owner_display_name=display,
        allow_edit=True,
    )


def test_storage_is_global_across_scopes(mu_isolated_root, as_user) -> None:
    with as_user("u_alice"):
        root_a = get_collab_storage().shares_root()
    with as_user("u_bob"):
        root_b = get_collab_storage().shares_root()
    # Both scopes hit the same admin-anchored store, not per-user dirs.
    assert root_a == root_b
    assert str(root_a).startswith(str((mu_isolated_root / "data").resolve()))


def test_cross_user_read_and_source_resolves_to_owner(mu_isolated_root, as_user) -> None:
    with as_user("u_alice"):
        _create(get_collab_storage(), owner_user_id="u_alice", url=_source_url(get_current_path_service()))

    with as_user("u_bob"):
        doc = get_collab_storage().load_manifest(SHARE_TOKEN)
        assert doc is not None
        assert doc.owner_user_id == "u_alice"
        path = resolve_source_path(doc)
        assert path is not None and path.is_file()
        # The file lives under Alice's scope, not Bob's.
        alice_root = (mu_isolated_root / "data" / "users" / "u_alice").resolve()
        assert str(path).startswith(str(alice_root))


def test_admin_owner_resolves_to_admin_workspace(mu_isolated_root, seed_user) -> None:
    """A real admin account's uid owns the admin workspace, not data/users/<uid>."""
    from deeptutor.multi_user.paths import get_admin_path_service

    admin_rec = seed_user("boss", role="admin")
    store = get_collab_storage()
    url = _source_url(get_admin_path_service())  # file written under data/user
    store.create_share(
        share_token=SHARE_TOKEN,
        owner_token=OWNER_TOKEN,
        title="A share",
        source=SourceInfo(
            kind="outputs", url=url, filename="lesson.pdf", mime="application/pdf"
        ),
        owner_user_id=admin_rec["id"],  # the real admin uid, not "local-admin"
        owner_display_name="Boss",
        allow_edit=True,
    )
    path = resolve_source_path(store.load_manifest(SHARE_TOKEN))
    assert path is not None and path.is_file()
    admin_root = (mu_isolated_root / "data").resolve()
    assert str(path).startswith(str(admin_root))


def test_owner_check_is_account_based(mu_isolated_root, as_user) -> None:
    with as_user("u_alice"):
        _create(get_collab_storage(), owner_user_id="u_alice", url=_source_url(get_current_path_service()))
        doc = get_collab_storage().load_manifest(SHARE_TOKEN)
        # Alice is the owner even without presenting the owner_token.
        assert _owner_is(None, doc)
        assert _owned_by_me(doc)

    with as_user("u_bob"):
        assert not _owner_is(None, doc)
        assert not _owned_by_me(doc)


def test_dedup_never_leaks_another_users_share(mu_isolated_root, as_user) -> None:
    with as_user("u_alice"):
        _create(get_collab_storage(), owner_user_id="u_alice", url=_source_url(get_current_path_service()))

    with as_user("u_bob"):
        # Bob shares the same source URL Alice already shared. The dedup must
        # NOT hand Bob Alice's share (which would leak Alice's owner_token).
        try:
            result = asyncio.run(
                create_share(
                    ShareCreateRequest(
                        source={"kind": "outputs", "url": f"/api/outputs/{REALM}"}
                    )
                )
            )
        except HTTPException:
            # Bob cannot serve Alice's file from his own scope → clean 400.
            return
    # If it minted a new share at all, it must be a fresh one, never Alice's.
    assert result["share_token"] != SHARE_TOKEN
    assert result["owner_token"] != OWNER_TOKEN
