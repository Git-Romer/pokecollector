from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, joinedload
from api.auth import get_current_user
from database import get_db
from services.card_values import effective_market_price, normalize_price_field
from services.card_visibility import visible_card_filter
from models import CollectionItem, Card, User
import io
import csv
import datetime

router = APIRouter()


def _normalize_currency(value: str | None) -> tuple[str, str]:
    currency = (value or "EUR").upper()
    if currency == "USD":
        return "USD", "$"
    return "EUR", "€"


def _convert_eur(amount: float | None, exchange_rate: float, currency: str) -> float | None:
    if amount is None:
        return None
    return float(amount) * exchange_rate if currency == "USD" else float(amount)


def _format_money(amount: float | None, symbol: str) -> str:
    if amount is None:
        return "-"
    return f"{symbol}{amount:.2f}"


@router.get("/csv")
def export_csv(
    price_field: str = Query(default="price_trend", description="Price field to use for value calculation"),
    currency: str = Query(default="EUR", description="Display currency"),
    exchange_rate: float = Query(default=1.0, gt=0, description="EUR to selected currency rate"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Export collection as CSV."""
    price_field = normalize_price_field(price_field)
    currency, symbol = _normalize_currency(currency)
    items = db.query(CollectionItem).join(Card, Card.id == CollectionItem.card_id).options(
        joinedload(CollectionItem.card).joinedload(Card.set_ref)
    ).filter(
        CollectionItem.user_id == current_user.id,
        visible_card_filter(db, current_user.id, "all"),
    ).all()

    output = io.StringIO()
    writer = csv.writer(output)

    # Header
    writer.writerow([
        "Card ID", "Name", "Set", "Number", "Rarity",
        "Quantity", "Condition", f"Purchase Price ({currency})",
        f"Current Price ({currency})", f"Total Value ({currency})",
        "Added At"
    ])

    # Rows
    for item in items:
        card = item.card
        if not card:
            continue
        set_name = card.set_ref.name if card.set_ref else ""
        current_price = effective_market_price(card, item.variant, price_field)
        display_current_price = _convert_eur(current_price, exchange_rate, currency)
        display_purchase_price = _convert_eur(item.purchase_price, exchange_rate, currency)
        total_value = round((display_current_price or 0) * item.quantity, 2)

        writer.writerow([
            card.id,
            card.name,
            set_name,
            card.number or "",
            card.rarity or "",
            item.quantity,
            item.condition,
            display_purchase_price or "",
            display_current_price or "",
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
def export_pdf(
    price_field: str = Query(default="price_trend", description="Price field to use for value calculation"),
    currency: str = Query(default="EUR", description="Display currency"),
    exchange_rate: float = Query(default=1.0, gt=0, description="EUR to selected currency rate"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Export collection as PDF."""
    price_field = normalize_price_field(price_field)
    currency, symbol = _normalize_currency(currency)
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
        from reportlab.lib.units import mm

        items = db.query(CollectionItem).join(Card, Card.id == CollectionItem.card_id).options(
            joinedload(CollectionItem.card).joinedload(Card.set_ref)
        ).filter(
            CollectionItem.user_id == current_user.id,
            visible_card_filter(db, current_user.id, "all"),
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
        headers = ["Name", "Set", "No.", "Rarity", "Qty", "Condition", f"Buy {currency}", f"Current {currency}", f"Value {currency}"]
        data = [headers]

        total_value = 0
        for item in items:
            card = item.card
            if not card:
                continue
            set_name = (card.set_ref.name[:20] if card.set_ref else "")
            current_price = _convert_eur(effective_market_price(card, item.variant, price_field), exchange_rate, currency)
            purchase_price = _convert_eur(item.purchase_price, exchange_rate, currency)
            val = round((current_price or 0) * item.quantity, 2)
            total_value += val

            data.append([
                card.name[:30],
                set_name,
                card.number or "-",
                (card.rarity or "-")[:15],
                str(item.quantity),
                item.condition,
                _format_money(purchase_price, symbol) if purchase_price else "-",
                _format_money(current_price, symbol) if current_price else "-",
                _format_money(val, symbol),
            ])

        # Summary row
        data.append(["", "", "", "", "", "", "", "TOTAL:", _format_money(total_value, symbol)])

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
