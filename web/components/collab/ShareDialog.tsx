"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import { Check, Copy, Loader2, PenLine, X } from "lucide-react";
import { createCollabShare, type CreateShareResult } from "@/lib/collab-api";

export interface ShareSource {
  url: string;
  filename: string;
  mime?: string;
}

function relativeSourceUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) {
    const idx = url.indexOf("/api/");
    if (idx >= 0) return url.slice(idx);
    return url;
  }
  return url;
}

function sourceKindForUrl(url: string): "outputs" | "attachment" | "" {
  if (url.startsWith("/api/outputs/")) return "outputs";
  if (url.startsWith("/api/attachments/")) return "attachment";
  return "";
}

export default function ShareDialog({
  open,
  source,
  onClose,
}: {
  open: boolean;
  source: ShareSource | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const [state, setState] = useState<"idle" | "creating" | "done" | "error">("idle");
  const [result, setResult] = useState<CreateShareResult | null>(null);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);

  const reset = useCallback(() => {
    setState("idle");
    setResult(null);
    setMessage("");
    setCopied(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    reset();
    if (!source) return;
    const relUrl = relativeSourceUrl(source.url);
    const kind = sourceKindForUrl(relUrl);
    if (!kind) {
      setState("error");
      setMessage(t("collab.source_not_shareable"));
      return;
    }
    setState("creating");
    createCollabShare({
      source: { kind, url: relUrl, filename: source.filename, mime: source.mime },
      title: source.filename,
    })
      .then((r) => {
        // Persist the owner identity the moment the share exists — the owner
        // may copy the link and reopen it later instead of clicking "Open
        // editor", and must still be recognised as owner (can annotate, toggle
        // co-editing, export).
        try {
          localStorage.setItem(
            `deeptutor.collab.owner.${r.share_token}`,
            r.owner_token,
          );
        } catch {
          // storage unavailable
        }
        setResult(r);
        setState("done");
      })
      .catch((err: unknown) => {
        setState("error");
        setMessage(err instanceof Error ? err.message : "failed");
      });
  }, [open, source, reset, t]);

  const copyLink = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${result.url}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard rejected
    }
  }, [result]);

  const openEditor = useCallback(() => {
    if (!result) return;
    try {
      localStorage.setItem(`deeptutor.collab.owner.${result.share_token}`, result.owner_token);
    } catch {
      // storage unavailable
    }
    router.push(result.url);
  }, [result, router]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-[var(--foreground)]">
            {t("collab.share_title")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
            aria-label={t("Close")}
          >
            <X size={15} />
          </button>
        </div>

        {state === "creating" && (
          <div className="flex items-center gap-2 py-6 text-[13px] text-[var(--muted-foreground)]">
            <Loader2 size={16} className="animate-spin" />
            {t("collab.creating")}
          </div>
        )}

        {state === "error" && (
          <p className="py-4 text-[13px] text-red-600">{message || t("collab.load_failed")}</p>
        )}

        {state === "done" && result && (
          <div className="space-y-3">
            <p className="text-[12px] text-[var(--muted-foreground)]">{t("collab.share_hint")}</p>
            <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--muted)]/40 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--foreground)]">
                {`${window.location.origin}${result.url}`}
              </span>
              <button
                type="button"
                onClick={copyLink}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
                aria-label={t("Copy link")}
              >
                {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
              </button>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md px-3 py-2 text-[13px] text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
              >
                {t("Close")}
              </button>
              <button
                type="button"
                onClick={openEditor}
                className="flex items-center gap-1.5 rounded-md bg-[var(--primary)] px-3 py-2 text-[13px] font-medium text-white"
              >
                <PenLine size={14} />
                {t("collab.open_editor")}
              </button>
            </div>
            <Link
              href="/shares"
              className="block text-center text-[12px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            >
              {t("collab.manage_shares")}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
