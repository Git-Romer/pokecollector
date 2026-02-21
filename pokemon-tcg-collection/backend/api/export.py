from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, joinedload
from database import get_db
from models import CollectionItem, Card
import io
import csv
import datetime

router = APIRouter()


@router.get("/csv")
def export_csv(db: Session = Depends(get_db)):
    """Export collection as CSV."""
    items = db.query(CollectionItem).options(
        joinedload(CollectionItem.card).joinedload(Card.set_ref)
    ).all()

    output = io.StringIO()
    writer = csv.writer(output)

    # Header
    writer.writerow([
        "Card ID", "Name", "Set", "Number", "Rarity",
        "Quantity", "Condition", "Purchase Price (€)",
        "Current Market Price (€)", "Total Value (€)",
        "Added At"
    ])

    # Rows
    for item in items:
        card = item.card
        if not card:
            continue
        set_name = card.set_ref.name if card.set_ref else ""
        total_value = round((card.price_market or 0) * item.quantity, 2)

        writer.writerow([
            card.id,
            card.name,
            set_name,
            card.number or "",
            card.rarity or "",
            item.quantity,
            item.condition,
            item.purchase_price or "",
            card.price_market or "",
            total_value,
            item.added_at.strftime("%Y-%m-%d") if item.added_at else "",
        ])

    output.seek(0)
    filename = f"pokemon_collection_{datetime.date.today().isoformat()}.csv"

    return StreamingResponse(
        io.BytesIO(output.getvalue().encode("utf-8-sig")),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.get("/pdf")
def export_pdf(db: Session = Depends(get_db)):
    """Export collection as PDF."""
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
        from reportlab.lib.units import mm

        items = db.query(CollectionItem).options(
            joinedload(CollectionItem.card).joinedload(Card.set_ref)
        ).all()

        buffer = io.BytesIO()
        doc = SimpleDocTemplate(
            buffer,
            pagesize=landscape(A4),
            rightMargin=10*mm,
            leftMargin=10*mm,
            topMargin=10*mm,
            bottomMargin=10*mm,
        )

        styles = getSampleStyleSheet()
        story = []

        # Title
        title_style = ParagraphStyle(
            "Title",
            parent=styles["Title"],
            fontSize=18,
            spaceAfter=6,
        )
        story.append(Paragraph("Pokemon TCG Collection", title_style))
        story.append(Paragraph(
            f"Exported: {datetime.date.today().isoformat()} | Total cards: {sum(i.quantity for i in items)}",
            styles["Normal"]
        ))
        story.append(Spacer(1, 10*mm))

        # Table
        headers = ["Name", "Set", "No.", "Rarity", "Qty", "Condition", "Buy €", "Market €", "Value €"]
        data = [headers]

        total_value = 0
        for item in items:
            card = item.card
            if not card:
                continue
            set_name = (card.set_ref.name[:20] if card.set_ref else "")
            val = round((card.price_market or 0) * item.quantity, 2)
            total_value += val

            data.append([
                card.name[:30],
                set_name,
                card.number or "-",
                (card.rarity or "-")[:15],
                str(item.quantity),
                item.condition,
                f"€{item.purchase_price:.2f}" if item.purchase_price else "-",
                f"€{card.price_market:.2f}" if card.price_market else "-",
                f"€{val:.2f}",
            ])

        # Summary row
        data.append(["", "", "", "", "", "", "", "TOTAL:", f"€{total_value:.2f}"])

        col_widths = [100, 80, 30, 80, 25, 50, 45, 55, 55]
        table = Table(data, colWidths=col_widths)
        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EE1515")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, 0), 9),
            ("FONTSIZE", (0, 1), (-1, -1), 8),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.HexColor("#f5f5f5"), colors.white]),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#ffe0e0")),
        ]))

        story.append(table)
        doc.build(story)
        buffer.seek(0)

        filename = f"pokemon_collection_{datetime.date.today().isoformat()}.pdf"
        return StreamingResponse(
            buffer,
            media_type="application/pdf",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )

    except ImportError:
        return {"error": "reportlab not installed"}
