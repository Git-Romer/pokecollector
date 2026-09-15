from __future__ import annotations

import argparse
import json

from services.pokedex_forms import form_catalogue
from services.pokedex_images import MAX_DEX_ID, populate_cache, populate_image_ids


def main() -> int:
    parser = argparse.ArgumentParser(description="Populate the persistent National Pokédex image cache")
    parser.add_argument("--min", dest="minimum", type=int)
    parser.add_argument("--max", dest="maximum", type=int)
    parser.add_argument("--refresh", action="store_true", help="replace existing cached files")
    parser.add_argument("--missing-only", action="store_true", help="compatibility flag; this is the default")
    parser.add_argument("--delay", type=float, default=0.05)
    args = parser.parse_args()
    if args.minimum is None and args.maximum is None:
        image_ids = [
            *range(1, MAX_DEX_ID + 1),
            *(row["image_id"] for row in form_catalogue()),
        ]
        result = populate_image_ids(
            image_ids,
            refresh=args.refresh,
            delay=max(args.delay, 0),
        )
    else:
        result = populate_cache(
            minimum=args.minimum or 1,
            maximum=args.maximum or MAX_DEX_ID,
            refresh=args.refresh,
            delay=max(args.delay, 0),
        )
    print(json.dumps(result, indent=2))
    return 1 if result["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
