"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, PageViewport } from "pdfjs-dist";
import { Loader2, AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { apiFetch } from "@/lib/api";
import { useCollab, newOpId } from "./CollabProvider";
import type { AnnotationOp, InkPoint, Tool } from "@/lib/collab-types";
import { colorToRgba } from "@/lib/collab-types";

interface PageEntry {
  wrap: HTMLDivElement | null;
  base: HTMLCanvasElement | null;
  ink: HTMLCanvasElement | null;
  viewport: PageViewport | null;
  scale: number;
}

interface TextEdit {
  pageNo: number; // 1-based
  x: number; // PDF page space
  y: number;
  draft: string;
}

interface AnnotatablePdfViewerProps {
  sourceUrl: string;
  tool: Tool;
  color: string;
  width: number;
  followOwner: boolean;
}

const ERASE_RADIUS = 10; // PDF units (points)

function drawOp(ctx: CanvasRenderingContext2D, op: AnnotationOp): void {
  const pts = op.points || [];

  if (op.kind === "ink" || op.kind === "highlight") {
    if (pts.length < 2) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = colorToRgba(op.color, op.opacity);
    ctx.lineWidth = Math.max(op.width, 0.5);
    if (op.kind === "highlight") ctx.globalCompositeOperation = "multiply";
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (op.kind === "textbox" && pts.length >= 2) {
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const w = Math.max(...xs) - x0;
    const h = Math.max(...ys) - y0;
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.strokeStyle = op.color;
    ctx.lineWidth = 1;
    ctx.fillRect(x0, y0, Math.max(w, 60), Math.max(h, 20));
    ctx.strokeRect(x0, y0, Math.max(w, 60), Math.max(h, 20));
    ctx.fillStyle = op.color;
    ctx.font = "11px sans-serif";
    ctx.fillText(op.text || "", x0 + 4, y0 + 14);
    ctx.restore();
    return;
  }

  if (op.kind === "note") {
    const p = pts[0] || { x: 0, y: 0 };
    ctx.save();
    ctx.fillStyle = "#facc15";
    ctx.fillRect(p.x, p.y, 14, 14);
    ctx.restore();
    return;
  }
}

function distanceToSegment(
  pt: InkPoint,
  a: InkPoint,
  b: InkPoint,
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(pt.x - a.x, pt.y - a.y);
  let t = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy));
}

function distanceToPolyline(pt: InkPoint, points: InkPoint[]): number {
  if (points.length === 0) return Infinity;
  if (points.length === 1) return Math.hypot(pt.x - points[0].x, pt.y - points[0].y);
  let min = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    min = Math.min(min, distanceToSegment(pt, points[i], points[i + 1]));
  }
  return min;
}

