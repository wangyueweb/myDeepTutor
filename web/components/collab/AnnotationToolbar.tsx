"use client";

import { useTranslation } from "react-i18next";
import { Eraser, Highlighter, PenLine, Type, Users } from "lucide-react";
import type { Tool } from "@/lib/collab-types";

const PEN_COLORS = [
  "#e11d48", // rose
  "#2563eb", // blue
  "#16a34a", // green
  "#111827", // black
  "#9333ea", // purple
  "#ea580c", // orange
];

const PEN_WIDTHS = [2, 4, 6];

interface AnnotationToolbarProps {
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  color: string;
  onColorChange: (color: string) => void;
  width: number;
  onWidthChange: (width: number) => void;
  canAnnotate: boolean;
  memberCount: number;
  followOwner: boolean;
  onToggleFollow: () => void;
}

export default function AnnotationToolbar({
  tool,
  onToolChange,
  color,
  onColorChange,
  width,
  onWidthChange,
  canAnnotate,
  memberCount,
  followOwner,
  onToggleFollow,
}: AnnotationToolbarProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--card)] px-3 py-2">
      <div className="flex items-center gap-1 rounded-lg bg-[var(--muted)]/60 p-1">
        <button
          type="button"
          onClick={() => onToolChange("pen")}
          title={t("collab.pen")}
          className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
            tool === "pen" ? "bg-[var(--card)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"
          }`}
        >
          <PenLine size={16} strokeWidth={1.7} />
        </button>
        <button
          type="button"
          onClick={() => onToolChange("highlighter")}
          title={t("collab.highlighter")}
          className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
            tool === "highlighter" ? "bg-[var(--card)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"
          }`}
        >
          <Highlighter size={16} strokeWidth={1.7} />
        </button>
        <button
          type="button"
          onClick={() => onToolChange("textbox")}
          title={t("collab.text")}
          className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
            tool === "textbox" ? "bg-[var(--card)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"
          }`}
        >
          <Type size={16} strokeWidth={1.7} />
        </button>
        <button
          type="button"
          onClick={() => onToolChange("eraser")}
          title={t("collab.eraser")}
          className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
            tool === "eraser" ? "bg-[var(--card)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"
          }`}
        >
          <Eraser size={16} strokeWidth={1.7} />
        </button>
      </div>

      {tool !== "eraser" && (
        <div className="flex items-center gap-1">
          {PEN_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onColorChange(c)}
              aria-label={c}
              className={`h-6 w-6 rounded-full border ${
                color === c ? "ring-2 ring-offset-1 ring-[var(--ring)]" : ""
              }`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      )}
      {(tool === "pen" || tool === "highlighter") && (
        <div className="flex items-center gap-1">
          {PEN_WIDTHS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => onWidthChange(w)}
              className={`flex h-7 w-7 items-center justify-center rounded-md border text-[11px] ${
                width === w
                  ? "border-[var(--ring)] bg-[var(--muted)] text-[var(--foreground)]"
                  : "border-[var(--border)] text-[var(--muted-foreground)]"
              }`}
            >
              <span
                className="rounded-full bg-current"
                style={{ width: w * 1.4, height: w * 1.4, minHeight: 2 }}
              />
            </button>
          ))}
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        <span className="flex items-center gap-1 text-[12px] text-[var(--muted-foreground)]">
          <Users size={14} strokeWidth={1.7} />
          {memberCount}
        </span>
        <button
          type="button"
          onClick={onToggleFollow}
          className={`rounded-md px-2 py-1 text-[12px] transition-colors ${
            followOwner
              ? "bg-[var(--primary)]/10 text-[var(--primary)]"
              : "text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
          }`}
        >
          {t("collab.follow")}
        </button>
        {!canAnnotate && (
          <span className="text-[12px] text-[var(--muted-foreground)]">
            {t("collab.readonly")}
          </span>
        )}
      </div>
    </div>
  );
}
