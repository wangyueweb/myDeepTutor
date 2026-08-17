"""Bake collaborative annotations into a new PDF via PyMuPDF (native annotations).

The source PDF is never mutated: a new file is written with every annotation
recreated as a native PDF annotation (ink / highlight / free text / note), which
preserves stroke vectors, colour, width and opacity and stays viewable in any
PDF reader.
"""

from __future__ import annotations

import math
import logging
from pathlib import Path

from deeptutor.collab.models import AnnotationOp

logger = logging.getLogger(__name__)


def _hex_to_rgb(color: str) -> tuple[float, float, float]:
    raw = (color or "").strip().lstrip("#")
    if len(raw) < 6:
        return (0.88, 0.11, 0.28)  # default rose
    try:
        r = int(raw[0:2], 16) / 255.0
        g = int(raw[2:4], 16) / 255.0
        b = int(raw[4:6], 16) / 255.0
        return (r, g, b)
    except ValueError:
        return (0.88, 0.11, 0.28)


def _points_to_quads(points: list, width: float) -> list:
    """Convert a polyline to per-segment quads for a highlight annotation."""
    import fitz

    quads: list[fitz.Quad] = []
    if len(points) < 2:
        return quads
    off = max(width, 1.0) / 2.0
    for i in range(len(points) - 1):
        p0 = points[i]
        p1 = points[i + 1]
        dx = p1.x - p0.x
        dy = p1.y - p0.y
        length = math.hypot(dx, dy)
        if length < 1e-6:
            continue
        nx = -dy / length
        ny = dx / length
        ul = (p0.x + nx * off, p0.y + ny * off)
        ur = (p1.x + nx * off, p1.y + ny * off)
        ll = (p0.x - nx * off, p0.y - ny * off)
        lr = (p1.x - nx * off, p1.y - ny * off)
        quads.append(fitz.Quad(ul, ur, ll, lr))
    return quads


def export_annotated_pdf(
    source_path: Path,
    items: dict[str, AnnotationOp],
    out_path: Path,
) -> Path:
    """Write ``out_path`` as the source PDF with all annotations baked in.

    ``items`` is the live (non-deleted) op map, values sorted by ``seq`` so the
    layering is deterministic. Errors on an individual annotation are logged and
    skipped so one malformed stroke can't block an export.
    """
    import fitz

    doc = fitz.open(str(source_path))
    try:
        ordered = sorted(items.values(), key=lambda op: op.seq)
        for op in ordered:
            try:
                _apply_op(doc, op)
            except Exception:
                logger.warning("failed to bake annotation %s: ", op.id, exc_info=True)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        doc.save(str(out_path), garbage=4, deflate=True)
    finally:
        doc.close()
    return out_path


def _apply_op(doc, op: AnnotationOp) -> None:
    import fitz

    if op.kind == "erase":
        return
    page_count = doc.page_count
    if op.page < 0 or op.page >= page_count:
        return
    page = doc[op.page]
    rgb = _hex_to_rgb(op.color)

    if op.kind == "ink":
        pts = [(p.x, p.y) for p in op.points]
        if len(pts) < 2:
            return
        annot = page.add_ink_annot([pts])
        annot.set_colors(stroke=rgb)
        annot.set_border(width=max(op.width, 0.3))
        annot.set_opacity(max(0.0, min(1.0, op.opacity)))
        annot.update()
        return

    if op.kind == "highlight":
        quads = _points_to_quads(op.points, max(op.width, 4.0))
        if not quads:
            return
        annot = page.add_highlight_annot(quads)
        annot.set_colors(stroke=rgb)
        annot.set_opacity(max(0.0, min(1.0, op.opacity)))
        annot.update()
        return

    if op.kind == "textbox":
        rect = _points_rect(op.points)
        text = op.text or ""
        annot = page.add_freetext_annot(
            rect,
            text,
            fontsize=11,
            fontname="helv",
            text_color=rgb,
            fill_color=(1.0, 1.0, 1.0),
        )
        try:
            annot.set_border(width=1)
            annot.set_colors(stroke=rgb, fill=(1.0, 1.0, 1.0))
        except Exception:
            pass
        annot.set_opacity(max(0.0, min(1.0, op.opacity)))
        annot.update()
        return

    if op.kind == "note":
        point = (op.points[0].x, op.points[0].y) if op.points else (72, 72)
        annot = page.add_text_annot(fitz.Point(*point), op.text or "")
        annot.set_info(title=op.author_name or "批注", content=op.text or "")
        annot.update()
        return


def _points_rect(points: list) -> object:
    import fitz

    if points:
        xs = [p.x for p in points]
        ys = [p.y for p in points]
        x0, x1 = min(xs), max(xs)
        y0, y1 = min(ys), max(ys)
        if x1 - x0 < 60:
            x1 = x0 + 60
        if y1 - y0 < 20:
            y1 = y0 + 20
        return fitz.Rect(x0, y0, x1, y1)
    return fitz.Rect(72, 72, 260, 120)


__all__ = ["export_annotated_pdf"]
