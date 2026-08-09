from __future__ import annotations

import argparse
import json

from database import SessionLocal
from models import Card
from services.card_metadata import (
    enrich_cards_metadata,
)
from services.pokedex_backfill import pokedex_backfill_query


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill TCGdex Pokédex and Cardmarket metadata")
    parser.add_argument("--limit", type=int, default=1000)
    parser.add_argument("--language")
    parser.add_argument("--refresh", action="store_true", help="refetch matching rows even when metadata exists")
    parser.add_argument("--missing-only", action="store_true", help="only rows missing Pokédex/Cardmarket metadata (default)")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        query = pokedex_backfill_query(db)
        if args.language:
            query = query.filter(Card.lang == args.language)
        if args.refresh:
            query = db.query(Card).filter(Card.is_custom.is_(False), Card.tcg_card_id.isnot(None))
            if args.language:
                query = query.filter(Card.lang == args.language)
        cards = query.order_by(Card.updated_at.asc(), Card.id.asc()).limit(max(args.limit, 1)).all()
        # Force the selected rows through enrichment; the generic selector is
        # intentionally bypassed because Cardmarket IDs may be absent even on
        # otherwise complete card rows.
        result = enrich_cards_metadata(
            db,
            cards,
            limit=len(cards),
            commit_every=25,
            force=True,
            ignore_cooldown=args.refresh,
        )
        print(json.dumps(result, indent=2))
        return 1 if result["failed"] else 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
