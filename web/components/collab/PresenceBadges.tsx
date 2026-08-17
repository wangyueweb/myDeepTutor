"use client";

import { useMemo } from "react";
import type { MemberInfo, Role } from "@/lib/collab-types";

const ROLE_COLORS: Record<Role, string> = {
  owner: "bg-[var(--primary)]",
  editor: "bg-emerald-500",
  viewer: "bg-[var(--muted-foreground)]",
};

function initials(name: string): string {
  const trimmed = (name || "").trim();
  if (!trimmed) return "·";
  return trimmed.slice(0, 2);
}

export default function PresenceBadges({
  members,
  presenterId,
}: {
  members: Map<string, MemberInfo>;
  presenterId?: string | null;
}) {
  const list = useMemo(() => Array.from(members.values()), [members]);
  if (list.length === 0) return null;

  return (
    <div className="flex -space-x-2">
      {list.map((m) => (
        <span
          key={m.member_id}
          title={m.member_id === presenterId ? `主讲：${m.display_name}` : m.display_name}
          className={`relative flex h-7 w-7 items-center justify-center rounded-full border-2 border-[var(--card)] bg-[var(--muted)] text-[11px] font-medium text-[var(--foreground)] ${
            m.member_id === presenterId ? "ring-2 ring-[var(--primary)]" : ""
          }`}
        >
          {initials(m.display_name)}
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-[var(--card)] ${ROLE_COLORS[m.role]}`}
          />
        </span>
      ))}
    </div>
  );
}
