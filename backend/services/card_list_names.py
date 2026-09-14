from fastapi import HTTPException


CARD_LIST_NAME_MAX_LENGTH = 255


def normalize_card_list_name(value: str | None) -> str:
    """Return a normalized Card List name shared by every API adapter."""
    name = str(value or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="Card List name is required")
    if len(name) > CARD_LIST_NAME_MAX_LENGTH:
        raise HTTPException(
            status_code=422,
            detail=f"Card List name must be at most {CARD_LIST_NAME_MAX_LENGTH} characters",
        )
    return name
