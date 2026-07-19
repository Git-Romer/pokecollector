# Public Viewable Binders — Design

**Date:** 2026-07-19
**Branch:** `feature/public-binders` (cut from `upstream/main`)
**Status:** Design — awaiting review before implementation planning

## Summary

Let a user publish a **public profile** identified by a custom handle. On that profile,
individual binders the user has explicitly shared are viewable — by anyone with the link
(no account required) and discoverable by logged-in users from the leaderboard. Purchase
prices, cost basis, and P&L are **never** exposed. Current card market values are shown
only if the profile owner opts in.

This extends the app's existing cross-user viewing (which today is entirely behind the
login wall via `ProtectedRoutes` and `get_current_user`) with a genuinely public,
unauthenticated surface.

## Decisions (from brainstorming)

- **Audience:** both — anonymous link works logged-out, AND logged-in users can discover
  public profiles in-app.
- **Control model:** a profile-level "make profile public" switch plus a per-binder
  "share publicly" toggle. The public profile lists only the binders the user shared.
- **Money data:** purchase price / cost basis / P&L are never public. Current market value
  (per card + binder total) is shown only when the owner enables a per-profile
  "show card values" setting. Default off.
- **Identity:** a unique, URL-safe **handle** for the URL (`/u/<handle>`); the page shows
  the user's `trainer_name` + avatar. The login `username` is never stored in or emitted
  by any public response.
- **Architecture:** a dedicated unauthenticated `/api/public/*` namespace with its own
  whitelist serializers, kept physically separate from the private endpoints, so private
  fields cannot leak by construction. (Rejected: gating the existing private endpoints
  with optional auth — mixing trust levels in one handler is exactly the pattern that
  produced the earlier `SENSITIVE_ADMIN_KEYS` admin-key leak.)

## Data model

No Alembic in this project (`create_all` adds new *tables* only), so each new **column**
needs a hand-written `migrate_*` function in `backend/database.py`
(`ALTER TABLE ... ADD COLUMN ... DEFAULT ...`). All defaults keep existing data private.

`User` (new columns):
- `public_handle` — `String`, **unique**, nullable. URL slug: lowercase `[a-z0-9-]`,
  3–30 chars, no leading/trailing/double hyphen. `NULL` = no public profile.
- `is_profile_public` — `Boolean`, default `False`. Master switch.
- `public_show_values` — `Boolean`, default `False`. Per-profile "show card market values".

`Binder` (new column):
- `is_public` — `Boolean`, default `False`. Per-binder share toggle.

**A profile is live iff** `is_profile_public = True AND public_handle IS NOT NULL`.
**A binder is publicly viewable iff** its owner's profile is live AND `binder.is_public = True`.

Display name = existing `trainer_name` UserSetting (default `"TRAINER"`). Avatar =
existing `User.avatar_id`.

### Reserved handles

`admin`, `api`, `u`, `settings`, `login`, `logout`, `static`, `assets`, `public`,
`me`, `null`, `undefined` (final list finalized during implementation).

## Backend — `backend/api/public.py` (unauthenticated router)

Mounted under `/api/public`. No `get_current_user`. Own Pydantic response models that
contain **only** whitelisted fields — private fields are absent from the models, so they
cannot be serialized even by mistake.

Response models:
- `PublicProfile` — `handle`, `trainer_name`, `avatar_id`, `show_values` (bool),
  `binders: list[PublicBinderSummary]`.
- `PublicBinderSummary` — `id`, `name`, `color`, `icon_pokemon_id`, `card_count`,
  `unique_card_count`, `total_value` (nullable; present only if `show_values`).
- `PublicBinderDetail` — summary fields + `cards: list[PublicCard]`.
- `PublicCard` — `id`, `name`, `image`, `set_name`, `number`, `rarity`, `quantity`,
  `market_value` (nullable; present only if `show_values`).

Endpoints:
- `GET /api/public/profiles/{handle}` → `PublicProfile`. 404 unless profile is live.
  Lists only `is_public` binders belonging to that user.
- `GET /api/public/profiles/{handle}/binders/{binder_id}` → `PublicBinderDetail`.
  404 unless profile is live AND the binder belongs to that user AND `binder.is_public`.

