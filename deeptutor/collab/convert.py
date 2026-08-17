"""Optional server-side document → PDF conversion for annotation.

PDF is the annotation canvas: every non-PDF source (DOCX/PPTX/…) is converted
to PDF once and cached, so the annotation model (PDF page space) stays uniform
and the export bakes ink into a real PDF. Conversion uses LibreOffice headless;
when it is absent, callers receive a clear "install LibreOffice" error instead
of a silent render failure.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

PDF_SUFFIX = ".pdf"
DOCX_SUFFIX = ".docx"

_SOFFICE_TIMEOUT_SECONDS = 180


def soffice_path() -> str | None:
    """Locate the LibreOffice headless binary.

    ``brew install --cask libreoffice`` installs the app without symlinking
    ``soffice`` onto PATH, so we also probe the standard macOS app bundle and
    the two common Homebrew bin roots.
    """
    path = shutil.which("soffice")
    if path:
        return path
    candidates = [
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        "/opt/homebrew/bin/soffice",
        "/usr/local/bin/soffice",
    ]
    for candidate in candidates:
        if Path(candidate).is_file():
            return candidate
    return None


def is_pdf_source(mime: str, filename: str) -> bool:
    return mime == "application/pdf" or Path(filename or "").suffix.lower() == PDF_SUFFIX


def convert_to_pdf(source_path: Path, out_dir: Path) -> Path | None:
    """Convert *source_path* to PDF into *out_dir*; return the produced path.

    Returns ``None`` when LibreOffice is unavailable or the conversion failed,
    so the caller can raise a helpful HTTP error.
    """
    soffice = soffice_path()
    if not soffice:
        return None
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        result = subprocess.run(
            [
                soffice,
                "--headless",
                "--convert-to",
                "pdf",
                "--outdir",
                str(out_dir),
                str(source_path),
            ],
            capture_output=True,
            timeout=_SOFFICE_TIMEOUT_SECONDS,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        logger.warning("soffice conversion failed for %s: %s", source_path, exc)
        return None
    if result.returncode != 0:
        logger.warning(
            "soffice conversion returned %s: %s",
            result.returncode,
            result.stderr.decode("utf-8", "replace")[:400],
        )
        return None
    target = out_dir / (source_path.stem + PDF_SUFFIX)
    return target if target.is_file() else None


__all__ = ["convert_to_pdf", "is_pdf_source", "soffice_path"]
