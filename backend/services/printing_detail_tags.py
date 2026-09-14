import datetime

from sqlalchemy.orm import Session

from models import PrintingDetailTag, User
from services.printing_details import (
    normalize_printing_detail_name,
    normalize_printing_details,
    printing_detail_normalized_key,
)


def printing_detail_keys(tags) -> frozenset[str]:
    return frozenset(
        normalize_printing_detail_name(tag)
        if isinstance(tag, str)
        else tag.normalized_name
        for tag in (tags or [])
    )


def printing_detail_names(tags) -> list[str]:
    return [tag.name for tag in (tags or [])]


def get_or_create_printing_detail_tags(
    db: Session,
    user_id: int,
    values,
) -> list[PrintingDetailTag]:
    pairs = normalize_printing_details(values)
    if not pairs:
        return []
    # Serialize every tag assignment with create/rename/delete for this owner.
    # Locking only when a name is missing still leaves a race where an existing
    # unused tag can be deleted between lookup and association insertion.
    db.query(User.id).filter(User.id == user_id).with_for_update().one()
    normalized_names = [normalized_name for _name, normalized_name in pairs]
    normalized_keys = [printing_detail_normalized_key(name) for name in normalized_names]
    existing = db.query(PrintingDetailTag).filter(
        PrintingDetailTag.user_id == user_id,
        PrintingDetailTag.normalized_key.in_(normalized_keys),
    ).all()
    by_normalized_name = {tag.normalized_name: tag for tag in existing}
    result: list[PrintingDetailTag] = []
    for display_name, normalized_name in pairs:
        tag = by_normalized_name.get(normalized_name)
        if tag is None:
            tag = PrintingDetailTag(
                user_id=user_id,
                name=display_name,
                normalized_name=normalized_name,
                normalized_key=printing_detail_normalized_key(normalized_name),
                created_at=datetime.datetime.utcnow(),
            )
            db.add(tag)
            by_normalized_name[normalized_name] = tag
        result.append(tag)
    db.flush()
    return result
