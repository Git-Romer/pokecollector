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
CONTRIBUTORS_CSV_URL = f"https://raw.githubusercontent.com/{REPO}/main/CONTRIBUTORS.csv"
GITHUB_HEADERS = {"Accept": "application/vnd.github+json"}


def _github_avatar_url(login: str) -> str:
    return f"https://github.com/{login}.png"


async def _fetch_repo_contributors(client: httpx.AsyncClient) -> list[dict]:
    resp = await client.get(
        f"{GITHUB_API}/repos/{REPO}/contributors",
        headers=GITHUB_HEADERS,
    )
    resp.raise_for_status()
    return [
        {
            "login": contributor["login"],
            "avatar_url": contributor["avatar_url"],
            "html_url": contributor["html_url"],
            "contributions": contributor["contributions"],
            "manual": False,
            "note": None,
        }
        for contributor in resp.json()
        if contributor.get("type") == "User"
    ]


async def _fetch_manual_contributors(client: httpx.AsyncClient) -> list[dict]:
    """Fetch additional contributors from CONTRIBUTORS.csv in the repo."""
    resp = await client.get(CONTRIBUTORS_CSV_URL)
    if resp.status_code == 404:
        return []
    resp.raise_for_status()

    contributors = []
    reader = csv.DictReader(io.StringIO(resp.text))
    for row in reader:
        login = (row.get("login") or row.get("username") or "").strip()
        if not login:
            continue

        note = (row.get("note") or row.get("role") or "").strip() or None
        contributor = {
            "login": login,
            "avatar_url": _github_avatar_url(login),
            "html_url": f"https://github.com/{login}",
            "contributions": 0,
            "manual": True,
            "note": note,
        }

        try:
            user_resp = await client.get(f"{GITHUB_API}/users/{login}", headers=GITHUB_HEADERS)
            user_resp.raise_for_status()
            user_data = user_resp.json()
            contributor["login"] = user_data.get("login") or login
            contributor["avatar_url"] = user_data.get("avatar_url") or contributor["avatar_url"]
            contributor["html_url"] = user_data.get("html_url") or contributor["html_url"]
        except Exception as exc:
            logger.warning("Failed to fetch manual contributor %s: %s", login, exc)

        contributors.append(contributor)

    return contributors


@router.get("/contributors")
async def get_contributors():
    """Fetch repo contributors from GitHub and merge additional CONTRIBUTORS.csv users."""
    contributors = []

    async with httpx.AsyncClient(timeout=10) as client:
        try:
            contributors = await _fetch_repo_contributors(client)
        except Exception as exc:
            logger.warning("Failed to fetch repo contributors: %s", exc)

        seen_logins = {contributor["login"].lower() for contributor in contributors}

        try:
            for contributor in await _fetch_manual_contributors(client):
                login_key = contributor["login"].lower()
                if login_key not in seen_logins:
                    contributors.append(contributor)
                    seen_logins.add(login_key)
        except Exception as exc:
            logger.warning("Failed to fetch manual contributors: %s", exc)

    return contributors


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
