from fastapi import APIRouter
import csv
import io
import logging

import httpx

router = APIRouter()
logger = logging.getLogger(__name__)

REPO = "Git-Romer/pokecollector"
GITHUB_API = "https://api.github.com"
SUPPORTERS_CSV_URL = f"https://raw.githubusercontent.com/{REPO}/main/SUPPORTERS.csv"


@router.get("/contributors")
async def get_contributors():
    """Fetch contributors from GitHub API (public, no auth needed)."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{GITHUB_API}/repos/{REPO}/contributors",
                headers={"Accept": "application/vnd.github+json"},
            )
            resp.raise_for_status()
            data = resp.json()
            return [
                {
                    "login": contributor["login"],
                    "avatar_url": contributor["avatar_url"],
                    "html_url": contributor["html_url"],
                    "contributions": contributor["contributions"],
                }
                for contributor in data
                if contributor.get("type") == "User"
            ]
    except Exception as exc:
        logger.warning("Failed to fetch contributors: %s", exc)
        return []


@router.get("/supporters")
async def get_supporters():
    """Fetch supporters list from SUPPORTERS.csv in the repo."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(SUPPORTERS_CSV_URL)
            resp.raise_for_status()
            reader = csv.DictReader(io.StringIO(resp.text))
            supporters = []
            for row in reader:
                name = (row.get("name") or "").strip()
                if name:
                    supporters.append(
                        {
                            "name": name,
                            "url": (row.get("url") or "").strip() or None,
                        }
                    )
            return supporters
    except Exception as exc:
        logger.warning("Failed to fetch supporters: %s", exc)
        return []
