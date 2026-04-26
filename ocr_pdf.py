"""
ocr_pdf.py  —  Hybrid PDF → text extractor
  1. Try PyMuPDF direct text extraction (fast, perfect for digital PDFs).
  2. If a page yields fewer than MIN_CHARS characters, fall back to EasyOCR
     (handles scanned / image-only pages).

Usage:
    python ocr_pdf.py [input.pdf] [output.txt]
Defaults to Docs/project.pdf → Docs/project.txt
"""

import sys
import io
import numpy as np

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

import fitz          # PyMuPDF
from pathlib import Path

# Pages with fewer extracted characters than this are treated as scanned images
MIN_CHARS = 50


def page_to_numpy(page, dpi: int = 300) -> np.ndarray:
    """Render a fitz page to an RGB numpy array at the given DPI."""
    mat = fitz.Matrix(dpi / 72, dpi / 72)
    pix = page.get_pixmap(matrix=mat, colorspace=fitz.csRGB)
    # pix.samples is a bytes object: H × W × 3 (RGB)
    arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
    return arr


def pdf_to_text(pdf_path: str, output_path: str, lang: list = None) -> None:
    if lang is None:
        lang = ["en"]

    pdf_path    = Path(pdf_path)
    output_path = Path(output_path)

    if not pdf_path.exists():
        print(f"ERROR: file not found: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Opening: {pdf_path}")
    doc = fitz.open(str(pdf_path))
    total = len(doc)

    # Determine which pages need OCR before loading the heavy EasyOCR model
    needs_ocr = []
    direct_texts = []

    for i in range(total):
        page = doc[i]
        text = page.get_text("text").strip()
        direct_texts.append(text)
        if len(text) < MIN_CHARS:
            needs_ocr.append(i)

    if needs_ocr:
        print(f"Pages needing OCR ({len(needs_ocr)}/{total}): {[p+1 for p in needs_ocr]}")
        print("Loading EasyOCR model (first run downloads ~100 MB) …")
        import easyocr
        reader = easyocr.Reader(lang, gpu=False)
    else:
        reader = None
        print(f"All {total} pages have embedded text — skipping OCR entirely.")

    all_text: list[str] = []

    for i in range(total):
        page = doc[i]
        print(f"Page {i+1}/{total} … ", end="", flush=True)

        if i not in needs_ocr:
            # Use the already-extracted direct text
            text = direct_texts[i]
            print(f"direct ({len(text)} chars)")
        else:
            # OCR path: render to numpy array (more compatible than raw bytes)
            img = page_to_numpy(page, dpi=300)
            results = reader.readtext(img, detail=0, paragraph=False)
            if not results:
                # paragraph=False failed — try without grouping as final fallback
                results = reader.readtext(img, detail=0)
            text = "\n".join(str(r) for r in results)
            print(f"OCR ({len(text)} chars)")

        all_text.append(f"--- Page {i+1} ---\n{text}")

    doc.close()

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n\n".join(all_text), encoding="utf-8")
    print(f"\nSaved → {output_path}")


if __name__ == "__main__":
    pdf = sys.argv[1] if len(sys.argv) > 1 else "Docs/project.pdf"
    out = sys.argv[2] if len(sys.argv) > 2 else "Docs/project.txt"
    pdf_to_text(pdf, out)
