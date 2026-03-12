from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List, Optional
from api.auth import get_current_user
from database import get_db
from models import ProductPurchase, User
from schemas import ProductPurchaseCreate, ProductPurchaseUpdate, ProductPurchaseResponse
import datetime

router = APIRouter()

PRODUCT_TYPES = ["Booster Pack", "Booster Box", "Elite Trainer Box", "Tin", "Bundle", "Collection Box", "Blister", "Other"]


@router.get("/types")
def get_product_types():
    """Get available product types."""
    return PRODUCT_TYPES


@router.get("/", response_model=List[ProductPurchaseResponse])
def get_products(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get all product purchases."""
    products = db.query(ProductPurchase).filter(
        ProductPurchase.user_id == current_user.id
    ).order_by(
        ProductPurchase.purchase_date.desc()
    ).all()

    result = []
    for p in products:
        effective_value = p.sold_price if p.sold_price else p.current_value
        pnl = None
        pnl_percent = None
        if effective_value is not None:
            pnl = round(effective_value - p.purchase_price, 2)
            pnl_percent = round((pnl / p.purchase_price * 100) if p.purchase_price > 0 else 0, 2)

        result.append(ProductPurchaseResponse(
            id=p.id,
            product_name=p.product_name,
            product_type=p.product_type,
            purchase_price=p.purchase_price,
            current_value=p.current_value,
            sold_price=p.sold_price,
            purchase_date=p.purchase_date,
            sold_date=p.sold_date,
            notes=p.notes,
            created_at=p.created_at,
            pnl=pnl,
            pnl_percent=pnl_percent,
        ))

    return result


@router.post("/", response_model=ProductPurchaseResponse)
def create_product(
    product: ProductPurchaseCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Log a new product purchase."""
    db_product = ProductPurchase(
        product_name=product.product_name,
        product_type=product.product_type,
        purchase_price=product.purchase_price,
        current_value=product.current_value,
        sold_price=product.sold_price,
        purchase_date=product.purchase_date,
        sold_date=product.sold_date,
        notes=product.notes,
        user_id=current_user.id,
        created_at=datetime.datetime.utcnow(),
    )
    db.add(db_product)
    db.commit()
    db.refresh(db_product)

    effective_value = db_product.sold_price if db_product.sold_price else db_product.current_value
    pnl = round(effective_value - db_product.purchase_price, 2) if effective_value else None
    pnl_percent = round((pnl / db_product.purchase_price * 100) if pnl and db_product.purchase_price > 0 else 0, 2) if pnl else None

    return ProductPurchaseResponse(
        **{k: getattr(db_product, k) for k in ['id', 'product_name', 'product_type', 'purchase_price',
                                                  'current_value', 'sold_price', 'purchase_date',
                                                  'sold_date', 'notes', 'created_at']},
        pnl=pnl,
        pnl_percent=pnl_percent,
    )


@router.put("/{product_id}", response_model=ProductPurchaseResponse)
def update_product(
    product_id: int,
    update: ProductPurchaseUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update a product purchase."""
    product = db.query(ProductPurchase).filter(
        ProductPurchase.id == product_id,
        ProductPurchase.user_id == current_user.id,
    ).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    for field, value in update.dict(exclude_unset=True).items():
        setattr(product, field, value)

    db.commit()
    db.refresh(product)

    effective_value = product.sold_price if product.sold_price else product.current_value
    pnl = round(effective_value - product.purchase_price, 2) if effective_value else None
    pnl_percent = round((pnl / product.purchase_price * 100) if pnl and product.purchase_price > 0 else 0, 2) if pnl else None

    return ProductPurchaseResponse(
        **{k: getattr(product, k) for k in ['id', 'product_name', 'product_type', 'purchase_price',
                                              'current_value', 'sold_price', 'purchase_date',
                                              'sold_date', 'notes', 'created_at']},
        pnl=pnl,
        pnl_percent=pnl_percent,
    )


@router.delete("/{product_id}")
def delete_product(
    product_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a product purchase."""
    product = db.query(ProductPurchase).filter(
        ProductPurchase.id == product_id,
        ProductPurchase.user_id == current_user.id,
    ).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    db.delete(product)
    db.commit()
    return {"message": "Product deleted"}


@router.get("/summary")
def get_products_summary(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get product investment summary (broker-style P&L)."""
    products = db.query(ProductPurchase).filter(
        ProductPurchase.user_id == current_user.id
    ).all()

    total_invested = sum(p.purchase_price for p in products)
    total_current_value = sum(
        (p.sold_price if p.sold_price else p.current_value or p.purchase_price)
        for p in products
    )
    total_pnl = total_current_value - total_invested
    total_pnl_pct = (total_pnl / total_invested * 100) if total_invested > 0 else 0

    # By type
    by_type = {}
    for p in products:
        t = p.product_type or "Other"
        if t not in by_type:
            by_type[t] = {"invested": 0, "current": 0, "count": 0}
        by_type[t]["invested"] += p.purchase_price
        by_type[t]["current"] += (p.sold_price if p.sold_price else p.current_value or p.purchase_price)
        by_type[t]["count"] += 1

    by_type_list = [
        {
            "type": t,
            "invested": round(v["invested"], 2),
            "current": round(v["current"], 2),
            "pnl": round(v["current"] - v["invested"], 2),
            "pnl_pct": round(((v["current"] - v["invested"]) / v["invested"] * 100) if v["invested"] > 0 else 0, 2),
            "count": v["count"],
        }
        for t, v in by_type.items()
    ]

    # Monthly breakdown
    monthly = {}
    for p in products:
        key = p.purchase_date.strftime("%Y-%m") if p.purchase_date else "Unknown"
        if key not in monthly:
            monthly[key] = {"invested": 0, "current": 0, "count": 0}
        monthly[key]["invested"] += p.purchase_price
        monthly[key]["current"] += (p.sold_price if p.sold_price else p.current_value or p.purchase_price)
        monthly[key]["count"] += 1

    monthly_list = sorted([
        {
            "month": k,
            "invested": round(v["invested"], 2),
            "current": round(v["current"], 2),
            "pnl": round(v["current"] - v["invested"], 2),
            "count": v["count"],
        }
        for k, v in monthly.items()
    ], key=lambda x: x["month"])

    return {
        "total_invested": round(total_invested, 2),
        "total_current_value": round(total_current_value, 2),
        "total_pnl": round(total_pnl, 2),
        "total_pnl_pct": round(total_pnl_pct, 2),
        "total_products": len(products),
        "by_type": by_type_list,
        "monthly": monthly_list,
    }
