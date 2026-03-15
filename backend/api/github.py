from fastapi import APIRouter
import httpx
import logging

router = APIRouter()
logger = logging.getLogger(__name__)

REPO = "Git-Romer/pokecollector"
GITHUB_API = "https://api.github.com"


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
                    "login": c["login"],
                    "avatar_url": c["avatar_url"],
                    "html_url": c["html_url"],
                    "contributions": c["contributions"],
                    "type": c.get("type", "User"),
                }
                for c in data
                if c.get("type") == "User"
            ]
    except Exception as e:
        logger.warning("Failed to fetch contributors: %s", e)
        return []


@router.get("/sponsors")
async def get_sponsors():
    """Return the GitHub Sponsors page URL.
    Sponsor list fetching would require a GitHub PAT with read:org scope.
    For now, we just return the sponsor page link."""
    return {
        "sponsor_url": f"https://github.com/sponsors/Git-Romer",
        "message": "All earnings are donated to animal rescue organizations 🐾",
    }
