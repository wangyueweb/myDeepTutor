import { apiFetch, apiUrl, wsUrl } from "./api";
import type { CollabDoc, Permissions } from "./collab-types";

const BASE = "/api/v1/collab";

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Request failed (${res.status}): ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export interface CreateShareResult {
  share_token: string;
  owner_token: string;
  url: string;
  doc: CollabDoc;
}

export async function createCollabShare(payload: {
  source: { kind: string; url: string; filename?: string; mime?: string };
  title?: string;
  allow_edit?: boolean;
  force_new?: boolean;
}): Promise<CreateShareResult> {
  const res = await apiFetch(apiUrl(`${BASE}/shares`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: payload.source,
      title: payload.title ?? null,
      allow_edit: payload.allow_edit ?? false,
      force_new: payload.force_new ?? false,
    }),
  });
  return jsonOrThrow<CreateShareResult>(res);
}

export async function getCollabShare(token: string): Promise<CollabDoc> {
  const res = await apiFetch(apiUrl(`${BASE}/shares/${encodeURIComponent(token)}`), {
    cache: "no-store",
  });
  return jsonOrThrow<CollabDoc>(res);
}

export async function updateCollabShare(
  token: string,
  allowEdit: boolean,
  ownerToken: string,
): Promise<Permissions> {
  const res = await apiFetch(apiUrl(`${BASE}/shares/${encodeURIComponent(token)}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ allow_edit: allowEdit, owner_token: ownerToken }),
  });
  return jsonOrThrow<Permissions>(res);
}

export async function deleteCollabShare(
  token: string,
  ownerToken: string,
): Promise<boolean> {
  const res = await apiFetch(
    apiUrl(`${BASE}/shares/${encodeURIComponent(token)}?owner_token=${encodeURIComponent(ownerToken)}`),
    { method: "DELETE" },
  );
  const data = await jsonOrThrow<{ deleted: boolean }>(res);
  return Boolean(data?.deleted);
}

/** Share entry as returned by the owner management endpoint (incl. owner_token). */
export interface ManageShare extends CollabDoc {
  owner_token: string;
  source_url: string;
}

export async function listCollabSharesManage(): Promise<ManageShare[]> {
  const res = await apiFetch(apiUrl(`${BASE}/shares/manage`), { cache: "no-store" });
  const data = await jsonOrThrow<{ shares: ManageShare[] }>(res);
  return Array.isArray(data?.shares) ? data.shares : [];
}

/** Owner-only: rename a share (its display title in the management list). */
export async function renameCollabShare(
  token: string,
  title: string,
  ownerToken: string,
): Promise<Permissions> {
  const res = await apiFetch(apiUrl(`${BASE}/shares/${encodeURIComponent(token)}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, owner_token: ownerToken }),
  });
  return jsonOrThrow<Permissions>(res);
}

/** Original-file bytes endpoint (for pdf.js rendering). */
export function collabSourceUrl(token: string): string {
  return apiUrl(`${BASE}/shares/${encodeURIComponent(token)}/source`);
}

/** Owner-only export (merged, annotated PDF). */
export function collabExportUrl(token: string, ownerToken: string): string {
  return apiUrl(
    `${BASE}/shares/${encodeURIComponent(token)}/export?owner_token=${encodeURIComponent(ownerToken)}`,
  );
}

export function collabDownloadUrl(token: string, ownerToken: string): string {
  return apiUrl(
    `${BASE}/shares/${encodeURIComponent(token)}/download?owner_token=${encodeURIComponent(ownerToken)}`,
  );
}

/** Room WebSocket endpoint. */
export function collabWsUrl(): string {
  return wsUrl(`${BASE}/ws`);
}
