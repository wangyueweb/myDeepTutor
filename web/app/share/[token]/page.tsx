"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  FileDown,
  Loader2,
  Share2,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { CollabProvider, useCollab } from "@/components/collab/CollabProvider";
import AnnotatablePdfViewer from "@/components/collab/AnnotatablePdfViewer";
import AnnotationToolbar from "@/components/collab/AnnotationToolbar";
import PresenceBadges from "@/components/collab/PresenceBadges";
import {
  collabDownloadUrl,
  collabExportUrl,
  collabSourceUrl,
  getCollabShare,
} from "@/lib/collab-api";
import type { CollabDoc, Tool } from "@/lib/collab-types";

function guestName(): string {
  const key = "deeptutor.collab.display_name";
  const existing = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  if (existing) return existing;
  const name = "教师-" + Math.random().toString(36).slice(2, 6).toUpperCase();
  try {
    localStorage.setItem(key, name);
  } catch {
    // storage unavailable
  }
  return name;
}

function ownerTokenFor(token: string): string | null {
  try {
    return localStorage.getItem(`deeptutor.collab.owner.${token}`);
  } catch {
    return null;
  }
}

function ShareRoom({ token }: { token: string }) {
  const { t } = useTranslation();
  const {
    doc,
    connected,
    role,
    memberId,
    presenterId,
    members,
    error,
    join,
    updatePermissions,
    setPresenter,
    clearAnnotations,
  } = useCollab();

  const [meta, setMeta] = useState<CollabDoc | null>(null);
  const [missing, setMissing] = useState(false);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState("#e11d48");
  const [width, setWidth] = useState(3);
  const [followOwner, setFollowOwner] = useState(true);
  const [copied, setCopied] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const ownerToken = useMemo(() => ownerTokenFor(token), [token]);
  const isOwner = role === "owner";
  const canAnnotate = role === "owner" || role === "editor";
  const allowEdit = (doc ?? meta)?.permissions?.allow_edit ?? false;

  useEffect(() => {
    let cancelled = false;
    getCollabShare(token)
      .then((m) => {
        if (!cancelled) setMeta(m);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "";
          if (msg.includes("404")) setMissing(true);
        }
      });
    join(token, ownerToken, guestName());
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, ownerToken]);

  const toggleAllowEdit = useCallback(async () => {
    if (!ownerToken) return;
    await updatePermissions(!allowEdit, ownerToken);
  }, [ownerToken, allowEdit, updatePermissions]);

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard rejected
    }
  }, []);

  // Auto-cancel the destructive "clear" confirmation after a few seconds.
  useEffect(() => {
    if (!confirmClear) return;
    const timer = setTimeout(() => setConfirmClear(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmClear]);

  const title = doc?.title ?? meta?.title ?? t("collab.title");

  if (missing) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-[var(--background)] px-6 text-center">
        <div className="text-[42px]">📄</div>
        <p className="text-[15px] font-medium text-[var(--foreground)]">
          {t("collab.share_missing")}
        </p>
        <p className="max-w-sm text-[12px] text-[var(--muted-foreground)]">
          {t("collab.share_missing_hint")}
        </p>
        <Link
          href="/"
          className="mt-2 rounded-md bg-[var(--primary)] px-4 py-2 text-[13px] font-medium text-white"
        >
          {t("Back")}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-[var(--background)]">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--card)] px-4 py-2.5">
        <Link
          href="/"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
          aria-label={t("Back")}
        >
          <ArrowLeft size={16} />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-[var(--foreground)]">
            {title}
          </div>
          <div className="truncate text-[11px] text-[var(--muted-foreground)]">
            {t("collab.shared_by", { name: (doc ?? meta)?.owner_display_name || "—" })}
            {!connected && <span className="ml-2">· {t("collab.connecting")}</span>}
          </div>
        </div>

        <PresenceBadges members={members} presenterId={presenterId} />

        {presenterId && presenterId !== memberId && (
          <button
            type="button"
            onClick={setPresenter}
            className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
          >
            {t("collab.become_presenter")}
          </button>
        )}
        {presenterId && presenterId === memberId && (
          <span className="rounded-md bg-[var(--primary)]/10 px-2.5 py-1.5 text-[12px] font-medium text-[var(--primary)]">
            {t("collab.presenting")}
          </span>
        )}

        {isOwner && (
          <button
            type="button"
            onClick={toggleAllowEdit}
            className={`rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
              allowEdit
                ? "bg-[var(--primary)] text-white"
                : "bg-[var(--muted)] text-[var(--foreground)]"
            }`}
          >
            {allowEdit ? t("collab.allow_on") : t("collab.allow_off")}
          </button>
        )}

        <button
          type="button"
          onClick={copyLink}
          className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[12px] text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
        >
          {copied ? <Check size={14} className="text-emerald-500" /> : <Share2 size={14} />}
          {t("collab.copy_link")}
        </button>

        {isOwner && ownerToken && (
          <>
            <a
              href={collabExportUrl(token, ownerToken)}
              className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[12px] text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
            >
              <FileDown size={14} />
              {t("collab.export")}
            </a>
            <a
              href={collabDownloadUrl(token, ownerToken)}
              className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[12px] text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
            >
              <Download size={14} />
              {t("Download")}
            </a>
          </>
        )}

        {isOwner && (
          <button
            type="button"
            onClick={() => {
              if (confirmClear) {
                clearAnnotations();
                setConfirmClear(false);
              } else {
                setConfirmClear(true);
              }
            }}
            className={`flex items-center gap-1 rounded-md px-2 py-1.5 text-[12px] font-medium transition-colors ${
              confirmClear
                ? "bg-red-500 text-white"
                : "text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
            }`}
          >
            <Trash2 size={14} />
            {confirmClear ? t("collab.confirm_clear") : t("collab.clear_annotations")}
          </button>
        )}
      </div>

      {/* Toolbar */}
      <AnnotationToolbar
        tool={tool}
        onToolChange={setTool}
        color={color}
        onColorChange={setColor}
        width={width}
        onWidthChange={setWidth}
        canAnnotate={canAnnotate}
        memberCount={members.size}
        followOwner={followOwner}
        onToggleFollow={() => setFollowOwner((v) => !v)}
      />

      {error && (
        <div className="border-b border-[var(--border)] bg-red-50 px-4 py-2 text-[12px] text-red-600">
          {error}
        </div>
      )}
      {!canAnnotate && connected && (
        <div className="border-b border-[var(--border)] bg-[var(--muted)]/40 px-4 py-1.5 text-[12px] text-[var(--muted-foreground)]">
          {t("collab.readonly_hint")}
        </div>
      )}

      {/* Viewer */}
      <div className="min-h-0 flex-1">
        <AnnotatablePdfViewer
          sourceUrl={collabSourceUrl(token)}
          tool={tool}
          color={color}
          width={width}
          followOwner={followOwner}
        />
      </div>
    </div>
  );
}

export default function SharePage() {
  const params = useParams<{ token: string }>();
  const token = typeof params?.token === "string" ? params.token : "";
  const { t } = useTranslation();

  if (!token) {
    return (
      <div className="flex h-dvh items-center justify-center text-[var(--muted-foreground)]">
        {t("collab.load_failed")}
      </div>
    );
  }

  return (
    <CollabProvider>
      <ShareRoom token={token} />
    </CollabProvider>
  );
}
