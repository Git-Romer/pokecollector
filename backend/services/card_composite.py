"""Build small labelled image grids for multi-card Gemini recognition."""

from __future__ import annotations

import io

from PIL import Image, ImageDraw, ImageFont


GRID_COLUMNS = 2
GRID_SIZE = 4
CELL_SIZE = (640, 896)
GUTTER = 20
LABEL_BOX = 64


def build_composite(images: list[bytes]) -> bytes:
    """Lay out two to four card photos as a labelled JPEG.

    Two photos form a 1x2 row. Three and four photos use a 2x2 canvas, leaving
    the fourth cell blank for a three-photo group. Labels make result mapping
    independent of Gemini's response ordering.
    """
    if not 2 <= len(images) <= GRID_SIZE:
        raise ValueError("A composite requires between two and four images.")

    rows = 1 if len(images) == 2 else 2
    cell_width, cell_height = CELL_SIZE
    canvas = Image.new(
        "RGB",
        (
            GRID_COLUMNS * cell_width + (GRID_COLUMNS + 1) * GUTTER,
            rows * (LABEL_BOX + cell_height) + (rows + 1) * GUTTER,
        ),
        "white",
    )
    draw = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.load_default(size=int(LABEL_BOX * 0.65))
    except TypeError:  # Pillow < 10.1
        font = ImageFont.load_default()

    for index, image_bytes in enumerate(images):
        row, column = divmod(index, GRID_COLUMNS)
        x = GUTTER + column * (cell_width + GUTTER)
        label_y = GUTTER + row * (LABEL_BOX + cell_height + GUTTER)
        y = label_y + LABEL_BOX
        with Image.open(io.BytesIO(image_bytes)) as source:
            card = source.convert("RGB")
            card.thumbnail((cell_width, cell_height), Image.Resampling.LANCZOS)
            canvas.paste(
                card,
                (
                    x + (cell_width - card.width) // 2,
                    y + (cell_height - card.height) // 2,
                ),
            )
        draw.rectangle((x, label_y, x + LABEL_BOX, label_y + LABEL_BOX), fill="black")
        draw.text(
            (x + LABEL_BOX * 0.25, label_y + LABEL_BOX * 0.1),
            str(index + 1),
            fill="white",
            font=font,
        )

    output = io.BytesIO()
    canvas.save(output, format="JPEG", quality=92, optimize=True)
    return output.getvalue()
