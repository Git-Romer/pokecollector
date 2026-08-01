"""Compose several single-card photos into one labeled grid image for a batched
Gemini scan call, and split an upload list into fixed-size chunks for that.

Grid size is locked at 2x2 (4 cards/call) based on real-card accuracy testing:
solid results held through at least 9-card grids, but so did a set_code
hallucination bug independent of grid size; 4 was chosen as the most
conservative validated size rather than pushing toward the tested ceiling.
"""

from __future__ import annotations

import io

from PIL import Image, ImageDraw, ImageFont

GRID_COLS = 2
GRID_SIZE = 4
CELL_SIZE = (420, 588)  # ~2.5:3.5, matches a standard card's aspect ratio
GUTTER = 16
LABEL_BOX = 54


def chunk_for_composite(items: list, *, size: int = GRID_SIZE) -> list[list]:
    """Split a flat list into chunks of at most `size` items (last one may be smaller)."""
    return [items[i:i + size] for i in range(0, len(items), size)]


def build_composite(
    images: list[bytes],
    *,
    cols: int = GRID_COLS,
    cell_size: tuple[int, int] = CELL_SIZE,
    gutter: int = GUTTER,
    label_box: int = LABEL_BOX,
) -> bytes:
    """Lay up to GRID_SIZE single-card photos into one labeled grid JPEG.

    Each cell gets a burned-in 1-based index number in its top-left corner so
    the Gemini response can echo back which cell it actually read, rather than
    the mapping relying on the model preserving array order.
    """
    if not images:
        raise ValueError("build_composite requires at least one image")

    n = len(images)
    rows = (n + cols - 1) // cols
    cell_w, cell_h = cell_size
    canvas_w = cols * cell_w + (cols + 1) * gutter
    canvas_h = rows * cell_h + (rows + 1) * gutter
    canvas = Image.new("RGB", (canvas_w, canvas_h), "white")
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default(size=int(label_box * 0.7))

    for i, image_bytes in enumerate(images):
        row, col = divmod(i, cols)
        x = gutter + col * (cell_w + gutter)
        y = gutter + row * (cell_h + gutter)

        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        img.thumbnail((cell_w, cell_h), Image.LANCZOS)
        paste_x = x + (cell_w - img.width) // 2
        paste_y = y + (cell_h - img.height) // 2
        canvas.paste(img, (paste_x, paste_y))

        draw.rectangle([x, y, x + label_box, y + label_box], fill="black")
        draw.text((x + label_box * 0.2, y + label_box * 0.05), str(i + 1), fill="white", font=font)

    out = io.BytesIO()
    canvas.save(out, format="JPEG", quality=92)
    return out.getvalue()
