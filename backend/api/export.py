from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, joinedload
from api.auth import get_current_user
from database import get_db
from services.card_values import effective_market_price, normalize_price_field
from services.card_visibility import visible_any_card_filter
from services.printing_details import format_printing_details_csv
from services.exchange_rates import (
    ExchangeRateError,
    ExchangeRateUnavailable,
    get_exchange_rate,
    normalize_currency_code,
)
from models import CollectionItem, Card, User
import io
import csv
import datetime
from xml.sax.saxutils import escape

router = APIRouter()


def _export_currency_and_rate(value: str | None) -> tuple[str, float]:
    try:
        currency = normalize_currency_code(value or "EUR")
    except ExchangeRateError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None

    try:
        quote = get_exchange_rate("EUR", currency)
    except ExchangeRateUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None
    return currency, float(quote["rate"])


def _convert_eur(amount: float | None, exchange_rate: float) -> float | None:
    if amount is None:
        return None
    return float(amount) * exchange_rate


def _format_money(amount: float | None, currency: str) -> str:
    if amount is None:
        return "-"
    return f"{currency} {amount:,.2f}"


@router.get("/csv")
def export_csv(
    price_field: str = Query(default="price_trend", description="Price field to use for value calculation"),
    currency: str = Query(default="EUR", description="Display currency"),
    exchange_rate: float | None = Query(default=None, gt=0, include_in_schema=False),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Export collection as CSV in the requested display currency."""
    price_field = normalize_price_field(price_field)
    currency, conversion_rate = _export_currency_and_rate(currency)
    items = db.query(CollectionItem).join(Card, Card.id == CollectionItem.card_id).options(
        joinedload(CollectionItem.card).joinedload(Card.set_ref)
    ).filter(
        CollectionItem.user_id == current_user.id,
        visible_any_card_filter(db, current_user.id, "all"),
    ).all()

    output = io.StringIO()
    writer = csv.writer(output)

    # Header
    writer.writerow([
        "Card ID", "Name", "Set", "Number", "Rarity",
        "Quantity", "Condition", "Variant", "Language", "Printing Details",
        f"Purchase Price ({currency})",
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
        display_current_price = _convert_eur(current_price, conversion_rate)
        display_purchase_price = _convert_eur(item.purchase_price, conversion_rate)
        total_value = round((display_current_price or 0) * item.quantity, 2)

        writer.writerow([
            card.id,
            card.name,
            set_name,
            card.number or "",
            card.rarity or "",
            item.quantity,
            item.condition,
            item.variant,
            item.lang,
            format_printing_details_csv(item.printing_detail_tags),
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
    exchange_rate: float | None = Query(default=None, gt=0, include_in_schema=False),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Export collection as PDF in the requested display currency."""
    price_field = normalize_price_field(price_field)
    currency, conversion_rate = _export_currency_and_rate(currency)
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
            visible_any_card_filter(db, current_user.id, "all"),
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
        headers = ["Name", "Set", "No.", "Rarity", "Qty", "Condition", "Variant", "Lang", "Printing Details", f"Buy {currency}", f"Current {currency}", f"Value {currency}"]
        data = [headers]
        detail_style = ParagraphStyle(
            "PrintingDetails",
            parent=styles["Normal"],
            fontSize=7,
            leading=8,
        )

        total_value = 0
        for item in items:
            card = item.card
            if not card:
                continue
            set_name = (card.set_ref.name[:20] if card.set_ref else "")
            current_price = _convert_eur(
                effective_market_price(card, item.variant, price_field), conversion_rate
            )
            purchase_price = _convert_eur(item.purchase_price, conversion_rate)
            val = round((current_price or 0) * item.quantity, 2)
            total_value += val

            data.append([
                card.name[:30],
                set_name,
                card.number or "-",
                (card.rarity or "-")[:15],
                str(item.quantity),
                item.condition,
                item.variant,
                item.lang,
                Paragraph(
                    escape(format_printing_details_csv(item.printing_detail_tags) or "-"),
                    detail_style,
                ),
                _format_money(purchase_price, currency) if purchase_price else "-",
                _format_money(current_price, currency) if current_price else "-",
                _format_money(val, currency),
            ])

        # Summary row
        data.append(["", "", "", "", "", "", "", "", "", "", "TOTAL:", _format_money(total_value, currency)])

        col_widths = [72, 55, 25, 50, 24, 44, 55, 27, 92, 45, 52, 52]
        table = Table(data, colWidths=col_widths)
        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EE1515")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
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
