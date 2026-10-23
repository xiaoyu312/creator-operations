#!/usr/bin/env python3
"""Render this repository's self-contained SVG social image. No network access.

Requires Python 3, PyMuPDF (fitz), and Pillow already available in the environment.
From the repository root: python3 assets/social/generate.py
"""
from io import BytesIO
from pathlib import Path
import json
import re
import xml.etree.ElementTree as ET

import fitz
from PIL import Image

WIDTH, HEIGHT = 1280, 640
MAX_BYTES = 1_000_000
HERE = Path(__file__).resolve().parent


def main():
    source = HERE / "social-preview.svg"
    target = HERE / "social-preview.png"
    svg = source.read_bytes()
    root = ET.fromstring(svg)
    if root.attrib.get("width") != str(WIDTH) or root.attrib.get("height") != str(HEIGHT):
        raise ValueError("The SVG must be exactly 1280 by 640 pixels.")
    # Keep the source standalone: no embedded UI, remote assets, scripts, or fonts.
    for element in root.iter():
        tag = element.tag.rsplit("}", 1)[-1]
        if tag in {"script", "image", "foreignObject", "style"}:
            raise ValueError(f"Unsupported external or active content: {tag}")
        if any(key.rsplit("}", 1)[-1] == "href" for key in element.attrib):
            raise ValueError("External or linked SVG resources are not allowed.")
    if re.search(rb"@import|url\s*\(", svg, re.I):
        raise ValueError("Linked CSS or font resources are not allowed.")
    with fitz.open(stream=svg, filetype="svg") as vector:
        pdf_data = vector.convert_to_pdf()
    with fitz.open(stream=pdf_data, filetype="pdf") as document:
        page = document[0]
        # Check actual rendered text bounds before rasterizing.
        for block in page.get_text("dict")["blocks"]:
            for line in block.get("lines", []):
                for span in line["spans"]:
                    x0, y0, x1, y1 = span["bbox"]
                    if x0 < 64 or y0 < 64 or x1 > WIDTH - 64 or y1 > HEIGHT - 64:
                        raise ValueError(f"Text leaves the 64px safe area: {span['text']}")
        pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
        image = Image.open(BytesIO(pixmap.tobytes("png"))).convert("RGB")
        image = image.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)
        buffer = BytesIO()
        image.save(buffer, format="PNG", optimize=True, compress_level=9)
    png = buffer.getvalue()
    if len(png) >= MAX_BYTES:
        raise ValueError(f"PNG must be strictly smaller than {MAX_BYTES} bytes.")
    target.write_bytes(png)
    print(json.dumps({"file": target.name, "width": WIDTH, "height": HEIGHT,
                      "bytes": len(png), "text_safe_margin_px": 64}))


if __name__ == "__main__":
    main()