Owner-facing control endpoints (authenticated). These are profile-shaped, not simple
key/value settings, so they live in a small new authenticated `backend/api/profile.py`
router (mounted at `/api/profile`) rather than being squeezed into the settings key/value
model:
- `PUT /api/profile` → set `public_handle` (validated), `is_profile_public`,
  `public_show_values`.
- `GET /api/profile/handle-available?handle=...` → `{available: bool, reason?: str}` for
  live availability checks.
- Extend the existing binder update endpoint (`backend/api/binders.py`) to accept
  `is_public`.

Discovery:
- Add `handle` (nullable) + `is_profile_public` to the existing leaderboard row payload
  (`backend/api/social.py`) so the frontend can link rows to `/u/<handle>`. No standalone
  public directory page or endpoint in v1 (YAGNI).

Market value: reuse `effective_market_price` (Cardmarket EUR) for `market_value` /
`total_value`. Values are EUR-native; public pages display in EUR in v1 (no per-viewer
currency conversion — the viewer may be anonymous with no currency setting).

## Frontend

Routing (`frontend/src/App.jsx`): add a **public route group rendered regardless of auth
state**, as a sibling of `ProtectedRoutes`:
- `/u/:handle` → `PublicProfile`
- `/u/:handle/binder/:binderId` → `PublicBinderView`

These pages call `/api/public/*` with no `Authorization` header and must render fully for a
logged-out visitor (no redirect to login, no calls to protected endpoints).

New pages:
- `PublicProfile.jsx` — handle → trainer name + avatar + grid of shared binders (counts,
  and `total_value` only when `show_values`). Each binder links to its public view.
- `PublicBinderView.jsx` — read-only card grid reusing existing card-tile components
  (e.g. `CardItem`), with **no** add/edit/remove affordances. Per-card value shown only
  when `show_values`.

Owner controls:
- `Settings.jsx` — a "Public profile" section: set/edit handle with live availability
  check, toggle `is_profile_public`, toggle `public_show_values`, and a copy-to-clipboard
  of the public URL.
- Binder UI (`Binders.jsx` / `BinderDetail.jsx`) — a per-binder "Share publicly" toggle,
  effective only while the profile is public (with a hint if the profile isn't public yet),
  plus a copy-link affordance.
- `Leaderboard.jsx` — rows with a handle link to `/u/<handle>`.

## Privacy, security & error handling

- Non-public profile or binder → **404, never 403** (do not confirm a private binder exists).
- Disabling a profile or unsharing a binder immediately 404s existing links — no stale
  tokens or cached grants.
- Public serializers omit `purchase_price`, cost basis, P&L, condition, notes, `username`,
  email, telegram/gemini settings, and internal user ids.
- Handle set-path validates slug format, reserved words, and uniqueness (backed by a unique
  constraint; handle races surface as a 409/validation error).
- Public GET responses send `Cache-Control: public, max-age=...`. Data is intentionally
  public; no heavy per-IP rate limiting in v1 (noted as a follow-up if scraping becomes an
  issue).
- Works in single- or multi-user mode.

**Known v1 limitations (out of scope):**
- SPA has no SSR, so shared links won't render rich social-preview (OpenGraph) cards. The
  link works; the unfurl is plain. Could add per-route meta / prerender later.
- No per-viewer currency conversion on public pages (EUR only).
- No follower/comment/like social features — view-only.

## Testing

Backend (`unittest`, run in the backend container — not pytest):
- Public serializers never emit private fields (assert `purchase_price` etc. absent from
  the JSON) even when the underlying rows have them populated.
- 404 for: unknown handle, `is_profile_public = False`, non-public binder, and a binder id
  that exists but belongs to a different user than the handle.
- `show_values` gating: `market_value`/`total_value` present when on, absent/null when off.
- Handle validation: format rejects, reserved-word rejects, uniqueness conflict.

Frontend (vitest):
- Handle-validation util (format + reserved).
- `PublicBinderView` renders read-only (no edit controls present).
- Value hiding when `show_values` is off.

Manual:
- Confirm logged-out access to `/u/<handle>` and a shared binder against the real domain
  (`https://poke.roberts-clan.site`), and that a private binder / unpublished profile 404s.

## Out of scope / future

- Public directory / browse-all-profiles page.
- Social-preview (OG) meta and SSR/prerender.
- Rate limiting / anti-scraping.
- Per-viewer currency on public pages.
- Wishlist binders public sharing (v1 covers collection binders; wishlist sharing can follow
  the same pattern if wanted).
