"""
eBay Finding API integration for graded card prices.
Uses completed sales (sold items) to calculate average market price.
"""
import httpx
from fastapi import APIRouter
from database import get_setting

router = APIRouter()

EBAY_FINDING_API_URL = "https://svcs.ebay.com/services/search/FindingService/v1"
POKEMON_CATEGORY_ID = "183454"  # Pokémon Individual Cards


def build_search_query(card_name: str, grade: str) -> str:
    """Build eBay search query for a graded Pokémon card."""
    grade_str = grade.upper().replace("_", " ")
    return f"{card_name} {grade_str} Pokemon"


@router.get("/graded-price")
async def get_graded_price(card_name: str, grade: str, lang: str = "en"):
    """
    Get eBay graded card price from completed sales.

    Returns average price from up to 10 recent sold listings.
    If eBay App ID is not configured, returns {"error": "not_configured"}.
    """
    app_id = get_setting("ebay_app_id", "")

    if not app_id or not app_id.strip():
        return {"error": "not_configured"}

    query = build_search_query(card_name, grade)

    params = {
        "OPERATION-NAME": "findCompletedItems",
        "SERVICE-VERSION": "1.0.0",
        "SECURITY-APPNAME": app_id.strip(),
        "RESPONSE-DATA-FORMAT": "JSON",
        "keywords": query,
        "categoryId": POKEMON_CATEGORY_ID,
        "itemFilter(0).name": "SoldItemsOnly",
        "itemFilter(0).value": "true",
        "sortOrder": "EndTimeSoonest",
        "paginationInput.entriesPerPage": "10",
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(EBAY_FINDING_API_URL, params=params)
            response.raise_for_status()
            data = response.json()

        # Navigate the eBay response structure
        search_response = data.get("findCompletedItemsResponse", [{}])[0]
        ack = search_response.get("ack", ["Failure"])[0]

        if ack != "Success":
            error_msg = search_response.get("errorMessage", [{}])[0].get(
                "error", [{}]
            )[0].get("message", ["Unknown eBay error"])[0]
            return {"error": f"ebay_api_error: {error_msg}"}

        search_result = search_response.get("searchResult", [{}])[0]
        items = search_result.get("item", [])

        if not items:
            return {
                "average_price": None,
                "currency": "USD",
                "sales_count": 0,
                "min_price": None,
                "max_price": None,
                "source": "ebay",
                "query": query,
            }

        prices = []
        for item in items[:10]:
            try:
                selling_status = item.get("sellingStatus", [{}])[0]
                price_data = selling_status.get("convertedCurrentPrice", [{}])[0]
                price = float(price_data.get("__value__", 0))
                if price > 0:
                    prices.append(price)
            except (KeyError, IndexError, ValueError, TypeError):
                continue

        if not prices:
            return {
                "average_price": None,
                "currency": "USD",
                "sales_count": 0,
                "min_price": None,
                "max_price": None,
                "source": "ebay",
                "query": query,
            }

        avg = round(sum(prices) / len(prices), 2)
        return {
            "average_price": avg,
            "currency": "USD",
            "sales_count": len(prices),
            "min_price": round(min(prices), 2),
            "max_price": round(max(prices), 2),
            "source": "ebay",
            "query": query,
        }

    except httpx.TimeoutException:
        return {"error": "timeout"}
    except Exception as e:
        return {"error": str(e)}