export default function AnnotatablePdfViewer({
  sourceUrl,
  tool,
  color,
  width,
  followOwner,
}: AnnotatablePdfViewerProps) {
  const { t } = useTranslation();
  const { annotations, members, role, memberId, presenterId, sendOp, applyLocalOp, sendPresence } =
    useCollab();

  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef(new Map<number, PageEntry>());
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const currentStrokeRef = useRef<AnnotationOp | null>(null);
  const lastEraseRef = useRef<string | null>(null);
  const lastProgrammaticScrollRef = useRef(0);
  const lastPresenceRef = useRef(0);
  const lastSentPageRef = useRef(-1);

  const [numPages, setNumPages] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const textEditRef = useRef<TextEdit | null>(null);
  textEditRef.current = textEdit;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const textOpenedAtRef = useRef(0);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const panStartRef = useRef<{ scrollTop: number; midY: number } | null>(null);

  const canAnnotate = role === "owner" || role === "editor";

  // Apply touch-action/pointer-events synchronously via DOM so the browser
  // respects the new value on the very next touch (no frame delay between the
  // React state update and the user's next gesture).
  useLayoutEffect(() => {
    const ta = canAnnotate ? "none" : "auto";
    const pe = canAnnotate ? "auto" : "none";
    pageRefs.current.forEach((entry) => {
      if (entry.ink) {
        entry.ink.style.touchAction = ta;
        entry.ink.style.pointerEvents = pe;
        // Force a synchronous reflow so the browser commits the style change
        // before the next touch event can be dispatched.
        void entry.ink.offsetHeight;
      }
    });
  }, [canAnnotate]);

  // Focus the textbox editor once it mounts. More reliable than `autoFocus`,
  // which the opening pointer event can steal back immediately.
  useEffect(() => {
    if (textEdit) {
      const timer = setTimeout(() => textareaRef.current?.focus(), 0);
      return () => clearTimeout(timer);
    }
  }, [textEdit]);

  // Measure the viewport width so pages can fit-to-width.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setContainerWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Load the PDF (via authenticated fetch, so auth works when enabled).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setFailed(null);
      try {
        const res = await apiFetch(sourceUrl);
        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try {
            const body = (await res.json()) as { detail?: string };
            if (body && typeof body.detail === "string" && body.detail) {
              detail = body.detail;
            }
          } catch {
            // non-JSON error body — keep the HTTP code
          }
          throw new Error(detail);
        }
        const buffer = await res.arrayBuffer();
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
        if (cancelled) {
          void pdf.destroy();
          return;
        }
        pdfRef.current = pdf;
        setNumPages(pdf.numPages);
      } catch (err) {
        if (!cancelled) setFailed(err instanceof Error ? err.message : "failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      pdfRef.current?.destroy();
      pdfRef.current = null;
    };
  }, [sourceUrl]);

  // Render each page's base canvas once the PDF + width are ready.
  useEffect(() => {
    const pdf = pdfRef.current;
    if (!pdf || containerWidth <= 0) return;
    let cancelled = false;
    (async () => {
      for (let i = 1; i <= pdf.numPages; i++) {
        const entry = pageRefs.current.get(i);
        if (!entry || !entry.base || !entry.ink) continue;
        const page = await pdf.getPage(i);
        if (cancelled) return;
        const base1 = page.getViewport({ scale: 1 });
        const scale = Math.min(1.5, Math.max(0.4, containerWidth / base1.width));
        const viewport = page.getViewport({ scale });
        entry.viewport = viewport;
        entry.scale = scale;
        const dpr = window.devicePixelRatio || 1;
        for (const cv of [entry.base, entry.ink]) {
          cv.width = Math.floor(viewport.width * dpr);
          cv.height = Math.floor(viewport.height * dpr);
          cv.style.width = `${viewport.width}px`;
          cv.style.height = `${viewport.height}px`;
        }
        if (entry.wrap) entry.wrap.style.width = `${viewport.width}px`;
        const ctx = entry.base.getContext("2d");
        if (!ctx) continue;
        await page.render({
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        }).promise;
        redrawPage(i, annotationsRef.current, currentStrokeRef.current);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numPages, containerWidth]);

  // Redraw ink whenever the committed annotation set changes.
  useEffect(() => {
    pageRefs.current.forEach((_entry, i) => {
      redrawPage(i, annotations, currentStrokeRef.current);
    });
  }, [annotations]);

  const redrawPage = useCallback(
    (pageNo: number, anns: Map<string, AnnotationOp>, currentStroke: AnnotationOp | null) => {
      const entry = pageRefs.current.get(pageNo);
      if (!entry?.ink || !entry.viewport) return;
      const ctx = entry.ink.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, entry.ink.width, entry.ink.height);
      ctx.setTransform(entry.scale * dpr, 0, 0, entry.scale * dpr, 0, 0);
      for (const op of anns.values()) {
        if (op.page === pageNo - 1) drawOp(ctx, op);
      }
      if (currentStroke && currentStroke.page === pageNo - 1) drawOp(ctx, currentStroke);
    },
    [],
  );

  const toPdfPoint = useCallback(
    (clientX: number, clientY: number, pageNo: number): InkPoint => {
      const entry = pageRefs.current.get(pageNo);
      if (!entry?.ink) return { x: 0, y: 0 };
      const rect = entry.ink.getBoundingClientRect();
      return {
        x: (clientX - rect.left) / entry.scale,
        y: (clientY - rect.top) / entry.scale,
      };
    },
    [],
  );

  const beginStroke = useCallback(
    (e: React.PointerEvent, pageNo: number) => {
      const entry = pageRefs.current.get(pageNo);
      if (!entry) return;
      const pt = toPdfPoint(e.clientX, e.clientY, pageNo);
      const isHighlighter = tool === "highlighter";
      const op: AnnotationOp = {
        seq: 0,
        id: newOpId(),
        kind: isHighlighter ? "highlight" : "ink",
        page: pageNo - 1,
        author: "",
        author_name: "",
        color,
        width: isHighlighter ? Math.max(width * 3, 12) : width,
        opacity: isHighlighter ? 0.45 : 0.92,
        points: [{ x: pt.x, y: pt.y, pressure: e.pressure ?? null }],
        created_at: Date.now(),
      };
      currentStrokeRef.current = op;
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // pointer capture unsupported
      }
    },
    [tool, color, width, toPdfPoint],
  );

  const extendStroke = useCallback(
    (e: React.PointerEvent, pageNo: number) => {
      const stroke = currentStrokeRef.current;
      if (!stroke || stroke.page !== pageNo - 1) return;
      const native = e.nativeEvent as PointerEvent;
      const coalesced = native.getCoalescedEvents?.() ?? [];
      if (coalesced.length > 0) {
        for (const ev of coalesced) {
          const p = toPdfPoint(ev.clientX, ev.clientY, pageNo);
          stroke.points.push({ x: p.x, y: p.y, pressure: ev.pressure ?? null });
        }
      } else {
        const p = toPdfPoint(e.clientX, e.clientY, pageNo);
        stroke.points.push({ x: p.x, y: p.y, pressure: e.pressure ?? null });
      }
      redrawPage(pageNo, annotationsRef.current, stroke);
    },
    [toPdfPoint, redrawPage],
  );

  const endStroke = useCallback(
    (e: React.PointerEvent, pageNo: number) => {
      const stroke = currentStrokeRef.current;
      currentStrokeRef.current = null;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      if (!stroke || stroke.page !== pageNo - 1) return;
      if (stroke.points.length >= 2) {
        applyLocalOp(stroke);
        sendOp({
          id: stroke.id,
          kind: stroke.kind,
          page: stroke.page,
          color: stroke.color,
          width: stroke.width,
          opacity: stroke.opacity,
          points: stroke.points,
        });
      }
      redrawPage(pageNo, annotationsRef.current, null);
    },
    [applyLocalOp, sendOp, redrawPage],
  );

  const eraseAt = useCallback(
    (pageNo: number, pt: InkPoint) => {
      let best: AnnotationOp | null = null;
      let bestDist = ERASE_RADIUS;
      for (const op of annotationsRef.current.values()) {
        if (op.page !== pageNo - 1) continue;
        if (op.kind !== "ink" && op.kind !== "highlight") continue;
        const d = distanceToPolyline(pt, op.points);
        if (d < bestDist) {
          bestDist = d;
          best = op;
        }
      }
      if (best) {
        if (best.id === lastEraseRef.current) return;
        lastEraseRef.current = best.id;
        const eraseOp: AnnotationOp = {
          seq: 0,
          id: newOpId(),
          kind: "erase",
          page: pageNo - 1,
          author: "",
          author_name: "",
          color: "",
          width: 0,
          opacity: 0,
          points: [],
          target: best.id,
          created_at: Date.now(),
        };
        applyLocalOp(eraseOp);
        sendOp({
          id: eraseOp.id,
          kind: "erase",
          page: eraseOp.page,
          color: "",
          width: 0,
          opacity: 0,
          points: [],
          target: best.id,
        });
      }
    },
    [applyLocalOp, sendOp],
  );

  const commitTextBox = useCallback(() => {
    const edit = textEditRef.current;
    textEditRef.current = null;
    setTextEdit(null);
    if (!edit) return;
    const text = edit.draft.trim();
    if (!text) return;
    const lines = text.split("\n");
    const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
    const w = Math.max(80, Math.min(500, longest * 12 + 24));
    const h = Math.max(24, lines.length * 20 + 8);
    const id = newOpId();
    const op: AnnotationOp = {
      seq: 0,
      id,
      kind: "textbox",
      page: edit.pageNo - 1,
      author: "",
      author_name: "",
      color,
      width: 1,
      opacity: 1,
      points: [
        { x: edit.x, y: edit.y },
        { x: edit.x + w, y: edit.y + h },
      ],
      text,
      created_at: Date.now(),
    };
    applyLocalOp(op);
    sendOp({
      id,
      kind: "textbox",
      page: op.page,
      color,
      width: 1,
      opacity: 1,
      points: op.points,
      text,
    });
  }, [color, applyLocalOp, sendOp]);

  const cancelTextBox = useCallback(() => {
    textEditRef.current = null;
    setTextEdit(null);
  }, []);

  const midPointY = useCallback(() => {
    const pts = Array.from(pointersRef.current.values());
    if (pts.length === 0) return 0;
    return pts.reduce((s, p) => s + p.y, 0) / pts.length;
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, pageNo: number) => {
      if (!canAnnotate) return;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      // Second finger lands → switch from drawing to two-finger pan.
      if (pointersRef.current.size >= 2) {
        currentStrokeRef.current = null;
        panStartRef.current = {
          scrollTop: containerRef.current?.scrollTop ?? 0,
          midY: midPointY(),
        };
        return;
      }

      if (tool === "textbox") {
        const pt = toPdfPoint(e.clientX, e.clientY, pageNo);
        textOpenedAtRef.current = Date.now();
        setTextEdit({ pageNo, x: pt.x, y: pt.y, draft: "" });
        return;
      }
      if (tool === "eraser") {
        lastEraseRef.current = null;
        const pt = toPdfPoint(e.clientX, e.clientY, pageNo);
        eraseAt(pageNo, pt);
        return;
      }
      beginStroke(e, pageNo);
    },
    [canAnnotate, tool, toPdfPoint, eraseAt, beginStroke, midPointY],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent, pageNo: number) => {
      if (pointersRef.current.has(e.pointerId)) {
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }

      if (panStartRef.current) {
        const el = containerRef.current;
        if (el) {
          const delta = midPointY() - panStartRef.current.midY;
          el.scrollTop = panStartRef.current.scrollTop - delta;
        }
        return;
      }

      if (!canAnnotate) return;
      if (tool === "textbox") return;
      if (tool === "eraser") {
        const pt = toPdfPoint(e.clientX, e.clientY, pageNo);
        eraseAt(pageNo, pt);
        return;
      }
      extendStroke(e, pageNo);
    },
    [canAnnotate, tool, toPdfPoint, eraseAt, extendStroke, midPointY],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent, pageNo: number) => {
      pointersRef.current.delete(e.pointerId);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      if (panStartRef.current && pointersRef.current.size < 2) {
        panStartRef.current = null;
        return;
      }

      if (!canAnnotate || tool === "textbox" || tool === "eraser") return;
      endStroke(e, pageNo);
    },
    [canAnnotate, tool, endStroke],
  );

  const handlePointerCancel = useCallback(
    (e: React.PointerEvent) => {
      pointersRef.current.delete(e.pointerId);
      if (panStartRef.current && pointersRef.current.size < 2) {
        panStartRef.current = null;
      }
      if (pointersRef.current.size === 0) {
        currentStrokeRef.current = null;
        pageRefs.current.forEach((_entry, i) => {
          redrawPage(i, annotationsRef.current, null);
        });
      }
    },
    [redrawPage],
  );

  // ── Scroll sync ────────────────────────────────────────────────────────
  const computeScrollState = useCallback(() => {
    const el = containerRef.current;
    if (!el) return { page: 0, ratio: 0 };
    const count = pageRefs.current.size;
    if (count === 0) return { page: 0, ratio: 0 };
    const scrollTop = el.scrollTop;
    const mid = scrollTop + el.clientHeight / 2;
    let current = 1;
    for (let i = 1; i <= count; i++) {
      const wrap = pageRefs.current.get(i)?.wrap;
      if (!wrap) continue;
      if (wrap.offsetTop <= mid) current = i;
    }
    const wrap = pageRefs.current.get(current)?.wrap;
    if (!wrap) return { page: current, ratio: 0 };
    const height = wrap.offsetHeight || 1;
    const top = wrap.offsetTop || 0;
    const denom = Math.max(1, height - el.clientHeight);
    const ratio = Math.max(0, Math.min(1, (scrollTop - top) / denom));
    return { page: current, ratio };
  }, []);

  const handleScroll = useCallback(() => {
    // Ignore scrolls we caused ourselves while following the host — only
    // genuine user scrolling should broadcast and (re)take control.
    if (Date.now() - lastProgrammaticScrollRef.current < 700) return;
    const now = Date.now();
    const { page, ratio } = computeScrollState();
    const pageChanged = page !== lastSentPageRef.current;
    if (!pageChanged && now - lastPresenceRef.current < 120) return;
    lastPresenceRef.current = now;
    lastSentPageRef.current = page;
    sendPresence({ kind: "scroll", page: page - 1, scroll_ratio: ratio });
  }, [computeScrollState, sendPresence]);

  const scrollToPage = useCallback((page0: number, ratio: number) => {
    const el = containerRef.current;
    if (!el) return;
    const wrap = pageRefs.current.get(page0 + 1)?.wrap;
    if (!wrap) return;
    const height = wrap.offsetHeight || 1;
    const top = wrap.offsetTop || 0;
    const target = top + ratio * Math.max(0, height - el.clientHeight);
    lastProgrammaticScrollRef.current = Date.now();
    el.scrollTo({ top: target, behavior: "smooth" });
  }, []);

  // Follow the presenter's scroll while the "follow" toggle is on. Everyone
  // except the presenter follows, so any participant (owner or sharee) can
  // lead the viewing by taking over as presenter.
  useEffect(() => {
    if (!followOwner || !presenterId || presenterId === memberId) return;
    const presenter = members.get(presenterId);
    const p = presenter?.presence as { kind?: string; page?: number; scroll_ratio?: number } | undefined;
    if (p && p.kind === "scroll" && typeof p.page === "number") {
      scrollToPage(p.page, p.scroll_ratio ?? 0);
    }
  }, [members, followOwner, presenterId, memberId, scrollToPage]);

  const pageNumbers = useMemo(
    () => Array.from({ length: numPages }, (_, k) => k + 1),
    [numPages],
  );

  const setPageRef = useCallback((pageNo: number) => {
    let entry = pageRefs.current.get(pageNo);
    if (!entry) {
      entry = { wrap: null, base: null, ink: null, viewport: null, scale: 1 };
      pageRefs.current.set(pageNo, entry);
    }
    return entry;
  }, []);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="relative h-full w-full overflow-y-auto bg-[var(--muted)]/30"
    >
      {loading && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="flex items-center gap-2 text-[12px] text-[var(--muted-foreground)]">
            <Loader2 size={14} className="animate-spin" />
            <span>{t("Loading preview…")}</span>
          </div>
        </div>
      )}
      {failed ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-[12px] text-[var(--muted-foreground)]">
          <AlertCircle size={18} strokeWidth={1.7} className="opacity-70" />
          <p className="max-w-sm whitespace-pre-wrap">{failed}</p>
        </div>
      ) : (
        <div ref={contentRef} className="relative flex flex-col items-center py-4">
          {pageNumbers.map((pageNo) => {
            const entry = setPageRef(pageNo);
            return (
              <div
                key={pageNo}
                ref={(el) => {
                  entry.wrap = el;
                }}
                className="relative mb-4 bg-white shadow"
              >
                <canvas
                  ref={(el) => {
                    entry.base = el;
                  }}
                  className="block"
                />
                <canvas
                  ref={(el) => {
                    entry.ink = el;
                  }}
                  className="absolute inset-0"
                  style={{
                    touchAction: canAnnotate ? "none" : "auto",
                    pointerEvents: canAnnotate ? "auto" : "none",
                    userSelect: "none",
                    WebkitUserSelect: "none",
                    WebkitTouchCallout: "none",
                  }}
                  onContextMenu={(e) => e.preventDefault()}
                  onPointerDown={(e) => handlePointerDown(e, pageNo)}
                  onPointerMove={(e) => handlePointerMove(e, pageNo)}
                  onPointerUp={(e) => handlePointerUp(e, pageNo)}
                  onPointerCancel={(e) => handlePointerCancel(e)}
                />
                {textEdit && textEdit.pageNo === pageNo && (
                  <textarea
                    ref={textareaRef}
                    value={textEdit.draft}
                    onChange={(e) =>
                      setTextEdit({ ...textEdit, draft: e.target.value })
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        commitTextBox();
                      } else if (e.key === "Escape") {
                        e.stopPropagation();
                        cancelTextBox();
                      }
                    }}
                    onBlur={() => {
                      // The opening pointer event can fire a spurious blur right
                      // after mount — ignore it and keep the editor open.
                      if (Date.now() - textOpenedAtRef.current < 250) {
                        textareaRef.current?.focus();
                        return;
                      }
                      commitTextBox();
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    placeholder={t("collab.type_hint")}
                    className="absolute z-10 resize-none rounded border border-[var(--primary)] bg-white/95 p-1.5 text-[13px] text-black shadow"
                    style={{
                      left: textEdit.x * entry.scale,
                      top: textEdit.y * entry.scale,
                      minWidth: 120,
                      minHeight: 28,
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
