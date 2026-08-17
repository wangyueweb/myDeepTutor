import { collabWsUrl } from "./collab-api";
import type { AnnotationOp, ServerMessage } from "./collab-types";

export interface JoinParams {
  token: string;
  ownerToken?: string | null;
  displayName?: string;
}

export interface CollabSocketHandlers {
  onMessage: (msg: ServerMessage) => void;
  onStatus?: (connected: boolean) => void;
}

const HEARTBEAT_MS = 25_000;
const TIMEOUT_MS = 40_000;
const MAX_RECONNECT = 6;

/**
 * Thin WebSocket client for one collab room. Connect with a share token,
 * stream ops/presence, and receive server messages. Reconnects with backoff
 * and re-joins the room on a fresh socket.
 */
export class CollabSocket {
  private ws: WebSocket | null = null;
  private handlers: CollabSocketHandlers;
  private join: JoinParams | null = null;
  private intentional = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastReceivedAt = 0;

  constructor(handlers: CollabSocketHandlers) {
    this.handlers = handlers;
  }

  connect(join: JoinParams): void {
    this.join = join;
    this.intentional = false;
    this.open();
  }

  private open(): void {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    const ws = new WebSocket(collabWsUrl());
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.lastReceivedAt = Date.now();
      this.startHeartbeat();
      if (this.join) {
        ws.send(
          JSON.stringify({
            type: "join",
            token: this.join.token,
            owner_token: this.join.ownerToken ?? "",
            display_name: this.join.displayName ?? "",
          }),
        );
      }
    };

    ws.onmessage = (ev) => {
      this.lastReceivedAt = Date.now();
      try {
        const data = JSON.parse(ev.data) as Record<string, unknown>;
        const type = data.type as string | undefined;
        if (type === "ping" || type === "pong") return;
        this.handlers.onMessage(data as unknown as ServerMessage);
      } catch {
        // ignore unparseable frames
      }
    };

    ws.onclose = () => {
      this.ws = null;
      this.stopHeartbeat();
      if (!this.intentional) this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose follows; no explicit handling needed here
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempt >= MAX_RECONNECT) {
      this.handlers.onStatus?.(false);
      return;
    }
    const delay = 300 * Math.pow(2, this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastReceivedAt > TIMEOUT_MS) {
        this.ws.close();
        return;
      }
      try {
        this.ws.send(JSON.stringify({ type: "ping" }));
      } catch {
        // socket closing
      }
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  sendOp(op: {
    id: string;
    kind: AnnotationOp["kind"];
    page: number;
    color: string;
    width: number;
    opacity: number;
    points: AnnotationOp["points"];
    text?: string;
    target?: string | null;
  }): void {
    this.send({ type: "op", ...op });
  }

  sendPresence(presence: Record<string, unknown>): void {
    this.send({ type: "presence", ...presence });
  }

  /** Ask to become the presenter (whose scroll everyone follows). */
  setPresenter(): void {
    this.send({ type: "set_presenter" });
  }

  /** Owner-only: wipe all annotations. */
  clearAnnotations(): void {
    this.send({ type: "clear_annotations" });
  }

  disconnect(): void {
    this.intentional = true;
    this.join = null;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
