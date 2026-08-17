// Shared types for collaborative annotation (Phase 1: PDF).
// Mirrors the backend models in `deeptutor/collab/models.py`.

export type SourceKind = "attachment" | "outputs" | "markdown";
export type AnnotationKind = "ink" | "highlight" | "textbox" | "note" | "erase";
export type Tool = "pen" | "highlighter" | "eraser" | "textbox";
export type Role = "owner" | "editor" | "viewer";

export interface InkPoint {
  x: number;
  y: number;
  pressure?: number | null;
}

export interface AnnotationOp {
  seq: number;
  id: string;
  kind: AnnotationKind;
  page: number;
  author: string;
  author_name?: string;
  color: string;
  width: number;
  opacity: number;
  points: InkPoint[];
  text?: string;
  target?: string | null;
  deleted?: boolean;
  created_at: number;
}

export interface Permissions {
  allow_edit: boolean;
  require_login: boolean;
  expires_at: number | null;
}

export interface CollabDoc {
  id: string;
  share_token: string;
  title: string;
  source: { kind: SourceKind; filename: string; mime: string };
  owner_display_name: string;
  permissions: Permissions;
  created_at: number;
  updated_at: number;
  revision: number;
}

export interface MemberInfo {
  member_id: string;
  display_name: string;
  role: Role;
  presence?: Record<string, unknown>;
}

export type ServerMessage =
  | {
      type: "welcome";
      doc: CollabDoc;
      revision: number;
      snapshot: Record<string, AnnotationOp>;
      role: Role;
      member_id: string;
      presenter_id: string | null;
      members: MemberInfo[];
    }
  | { type: "op"; seq: number; op: AnnotationOp }
  | { type: "presence"; member_id: string; presence: Record<string, unknown> }
  | {
      type: "member_join" | "member_leave";
      member_id: string;
      display_name?: string;
      role?: Role;
    }
  | { type: "permission_changed"; permissions: Permissions; roles: Record<string, Role> }
  | { type: "presenter_changed"; presenter_id: string; display_name: string }
  | { type: "annotations_cleared"; revision: number }
  | { type: "error"; code: string; message: string };

export function colorToRgba(hex: string, opacity: number): string {
  const raw = (hex || "").replace("#", "");
  if (raw.length < 6) return `rgba(225, 29, 72, ${opacity})`;
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}
