# Public Viewable Binders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user publish a public profile (custom handle) exposing binders they explicitly share, viewable by anonymous visitors and discoverable in-app, with purchase price / cost / P&L never exposed.

**Architecture:** A dedicated unauthenticated `/api/public/*` router with its own whitelist serializers (private fields physically absent from the response models). Owner controls live in a new authenticated `/api/profile` router plus an `is_public` flag on binders. Frontend adds public routes outside the login wall using a separate axios client that never attaches a token or redirects on 401.

**Tech Stack:** FastAPI + SQLAlchemy + PostgreSQL (prod) / in-memory SQLite (tests); React + Vite + React Router + axios; slowapi for rate limiting; Vitest + Python `unittest`.

## Global Constraints

- **Tests are `unittest`, NOT pytest.** Run backend tests in the backend image with the source bind-mounted:
  `docker run --rm -v "$PWD/backend":/app/backend -w /app/backend pokecollector-backend python -m unittest tests.<module> -v`
- **Frontend tests/build run in Node 20 container, not the host:**
  `docker run --rm -v "$PWD/frontend":/app -w /app node:20 npx vitest run <path>`
- **No Alembic.** New columns need idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` statements in `backend/database.py::_run_migrations` (PostgreSQL). Tests get the columns from `Base.metadata.create_all` via the model definitions.
- **The collection table is named `collection`** (not `collection_items`). `Set.id`/`Card.id` are composite/lang-suffixed; `Card.set_id` is the unsuffixed tcg id.
- **`SessionLocal` is `autoflush=False`.**
- **Never expose private fields publicly:** `purchase_price`, cost basis, P&L, `condition`, notes, `username`, email, telegram/gemini settings, internal user ids. The login `username` in particular must never appear in any `/api/public/*` or profile-public response.
- **Money is EUR-native** on public pages (no per-viewer currency conversion in v1).
- Branch: `feature/public-binders` (already created from `upstream/main`). Design/plan docs under `docs/superpowers/` must not ride into an upstream PR.

---

## File Structure

**Backend**
- `backend/models.py` — add `User.public_handle`, `User.is_profile_public`, `User.public_show_values`, `Binder.is_public`.
- `backend/database.py` — migrations for the four new columns.
- `backend/services/public_profile.py` *(new)* — handle validation/reserved words, profile resolution, and whitelist serialization. All public logic isolated here.
- `backend/api/public.py` *(new)* — unauthenticated router + public Pydantic response models.
- `backend/api/profile.py` *(new)* — authenticated owner controls (set handle/toggles, availability check).
- `backend/schemas.py` — add `ProfileUpdate`; add `is_public` to `BinderUpdate` and `BinderResponse`.
- `backend/api/binders.py` — persist `is_public` in `update_binder`, include it in `_binder_response`.
- `backend/api/social.py` — include `public_handle` in leaderboard rows.
- `backend/main.py` — mount the two new routers.
- `backend/tests/test_public_binders.py` *(new)* — all backend tests for this feature.

**Frontend**
- `frontend/src/utils/publicHandle.js` *(new)* — shared handle-format validator.
- `frontend/src/utils/publicHandle.test.js` *(new)*.
- `frontend/src/api/publicClient.js` *(new)* — token-less axios instance + public API calls.
- `frontend/src/api/client.js` — add `updateProfile`, `checkHandleAvailable`, and `is_public` on binder update.
- `frontend/src/pages/PublicProfile.jsx` *(new)*, `frontend/src/pages/PublicBinderView.jsx` *(new)*.
- `frontend/src/pages/PublicBinderView.test.jsx` *(new)*.
- `frontend/src/App.jsx` — public routes outside `ProtectedRoutes`.
- `frontend/src/pages/Settings.jsx` — "Public profile" section.
- `frontend/src/pages/Binders.jsx` — per-binder "Share publicly" toggle.
- `frontend/src/pages/Leaderboard.jsx` — link rows with a handle.

---

## Task 1: Data model + migrations

**Files:**
- Modify: `backend/models.py` (User class ~line 134, Binder class ~line 205)
- Modify: `backend/database.py` (`_run_migrations` list ~line 58)
- Test: `backend/tests/test_public_binders.py`

**Interfaces:**
- Produces: `User.public_handle: str|None`, `User.is_profile_public: bool`, `User.public_show_values: bool`, `Binder.is_public: bool`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_public_binders.py`:

```python
import unittest

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from database import Base
    from models import User, Binder
    DEPS = True
except ModuleNotFoundError:
    DEPS = False


@unittest.skipUnless(DEPS, "SQLAlchemy not installed in this lightweight test environment")
class PublicBindersModelTests(unittest.TestCase):
    def _db(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine)()

    def test_new_columns_default_private(self):
        db = self._db()
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        binder = Binder(name="Binder", binder_type="collection")
        db.add_all([user, binder])
        db.commit()
        db.refresh(user)
        db.refresh(binder)
        self.assertIsNone(user.public_handle)
        self.assertFalse(user.is_profile_public)
        self.assertFalse(user.public_show_values)
        self.assertFalse(binder.is_public)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker run --rm -v "$PWD/backend":/app/backend -w /app/backend pokecollector-backend python -m unittest tests.test_public_binders -v`
Expected: FAIL — `AttributeError`/`TypeError` (columns don't exist yet).

- [ ] **Step 3: Add columns to models**

In `backend/models.py`, inside `class User(Base)` (after `avatar_id`):

```python
    public_handle = Column(String, unique=True, nullable=True)
    is_profile_public = Column(Boolean, default=False, nullable=False)
    public_show_values = Column(Boolean, default=False, nullable=False)
```

Inside `class Binder(Base)` (after `icon_pokemon_id`):

```python
    is_public = Column(Boolean, default=False, nullable=False)
```

- [ ] **Step 4: Add migrations**

In `backend/database.py`, append to the `migrations` list in `_run_migrations`:

```python
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS public_handle VARCHAR",
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_public_handle ON users (public_handle)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_profile_public BOOLEAN DEFAULT FALSE",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS public_show_values BOOLEAN DEFAULT FALSE",
        "ALTER TABLE binders ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT FALSE",
```

- [ ] **Step 5: Run test to verify it passes**

Run: `docker run --rm -v "$PWD/backend":/app/backend -w /app/backend pokecollector-backend python -m unittest tests.test_public_binders -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/models.py backend/database.py backend/tests/test_public_binders.py
git commit -m "feat(public-binders): add profile handle + public flags data model"
```

---

## Task 2: Handle validation service

**Files:**
- Create: `backend/services/public_profile.py`
- Test: `backend/tests/test_public_binders.py`

**Interfaces:**
- Produces:
  - `HANDLE_RE` (compiled), `RESERVED_HANDLES: set[str]`
  - `class HandleError(ValueError)`
  - `validate_handle(raw: str) -> str` — returns normalized lowercase handle or raises `HandleError(message)`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_public_binders.py`:

```python
try:
    from services.public_profile import validate_handle, HandleError
    SERVICE_DEPS = True
except ModuleNotFoundError:
    SERVICE_DEPS = False


@unittest.skipUnless(SERVICE_DEPS, "service deps unavailable")
class HandleValidationTests(unittest.TestCase):
    def test_valid_handle_is_normalized(self):
        self.assertEqual(validate_handle("  Ash-Ketchum "), "ash-ketchum")

    def test_too_short_rejected(self):
        with self.assertRaises(HandleError):
            validate_handle("ab")

    def test_bad_chars_rejected(self):
        with self.assertRaises(HandleError):
            validate_handle("ash_ketchum")

    def test_leading_hyphen_rejected(self):
        with self.assertRaises(HandleError):
            validate_handle("-ash")

    def test_double_hyphen_rejected(self):
        with self.assertRaises(HandleError):
            validate_handle("ash--ketchum")

    def test_reserved_rejected(self):
        with self.assertRaises(HandleError):
            validate_handle("admin")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker run --rm -v "$PWD/backend":/app/backend -w /app/backend pokecollector-backend python -m unittest tests.test_public_binders.HandleValidationTests -v`
Expected: FAIL — `ModuleNotFoundError`/skip → the file doesn't exist. (If skipped, that itself signals the module is missing; create it in Step 3.)

- [ ] **Step 3: Create the service**

Create `backend/services/public_profile.py`:

```python
import re

HANDLE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$")

RESERVED_HANDLES = {
    "admin", "api", "u", "settings", "login", "logout", "static", "assets",
    "public", "profile", "me", "null", "undefined", "app", "www",
}


class HandleError(ValueError):
    pass


def validate_handle(raw: str) -> str:
    """Normalize and validate a public handle. Return the normalized handle or raise HandleError."""
    handle = (raw or "").strip().lower()
    if not handle:
        raise HandleError("Handle is required")
    if len(handle) < 3 or len(handle) > 30:
        raise HandleError("Handle must be 3–30 characters")
    if "--" in handle:
        raise HandleError("Handle cannot contain consecutive hyphens")
    if not HANDLE_RE.match(handle):
        raise HandleError("Handle may use lowercase letters, numbers and hyphens, and cannot start or end with a hyphen")
    if handle in RESERVED_HANDLES:
        raise HandleError("That handle is reserved")
    return handle
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker run --rm -v "$PWD/backend":/app/backend -w /app/backend pokecollector-backend python -m unittest tests.test_public_binders.HandleValidationTests -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/services/public_profile.py backend/tests/test_public_binders.py
git commit -m "feat(public-binders): handle validation + reserved words"
```

---

## Task 3: Profile resolution + whitelist serialization

**Files:**
- Modify: `backend/services/public_profile.py`
- Test: `backend/tests/test_public_binders.py`

**Interfaces:**
- Consumes: `User`, `Binder`, `BinderCard`, `Card`, `UserSetting` models; `services.card_values.effective_market_price`.
- Produces:
  - `is_handle_available(db, handle: str, exclude_user_id: int|None=None) -> bool`
  - `get_live_profile(db, handle: str) -> User|None` — returns the user only if `is_profile_public` and handle set.
  - `trainer_name_for(db, user) -> str`
  - `public_collection_binders(db, user) -> list[Binder]` — this user's `is_public` collection binders.
  - `serialize_profile(db, user) -> dict` — keys: `handle, trainer_name, avatar_id, show_values, binders`.
  - `serialize_binder_summary(db, binder, show_values: bool) -> dict` — keys: `id, name, color, icon_pokemon_id, card_count, unique_card_count, total_value`.
  - `serialize_binder_detail(db, binder, show_values: bool) -> dict` — summary keys + `cards`.
  - Each card dict keys: `id, name, image, set_name, number, rarity, quantity, market_value`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_public_binders.py`:

```python
try:
    from services import public_profile as pp
    from models import BinderCard, Card, Set, UserSetting
    PP_DEPS = True
except ModuleNotFoundError:
    PP_DEPS = False


@unittest.skipUnless(PP_DEPS, "service deps unavailable")
class SerializationTests(unittest.TestCase):
    def _db(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine)()

    def _seed(self, db, *, profile_public=True, binder_public=True, show_values=False):
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True,
                    public_handle="ash", is_profile_public=profile_public, public_show_values=show_values)
        db.add_all([
            user,
            UserSetting(user_id=1, key="trainer_name", value="Ash K."),
            Set(id="sv1_en", tcg_set_id="sv1", name="Scarlet & Violet", lang="en", total=1),
            Card(id="sv1-1_en", tcg_card_id="sv1-1", name="Sprigatito", set_id="sv1",
                 number="1", lang="en", rarity="Common", images_small="https://img/s.webp",
                 price_trend=5.0),
        ])
        db.commit()
        binder = Binder(name="Starters", user_id=user.id, binder_type="collection", is_public=binder_public)
        db.add(binder)
        db.commit()
        db.add(BinderCard(binder_id=binder.id, card_id="sv1-1_en", required_quantity=2))
        db.commit()
        return user, binder

    def test_get_live_profile_requires_public(self):
        db = self._db()
        self._seed(db, profile_public=False)
        self.assertIsNone(pp.get_live_profile(db, "ash"))

    def test_serialize_profile_lists_only_public_binders(self):
        db = self._db()
        user, _ = self._seed(db, binder_public=False)
        data = pp.serialize_profile(db, user)
        self.assertEqual(data["trainer_name"], "Ash K.")
        self.assertEqual(data["binders"], [])

    def test_binder_detail_hides_values_when_off(self):
        db = self._db()
        _, binder = self._seed(db, show_values=False)
        detail = pp.serialize_binder_detail(db, binder, show_values=False)
        self.assertEqual(detail["cards"][0]["name"], "Sprigatito")
        self.assertEqual(detail["cards"][0]["quantity"], 2)
        self.assertIsNone(detail["cards"][0]["market_value"])
        self.assertIsNone(detail["total_value"])

    def test_binder_detail_shows_values_when_on(self):
        db = self._db()
        _, binder = self._seed(db, show_values=True)
        detail = pp.serialize_binder_detail(db, binder, show_values=True)
        self.assertEqual(detail["cards"][0]["market_value"], 5.0)
        self.assertEqual(detail["total_value"], 10.0)  # 5.0 * qty 2

    def test_no_private_fields_leak(self):
        db = self._db()
        _, binder = self._seed(db, show_values=True)
        detail = pp.serialize_binder_detail(db, binder, show_values=True)
        card = detail["cards"][0]
        for banned in ("purchase_price", "condition", "user_id", "username"):
            self.assertNotIn(banned, card)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker run --rm -v "$PWD/backend":/app/backend -w /app/backend pokecollector-backend python -m unittest tests.test_public_binders.SerializationTests -v`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement the resolution + serialization**

Append to `backend/services/public_profile.py`:

```python
from models import User, Binder, BinderCard, Card, UserSetting
from services.card_values import effective_market_price

_DEFAULT_TRAINER_NAME = "TRAINER"
_PRICE_FIELD = "price_trend"


def is_handle_available(db, handle: str, exclude_user_id: int | None = None) -> bool:
    query = db.query(User.id).filter(User.public_handle == handle)
    if exclude_user_id is not None:
        query = query.filter(User.id != exclude_user_id)
    return query.first() is None


def get_live_profile(db, handle: str) -> User | None:
    if not handle:
        return None
    return db.query(User).filter(
        User.public_handle == handle,
        User.is_profile_public.is_(True),
        User.is_active.is_(True),
    ).first()


def trainer_name_for(db, user: User) -> str:
    row = db.query(UserSetting).filter(
        UserSetting.user_id == user.id, UserSetting.key == "trainer_name"
    ).first()
    return (row.value if row and row.value else _DEFAULT_TRAINER_NAME)


def public_collection_binders(db, user: User) -> list[Binder]:
    return db.query(Binder).filter(
        Binder.user_id == user.id,
        Binder.is_public.is_(True),
        Binder.binder_type == "collection",
    ).order_by(Binder.created_at.asc()).all()


def _binder_cards(db, binder: Binder) -> list[BinderCard]:
    return db.query(BinderCard).filter(BinderCard.binder_id == binder.id).all()


def _serialize_card(bc: BinderCard, show_values: bool) -> dict:
    card = bc.card
    quantity = bc.required_quantity or 1
    value = effective_market_price(card, None, _PRICE_FIELD) if show_values else None
    return {
        "id": card.id,
        "name": card.name,
        "image": card.images_small or card.images_large,
        "set_name": card.set_ref.name if card.set_ref else None,
        "number": card.number,
        "rarity": card.rarity,
        "quantity": quantity,
        "market_value": value,
    }


def serialize_binder_summary(db, binder: Binder, show_values: bool) -> dict:
    cards = _binder_cards(db, binder)
    unique = {bc.card_id for bc in cards}
    total_count = sum((bc.required_quantity or 1) for bc in cards)
    total_value = None
    if show_values:
        total_value = round(sum(
            effective_market_price(bc.card, None, _PRICE_FIELD) * (bc.required_quantity or 1)
            for bc in cards if bc.card
        ), 2)
    return {
        "id": binder.id,
        "name": binder.name,
        "color": binder.color,
        "icon_pokemon_id": binder.icon_pokemon_id,
        "card_count": total_count,
        "unique_card_count": len(unique),
        "total_value": total_value,
    }


def serialize_binder_detail(db, binder: Binder, show_values: bool) -> dict:
    summary = serialize_binder_summary(db, binder, show_values)
    cards = _binder_cards(db, binder)
    summary["cards"] = [_serialize_card(bc, show_values) for bc in cards if bc.card]
    return summary


def serialize_profile(db, user: User) -> dict:
    show_values = bool(user.public_show_values)
    binders = public_collection_binders(db, user)
    return {
        "handle": user.public_handle,
        "trainer_name": trainer_name_for(db, user),
        "avatar_id": user.avatar_id,
        "show_values": show_values,
        "binders": [serialize_binder_summary(db, b, show_values) for b in binders],
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker run --rm -v "$PWD/backend":/app/backend -w /app/backend pokecollector-backend python -m unittest tests.test_public_binders.SerializationTests -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/services/public_profile.py backend/tests/test_public_binders.py
git commit -m "feat(public-binders): profile resolution + whitelist serialization"
```

---

## Task 4: Public API router

**Files:**
- Create: `backend/api/public.py`
- Modify: `backend/main.py` (imports ~line 124, mounts ~line 156)
- Test: `backend/tests/test_public_binders.py`

**Interfaces:**
- Consumes: `services.public_profile`, `database.get_db`.
- Produces (callable directly in tests): `get_public_profile(handle, db)`, `get_public_binder(handle, binder_id, db)`; Pydantic `PublicProfile`, `PublicBinderDetail`, `PublicBinderSummary`, `PublicCard`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_public_binders.py`:

```python
try:
    from fastapi import HTTPException
    from api.public import get_public_profile, get_public_binder
    API_DEPS = True
except ModuleNotFoundError:
    API_DEPS = False


@unittest.skipUnless(API_DEPS, "api deps unavailable")
class PublicApiTests(unittest.TestCase):
    def _db(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine)()

    def _seed(self, db, **kw):
        return SerializationTests()._seed(db, **kw)

    def test_unknown_handle_404(self):
        db = self._db()
        with self.assertRaises(HTTPException) as ctx:
            get_public_profile("nobody", db=db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_private_profile_404(self):
        db = self._db()
        self._seed(db, profile_public=False)
        with self.assertRaises(HTTPException) as ctx:
            get_public_profile("ash", db=db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_public_profile_returns_binders(self):
        db = self._db()
        self._seed(db)
        result = get_public_profile("ash", db=db)
        self.assertEqual(result["handle"], "ash")
        self.assertEqual(len(result["binders"]), 1)

    def test_private_binder_404(self):
        db = self._db()
        _, binder = self._seed(db, binder_public=False)
        with self.assertRaises(HTTPException) as ctx:
            get_public_binder("ash", binder.id, db=db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_cross_owner_binder_404(self):
        db = self._db()
        self._seed(db)
        # A public binder id that belongs to a different (nonexistent) handle path
        other = Binder(name="Other", user_id=999, binder_type="collection", is_public=True)
        db.add(other)
        db.commit()
        with self.assertRaises(HTTPException) as ctx:
            get_public_binder("ash", other.id, db=db)
        self.assertEqual(ctx.exception.status_code, 404)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker run --rm -v "$PWD/backend":/app/backend -w /app/backend pokecollector-backend python -m unittest tests.test_public_binders.PublicApiTests -v`
Expected: FAIL — `api.public` not found.

- [ ] **Step 3: Create the router**

Create `backend/api/public.py`:

```python
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List

from database import get_db
from services import public_profile as pp

router = APIRouter()


class PublicCard(BaseModel):
    id: str
    name: str
    image: Optional[str] = None
    set_name: Optional[str] = None
    number: Optional[str] = None
    rarity: Optional[str] = None
    quantity: int
    market_value: Optional[float] = None


class PublicBinderSummary(BaseModel):
    id: int
    name: str
    color: Optional[str] = None
    icon_pokemon_id: Optional[int] = None
    card_count: int
    unique_card_count: int
    total_value: Optional[float] = None


class PublicProfile(BaseModel):
    handle: str
    trainer_name: str
    avatar_id: Optional[int] = None
    show_values: bool
    binders: List[PublicBinderSummary]


class PublicBinderDetail(PublicBinderSummary):
    cards: List[PublicCard]


@router.get("/profiles/{handle}", response_model=PublicProfile)
def get_public_profile(handle: str, db: Session = Depends(get_db)):
    user = pp.get_live_profile(db, handle.lower())
    if not user:
        raise HTTPException(status_code=404, detail="Profile not found")
    return pp.serialize_profile(db, user)


@router.get("/profiles/{handle}/binders/{binder_id}", response_model=PublicBinderDetail)
def get_public_binder(handle: str, binder_id: int, db: Session = Depends(get_db)):
    user = pp.get_live_profile(db, handle.lower())
    if not user:
        raise HTTPException(status_code=404, detail="Profile not found")
    binder = next((b for b in pp.public_collection_binders(db, user) if b.id == binder_id), None)
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")
    return pp.serialize_binder_detail(db, binder, show_values=bool(user.public_show_values))
```

Note: endpoints return the plain whitelisted dict from the serializer; `response_model` filters/validates the schema at FastAPI's serialization layer (extra keys would be dropped), and the serializers already emit only whitelisted keys — belt and suspenders. Returning a dict (not a `Response`) keeps the functions directly callable and subscriptable in the unit tests. The public `Cache-Control` header is added in Task 11 with a test-safe signature.

- [ ] **Step 4: Mount the router**

In `backend/main.py`, add `public` to the `from api import ...` line (~124), then after the other `include_router` calls:

```python
app.include_router(public.router, prefix="/api/public", tags=["public"])
```

- [ ] **Step 5: Run test to verify it passes**

Run: `docker run --rm -v "$PWD/backend":/app/backend -w /app/backend pokecollector-backend python -m unittest tests.test_public_binders.PublicApiTests -v`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/api/public.py backend/main.py backend/tests/test_public_binders.py
git commit -m "feat(public-binders): unauthenticated public profile + binder API"
```

---

## Task 5: Owner control API (profile router)

**Files:**
- Create: `backend/api/profile.py`
- Modify: `backend/schemas.py` (add `ProfileUpdate`)
- Modify: `backend/main.py`
- Test: `backend/tests/test_public_binders.py`

**Interfaces:**
- Consumes: `api.auth.get_current_user`, `services.public_profile`, `database.get_db`.
- Produces: `update_profile(payload, db, current_user)`, `handle_available(handle, db, current_user)`; `schemas.ProfileUpdate`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_public_binders.py`:

```python
try:
    from api.profile import update_profile, handle_available
    from schemas import ProfileUpdate
    PROFILE_DEPS = True
except ModuleNotFoundError:
    PROFILE_DEPS = False


@unittest.skipUnless(PROFILE_DEPS, "profile api deps unavailable")
class ProfileControlTests(unittest.TestCase):
    def _db(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine)()

    def _user(self, db, username="ash"):
        u = User(username=username, hashed_password="x", role="trainer", is_active=True)
        db.add(u)
        db.commit()
        db.refresh(u)
        return u

    def test_set_handle_and_publish(self):
        db = self._db()
        u = self._user(db)
        result = update_profile(ProfileUpdate(public_handle="Ash-K", is_profile_public=True),
                                db=db, current_user=u)
        self.assertEqual(result["public_handle"], "ash-k")
        self.assertTrue(result["is_profile_public"])

    def test_invalid_handle_422(self):
        db = self._db()
        u = self._user(db)
        with self.assertRaises(HTTPException) as ctx:
            update_profile(ProfileUpdate(public_handle="a"), db=db, current_user=u)
        self.assertEqual(ctx.exception.status_code, 422)

    def test_duplicate_handle_409(self):
        db = self._db()
        taken = self._user(db, "misty")
        update_profile(ProfileUpdate(public_handle="star"), db=db, current_user=taken)
        me = self._user(db, "ash")
        with self.assertRaises(HTTPException) as ctx:
            update_profile(ProfileUpdate(public_handle="star"), db=db, current_user=me)
        self.assertEqual(ctx.exception.status_code, 409)

    def test_handle_available_check(self):
        db = self._db()
        u = self._user(db)
        self.assertTrue(handle_available("brand-new", db=db, current_user=u)["available"])
        self.assertFalse(handle_available("ADMIN", db=db, current_user=u)["available"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker run --rm -v "$PWD/backend":/app/backend -w /app/backend pokecollector-backend python -m unittest tests.test_public_binders.ProfileControlTests -v`
Expected: FAIL — `api.profile` not found.

- [ ] **Step 3: Add the schema**

In `backend/schemas.py`, add:

```python
class ProfileUpdate(BaseModel):
    public_handle: Optional[str] = None
    is_profile_public: Optional[bool] = None
    public_show_values: Optional[bool] = None
```

- [ ] **Step 4: Create the router**

Create `backend/api/profile.py`:

```python
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import User
from schemas import ProfileUpdate
from services import public_profile as pp

router = APIRouter()


def _serialize_owner(user: User) -> dict:
    return {
        "public_handle": user.public_handle,
        "is_profile_public": bool(user.is_profile_public),
        "public_show_values": bool(user.public_show_values),
    }


@router.get("/handle-available")
def handle_available(handle: str = Query(...), db: Session = Depends(get_db),
                     current_user: User = Depends(get_current_user)):
    try:
        normalized = pp.validate_handle(handle)
    except pp.HandleError as exc:
        return {"available": False, "reason": str(exc)}
    available = pp.is_handle_available(db, normalized, exclude_user_id=current_user.id)
    return {"available": available, "reason": None if available else "Handle is taken"}


@router.put("/")
def update_profile(payload: ProfileUpdate, db: Session = Depends(get_db),
                   current_user: User = Depends(get_current_user)):
    if payload.public_handle is not None:
        try:
            normalized = pp.validate_handle(payload.public_handle)
        except pp.HandleError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        if not pp.is_handle_available(db, normalized, exclude_user_id=current_user.id):
            raise HTTPException(status_code=409, detail="Handle is taken")
        current_user.public_handle = normalized
    if payload.is_profile_public is not None:
        current_user.is_profile_public = payload.is_profile_public
    if payload.public_show_values is not None:
        current_user.public_show_values = payload.public_show_values
    db.commit()
    db.refresh(current_user)
    return _serialize_owner(current_user)
```

- [ ] **Step 5: Mount the router**

In `backend/main.py`, add `profile` to the `from api import ...` line and:

```python
app.include_router(profile.router, prefix="/api/profile", tags=["profile"])
```

- [ ] **Step 6: Run test to verify it passes**

Run: `docker run --rm -v "$PWD/backend":/app/backend -w /app/backend pokecollector-backend python -m unittest tests.test_public_binders.ProfileControlTests -v`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add backend/api/profile.py backend/schemas.py backend/main.py backend/tests/test_public_binders.py
git commit -m "feat(public-binders): owner profile controls (handle + toggles)"
```

---

## Task 6: Binder `is_public` toggle

**Files:**
- Modify: `backend/schemas.py` (`BinderUpdate` ~234, `BinderResponse` ~256)
- Modify: `backend/api/binders.py` (`_binder_response` ~88, `update_binder` ~491)
- Test: `backend/tests/test_public_binders.py`

**Interfaces:**
- Consumes: existing `update_binder(binder_id, binder, db, current_user)`.
- Produces: `BinderResponse.is_public: bool`; `update_binder` persists `is_public`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_public_binders.py`:

```python
try:
    from api.binders import update_binder
    from schemas import BinderUpdate
    BINDER_DEPS = True
except ModuleNotFoundError:
    BINDER_DEPS = False


@unittest.skipUnless(BINDER_DEPS, "binder api deps unavailable")
class BinderPublicToggleTests(unittest.TestCase):
    def _db(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine)()

    def test_update_binder_sets_is_public(self):
        db = self._db()
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        db.add(user)
        db.commit()
        db.refresh(user)
        binder = Binder(name="B", user_id=user.id, binder_type="collection")
        db.add(binder)
        db.commit()
        resp = update_binder(binder.id, BinderUpdate(is_public=True), db=db, current_user=user)
        self.assertTrue(resp.is_public)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker run --rm -v "$PWD/backend":/app/backend -w /app/backend pokecollector-backend python -m unittest tests.test_public_binders.BinderPublicToggleTests -v`
Expected: FAIL — `BinderUpdate` has no `is_public` / `BinderResponse` has no `is_public`.

- [ ] **Step 3: Update schemas**

In `backend/schemas.py`, add `is_public: Optional[bool] = None` to `BinderUpdate`, and `is_public: bool = False` to `BinderResponse`.

- [ ] **Step 4: Persist and return `is_public`**

In `backend/api/binders.py`, in `_binder_response(...)` add `is_public=binder.is_public or False,` to the `BinderResponse(...)` call. In `update_binder`, alongside the other `if update.X is not None:` assignments, add:

```python
    if update.is_public is not None:
        binder.is_public = update.is_public
```

- [ ] **Step 5: Run test to verify it passes**

Run: `docker run --rm -v "$PWD/backend":/app/backend -w /app/backend pokecollector-backend python -m unittest tests.test_public_binders.BinderPublicToggleTests -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/schemas.py backend/api/binders.py backend/tests/test_public_binders.py
git commit -m "feat(public-binders): per-binder is_public toggle"
```

---

## Task 7: Leaderboard handle exposure (discovery)

**Files:**
- Modify: `backend/api/social.py` (`_load_user_stats`, the `stats[user.id] = {...}` block ~line 153)
- Test: `backend/tests/test_public_binders.py`

**Interfaces:**
- Produces: leaderboard row dict gains `public_handle: str|None`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_public_binders.py`:

```python
try:
    from api.social import _load_user_stats
    SOCIAL_DEPS = True
except ModuleNotFoundError:
    SOCIAL_DEPS = False


@unittest.skipUnless(SOCIAL_DEPS, "social deps unavailable")
class LeaderboardHandleTests(unittest.TestCase):
    def test_row_includes_public_handle(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        u = User(username="ash", hashed_password="x", role="trainer", is_active=True,
                 public_handle="ash", is_profile_public=True)
        db.add(u)
        db.commit()
        stats = _load_user_stats(db)
        self.assertIn(u.id, stats)
        self.assertEqual(stats[u.id]["public_handle"], "ash")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker run --rm -v "$PWD/backend":/app/backend -w /app/backend pokecollector-backend python -m unittest tests.test_public_binders.LeaderboardHandleTests -v`
Expected: FAIL — `KeyError: 'public_handle'`.

- [ ] **Step 3: Add the field**

In `backend/api/social.py`, inside the `stats[user.id] = { ... }` dict, add:

```python
            "public_handle": user.public_handle if user.is_profile_public else None,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker run --rm -v "$PWD/backend":/app/backend -w /app/backend pokecollector-backend python -m unittest tests.test_public_binders.LeaderboardHandleTests -v`
Expected: PASS.

- [ ] **Step 5: Full backend suite regression check**

Run: `docker run --rm -v "$PWD/backend":/app/backend -w /app/backend pokecollector-backend python -m unittest discover -s tests -v`
Expected: all pass (existing + new).

- [ ] **Step 6: Commit**

```bash
git add backend/api/social.py backend/tests/test_public_binders.py
git commit -m "feat(public-binders): expose public_handle on leaderboard rows"
```

---

## Task 8: Frontend handle validator + public API client

**Files:**
- Create: `frontend/src/utils/publicHandle.js`
- Create: `frontend/src/utils/publicHandle.test.js`
- Create: `frontend/src/api/publicClient.js`

**Interfaces:**
- Produces: `isValidHandleFormat(raw) -> bool`, `normalizeHandle(raw) -> string`; `getPublicProfile(handle)`, `getPublicBinder(handle, binderId)`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/utils/publicHandle.test.js`:

```javascript
import { describe, it, expect } from 'vitest'
import { isValidHandleFormat, normalizeHandle } from './publicHandle'

describe('publicHandle', () => {
  it('normalizes case and trims', () => {
    expect(normalizeHandle('  Ash-K ')).toBe('ash-k')
  })
  it('accepts a valid handle', () => {
    expect(isValidHandleFormat('ash-ketchum')).toBe(true)
  })
  it('rejects too short', () => {
    expect(isValidHandleFormat('ab')).toBe(false)
  })
  it('rejects bad chars and edges', () => {
    expect(isValidHandleFormat('ash_k')).toBe(false)
    expect(isValidHandleFormat('-ash')).toBe(false)
    expect(isValidHandleFormat('ash--k')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker run --rm -v "$PWD/frontend":/app -w /app node:20 npx vitest run src/utils/publicHandle.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the validator**

Create `frontend/src/utils/publicHandle.js`:

```javascript
const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/

export function normalizeHandle(raw) {
  return String(raw || '').trim().toLowerCase()
}

export function isValidHandleFormat(raw) {
  const handle = normalizeHandle(raw)
  if (handle.length < 3 || handle.length > 30) return false
  if (handle.includes('--')) return false
  return HANDLE_RE.test(handle)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker run --rm -v "$PWD/frontend":/app -w /app node:20 npx vitest run src/utils/publicHandle.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Create the token-less public client**

Create `frontend/src/api/publicClient.js`:

```javascript
import axios from 'axios'

// A separate instance from api/client.js: NO Authorization header and NO 401->/login
// redirect, so anonymous visitors on public pages are never bounced to the login screen.
const publicApi = axios.create({
  baseURL: '/api/public',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
})

export const getPublicProfile = (handle) =>
  publicApi.get(`/profiles/${encodeURIComponent(handle)}`).then(r => r.data)

export const getPublicBinder = (handle, binderId) =>
  publicApi.get(`/profiles/${encodeURIComponent(handle)}/binders/${binderId}`).then(r => r.data)
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/utils/publicHandle.js frontend/src/utils/publicHandle.test.js frontend/src/api/publicClient.js
git commit -m "feat(public-binders): frontend handle validator + token-less public client"
```

---

## Task 9: Public pages + routes

**Files:**
- Create: `frontend/src/pages/PublicProfile.jsx`
- Create: `frontend/src/pages/PublicBinderView.jsx`
- Create: `frontend/src/pages/PublicBinderView.test.jsx`
- Modify: `frontend/src/App.jsx`

**Interfaces:**
- Consumes: `getPublicProfile`, `getPublicBinder` from `../api/publicClient`.
- Produces: routes `/u/:handle`, `/u/:handle/binder/:binderId` rendered outside `ProtectedRoutes`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/pages/PublicBinderView.test.jsx`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

vi.mock('../api/publicClient', () => ({
  getPublicBinder: vi.fn(),
}))
import { getPublicBinder } from '../api/publicClient'
import PublicBinderView from './PublicBinderView'

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/u/:handle/binder/:binderId" element={<PublicBinderView />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('PublicBinderView', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders cards read-only and hides value when null', async () => {
    getPublicBinder.mockResolvedValue({
      id: 1, name: 'Starters', card_count: 1, unique_card_count: 1, total_value: null,
      cards: [{ id: 'sv1-1_en', name: 'Sprigatito', image: null, set_name: 'SV', number: '1', rarity: 'Common', quantity: 2, market_value: null }],
    })
    renderAt('/u/ash/binder/1')
    await waitFor(() => expect(screen.getByText('Sprigatito')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /add|edit|remove/i })).toBeNull()
    expect(screen.queryByText(/€/)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker run --rm -v "$PWD/frontend":/app -w /app node:20 npx vitest run src/pages/PublicBinderView.test.jsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `PublicBinderView.jsx`**

Create `frontend/src/pages/PublicBinderView.jsx`:

```javascript
import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getPublicBinder } from '../api/publicClient'

function formatEur(value) {
  if (value == null) return null
  return new Intl.NumberFormat('en', { style: 'currency', currency: 'EUR' }).format(value)
}

export default function PublicBinderView() {
  const { handle, binderId } = useParams()
  const [binder, setBinder] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    getPublicBinder(handle, binderId)
      .then(data => { if (!cancelled) setBinder(data) })
      .catch(() => { if (!cancelled) setError('This binder is not available.') })
    return () => { cancelled = true }
  }, [handle, binderId])

  if (error) return <div className="min-h-screen flex items-center justify-center text-text-secondary">{error}</div>
  if (!binder) return <div className="min-h-screen flex items-center justify-center text-text-secondary">Loading…</div>

  return (
    <div className="max-w-5xl mx-auto p-4">
      <Link to={`/u/${handle}`} className="text-sm text-text-secondary">← {handle}</Link>
      <div className="flex items-baseline justify-between mt-2 mb-4">
        <h1 className="text-2xl font-bold">{binder.name}</h1>
        {binder.total_value != null && (
          <span className="text-lg font-semibold">{formatEur(binder.total_value)}</span>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        {binder.cards.map(card => (
          <div key={card.id} className="rounded-lg border border-border p-2">
            {card.image
              ? <img src={card.image} alt={card.name} className="w-full rounded" loading="lazy" />
              : <div className="aspect-[3/4] bg-bg-secondary rounded" />}
            <div className="mt-1 text-sm font-medium truncate">{card.name}</div>
            <div className="text-xs text-text-secondary">
              {card.set_name} · #{card.number}{card.quantity > 1 ? ` · ×${card.quantity}` : ''}
            </div>
            {card.market_value != null && (
              <div className="text-xs font-semibold">{formatEur(card.market_value)}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Create `PublicProfile.jsx`**

Create `frontend/src/pages/PublicProfile.jsx`:

```javascript
import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getPublicProfile } from '../api/publicClient'

function formatEur(value) {
  if (value == null) return null
  return new Intl.NumberFormat('en', { style: 'currency', currency: 'EUR' }).format(value)
}

export default function PublicProfile() {
  const { handle } = useParams()
  const [profile, setProfile] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    getPublicProfile(handle)
      .then(data => { if (!cancelled) setProfile(data) })
      .catch(() => { if (!cancelled) setError('This profile is not available.') })
    return () => { cancelled = true }
  }, [handle])

  if (error) return <div className="min-h-screen flex items-center justify-center text-text-secondary">{error}</div>
  if (!profile) return <div className="min-h-screen flex items-center justify-center text-text-secondary">Loading…</div>

  return (
    <div className="max-w-4xl mx-auto p-4">
      <div className="flex items-center gap-3 mb-6">
        {profile.avatar_id && (
          <img src={`/api/pokedex/images/sprites/${profile.avatar_id}.png`} alt="" className="w-14 h-14" />
        )}
        <h1 className="text-2xl font-bold">{profile.trainer_name}</h1>
      </div>
      {profile.binders.length === 0 && (
        <p className="text-text-secondary">No shared binders yet.</p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {profile.binders.map(binder => (
          <Link key={binder.id} to={`/u/${handle}/binder/${binder.id}`}
                className="rounded-lg border border-border p-4 hover:bg-bg-secondary"
                style={{ borderLeftColor: binder.color, borderLeftWidth: 4 }}>
            <div className="font-semibold">{binder.name}</div>
            <div className="text-sm text-text-secondary">
              {binder.unique_card_count} cards
              {binder.total_value != null ? ` · ${formatEur(binder.total_value)}` : ''}
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Wire the routes outside the auth wall**

In `frontend/src/App.jsx`: add lazy imports near the other page imports:

```javascript
const PublicProfile = lazy(() => import('./pages/PublicProfile'))
const PublicBinderView = lazy(() => import('./pages/PublicBinderView'))
```

Then in the top-level `<Routes>` (the one containing `/login` and `/*`), add these **before** the `/*` catch-all so they bypass `ProtectedRoutes`:

```javascript
            <Route path="/u/:handle" element={lazyRoute(<PublicProfile />)} />
            <Route path="/u/:handle/binder/:binderId" element={lazyRoute(<PublicBinderView />)} />
```

- [ ] **Step 6: Run test to verify it passes**

Run: `docker run --rm -v "$PWD/frontend":/app -w /app node:20 npx vitest run src/pages/PublicBinderView.test.jsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/PublicProfile.jsx frontend/src/pages/PublicBinderView.jsx frontend/src/pages/PublicBinderView.test.jsx frontend/src/App.jsx
git commit -m "feat(public-binders): public profile + binder pages and routes"
```

---

## Task 10: Owner controls UI (settings + binder toggle + leaderboard links)

**Files:**
- Modify: `frontend/src/api/client.js`
- Modify: `frontend/src/pages/Settings.jsx`
- Modify: `frontend/src/pages/Binders.jsx`
- Modify: `frontend/src/pages/Leaderboard.jsx`

**Interfaces:**
- Consumes: `/api/profile` (PUT + handle-available), `/api/binders/{id}` (PUT with `is_public`), leaderboard `public_handle`.
- Produces: user-facing controls; no new exported types.

- [ ] **Step 1: Add API client functions**

In `frontend/src/api/client.js`, add:

```javascript
export const updateProfile = (data) => api.put('/profile/', data).then(r => r.data)
export const checkHandleAvailable = (handle) =>
  api.get('/profile/handle-available', { params: { handle } }).then(r => r.data)
export const updateBinder = (id, data) => api.put(`/binders/${id}`, data).then(r => r.data)
```

(If `updateBinder` already exists, extend its usage to pass `is_public` rather than redefining.)

- [ ] **Step 2: Add the "Public profile" settings section**

In `frontend/src/pages/Settings.jsx`, add a section that:
- Loads current `public_handle`, `is_profile_public`, `public_show_values` from `/api/settings/` (these are now included via the profile columns — if not surfaced there, fetch from a `getMe`-style call; simplest is to read them from the settings payload which already returns user-scoped data). Use local state seeded on mount.
- Renders a handle text input with live availability feedback via `checkHandleAvailable` (debounced 400ms; show "available"/reason).
- Renders toggles for `is_profile_public` and `public_show_values`.
- On save, calls `updateProfile({ public_handle, is_profile_public, public_show_values })`.
- Shows the public URL `${window.location.origin}/u/${handle}` with a copy button when a handle is set and the profile is public.

Concrete control block to insert (adapt styling to the surrounding page):

```javascript
// inside Settings component
const [handle, setHandle] = useState('')
const [profilePublic, setProfilePublic] = useState(false)
const [showValues, setShowValues] = useState(false)
const [handleStatus, setHandleStatus] = useState(null) // {available, reason}

useEffect(() => {
  if (!handle) { setHandleStatus(null); return }
  const t = setTimeout(() => {
    checkHandleAvailable(handle).then(setHandleStatus).catch(() => setHandleStatus(null))
  }, 400)
  return () => clearTimeout(t)
}, [handle])

const savePublicProfile = async () => {
  await updateProfile({
    public_handle: handle || null,
    is_profile_public: profilePublic,
    public_show_values: showValues,
  })
}
```

And JSX (place in a settings card):

```jsx
<div className="space-y-3">
  <h3 className="font-semibold">Public profile</h3>
  <label className="block text-sm">Handle
    <input value={handle} onChange={e => setHandle(e.target.value.toLowerCase())}
           className="mt-1 w-full rounded border border-border bg-bg-secondary p-2"
           placeholder="ash-ketchum" />
  </label>
  {handleStatus && (
    <p className={handleStatus.available ? 'text-green-500 text-xs' : 'text-red-500 text-xs'}>
      {handleStatus.available ? 'Available' : handleStatus.reason}
    </p>
  )}
  <label className="flex items-center gap-2 text-sm">
    <input type="checkbox" checked={profilePublic} onChange={e => setProfilePublic(e.target.checked)} />
    Make my profile public
  </label>
  <label className="flex items-center gap-2 text-sm">
    <input type="checkbox" checked={showValues} onChange={e => setShowValues(e.target.checked)} />
    Show card market values on my public profile
  </label>
  <button onClick={savePublicProfile} className="rounded bg-primary px-3 py-2 text-white text-sm">Save</button>
  {profilePublic && handle && (
    <div className="text-xs text-text-secondary break-all">
      {`${window.location.origin}/u/${handle}`}
      <button className="ml-2 underline"
              onClick={() => navigator.clipboard.writeText(`${window.location.origin}/u/${handle}`)}>Copy</button>
    </div>
  )}
</div>
```

Seed `handle/profilePublic/showValues` from the settings payload the page already loads (the profile columns are user-scoped). If the settings endpoint does not return them, add them to `_get_user_settings` in `backend/api/settings.py` (read-only, non-sensitive) so the page can hydrate — but do NOT route their writes through settings; writes go through `/api/profile`.

- [ ] **Step 3: Add per-binder "Share publicly" toggle**

In `frontend/src/pages/Binders.jsx`, on each binder card (collection binders only), add a small toggle that calls `updateBinder(binder.id, { is_public: next })` and reflects `binder.is_public`. Show a hint ("Enable your public profile in Settings to share") when the user's profile isn't public. Include a copy-link affordance to `${origin}/u/${handle}/binder/${binder.id}` when both profile and binder are public.

- [ ] **Step 4: Link leaderboard rows with a handle**

In `frontend/src/pages/Leaderboard.jsx`, where each row renders, if `row.public_handle` is set, wrap/append a `<Link to={`/u/${row.public_handle}`}>` (e.g. a small "profile" link/icon). Leave rows without a handle unchanged.

- [ ] **Step 5: Build to verify no breakage**

Run: `docker run --rm -v "$PWD/frontend":/app -w /app node:20 npm run build`
Expected: build succeeds.

- [ ] **Step 6: Run frontend tests**

Run: `docker run --rm -v "$PWD/frontend":/app -w /app node:20 npx vitest run`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/client.js frontend/src/pages/Settings.jsx frontend/src/pages/Binders.jsx frontend/src/pages/Leaderboard.jsx
git commit -m "feat(public-binders): owner controls — settings, binder toggle, leaderboard links"
```

---

## Task 11: Cache headers + rate limiting + manual verification

**Files:**
- Modify: `backend/api/public.py`

**Interfaces:**
- Consumes: `main.py`'s existing slowapi `Limiter` (via the `@limiter.limit` decorator pattern already used in the codebase).

- [ ] **Step 1: Add the public `Cache-Control` header (test-safe signature)**

Add a `response: Response = None` keyword param (defaulted, so the direct unit-test calls from Task 4 still work) and set the header. Update both endpoints:

```python
from fastapi import Response

@router.get("/profiles/{handle}", response_model=PublicProfile)
def get_public_profile(handle: str, db: Session = Depends(get_db), response: Response = None):
    user = pp.get_live_profile(db, handle.lower())
    if not user:
        raise HTTPException(status_code=404, detail="Profile not found")
    if response is not None:
        response.headers["Cache-Control"] = "public, max-age=300"
    return pp.serialize_profile(db, user)
```

Apply the same `response: Response = None` param + header line to `get_public_binder`. Re-run Task 4's tests to confirm they still pass:
`docker run --rm -v "$PWD/backend":/app/backend -w /app/backend pokecollector-backend python -m unittest tests.test_public_binders.PublicApiTests -v`

- [ ] **Step 2: Add a slowapi limit to public endpoints**

First search the codebase for the existing pattern: `grep -rn "limiter.limit\|@limiter\|Limiter(" backend/`. Match whatever it does exactly. slowapi's decorator requires a `request: Request` parameter on the endpoint. Example shape:

```python
from fastapi import Request

@router.get("/profiles/{handle}", response_model=PublicProfile)
@limiter.limit("60/minute")
def get_public_profile(request: Request, handle: str, db: Session = Depends(get_db), response: Response = None):
    ...
```

Because adding a required `request: Request` positional param changes the signature the Task 4 unit tests call, either (a) pass a stub `request` in those tests, or (b) if the `limiter` instance can't be imported into `public.py` without an import cycle with `main.py`, **skip the decorator** and leave rate limiting as a documented follow-up — the spec permits deferral. Do NOT introduce an import cycle, and do NOT break the Task 4 tests. Prefer moving the `Limiter` instance to a small `backend/services/rate_limit.py` if you want the decorator without the cycle.

- [ ] **Step 3: Run the full backend suite**

Run: `docker run --rm -v "$PWD/backend":/app/backend -w /app/backend pokecollector-backend python -m unittest discover -s tests -v`
Expected: all pass.

- [ ] **Step 4: Manual verification (logged out)**

With the feature deployed to a test environment (not asked for here — just the checklist):
- Set a handle, publish the profile, share one binder in the app.
- In a private/incognito window (no token), open `https://<host>/u/<handle>` → profile renders, shared binder visible.
- Open the shared binder URL → cards render read-only; values shown only if the toggle is on.
- Open a non-shared binder id under the handle → 404 page/message.
- Unpublish the profile → both URLs now show "not available".

- [ ] **Step 5: Commit**

```bash
git add backend/api/public.py
git commit -m "feat(public-binders): cache headers + rate-limit public endpoints"
```

---

## Self-Review Notes (coverage map)

- Data model (handle, profile-public, show-values, binder-public) → Task 1.
- Handle validation + reserved words → Task 2 (backend), Task 8 (frontend).
- Whitelist serialization / no private-field leak / show-values gating → Task 3 (+ tests).
- Unauthenticated public API + 404-not-403 + cross-owner guard → Task 4.
- Owner controls (handle set, toggles, availability, 409 on dup) → Task 5.
- Per-binder share toggle → Task 6 (backend), Task 10 (UI).
- In-app discovery via leaderboard → Task 7 (backend), Task 10 (UI links).
- Public pages outside login wall + token-less client → Tasks 8–9.
- Rate limiting (upgraded from spec's "deferred" since slowapi already exists) → Task 11.
- Known v1 exclusions (SSR/OG previews, per-viewer currency, public directory, wishlist sharing) remain out of scope.
