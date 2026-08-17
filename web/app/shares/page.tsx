"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import {
  createCollabShare,
  deleteCollabShare,
  listCollabSharesManage,
  renameCollabShare,
  type ManageShare,
} from "@/lib/collab-api";

function formatWhen(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "2-digit", day: "2-digit" });
}

export default function MySharesPage() {
  const { t } = useTranslation();
  const [shares, setShares] = useState<ManageShare[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const load = useCallback(() => {
    listCollabSharesManage()
      .then(setShares)
      .catch(() => setShares([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const copy = useCallback(async (s: ManageShare) => {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/share/${s.share_token}`,
      );
      setCopied(s.share_token);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // clipboard rejected
    }
  }, []);

  const remove = useCallback(
    async (s: ManageShare) => {
      if (confirmDelete !== s.share_token) {
        setConfirmDelete(s.share_token);
        setTimeout(() => setConfirmDelete(null), 3000);
        return;
      }
      try {
        await deleteCollabShare(s.share_token, s.owner_token);
      } finally {
        setConfirmDelete(null);
        load();
      }
    },
    [confirmDelete, load],
  );

  const addLink = useCallback(
    async (s: ManageShare) => {
      setAdding(s.share_token);
      try {
        await createCollabShare({
          source: {
            kind: s.source.kind,
            url: s.source_url,
            filename: s.source.filename,
            mime: s.source.mime,
          },
          title: s.title,
          force_new: true,
        });
        load();
      } finally {
        setAdding(null);
      }
    },
    [load],
  );

  const startRename = useCallback((s: ManageShare) => {
    setRenaming(s.share_token);
    setRenameDraft(s.title);
  }, []);

  const saveRename = useCallback(
    async (s: ManageShare) => {
      const title = renameDraft.trim();
      setRenaming(null);
      if (title && title !== s.title) {
        await renameCollabShare(s.share_token, title, s.owner_token);
        load();
      }
    },
    [renameDraft, load],
  );

  return (
    <div className="min-h-dvh bg-[var(--background)]">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6 flex items-center gap-3">
          <Link
            href="/"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
            aria-label={t("Back")}
          >
            <ArrowLeft size={16} />
          </Link>
          <h1 className="text-lg font-semibold text-[var(--foreground)]">
            {t("collab.my_shares")}
          </h1>
        </div>

        {shares === null ? (
          <div className="flex items-center gap-2 py-10 text-[13px] text-[var(--muted-foreground)]">
            <Loader2 size={16} className="animate-spin" />
            {t("Loading preview…")}
          </div>
        ) : shares.length === 0 ? (
          <p className="py-10 text-[13px] text-[var(--muted-foreground)]">
            {t("collab.share_list_empty")}
          </p>
        ) : (
          <ul className="space-y-2">
            {shares.map((s) => (
              <li
                key={s.share_token}
                className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  {renaming === s.share_token ? (
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          saveRename(s);
                        } else if (e.key === "Escape") {
                          setRenaming(null);
                        }
                      }}
                      onBlur={() => saveRename(s)}
                      className="w-full rounded border border-[var(--ring)] bg-[var(--background)] px-1.5 py-0.5 text-[14px] font-medium text-[var(--foreground)]"
                    />
                  ) : (
                    <div className="truncate text-[14px] font-medium text-[var(--foreground)]">
                      {s.title}
                    </div>
                  )}
                  <div className="truncate text-[11px] text-[var(--muted-foreground)]">
                    {s.source.filename} · {t("collab.annotation_count", { n: s.revision })} ·{" "}
                    {formatWhen(s.updated_at)}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => startRename(s)}
                  title={t("collab.rename")}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => copy(s)}
                  title={t("Copy link")}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
                >
                  {copied === s.share_token ? (
                    <Check size={15} className="text-emerald-500" />
                  ) : (
                    <Copy size={15} />
                  )}
                </button>
                <Link
                  href={`/share/${s.share_token}`}
                  title={t("collab.open_editor")}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
                >
                  <ExternalLink size={15} />
                </Link>
                <button
                  type="button"
                  onClick={() => addLink(s)}
                  disabled={adding === s.share_token}
                  title={t("collab.new_link")}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted-foreground)] hover:bg-[var(--muted)] disabled:opacity-40"
                >
                  {adding === s.share_token ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : (
                    <Plus size={15} />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => remove(s)}
                  className={`flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[12px] font-medium transition-colors ${
                    confirmDelete === s.share_token
                      ? "bg-red-500 text-white"
                      : "text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
                  }`}
                >
                  <Trash2 size={14} />
                  {confirmDelete === s.share_token
                    ? t("collab.confirm_delete")
                    : t("collab.delete")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
