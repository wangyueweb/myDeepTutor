"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CollabSocket } from "@/lib/collab-ws";
import type {
  AnnotationOp,
  CollabDoc,
  MemberInfo,
  Permissions,
  Role,
  ServerMessage,
} from "@/lib/collab-types";

export interface PendingOp {
  id: string;
  kind: AnnotationOp["kind"];
  page: number;
  color: string;
  width: number;
  opacity: number;
  points: AnnotationOp["points"];
  text?: string;
  target?: string | null;
}

interface CollabContextValue {
  connected: boolean;
  role: Role;
  memberId: string;
  presenterId: string | null;
  doc: CollabDoc | null;
  annotations: Map<string, AnnotationOp>;
  members: Map<string, MemberInfo>;
  error: string | null;
  join: (token: string, ownerToken: string | null, displayName?: string) => void;
  sendOp: (op: PendingOp) => void;
  applyLocalOp: (op: AnnotationOp) => void;
  sendPresence: (presence: Record<string, unknown>) => void;
  setPresenter: () => void;
  clearAnnotations: () => void;
  updatePermissions: (allowEdit: boolean, ownerToken: string) => Promise<void>;
  disconnect: () => void;
}

const CollabContext = createContext<CollabContextValue | null>(null);

function newOpId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return "a_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  }
  return "a_" + Math.random().toString(36).slice(2, 14);
}

export function CollabProvider({ children }: { children: ReactNode }) {
  const socketRef = useRef<CollabSocket | null>(null);
  const handleMessageRef = useRef<((msg: ServerMessage) => void) | null>(null);
  const [connected, setConnected] = useState(false);
  const [role, setRole] = useState<Role>("viewer");
  const [memberId, setMemberId] = useState("");
  const [presenterId, setPresenterId] = useState<string | null>(null);
  const [doc, setDoc] = useState<CollabDoc | null>(null);
  const [annotations, setAnnotations] = useState<Map<string, AnnotationOp>>(
    new Map(),
  );
  const [members, setMembers] = useState<Map<string, MemberInfo>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const applyOp = useCallback((op: AnnotationOp) => {
    setAnnotations((prev) => {
      const next = new Map(prev);
      if (op.kind === "erase") {
        if (op.target) next.delete(op.target);
      } else if (op.deleted) {
        next.delete(op.id);
      } else {
        next.set(op.id, op);
      }
      return next;
    });
  }, []);

  const handleMessage = useCallback(
    (msg: ServerMessage) => {
      switch (msg.type) {
        case "welcome": {
          setDoc(msg.doc);
          setRole(msg.role);
          setMemberId(msg.member_id);
          setPresenterId(msg.presenter_id);
          setAnnotations(new Map(Object.entries(msg.snapshot)));
          setMembers(new Map(msg.members.map((m) => [m.member_id, m])));
          setConnected(true);
          setError(null);
          break;
        }
        case "op":
          applyOp(msg.op);
          setDoc((d) => (d ? { ...d, revision: Math.max(d.revision, msg.seq) } : d));
          break;
        case "presence":
          setMembers((prev) => {
            const next = new Map(prev);
            const m = next.get(msg.member_id);
            if (m) next.set(msg.member_id, { ...m, presence: msg.presence });
            return next;
          });
          break;
        case "member_join":
          setMembers((prev) => {
            const next = new Map(prev);
            next.set(msg.member_id, {
              member_id: msg.member_id,
              display_name: msg.display_name ?? "匿名",
              role: msg.role ?? "viewer",
            });
            return next;
          });
          break;
        case "member_leave":
          setMembers((prev) => {
            const next = new Map(prev);
            next.delete(msg.member_id);
            return next;
          });
          break;
        case "permission_changed":
          setDoc((d) => (d ? { ...d, permissions: msg.permissions } : d));
          if (msg.roles && memberId && msg.roles[memberId]) {
            setRole(msg.roles[memberId]);
          }
          break;
        case "presenter_changed":
          setPresenterId(msg.presenter_id);
          break;
        case "annotations_cleared":
          setAnnotations(new Map());
          setDoc((d) => (d ? { ...d, revision: msg.revision } : d));
          break;
        case "error":
          setError(msg.message || msg.code);
          break;
      }
    },
    [applyOp, memberId],
  );
  handleMessageRef.current = handleMessage;

  const join = useCallback(
    (token: string, ownerToken: string | null, displayName?: string) => {
      setError(null);
      if (!socketRef.current) {
        // Use a ref-wrapped handler so the socket always calls the LATEST
        // handleMessage (which has the up-to-date memberId etc.), even though
        // the CollabSocket is created once and never re-created.
        socketRef.current = new CollabSocket({
          onMessage: (msg) => handleMessageRef.current!(msg),
          onStatus: setConnected,
        });
      }
      socketRef.current.connect({ token, ownerToken, displayName });
    },
    [],
  );

  const sendOp = useCallback((op: PendingOp) => {
    socketRef.current?.sendOp(op);
  }, []);

  const applyLocalOp = useCallback((op: AnnotationOp) => {
    applyOp(op);
  }, [applyOp]);

  const sendPresence = useCallback((presence: Record<string, unknown>) => {
    socketRef.current?.sendPresence(presence);
  }, []);

  const setPresenter = useCallback(() => {
    socketRef.current?.setPresenter();
  }, []);

  const clearAnnotations = useCallback(() => {
    socketRef.current?.clearAnnotations();
  }, []);

  const updatePermissions = useCallback(
    async (allowEdit: boolean, ownerToken: string) => {
      if (!doc) return;
      const { updateCollabShare } = await import("@/lib/collab-api");
      const perm = await updateCollabShare(doc.share_token, allowEdit, ownerToken);
      setDoc((d) => (d ? { ...d, permissions: perm } : d));
    },
    [doc],
  );

  const disconnect = useCallback(() => {
    socketRef.current?.disconnect();
    socketRef.current = null;
    setConnected(false);
  }, []);

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
    };
  }, []);

  const value = useMemo<CollabContextValue>(
    () => ({
      connected,
      role,
      memberId,
      presenterId,
      doc,
      annotations,
      members,
      error,
      join,
      sendOp,
      applyLocalOp,
      sendPresence,
      setPresenter,
      clearAnnotations,
      updatePermissions,
      disconnect,
    }),
    [
      connected,
      role,
      memberId,
      presenterId,
      doc,
      annotations,
      members,
      error,
      join,
      sendOp,
      applyLocalOp,
      sendPresence,
      setPresenter,
      clearAnnotations,
      updatePermissions,
      disconnect,
    ],
  );

  return <CollabContext.Provider value={value}>{children}</CollabContext.Provider>;
}

export function useCollab(): CollabContextValue {
  const ctx = useContext(CollabContext);
  if (!ctx) throw new Error("useCollab must be used within CollabProvider");
  return ctx;
}

export { newOpId };
