# PWA, Offline Queue and Web Push — Design for PokéCollector

> **Status: implemented.** This document is the design the feature was built from. It is kept as the rationale behind the implementation. `docs/PWA.md` describes current behaviour and is the place to look for configuration and usage; where the two differ, `docs/PWA.md` and the code win (§13.3 lists the deviations found while testing on real devices). Not built: P9 (offline collection/wishlist adds). Not part of this change: P11 (enabling the flags by default); both flags default to off.
>
> Written in October 2026 against `main` at v1.51.6 (`d00efee`). Evidence conventions: repo claims cite `file:line`; platform claims are **VERIFIED** (primary-source URL) or **UNVERIFIED** (what would settle it, and why the design stays safe if the claim is false).

**Contents:** 1 Summary and phasing · 2 Goals, non-goals, assumptions · 3 Verified findings (3.1 repo facts R1–R8, 3.2 further repo findings, 3.3 platform facts, 3.4 in-flight work) · 4 Architecture · 5 Decisions D1–D16 · 6 Detailed specifications (6.1 server idempotency, 6.2 outbox, 6.3 service worker, 6.4 UI, 6.5 scanner, 6.6 auth, 6.7 push) · 7 Edge-case table · 8 Scenario traces · 9 Phased plan (9.1 delivery, 9.2 phase definitions) · 10 Test strategy · 11 Risks register · 12 Decisions taken · 13 Appendix (red-team list, sources, implementation notes)

---

## 1. Summary and recommended scope/phasing

- **Goal:** make PokéCollector a first-class installable iPhone web app (no $99 Apple Developer Program), with an offline app shell, an offline write queue ("outbox") and optional Web Push for price alerts.
- **Scope, in shipping order:** Tier 0 installability + offline shell → Tier 2a offline **scan capture** (photos are uploaded when the server is reachable) → Tier 1 read-only cache of data already viewed (independent of Tier 2a, swappable) → web push for price alerts (P10). Tier 2b offline *adds* (collection/wishlist, P9) is not built. **Offline card search is out of scope** (the catalogue lives in server Postgres).
- **Safety principle:** only *append / commutative* operations are ever queued (scan upload, collection add, wishlist add). Nothing destructive or read-modify-write is queued, so the worst failure is a missing or duplicated addition, never lost server data.
- **Server first:** an `Idempotency-Key` contract (new `idempotency_keys` table, key recorded in the *same* DB transaction as the business write, only successes stored) lands before any client queueing.
- **Client:** the outbox lives in **page context + IndexedDB** (Safari has no Background Sync — VERIFIED), uses a reachability probe instead of `navigator.onLine`, single-flights via an IndexedDB lease, and stores photos as `ArrayBuffer` and uploads them as fresh in-memory Blobs (WebKit bug 319985 empties disk-backed `File` bodies on iOS 26.5+ — VERIFIED).
- **Service worker:** hand-written (`vite-plugin-pwa@2.0.0` resolves to a **353-node** dependency graph — VERIFIED via deps.dev), never touches `/api` (except three public image prefixes), **never precaches `index.html`** (the container rewrites it at start, R7), never auto-activates, and has a three-level kill switch.
- **Rollout:** two opt-in env flags (`PWA_ENABLED`, `OFFLINE_QUEUE_ENABLED`), default **off**; flipping the defaults (P11) is a separate, later decision and is not part of this change.
- **Size:** phases P0–P8 and P10 (P9 was not built; P11, the default flip, is not part of this change), merged **sequentially** (shared hot files, two migration PRs; no version bumps); longest true dependency chain = **6 PRs**.
- **Five biggest risks:** (1) double-apply after a lost response — mitigated by idempotency; (2) a bad service-worker release trapping users — kill switch + no auto-activation; (3) Safari/iOS storage eviction or quirks (Blob/File bugs, 7-day cap outside installed apps) — ArrayBuffers, canary, honest wording; (4) replay storms/429 against a *shared* 60 req/min bucket on `main` — pacing + 429 pause; (5) auth/multi-user leakage — items bound to `userId`+origin, `X-Expected-User-Id` server guard, SW never caches authenticated data.

### 1.1 Recommended phasing (one PR each; details in §9)

| Phase | Ships | Depends on (merged) | Flags |
|---|---|---|---|
| P0 | This design document (docs-only) | — | — |
| P1 | Server idempotency + migration + health info | — | — |
| P2 | Installability, iOS meta, icons, nginx cache headers | — | — |
| P3 | Opt-in service worker, kill switch, update banner, upload hardening | P2 | `PWA_ENABLED` |
| P4 | Outbox core (IndexedDB, state machine, replay engine) — no UI | P1 | `OFFLINE_QUEUE_ENABLED` |
| P5 | Degraded (offline) sign-in state, logout guard, provider | P4, P3 | `OFFLINE_QUEUE_ENABLED` |
| P6 | Sync center, offline banner, storage protection, `/offline` page | P5 | `OFFLINE_QUEUE_ENABLED` |
| P7 | Offline scan capture (persist-then-send) | P6, P3, P1 | `OFFLINE_QUEUE_ENABLED` |
| P8 | Read cache of viewed data (Tier 1) | P6 | `OFFLINE_QUEUE_ENABLED` |
| P9 | *(not built)* Offline collection/wishlist adds | P7 | `OFFLINE_QUEUE_ENABLED` |
| P10 | Web push for price alerts (migration) | P3, P1 | — |
| P11 | *(not part of this change)* Flip defaults to on, final docs | P7, P3 | — |

---

## 2. Goals, non-goals, assumptions

### 2.1 Goals
1. G1 — Installable on iPhone: correct manifest, icons, iOS meta, safe-area polish, standalone-aware UI.
2. G2 — App shell opens with no connectivity (after one online visit) and shows a friendly, bilingual offline state.
3. G3 — Scan photos taken with no signal are kept on the device and uploaded exactly once when the server is reachable again.
4. G4 — Previously viewed collection data is readable offline and labelled "last synced".
5. G5 — No data loss, no double-apply, no cross-account replay, no stale-cache lockout (kill switch).
6. G6 — Plain-HTTP LAN installs behave exactly as today where a service worker is unavailable, and are told honestly what degrades.
7. G7 — Every phase ships safely on its own, behind flags, with documentation.

### 2.2 Non-goals (explicitly **not** built, and why)
| Not built | Why |
|---|---|
| Offline card search | Catalogue is huge and lives in server Postgres (`backend/models.py` `cards`); mirroring it to the phone is a separate product. |
| Queued edits, deletes, bulk-add, CSV import, scan review actions, binder/deck allocation, trades, products, settings, admin, password change, custom-card CRUD | Read-modify-write or cross-entity invariants (D3). Last-write-wins would silently overwrite another device's data. |
| Background Sync / Periodic Sync | Not supported on Safari/iOS (VERIFIED, PF1); Chrome-only value; extra complexity. |
| Workbox / vite-plugin-pwa | A 353-node dependency graph for ~300 lines of logic (D9). |
| Service-worker-owned outbox | SWs are killed arbitrarily and are unavailable on plain HTTP (D2). |
| Client-side photo re-encode / thumbnails in v1 | Server already normalises to ≤2048 px q90 (`scan_storage.py:33-34,80-126`); canvas/EXIF/HEIC pipelines cannot be verified without a device matrix (D11). |
| Honouring a client capture time as `added_at` | `sync_service.py:139-157` uses `max(added_at)` as an activity signal; `added_at` is the date a card was added and is never edited afterwards (D11). |
| Offline login, cross-device sync, CRDTs | Auth is server-side JWT; commutative adds need no CRDT. |
| Self-hosting the Inter font | Separate change (decision Q5). |
| Sub-path deployments | Unsupported today (`vite.config.js:19-32`, `App.jsx:204`); PWA scope is `/`. |
| Android/desktop install prompt UI | `beforeinstallprompt` is Chromium-only and non-standard (VERIFIED); iOS is the target. |

### 2.3 Assumptions
- A1 — Target devices: iPhone/iPad on **iOS/iPadOS 16.4+** (Home Screen web apps, manifest `id`, push — VERIFIED); anything older keeps working as a normal website.
- A2 — The site is served from an origin **root** (no sub-path).
- A3 — Backend runs as a single uvicorn process (`backend/Dockerfile:32`); DB is PostgreSQL 18.
- A4 — Most self-hosters use plain `http://192.168.x.x`; some use HTTPS via a reverse proxy; some add SSO (`docs/REVERSE_PROXY_AUTH.md`). A typical HTTPS setup is a reverse proxy with a trusted certificate (for example Nginx Proxy Manager) in front of the frontend container, which then publishes no ports of its own.
- A5 — Frontend and backend images are published separately (`.github/workflows/release.yml`), so they can briefly differ.
- A6 — Development happens on a branch cut from `main` (v1.51.6, `d00efee`); the phases merge sequentially into one integration branch (§9.1).
- A7 — No Apple Developer Program, no native app, no APNs certificates.

---

## 3. Verified findings

### 3.1 Repo facts — hypotheses R1–R8 re-verified

| # | Status | Evidence (file:line) and corrections |
|---|---|---|
| R1 | **CONFIRMED** | `frontend/public/manifest.json:1-14`: `display: standalone` (:6), icons with `?v=2` (:10-12), no `id`/`scope`/maskable/screenshots. `frontend/index.html`: `viewport-fit=cover` (:5), icons `?v=2` (:8-10), manifest link (:12), `theme-color` (:13), Google Fonts (:15-17). No `apple-mobile-web-app-*` meta. A repo-wide search for `serviceWorker`, `workbox`, `sw.js`, `beforeinstallprompt` and `PushManager` finds nothing in app code. Extra: all PNG icons are 16-bit RGBA with transparent corners (`file` output) — Apple-style Home Screen icons should be opaque; how iOS renders transparency is **UNVERIFIED** (polish only). |
| R2 | **CONFIRMED + 3 extra token sites** | `client.js:9` baseURL `/api`; interceptor `:16-24` (header `:21`); 401 handler `:26-39` clears `token`/`user` (`:31-32`) **and hard-redirects** `window.location.href='/login'` (`:34`) unless `preserveSessionOnUnauthorized`. Own-token call sites exactly `:279 :338 :356 :376 :415`. **Missed in the hypothesis:** `contexts/SettingsContext.jsx:91-99`, `:143-150`, `:189-196` use raw `fetch` with their own Bearer logic. `publicClient.js:5-9` baseURL `/api/public`, no auth, no redirect. Owner-photo comment `client.js:174-178` ✓. Default axios timeout 30 s (`:10`). |
| R3 | **CONFIRMED, but it is a blocking screen, not an offline mode** | `contexts/AuthContext.jsx:48-56`: bootstrap failure → status `'offline'`, retry via `authRetryDelay` (1,2,4,8,10 s cap, `authBootstrap.js:1-6`); `loading = status !== 'ready'` (`:96`), `connectionError` (`:97`); `App.jsx:143-145` renders `AuthStartupScreen`. The cached `user` in localStorage (`AuthContext.jsx:8-17`) is ignored while loading. ⇒ today an offline app shows only "Cannot reach PokéCollector" (`i18n/en.js:185-187`); Tier 1 needs a new *degraded* state (P5). |
| R4 | **CONFIRMED with 3 corrections** | Non-idempotent increment `collection.py:353`; merge lookup `:333-350`; `added_at=utcnow()` `:364`; `POST /` `:599-609`; `bulk-add` `:612-647`; `import-csv` `:650-752`. **Corrections:** (a) the 404 "Card is no longer available locally." (`:330-331`) occurs **only** when `ensure_catalogue_card=False`, used only by scan resolve-and-add (`scan_jobs.py:364-368`); the plain add (`:328-329`) calls `ensure_card_exists` (`:246-300`) which **fetches from TCGdex** when the card is missing and 404s with a different message (`:273-276`, `:296-299`). (b) `bulk-add` commits **per item** (`:630-645`): partial success, so one idempotency record cannot cover it. (c) Wishlist add also increments (`wishlist.py:55-56`, cap 99 → 400, `:14-23`). (d) No row lock or unique constraint on the grouping identity ⇒ two concurrent identical adds can create two rows. |
| R5 | **PARTLY WRONG** | Capture inputs exist in `UnifiedCardScanner.jsx:185-195` (camera, `capture` at `:189`) and legacy `CardScanner.jsx:395,:427`, but **`ScanReview.jsx` has no file input at all**. `CardScanner.jsx`'s default export is **dead** (`CardSearch.jsx:10` imports `UnifiedCardScanner` under that name; only `ScanAddModal`/`attachScanFallbackPhoto` are imported elsewhere, `ScanQueue.jsx:15`). Queue facts **CONFIRMED**: `MAX_RECOGNITION_ATTEMPTS=3` (`scan_queue.py:27`), `MAX_CONCURRENT_SCAN_PROCESSING=3` (`:37`), `LEASE_SECONDS=20*60` (`:32`), retention `SCAN_RETENTION_DAYS=14` (`scan_storage.py:35`), `expires_at` set at job creation (`:226`) ⇒ the 14 days count from **upload**, not capture. Staged photos live only in React state (`UnifiedCardScanner.jsx:40,:81-87`); failure just toasts (`:161-163`). |
| R6 | **CONFIRMED + details** | CORS `main.py:116-122`: origins from `CORS_ORIGINS` else `["*"]` (`:118`), methods lack PATCH (`:120`), headers only `Authorization`,`Content-Type` (`:121`). slowapi: `Limiter(... default_limits=["60/minute"])` (`:21`) + `SlowAPIMiddleware` (`:105`) ⇒ **every route**, keyed by `get_remote_address`; no per-route `@limiter.limit` exists; the peer is the nginx container (`backend/Dockerfile:32` has no proxy-header flags) ⇒ on `main` **all users share one 60/min bucket**. slowapi 0.1.9 (`requirements.txt:19`) returns 429 `{"error": ...}` and, with `headers_enabled` defaulting to `False`, **no `Retry-After`** (VERIFIED from source `v0.1.9/slowapi/extension.py`). `alembic==1.13.1` is listed (`requirements.txt:16`) but **unused** (only mention: `docs/ARCHITECTURE.md:369`). Schema ships via `Base.metadata.create_all` (`database.py:1078-1081`) + an idempotent raw-SQL list `_run_migrations` (`database.py:57-678`, each statement in its own try/except `:673-678`; errors swallowed `:1084-1087`) ⇒ one linear tail: parallel migration PRs collide. Pre-upgrade `pg_dump` runs before `init_db()` (`main.py:62-63`, `services/pre_upgrade_backup.py`). `backup.py:21-43` selective groups exclude newer tables; `restore` is `psql --single-transaction` (`:161-177`). |
| R7 | **CONFIRMED — showstopper, resolved in D9** | `frontend/Dockerfile:24` copies `index.html` → `index.html.template`; `docker-entrypoint.d/40-configure-public-mode.sh` runs **at container start**: resets `index.html` from the template (`:10`), then `sed -i` rewrites the `<title>` line to add `noindex` (`:14-15`) or SEO tags (`:21-31`); it also **overwrites `robots.txt`** (`:13`, `:20`; build also copies `robots-block.txt`, `Dockerfile:11`). A build-time revision hash for `index.html`/`robots.txt` would never match what is served. ⇒ never precache either; cache the shell at runtime under a consistency rule (D9). |
| R8 | **CONFIRMED + corrections** | vitest 4, node environment, **no config file**, component tests use `renderToStaticMarkup` + `vi.mock` (`AuthStartupScreen.test.js`); `fake-indexeddb` is not installed. Playwright: `playwright.config.js` (chromium; desktop+mobile; dev server :4173) and `playwright.webkit.config.js` (only `card-system-webkit.spec.js`). `npm test` = `check:translations` + `node --test scripts/configure-public-mode.test.mjs` + `vitest run src` (`package.json:11`). `check:translations` validates only **literal** `t('a.b')` keys against `en.js` (`scripts/check-translations.mjs:11,24-40`) and does **not** require `de` (`CONTRIBUTING.md:43`); this design supplies both anyway. Backend tests are **`unittest`** (`CONTRIBUTING.md:26-28`), not pytest. CI (`frontend-card-system.yml`) runs frontend checks only; no backend CI. Workflows use a hand-rolled `git fetch` checkout and no third-party actions except SHA-pinned Docker actions. |

### 3.2 Additional repo findings that shape the design

| # | Finding (file:line) | Consequence |
|---|---|---|
| F1 | Every multipart upload hands a `File` straight to `FormData`: `client.js:127-134` (scan jobs), `:185-194` (owner photo), `:203-209` (collection CSV), `:271-277` (binder CSV), `:393-399` (restore), `:117-124` (legacy recognise). | WebKit bug 319985 (iOS 26.5.x–26.7, iOS 27 reports; fixed in WebKit main 2026-10-10, release not stated) sends an **empty body** for disk-backed Files on service-worker-controlled pages. Adding a SW could **newly break existing uploads** on affected iOS builds ⇒ P3 must add `toMemoryBlob` to every upload. |
| F2 | 12 of 12 sampled VERSION-touching commits are code PRs that bump `VERSION` (`git log -- VERSION`); docs-only #411 did not. A bump touches 7 files (§9.1.4). `release.yml:3-9` publishes images when `VERSION` changes on `main`. | Each merged code phase *is a release*; phases must be safe alone and flag-gated. |
| F3 | `nginx.conf:86-89` gives every static extension in its regex (`js`, `css`, `png`, `svg`, …) `expires 1y` + `immutable`; that regex would match `/sw.js`. `add_header` inside a `location` **replaces** inherited `add_header`s (so static assets already lack CSP/X-Frame). `nginx.conf:81-83` `try_files … /index.html` sets **no cache header** on HTML. | `/sw.js` needs an exact-match no-cache location; `index.html` needs `no-cache` (also fixes a pre-existing stale-index hazard). |
| F4 | No `base` in `vite.config.js:19-32`, `BrowserRouter` without `basename` (`App.jsx:204`), absolute `/api` and `/login`. | Root deployment only; manifest `scope:"/"`. |
| F5 | `main.jsx:16-24` QueryClient: `retry:1`, `staleTime:30000`, `refetchOnWindowFocus:false`, no persister. | Tier 1 adds a persister without new dependencies (`dehydrate/hydrate` ship with `@tanstack/react-query`). |
| F6 | ~30 lazy page chunks (`App.jsx:14-47`) + 19 lazy translation chunks (`SettingsContext.jsx:7-27`). | Offline navigation needs **all** hashed chunks precached; budget test (12 MiB). |
| F7 | `AppNav.jsx:84` top strip `pt-5` (no safe-area), home button `bottom-6` (`:118`, no inset); `PublicHomeButton.jsx:15-16` already uses `env(safe-area-inset-*)`. `BottomNav.jsx`, `Sidebar.jsx`, `SyncStatus.jsx` have **no importers**. | Safe-area polish in P2; new indicator mounts in `Layout.jsx`, not in dead components. |
| F8 | `UnifiedCardScanner.jsx:82` already guards `crypto.randomUUID`. `crypto.randomUUID` is secure-context-only (VERIFIED, MDN); `crypto.getRandomValues` works on insecure origins (VERIFIED). | Key generator uses `getRandomValues`. |
| F9 | JWT HS256, **7 days**, no refresh (`services/auth.py:102`); password change does **not** revoke tokens on `main` (`api/auth.py:393-404`); single-user mode returns the first active admin when no token (`api/auth.py:126-132`); role/active read from DB each request (`:140-142`). | A phone offline >7 days will 401 on first replay; items must survive and resume after re-login. |
| F10 | `enqueue_scan_job` is `async def` with a sync DB session (`scan_jobs.py:106-167`); `create_scan_job` commits internally (`scan_storage.py:269`) and runs CPU-heavy Pillow work in the event loop (`:80-126`). | Idempotency needs a pre-commit hook; no blocking DB lock waits in async handlers; client replay concurrency = 1. |
| F11 | `resolve_and_add` is already idempotent via row lock + `resolved` flag (`scan_jobs.py:315-319,:359-362`). | Precedent; review actions stay online-only. |
| F12 | `sync_service.py:139-157` uses `max(added_at)` as price-sync activity. | Never backdate `added_at`. |
| F13 | `docker-compose.yml:4,:36,:82` hard-code `container_name`; `core.autocrlf=true` on some Windows checkouts; no `.gitattributes`. | Parallel stacks clash (§9.1.5); shell scripts need `eol=lf` (P3 adds `.gitattributes`). |
| F14 | Cache headers already used: card/set images `public, max-age=86400` (`api/images.py:63,220,262`); pokedex images `public, max-age=604800` (`api/pokedex.py:65`); `/api/public` `public, max-age=0, must-revalidate` (`api/public.py:127`); owner photo `no-store` + `Vary: Authorization` (`collection.py:1071-1074`); scan candidate image **authenticated** `private, max-age=86400` (`scan_jobs.py:272`). | SW cache allowlist (D8) and a hard "never cache `no-store`/`private`" rule. |
| F15 | `logout()` removes only `token` and `user` (`AuthContext.jsx:88-89`) — it does **not** clear all localStorage as `docs/ARCHITECTURE.md:360` implies. | Outbox is IndexedDB (separate); logout guard is new. |
| F16 | `telegram.send_price_alert` is called from `sync_service.check_wishlist_alerts` (`:624-629`), which sets `notified_at` regardless of delivery (`:629`). | Push hooks in at the same point (D15). |
| F17 | `ensure_card_exists` can `commit()` mid-request (`collection.py:289-295`); it is called by collection add (`:329`) and wishlist add (`wishlist.py:48`). | A transaction-level advisory lock is released by that commit ⇒ the unique constraint is the final safety net (D4). |

### 3.3 Platform facts — PF1–PF7 (originally numbered P1–P7) and extras X1–X16

Legend: **V** = VERIFIED against a primary source; **U** = UNVERIFIED. Platform claims are labelled **PF1–PF7** (originally P1–P7) and extras **X1–X16**, so they cannot be confused with phases P0–P11. Today is 2026-10-16: Safari/iOS **27.0** shipped about 2026-09-17 (date of its WebKit features post); iOS 26.x remains common. Current-information coverage: WebKit posts through **Safari 27.0** were read; Apple's iPhone User Guide page for Add to Home Screen could not be retrieved (it is script-rendered), so install wording is generic (PF6b).

| Claim | Status | Source | How the design stays safe if wrong |
|---|---|---|---|
| **PF1** Safari/iOS has no Background Sync (SyncManager) | **V** | MDN browser-compat-data `api/SyncManager.json` (Safari `false`, iOS mirrors; `impl_url` https://webkit.org/b/182565) | Not used. Replay runs from page context on start/foreground/`online`/timer/manual. "Workbox's fallback is unreliable on Safari": **U**, irrelevant (no Workbox). |
| **PF2a** Service workers and Web Push need a secure context | **V** | https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts/features_restricted_to_secure_contexts ; https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers (localhost counts as secure) | Feature-detect `isSecureContext` + `'serviceWorker' in navigator`; no SW on `http://192.168.x.x`; app unchanged there (D14). |
| **PF2b** IndexedDB works on plain HTTP | **V by absence / U on real iPhone** | MDN IndexedDB page lists no secure-context requirement and the restricted-features list omits it | Outbox opens IndexedDB in try/catch; on failure the queue feature disables itself and the app behaves as today. Manual checklist step M-11 settles it on a real iPhone over `http://192.168.x.x`. |
| **PF3** SW is stopped after ~30 s idle | **U** for Safari (number is Chrome-specific; MDN only warns about global state) | https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers | SW is stateless; all queue state is in IndexedDB; the SW holds no timers or tokens. |
| **PF4a** Safari deletes script-writable storage (IndexedDB, localStorage, Cache/SW registrations…) after 7 days of Safari use without interaction | **V** | https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ (2020-03-24) | Canary + warnings; "the server copy is the only durable copy". |
| **PF4b** Home Screen web apps are exempt / isolated | **V by policy; anecdotal exceptions U** | https://webkit.org/tracking-prevention/ (web app data isolated; first-party domain fully exempt from the 7-day cap incl. IndexedDB/localStorage/SW data). Reports of deviations (e.g. WebKit bug 211775, session cookies reset on iOS 17.4.1) are **U** | Treat eviction as possible everywhere; canary detects partial wipes; warn when not installed and items are >3 days old. |
| **PF4c** `navigator.storage.persist()` is heuristic; "must be re-requested every launch" | heuristic **V**; re-request claim **U** | https://webkit.org/blog/14403/updates-to-storage-policy/ (2023-08-10: 60% disk quota for browser apps, 15% for others; LRU origin eviction; `persist()` granted by heuristics, e.g. Home Screen web app); MDN BCD `api/StorageManager.json` (persist Safari 15.2, estimate Safari 17) | Request `persist()` on every launch while the queue is non-empty (cheap), show the result, never rely on it. |
| **PF5** Installed app and Safari tab have separate storage/login | **V** | https://webkit.org/tracking-prevention/ ; https://webkit.org/blog/14787/webkit-features-in-safari-17-2/ (2023-12-11: iOS 17.2 copies **cookies only**, once, at creation) | App token is in `localStorage` ⇒ not carried; installed app starts logged out with an empty outbox. S15 shows the hint "sync before installing". |
| **PF6a** iOS 26: every site added to the Home Screen opens as a web app by default | **V** | https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/ (2025-06-09; user can turn "Open as Web App" off; manifest still applies; SW offline still works) | Standalone detection via `navigator.standalone`/`display-mode`; UI works in both modes. |
| **PF6b** No `beforeinstallprompt` on iOS | **V** | MDN BCD `api/BeforeInstallPromptEvent.json` (Safari/iOS `false`; Chrome 44, experimental, non-standard) | Static "Share → Add to Home Screen" hint. The exact iOS 26/27 Share-button location is **U** (Apple support page not retrievable) → wording stays generic, checked on device. |
| **PF7** Web Push on iOS: 16.4+, Home Screen app, user-gesture prompt, HTTPS | **V** | https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ ; https://webkit.org/blog/13966/webkit-features-in-safari-16-4/ ; HTTPS via MDN secure-context list. Apple sending rules (VAPID `sub` URL/`mailto:`, `exp` ≤ 1 day, JWT not refreshed > hourly, 4 KB payload, 410 = expired, **no invisible pushes**): https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers (read via DocC JSON). **Declarative Web Push** (iOS 18.4, no SW needed, `web_push: 8030`): https://webkit.org/blog/16535/meet-declarative-web-push/ (2025-03-27) | Push is an optional, separable phase; hidden unless `PushManager` exists and context is secure. |
| **X1** Web Locks API | **V** (Safari/iOS 15.4, BCD `api/LockManager.json`), but secure-context-only | MDN secure-context list | **Not used.** IndexedDB lease row + per-item compare-and-set claim work on every context. |
| **X2** Blobs/Files in IndexedDB and uploads on iOS are unsafe | **V** | WebKit bugs https://bugs.webkit.org/show_bug.cgi?id=292142 (iOS 18.4.x Blob read terminates Networking process; fixed 297122@main), 235687 and 240216 (re-saved Blobs unreadable), **319985** (reported 2026-07-22, iOS/Safari 26.5.x–26.7 + iOS 27 reports: disk-backed `File` sends empty body incl. Files restored from IndexedDB; `new Blob([await file.arrayBuffer()],{type})` works; fix landed WebKit main 2026-10-10, shipped release **not stated**) | Store `ArrayBuffer`s; upload fresh in-memory Blobs. |
| **X3** `navigator.onLine` is unreliable | **V** | https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine ("inherently unreliable"; a LAN without Internet counts as online) | Reachability probe of `/api/health`; `onLine` is only a hint to probe less often. |
| **X4** `<input capture="environment">` in standalone mode | **U** on iOS 26/27 | Old reports only (WebKit bugs 198751/206219/202884, 2019-20, camera black after backgrounding); Apple forum thread 826732 (multiple captures replace the FileList — handled: `UnifiedCardScanner.jsx:191-194` consumes each file and resets the input). `getUserMedia` in standalone: **V** fixed in iOS 13.4 (https://bugs.webkit.org/show_bug.cgi?id=185448) | Photos are persisted at submit; a manual iPhone step (M-04) settles it. |
| **X5** SW update checks and caching | **V** | https://web.dev/articles/service-worker-lifecycle (check on in-scope navigation and after functional events, ≤ once/24 h for the latter; `reg.update()`; byte comparison; main script update bypasses HTTP cache by default in Chrome 68+ "and most other browsers"); MDN BCD (`updateViaCache`/`update()` Safari 11.1, `navigationPreload` 15.4) | Safari's default `updateViaCache` is **U** ⇒ register with `updateViaCache:'none'` and serve `sw.js` with `Cache-Control: no-cache`; call `registration.update()` on foreground (installed iOS apps rarely navigate). |
| **X6** CSP `worker-src` fallback | **V** | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/worker-src (`worker-src` → `child-src` → `script-src` → `default-src`) | `nginx.conf:16` has `script-src 'self'` ⇒ a same-origin `/sw.js` is allowed; no CSP change needed. |
| **X7** External links in standalone mode | **U** | No current primary source found (WWDC23 post does not address scope) | Keep existing `target="_blank" rel="noreferrer"` external links (`Settings.jsx:172,265…`); manual step M-12; nothing depends on it. |
| **X8** Status bar / `theme-color` on iOS 26 | **U** | WebKit bug https://bugs.webkit.org/show_bug.cgi?id=305546 (Safari 26.2, NEW: status bar shows a shadow after soft navigation; `theme-color` has no effect; reproducible in Home Screen apps) | Keep `html` background = app background (`index.css:100`); avoid fixed top bars with different colours; check on device (M-02). |
| **X9** Lockdown Mode disables service workers | **V** | https://webkit.org/blog/13966/webkit-features-in-safari-16-4/ | SW is progressive enhancement; app works without it. |
| **X10** Safari 27 changes | **V** | https://webkit.org/blog/18325/webkit-features-for-safari-27-0/ (2026-09-17): SW static routing API; **HEIC no longer converted to JPEG** by file inputs; IndexedDB/SW fixes | Server accepts HEIC (`pillow-heif`, `requirements.txt:15`, `scan_storage.py:20-26`); static-routing optimisation not built (feature-detect only). |
| **X11** BroadcastChannel | **V** | MDN BCD `api/BroadcastChannel.json` (Safari/iOS 15.4) | `storage`-event fallback for older/odd contexts. |
| **X12** Playwright and service workers | **V** | https://playwright.dev/docs/service-workers (SW support Chromium-only; page requests handled by a SW fetch handler are not routable; `serviceWorkers:'block'` exists) | SW e2e on Chromium only; WebKit project covers the page-level outbox with SWs blocked; real-iPhone checklist covers the rest (§10). |
| **X13** slowapi 429 has no `Retry-After` by default | **V** | https://raw.githubusercontent.com/laurentS/slowapi/v0.1.9/slowapi/extension.py | Client uses `Retry-After` if present else 60 s. |
| **X14** Idempotency-Key conventions | **V** | https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-07 (expired I-D; Structured-Field String, UUID recommended; 422 key reuse with different payload; 409 in-progress; 400 missing; retry returns the earlier result) | Used as convention only; codes mirror it. |
| **X15** `crypto.randomUUID` secure-only; `getRandomValues` insecure-OK | **V** | MDN `Crypto/randomUUID`, `Crypto/getRandomValues` | UUIDv4 built from `getRandomValues`. |
| **X16** Network Information API (`navigator.connection`, `saveData`) on Safari/iOS | **V** (absent) | MDN browser-compat-data `api/NetworkInformation.json` (Safari/iOS "No"; WebKit request bug 185697) | No automatic Wi-Fi-only mode is possible; sequential pacing, visible-only timers, the **Automatic sync** toggle and a waiting-size display (D6). |
| **X17** Nginx Proxy Manager's per-host **Cache Assets** option caches every response whose path ends in `.js`, `.css` or an image or font extension (so `/sw.js` too) for 30 minutes inside the proxy, ignores and hides the app's `Cache-Control`, and serves stale copies when the upstream errors | **V** | NPM source, `develop` branch, read 2026-10-18: `docker/rootfs/etc/nginx/conf.d/include/assets.conf` (path regex, `proxy_cache_valid any 30m`, `proxy_ignore_headers` incl. `Cache-Control`, `proxy_hide_header Cache-Control`, `expires @30m`) and `backend/templates/_assets.conf` (included only when `caching_enabled`) | A new `sw.js` or the L1 kill worker can reach phones up to 30 minutes late. L2 (`/?pc_sw=off`) and L3 (in-app reset) are unaffected because `/`, deep links and `/index.html` do not match the regex. Turn Cache Assets off for the site (M-00); `docs/PWA.md` (P3) tells every reverse-proxy user not to cache `/sw.js`. Authenticated images use extension-less URLs (`scan_jobs.py:216`, `:235`, `collection.py:1041`), so the option never caches them. |

### 3.4 Concurrent in-flight work

Not applicable to this document: the design targets `main` and does not depend on any unmerged branch. The heading is kept so that section numbers stay stable.

---

## 4. Architecture overview

### 4.1 Components and what runs where

| Component | Runs in | Responsibility | Must **not** |
|---|---|---|---|
| **Manifest + iOS meta + icons** (P2) | static files via nginx | Installability, standalone look, safe-area polish | Be renamed (`/manifest.json` is allow-listed by SSO proxies, `docs/REVERSE_PROXY_AUTH.md:19,48,59`) |
| **Service worker** (P3) | browser SW thread (HTTPS only) | Precache hashed assets, cache the shell, offline navigation fallback, bounded image cache, later push display | Touch `/api` (except 3 public image prefixes), read tokens, cache authenticated data, queue writes, auto-activate, `clients.claim()`, use Background Sync |
| **Outbox library** (P4) | page context + IndexedDB | Persist queued operations, state machine, reachability probe, replay engine, single-flight lease, backoff | Depend on the SW; store Blob/File; use the axios 401 interceptor |
| **OfflineProvider** (P5) | page context | Reads flags and auth, owns the controller, bridges reachability to TanStack `onlineManager` | Render UI itself |
| **Sync UI** (P6) | page context | Indicator, sheet, banner, `/offline` page, storage protection | Patch TanStack caches with fake rows |
| **Read cache** (P8) | page context + IndexedDB (separate DB) | Persist allow-listed query results per user+origin | Share a DB with the outbox; outlive logout |
| **Idempotency layer** (P1) | FastAPI + Postgres | Exactly-once effect for three append operations | Store failures; wait on DB locks inside `async` handlers |
| **nginx** (P2/P3) | frontend container | Correct cache headers, `sw.js` no-cache, security-header snippet | Serve `index.html`/`sw.js` as immutable |
| **Entrypoint script** (P3) | container start | Select real vs kill SW, write the flags `<meta>` into `index.html` | Run before `40-configure-public-mode.sh` |

### 4.2 Diagram

```text
                 iPhone: installed Home Screen web app (or a Safari tab)
 +--------------------------------------------------------------------------------+
 | PAGE CONTEXT (React)                                                           |
 |  +-------------+   +----------------+   +--------------------+   +-----------+  |
 |  | UI / pages  |<--| OfflineProvider|<--| Outbox library     |   | Read cache|  |
 |  | SyncIndicator|  | flags+auth+    |   | store / replay /   |   | (TanStack |  |
 |  | OfflineBanner|  | reachability   |   | probe / lease      |   |  persister|  |
 |  +------+------+   +-------+--------+   +---------+----------+   +-----+-----+  |
 |         | axios (UI)       | fetch (replay only)  |                    |        |
 |         |                  |                      v                    v        |
 |         |                  |      IndexedDB "pokecollector-outbox"  "pokecollector-readcache"
 |         |                  |      items | photos(ArrayBuffer) | meta | history   |
 +---------+------------------+---------------------------------------------------+
           | same-origin HTTP(S)
 +---------v------------------------------+        +-------------------------------+
 | SERVICE WORKER (optional; HTTPS only)  |        | nginx (frontend container)    |
 |  pc-precache-<build>: /assets/**       | <----> |  /           -> index.html    |
 |  pc-shell-<build>   : '/shell'         |        |  /sw.js      -> no-cache      |
 |  pc-images-v1       : FIFO 800         |        |  /api/       -> backend:8000  |
 |  never /api (except 3 image prefixes)  |        +---------------+---------------+
 +----------------------------------------+                        |
                                                                   v
                                                  FastAPI (single uvicorn process)
                                                    idempotency_keys, scan_jobs ...
                                                                   |
                                                              PostgreSQL 18
```

### 4.3 Key data flows

**A. Online scan submit (flag on).** (1) User taps *Start scanning*. (2) Files are read into `ArrayBuffer`s, split into ≤12-photo / ≤10 MiB chunks, each written (item + photos) in **one** IndexedDB transaction. (3) If reachability ≠ `unreachable`, the controller sends the chunks one after another immediately and the UI keeps its spinner exactly as today. (4) On 2xx the item moves to history and the UI navigates to `/scans/:id` (one job) or `/scans`. (5) On a network failure the item stays queued, the user sees "Saved on this device", and the scanner closes.

**B. Offline capture and later replay.** (1) Probe says `unreachable`; items accumulate as `pending`. (2) On start/foreground/`online`/timer/manual the replay engine probes `/api/health`; when `reachable` it takes the IndexedDB lease. (3) It claims the oldest eligible item with a compare-and-set (`pending|retry_wait → sending`), builds the request with a fresh in-memory Blob, sends it with `Idempotency-Key` and `X-Expected-User-Id`, classifies the result, and moves the item to `sent` / `retry_wait` / `blocked` / `failed`. (4) Waits `PACE_MS` (2 s) between requests; a 429 pauses the whole engine.

**C. App start.** (1) Flags are read from the `<meta name="pokecollector-pwa">` tag. (2) SW registers (if enabled, secure context). (3) Auth bootstraps; on a network failure with a valid snapshot the app enters **degraded** mode (P5) instead of the blocking connection screen. (4) Outbox opens IndexedDB, recovers stale `sending` claims (→ `retry_wait`, `maybeApplied=true`), requests `storage.persist()` if the queue is non-empty, and starts replay.

**D. New release.** (1) A new `sw.js` is detected on navigation or foreground `registration.update()`. (2) It installs (precache + shell validated) and **waits**. (3) The page shows "A new version is available". (4) The user taps *Update* (disabled while a scan batch is staged or an item is `sending`) → `SKIP_WAITING` → `controllerchange` → one guarded reload. (5) New code opens IndexedDB; the schema upgrade (if any) migrates items in place.

**E. Logout with pending items.** `logout()` (AuthContext) asks: *Sync first / Log out and keep items / Log out and delete items / Cancel*. "Keep" leaves items bound to `userId`+origin, invisible to other accounts. The read cache for that user is always purged.

### 4.4 New file map (created across phases)

```text
backend/services/idempotency.py        backend/services/api_info.py
backend/tests/test_idempotency.py      backend/tests/test_idempotency_postgres.py
frontend/src/sw/sw.js  sw.kill.js      frontend/scripts/build-sw.mjs
frontend/src/pwa/{flags.js,register.js}
frontend/src/utils/memoryBlob.js
frontend/src/offline/{constants.js,capabilities.js,uuid.js,debug.js,authSnapshot.js,routes.js,
                      durability.js,readCache.js,OfflineProvider.jsx,useOutbox.js,
                      useQueuedAdd.js}
frontend/src/offline/outbox/{db.js,store.js,states.js,classify.js,probe.js,backoff.js,
                             lease.js,replay.js,events.js,index.js}
frontend/src/offline/outbox/ops/{scanUpload.js,collectionAdd.js,wishlistAdd.js,scanSubmit.js}
frontend/src/components/sync/{SyncIndicator.jsx,SyncSheet.jsx,OfflineBanner.jsx,
                              LogoutGuardDialog.jsx,StaleDataLabel.jsx,PendingGhostRows.jsx,
                              QueuedChip.jsx}
frontend/src/components/{OfflineUnavailable.jsx,pwa/UpdateBanner.jsx,pwa/InstallHint.jsx,
                         pwa/NotificationsCard.jsx}
frontend/src/pwa/push.js   (Phase 10)
frontend/src/pages/OfflineCenter.jsx
frontend/docker-entrypoint.d/45-configure-pwa.sh
frontend/nginx-security-headers.conf   frontend/playwright.pwa.config.js
frontend/tests/pwa/*.spec.js           docs/PWA.md
```

### 4.5 What was deliberately **not** built (summary; reasons in §2.2 and §5)
Background Sync; Workbox; offline search; queued edits/deletes; auto-coalescing of identical adds; client photo re-encode; capture-time as `added_at`; SW-owned outbox; precaching `index.html`; Web Locks; per-user push preferences beyond subscribe/unsubscribe; CRDTs; periodic sync; a native shell.

---

## 5. Decisions D1–D16

Each decision uses the same five parts. "Strongest argument against" is the best case I could make for the rejected path.

### D1 — Scope tiers and order

- **Decision.** Ship **Tier 0** (installable + offline shell + friendly offline state) first, then **Tier 2a** (offline scan capture, the main use case), then **Tier 1** (read-only cache of data already viewed), then the *optional* **Tier 2b** (offline collection/wishlist adds). Web push is a separate optional phase. **Offline card search is out of scope**: the searchable catalogue is the Postgres `cards` table (all synced languages, with JSON attacks/abilities, `models.py:45-140`); mirroring it to a phone is a separate sync product, and its size is not measured here (UNVERIFIED), so no promise is made. After P6, **P7 (scan) and P8 (read cache) are independent and may be swapped** at no cost.
- **Alternatives.** (1) Tier 0 only — safe but does not deliver G3. (2) Reads before writes (Tier 0 → 1 → 2) — lowest risk first and answers "do I already own this card?" earlier. (3) All tiers in one change — rejected, unsafe.
- **Why this one.** Scan capture is the smallest *safe* write surface: the server already has a persistent, restart-safe scan queue (`services/scan_queue.py`), so offline work only needs to deliver photos once; no existing server row is modified. Tier 1 adds an at-rest copy of private data plus route gating across many pages, which is more surface than one upload path.
- **Strongest argument against.** Reads-first is strictly safer (no user data at risk) and the most common in-shop question is a *read* ("do I own this?"). Tier 1 depends only on P5/P6, which ship before P7 anyway, so the order is purely risk appetite.
- **Risk and mitigation.** Reads first is a legitimate alternative (§12, Q2) and the swap is cheap; both phases touch disjoint files (§9.1.3).

### D2 — Where the outbox lives; what the service worker is for

- **Decision.** The outbox is **page-context code + IndexedDB**. The service worker only precaches hashed assets, caches the shell, serves an offline navigation fallback, keeps a bounded public-image cache and (optional phase) shows push notifications. It must **not** queue or replay writes, touch `/api` (except three public image prefixes), read tokens, cache authenticated data, call `clients.claim()`, auto-`skipWaiting()`, or use Background Sync. **Background Sync is not used at all.** Single-flight across tabs uses an **IndexedDB lease row** plus a per-item compare-and-set claim, not Web Locks.
- **Alternatives.** (1) SW-owned outbox with Background Sync (Workbox `BackgroundSyncPlugin`). (2) `localStorage` queue. (3) Hybrid: page outbox + SW Background Sync where available.
- **Why this one.** Safari/iOS has no Background Sync (VERIFIED), service workers do not exist on plain-HTTP LAN installs (VERIFIED), a SW may be terminated at any time (spec; Safari timing UNVERIFIED), and Web Locks is secure-context-only (VERIFIED) while IndexedDB has no documented restriction. One mechanism (IndexedDB) works in every context and is unit-testable in Node with `fake-indexeddb`. Item-level compare-and-set makes the global lease an efficiency measure, not a correctness requirement: even if two tabs replay at once, the same idempotency key makes a double send harmless.
- **Strongest argument against.** Replay only runs while the page is open: items captured offline wait until the user opens the app again. On Android/Chrome a hybrid would sync in the background for free, and Web Locks has cleaner crash semantics than a 30 s lease.
- **Risk and mitigation.** Forgotten items → pending badge on Home and the floating indicator; items are never auto-deleted. The outbox API is SW-independent so a Chrome-only background trigger could call it later (not built). Lease expiry after a tab kill delays takeover by ≤ 30 s; harmless because claims are per item.

### D3 — Which operations are queueable

- **Decision.** Whitelist of **three** append/commutative operations; everything else stays online-only.

| Operation (route) | Queueable? | Reason | If replay fails |
|---|---|---|---|
| Scan photo upload (`POST /api/cards/recognize/jobs`) | **Yes (P7)** | Append-only; creates a new server job; server queue handles the rest | 400 (provider key/capability missing, bad file) → `failed` with server message, user fixes Settings then **Retry**; 413 → `failed` ("photo too large"); network/5xx → retry; 401 → `blocked` |
| Add to collection (`POST /api/collection/`) | **Yes (P9, optional)** | `quantity +=` is commutative; idempotency makes it exactly-once | 404 card unavailable / 409 shared template / 422 → `failed` with message; wishlist-like caps n/a |
| Add to wishlist (`POST /api/wishlist/`) | **Yes (P9, optional)** | `quantity +=` commutative | 400 "cannot exceed 99" (`wishlist.py:22`) → `failed`; 404 → `failed` |
| Collection quantity edit (`PUT /collection/{id}`) | No | Absolute set = lost update vs another device; 409 when product-linked/allocated (`collection.py:919-944`); a language change calls TCGdex (`:895-902`) | n/a† |
| Collection delete (`DELETE /collection/{id}`) | No | Destructive; 409 on product links/allocation (`:1011-1023`) | n/a† |
| `bulk-add`, `import-csv` | No | `bulk-add` commits per item (`:630-645`) so no single idempotent unit; CSV needs all-or-nothing validation + live TCGdex lookups (`:690-752`). Offline multi-add = N single-add items | n/a† |
| Scan review: resolve / resolve-and-add / retry / dismiss / delete job | No | Depend on live server job state | n/a† |
| Binder/deck allocation, conversions, optimise prints | No | Shared capacity pool and row locks (`services/binder_allocations.py`) | n/a† |
| Trades, products, ledger | No | Inventory side effects and valuation snapshots | n/a† |
| Custom-card CRUD, owner photo upload/delete, printing-detail tag CRUD | No | Server-assigned ids needed by later steps; tag names already travel *inside* add payloads and are created by the server | n/a† |
| Settings (language, currency, Telegram, scanner keys) | No | Secrets and cross-feature effects | n/a† |
| Admin actions (users, sync, backup/restore, auth mode) | No | Privileged and destructive | n/a† |
| Password change / force-password | No | Security-sensitive | n/a† |

† Not queued, so there is no replay: while unreachable the control is disabled with "Needs a connection" (P6/P9); while online a failure shows today's error toast, unchanged.

- **Alternatives.** (1) Queue everything with last-write-wins. (2) Queue edits with optimistic-concurrency tokens (`expected_quantity` / `expected_updated_at`). (3) Queue only scan uploads.
- **Why this one.** Append/commutative operations need no conflict resolution and fail in ways the user can understand; edits/deletes would need server preconditions that do not exist today.
- **Strongest argument against.** Quantity edit and delete are natural candidates; "I sold two copies at the show" is a natural offline action. Telling them "online only" is a real feature gap.
- **Risk and mitigation.** Disabled controls explain themselves ("Needs a connection") instead of failing silently when unreachable (P6). A conditional-update contract (`PUT` with `expected_quantity`) is documented as future work, deliberately not built. Edits/deletes of **pending** items are local outbox mutations (§6.2.5), so S13 needs no server call.

### D4 — Idempotency (server contract)

- **Decision.** `Idempotency-Key` on exactly three routes, a new `idempotency_keys` table, the key recorded **in the same DB transaction** as the business write, **only successful (2xx) results stored**, non-blocking in-flight detection. Full contract in §6.1. Applies **only to the queued routes** (opt-in), not to all POSTs; absent header ⇒ behaviour byte-identical to today. `bulk-add`/`import-csv` are not covered (they ignore the header; the outbox never sends them).
- **Alternatives.** (1) A `client_op_id` unique column on `collection`/`wishlist`/`scan_jobs` — breaks for merges: many operations increment one row (`collection.py:353`). (2) Middleware that dedupes every POST — wrong blast radius (login, restore, large bodies) and cannot share the business transaction. (3) Make adds *conditional* ("set quantity to N") — changes semantics for existing clients.
- **Why this one.** A side table is generic, touches no business table, and its row commits atomically with the write, so a crash can never leave a write without a key (or a key without a write). Storing only successes removes stale-error replays and the need to rotate keys after a failed attempt.
- **Strongest argument against.** It adds a table, a TTL job and a wrapper in three hot routes, duplicates response data for 14 days, and relies on a Postgres-specific advisory lock for early duplicate detection. Per-table `client_op_id` would be simpler if adds did not merge.
- **Risk and mitigation.** (a) Restoring an older backup leaves stale keys → the restore endpoint deletes all keys after success (a silent loss is worse than a visible duplicate). (b) Mid-request commits inside `ensure_card_exists` release the xact lock → the unique constraint is the final safety net; the loser rolls back and gets `409 idempotency_in_progress`. (c) Blocking waits inside `async` handlers would deadlock the event loop (F10) → `pg_try_advisory_xact_lock`, never a blocking wait. (d) Table growth → hourly cleanup job.

### D5 — Outbox data model and state machine

- **Decision.** IndexedDB database `pokecollector-outbox` v1 with stores `items`, `photos`, `meta`, `history`; photos live in their own store as `ArrayBuffer`s; one transaction per enqueue; five live states (`pending`, `sending`, `retry_wait`, `blocked`, `failed`) plus two terminal outcomes (`sent`, `cancelled`) with an explicit transition table, per-item compare-and-set claims, stale-claim recovery, no cross-item dependencies, no auto-coalescing. Exact schema, JSON shape, transitions, ordering and migration rules: §6.2.
- **Alternatives.** (1) One JSON blob per queue in `localStorage` (5 MB cap, synchronous, no binary). (2) Photos embedded in item records (every list read would load megabytes). (3) SQLite-wasm (new dependency, OPFS support on iOS unverified).
- **Why this one.** IndexedDB is the only boring, universally available binary store; a separate `photos` store keeps list reads cheap; a single transaction gives all-or-nothing writes under quota errors.
- **Strongest argument against.** IndexedDB on Safari has a history of bugs (X2) and a schema-migration burden that `localStorage` does not.
- **Risk and mitigation.** Strict module boundary; `ArrayBuffer`-only storage (asserted in tests); versioned schema with ordered migrations and `versionchange` handling; corrupted records are surfaced as `failed (corrupted)` with Discard only, never auto-deleted.

### D6 — Replay engine

- **Decision.** Sequential (concurrency 1), `PACE_MS = 2000`, triggered by app start, `visibilitychange`→visible, `pageshow`, `online`, manual **Sync now**, and a 15 s (±20 %) timer while visible with a non-empty queue. A **reachability probe** (`GET /api/health`, 5 s timeout, must return JSON `{"status":"ok","service":"pokemon-tcg-collection"}`) gates every session; `navigator.onLine` is only a hint. Exponential backoff with full jitter (base 5 s, cap 15 min); `Retry-After` honoured, else 60 s; per-attempt timeouts; exhaustive HTTP classification (§6.2.7). Replay uses raw `fetch` with `redirect:'manual'`, **not** axios. **Battery/cellular:** Safari/iOS has no Network Information API (`navigator.connection`, `saveData` — VERIFIED, MDN browser-compat-data `api/NetworkInformation.json`: Safari and iOS "No"), so a Wi-Fi-only mode cannot be detected. Instead: timers run only while the page is visible (no background wake-ups), uploads are sequential and paced, the sheet shows the **total size of waiting photos** and offers an **Automatic sync** toggle plus **Sync now**, so the user decides about cellular use.
- **Alternatives.** (1) Trust `navigator.onLine` + `online` event. (2) Concurrency 3 to drain faster. (3) Let the SW drive replay.
- **Why this one.** Self-hosters are usually "device online, server unreachable" (VPN off, away from Wi-Fi), exactly the case `onLine` gets wrong (VERIFIED). On `main` the whole instance shares one 60 req/min bucket (R6), so 30 req/min is the safe ceiling; `create_scan_job` does CPU-heavy work on the event loop (F10), so parallel uploads would starve the UI. Raw `fetch` avoids the axios 401 interceptor that deletes the token and navigates away (`client.js:29-34`) and lets us detect proxy redirects/HTML.
- **Strongest argument against.** 100 items take ≈ 3.5 min of pure pacing (more with photos), and the probe adds a request per cycle; concurrency would be faster on a good link.
- **Risk and mitigation.** `PACE_MS` is a constant in one file; progress is visible in the sync sheet; a 429 (body `{"error":...}`, no `Retry-After` on `main`, X13) pauses the whole engine; classification bugs are the main risk → table-driven `classify.js` with a unit test per row.

### D7 — Auth interplay

- **Decision.** Items are bound to `userId` + `serverOrigin` and replayed only when `auth.user.id` and `location.origin` match. The replay sends `Authorization` (read at send time) plus `X-Expected-User-Id`; the server answers `409 wrong_account` on mismatch (defence in depth for the two-tabs/token-swap case). **401 ⇒ `blocked(auth)`**: queue kept, token untouched by replay, resume after the same user signs in. **Logout with pending items** shows *Sync first / Log out and keep items / Log out and delete items / Cancel*. Single-user mode binds items to the admin id from `/auth/me`. A 200 `text/html`, an opaque redirect, or a non-JSON 403 ⇒ `blocked(proxy)` (reverse-proxy SSO). No auto-purge of other accounts' items.
- **Alternatives.** (1) Purge the queue on logout (data loss). (2) Store the token inside items (credential at rest). (3) Let the SW attach auth (SW must not hold secrets).
- **Why this one.** Dropping a user's captured photos because a token expired is the worst outcome; binding items to an identity and a guard header makes cross-account replay impossible even if client state is stale.
- **Strongest argument against.** "Keep" leaves private photos on a shared device after logout, readable by someone with developer tools; and the four-way dialog adds friction.
- **Risk and mitigation.** Explicit choice at logout; **Reset offline app data** clears caches but never the outbox, while "Log out and delete items" purges the current user's items; other users' items are shown only as a count; docs tell users of a shared device to choose "delete". Server-side session revocation, should it be added, ends in the same 401 path.

### D8 — Cache strategy

- **Decision.** (Full table §6.3.2.) The SW **never caches `/api` authenticated responses**. Allowed: precache of hashed `/assets/**` and a fixed list of static files (cache-first); shell `'/shell'` (network-first, 2.5 s timeout); public images under `/api/images/card/`, `/api/images/set/`, `/api/pokedex/images/` (cache-first, FIFO cap 800). Never cached: `/api/public/*`, owner photos, scan photos/candidate images, product images, cross-origin requests (fonts, TCGdex CDN), anything with `Cache-Control: no-store|private`, any `Vary: Authorization`, any request carrying `Authorization`, non-200, redirected, non-`basic` responses. Authenticated read data lives in the **app-level read cache** (P8) in IndexedDB keyed by `origin|userId`, purged on logout. **Fonts:** Google Fonts (`index.html:15-17`) are cross-origin and deliberately **not** cached by the worker (opaque responses may be padded in quota accounting by some browsers — **U**); offline the page falls back to `system-ui` (`index.css:117`); self-hosting Inter is decision Q5. **TTL/size caps:** precache and shell are replaced per build (no TTL needed); images use a 800-entry FIFO cap and no TTL because their URLs are per card/size; the read cache has a 30-day max age and 20 MiB cap (P8).
- **Alternatives.** (1) Workbox default recipe (precache `index.html`, SWR on `/api` GETs). (2) SW cache of authenticated `/api` keyed per user. (3) Rely on HTTP caching only.
- **Why this one.** Cache API matching keys on URL (+`Vary`), not on the `Authorization` header, so a cached `/api/collection/` could be served to the next user; per-user keying inside the SW would need the token in the SW. An app-level cache knows the user and can be purged at logout. SW caches then contain **no user data**, so logout has nothing to purge there.
- **Strongest argument against.** App-level persistence reimplements what a SW cache gives for free and costs a persister module (P8); public images are unauthenticated *today*, but if images later become authenticated the SW cache would leak across users.
- **Risk and mitigation.** The image rules are defensive (reject `Vary: Authorization`, `private`, `no-store`, `Authorization`-bearing requests) so a future change fails closed; budget test fails the build if the precache exceeds 12 MiB.

### D9 — Service-worker lifecycle, releases, tooling, `PUBLIC_MODE`, nginx

- **Decision.**
  1. **Tooling: hand-written classic service worker, no Workbox, no `vite-plugin-pwa`.** `frontend/src/sw/sw.js` has no imports; `frontend/scripts/build-sw.mjs` runs after `vite build`, replaces two placeholders (`__BUILD_ID__`, `/*__PRECACHE__*/[]`), and writes `dist/sw.real.js`, `dist/sw.kill.js` and `dist/sw.js` (copy of real). Testable without a bundler through a `node:vm` harness plus Playwright (Chromium).
  2. **Registration** after `window.load` + idle (≤3 s), only when `flags.sw`, `window.isSecureContext`, `'serviceWorker' in navigator` and `import.meta.env.PROD`; `register('/sw.js', {scope:'/', updateViaCache:'none'})`.
  3. **Update detection:** the browser's own check on navigation plus `registration.update()` on every `visibilitychange→visible`, throttled to once per 30 min (installed iOS apps rarely navigate).
  4. **No `skipWaiting`, no `clients.claim()`.** A new SW installs, then **waits**; the page shows "A new version is available". *Update* sends `SKIP_WAITING` and reloads once on `controllerchange` (guarded by `sessionStorage['pc.reloaded']`). *Update* is disabled while a scan batch is staged or an outbox item is `sending`. The outbox lives in IndexedDB, so a reload never loses queue state.
  5. **Navigation fallback** applies only to `navigate` requests whose path is not `/api/*`, not `/assets/*` and has no file extension; everything else passes to the network untouched.
  6. **Old caches** (`pc-precache-*`, `pc-shell-*` other than the current build) are deleted in `activate`. Unchanged `/assets/` entries are *reused* from the previous cache at install (content-hashed names), so an update downloads only changed chunks.
  7. **Stale lazy-chunk 404 after a deploy:** an old tab keeps working because its (still active) SW holds the old precache; without a SW, a `vite:preloadError` listener shows the update banner / reloads once.
  8. **Frontend/backend skew:** `/api/health` gains `version`, `api_level` (=1) and `features` (`["idempotency-v1"]`). The probe stores them; if `features` lacks `idempotency-v1` (older backend) *new enqueues are refused* ("server must be updated") and existing items become `blocked(server_old)`; items carry `minApiLevel`.
  9. **Kill switch, three levels:** **L1** operator: `PWA_ENABLED=false` + restart the frontend container → entrypoint copies `sw.kill.js` over `sw.js` (the kill worker skips waiting, deletes every `pc-*` cache, unregisters itself, reloads its window clients) and writes `sw=0` into the flags meta so the page also unregisters/clears. **L2** user: open `/?pc_sw=off` — the SW fetch handler bypasses any request carrying `pc_sw`, and the page unregisters, clears `pc-*` caches, strips the parameter and reloads (works even if the cached shell is bad, as long as the network is up). **L3** in-app: *Offline center → Reset offline app data* (keeps the outbox).
  10. **`PUBLIC_MODE` (R7):** `index.html` and `robots.txt` are **never precached**. The shell is fetched at SW install with `cache:'reload'` (whatever nginx serves, including the entrypoint's SEO/robots edits) and stored under the single key `'/shell'`. It is refreshed after successful online navigations **only if** the response is 200, not redirected, `text/html`, contains `id="root"` **and every `/assets/*` URL it references is in this SW's precache manifest**. That last rule keeps shell and precache consistent (a newer shell with an older precache would white-screen offline). Crawlers never run service workers, so SEO output is unchanged.
  11. **nginx (F3):** exact/regex locations for `sw.js` family, `index.html`, `manifest.json` and `/` with `Cache-Control: no-cache`; a shared `security-headers` snippet is `include`d everywhere `add_header` is used (because `add_header` in a location replaces inherited ones). Exact config: §6.3.5. CSP needs **no change** (X6).
- **Alternatives.** (1) `vite-plugin-pwa@2.0.0` + Workbox `injectManifest`: MIT, supports Vite 8 (peer `^8.0.0`), but resolves to a **353-node graph** (1 self, 5 direct, 347 indirect, 91 of them `@babel/*`; deps.dev) with `workbox-build@7.4.1` bringing 37 direct deps — for a ~300-line worker. (2) Workbox *runtime* modules only + own build step: ~8 packages, but still needs custom navigation/shell logic (R7) so the saving is small. (3) Hand-written (chosen).
- **Why this one.** Zero new dependencies and licences (AGPL-3.0 compatibility is trivially preserved), full control over the R7 shell rule and the kill switch, small enough to review line by line, no dependency on how Vite 8/Rolldown treats library/worker builds (the worker is a plain classic script).
- **Strongest argument against.** Service-worker caching code is a notorious source of subtle bugs (missing `waitUntil`, cloned bodies, opaque/redirected responses, never-resolving promises); Workbox exists to avoid exactly that, and an implementer will find far more documentation for Workbox.
- **Risk and mitigation.** Logic is split into pure, unit-tested functions inside one file (loaded into a `node:vm` sandbox with fake `caches`/`fetch`); Chromium e2e covers install, offline reload, update, kill switch, escape hatch; the file has a hard review cap of 350 lines; default-off flag; three-level kill switch; no auto-activation. A bad release cannot trap users because the kill worker is served from the same URL and replaces it at the next update check (X5).

### D10 — Optimistic UI and wording

- **Decision.** **Overlay, not cache patching.** Pending items never enter TanStack caches. A floating **SyncIndicator** (mounted once in `Layout.jsx`, top-right below the safe area) shows offline / waiting count / syncing / needs-attention; tapping opens the **SyncSheet** (existing `Modal`) listing items with state, age and **Retry / Edit / Discard**, plus *Sync now*, *Automatic sync* toggle, storage status and "Last synced". An **OfflineBanner** (top of `Layout`) appears when the probe has failed twice or `navigator.onLine === false`. Totals/portfolio value **exclude** pending items and say so. Stale cached data is labelled "Showing saved data from <time>" (P8). P9 adds ghost rows labelled "queued" to Collection/Wishlist only. Toasts are coalesced (≤1 summary per 60 s). All strings (en + de) in §6.4.3.
- **Alternatives.** (1) Optimistic patching of every affected query (`invalidateCardState` touches ≥7 families, `utils/queryInvalidation.js:9-21`). (2) A full local database mirroring the server. (3) No optimistic UI (just a spinner).
- **Why this one.** One place shows *everything that is only on this device*; no fake rows to reconcile; correctness of totals is explicit.
- **Strongest argument against.** Users expect "I added it, so I see it": pages that do not render the overlay (Pokédex completion, set checklists, dashboard) will not reflect pending adds until sync, which can read as "it didn't work".
- **Risk and mitigation.** Persistent banner + indicator + the sentence "Items waiting here exist only on this device until they reach the server"; P9 is optional precisely because it needs these ghosts; pending scans are never shown as cards, only in the sheet.

### D11 — Scanner specifics

- **Decision.**
  - **What is stored:** the **original photo bytes** as `ArrayBuffer` + MIME type + name + size, plus `individualPositions`. **No client-side re-encode, no thumbnails in v1.** Backend facts relied on: only JPEG/PNG/WebP/HEIF/HEIC are accepted, animated images and > 50 megapixels are refused, EXIF orientation is applied and metadata stripped (`scan_storage.py:32,36,88-100`). Accepted types are exactly `isSupportedScannerImage` (`scannerImages.js:1-7`: JPEG/PNG/WebP/HEIC/HEIF). Safari 27 stops converting HEIC to JPEG for file inputs (X10); the server decodes HEIC via `pillow-heif` (`scan_storage.py:20-26`), so HEIC is stored and uploaded as is.
  - **Numbers (all justified by server limits):** photo ≤ **15 MiB** (server `MAX_FILE_BYTES`, `scan_storage.py:30`) — larger is refused at capture with "This photo is larger than 15 MB"; one outbox item ≤ **12 photos and ≤ 10 MiB** (the server allows 50 photos/200 MiB per job, `:29,:31`, but a 10 MiB body at the 40 KiB/s floor takes 256 s, under nginx's 300 s `proxy_read_timeout`, `nginx.conf:26-36`); total outbox photo bytes ≤ **300 MiB**; when `navigator.storage.estimate()` exists, refuse a new item if `quota − usage < bytes + 100 MiB`; ≤ **500** items.
  - **Quota UX:** item + photos are written in **one** IndexedDB transaction; on `QuotaExceededError` nothing is persisted for that chunk, staged files stay in memory, toast "Not enough storage to keep these items offline" (S11).
  - **Upload:** each photo becomes a **fresh in-memory `Blob`** (`new Blob([bytes],{type})`) in `FormData` (X2); items are small so a suspended/killed upload simply restarts with the same key (HTTP uploads cannot resume).
  - **Composition with the server queue:** the job is created at upload, so recognition attempts (`scan_queue.py:27`) and the 14-day retention (`scan_storage.py:35,226`) start at upload; offline time consumes neither. A staged batch of N photos becomes at least ⌈N/12⌉ items (greedy by order; a new item starts when adding the next photo would exceed 12 photos or 10 MiB), i.e. several server jobs; `individualPositions` are remapped per chunk; the UI navigates to `/scans` when more than one job results.
  - **Persist-then-send:** when the queue flag is on, *every* submit (online too) is persisted first, then sent at once; online UX (spinner → navigate) is unchanged; a mid-upload failure no longer loses the staged photos.
  - **Capture time:** **not sent, not honoured as `added_at`** (F12). The sheet shows "Captured <time>" from the local `createdAt`. A future `captured_at` field on `ScanJobItem` could prefill a user-editable acquisition date (not built).
- **Alternatives.** (1) Client downscale to 2048 px long edge at JPEG q0.9 (matches the server cap `scan_storage.py:33-34`) — shrinks storage ~5×. (2) Keep staging in memory only (today). (3) Upload the `File` directly (today; breaks under X2).
- **Why this one.** The server already re-encodes to ≤2048 px q90 and strips metadata (`scan_storage.py:80-126`), so a client re-encode only saves bytes; its correctness depends on EXIF-orientation, HEIC decode and canvas-memory behaviour that cannot be verified without a device matrix (U). Storing originals removes a whole class of "rotated/blank photo" failures.
- **Strongest argument against.** 50 originals at 3–5 MB each is 150–250 MB on a phone and 3–5× more upload time on weak cellular links than a downscaled copy.
- **Risk and mitigation.** Caps and the quota guard bound storage; chunking bounds each request; the doc lists client downscale as an explicit **later optimisation** to adopt only after a real-device matrix proves orientation/HEIC behaviour.

### D12 — Storage durability and honest wording

- **Decision.** (1) After the first enqueue and **on every app start while the queue is non-empty**, call `navigator.storage.persist()` (when available; heuristic, PF4c) and record the result. (2) Show `navigator.storage.estimate()` usage/quota in the sync sheet when available (Safari 17+). (3) **Canary:** a random id stored in the `meta` store *and* mirrored in `localStorage['pc.outbox.canary']`; at start, if the mirror exists but the IndexedDB canary is missing (or the DB is empty at version 1 while history shows prior use) → *eviction detected*: show a blocking notice with the **evicted** text (S6). (4) Warn when `!standalone` and the oldest item is ≥ 3 days old ("Safari can delete data of websites you haven't opened for about a week…"), strong warning at ≥ 7 days. (5) Always show: "Items waiting here exist only on this device until they reach the server. The server copy is the only durable copy."
- **Alternatives.** (1) Silence (no warnings). (2) Rely on `persist()` alone. (3) Server-side mirror of pending metadata.
- **Why this one.** The 7-day cap applies to Safari tabs (V); Home Screen apps are exempt by policy but anecdotal reports exist (U). Honest copy plus a canary is the cheapest defence that does not pretend durability.
- **Strongest argument against.** If localStorage and IndexedDB are wiped together the canary cannot fire; users may ignore warnings; warnings add friction for people who will sync within minutes.
- **Risk and mitigation.** Total wipes are undetectable by design — hence the wording and the 3-day nudge; warnings show only when items exist; evidence for exemption is policy-level (V) with anecdotal exceptions (U), so no claim of safety is made.

### D13 — Installability and iOS polish

- **Decision.** Manifest (file stays `/manifest.json`):

```json
{
  "id": "/",
  "name": "PokéCollector",
  "short_name": "PokéCollector",
  "description": "A free, self-hosted Pokemon TCG collection manager. Track cards, monitor prices, manage binders, and analyse your portfolio.",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#08080f",
  "theme_color": "#08080f",
  "icons": [
    { "src": "/icons/pc-icon-192-v3.png",      "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/pc-icon-512-v3.png",      "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/pc-maskable-192-v3.png",  "sizes": "192x192", "type": "image/png", "purpose": "maskable" },
    { "src": "/icons/pc-maskable-512-v3.png",  "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

  `id` is supported on iOS 16.4+ (V). `screenshots` are **not** added (they only enrich Android/desktop install dialogs; nothing on iOS depends on them). `theme_color` changes from brand red to `#08080f` (= `--color-bg`, `index.css:28`) so the status/task area blends with the dark UI; iOS 26 may ignore it anyway (X8, U). **Icons:** new files under `/icons/` with version suffix **in the filename** (nginx makes `.png` `immutable` for a year, `nginx.conf:86-89`, which is why `?v=2` existed; the query strings are removed, old files stay for old cached HTML, `og:image` and the SSO allow-list). `apple-touch-icon` becomes **opaque** (no alpha) `#08080f` background, 180×180; maskable icons keep the Poké Ball diameter ≤ 70 % of the canvas (inside the 80 % safe circle); `purpose:"any"` icons may stay transparent. Generation recipe in P2. **iOS meta tags** added to `index.html`: `apple-mobile-web-app-capable=yes`, `mobile-web-app-capable=yes`, `apple-mobile-web-app-title=PokéCollector`, `apple-mobile-web-app-status-bar-style=black` (opaque, content below the bar; `black-translucent` is reported broken on iOS 26.1, U). **Safe areas:** `AppNav.jsx:118` home button uses `max(1.5rem, env(safe-area-inset-bottom))`/`max(1rem, env(safe-area-inset-left))` like `PublicHomeButton.jsx:15-16`; the top strip (`:84`) uses `max(1.25rem, env(safe-area-inset-top))`. **Standalone detection:** `navigator.standalone === true || matchMedia('(display-mode: standalone)').matches`. **Install hint** (iOS has no prompt, V): a dismissible card shown only when `navigator.standalone === false` (the property exists only on iOS WebKit, so this is feature detection) on Home and always in the Offline center: "Tap the Share button, then choose Add to Home Screen." **External links:** unchanged `target="_blank" rel="noreferrer"` (X7, U, manual M-12). **Back navigation:** every page keeps the floating Home button; manual M-13. **Camera permission:** `<input capture>` needs no web permission; the live viewfinder (a possible future capture path) uses `getUserMedia` (V in standalone since iOS 13.4), repeated prompts U (M-04). **Sub-path deployments:** unsupported (F4).
- **Alternatives.** (1) Leave `?v=2` URLs. (2) Keep brand-red `theme_color`. (3) `black-translucent` + full-bleed header with safe-area padding.
- **Why this one.** Versioned filenames are the only cache-busting that survives `immutable`; opaque icons avoid platform-dependent transparency rendering (U); `black` preserves today's layout with no new inset arithmetic.
- **Strongest argument against.** A full-bleed `black-translucent` look is the "native" iOS aesthetic, and `theme_color` red is the brand colour.
- **Risk and mitigation.** Status-bar behaviour on iOS 26/27 is unverified (X8): keep `html` background = app background and verify on device (M-02); both choices are one-line reverts.

### D14 — Plain-HTTP and non-secure installs

- **Decision.** Capabilities are detected by **feature detection** in `offline/capabilities.js` and shown on the Offline center. Behaviour matrix:

| Capability | HTTPS | Plain HTTP LAN | Lockdown Mode / no SW |
|---|---|---|---|
| Manifest / Add to Home Screen | yes | yes (iOS accepts any page; standalone on HTTP **U**, M-11) | yes |
| Service worker (offline app start) | yes | **no** (VERIFIED secure-context only) | no (V, X9) |
| Outbox (IndexedDB) while the page is open | yes | yes (**U** on device, M-11) | yes |
| Cold start offline | yes (after one online visit) | **no** (nothing is cached) | no |
| `navigator.storage` persist/estimate | yes | no (secure-only) → skipped, UI says "unavailable" | yes |
| `crypto.randomUUID` | not used | not used (`getRandomValues` UUID) | — |
| Live camera `getUserMedia` | yes | no → falls back to `<input capture>` (their code path) | yes |
| Web push | yes (installed) | no | no |

  UI: `pwa.httpsHint` ("Offline app start and push notifications need HTTPS. Offline saving still works while the app is open."); no nagging banner. **Confirmation:** with no SW available the registration code is a no-op and Tier 0 changes nothing at runtime — the app behaves exactly as today. (With `OFFLINE_QUEUE_ENABLED` on, the outbox is deliberately independent of the SW and still works on HTTP.)
- **Alternatives.** (1) Hide all offline UI on HTTP. (2) Require HTTPS for the outbox as well. (3) Ship a self-signed-cert tutorial.
- **Why this one.** Most self-hosters are on HTTP; the outbox needs only IndexedDB, so they still get safe capture while the app is open.
- **Strongest argument against.** Offering offline capture that cannot survive a cold start offline may mislead; and HTTP IndexedDB behaviour on iOS is unverified.
- **Risk and mitigation.** Honest copy; M-11 verifies; the outbox disables itself cleanly if IndexedDB throws. `docs/PWA.md` explains HTTPS options (reverse proxy with a real certificate, Tailscale HTTPS) and warns that a self-signed certificate that iOS does not trust will not enable service workers (**U**, test).

### D15 — Web push (optional, separable: P10)

- **Decision.** Web push for the existing wishlist price alerts, hooked next to Telegram. **VAPID** EC P-256 key pair generated once and persisted at `/app/data/auth/vapid_private.pem` (volume `./data/auth` already mounted, `docker-compose.yml`; same pattern as the JWT secret file, `services/auth.py:19-97`) with env overrides `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (default `https://github.com/Git-Romer/pokecollector`; Apple requires a URL or `mailto:` — V). **Table `push_subscriptions`:** `id`, `user_id` (FK users, `ON DELETE CASCADE`), `endpoint` (TEXT, UNIQUE), `p256dh`, `auth`, `user_agent` (≤255), `created_at`, `last_seen_at`, `last_success_at`, `failure_count`. **Endpoints:** `GET /api/push/vapid-public-key`, `POST /api/push/subscribe`, `DELETE /api/push/subscribe`, `POST /api/push/test` (all authenticated). **Hook:** in `sync_service.check_wishlist_alerts` right after `telegram.send_price_alert` (`:626-628`): `push.send_price_alert(db, item.user_id, card.name, current_price, threshold, alert_type)`. **Payload (≤ 4 KB, V):** Declarative Web Push JSON `{"web_push":8030,"notification":{"title":"PokéCollector","body":"<card name> price alert","navigate":"/wishlist"}}` — no collection or price history; encrypted end to end by `aes128gcm`. A SW `push` handler (same JSON) covers browsers without Declarative Web Push and **always shows a notification** (Apple revokes permission on invisible pushes, V). **Failure handling:** 404/410 → delete subscription (410 V); 403 → log, keep; 429 → skip this cycle; `failure_count` ≥ 10 → delete. **UX:** Settings → Notifications → *Enable on this device* (user gesture → `Notification.requestPermission()` → `pushManager.subscribe({userVisibleOnly:true, applicationServerKey})` → POST); hidden unless `isSecureContext && 'PushManager' in window`; on iOS the control appears only in the installed app (feature-detected). Multiple devices per user supported (one row each). **Library:** `pywebpush==2.5.0` (released 2026-08-29; MPL-2.0; requires `aiohttp`, `cryptography>=47`, `http-ece`, `requests`, `py-vapid`; Python ≥ 3.10 — V from PyPI). MPL-2.0 lists AGPL-3.0 as a *Secondary License*, so an unmodified dependency is compatible (stated from the licence text; not re-fetched, minor **U**). **Without HTTPS:** push UI hidden; backend still starts and simply has no subscriptions.
- **Alternatives.** (1) Hand-rolled RFC 8291/8292 on `cryptography` + `httpx` (no MPL dependency, but own crypto). (2) Telegram only (today). (3) A relay service (new infrastructure, privacy cost).
- **Why this one.** `pywebpush` is the reference Python implementation; the extra dependencies are one-time; MPL file-level copyleft does not extend to this project's files.
- **Strongest argument against.** Five new runtime dependencies for an optional feature, `requests` alongside the existing `httpx`, and Apple's rule against hourly JWT refresh means one more thing to get right.
- **Risk and mitigation.** The server POSTs to a client-supplied endpoint, which is an SSRF vector → subscriptions are accepted only for an allow-list of push-service hosts (§6.7.1). Optional phase, separate migration PR; alerts rate is low so JWT refresh is irrelevant in practice; `cryptography>=47` may conflict with other pins → implementer checks `pip` resolution in Phase 10 and falls back to alternative (1) only if resolution fails (documented stop condition, not a design choice).

### D16 — Rollout

- **Decision.** Two **frontend-container** env vars, applied at start by `45-configure-pwa.sh` and surfaced to the app through `<meta name="pokecollector-pwa" content="sw=1;queue=1">`: `PWA_ENABLED` (service worker, update banner, install polish that depends on it) and `OFFLINE_QUEUE_ENABLED` (outbox, sync UI, offline scan). **Defaults `false`**, so nothing changes for existing installs; a later change (P11, not part of this change) may flip both defaults to `true` (script default, `docker-compose.yml`, `.env.example`, docs) once the real-iPhone checklist (§10.3) has passed. Build-time default for preview/tests: `VITE_PWA_DEFAULT=on`. **Docs:** README (feature bullets, env table, HTTPS note), `docs/FRONTEND.md`, `docs/DEPLOYMENT.md`, `docs/BACKEND.md`, `docs/ARCHITECTURE.md`, `docs/REVERSE_PROXY_AUTH.md`, new `docs/PWA.md` (install on iPhone, HTTPS options, flags, kill switch, privacy, troubleshooting). **Per-PR checklist** (from `CONTRIBUTING.md:5-43` and the PR template): focused PR; tests; run `npm test` + `npm run build` (frontend) or `python -m unittest discover -s tests -p 'test_*.py'` (backend); `node scripts/check-version.mjs` and both `docker compose … config --quiet` when versions/compose change; docs updated; screenshots for visual work; PR body follows the template (What and why / Validation / Card UI n/a). **Rollback:** `PWA_ENABLED=false` + `docker compose up -d frontend` (kill worker replaces the SW); `OFFLINE_QUEUE_ENABLED=false` (outbox stops; **data is kept**, so turn it on briefly to sync before disabling); or pin `POKECOLLECTOR_VERSION` to the previous release; the `idempotency_keys` table is additive and harmless to older backends.
- **Alternatives.** (1) Default on immediately. (2) A per-user setting. (3) Build-time flag only.
- **Why this one.** Each phase is a release (F2), so default-off keeps `latest` safe for every self-hoster; maintainers can try it before it is enabled for everyone. Runtime env vars match the existing `PUBLIC_MODE` pattern and need no rebuild.
- **Strongest argument against.** Opt-in features are rarely turned on, so real-world coverage is thin; two flags are more to document than one.
- **Risk and mitigation.** Flipping the defaults (P11) would be a small dedicated PR once §10.3 passes; separate flags exist because a service-worker fault and an outbox fault need different kill levers (the outbox kill must never delete data).

---

## 6. Detailed specifications

### 6.1 Server: idempotency contract (Phase 1)

#### 6.1.1 Contract

| Item | Specification |
|---|---|
| Request header `Idempotency-Key` | One value. Optional surrounding double quotes are stripped (draft-07 uses a Structured-Field String; the client sends it unquoted). After stripping it must match `^[A-Za-z0-9_-]{16,64}$` (a UUIDv4 is 36 chars). Honoured **only** by `POST /api/collection/` (scope `collection.add`), `POST /api/wishlist/` (`wishlist.add`), `POST /api/cards/recognize/jobs` (`scan.enqueue`). Any other route ignores it. |
| Request header `X-Expected-User-Id` | Optional integer. If present on one of the three routes and ≠ authenticated user id → `409 wrong_account`. Checked even when `Idempotency-Key` is absent. |
| Response header `Idempotent-Replayed: true` | Set on every replayed response. |
| No header | Behaviour is **identical to today** (no table access, same status codes/bodies). |
| Scope of dedupe | `(user_id, key)`; a key reused with a different `scope` or request fingerprint is a conflict. |
| Retention | `KEY_TTL = 14 days` from creation. An expired row is treated as absent (deleted and re-created). |
| Stored | Only **successful** results: status 2xx and the exact JSON body. Failures roll back with the transaction ⇒ no row ⇒ a retry re-executes. |

Error responses use `detail` objects so the client can branch on `code` (the existing `getApiErrorMessage` already formats object details, `client.js:71-90`):

| HTTP | `detail.code` | When | Client action |
|---|---|---|---|
| 400 | `idempotency_key_invalid` | `Idempotency-Key` (or `X-Expected-User-Id`) present but malformed | `failed` (client bug) |
| 409 | `idempotency_in_progress` (+ `Retry-After: 2`) | Another request holds the key's advisory lock, or the insert lost a race | `retry_wait` ≈ 3 s, no penalty |
| 409 | `wrong_account` | `X-Expected-User-Id` ≠ token user | `blocked(wrong_account)` |
| 422 | `idempotency_key_reused` | Same key with different scope/payload fingerprint | `failed` (needs Edit, which rotates the key) |
| 2xx + `Idempotent-Replayed` | — | Replay | success |

FastAPI's own validation `422` keeps its array `detail`; the two are distinguishable by `detail.code`.

**Behaviour matrix (the five required cases plus failure):**

| Case | Behaviour |
|---|---|
| First call | Try-lock acquired, no row, business logic runs, `record()` stages the row, **one** commit, normal response |
| Exact replay (same user, key, scope, fingerprint) | Stored status + body returned verbatim with `Idempotent-Replayed: true`; no business code runs, no side effects |
| Concurrent duplicate while the first is still running | PostgreSQL: the try-lock fails → immediate `409 idempotency_in_progress` + `Retry-After: 2` (never waits). If an intermediate commit released the lock, the unique-constraint loser rolls back and returns the same 409; the client's retry then gets the replay |
| Same key, different body or scope | `422 idempotency_key_reused`; nothing written |
| Expired key (`expires_at <= now`) | Row deleted inside the transaction; the request is treated as a first call |
| Business failure (4xx/5xx/exception) | Transaction rolled back, no row; a retry re-executes |

#### 6.1.2 Table (model + DDL)

`backend/models.py` (add after `ScanQueueUserState`; alias like `POKEDEX_JSON`, `models.py:10`):

```python
IDEMPOTENCY_JSON = JSON(none_as_null=True).with_variant(JSONB(none_as_null=True), "postgresql")

class IdempotencyKey(Base):
    """A completed, replayable result for one (user, Idempotency-Key). Only 2xx results are stored."""
    __tablename__ = "idempotency_keys"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    key = Column(String(64), nullable=False)
    scope = Column(String(64), nullable=False)
    request_hash = Column(String(64), nullable=False)          # sha256 hex
    response_status = Column(Integer, nullable=False)
    response_body = Column(IDEMPOTENCY_JSON, nullable=False)
    created_at = Column(DateTime, nullable=False, default=func.now())
    expires_at = Column(DateTime, nullable=False, index=True)

    __table_args__ = (UniqueConstraint("user_id", "key", name="uq_idempotency_user_key"),)
```

`backend/database.py`: append these two statements as **two separate entries** at the **end** of the `migrations` list in `_run_migrations` (the list closes just before `for stmt in migrations:` at `:673`; the runner executes one statement per entry), following the model + raw-SQL convention used for `scan_jobs` (`:481-562`):

```sql
CREATE TABLE IF NOT EXISTS idempotency_keys (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key VARCHAR(64) NOT NULL,
    scope VARCHAR(64) NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    response_status INTEGER NOT NULL,
    response_body JSONB NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL,
    CONSTRAINT uq_idempotency_user_key UNIQUE (user_id, key)
);
CREATE INDEX IF NOT EXISTS ix_idempotency_keys_expires_at ON idempotency_keys(expires_at);
```

User deletion cascades at the DB level (`ON DELETE CASCADE`), consistent with scan rows (`docs/ARCHITECTURE.md:362-363`); no change to `delete_user`.

#### 6.1.3 `backend/services/idempotency.py` — API and algorithm

```python
IDEMPOTENCY_HEADER = "Idempotency-Key"
EXPECTED_USER_HEADER = "X-Expected-User-Id"
REPLAYED_HEADER = "Idempotent-Replayed"
KEY_TTL = datetime.timedelta(days=14)
SCOPE_COLLECTION_ADD, SCOPE_WISHLIST_ADD, SCOPE_SCAN_ENQUEUE = "collection.add", "wishlist.add", "scan.enqueue"

@dataclass(frozen=True)
class StoredResponse: status_code: int; body: Any

class IdempotencyContext:            # returned by begin_idempotent
    active: bool                     # True when a valid key was supplied
    replay: StoredResponse | None    # non-None => caller must return replay_response(replay) immediately
    def record(self, db, status_code: int, body: Any) -> None   # stage the completed row in the CURRENT transaction

def begin_idempotent(db, user, headers, *, scope, fingerprint) -> IdempotencyContext
def fingerprint_json(scope, payload) -> str          # sha256 of json.dumps({"scope":..,"payload":..}, sort_keys=True, separators=(",",":"))
async def digest_uploads(uploads) -> list[str]       # sha256 hex per file, read in 1 MiB chunks, then `await upload.seek(0)`
def fingerprint_scan(scope, positions, digests) -> str
def replay_response(stored) -> JSONResponse          # status=stored.status_code, content=stored.body, header Idempotent-Replayed: true
def purge_expired_idempotency_keys(db, now=None, batch_size=1000) -> int
```

`begin_idempotent`, in order:
1. If `X-Expected-User-Id` is present: non-integer → `400 idempotency_key_invalid`; integer ≠ `user.id` → `409 wrong_account`.
2. If `Idempotency-Key` is absent → return an **inactive** context (`active=False`, `replay=None`).
3. Strip one pair of double quotes; reject if the regex fails → `400 idempotency_key_invalid`.
4. **PostgreSQL only** (`_db_dialect_name(db) == "postgresql"`, precedent `sync_service.py:573,752-755`): `SELECT pg_try_advisory_xact_lock(hashtextextended(:k, 0))` with `k = f"idem:{user.id}:{key}"`. `false` → `409 idempotency_in_progress` with `Retry-After: 2`. **Never** take a blocking lock (F10: sync DB waits inside `async def` handlers would freeze the event loop).
5. `row = SELECT … WHERE user_id=:u AND key=:k`. If found: expired (`expires_at <= utcnow()`) → delete + `flush`, continue as new; scope or `request_hash` differs → `422 idempotency_key_reused`; else return an active context with `replay=StoredResponse(row.response_status, row.response_body)`.
6. Return an active context whose `record()` closes over `(user.id, key, scope, fingerprint)`.

`record(db, status_code, body)`: assert `200 <= status_code < 300`; `db.add(IdempotencyKey(..., created_at=now, expires_at=now+KEY_TTL))`; `db.flush()`. On `IntegrityError` (another transaction won the race after an intermediate commit released the xact lock): `db.rollback()` (this also rolls back the business writes, which is the point) and raise `409 idempotency_in_progress`. It does **not** commit; the route commits once, so the key row and the business write are one transaction.

#### 6.1.4 Route integration (exact shape)

*`POST /api/collection/` (`collection.py:599-609`)* — add `request: Request`; the legacy path stays literally as is when the context is inactive:

```python
idem = begin_idempotent(db, current_user, request.headers, scope=SCOPE_COLLECTION_ADD,
                        fingerprint=fingerprint_json(SCOPE_COLLECTION_ADD, item.model_dump(mode="json")))
if idem.replay is not None:
    return replay_response(idem.replay)
_status, db_item = _upsert_collection_item(db, current_user, item)
if not idem.active:                                   # unchanged legacy behaviour
    db.commit(); db.refresh(db_item)
    return _annotate_collection_item(db, current_user, db_item)
db.flush()
body = jsonable_encoder(CollectionItemResponse.model_validate(_annotate_collection_item(db, current_user, db_item)))
idem.record(db, 200, body)
db.commit()
return body
```

(`CollectionItemResponse` has `from_attributes = True`, `schemas.py:215-216`.) `POST /api/wishlist/` (`wishlist.py:41-76`) is identical in shape with scope `wishlist.add` and `WishlistItemResponse`; replace its two `db.commit(); db.refresh(...)` blocks by the flush/record/commit sequence when active.

*`POST /api/cards/recognize/jobs` (`scan_jobs.py:106-167`)* — keep the current order for requests **without** a key. With a key: (a) validate `individual_positions` first (refactor the existing parse at `:130-140` into `_requested_individual_positions(raw, file_count)` used by both paths), (b) `digests = await digest_uploads(files)`, (c) `begin_idempotent(... fingerprint_scan(...))`, (d) replay returns **before** the provider/credential checks (`:121-129`) so a retry after success never fails because the user removed a key meanwhile, (e) then the existing provider checks, (f) `create_scan_job(..., before_commit=hook)`. `services/scan_storage.py:create_scan_job` gains an optional `before_commit: Callable[[ScanJob], None] | None = None`, called just before `db.commit()` (`:269`) after `db.flush()`; the hook does `body = jsonable_encoder(job_progress(db, job)); idem.record(db, 200, body)`. An exception from the hook is already covered by the existing `except Exception: db.rollback(); delete_job_directory(job.id); raise` (`:272-275`). Disk files written before a crash are removed by `purge_orphaned_scan_directories` after 60 min (`:179-200`).

#### 6.1.5 Cleanup job
`services/scheduler.py`: `run_idempotency_cleanup()` calls `purge_expired_idempotency_keys` (loop: `DELETE … WHERE id IN (SELECT id … WHERE expires_at <= now LIMIT 1000)` until 0) and logs the count when > 0; register in `start_scheduler` with `IntervalTrigger(hours=1)`, id `idempotency_key_cleanup_job`, `replace_existing=True`, `next_run_time=now_utc + 5 min` (pattern: `scheduler.py:212-221`; leave out its `misfire_grace_time`/`coalesce` arguments, which upstream added for the scan-queue job only).

#### 6.1.6 Migration, backup, restore
- Shipping: additive table via `create_all` + the two raw statements; the automatic pre-upgrade `pg_dump` runs first (`main.py:62-63`); older backends ignore the table; rollback = pin the previous image, optionally `DROP TABLE idempotency_keys`.
- Not added to `BACKUP_GROUPS` (`backup.py:21-43`; operational state). **Included in full dumps** (no `-t`).
- `restore_backup` (`backup.py:126-193`): after a successful `psql`, best-effort `DELETE FROM idempotency_keys` (own short transaction, errors logged and ignored). Reason: restoring an older dump leaves newer keys whose business rows no longer exist; replaying such a key would silently drop the add. A visible duplicate is the safer failure. `docs/DEPLOYMENT.md` gets the same sentence for manual `psql` restores.

#### 6.1.7 Health info and CORS (`main.py`)
- `GET /api/health` (`:208-210`) returns `{"status":"ok","service":"pokemon-tcg-collection","version": read_app_version(),"api_level": 1,"features": ["idempotency-v1"]}`; constants in new `services/api_info.py` (`API_LEVEL = 1`, `API_FEATURES = ("idempotency-v1",)`). Existing consumers only check the status code (`docs/DEPLOYMENT.md:87`).
- CORS `allow_headers` (`:121`) gains `"Idempotency-Key"` and `"X-Expected-User-Id"` (needed only for a separately hosted front end; harmless otherwise).

#### 6.1.8 Backend tests (`unittest`, repo convention)
`backend/tests/test_idempotency.py` (SQLite in-memory, call route functions directly as `test_wishlist_api.py` does): first call stores one row; replay returns the same status/body without incrementing; different payload → 422; different user, same key → independent; expired key → treated as new; invalid key → 400; absent key → no row and legacy path; `X-Expected-User-Id` mismatch → 409; `record()` `IntegrityError` → rollback + 409; scan route with fake `UploadFile`s (replay creates no second job; hash covers file bytes); cleanup deletes only expired rows; health payload shape. `backend/tests/test_idempotency_postgres.py` gated by `IDEMPOTENCY_POSTGRES_TEST=1` and a `postgresql` `DATABASE_URL` (pattern `test_scan_queue_postgres.py:29-35`): two threads, same key → one effect, other gets replay or 409; advisory-lock path; FK cascade on user delete.

---

### 6.2 Client: outbox (Phases 4–7, 9)

#### 6.2.1 Constants (`frontend/src/offline/constants.js`)

| Name | Value | Why |
|---|---|---|
| `OUTBOX_DB_NAME` / `OUTBOX_DB_VERSION` | `pokecollector-outbox` / `1` | — |
| `PROBE_TIMEOUT_MS` | 5000 | bounds half-open connections |
| `PROBE_BACKOFF_MS` | `[15000, 30000, 60000, 120000]` | ≤ 4 probes/min against the shared 60/min bucket |
| `REPLAY_TICK_MS` | 15000 (±20 % jitter) | re-evaluate retry times while visible |
| `PACE_MS` | 2000 | ≤ 30 req/min, leaves headroom under 60/min (R6) |
| `JSON_TIMEOUT_MS` | 20000 | add/wishlist requests |
| upload timeout | `clamp(30000 + bytes / 40960 * 1000, 60000, 290000)` | 40 KiB/s floor; < nginx `proxy_read_timeout 300s` (`nginx.conf:26-36`) |
| `CLAIM_GRACE_MS` | 15000 | added to the attempt timeout for the claim expiry |
| `BACKOFF_BASE_MS` / `BACKOFF_CAP_MS` | 5000 / 900000 | full jitter: `random(0, min(cap, base·2^(n−1)))` |
| `MAX_SERVER_ERRORS_PER_ITEM` | 12 | HTTP 500-class (not 502/503/504, not network) then `failed` |
| `RATE_LIMIT_DEFAULT_PAUSE_MS` | 60000 | slowapi window; `Retry-After` clamp [5 s, 900 s]; doubles on consecutive 429s up to 900 s |
| `LEASE_TTL_MS` / `LEASE_HEARTBEAT_MS` | 30000 / 10000 | single-flight |
| `STALE_UNKNOWN_OUTCOME_MS` | 12 days | server key TTL is 14 days (margin 2) |
| `HISTORY_MAX` / `HISTORY_MAX_AGE_MS` | 100 / 14 days | "recently synced" list |
| `OUTBOX_MAX_BYTES` / `OUTBOX_MIN_FREE_BYTES` / `OUTBOX_MAX_ITEMS` | 300 MiB / 100 MiB / 500 | D11 |
| `MAX_PHOTO_BYTES` / `MAX_PHOTOS_PER_ITEM` / `TARGET_ITEM_BYTES` | 15 MiB / 12 / 10 MiB | D11 |
| `OLD_ITEM_WARN_MS` / `OLD_ITEM_STRONG_WARN_MS` | 3 days / 7 days | D12 |
| `FOREGROUND_UPDATE_CHECK_MS` | 1 800 000 | SW update throttle |

#### 6.2.2 IndexedDB schema (v1)

| Store | keyPath | Indexes | Value |
|---|---|---|---|
| `items` | `id` | `by_user_created` on `["serverOrigin","userId","createdAt"]` | item record (§6.2.3), **no binary data** |
| `photos` | `["itemId","index"]` | — | `{itemId, index, name, type, size, bytes: ArrayBuffer}` |
| `meta` | `key` | — | `{key, value}`; keys: `schemaVersion`, `canary`, `lease`, `deviceId`, `autoSync`, `persist`, `serverInfo`, `lastSuccessAt` |
| `history` | `id` | `by_completedAt` | `{id, type, summary, completedAt}` (no payload, no photos) |

Rules: **never** store `Blob`/`File` (X2) — a unit test asserts every stored value's binary fields are `ArrayBuffer`. Enqueue = **one** `readwrite` transaction over `items`+`photos`. List reads touch only `items`. Photos are read with a key-range cursor per item, one at a time.

#### 6.2.3 Item JSON shape

```json
{
  "id": "6f1c2d3e-…", "schema": 1,
  "idempotencyKey": "0b8e7a41-…",
  "serverOrigin": "https://cards.example.com", "userId": 3,
  "type": "scan.upload",
  "payload": { "individualPositions": [1, 4] },
  "photoCount": 5, "photoBytes": 7340032,
  "state": "pending",
  "createdAt": 1760600000000, "updatedAt": 1760600000000,
  "attempts": 0, "retryCount": 0, "serverErrorCount": 0,
  "firstSentAt": null, "lastAttemptAt": null, "nextAttemptAt": 0,
  "maybeApplied": false,
  "claim": null,
  "lastError": null,
  "display": { "title": "5 photos", "subtitle": "", "imageUrl": null },
  "appVersion": "1.53.0", "minApiLevel": 1
}
```

`display` is optional UI-only data (`{title, subtitle, imageUrl}`) used by lists and ghost rows; it is **never** sent to the server (only `payload` is).

`lastError = {kind: "network"|"http"|"proxy"|"shape"|"local", status?: number, code?: string, message: string, at: number}`. `payload` per type: `collection.add` = the `CollectionItemCreate` body (`card_id`, `quantity`, `condition`, `variant`, `printing_details`, `lang`, `purchase_price` already converted to EUR, `schemas.py:154-161`); `wishlist.add` = `WishlistItemCreate` (`schemas.py:219-223`); `scan.upload` = `{individualPositions: number[]}` with photos in the `photos` store. UUIDs come from `offline/uuid.js` (`uuidv4()` built on `crypto.getRandomValues`, X15).

#### 6.2.4 State machine

States: `pending`, `sending`, `retry_wait`, `blocked` (`lastError.code` is one of `auth`, `proxy`, `wrong_account`, `server_old`, `newer_schema`), `failed`. Terminal outcomes `sent` (item deleted, history row added) and `cancelled` (item and photos deleted).

| # | From → To | Trigger | Actor | Guard / effect |
|---|---|---|---|---|
| 1 | (new) → `pending` | `enqueue()` committed | UI code | `nextAttemptAt=0` |
| 2 | `pending`/`retry_wait` → `sending` | claim | replayer | CAS in one tx: state matches, `nextAttemptAt ≤ now`, `schema ≤ supported`, `minApiLevel ≤ server.apiLevel`; sets `claim={owner,expiresAt=now+timeout+CLAIM_GRACE}`, `attempts+=1`, `lastAttemptAt=now`, `firstSentAt ??= now` |
| 3 | `sending` → `sent` | valid 2xx | replayer | CAS on `claim.owner`; delete photos+item; add history |
| 4 | `sending` → `retry_wait` | network error, timeout, 500-class, 502/503/504, 409 `idempotency_in_progress` | replayer | sets `nextAttemptAt`; `maybeApplied=true` when a request was sent and no definitive response arrived (network/timeout/5xx without JSON/502-504); 500-class increments `serverErrorCount` (≥ 12 → `failed`) |
| 4b | `sending` → `pending` | 429 (rate limited) | replayer | `claim=null`; the attempt is not penalised (the slowapi middleware answers before the route runs, so nothing was applied); the engine pauses (§6.2.7) |
| 5 | `sending` → `blocked` | 401 → `auth`; `wrong_account`; HTML/redirect/non-JSON 403, 404, 400 or 401 → `proxy`; server lacks `idempotency-v1` → `server_old` | replayer | `claim=null` |
| 6 | `sending` → `failed` | definitive 400/403(JSON)/404/413/422/409-other, malformed 2xx JSON, unsupported op | replayer | `lastError` set; `maybeApplied=true` only for malformed 2xx |
| 7 | `sending` → `retry_wait` | claim expired (app was killed) | **any** replayer at start/loop | `maybeApplied=true`, `claim=null`, `nextAttemptAt=now` |
| 8 | `blocked` → `pending` | same user authenticated again; proxy answers JSON again; server upgraded; user **Retry** | OfflineProvider / UI | clears `claim` |
| 9 | `failed` → `pending` | user **Retry** (same payload) | UI | key unchanged (failures leave no server row); if `maybeApplied` and `now − firstSentAt > STALE_UNKNOWN_OUTCOME_MS` the key is rotated after an explicit "may already be applied" confirmation |
| 10 | `failed` → `pending` | user **Edit** (add types only) | UI | allowed only when `!maybeApplied`; **`idempotencyKey` regenerated**, counters reset |
| 11 | any except live-claim `sending` → *cancelled* | **Discard** (confirm) | UI | delete item + photos |
| 12 | `pending` → `pending` | local edit (quantity/condition/… of an add) | UI | allowed only for `collection.add`/`wishlist.add`; add+delete ⇒ #11 |
| 13 | any → `blocked(newer_schema)` | `item.schema > supported` | engine at load | never sent |

A `maybeApplied` item that is still unresolved 12 days after `firstSentAt` becomes `failed` with code `outcome_unknown_stale` ("may already be applied — verify, then Retry or Discard").

#### 6.2.5 Ordering, dependencies, coalescing, head-of-line blocking
- **Order:** oldest `createdAt` first among *eligible* items. There are **no cross-item dependencies** in the whitelist (all operations are appends), so `dependsOn` is deliberately absent.
- **Add then edit/delete of the same pending item (S13):** local outbox mutations (#12, #11); the server never sees them.
- **No auto-coalescing** of identical adds (user intent preserved; accidental double-taps are prevented at the source by disabling the button while `enqueue()` runs and showing a "queued ×N" chip, P9).
- **Head-of-line blocking:** `failed`, `blocked` and backing-off items are skipped; the loop always advances to the next eligible item; an engine-level pause (429, unreachable) stops *attempts*, not eligibility.

#### 6.2.6 Replay algorithm (numbered)

1. Return if flags/IndexedDB unavailable, or no authenticated user (`ctx = {userId, origin}` from `OfflineProvider`), or `pausedUntil > now`, or (`autoSync` off and trigger ≠ `manual`).
2. Acquire the lease (§6.2.9); if not acquired, return.
3. Recover stale claims (#7).
4. If no eligible item for `ctx`, release and return.
5. Probe (§6.2.8). Not `reachable` → emit `unreachable`, schedule the next probe from `PROBE_BACKOFF_MS`, release, return. Apply `serverInfo`; if `features` lacks `idempotency-v1`, mark eligible items `blocked(server_old)` and return.
6. Loop: `item = claimNext(ctx, owner)`; stop when none. (`claimNext` already filters by `userId` and `serverOrigin`; as defence in depth the loop re-checks `item.userId === ctx.userId && item.serverOrigin === location.origin`, else releases the claim.)
7. Build the request with the op executor (§6.2.12): headers `Authorization: Bearer <localStorage token>` if present, `Idempotency-Key`, `X-Expected-User-Id`; scan items read photos one by one into fresh in-memory Blobs; no `Content-Type` for multipart.
8. `fetch(url, {method, headers, body, redirect: 'manual', cache: 'no-store', signal})` where `signal` comes from an `AbortController` aborted by `setTimeout(timeout)` (not `AbortSignal.timeout`, whose Safari support was not verified) — raw `fetch`, **not** axios.
9. Classify (§6.2.7) and apply the transition with a CAS on `claim.owner`.
10. Post-processing: `rate_limited` → engine `pausedUntil`, break; two consecutive network errors → mark `unreachable`, break; `blocked(auth|proxy)` → break (all remaining items would block identically); **circuit breaker (added after trace S7):** three consecutive `failed` outcomes of the same `type` with identical `status` + `detail` end the session and leave the remaining items `pending` (typical cause: scanner provider not configured, which would otherwise burn one request per item), and the sheet shows the shared reason once; on `sent` run the op's `onSynced` (TanStack invalidations, toast coalescing).
11. Heartbeat the lease; `await sleep(PACE_MS)`; goto 6.
12. Finally release the lease and emit `changed`.

**Debug flags** (`offline/debug.js`, honoured in production builds, all harmless, needed because Safari Web Inspector needs a Mac and is not available on every development machine): `localStorage['pc.debug.forceUnreachable']='1'` (probe fails), `…forceQuota` (`enqueue` throws `QuotaExceededError`), `…forceLostResponse` (the response is discarded after the server answered and treated as a network error — the manual test for S2). They are set by opening `/?pc_debug=forceLostResponse,forceQuota` (comma-separated names from this fixed allow-list; unknown names ignored); `applyDebugParams()` stores them, strips the parameter with `history.replaceState`, and `/?pc_debug=off` removes all three. `OfflineProvider` calls `applyDebugParams()` once at mount.

#### 6.2.7 Response classification (table-driven `classify.js`, one unit test per row)

| Outcome of `fetch` | Content-Type JSON? | Result |
|---|---|---|
| Promise rejects (TypeError/AbortError) | — | `retry_wait`, engine unreachable counter++, `maybeApplied=true` |
| `type === 'opaqueredirect'` or `status === 0` | — | `blocked(proxy)` |
| 2xx, valid shape (scan: numeric `id`; collection add: numeric `id` + `card_id`; wishlist: numeric `id`) | yes | **`sent`** (also when `Idempotent-Replayed: true`) |
| 2xx | no (e.g. HTML login page) | `blocked(proxy)`, `maybeApplied=false` |
| 2xx, JSON, wrong shape | yes | `failed(shape)`, `maybeApplied=true` |
| 401 | yes | `blocked(auth)` |
| 401 / 403 / 404 / 400 | no | `blocked(proxy)` |
| 403 | yes | `failed(forbidden)` |
| 404, 400 | yes | `failed` with server `detail` |
| 409 `idempotency_in_progress` | yes | `retry_wait` (~3 s), no penalty |
| 409 `wrong_account` | yes | `blocked(wrong_account)` |
| 409 other | yes | `failed` |
| 413 | any | `failed(too_large)` |
| 422 `idempotency_key_reused` | yes | `failed(key_reused)` |
| 422 other | yes | `failed(validation)` |
| 429 | any | engine pause (`Retry-After` seconds or HTTP-date, else 60 s, clamped; doubles on consecutive 429s); item → `pending`, no penalty |
| 500, other 5xx | any | `retry_wait`, `serverErrorCount++`, `maybeApplied` if body not JSON |
| 502, 503, 504 | any | `retry_wait`, engine probe, `maybeApplied=true`, not counted |
| other 4xx | any | `failed` |

#### 6.2.8 Reachability probe (`outbox/probe.js`)
`GET /api/health` with `cache:'no-store'`, an `AbortController` aborted after `PROBE_TIMEOUT_MS`, **no** `Authorization`. Result `reachable` only if HTTP 200, `Content-Type` JSON and body `status === 'ok' && service === 'pokemon-tcg-collection'` (records `serverInfo = {version, apiLevel, features, fetchedAt}` in `meta`). Rejected/timeout/5xx → `unreachable`; 200 with anything else (HTML, other JSON, opaque redirect) → `captive`. The banner appears after **two** consecutive non-`reachable` results or `navigator.onLine === false`; it clears on the first `reachable`. `navigator.onLine === false` only lengthens the probe interval, never declares reachability (X3). The monitor also calls `onlineManager.setOnline(state === 'reachable')` (TanStack) so queries pause/resume with real reachability.

#### 6.2.9 Locking (`outbox/lease.js`)
Lease row `meta.lease = {owner, expiresAt}`; `owner = deviceId + ':' + tabId`. `acquire`: one `readwrite` tx on `meta`: if absent, expired, or owned by me → write `{owner, expiresAt: now + LEASE_TTL_MS}` and return true. Heartbeat every `LEASE_HEARTBEAT_MS` and after each item. `release` deletes it if owned. Per-item correctness never depends on the lease: `claimNext` is one `readwrite` tx over `items`, so two replayers cannot claim the same item; a double send after a lease race is harmless (same idempotency key). Change notifications use `BroadcastChannel('pokecollector-outbox')`, falling back to a `storage` event on `localStorage['pc.outbox.ping']`.

#### 6.2.10 Backoff (`outbox/backoff.js`, pure, seeded RNG in tests)
`nextDelayMs(retryCount, rng) = floor(rng() * min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2^(retryCount-1)))`; `parseRetryAfter(header, now)` accepts delta-seconds or HTTP-date, returns clamped ms or `null`.

#### 6.2.11 Schema migration of the outbox itself
`db.js` exports `migrations = {1: createStores}` (future `2`, `3`… append). `onupgradeneeded` runs every migration from `oldVersion+1` to `newVersion` inside the upgrade transaction, each idempotent and pure over the data. If a migration throws, the upgrade transaction aborts, the database stays at the old version, the outbox **disables itself for the session** and `/offline` shows "Offline queue unavailable; your data is preserved". An old tab holding the database receives `versionchange`, closes its connection and shows the update banner (so a new tab's upgrade is never blocked). Items carry `schema`; the engine refuses `schema > supported` (`blocked(newer_schema)`, #13). Tests build synthetic v1 databases with `fake-indexeddb`, upgrade, and assert no item or photo is lost.

#### 6.2.12 Module surface (for implementers)

| Module | Export | Contract |
|---|---|---|
| `outbox/index.js` | `createOutbox({ctx, flags, fetchImpl, now, rng, queryClient})` | returns `{start, stop, enqueue, sendNow, retry, editPending, discard, discardAllForUser, syncNow, setAutoSync, subscribe, getSnapshot, storageInfo}`; `sendNow(itemIds)` claims exactly those items (same claim, classification and transitions as the replay loop, but no pacing delay and without taking the global lease) and resolves with one `{id, outcome, json}` per item — the persist-then-send call used by P7/P9 |
| `enqueue({type, payload, photos?, display?})` | → item | **persist-then-send** is the only entry point for every operation (online or not), so a key always exists *before* the first send and a lost connection can never cause a second, differently-keyed attempt; validates caps (§6.2.1), checks free space, single transaction, `QuotaExceededError` → rejects with `{code:'quota'}` and persists nothing; refuses when `serverInfo` is known to lack `idempotency-v1` (`{code:'server_old'}`) |
| `getSnapshot()` | → `{items (no binary), counts{pending,sending,retryWait,blocked,failed}, reachability, engine{running,pausedUntil}, autoSync, otherAccountCount}` | stable object identity until a change (for `useSyncExternalStore`) |
| `outbox/ops/*.js` | `{type, buildRequest(item, readPhotos), validateResponse(json), summarize(item), onSynced(queryClient, json)}` | `scanUpload`: `POST /api/cards/recognize/jobs`, invalidates `['scan-jobs']`; `collectionAdd`/`wishlistAdd`: JSON body, call `invalidateCardState`/`invalidateTcgdexFilterLanguages` (`utils/queryInvalidation.js:1-21`) |
| `useOutbox.js` | `useOutbox()` | `useSyncExternalStore` over `getSnapshot` |
| `OfflineProvider.jsx` | `<OfflineProvider>` | placed inside `SettingsProvider`, above routes (`App.jsx:201-221`); builds the outbox when `flags.queue` and `capabilities.indexedDB`; supplies `ctx` from `useAuth()`; triggers `syncNow('login')` when `user.id` becomes defined |

---

### 6.3 Service worker (Phases 2–3; push handlers in Phase 10)

#### 6.3.1 Files and build

| File | Purpose |
|---|---|
| `frontend/src/sw/sw.js` | The worker. Classic script, **no `import`**, ≤ 350 lines. Two placeholders: `const BUILD_ID = '__BUILD_ID__'` and `const PRECACHE = /*__PRECACHE__*/ []` (valid JS when unreplaced, so tests load it unmodified). When `self.__PC_SW_TEST_MODE__` is truthy the worker exposes its pure helpers (`classify`, `validatePrecache`, `validateShell`, `isCacheableImage`, `trimCache`) on `self.__PC_SW_TEST__` (used only by the `node:vm` test; inert in browsers). |
| `frontend/src/sw/sw.kill.js` | Kill worker (§6.3.4), ≤ 40 lines, no placeholders. |
| `frontend/scripts/build-sw.mjs` | Runs after `vite build` (`package.json`: `"build": "vite build && node scripts/build-sw.mjs"`). |

`build-sw.mjs`, in order: (1) walk `dist/`; entries = every file under `dist/assets/` (excluding `*.map`) **plus** the fixed list `pokeball.svg, cardback.jpg, favicon.ico, favicon-48.png, apple-touch-icon.png, icon-192.png, icon-512.png, manifest.json` and everything under `dist/icons/`; **never** `index.html`, `index.html.template`, `robots*.txt`, `sw*.js`. (2) Each entry is `{url:'/assets/x-HASH.js', revision:null}` for `/assets/**` (content-hashed names) and `{url, revision: sha256(file).slice(0,16)}` otherwise. (3) `BUILD_ID = sha256(JSON.stringify(entries) + sha256(sw.js source)).slice(0,12)`. (4) Read `src/sw/sw.js`, replace each placeholder **exactly once** (fail otherwise), write `dist/sw.real.js` and a byte-identical copy `dist/sw.js`; copy `sw.kill.js` to `dist/sw.kill.js`. (5) Print entry count and total bytes; **exit 1 if total > 12 MiB** (budget, F6). (6) Fail if any `__` placeholder token remains.

#### 6.3.2 Caches and URL patterns

| Cache | Pattern | Strategy | Cap / TTL | Notes |
|---|---|---|---|---|
| `pc-precache-<BUILD_ID>` | every manifest URL (`/assets/**`, listed statics, `/icons/**`) | cache-first, network fallback (no insert) | whole set, ≤ 12 MiB; replaced per build | install validates each response (§6.3.3) |
| `pc-shell-<BUILD_ID>` | single key `'/shell'` | network-first (2.5 s) for navigations; refreshed after online navigations when consistent (D9.10) | 1 entry | never contains user data |
| `pc-images-v1` | `/api/images/card/*`, `/api/images/set/*`, `/api/pokedex/images/*` | cache-first | FIFO cap **800** entries (insertion order from `cache.keys()`); no TTL (URLs are per card/size) | only `200`, `type:'basic'`, `!redirected`, `Content-Type: image/*`, no `no-store`/`private`/`Vary: Authorization`; survives releases |
| *(none)* | `/api/*` (all other), `/api/public/*`, `/api/images/product/*`, owner/scan photos, candidate images, other origins, non-GET, `Range`, `Authorization`-bearing | **not handled** (network) | — | `fetch` handler returns without `respondWith` |

#### 6.3.3 Worker algorithms

- **Routing (`classify(req, url)`):** return *none* when method ≠ GET, `url.origin ≠ self.location.origin`, header `Range`/`Authorization` present, pathname is `/sw.js` or matches `^/sw\.[a-z]+\.js$`, or `url.searchParams.has('pc_sw')` (escape hatch); `precache` if the pathname is in the manifest set; `navigate` if `req.mode==='navigate'` and the path is not under `/api/` or `/assets/` and its last segment has no extension; `image` if it matches the three image prefixes; else none.
- **`install`:** `event.waitUntil(precacheAll())` — **no `skipWaiting()`**. `precacheAll`: open `pc-precache-<id>`; run entries with concurrency 6; for `/assets/` URLs first try `caches.match(url)` in older caches and reuse a valid response; otherwise `fetch(url, {cache:'reload', credentials:'same-origin'})`. Validation `validatePrecache(entry, res)`: `res.ok`, `res.status===200`, `res.type==='basic'`, `!res.redirected`, `Content-Type` matches the extension (`.js`→`javascript`, `.css`→`text/css`, images/fonts/`.json` must **not** be `text/html`). Any failure **rejects the install** (the old worker stays; this also protects against a reverse-proxy login page being cached as JavaScript, S8). Then fetch `/` with `cache:'reload'`, run `validateShell`, store under `'/shell'`.
- **`validateShell(res, text, precacheSet)`:** status 200, `!redirected`, `type==='basic'`, `Content-Type` includes `text/html`, `text` contains `id="root"`, and **every** `/(?:src|href)="(\/assets\/[^"#?]+)"/g` match is in `precacheSet`.
- **`activate`:** `event.waitUntil` delete every cache named `pc-precache-*` or `pc-shell-*` that is not the current build; **no `clients.claim()`**.
- **Navigation handler:** `net = fetch(req)`; race it against a 2.5 s timer. Winner network and `res.ok` → `event.waitUntil(maybeStoreShell(res.clone()))` then return it. Timer or network failure → return `caches.match('/shell')`; if absent → an inline bilingual HTML response (status 200, no scripts: "You are offline and this page is not saved on this device yet. Reconnect and reload. / Du bist offline und diese Seite ist noch nicht auf diesem Gerät gespeichert. Verbinde dich und lade neu."). If the timer won, the network promise continues and updates the shell later through the same `maybeStoreShell`.
- **`maybeStoreShell`:** read `text`, `validateShell` against **this worker's** manifest; store only if valid (consistency rule).
- **Image handler:** `cache.match(req)` → hit returns; else `fetch(req)`; if `isCacheableImage(res)` then `event.waitUntil(put + trim to 800)`; fetch errors propagate (the `<img>` simply fails offline).
- **Messages:** `{type:'SKIP_WAITING'}` → `self.skipWaiting()`; `{type:'GET_VERSION'}` → reply `{type:'VERSION', buildId, appVersion}` to `event.source`.
- **Optional (not built):** the Service Worker static routing API (`addRoutes`, Safari 27 / Chromium) could bypass the worker for `/api/*`; feature-detect only, no dependency.
- **Push (Phase 10):** `push` → parse JSON → `registration.showNotification(title, {body, data:{navigate}})` **always** (Apple revokes the subscription for invisible pushes, V); `notificationclick` → focus a window or `clients.openWindow(navigate)` (same-origin paths only).

#### 6.3.4 Registration, update flow, kill switch (page side)

`pwa/flags.js` → `readPwaFlags()`: parse `<meta name="pokecollector-pwa" content="sw=1;queue=1">`; if absent use build-time `__PWA_DEFAULT__` (`vite.config.js` `define`, from `VITE_PWA_DEFAULT=on|off`, default `off`).

`pwa/register.js` → `initServiceWorker({flags, onUpdateReady})`:
1. `'serviceWorker' in navigator` else return.
2. If the URL has `pc_sw=off` → `resetServiceWorker()` (unregister all registrations, delete caches whose name starts with `pc-`, **never** touch IndexedDB), strip the parameter, `location.replace(cleanUrl)`.
3. If `!flags.sw` → `resetServiceWorker()` (covers an installed worker when the operator disabled the feature) and return.
4. If `!window.isSecureContext` or `!import.meta.env.PROD` → return.
5. After `load` + idle (≤ 3 s): `register('/sw.js', {scope:'/', updateViaCache:'none'})`.
6. If `reg.waiting` exists, or an `installing` worker reaches `installed` while `navigator.serviceWorker.controller` exists → `onUpdateReady(reg)` (shows `UpdateBanner`).
7. On every `visibilitychange→visible`, if the last check is older than `FOREGROUND_UPDATE_CHECK_MS`, call `reg.update()` (store the time in `sessionStorage['pc.swCheckedAt']`).
8. `applyUpdate(reg)`: refuse while the scanner has staged files or an outbox item is `sending`; else `reg.waiting.postMessage({type:'SKIP_WAITING'})`; on `controllerchange` reload **once** (guard `sessionStorage['pc.reloaded']`).
9. Also listen for `vite:preloadError` (dynamic-import failure after a deploy): show the update banner, or reload once when no banner is possible.

`sw.kill.js` (served at `/sw.js` when `PWA_ENABLED=false`): `install` → `skipWaiting()`; `activate` → delete every cache starting `pc-`, `registration.unregister()`, then `clients.matchAll({type:'window', includeUncontrolled:true})` and `client.navigate(client.url)` (errors ignored); **no `fetch` handler**. Recovery path for a bad release without clearing site data: the operator sets `PWA_ENABLED=false` and restarts the frontend container; the browser's next update check (navigation, or the 30-minute foreground `update()`) installs the kill worker, which removes the broken one (X5).

#### 6.3.5 nginx, entrypoint, Dockerfile (exact)

`frontend/nginx-security-headers.conf` (new; moves the five `add_header` lines now at `nginx.conf:12-16` verbatim, CSP string unchanged):

```nginx
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(self), microphone=()" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https://assets.tcgdex.net https://raw.githubusercontent.com https://avatars.githubusercontent.com https://github.com data: blob:; connect-src 'self' https://api.tcgdex.net https://api.frankfurter.app https://api.github.com https://raw.githubusercontent.com https://generativelanguage.googleapis.com" always;
```

`frontend/nginx.conf` changes (P2 adds the snippet include + `index.html`/`manifest.json`/`/` locations; P3 adds the `sw` location — all other blocks unchanged):

```nginx
server {
    ...
    include /etc/nginx/snippets/pc-security-headers.conf;      # replaces lines 12-16

    # (unchanged) location = /api/cards/recognize/jobs, = /api/settings/scanner/test,
    #             = /api/cards/recognize, ^~ /api/ ...

    # P3: service-worker family is never HTTP-cached (updates + kill switch must propagate)
    location ~ ^/sw(\.real|\.kill)?\.js$ {
        include /etc/nginx/snippets/pc-security-headers.conf;
        add_header Cache-Control "no-cache" always;
        try_files $uri =404;
    }
    # P2: HTML shell and manifest revalidate on every use (fixes heuristic caching of index.html)
    location = /index.html {
        include /etc/nginx/snippets/pc-security-headers.conf;
        add_header Cache-Control "no-cache" always;
    }
    location = /manifest.json {
        include /etc/nginx/snippets/pc-security-headers.conf;
        add_header Cache-Control "no-cache" always;
    }
    location / {                                                  # SPA fallback keeps working
        include /etc/nginx/snippets/pc-security-headers.conf;
        add_header Cache-Control "no-cache" always;
        try_files $uri $uri/ /index.html;
    }
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {   # existing block, + include
        include /etc/nginx/snippets/pc-security-headers.conf;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

**MIME types:** nginx's stock `mime.types` serves `.js` as a JavaScript type (a worker script must have one) and `manifest.json` as `application/json`, which browsers accept although `application/manifest+json` is the registered type; no `types` override is needed (standard nginx behaviour, **U** here, asserted by the P3 `curl -I` check). Order matters: the `sw` regex location must appear **before** the static-asset regex (first matching regex wins). `location ^~ /api/` keeps `/api` away from all regexes. `frontend/Dockerfile` adds `COPY frontend/nginx-security-headers.conf /etc/nginx/snippets/pc-security-headers.conf` next to the existing `COPY … default.conf` (`Dockerfile:21`).

`frontend/docker-entrypoint.d/45-configure-pwa.sh` (new; runs after `40-…` because the nginx image executes `/docker-entrypoint.d/*.sh` in name order — the standard behaviour; P3 acceptance verifies both scripts' effects in a built container):

```sh
#!/bin/sh
set -eu

web_root="${WEB_ROOT:-/usr/share/nginx/html}"
index_file="${web_root}/index.html"

# $1 = raw value, $2 = default (0 or 1)
flag() {
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "${value}" in
    true|1|yes|on) echo 1 ;;
    false|0|no|off) echo 0 ;;
    '') echo "$2" ;;
    *) echo >&2 "WARNING: Invalid flag value '$1'. Using default $2."; echo "$2" ;;
  esac
}

sw_enabled="$(flag "${PWA_ENABLED:-}" 0)"            # P11 changes this default to 1
queue_enabled="$(flag "${OFFLINE_QUEUE_ENABLED:-}" 0)" # P11 changes this default to 1

if [ "${sw_enabled}" = 1 ]; then
  cp "${web_root}/sw.real.js" "${web_root}/sw.js"
else
  cp "${web_root}/sw.kill.js" "${web_root}/sw.js"
fi

# 40-configure-public-mode.sh already reset index.html from its template on this start,
# so this insertion cannot accumulate across restarts. </head> is a stable anchor
# (the <title> line is rewritten by PUBLIC_MODE).
sed -i "s|</head>|<meta name=\"pokecollector-pwa\" content=\"sw=${sw_enabled};queue=${queue_enabled}\" /></head>|" "${index_file}"
```

`frontend/Dockerfile`: add `COPY frontend/docker-entrypoint.d/45-configure-pwa.sh /docker-entrypoint.d/45-configure-pwa.sh` and extend the existing `chmod +x` (`Dockerfile:24-25`) to both scripts. `docker-compose.yml` frontend `environment:` (`:86-87`) gains `PWA_ENABLED: ${PWA_ENABLED:-}` and `OFFLINE_QUEUE_ENABLED: ${OFFLINE_QUEUE_ENABLED:-}` (empty ⇒ script default). `.gitattributes` (new, P3): `*.sh text eol=lf` — a Windows checkout may have `core.autocrlf=true` (F13), and a CRLF `#!/bin/sh` fails inside the container.

#### 6.3.6 Worker test plan
`frontend/src/sw/sw.test.js` (vitest, node) loads `sw.js` into a `node:vm` context with fake `self`, `caches`, `fetch`, `clients`, and asserts: `classify` table (every row of the routing rule); `validatePrecache` accepts/rejects HTML-as-JS, redirected, non-200; `validateShell` rejects a shell referencing an asset not in the manifest; install rejects when any entry fails; activate deletes only stale `pc-precache-*`/`pc-shell-*`; FIFO trim at 800; `isCacheableImage` rejects `private`/`no-store`/`Vary: Authorization`; navigation timeout falls back to the shell then to the inline page; no `skipWaiting`/`claim` calls without a message. Playwright (Chromium, §10.1) covers the real lifecycle.

---

### 6.4 UI (Phases 2, 5, 6, 8, 9)

#### 6.4.1 Components and files

| Component / file | Phase | Behaviour |
|---|---|---|
| `components/sync/SyncIndicator.jsx` | P6 | Floating button `fixed right-3 top-[max(0.5rem,env(safe-area-inset-top))] z-[45]`, mounted **once** in `Layout.jsx`. Hidden when the queue is empty and reachability is `reachable`. Shows an icon (`CloudOff` / `Clock3` / `Loader2` with `motion-safe:animate-spin` / `AlertTriangle`), a count badge and an `aria-label`. Opens `SyncSheet`. |
| `components/sync/SyncSheet.jsx` | P6 | Existing `Modal` (size `md`). Header: title, **Sync now**, **Automatic sync** toggle, and the total size of waiting photos (`` `${t('sync.waitingSize')}: ${megabytes} MB` ``). Body: item list (type icon, summary, age, state chip, per-item **Retry/Edit/Discard**, error text; `maybeApplied` hint). Footer: storage line, "only copy" sentence, Safari warning (D12), link to `/offline`. |
| `components/sync/OfflineBanner.jsx` | P6 | `role="status"` strip at the top of `Layout` when reachability is non-`reachable` twice or `navigator.onLine === false`. |
| `pages/OfflineCenter.jsx` (`/offline`) | P6 | Works in degraded mode. Sections: Connection (state, server version/`api_level`, last probe), Sync (list), Storage (usage/quota/persist), Capabilities (HTTPS, service worker, IndexedDB, storage API, installed, push), Install hint, **Reset offline app data**, app version + build id. |
| `components/OfflineUnavailable.jsx` | P6 | Rendered by `Layout` in place of `<Outlet/>` when not reachable and the route is not in `OFFLINE_ROUTES`; links to `/offline` and Home. |
| `OFFLINE_ROUTES` (`offline/routes.js`) | P6/P8 | `/`, `/dashboard`, `/collection`, `/wishlist`, `/sets`, `/sets/:setId`, `/binders`, `/binders/:binderId`, `/search` (scanner only), `/offline`. Others → `OfflineUnavailable`. |
| `components/pwa/UpdateBanner.jsx`, `InstallHint.jsx` | P3 / P6 | Update banner; iOS hint card (Home + `/offline`; dismissal in `localStorage['pc.installHint.dismissed']`). |
| Logout guard (inside `AuthContext.logout`, registered by `OfflineProvider`) | P5 | Four-way dialog (D7) in `components/sync/LogoutGuardDialog.jsx`, built on the existing `Modal`/`ConfirmDialog` look. |
| Ghost rows, "queued" chip | P9 | Collection/Wishlist top section "Waiting to sync"; chip on a card tile when `pendingForCard(cardId) > 0`. Totals exclude pending and show `sync.pendingTotalsNote`. |
| Stale-data label | P8 | "Showing saved data from <relative time>" above cached pages when `reachability !== 'reachable'`. |

#### 6.4.2 State diagrams

```text
SyncIndicator
  hidden ──(enqueue | probe fails twice | onLine=false)──► OFFLINE / WAITING(n)
  WAITING(n) ──(reachable & lease)──► SYNCING(n) ──(all sent)──► hidden  (+ one coalesced toast)
  SYNCING(n) ──(any failed|blocked)──► ATTENTION(n)   persists until each item is Retried or Discarded
  any ──(items for other accounts only)──► hidden (count shown in sheet footer)

Item chip
  pending ─► sending ─► sent (disappears; history)
     ▲          ├──► retry_wait ("Retrying soon") ─► sending
     │          ├──► blocked ("Sign-in needed" | proxy | other account) ─(login/Retry)─► pending
     └─ Retry ──┴──► failed ("Failed" + reason) ─(Edit/Retry)─► pending     Discard ─► gone
```

#### 6.4.3 Every user-visible string (keys; `t()` has no interpolation, so counts are composed as `` `${t('sync.waitingLabel')}: ${n}` ``)

`i18n/en.js` and `i18n/de.js` each get two new top-level objects `sync` and `pwa` (German uses the app's informal "du", e.g. `de.js:173`). Literal `t('sync.x')` calls are validated by `check:translations`; a vitest test (`src/i18n/offlineKeys.test.js`) additionally asserts `de.sync`/`de.pwa` have exactly the keys of `en`.

| Key | English | Deutsch |
|---|---|---|
| `sync.centerTitle` | Sync center | Synchronisierung |
| `sync.offlineBanner` | You're offline or the server can't be reached. Changes are saved on this device and sync automatically when the server is back. | Du bist offline oder der Server ist nicht erreichbar. Änderungen werden auf diesem Gerät gespeichert und automatisch synchronisiert, sobald der Server wieder erreichbar ist. |
| `sync.offlineShort` | Offline mode | Offline-Modus |
| `sync.waitingLabel` | Waiting to sync | Wartet auf Synchronisierung |
| `sync.waitingSize` | Waiting data | Wartende Daten |
| `sync.syncingLabel` | Syncing… | Synchronisiere… |
| `sync.attentionLabel` | Needs attention | Benötigt Aufmerksamkeit |
| `sync.syncNow` | Sync now | Jetzt synchronisieren |
| `sync.autoSync` | Automatic sync | Automatische Synchronisierung |
| `sync.autoSyncPaused` | Automatic sync is paused | Automatische Synchronisierung ist pausiert |
| `sync.lastSynced` | Last synced | Zuletzt synchronisiert |
| `sync.never` | never | nie |
| `sync.empty` | Everything is synced. | Alles ist synchronisiert. |
| `sync.state.pending` | Waiting | Wartet |
| `sync.state.sending` | Sending… | Wird gesendet… |
| `sync.state.retry` | Retrying soon | Neuer Versuch folgt |
| `sync.state.blocked` | Sign-in needed | Anmeldung erforderlich |
| `sync.state.failed` | Failed | Fehlgeschlagen |
| `sync.item.scan` | Scan photos | Scan-Fotos |
| `sync.item.photos` | photos | Fotos |
| `sync.item.collectionAdd` | Add to collection | Zur Sammlung hinzufügen |
| `sync.item.wishlistAdd` | Add to wishlist | Zur Wunschliste hinzufügen |
| `sync.item.captured` | Captured | Aufgenommen |
| `sync.retry` | Retry | Erneut versuchen |
| `sync.edit` | Edit | Bearbeiten |
| `sync.discard` | Discard | Verwerfen |
| `sync.discardConfirm` | Discard this item? It has not reached the server and cannot be recovered. | Diesen Eintrag verwerfen? Er hat den Server nicht erreicht und kann nicht wiederhergestellt werden. |
| `sync.maybeApplied` | This item may already have been saved. Check your collection before retrying. | Dieser Eintrag wurde möglicherweise bereits gespeichert. Prüfe deine Sammlung, bevor du es erneut versuchst. |
| `sync.blockedAuth` | Sign in again to continue syncing. | Melde dich erneut an, um die Synchronisierung fortzusetzen. |
| `sync.blockedProxy` | Your login proxy answered instead of PokéCollector. Open the app online and sign in, then sync. | Statt PokéCollector hat dein Login-Proxy geantwortet. Öffne die App online, melde dich an und synchronisiere erneut. |
| `sync.wrongAccount` | These items belong to another account on this device. | Diese Einträge gehören zu einem anderen Konto auf diesem Gerät. |
| `sync.otherAccountsNote` | Items for other accounts are waiting on this device | Auf diesem Gerät warten Einträge anderer Konten |
| `sync.savedOffline` | Saved on this device. It will sync automatically. | Auf diesem Gerät gespeichert. Es wird automatisch synchronisiert. |
| `sync.syncedToast` | Offline changes were synced. | Offline-Änderungen wurden synchronisiert. |
| `sync.failedToast` | Some items could not be synced. Open the sync center. | Einige Einträge konnten nicht synchronisiert werden. Öffne die Synchronisierung. |
| `sync.storageTitle` | Storage | Speicher |
| `sync.storageUsed` | Used by offline data | Von Offline-Daten belegt |
| `sync.storageFull` | Not enough storage to keep these items offline. Sync or free up space and try again. | Nicht genug Speicher, um diese Einträge offline zu behalten. Synchronisiere oder schaffe Platz und versuche es erneut. |
| `sync.storagePersistent` | Protected from automatic cleanup | Vor automatischer Bereinigung geschützt |
| `sync.storageNotPersistent` | Your browser may delete this data if storage runs low. | Dein Browser kann diese Daten löschen, wenn der Speicher knapp wird. |
| `sync.storageUnavailable` | Storage information is not available here. | Speicherinformationen sind hier nicht verfügbar. |
| `sync.onlyCopyWarning` | Items waiting here exist only on this device until they reach the server. | Wartende Einträge existieren nur auf diesem Gerät, bis sie den Server erreichen. |
| `sync.safariWarning` | Safari can delete data of websites you haven't opened for about a week. Add PokéCollector to your Home Screen and sync soon. | Safari kann Daten von Websites löschen, die du etwa eine Woche nicht geöffnet hast. Füge PokéCollector zum Home-Bildschirm hinzu und synchronisiere bald. |
| `sync.syncBeforeInstall` | Sync your waiting items in this browser before adding PokéCollector to your Home Screen. The installed app has its own storage and won't see them. | Synchronisiere wartende Einträge in diesem Browser, bevor du PokéCollector zum Home-Bildschirm hinzufügst. Die installierte App hat einen eigenen Speicher und sieht sie nicht. |
| `sync.evicted` | Some offline data was removed by the browser before it could sync. Check your collection and re-scan missing cards. | Der Browser hat einige Offline-Daten entfernt, bevor sie synchronisiert werden konnten. Prüfe deine Sammlung und scanne fehlende Karten erneut. |
| `sync.logoutTitle` | Unsynced items | Nicht synchronisierte Einträge |
| `sync.logoutMessage` | You have items that have not reached the server yet. | Du hast Einträge, die den Server noch nicht erreicht haben. |
| `sync.logoutSyncFirst` | Sync first | Zuerst synchronisieren |
| `sync.logoutKeep` | Log out and keep items | Abmelden und Einträge behalten |
| `sync.logoutDiscard` | Log out and delete items | Abmelden und Einträge löschen |
| `sync.pendingBadge` | queued | in Warteschlange |
| `sync.staleData` | Showing saved data from | Zeige gespeicherte Daten von |
| `sync.pendingTotalsNote` | Totals do not include items waiting to sync. | Summen enthalten keine Einträge, die auf Synchronisierung warten. |
| `sync.unavailableOffline` | This page isn't available offline. | Diese Seite ist offline nicht verfügbar. |
| `sync.needsConnection` | Needs a connection | Benötigt eine Verbindung |
| `sync.serverTooOld` | The server must be updated before changes can be saved offline. | Der Server muss aktualisiert werden, bevor Änderungen offline gespeichert werden können. |
| `sync.photoTooLarge` | This photo is larger than 15 MB and can't be uploaded. | Dieses Foto ist größer als 15 MB und kann nicht hochgeladen werden. |
| `sync.newerVersion` | Created by a newer app version. Update the app to sync it. | Mit einer neueren App-Version erstellt. Aktualisiere die App, um es zu synchronisieren. |
| `sync.unavailableQueue` | Offline queue unavailable. Your saved data is preserved. | Offline-Warteschlange nicht verfügbar. Deine gespeicherten Daten bleiben erhalten. |
| `sync.corrupted` | This item is damaged and can only be discarded. | Dieser Eintrag ist beschädigt und kann nur verworfen werden. |
| `pwa.updateAvailable` | A new version is available. | Eine neue Version ist verfügbar. |
| `pwa.updateNow` | Update | Aktualisieren |
| `pwa.updateBlocked` | Finish what you're doing first. | Schließe zuerst ab, was du gerade tust. |
| `pwa.installTitle` | Install on your iPhone | Auf dem iPhone installieren |
| `pwa.installSteps` | Tap the Share button, then choose Add to Home Screen. | Tippe auf „Teilen“ und wähle dann „Zum Home-Bildschirm“. |
| `pwa.installDismiss` | Not now | Jetzt nicht |
| `pwa.offlineTitle` | You're offline | Du bist offline |
| `pwa.offlineMessage` | PokéCollector can't reach the server. Saved pages and your sync queue are still available. | PokéCollector erreicht den Server nicht. Gespeicherte Seiten und deine Warteschlange sind weiterhin verfügbar. |
| `pwa.settingsTitle` | Offline & install | Offline & Installation |
| `pwa.capServiceWorker` | Offline app start (service worker) | Offline-App-Start (Service Worker) |
| `pwa.capSecureContext` | Secure connection (HTTPS) | Sichere Verbindung (HTTPS) |
| `pwa.capStorage` | Offline storage | Offline-Speicher |
| `pwa.capInstalled` | Installed to Home Screen | Zum Home-Bildschirm hinzugefügt |
| `pwa.capPush` | Push notifications | Push-Benachrichtigungen |
| `pwa.supported` | Available | Verfügbar |
| `pwa.unsupported` | Not available | Nicht verfügbar |
| `pwa.httpsHint` | Offline app start and push notifications need HTTPS. Offline saving still works while the app is open. | Offline-App-Start und Push-Benachrichtigungen benötigen HTTPS. Offline-Speichern funktioniert weiterhin, solange die App geöffnet ist. |
| `pwa.resetTitle` | Reset offline app data | Offline-App-Daten zurücksetzen |
| `pwa.resetDescription` | Removes cached app files and saved pages. Items waiting to sync are kept. | Entfernt zwischengespeicherte App-Dateien und gespeicherte Seiten. Wartende Einträge bleiben erhalten. |
| `pwa.resetAction` | Reset | Zurücksetzen |
| `pwa.resetDone` | Offline app data was reset. | Offline-App-Daten wurden zurückgesetzt. |
| `pwa.version` | App version | App-Version |
| `pwa.connection` | Connection | Verbindung |
| `pwa.serverVersion` | Server version | Server-Version |
| `pwa.reachable` | Server reachable | Server erreichbar |
| `pwa.unreachable` | Server not reachable | Server nicht erreichbar |
| `pwa.captive` | A network login page or proxy is answering instead of PokéCollector | Eine Anmeldeseite oder ein Proxy antwortet anstelle von PokéCollector |
| `pwa.pushTitle` *(P10)* | Push notifications | Push-Benachrichtigungen |
| `pwa.pushEnable` *(P10)* | Enable on this device | Auf diesem Gerät aktivieren |
| `pwa.pushDisable` *(P10)* | Disable on this device | Auf diesem Gerät deaktivieren |
| `pwa.pushTest` *(P10)* | Send test notification | Testbenachrichtigung senden |
| `pwa.pushDenied` *(P10)* | Notifications are blocked in your device settings. | Benachrichtigungen sind in den Geräteeinstellungen blockiert. |
| `pwa.pushIosHint` *(P10)* | On iPhone, add PokéCollector to your Home Screen first. | Füge PokéCollector auf dem iPhone zuerst zum Home-Bildschirm hinzu. |

#### 6.4.4 Accessibility, motion, duplicates
- Indicator and sheet controls are real `<button>`s with text labels (icons are never the only signal); the banner and one polite live region (`role="status"`, updates debounced to 1 s) announce state changes; the sheet reuses `Modal`'s focus trap and restore (`components/ui/dialogBehavior`).
- `motion-safe:` prefixes on spinners and transitions; under `prefers-reduced-motion` all appear/disappear animation is removed (the codebase already checks the media query, `AppNav.jsx:34`).
- Toasts: at most one "synced" summary per 60 s; one error toast per item entering `failed`; none for `retry_wait`.
- Colour is never the sole state signal (icon + text on every chip).

---

### 6.5 Scanner integration (Phases 3 and 7)

#### 6.5.1 Upload hardening (P3, applies even with the queue off)
`frontend/src/utils/memoryBlob.js` exports `prepareUploadPart(file, {enabled})`:
- `enabled` is `flags.sw || flags.queue` (so flag-off installs keep today's exact behaviour).
- If `enabled` and `file.size ≤ 8 MiB` → `new Blob([await file.arrayBuffer()], {type: file.type})` (memory-backed; the workaround confirmed in the bug thread, X2).
- If `enabled` and larger → `file.slice(0, file.size, file.type)` (zero-copy workaround reported in the same thread; avoids a 150 MB memory spike for a 50-photo batch — **U**: unverified beyond the thread, so a failure surfaces as the server's explicit 400 "An uploaded scan photo is empty", `scan_storage.py:75-76`, never silently).
- Otherwise return `file` unchanged.
`client.js` multipart functions (`enqueueScanJob :127-134`, `uploadCollectionItemPhoto :185-194`, `importCollectionCsv :203-209`, `importBinderCsv :271-277`, `restoreBackup :393-399`, `recognizeCard :117-124`) become `async`, call `formData.append(field, await prepareUploadPart(file), file.name)` (the **filename must be preserved**: the CSV endpoints check `.csv`, `collection.py:664`), and keep every other detail (headers, timeouts) unchanged. All callers already `await` or `.then`.

#### 6.5.2 `submitScanBatch` (P7) — `frontend/src/offline/ops/scanSubmit.js`
Input `{files, individualPositions, outbox, queryClient}`; output `{mode: 'sent'|'queued'|'partial', jobIds: number[], queuedCount: number}`.
1. Validate: every file passes `isSupportedScannerImage`; any `file.size > MAX_PHOTO_BYTES` → reject with `{code:'too_large'}` (UI toast `sync.photoTooLarge`); `files.length ≤ 50` (unchanged UI rule, `UnifiedCardScanner.jsx:78`).
2. Chunk greedily in order: start a new chunk when adding the next file would exceed `MAX_PHOTOS_PER_ITEM` (12) or `TARGET_ITEM_BYTES` (10 MiB); a single file larger than 10 MiB forms its own chunk (≤ 15 MiB).
3. Remap `individualPositions` per chunk (`position − chunkStart`, dropping those outside the chunk).
4. For each chunk: read bytes (`await file.arrayBuffer()`), call `outbox.enqueue({type:'scan.upload', payload:{individualPositions}, photos:[{name,type,size,bytes}]})` (one IndexedDB transaction). `{code:'quota'}` or `{code:'server_old'}` aborts **before any further chunk**; already-enqueued chunks stay queued and are reported (`partial`).
5. If reachability ≠ `unreachable` call `outbox.sendNow(itemIds)` sequentially and collect job ids from the responses; if every chunk was sent → `sent`; if none → `queued`; else `partial`.
6. UI (in `UnifiedCardScanner.startScanning`): clear staged files **only after step 4 succeeded for all chunks**; `sent` + one job → `navigate('/scans/'+id)`; `sent` + several → `navigate('/scans')`; `queued`/`partial` → `toast.success(t('sync.savedOffline'))`, close the scanner; thrown `quota` → `toast.error(t('sync.storageFull'))` and keep the staged files in memory; other errors keep today's `scanner.batchSubmitFailed` toast.
With `flags.queue` off, `startScanning` keeps today's code path (`enqueueScanJob` + navigate, `UnifiedCardScanner.jsx:147-166`).

#### 6.5.3 Interaction with the server queue (facts)
Recognition attempts (`MAX_RECOGNITION_ATTEMPTS=3`, `scan_queue.py:27`) and the 14-day retention (`scan_storage.py:35,226`) start when the job is created, i.e. at upload; offline time consumes neither. A new job per chunk means batch-composite grouping (2–4 cards per provider call) applies within each job only (`scan_jobs.py:149-155`); an accepted cost of chunking. The server's concurrency cap (`MAX_CONCURRENT_SCAN_PROCESSING=3`) and provider pacing handle bursts, so the client does not throttle for providers, only for the API rate limit (R6).

#### 6.5.4 Capture sources
`<input capture="environment">` (`UnifiedCardScanner.jsx:185-195`), the gallery input (`:196-206`) and a possible future live viewfinder all produce `File`s through `appendFiles`; the outbox sits at **submit**, so it is independent of the capture method. HEIC/HEIF files are stored and uploaded unchanged (X10).

---

### 6.6 Auth and multi-user rules (Phases 5–7)

| # | Rule |
|---|---|
| A1 | Every item stores `userId` (from the verified `/auth/me` of the last successful bootstrap) and `serverOrigin = location.origin`. All reads and the replay loop filter on both. Items of other users are only *counted* (`sync.otherAccountsNote`) and never shown, edited, replayed or purged by a different user. |
| A2 | Replay builds its own headers: `Authorization: Bearer <localStorage 'token'>` read **at send time** (omitted in single-user mode, where the app clears the token, `authBootstrap.js:45`), `Idempotency-Key`, `X-Expected-User-Id: item.userId`. The server answers `409 wrong_account` on mismatch — covering two tabs where tab B logged in as another user after tab A loaded. |
| A3 | Replay never uses the axios instance, so a 401 cannot clear `token`/`user` or navigate to `/login` (`client.js:29-34`). A 401 only moves items to `blocked(auth)`. |
| A4 | When `user.id` becomes defined (login or bootstrap) `OfflineProvider` calls `syncNow('login')`; `blocked(auth)` items of that user return to `pending` (#8). |
| A5 | **Degraded bootstrap (P5):** on a successful bootstrap `AuthContext` writes `localStorage['pc.auth.snapshot'] = {v:1, multiUser, locked, user:{id,username,role,avatar_id,must_change_password}, savedAt}`; it removes it on logout and whenever `clearSession` applies. On a bootstrap failure (`catch`, `AuthContext.jsx:48-56`) the snapshot is **valid** iff `v===1`, `user.id` is a number, `!user.must_change_password`, `savedAt` is ≤ 90 days old, and (`multiUser` ⇒ `localStorage.token` exists). Valid → `authStatus='degraded'` (`loading=false`, `connectionError=false`, `user` from the snapshot) and the retry timer keeps running (`authRetryDelay`); success → `'ready'`. Invalid → `'offline'` exactly as today. The cached user is **display-only**: the server re-authorises every request. |
| A6 | **Logout (P5):** if the outbox has items for this user: dialog *Sync first / Log out and keep items / Log out and delete items / Cancel*. *Sync first* runs a replay with a progress state, then proceeds if no item remains `pending`, `sending` or `retry_wait` (blocked/failed items re-prompt). Whatever is chosen, the read cache of that user is purged. Logout keeps removing only `token` and `user` (`AuthContext.jsx:88-89`) plus the snapshot. If server-side session revocation is added later, the dialog still comes first. |
| A7 | **Reset offline app data** clears SW caches and the read cache only; **never** the outbox (separate IndexedDB database). |
| A8 | **Single-user mode:** the user is the first active admin (`api/auth.py:126-132`); `userId` is that admin id. If multi-user mode is enabled later, items stay bound to that id and replay after that admin signs in. |
| A9 | **Reverse-proxy SSO:** an expired proxy session produces a 302 to the IdP (seen as an opaque redirect with `redirect:'manual'`) or a 200/403 HTML page; both become `blocked(proxy)` with `sync.blockedProxy`; nothing is dequeued on HTML. The service worker's install validation rejects HTML-as-asset for the same reason. |
| A10 | **Roles / deactivation:** role and `is_active` are read from the DB per request (`api/auth.py:140-142`); queued operations are user-level, never admin-only, so a role change cannot make a queued item privileged. A deactivated user gets 401 → `blocked(auth)`. |
| A11 | **Password changed elsewhere:** on `main` tokens are not revoked (`api/auth.py:393-404`), replay keeps working until the 7-day expiry; with revocable sessions the token dies and the 401 path applies. |
| A12 | **Secrets:** no token, password or API key is ever written to IndexedDB, the Cache API or the service worker; the SW cannot read `localStorage`. The existing token in `localStorage` is unchanged. |
| A13 | **Origin change:** items belong to the old origin's storage; a new origin starts empty. `docs/PWA.md` instructs: sync before moving domains or ports. |

---

### 6.7 Web push (Phase 10 — optional, separable)

#### 6.7.1 Backend
- Migration (two entries appended to `_run_migrations`, serialised after P1):

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    p256dh VARCHAR(255) NOT NULL,
    auth VARCHAR(255) NOT NULL,
    user_agent VARCHAR(255),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_success_at TIMESTAMP,
    failure_count INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT uq_push_subscription_endpoint UNIQUE (endpoint)
);
CREATE INDEX IF NOT EXISTS ix_push_subscriptions_user_id ON push_subscriptions(user_id);
```

  plus the matching `PushSubscription` model in `models.py`.
- `backend/api/push.py` (router prefix `/api/push`, all routes `Depends(get_current_user)`): `GET /vapid-public-key` → `{"public_key": "<base64url uncompressed P-256 point>"}`; `POST /subscribe` body `{endpoint, keys:{p256dh, auth}, user_agent?}` → upsert by `endpoint` (re-assign to the caller; `last_seen_at=now`; reset `failure_count`) → `{"id": n}`; `DELETE /subscribe` body `{endpoint}` → 204 (only the caller's rows); `POST /test` → sends a test notification to the caller's subscriptions → `{"sent": n, "removed": m}`.
- **SSRF guard (security requirement):** the server later POSTs to `endpoint`, so `subscribe` accepts only `https` URLs ≤ 2048 chars whose host ends with one of `.push.apple.com`, `fcm.googleapis.com`, `.push.services.mozilla.com`, `.notify.windows.com` and rejects IP literals and ports other than 443; reuse the validation style of `services/image_url_security.py`. Other hosts → 422.
- `backend/services/push.py`: `get_or_create_vapid_keys()` (reads `VAPID_PRIVATE_KEY` or `/app/data/auth/vapid_private.pem`; creates an EC P-256 key with mode `0600` using the JWT-secret write pattern, `services/auth.py:48-97`; never logged), `send_to_user(db, user_id, payload_dict) -> {"sent","removed"}`, `send_price_alert(db, user_id, card_name, price, threshold, alert_type)`. Sends with `pywebpush.webpush(..., ttl=86400, headers={"Urgency":"normal"})`, timeout 10 s, payload ≤ 4096 bytes (truncate the card name). Outcomes: HTTP 404/410 → delete row; 403 → log, keep; 429 → skip; other failure → `failure_count += 1`, delete at ≥ 10; success → `last_success_at=now`, `failure_count=0`.
- Hook: `sync_service.check_wishlist_alerts` (`:624-629`): after `telegram.send_price_alert(...)` add `push.send_price_alert(...)` inside its own `try/except` that logs and continues so a push fault can never stop Telegram or the loop; `item.notified_at = now` semantics unchanged.
- Requirements: `pywebpush==2.5.0` added to `backend/requirements.txt` (stop condition: if `pip` cannot resolve `cryptography>=47` alongside the existing pins, stop and report; do **not** swap libraries silently).
- Tests (`unittest`, mocked `webpush`): payload size ≤ 4 KB; 410 removes; 403 keeps; 429 skips; allowlist rejects `http://`, IPs, foreign hosts; upsert re-assigns; cascade on user delete; hook failure does not break Telegram.

#### 6.7.2 Frontend
- `frontend/src/pwa/push.js`: `pushSupported()` = `window.isSecureContext && 'PushManager' in window && 'Notification' in window` (feature detection; per platform claim PF7 in §3.3, on iOS this is true only in the installed app); `enablePush()` (**must run in a click handler**): `Notification.requestPermission()` → if `granted`, `navigator.serviceWorker.ready` then `pushManager.subscribe({userVisibleOnly:true, applicationServerKey})` (key from `GET /api/push/vapid-public-key`) → `POST /api/push/subscribe`; `disablePush()` unsubscribes and `DELETE`s.
- `components/pwa/NotificationsCard.jsx` in Settings (strings `pwa.push*`): hidden unless `pushSupported()`; shows `pwa.pushIosHint` on iOS Safari tab (`navigator.standalone === false`), `pwa.pushDenied` when permission is `denied`.
- `sw.js` gains `push` and `notificationclick` handlers (§6.3.3); payload is the Declarative Web Push JSON (V), so browsers with native support display it without running worker code and older ones run the handler with the same JSON.
- Failure behaviour without HTTPS: the card is hidden; backend unaffected.

---

## 7. Edge-case table

| # | Edge case | Where handled | Behaviour |
|---|---|---|---|
| **Network** | | | |
| 1 | Device online but server unreachable (VPN off, away from home) | D6, §6.2.8 | Probe of `/api/health` fails → `unreachable`; banner after two failures; items stay `pending`; probes back off 15→120 s; TanStack `onlineManager` mirrors reachability |
| 2 | Captive portal / proxy returns HTML | §6.2.7, §6.2.8 | Probe sees 200 non-JSON → `captive` ("a login page is answering"); replay 2xx non-JSON → `blocked(proxy)`; **never** dequeued on HTML |
| 3 | Half-open connection | §6.2.6 step 8 | `AbortController` timeouts (probe 5 s, JSON 20 s, upload ≤ 290 s) → network error → `retry_wait` |
| 4 | Timeout during a large photo upload | D11, §6.2.1 | Upload timeout scales with bytes (40 KiB/s floor); items ≤ 10 MiB; retry with the **same key**; server either never saw it or replays |
| 5 | Response lost after server commit | D4, §6.1 | Row + write commit together; retry gets `Idempotent-Replayed`; item marked `maybeApplied` meanwhile (S2) |
| 6 | 429 burst | D6, §6.2.7 | Engine pause (`Retry-After` or 60 s, doubling to 15 min); item back to `pending` without penalty; 30 req/min pacing (S14) |
| 7 | Server restarting mid-replay | §6.2.7 | 502/503/504 or connection refused → `retry_wait`, engine probe; idempotency makes the retry safe |
| 8 | HTTPS page calling an http server (mixed content) | §2.3, D7 | All calls are relative same-origin (`client.js:9`); items bound to `serverOrigin`; a different origin never sees them |
| 9 | Server URL/domain changed | A13, S20 | Old origin's storage keeps the items; new origin starts empty; docs: sync before moving |
| 10 | Clock skew phone vs server | §6.2.1, §6.1 | No client timestamps are sent; server TTL uses the server clock; client uses its clock only for local scheduling and display; `Retry-After` is relative |
| **Auth** | | | |
| 11 | Expired JWT (7 days, no refresh) | A3, A4, S3 | Items survive; first replay 401 → `blocked(auth)`; after the same user logs in → `pending` |
| 12 | Token cleared by the 401 handler while items pending | A3 | Replay does not use axios; the interceptor only affects UI calls; outbox is a separate IndexedDB database untouched by `removeItem('token')` |
| 13 | Two accounts on one phone | A1, A2 | Items filtered by `userId`+origin; other accounts counted only; `X-Expected-User-Id` → `409 wrong_account` as backstop (S4) |
| 14 | Logout with pending items | A6, D7 | Four-way dialog; *keep* retains items bound to the user; *delete* purges them; read cache always purged |
| 15 | Admin vs trainer role changes offline | A10 | Role is read per request; queued ops are never admin-only |
| 16 | Password changed on another device | A11 | `main`: replay continues until expiry; with revocable sessions: 401 → `blocked(auth)` |
| 17 | Reverse-proxy SSO session expiry | A9, S8 | Opaque redirect/HTML → `blocked(proxy)` with instructions; SW install validation rejects HTML-as-asset |
| 18 | Single-user mode | A8, A2 | No token header; `userId` = admin id from `/auth/me`; works unchanged |
| 19 | User deleted while items pending | A10 | 401 "User not found or inactive" → `blocked(auth)`; items can only be discarded by signing in as that user; documented orphan case (storage only) |
| **Data** | | | |
| 20 | Same card queued twice, on purpose vs by accident | §6.2.5 | No auto-coalescing; double-tap prevented at source and visible as "queued ×N"; server `quantity +=` is commutative so both apply exactly once each |
| 21 | Offline add then offline edit/delete of the same item | §6.2.5, S13 | Local outbox mutation/cancel; no server calls; edits/deletes of server rows are online-only |
| 22 | Card removed from the catalogue before replay | §3.1 R4, §6.2.7 | Plain add tries TCGdex first (`collection.py:246-300`); a final 404 → `failed` with the server message; other items continue |
| 23 | Catalogue sync changes ids/language suffix while pending | §3.1 R4 | Server normalises `{tcg_card_id}_{lang}` (`collection.py:326-327`); a vanished id → 404 → `failed`; user Edit/Discard |
| 24 | Validation changes after an app upgrade | §6.2.7 | 422 → `failed(validation)` with message; Edit or Discard; `schema`/`minApiLevel` gate incompatible items |
| 25 | `purchase_price`/currency/language settings change between queue and replay | §6.2.3 | Payload stores the already-converted EUR number and explicit `lang` (`parseMoneyInputValue`, `CardScanner.jsx:81`); later setting changes do not alter queued items |
| 26 | Quota/capacity limit hit at replay (wishlist ≤ 99) | §6.2.7, D3 | 400 "cannot exceed 99" (`wishlist.py:22`) → `failed`; user adjusts or discards |
| 27 | Bulk operations partially failing | D3 | Not queued; multi-add = N independent single-add items each with its own key |
| 28 | Very large queues (hundreds) | §6.2.1 | ≤ 500 items; 30 req/min pacing ⇒ ~17 min for 500; list shows counts and the sheet scrolls; no per-item polling |
| **Storage** | | | |
| 29 | Private mode / IndexedDB unavailable | D14, §6.2.11 | `openOutboxDb` in try/catch → feature disabled, `sync.unavailableQueue`, app behaves as today |
| 30 | `QuotaExceededError` | D11, S11 | One transaction per enqueue: nothing partial; staged files stay in memory; `sync.storageFull` |
| 31 | Eviction while items pending | D12, S6 | Canary mismatch → blocking `sync.evicted`; warnings at 3/7 days when not installed |
| 32 | Safari tab vs installed app have separate stores | PF5 in §3.3, S15 | Items in the tab are invisible to the app; `sync.syncBeforeInstall` + install hint |
| 33 | Blob/File bugs on iOS | X2, D5, D11, §6.5.1 | `ArrayBuffer`-only storage; uploads from fresh in-memory Blobs; existing uploads hardened in P3 |
| 34 | Schema upgrade of the outbox | §6.2.11, S5 | Ordered in-transaction migrations; `versionchange` closes old connections; failure aborts and disables the queue without data loss |
| 35 | Corrupted records | §6.2.4 | Validation on read; invalid shape → shown as `failed(corrupted)` with Discard only; never auto-deleted |
| 36 | Crash mid-write | §6.2.2 | IndexedDB transactions are atomic; enqueue is one transaction |
| **Lifecycle** | | | |
| 37 | iOS suspends/kills the app mid-upload | §6.2.4 #7 | Claim expires → `retry_wait`, `maybeApplied=true`; same key on retry |
| 38 | Two tabs/windows replaying simultaneously | §6.2.9, S10 | Lease + per-item CAS + idempotency |
| 39 | New SW waiting while the user is mid-form | D9.4 | No auto-activation; *Update* disabled while a scan batch is staged or an item is `sending`; reload is safe because the queue is in IndexedDB |
| 40 | Stale shell + upgraded backend | D9.8, S12 | `features`/`api_level` from the probe gate queueing; `minApiLevel` per item |
| 41 | Old hashed chunk deleted after a deploy | D9.7 | Old SW's precache keeps serving; without SW `vite:preloadError` → banner/reload once |
| 42 | SW update-check frequency | D9.3, X5 | Navigation + foreground `update()` throttled to 30 min; `sw.js` is `no-cache` and registered with `updateViaCache:'none'` |
| 43 | Bad SW release | D9.9, S16 | Three-level kill switch; kill worker replaces the bad one; escape URL; in-app reset |
| 44 | First load while offline (nothing cached) | S17 | Nothing to serve; documented: open once online (HTTPS) first |
| **Security / privacy** | | | |
| 45 | Cached authenticated responses leaking across users | D8 | SW never caches authenticated `/api`; read cache keyed by origin and user id (`origin\|userId`), purged on logout; SW caches hold no user data |
| 46 | Outbox contains private photos | D7, A6, A7 | Deleted on success and on Discard; "delete items" at logout; Reset keeps them deliberately; other users' items never shown |
| 47 | XSS impact on persisted data | A12, `nginx.conf:16` | `script-src 'self'`; no tokens in IndexedDB; persisted data is the user's own and same-origin script could already read `localStorage['token']` today |
| 48 | Tokens readable by the SW or other origins | A12 | SW has no token access and never sees `Authorization`; replay runs in the page |
| 49 | Push payload contents | D15 | Title + card name + `/wishlist` only; encrypted; no collection data |
| 50 | `PUBLIC_MODE`/SEO crawlers | R7, D9.10 | `index.html`/`robots.txt` never precached; shell cached at runtime; crawlers do not run SWs |
| 51 | `/api/public` caching | D8 | Never handled by the SW (`must-revalidate`, `public.py:127`) |
| 52 | Backup restore with pending replays | §6.1.6, S19 | Restore deletes all idempotency rows; at worst a visible duplicate, never silent loss |
| **UX** | | | |
| 53 | User thinks data is saved when it is only local | D10, D12 | Banner + indicator + "only copy" sentence + `queued` chips; toast `sync.savedOffline` says "saved on this device" |
| 54 | Duplicate sync notifications | §6.4.4 | ≤ 1 summary toast / 60 s; one error toast per failed item |
| 55 | Failed items that never surface | §6.4.2 | ATTENTION state persists until each item is retried or discarded; counted on the indicator and Home |
| 56 | i18n coverage and `check:translations` | §6.4.3 | Literal `t('sync.*'/'pwa.*')` keys; parity test for `de`; `npm test` runs the checker |
| 57 | Accessibility of the indicators | §6.4.4 | Real buttons, text labels, `role="status"`, focus trap via `Modal`, colour not sole signal |
| 58 | Reduced motion | §6.4.4 | `motion-safe:` animations only |
| 59 | Offline screen when cached vs not | §6.4.1 | Cached route renders; otherwise `OfflineUnavailable` → `/offline`; no shell at all → the SW's inline bilingual page |
| 60 | HEIC photos | D11, X10 | Stored and uploaded unchanged; server decodes with `pillow-heif` |
| 61 | Lockdown Mode / no SW | X9, D14 | App works without SW; outbox independent |

---

## 8. Scenario traces

Notation: "Outbox" shows item states (`P`=pending, `S`=sending, `R`=retry_wait, `B`=blocked, `F`=failed). "Design change" records what each trace caused me to alter while drafting; where none was needed it says so.

### S1 — Scan 5 cards in a shop with no signal, then open the app on home Wi-Fi

| Step | Device | Outbox | Server | UI shown |
|---|---|---|---|---|
| 1 | Airplane mode; installed app opens; shell from SW; bootstrap fails → snapshot valid → degraded | empty | unreachable | Offline banner; `/search` allowed (scanner only) |
| 2 | Takes 5 photos (~3 MB each, 15 MB) with the camera input | empty | — | Staged grid 5/50 |
| 3 | Taps *Start scanning* → chunks `[3 photos 9 MB][2 photos 6 MB]` (next photo would exceed 10 MiB) | 2 × `P` (two transactions) | — | Toast "Saved on this device…", scanner closes, indicator WAITING(2) |
| 4 | Leaves the shop; iOS suspends the app | 2 × `P` | — | — |
| 5 | Home Wi-Fi; opens app; bootstrap OK; start: recover claims, probe | 2 × `P` | `GET /api/health` 200 | Banner clears |
| 6 | Replay: claim item 1 → `POST /cards/recognize/jobs` with key K1 + `X-Expected-User-Id`; 2 s pace; item 2 with K2 | `S`→gone, then `S`→gone | creates jobs 41, 42 (`expires_at` = now+14 d); records keys | Indicator SYNCING(2) → hidden; toast "Offline changes were synced." |
| 7 | Opens `/scans` | empty | jobs processing | Two jobs listed |

*Design change:* chunking makes several jobs, so the UI navigates to `/scans` rather than a single job when `jobIds.length > 1` (§6.5.2).

### S2 — The request reaches the server and commits, the response is lost, the app retries

| Step | Device | Outbox | Server | UI shown |
|---|---|---|---|---|
| 1 | Replay sends item (key K) | `S` (claim set) | `begin_idempotent` → no row; creates job 51; `record`; **commit** (row + job atomically) | Indicator SYNCING |
| 2 | Connection drops before the response; `fetch` rejects | `R`, `maybeApplied=true` | job 51 exists | WAITING, "Retrying soon" |
| 3 | Network returns; probe OK; replay with **same K** | `S` | row found, hash equal → returns stored 200 + `Idempotent-Replayed: true`; **no second job** | SYNCING |
| 4 | Response validated | gone → history | — | Synced toast |

*Design change:* the key row is written *before* the single commit, not after (no window between write and key); `maybeApplied` added so the UI can warn when something is stuck; `pc.debug.forceLostResponse` added to rehearse this on a real device (M-07).

### S3 — Token expires while offline; user returns after 3 days with items queued

| Step | Device | Outbox | Server | UI shown |
|---|---|---|---|---|
| 1 | Day 0 login (token exp day 7). Day 6 offline: 3 photos queued | 1 × `P` | — | WAITING(1) |
| 2 | Day 9 (3 days later), home Wi-Fi; app start; `/auth/me` → 401 (`isUnauthorized`, `authBootstrap.js:51`) → `clearSession` | 1 × `P` (untouched) | 401 | Login screen (multi-user) |
| 3 | User logs in as the **same** user → `loginUser` | `P` | `POST /auth/login` | App; `OfflineProvider` sees `user.id` → `syncNow('login')` |
| 4 | Replay with the **new** token | `S` → gone | creates job | Synced toast |
| 5 | Variant: a replay was attempted before login with the expired token | `S` → `B(auth)` → (login) → `P` | 401 | ATTENTION → cleared on login |

*Design change:* replay uses its own `fetch` so a 401 cannot trigger the axios redirect/token wipe (`client.js:29-34`) mid-replay; resume-on-login (#8) added.

### S4 — User A queues items and logs out; user B logs in on the same phone

| Step | Device | Outbox | Server | UI shown |
|---|---|---|---|---|
| 1 | A taps logout with 3 items; reachable | 3 × `P` (userId 3) | — | Dialog: Sync first / keep / delete / cancel |
| 2 | A chooses *keep* → token, user, snapshot removed; A's read cache purged; reload `/login` | 3 × `P` | — | Login |
| 3 | B (id 7) logs in | 3 × `P` (userId 3) | — | Sync sheet for B is empty; footer "Items for other accounts are waiting on this device" (count only) |
| 4 | Stale tab 1 still believes A and replays | claim → send with **B's token** + `X-Expected-User-Id: 3` | `409 wrong_account` (nothing written) | tab 1: `B(wrong_account)` |
| 5 | Later A logs in | `B`→`P` → sync | applies for A | A's items sync |

*Design change:* the server-side `X-Expected-User-Id` guard was added **because step 4 exists** (two tabs share one `localStorage` token); client-side filtering alone could not stop it.

### S5 — New app version with an outbox schema change is deployed while 10 items are pending

| Step | Device | Outbox | Server | UI shown |
|---|---|---|---|---|
| 1 | Phone runs v1 code; 10 × `P` (schema 1) | 10 × `P` | — | — |
| 2 | Foreground → `registration.update()`; new SW installs and **waits** | unchanged | new image live | Banner "A new version is available." |
| 3 | User taps *Update* (disabled while any item is `S`) → `SKIP_WAITING` → one guarded reload | unchanged | — | Reload |
| 4 | v2 opens DB version 2: `onupgradeneeded` migrates 10 items inside the upgrade transaction; an old tab (if any) gets `versionchange` and closes | 10 × `P` (schema 2) | — | — |
| 5 | Failure variant: migration throws | DB stays v1; queue disabled for the session | — | `/offline`: "Offline queue unavailable. Your saved data is preserved." |
| 6 | Replay resumes | → gone | applies | Synced toast |

*Design change:* no automatic `skipWaiting` (a mid-batch swap could otherwise run new code on old data); `versionchange` handling and abort-on-failure migrations; *Update* gated on staged scans and `sending` items.

### S6 — Safari evicts storage while 10 items are pending

| Step | Device | Outbox | Server | UI shown |
|---|---|---|---|---|
| 1 | Site used in a Safari **tab**, not installed; 10 × `P`; 8 days without opening | 10 × `P` | — | (3-day and 7-day warnings were shown earlier when the app was opened) |
| 2a | Case A: IndexedDB **and** localStorage wiped together, SW registration gone | none | — | Empty queue, no signal — undetectable by design |
| 2b | Case B: IndexedDB wiped, localStorage survives (canary mirror present, IndexedDB canary missing) | none | — | Blocking notice `sync.evicted` |
| 3 | What is recoverable | nothing on the device | nothing on the server | The photos only if they also exist in the device's Photos library (**U** for `capture` inputs); otherwise re-scan |

*Design change:* canary mirror, 3/7-day warnings for non-installed use, and the explicit sentence "the server copy is the only durable copy" (D12). Total wipes are an accepted, documented residual risk.

### S7 — A queued add fails permanently on replay in the middle of 20 items (also scan 400s)

| Step | Device | Outbox | Server | UI shown |
|---|---|---|---|---|
| 1 | 20 adds queued offline; reachable | 20 × `P` | — | WAITING(20) |
| 2 | Items 1–8 sent | 8 sent | applied | SYNCING |
| 3 | Item 9: `404 "Card … not available locally, from TCGdex…"` | item 9 `F` | no write | — |
| 4 | Items 10–20 continue (no head-of-line blocking) | 11 sent | applied | SYNCING |
| 5 | Done | 1 × `F` | — | Toast "Some items could not be synced…"; ATTENTION(1); sheet shows the server message + Retry/Edit/Discard |
| 6 | Scan variant: provider key missing → every item 400 "Gemini API key required" | items 1–3 `F`, **session stops**, items 4–20 stay `P` | 3 requests only | One shared reason; user fixes Settings → *Sync now* |

*Design change:* the **circuit breaker** (three identical failures end the session, §6.2.6 step 10) was added because step 6 would otherwise burn one request per item.

### S8 — Reverse-proxy SSO session expired: replay receives a login HTML page with status 200

| Step | Device | Outbox | Server | UI shown |
|---|---|---|---|---|
| 1 | Probe `GET /api/health` via the proxy | — | proxy returns 200 `text/html` login page | Banner "A network login page or proxy is answering…" (`captive`) |
| 2 | (Variant) probe passed earlier; replay `POST` gets a 302 to the IdP | claim | proxy | `redirect:'manual'` → `opaqueredirect` |
| 3 | Classification | item → `B(proxy)`; **not** dequeued; `maybeApplied=false` | app never reached | ATTENTION; text `sync.blockedProxy` |
| 4 | User opens the app normally, completes SSO | — | — | App loads |
| 5 | Probe returns JSON → `B(proxy)` → `P` → replay | → gone | applies | Synced toast |

*Design change:* `redirect:'manual'` and JSON content-type validation (never trust a 200); the service worker install path validates content types so a login page can never be cached as a script.

### S9 — Self-hoster on plain `http://192.168.1.x` (no service worker)

| Step | Device | Outbox | Server | UI shown |
|---|---|---|---|---|
| 1 | Safari tab over HTTP; `isSecureContext=false`, no `navigator.serviceWorker` | — | — | App identical to today (flags default off) |
| 2 | Operator enables `OFFLINE_QUEUE_ENABLED`; Offline center lists capabilities | IndexedDB opened (**U**, M-11) | — | "Not available" for SW/push/storage API; `pwa.httpsHint` |
| 3 | Page already open; user leaves the Wi-Fi; captures photos | `P` items | unreachable | Banner + WAITING |
| 4 | Returns to Wi-Fi with the page still open (or reopens it) | replay → gone | applies | Synced toast |
| 5 | Cold start while offline | — | — | Safari's own "cannot open page" (no SW possible) |

*Design change:* the outbox was made independent of the SW and of Web Locks/`crypto.randomUUID`/`navigator.storage` (all secure-context-only) precisely so step 3 works on HTTP; honest copy for step 5.

### S10 — Two tabs are open, both see "online" and start replaying

| Step | Device | Outbox | Server | UI shown |
|---|---|---|---|---|
| 1 | `online` event fires in tab A and tab B | 3 × `P` | — | — |
| 2 | A acquires the lease (`meta.lease`); B's acquire fails and returns | — | — | — |
| 3 | A sends items sequentially; B receives `BroadcastChannel` change events | `S`→gone ×3 | applies once each | Both tabs show the same sheet state |
| 4 | Variant: A is suspended mid-item X; lease expires after 30 s; B takes over, X's claim also expired → B claims X | X: `S`(A) → `R`+`maybeApplied` → `S`(B) | first send committed? replay; else applies once | — |
| 5 | A resumes and re-sends X with the same key | X | `Idempotent-Replayed` or `409 in_progress` → `R` | no duplicate |

*Design change:* none beyond the design — the lease is only an efficiency measure; item CAS + idempotency carry correctness (stated in D2).

### S11 — Taking the 40th offline photo hits the storage quota

| Step | Device | Outbox | Server | UI shown |
|---|---|---|---|---|
| 1 | 39 photos persisted (~120 MB) | 4 items | — | WAITING(4) |
| 2 | New batch of 3 photos (9 MB); `estimate()` says free < 9 MB + 100 MiB | refused before writing | — | Toast `sync.storageFull`; staged files stay |
| 3 | Browser without `estimate()` | transaction aborts on `QuotaExceededError` → nothing persisted for that chunk | — | Same toast |
| 4 | User syncs or discards, retries | items intact | — | Works |

*Design change:* preflight with `estimate()` plus the single-transaction write (no half-written items); a 300 MiB / 500-item app cap so one user cannot fill the device.

### S12 — Server upgraded with a changed API while an old cached frontend is open

| Step | Device | Outbox | Server | UI shown |
|---|---|---|---|---|
| 1 | Phone runs frontend F1 (old SW, old precache) | items `minApiLevel:1` | upgraded to `api_level:2` | — |
| 2 | User navigates to a never-visited page; chunk hash changed on the server | — | old chunk deleted | Old SW serves the chunk from its precache; without a SW, `vite:preloadError` → banner |
| 3 | Probe stores `serverInfo {apiLevel:2, features}` | eligible (`1 ≤ 2`) | — | — |
| 4 | Server rejects a payload with 422 | `F(validation)` | no write | Sheet shows the message; Edit/Discard |
| 5 | Reverse case: new frontend + old backend (no `features`) | enqueue refused; existing items `B(server_old)` | old API | `sync.serverTooOld` |
| 6 | User taps *Update* | reload on new build | — | Normal |

*Design change:* `/api/health` carries `version`/`api_level`/`features`, items carry `minApiLevel`, and `vite:preloadError` is handled — none existed in the first draft.

### S13 — Add a card offline, change its quantity offline, delete it offline, then reconnect (P9)

| Step | Device | Outbox | Server | UI shown |
|---|---|---|---|---|
| 1 | Add Pikachu ×1 from a cached card page | A `P` | — | Ghost row "queued" |
| 2 | Change quantity to 3 | A `P`, `payload.quantity=3` (local edit #12) | — | Ghost row shows ×3 |
| 3 | Delete it | A cancelled (#11) | — | Ghost row gone |
| 4 | Reconnect | empty | **no request** | Nothing to sync |
| 5 | Variant: user taps edit while A is `S` | A `S` | applying | Edit/Discard disabled ("Sending…") |
| 6 | Variant: user wants to edit a *server* row offline | — | — | Control disabled with "Needs a connection" |

*Design change:* edits/deletes of server rows are **not** queueable at all; edits of pending items never leave the device.

### S14 — Replaying 50 items trips the rate limiter (429 with or without Retry-After)

| Step | Device | Outbox | Server | UI shown |
|---|---|---|---|---|
| 1 | 50 × `P`; replay at 1 request / 2 s | 50 × `P` | `main`: one **shared** 60/min bucket for all users | SYNCING(50) |
| 2 | Other traffic (UI polling, another user) pushes the bucket over | item N claimed | slowapi middleware answers `429 {"error":"Rate limit exceeded…"}` **before** the route runs, no `Retry-After` | — |
| 3 | Engine pause 60 s (default; next 429 → 120 s … cap 900 s); item N back to `P`, no penalty | N `P` | nothing written | "Waiting for the server's rate limit" |
| 4 | Resume | continues | applies | SYNCING |
| 5 | If the limiter is keyed per client IP: a higher per-client limit | — | — | rarely triggers |

*Design change:* the default 60 s pause exists **because** slowapi sends no `Retry-After` (X13); the doubling prevents hammering; 429 is classed "definitely not applied".

### S15 — The user installs the PWA from Safari after queuing items in the Safari tab

| Step | Device | Outbox | Server | UI shown |
|---|---|---|---|---|
| 1 | Safari tab (not standalone): 4 items queued | tab storage: 4 × `P` | unreachable | Sheet shows `sync.safariWarning` and `sync.syncBeforeInstall` |
| 2 | Adds to Home Screen; iOS 17.2+ copies **cookies only** | app storage: empty | — | — |
| 3 | Opens the installed app: no token (it lives in `localStorage`), empty outbox | none | — | Login; sheet empty |
| 4 | Items remain in the Safari tab's storage | 4 × `P` (tab) | — | — |
| 5 | Opening the Safari tab on a reachable network | → replay → gone | applies | Synced |

*Design change:* the sentence `sync.syncBeforeInstall` and showing it *in the sheet while `!standalone`* were added because the isolation (PF5, V) makes this a silent trap.

### S16 — A faulty service worker has shipped; users recover without clearing site data

| Step | Device | Outbox | Server | UI shown |
|---|---|---|---|---|
| 1 | Release ships a SW bug; shell loads blank | untouched | — | Blank page |
| 2 | Operator sets `PWA_ENABLED=false`, `docker compose up -d frontend`; entrypoint copies `sw.kill.js` over `sw.js`, writes `sw=0` | — | `/sw.js` = kill worker (`no-cache`) | — |
| 3 | Phone: next navigation or 30-min foreground `update()` fetches `/sw.js`; bytes differ → kill worker installs (`skipWaiting`) → activates: deletes `pc-*` caches, unregisters, navigates its window clients | IndexedDB untouched | — | Page reloads from the network |
| 4 | Page boots with `sw=0` → `resetServiceWorker()` again (idempotent) | — | — | Working app |
| 5 | Fast path for one user | — | — | Open `/?pc_sw=off` (SW bypasses `pc_sw`; page unregisters, clears caches, strips the param) or *Offline center → Reset offline app data* |

*Design change:* the `?pc_sw=off` escape hatch and the "SW never handles `/sw*.js`" rule were added so a bad cached shell cannot block recovery; the kill worker lives at the same URL (no new registration needed).

### S17 — The service worker has never run (first-ever visit offline)

| Step | Device | Outbox | Server | UI shown |
|---|---|---|---|---|
| 1 | Fresh install of nothing; user opens the URL with no signal | — | — | Safari's own "cannot open the page" |
| 2 | Same for the Home Screen icon of an HTTP install (no SW possible) | — | — | Same |
| 3 | After one online visit over HTTPS | SW installed after load; first page uncontrolled until the next navigation | — | Offline start works from then on |

*Design change:* none possible (nothing can be cached before the first visit); `docs/PWA.md` states it plainly, and the SW deliberately does **not** call `clients.claim()` so the first visit is not altered.

### S18 — Lockdown Mode (service workers disabled, X9)

| Step | Device | Outbox | Server | UI shown |
|---|---|---|---|---|
| 1 | Lockdown Mode on; `'serviceWorker' in navigator` is false or registration is refused | — | — | App works online as today |
| 2 | Offline center lists capabilities | — | — | "Offline app start (service worker): Not available" |
| 3 | Offline capture while the page is open | IndexedDB allowed? (**U**) yes → `P` items; no → queue disabled | unreachable | WAITING, or `sync.unavailableQueue` |
| 4 | Server reachable again | replay → gone | applies | Synced toast |

*Design change:* none — treating the worker as progressive enhancement (D14) already covers it.

### S19 — Admin restores an older database backup while a phone holds a lost-response item

| Step | Device | Outbox | Server | UI shown |
|---|---|---|---|---|
| 1 | Earlier replays of K1–K5 succeeded | — | rows + keys recorded | — |
| 2 | One more item's response was lost (`maybeApplied`) | 1 × `R` (key K6) | K6 recorded with its write | WAITING |
| 3 | Admin restores a week-old dump (`restore_backup`) | 1 × `R` | business rows revert; **all idempotency rows deleted** after the restore | — |
| 4 | Phone replays K6 | `S` → gone | no row → applies again | Synced toast |
| 5 | Result | — | at worst a visible duplicate relative to the restored state; never a silent loss | — |

*Design change:* the post-restore `DELETE FROM idempotency_keys` (§6.1.6) comes from this trace — leaving stale keys would have replayed K6 as "already done" while its row no longer exists.

### S20 — Domain or port changes (e.g. `http://192.168.1.5:3000` → `https://cards.example.com`)

| Step | Device | Outbox | Server | UI shown |
|---|---|---|---|---|
| 1 | Old origin's storage holds 3 items | 3 × `P` (origin A) | — | WAITING (on origin A) |
| 2 | The install is moved to origin B; the user opens origin B | empty (new origin = new storage) | reachable | Sync sheet empty; no token (login needed) |
| 3 | Items stay on origin A until that page is opened again and can reach its server | 3 × `P` (origin A) | — | — |

*Design change:* none is technically possible; `docs/PWA.md` instructs "sync before changing the address", and the sheet footer shows `location.origin` so the user can see which install holds data.

### S21 — A user is deleted on the server while items are pending

| Step | Device | Outbox | Server | UI shown |
|---|---|---|---|---|
| 1 | Admin deletes user 3 (`api/auth.py:290-390`; `idempotency_keys` and scan rows cascade) | 3 × `P` (userId 3) | user gone | — |
| 2 | Phone replays | `S` → `B(auth)` | `401 "User not found or inactive"` | ATTENTION |
| 3 | Items can never succeed; only discarding while signed in as that user (impossible) or clearing the browser's site data removes them | 3 × `B` | — | Count shown to other accounts only |

*Design change:* none — an explicitly accepted orphan case (storage only; items are never replayed under another account).

---

## 9. Phased implementation plan

Phases P0–P8 and P10 were delivered as pull requests (P9 was not built; P11 is not part of this change). **One phase = one PR.** The plan is written so an implementer can execute each phase without making design decisions: every number, name, path and algorithm is fixed in §5–§6; where a phase says "per §6.x" the referenced section is normative.

### 9.1 Delivery

Each phase was delivered as one pull request, merged in order (P0, P1, P2, P3, P4, P5, P6, P7, P8, P10). A dependent phase started only after its prerequisites had merged; there were no stacked PRs. Each PR contains only its own phase; work that belongs to another phase is listed under "Follow-ups" in the PR description, not added.

#### 9.1.3 Phase map, ordering, conflicts

| Phase | Depends on (merged) | Migration | Version bump | PR title |
|---|---|---|---|---|
| P0 | — | no | no (docs-only) | `docs: add PWA offline sync design` |
| P1 | — | **yes** | no | `feat: add idempotency keys for offline-safe adds and scan uploads` |
| P2 | — | no | no | `feat: make PokéCollector installable on iPhone` |
| P3 | P2 | no | no | `feat: add opt-in service worker with kill switch` |
| P4 | P1 | no | no | `feat: add offline outbox core` |
| P5 | P4, P3 | no | no | `feat: keep the app usable offline with cached sign-in` |
| P6 | P5 | no | no | `feat: add sync center and offline banner` |
| P7 | P6, P3, P1 | no | no | `feat: save scan photos offline and upload when reachable` |
| P8 | P6 | no | no | `feat: show previously loaded data offline` |
| P9 *(not built)* | P7 | no | no | `feat: queue collection and wishlist adds offline` |
| P10 | P3, P1 | **yes** | no | `feat: web push for price alerts` |
| P11 *(not part of this change)* | P7, P3 | no | no | `feat: enable offline features by default` |

**Dependency edges:** P3←P2; P4←P1; P5←P4,P3 (P5 uses P3's `pwa/flags.js`, `playwright.pwa.config.js` and `docs/PWA.md`); P6←P5; P7←P6,P3,P1; P8←P6; P9←P7; P10←P3,P1; P11←P7,P3. **Longest chain = 6 PRs** (P1→P4→P5→P6→P7→P11, or P2→P3→P5→P6→P7→P11). **Merge order:** P0, P1, P2, P3, P4, P5, P6, P7, P8, P10 (P9 not built; P11 not part of this change). P7 and P8 are interchangeable after P6.

**Hard ordering:** the server idempotency PR **P1 (with its migration) must merge before any PR that adds client-side queueing** — P4, P7, P9 (enforced by the "Depends on" column).

**Parallelism.** Default: none. Two phases may run in parallel only if their "Files it touches" lists do not overlap and neither needs the other's output. Independent phases still share at least one file (for example P1 and P2 both edit `docs/DEPLOYMENT.md`; P7 and P8 both edit `docs/PWA.md` and `docs/FRONTEND.md`), and the migration PRs (P1, P10) must run alone because the migration list is one linear tail (`database.py:59-670`). Only P0 (a single file that no later phase edits; phases update `docs/PWA.md`, `FRONTEND.md`, `BACKEND.md`, `DEPLOYMENT.md`, `ARCHITECTURE.md`, `REVERSE_PROXY_AUTH.md` and the README) could run in parallel with the others.

Hot files that make the other phases sequential (✱ = touched):

|---|---|---|---|---|---|---|---|---|---|---|---|
| `backend/database.py`, `backend/models.py` | ✱ |  |  |  |  |  |  |  |  | ✱ |  |
| `backend/main.py` | ✱ |  |  |  |  |  |  |  |  | ✱ |  |
| `backend/api/collection.py` | ✱ |  |  |  |  |  |  |  |  |  |  |
| `frontend/nginx.conf`, `frontend/Dockerfile` |  | ✱ | ✱ |  |  |  |  |  |  |  | ✱ |
| `frontend/index.html` |  | ✱ |  |  |  |  |  |  |  |  |  |
| `frontend/package.json` + lock |  | ✱ | ✱ | ✱ |  |  |  |  |  |  |  |
| `frontend/src/api/client.js` |  |  | ✱ |  |  |  |  |  |  | ✱ |  |
| `frontend/src/App.jsx` |  |  | ✱ |  | ✱ | ✱ |  |  |  |  |  |
| `AuthContext.jsx` |  |  |  |  | ✱ |  |  |  |  |  |  |
| `AppNav.jsx`, `HomeScreen.jsx` |  | ✱ (AppNav) |  |  | ✱ |  |  |  |  |  |  |
| `Layout.jsx` |  |  |  |  |  | ✱ |  | ✱ |  |  |  |
| `UnifiedCardScanner.jsx` |  |  |  |  |  |  | ✱ |  |  |  |  |
| `CardItem.jsx`, `Collection.jsx`, `Wishlist.jsx` |  |  |  |  |  |  |  |  | ✱ |  |  |
| `i18n/en.js`, `i18n/de.js` |  |  | ✱ |  | ✱ | ✱ |  |  |  | ✱ |  |
| `frontend/src/sw/sw.js` |  |  | ✱ |  |  |  |  |  |  | ✱ |  |
| `docs/*` (various) | ✱ | ✱ | ✱ | ✱ | ✱ | ✱ | ✱ | ✱ | ✱ | ✱ | ✱ |

#### 9.1.4 Version bump and release files
- **Rule for the phase PRs: no version bumps.** Phase PRs leave every VERSION-SET file unchanged; the release that ships the work bumps the version once (`node scripts/check-version.mjs` must still pass; it only checks that the files agree with `VERSION`, `scripts/check-version.mjs:5-46`). `version-check.yml` still runs on PRs that touch one of its listed files, such as `docker-compose.yml` in P3 (`version-check.yml:4-15`).
- **Repository convention:** every merged *code* PR bumps `VERSION` (12 of 12 sampled commits); docs-only PRs do not. `release.yml` publishes images when `VERSION` changes on `main` (`release.yml:3-9`). `CONTRIBUTING.md:30-35` asks to run `node scripts/check-version.mjs` and both `docker compose … config --quiet` for such changes.
- **VERSION-SET (all must be updated together):** `VERSION`; `README.md` (the badge `version-vX.Y.Z-` at line 21 and the text `Current version: vX.Y.Z` at line 23); `docker-compose.yml` (the two `${POKECOLLECTOR_VERSION:-X.Y.Z}` image lines, `:35`/`:81` region); `.env.example` (comment `# POKECOLLECTOR_VERSION=X.Y.Z`); `frontend/package.json` (`version`); `frontend/package-lock.json` (top-level `version` and `packages[""].version`); `docs/DEPLOYMENT.md` (the two example versions, `:20` and `:31` region). Verify with `node scripts/check-version.mjs`.
- P0 changes none of these.

#### 9.1.5 Shared-resource hazards when testing
- **Docker Compose clashes.** `docker-compose.yml` hard-codes `container_name: pokemon-postgres` (`:4`), `pokemon-backend` (`:36`), `pokemon-frontend` (`:82`), so two stacks on one Docker host collide even with different project names or ports. Run one compose stack at a time, or use an override file kept outside the repository that renames the three containers, plus `COMPOSE_PROJECT_NAME`, `FRONTEND_PORT` and `BACKEND_PORT` (`.env.example:50-51`). Do not edit the port mappings in `docker-compose.yml` (`scripts/check-compose-ports.mjs` guards them).
- **Postgres-gated backend tests** need their own throw-away server on a free port: `docker run --rm -d --name pcp01-pg -p 55401:5432 -e POSTGRES_PASSWORD=test postgres:18-alpine`, then `DATABASE_URL=postgresql://postgres:test@127.0.0.1:55401/postgres IDEMPOTENCY_POSTGRES_TEST=1 python -m unittest tests.test_idempotency_postgres` (run from `backend/`). Backend unit tests otherwise use in-memory SQLite.
- **Line endings:** shell scripts must be LF; a Windows checkout with `core.autocrlf=true` would otherwise break them inside the container (P3 adds `.gitattributes`; until then verify with `git ls-files --eol`).
- **Playwright browsers** are installed per machine (`npx playwright install --with-deps chromium webkit`); use a distinct preview port if two runs overlap.

### 9.2 Phase definitions

Conventions used below: **VERSION-SET** = the seven files in §9.1.4; no phase changes them. "Per §x" means that section is normative. Every code phase still runs `node scripts/check-version.mjs`.

---

#### P0 — The design document (docs-only)

**Phase facts**
- Depends on: none
- Files it touches: `docs/PWA_OFFLINE_DESIGN.md`
- Needs a migration: no. Needs a version bump / release-file change: **no** (docs-only precedent: `dffaab1`, #411)
- PR title: `docs: add PWA offline sync design`

**Goal.** Put this document in the repository so later PRs can cite it.
**Acceptance.** The diff is one new file and the status note at the top is present (`CONTRIBUTING.md:40-41`).
**Tests / docs / rollback.** None / none / revert the PR.

---

#### P1 — Server idempotency keys (migration; runs alone)

**Phase facts**
- Depends on: none
- Safe to run in parallel with: none
- Files it touches: **create** `backend/services/idempotency.py`, `backend/services/api_info.py`, `backend/tests/test_idempotency.py`, `backend/tests/test_idempotency_postgres.py`; **modify** `backend/models.py`, `backend/database.py`, `backend/api/collection.py`, `backend/api/wishlist.py`, `backend/api/scan_jobs.py`, `backend/services/scan_storage.py`, `backend/services/scheduler.py`, `backend/main.py`, `backend/api/backup.py`, `docs/BACKEND.md`, `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`
- Needs a migration: **yes** (`idempotency_keys`) — must run alone. Version bump: **no**
- PR title: `feat: add idempotency keys for offline-safe adds and scan uploads`

**Goal.** Make the three append operations exactly-once under retries (§6.1). No client change; absent header ⇒ identical behaviour.
**Tasks (in order).**
1. `models.py`: add `IDEMPOTENCY_JSON` and `IdempotencyKey` exactly as §6.1.2.
2. `database.py`: append **two** entries (`CREATE TABLE IF NOT EXISTS idempotency_keys …`, `CREATE INDEX IF NOT EXISTS ix_idempotency_keys_expires_at …`) at the **end** of the `migrations` list.
3. `services/api_info.py`: `API_LEVEL = 1`, `API_FEATURES = ("idempotency-v1",)`.
4. `services/idempotency.py`: implement the API in §6.1.3 (constants, `StoredResponse`, `IdempotencyContext`, `begin_idempotent`, `fingerprint_json`, `digest_uploads`, `fingerprint_scan`, `replay_response`, `purge_expired_idempotency_keys`). Error `HTTPException`s use `detail={"code": "...", "message": "..."}`; `idempotency_in_progress` also sets `headers={"Retry-After": "2"}`.
5. `api/collection.py`: add `request: Request` to `add_to_collection` and restructure it exactly as §6.1.4 (inactive context = the two original statements unchanged). Import `Request` from `fastapi`, `jsonable_encoder` from `fastapi.encoders`.
6. `api/wishlist.py`: same shape for `add_to_wishlist` with scope `wishlist.add` and `WishlistItemResponse`.
7. `services/scan_storage.py`: add `before_commit: Callable[[ScanJob], None] | None = None` to `create_scan_job`; call it after `db.flush()` and immediately before `db.commit()` (`:269`).
8. `api/scan_jobs.py`: extract `_requested_individual_positions(raw, file_count)` (existing logic `:130-140`); add `request: Request`; implement the keyed path of §6.1.4 (positions → `digest_uploads` → `begin_idempotent` → replay return → existing provider checks → `create_scan_job(..., before_commit=hook)`); the keyless path must remain byte-for-byte the current order of checks.
9. `services/scheduler.py`: `run_idempotency_cleanup()` + registration per §6.1.5.
10. `main.py`: extend `/api/health` and CORS `allow_headers` per §6.1.7.
11. `api/backup.py`: after the success path of `restore_backup`, best-effort `DELETE FROM idempotency_keys` per §6.1.6.
12. Tests per §6.1.8.
13. Docs: `docs/BACKEND.md` — new "Idempotency" subsection (headers, error table, scopes, TTL, health fields; add the table to the model list; state that `bulk-add`/`import-csv` ignore the header); `docs/ARCHITECTURE.md` — add `IdempotencyKey` to the key-model list and one line under "Migration Notes"; `docs/DEPLOYMENT.md` — one sentence: restore clears idempotency keys, also after a manual `psql` restore (`DELETE FROM idempotency_keys;`).
14. No version bump.

**Acceptance criteria.**
- `cd backend && python -m unittest discover -s tests -p 'test_*.py'` passes (new tests included; Postgres test skipped without the env flag).
- With the Postgres test enabled against a throw-away server: passes, including the two-thread duplicate test.
- Manual (any card id present): the same `POST /api/collection/` twice with header `Idempotency-Key: 11111111-1111-4111-8111-111111111111` returns identical bodies, the second carries `Idempotent-Replayed: true`, and the row's `quantity` increased **once**; the same key with a different body → `422` with `detail.code == "idempotency_key_reused"`; without the header, quantity increases each call (unchanged behaviour).
- `GET /api/health` contains `version`, `api_level: 1`, `features: ["idempotency-v1"]`.
- Starting the backend on an existing database creates the table (check `\d idempotency_keys`); a pre-upgrade backup file is produced as usual.
**Tests to add.** §6.1.8.
**Docs to update.** Above (task 13).
**Rollback.** Revert the PR/pin the previous image; the extra table is harmless (optionally `DROP TABLE idempotency_keys`).

---

#### P2 — Installability and iOS polish (no service worker yet)

**Phase facts**
- Depends on: none (P1 is not required)
- Safe to run in parallel with: none
- Files it touches: **create** `frontend/public/icons/pc-icon-192-v3.png`, `pc-icon-512-v3.png`, `pc-maskable-192-v3.png`, `pc-maskable-512-v3.png`, `pc-apple-touch-180-v3.png`, `frontend/nginx-security-headers.conf`, `frontend/scripts/pwa-assets.test.mjs`, `frontend/scripts/nginx-config.test.mjs`; **modify** `frontend/public/manifest.json`, `frontend/index.html`, `frontend/nginx.conf`, `frontend/Dockerfile`, `frontend/src/components/AppNav.jsx`, `frontend/package.json` (test script), `docs/REVERSE_PROXY_AUTH.md`, `docs/FRONTEND.md`, `README.md`, `docs/DEPLOYMENT.md`
- Needs a migration: no. Version bump: **no**
- PR title: `feat: make PokéCollector installable on iPhone`

**Goal.** Correct manifest, icons, iOS meta and safe-area polish; correct HTTP caching for HTML/manifest; shared nginx security-header snippet. Zero runtime JavaScript change.
**Tasks (in order).**
1. **Icons.** Create the five PNGs under `frontend/public/icons/`; keep the old icon files untouched (they stay referenced by `og:image` in `40-configure-public-mode.sh:27,:31`, and by SSO allow-lists). Recipe (ImageMagick 7, run from the repo root; any tool producing the same properties is acceptable, the node test is the contract):
```bash
magick -background none -density 600 frontend/public/pokeball.svg -resize 192x192 frontend/public/icons/pc-icon-192-v3.png
magick -background none -density 600 frontend/public/pokeball.svg -resize 512x512 frontend/public/icons/pc-icon-512-v3.png
magick -size 192x192 xc:'#08080f' \( -background none -density 600 frontend/public/pokeball.svg -resize 134x134 \) -gravity center -composite -alpha off PNG24:frontend/public/icons/pc-maskable-192-v3.png
magick -size 512x512 xc:'#08080f' \( -background none -density 600 frontend/public/pokeball.svg -resize 358x358 \) -gravity center -composite -alpha off PNG24:frontend/public/icons/pc-maskable-512-v3.png
magick -size 180x180 xc:'#08080f' \( -background none -density 600 frontend/public/pokeball.svg -resize 140x140 \) -gravity center -composite -alpha off PNG24:frontend/public/icons/pc-apple-touch-180-v3.png
```
   (Maskable ball ≈ 70 % of the canvas; Apple touch ball ≈ 78 %, opaque.)
2. `manifest.json`: replace with the JSON in D13 (keep the existing `description` text).
3. `index.html`: replace the three icon `<link>`s (`:8-10`) with `/pokeball.svg`, `/favicon-48.png` (no `?v=2`) and `<link rel="apple-touch-icon" sizes="180x180" href="/icons/pc-apple-touch-180-v3.png">`; set `theme-color` to `#08080f`; add the four meta tags from D13 (`apple-mobile-web-app-capable`, `mobile-web-app-capable`, `apple-mobile-web-app-title`, `apple-mobile-web-app-status-bar-style=black`).
4. `nginx-security-headers.conf`: the five lines of §6.3.5, verbatim from `nginx.conf:12-16`.
5. `nginx.conf`: replace lines 12-16 with `include /etc/nginx/snippets/pc-security-headers.conf;`; add the `location = /index.html`, `location = /manifest.json` and updated `location /` blocks and add `include` to the static-asset regex block, **exactly** as §6.3.5 (the `sw` block is **not** added in this phase).
6. `Dockerfile`: `COPY frontend/nginx-security-headers.conf /etc/nginx/snippets/pc-security-headers.conf` next to the existing `COPY … default.conf` (`:21`).
7. `AppNav.jsx`: home button (`:118`) → positioning via `style={{ bottom: 'max(1.5rem, env(safe-area-inset-bottom))', left: 'max(1rem, env(safe-area-inset-left))' }}` (drop `bottom-6 left-4`); top strip (`:84`) padding-top → `max(1.25rem, env(safe-area-inset-top))` (replace `pt-5`).
8. `scripts/pwa-assets.test.mjs` (node:test): parse `manifest.json`; assert `id`, `scope`, `display`, `start_url`, all icon `src` start with `/icons/`, contain no `?`, exist on disk; read each PNG's IHDR (width, height, colour type) and assert declared `sizes` match; `pc-apple-touch-180-v3.png` has colour type 2 (no alpha); assert `index.html` has no `?v=` and contains the four meta tags. `scripts/nginx-config.test.mjs`: assert the snippet exists and contains `Content-Security-Policy` with `script-src 'self'`; `nginx.conf` has `include … pc-security-headers.conf` at server level and in each location that contains `add_header`; the `index.html`, `manifest.json` and `/` locations contain `no-cache`.
9. `package.json`: extend `"test"` to also run `node --test scripts/pwa-assets.test.mjs scripts/nginx-config.test.mjs`.
10. Docs: `docs/REVERSE_PROXY_AUTH.md` — add `/icons/*` to the public-route table and to **both** Authentik regex blocks (`^/icons/.*$`, and the full-URL variant); `docs/FRONTEND.md` — short "Installable web app" section (manifest, icons, iOS meta, standalone detection); README feature bullet.
11. No version bump.

**Acceptance criteria.**
- `cd frontend && npm test && npm run build` pass.
- `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build frontend` (with a unique port per §9.1.5), then: `curl -sI http://127.0.0.1:$FRONTEND_PORT/` shows `Cache-Control: no-cache` **and** the CSP header; same for `/manifest.json` and a deep link such as `/collection` (SPA fallback); a hashed `/assets/*.js` shows `public, immutable` **and** now also the CSP header.
- Manual: M-01 and M-02 (§10.3) on an iPhone (install, icon, safe areas).
**Tests to add.** The two node tests (task 8).
**Docs to update.** Task 10.
**Rollback.** Revert; old icon URLs and `?v=2` references still exist in the previous release.

---

#### P3 — Opt-in service worker, kill switch, update banner, upload hardening

**Phase facts**
- Depends on: P2
- Safe to run in parallel with: none
- Files it touches: **create** `frontend/src/sw/sw.js`, `frontend/src/sw/sw.kill.js`, `frontend/src/sw/sw.test.js`, `frontend/scripts/build-sw.mjs`, `frontend/scripts/build-sw.test.mjs`, `frontend/scripts/serve-pwa-test.mjs`, `frontend/scripts/configure-pwa.test.mjs`, `frontend/src/pwa/flags.js`, `frontend/src/pwa/register.js`, `frontend/src/components/pwa/UpdateBanner.jsx`, `frontend/src/utils/memoryBlob.js`, `frontend/src/utils/memoryBlob.test.js`, `frontend/docker-entrypoint.d/45-configure-pwa.sh`, `frontend/playwright.pwa.config.js`, `frontend/tests/pwa/service-worker.spec.js`, `.gitattributes`, `docs/PWA.md`; **modify** `frontend/package.json`, `frontend/vite.config.js`, `frontend/src/main.jsx`, `frontend/src/App.jsx`, `frontend/src/api/client.js`, `frontend/src/i18n/en.js`, `frontend/src/i18n/de.js`, `frontend/nginx.conf`, `frontend/Dockerfile`, `docker-compose.yml`, `.env.example`, `.github/workflows/frontend-card-system.yml`, `docs/FRONTEND.md`, `docs/DEPLOYMENT.md`, `docs/REVERSE_PROXY_AUTH.md`, `README.md`
- Needs a migration: no. Version bump: **no**
- PR title: `feat: add opt-in service worker with kill switch`

**Goal.** Offline app shell and asset caching behind `PWA_ENABLED` (default **off**), with the kill switch, update flow and the iOS upload hardening (F1). With the flag off, runtime behaviour is unchanged except the HTML/`sw.js` headers from P2/P3.
**Tasks (in order).**
1. `pwa/flags.js` per §6.3.4 (`readPwaFlags()`).
2. `utils/memoryBlob.js` per §6.5.1 and make the six multipart functions in `client.js` `async` and use it (keep filenames).
3. `sw/sw.js` per §6.3.1–§6.3.3 (placeholders, install/activate/fetch/message handlers, pure helper functions at top level so the `vm` test can reach them via `globalThis.__PC_SW_TEST__` when `self.__PC_SW_TEST_MODE__` is set).
4. `sw/sw.kill.js` per §6.3.4.
5. `scripts/build-sw.mjs` per §6.3.1; `package.json`: `"build": "vite build && node scripts/build-sw.mjs"`, add `"test:pwa": "playwright test --config=playwright.pwa.config.js"`, extend `"test"` with the new node tests (`build-sw.test.mjs`, `configure-pwa.test.mjs`).
6. `vite.config.js`: `define: { __PWA_DEFAULT__: JSON.stringify(process.env.VITE_PWA_DEFAULT === 'on' ? 'sw=1;queue=1' : 'sw=0;queue=0') }` added next to `__APP_VERSION__`.
7. `pwa/register.js` per §6.3.4 and `components/pwa/UpdateBanner.jsx` (uses `pwa.updateAvailable`, `pwa.updateNow`, `pwa.updateBlocked`; shown as a non-blocking bar at the bottom, above the safe area).
8. `main.jsx`: after the `render(...)` call, `initServiceWorker({flags: readPwaFlags(), onUpdateReady})` with a tiny store so `UpdateBanner` (mounted once in `App.jsx`) can show; add the `vite:preloadError` listener.
9. `nginx.conf`: add the `location ~ ^/sw(\.real|\.kill)?\.js$` block **before** the static-asset regex (§6.3.5).
10. `45-configure-pwa.sh` verbatim from §6.3.5; `Dockerfile`: `COPY` it and extend the existing `chmod +x` (`:24-25`); `docker-compose.yml` frontend `environment:` gains `PWA_ENABLED: ${PWA_ENABLED:-}` and `OFFLINE_QUEUE_ENABLED: ${OFFLINE_QUEUE_ENABLED:-}`; `.env.example`: two commented lines with explanations.
11. `.gitattributes`: `*.sh text eol=lf`.
12. Playwright harness: `scripts/serve-pwa-test.mjs` (Node, cross-platform) runs `npm run build` with `VITE_PWA_DEFAULT=on` (via `execSync(..., {stdio:'inherit', env:{...process.env, VITE_PWA_DEFAULT:'on'}})`), then starts `preview()` from the `vite` package on `127.0.0.1:4175` with `strictPort`; `playwright.pwa.config.js`: `testDir: './tests/pwa'`, `outputDir: './test-results-pwa'`, `workers: 1`, `use.baseURL: 'http://127.0.0.1:4175'`, `webServer: {command: 'node scripts/serve-pwa-test.mjs', url: 'http://127.0.0.1:4175', reuseExistingServer: !process.env.CI, timeout: 240000}`, and the project `chromium-sw` (`devices['Desktop Chrome']`, `serviceWorkers: 'allow'`, `testMatch: /service-worker\.spec\.js/`). Later phases add the `chromium-page` and `webkit-page` projects (`serviceWorkers: 'block'`).
13. Tests (below).
14. `.github/workflows/frontend-card-system.yml`: after "Run WebKit card-list regression test" add the step "Run PWA service-worker tests (Chromium)" = `npm run test:pwa` (browsers are already installed by the existing step).
15. Docs: new `docs/PWA.md` (install on iPhone, HTTPS requirement and options, the two flags, kill switch L1–L3 with the exact `/?pc_sw=off` URL, privacy statement "the service worker caches no user data", limitations incl. first visit and plain HTTP); `docs/FRONTEND.md` (service-worker build, file map, how to test), `docs/DEPLOYMENT.md` (headers, entrypoint order, flags, rollback), `docs/REVERSE_PROXY_AUTH.md` (optionally allow `/sw.js` for anonymous public pages), README env table + feature bullet + docs table link.
16. i18n: `pwa.updateAvailable`, `pwa.updateNow`, `pwa.updateBlocked` in `en.js` and `de.js` (§6.4.3).
17. No version bump.

**Acceptance criteria.**
- `npm test` (includes node tests and the vm-harness test) and `npm run build` pass; the build prints the precache size and exits non-zero above 12 MiB; `dist/sw.real.js` has no `import ` statements and no remaining `__` placeholders.
- `npm run test:pwa` (Chromium): (a) first load registers the SW; after reload it controls the page and `pc-precache-*` contains every `dist/assets/*` file and **no** `index.html`/`robots.txt`; (b) with the API mocked, `context.setOffline(true)` + reload renders the shell (the app shows its connection screen, no blank page); (c) page `/api/*` requests are not served by the SW (`response.fromServiceWorker() === false`); (d) update: overwrite `dist/sw.js` with a byte-different copy, call `registration.update()`, assert the banner appears and *Update* activates the new worker after one reload; (e) kill switch: copy `dist/sw.kill.js` over `dist/sw.js`, update → registration gone and no `pc-*` caches remain, IndexedDB untouched; (f) `/?pc_sw=off` unregisters and strips the parameter.
- Container: with `PWA_ENABLED` unset, `curl http://127.0.0.1:$FRONTEND_PORT/` contains `sw=0;queue=0`, and `/sw.js` equals `sw.kill.js`; with `PWA_ENABLED=true` it contains `sw=1` and `/sw.js` equals `sw.real.js`; with `PUBLIC_MODE=true` both the SEO tags **and** the flags meta are present exactly once (proves `45-` runs after `40-`); `curl -sI /sw.js` shows `Cache-Control: no-cache` and a `Content-Type` containing `javascript`.
- Manual: M-01, M-03, M-09, M-10, M-16, M-17 (§10.3).
**Tests to add.** `sw.test.js` (§6.3.6), `build-sw.test.mjs` (fixture `dist/` → manifest contents, exclusions, placeholder replacement, budget failure), `configure-pwa.test.mjs` (pattern of `configure-public-mode.test.mjs`: temp dir, `execFileSync('sh', [script])`, env matrix `true/false/invalid/empty`, idempotent across two runs after re-copying the template), `memoryBlob.test.js`, Playwright `service-worker.spec.js` (above).
**Docs to update.** Task 15.
**Rollback.** `PWA_ENABLED=false` (default) + restart frontend (kill worker removes any installed worker); or revert/pin the previous image.

---

#### P4 — Outbox core (library + tests, no UI, not wired)

**Phase facts**
- Depends on: P1 (server contract must exist before any queueing code ships)
- Safe to run in parallel with: none
- Files it touches: **create** `frontend/src/offline/constants.js`, `capabilities.js`, `uuid.js`, `debug.js`, `outbox/{db,store,states,classify,probe,backoff,lease,replay,events,index}.js`, `outbox/ops/{scanUpload,collectionAdd,wishlistAdd}.js` and a `*.test.js` beside each; **modify** `frontend/package.json`, `frontend/package-lock.json` (devDependency), `docs/FRONTEND.md`, `docs/ARCHITECTURE.md`
- Needs a migration: no. Version bump: **no**
- PR title: `feat: add offline outbox core`

**Goal.** The complete, tested client library of §6.2. Nothing imports it yet, so it is not in the production bundle (Vite bundles only imported modules): shipping it cannot change runtime behaviour.
**Tasks (in order).**
1. `npm install -D --save-exact fake-indexeddb@6.2.5` (Apache-2.0, zero runtime dependencies, Node ≥ 18 — verified 2026-10-16); run `npm audit --omit=dev` (must not worsen) and commit the lockfile change.
2. `constants.js`: every constant of §6.2.1 as named exports (`OUTBOX_DB_NAME`, `PROBE_TIMEOUT_MS`, …, and `uploadTimeoutMs(bytes)` implementing the clamp formula).
3. `uuid.js`: `uuidv4()` from `crypto.getRandomValues` (set version/variant bits); never `randomUUID`.
3b. `debug.js`: `applyDebugParams()` and `debugFlag(name)` exactly as the "Debug flags" paragraph of §6.2.6 (fixed allow-list `forceUnreachable|forceQuota|forceLostResponse`; `?pc_debug=a,b` sets, `?pc_debug=off` clears, parameter stripped with `history.replaceState`; every storage access in try/catch) plus `debug.test.js`.
4. `capabilities.js`: `getCapabilities()` → `{secureContext, serviceWorker, indexedDB, storageManager, standalone, push}` using only feature detection (`window.isSecureContext`, `'serviceWorker' in navigator`, `typeof indexedDB`, `navigator.storage?.persist`, `isStandalone()`, `pushSupported()` per §6.7.2).
5. `outbox/backoff.js` (§6.2.10), `outbox/states.js` (transition table of §6.2.4 as data + `canTransition(from, to, actor)`), `outbox/events.js` (BroadcastChannel with `storage`-event fallback; `publish()`, `subscribe(cb)`).
6. `outbox/db.js` (§6.2.2, §6.2.11): `openOutboxDb({indexedDB})`, `migrations`, `versionchange` handler.
7. `outbox/store.js`: `enqueue`, `listItems(ctx)`, `getItem`, `claimNext(ctx, owner, now)`, `applyOutcome(id, owner, outcome, now)`, `recoverStaleClaims(owner, now)`, `editPending`, `discard`, `readPhotos(id)` (async iterator, one `ArrayBuffer` at a time), `totals()`, `addHistory`, `trimHistory`. All writes are single transactions; all state changes are compare-and-set on `state`/`claim.owner`.
8. `outbox/lease.js` (§6.2.9). 9. `outbox/probe.js` (§6.2.8). 10. `outbox/classify.js` (table of §6.2.7 as data; `classifyResponse(opType, {error, response, json})`).
11. `outbox/ops/*.js`: `{type, buildRequest, validateResponse, summarize, onSynced}` per §6.2.12 (`scanUpload` builds `FormData` from `readPhotos` with fresh in-memory Blobs and **no** `Content-Type`).
12. `outbox/replay.js`: the algorithm of §6.2.6 including the circuit breaker, the 429 pause, `maybeApplied` handling and the debug flags.
13. `outbox/index.js`: `createOutbox(...)` with the surface of §6.2.12.
14. Tests (below). 15. Docs: `docs/FRONTEND.md` "Offline outbox" section (module map, state table, constants, debug flags) and `docs/ARCHITECTURE.md` (frontend state layer list gains "Outbox: IndexedDB + replay engine"). 16. No version bump.

**Acceptance criteria.** `cd frontend && npm test && npm run build` pass; `dist/` does not contain the strings `pokecollector-outbox` (proof that nothing imports the library yet).
**Tests to add** (`import 'fake-indexeddb/auto'`, node environment, injected `fetch`/`now`/`rng`/`sleep`):
- *uuid*: format, 10 000 unique values, works with `crypto.randomUUID` deleted.
- *db/store*: enqueue is one transaction (inject an error on the photos `put` → no item row remains); `QuotaExceededError` injected → rejects `{code:'quota'}`, nothing persisted; two concurrent `claimNext` calls on one database claim distinct items and never the same one; stale-claim recovery sets `retry_wait` + `maybeApplied`; `discard` removes photos; `listItems` returns no binary fields; **assert every stored binary value is an `ArrayBuffer` (never Blob/File)**; filter by `userId` and `serverOrigin`; schema upgrade: build a synthetic v1 DB, open with a test `migrations` map containing a v2 step, assert no item/photo lost and an aborting migration leaves v1 intact; `versionchange` closes the connection.
- *states/classify*: one test per row of §6.2.4 and §6.2.7 (including HTML 200, opaque redirect, 429 with/without `Retry-After`, 409 variants, 502/503/504, malformed 2xx JSON).
- *backoff*: bounds and monotonic cap with a seeded RNG; `parseRetryAfter` for seconds, HTTP-date, garbage, negative.
- *probe*: reachable; HTML → `captive`; wrong JSON → `captive`; timeout → `unreachable`; records `serverInfo`.
- *lease*: acquire/renew/expire/steal-after-expiry; two engines → one runs.
- *replay*: success path with `Idempotency-Key` and `X-Expected-User-Id` headers and `redirect:'manual'`; lost response (server "applied", client sees a network error) → second attempt reuses the **same key**; 401 → `blocked(auth)` and the loop stops; 429 → pause with default 60 s and doubling, item `pending`; 12 consecutive 500s → `failed`; three identical failures → circuit breaker, remaining items stay `pending`; wrong-user and wrong-origin items are skipped; FIFO order; a poison item does not block later items; pacing uses the injected `sleep(PACE_MS)`; `maybeApplied` older than 12 days → `failed(outcome_unknown_stale)`; `forceLostResponse` debug flag.
**Docs to update.** Task 15.
**Rollback.** Revert; nothing depends on it.

---

#### P5 — Cached sign-in (degraded mode), outbox provider, logout guard

**Phase facts**
- Depends on: P4, P3
- Safe to run in parallel with: none
- Files it touches: **create** `frontend/src/offline/authSnapshot.js`, `authSnapshot.test.js`, `OfflineProvider.jsx`, `useOutbox.js`, `frontend/src/components/sync/LogoutGuardDialog.jsx`, `frontend/tests/pwa/offline-auth.spec.js`; **modify** `frontend/src/contexts/AuthContext.jsx`, `frontend/src/App.jsx`, `frontend/src/components/AppNav.jsx`, `frontend/src/pages/HomeScreen.jsx`, `frontend/src/i18n/en.js`, `frontend/src/i18n/de.js`, `frontend/playwright.pwa.config.js`, `docs/PWA.md`, `docs/FRONTEND.md`
- Needs a migration: no. Version bump: **no**
- PR title: `feat: keep the app usable offline with cached sign-in`

**Goal.** The app opens offline for a previously signed-in user, the outbox is owned by a provider, and logout can no longer strand unsynced items silently (D7, §6.6). All behaviour is inert unless `flags.queue` is on **or** a valid snapshot exists with the flag on (the snapshot is written regardless but only *used* when `flags.queue`).
**Tasks (in order).**
1. `authSnapshot.js` per A5: `writeAuthSnapshot({multiUser, locked, user})`, `readAuthSnapshot({token, now})` → snapshot or `null` (validity rules of A5), `clearAuthSnapshot()`; storage key `pc.auth.snapshot`; every access in try/catch.
2. `AuthContext.jsx`: write the snapshot after a successful bootstrap and in `loginUser`; clear it in `logout` and when `result.clearSession` applies; in the bootstrap `catch` (`:48-56`): if `flags.queue` and a valid snapshot exists → `setUser(snapshot.user)`, `setMultiUser(snapshot.multiUser)`, `setModeLocked(snapshot.locked)`, `setAuthStatus('degraded')`; else the existing `'offline'` branch. Keep the retry timer in both branches. `loading = authStatus === 'loading' || authStatus === 'offline'` (so `'degraded'` is not loading); expose `status` and `offline = authStatus === 'degraded' || authStatus === 'offline'` in the context value.
3. `useOutbox.js` and `OfflineProvider.jsx` per §6.2.12: when `flags.queue && capabilities.indexedDB` build the outbox with `ctx` from `useAuth()` (`{userId: user?.id, origin: location.origin}`) and the app `queryClient` (`useQueryClient`); start it when `status` is `ready` or `degraded` and `user` exists; call `applyDebugParams()` once at mount; listeners for `visibilitychange`, `online`, `pageshow`, a `REPLAY_TICK_MS` timer while visible; `syncNow('login')` when `user.id` changes to a number; bridge reachability to `onlineManager.setOnline`; otherwise render children untouched. Mount it in `App.jsx` inside `SettingsProvider` and above `ConfirmDialogProvider` (`App.jsx:201-203`).
4. **Logout guard.** `logout()` is called from `AppNav.jsx:71` **and** `HomeScreen.jsx:295` (plus the unused `BottomNav`/`Sidebar`), so the guard lives in `AuthContext`, not in the callers: add `const logoutGuardRef = useRef(null)`; expose `setLogoutGuard(fn)` in the context value; make `logout` `async` and begin it with `const proceed = logoutGuardRef.current ? await logoutGuardRef.current() : true; if (!proceed) return` (the existing body follows unchanged). `OfflineProvider` registers a guard (cleanup on unmount): if `flags.queue` and the outbox has any item for the current user it renders `LogoutGuardDialog` (the four-way dialog, D7, §6.6 A6) and returns a promise resolved by the choice — *Sync first* runs `syncNow('logout')` with a progress label and resolves `true` when no `pending|sending|retry_wait` remain, otherwise re-prompts; *Log out and keep* → `true`; *Log out and delete* → `discardAllForUser()` then `true`; *Cancel* → `false`. With no items it resolves `true` immediately (today's behaviour). In `AppNav.jsx:71` and `HomeScreen.jsx:295` change `logout(); navigate('/login')` to `logout()` (the context already does `window.location.href = '/login'`, `AuthContext.jsx:93`, and navigating first would bounce back through `Login`'s redirect while the dialog is open).
5. i18n keys `sync.logoutTitle`, `sync.logoutMessage`, `sync.logoutSyncFirst`, `sync.logoutKeep`, `sync.logoutDiscard`, `sync.syncingLabel` in `en.js` and `de.js` (§6.4.3).
6. `playwright.pwa.config.js`: add projects `chromium-page` and `webkit-page` (`serviceWorkers: 'block'`, `testIgnore: /service-worker\.spec\.js/`).
7. Tests (below). 8. Docs: `docs/PWA.md` (degraded mode, logout behaviour, what "keep/delete" mean), `docs/FRONTEND.md` (Auth flow section gains the `degraded` status). 9. No version bump.

**Acceptance criteria.** `npm test`, `npm run build`, `npm run test:pwa` pass (new projects included). With `VITE_PWA_DEFAULT=off` the app is unchanged: the existing Playwright `auth-startup.spec.js` still passes untouched. Manual: M-03 (offline cold start renders Home for a signed-in user), M-14, M-15.
**Tests to add.** `authSnapshot.test.js` (every validity rule of A5, corrupted JSON, expired `savedAt`, missing token in multi-user, `must_change_password`); Playwright `offline-auth.spec.js` on `chromium-page` **and** `webkit-page`, API mocked with `context.route`: (a) first load online (writes the snapshot), then abort all `/api/**` and reload → Home renders and no connection screen; (b) no snapshot → connection screen exactly as today; (c) snapshot with `must_change_password:true` → connection screen; (d) seed a v1 outbox item through raw IndexedDB, click logout **on Home and on a sub-page** → dialog with four actions each time; *keep* leaves the item, *delete* removes it, *cancel* keeps the session; with no items logout behaves as today; (e) single-user mode (no token) works.
**Docs to update.** Task 8.
**Rollback.** `OFFLINE_QUEUE_ENABLED=false` (default) disables every new path; or revert.

---

#### P6 — Sync center, offline banner, storage protection, `/offline` page

**Phase facts**
- Depends on: P5
- Safe to run in parallel with: none
- Files it touches: **create** `frontend/src/components/sync/{SyncIndicator,SyncSheet,OfflineBanner}.jsx`, `frontend/src/components/OfflineUnavailable.jsx`, `frontend/src/components/pwa/InstallHint.jsx`, `frontend/src/pages/OfflineCenter.jsx`, `frontend/src/offline/{routes.js,durability.js}`, `frontend/src/offline/{routes,durability}.test.js`, `frontend/src/i18n/offlineKeys.test.js`, `frontend/tests/pwa/sync-center.spec.js`; **modify** `frontend/src/components/Layout.jsx`, `frontend/src/App.jsx`, `frontend/src/i18n/en.js`, `frontend/src/i18n/de.js`, `docs/PWA.md`, `docs/FRONTEND.md`
- Needs a migration: no. Version bump: **no**
- PR title: `feat: add sync center and offline banner`

**Goal.** Make pending/failed state visible and actionable (D10, D12, §6.4). Still flag-gated.
**Tasks (in order).**
1. `offline/durability.js`: `requestPersistence()` (calls `navigator.storage.persist()` when present, stores `{requestedAt, granted}` in `meta.persist`), `readEstimate()` (`navigator.storage.estimate()` or `null`), `initCanary(db)`/`checkCanary(db)` (random id in `meta.canary` + `localStorage['pc.outbox.canary']`; returns `'ok' | 'evicted' | 'unknown'`), `ageWarning(oldestCreatedAt, standalone)` → `'none' | 'warn' | 'strong'` (3 / 7 days). Call `requestPersistence()` after the first enqueue and on every start while the queue is non-empty (D12) from `OfflineProvider`.
2. `offline/routes.js`: `OFFLINE_ROUTES` and `isOfflineRoute(pathname)` (patterns of §6.4.1).
3. `SyncIndicator.jsx`, `SyncSheet.jsx`, `OfflineBanner.jsx`, `OfflineUnavailable.jsx`, `InstallHint.jsx`, `OfflineCenter.jsx` per §6.4.1–§6.4.4 and all strings of §6.4.3 not reserved for P3/P5/P10 (use **literal** `t('sync.…')` calls so `check:translations` validates them).
4. `Layout.jsx`: render `<OfflineBanner/>` above `AppNav`, `<SyncIndicator/>` once, and replace `<Outlet/>` by `<OfflineUnavailable/>` when reachability is not `reachable` and `!isOfflineRoute(location.pathname)`; `InstallHint` only on `/`. All new elements render `null` unless `flags.queue`.
5. `App.jsx`: add `<Route path="offline" element={lazyRoute(<OfflineCenter />)} />` inside `ProtectedRoutes`.
6. i18n parity test `src/i18n/offlineKeys.test.js`: `Object.keys(de.sync)` and `Object.keys(de.pwa)` equal those of `en` (ignoring the P10 push keys until P10).
7. Playwright `sync-center.spec.js` (projects `chromium-page`, `webkit-page`), tests below. 8. Docs. 9. No version bump.

**Acceptance criteria.** `npm test`, `npm run build`, `npm run test:visual`, `npm run test:visual:webkit`, `npm run test:pwa` pass; screenshots (desktop 1280 and mobile 390) of the indicator states, the sheet and `/offline` attached to the PR; manual M-02, M-14, M-15, M-20.
**Tests to add.** `durability.test.js` (persist granted/denied/absent, estimate present/absent, canary ok/evicted/unknown with a fake `localStorage`, age warnings); `routes.test.js` (each pattern, trailing slashes, params); `sync-center.spec.js` (seed outbox items through raw IndexedDB; assert indicator states and aria labels, sheet buttons (Retry moves `failed`→`pending`, Discard asks for confirmation and removes), banner appears after two failed probes and disappears after one success, `OfflineUnavailable` on `/analytics` while offline and normal render on `/collection`, `prefers-reduced-motion` emulation → no animation class, keyboard focus trap and Escape close, items of another user show only a count).
**Docs to update.** `docs/PWA.md` ("Sync center", screenshots optional), `docs/FRONTEND.md` (components and routes tables gain `/offline`).
**Rollback.** Flag off, or revert.

---

#### P7 — Offline scan capture (persist-then-send)

**Phase facts**
- Depends on: P6, P3, P1
- Safe to run in parallel with: none
- Files it touches: **create** `frontend/src/offline/ops/scanSubmit.js`, `frontend/src/offline/ops/scanSubmit.test.js`, `frontend/tests/pwa/offline-scan.spec.js`; **modify** `frontend/src/components/UnifiedCardScanner.jsx`, `docs/PWA.md`, `docs/FRONTEND.md`
- Needs a migration: no. Version bump: **no**
- PR title: `feat: save scan photos offline and upload when reachable`

**Goal.** Deliver goal G3 for scan photos exactly as §6.5.2 and D11.
**Tasks (in order).**
1. `ops/scanSubmit.js`: `chunkPhotos(files, {maxPhotos:12, targetBytes:10*MiB})` (pure) and `submitScanBatch(...)` per §6.5.2.
2. `UnifiedCardScanner.jsx`: in `appendFiles` (`:71-88`) when `flags.queue` reject files over 15 MiB with `toast.error(t('sync.photoTooLarge'))`; replace the body of `startScanning` (`:147-166`) so that when `flags.queue` is on it calls `submitScanBatch` and handles `sent|queued|partial` and thrown `quota|server_old|too_large` per §6.5.2 step 6; with the flag off the current code runs untouched. Do **not** touch the capture inputs, the staged-file state or the `BatchCameraCapture` integration if present.
3. Tests (below). 4. Docs: `docs/PWA.md` ("Scanning without a connection": what is stored, limits 15 MB / 12 photos / 10 MB per batch item / 300 MB total, what happens at sync, why several jobs may result, the 14-day server retention starts at upload). 5. No version bump.

**Acceptance criteria.** `npm test`, `npm run build`, `npm run test:visual`, `npm run test:pwa` pass. Playwright (`chromium-page` and `webkit-page`, API mocked, `serviceWorkers:'block'`): (1) abort all `/api/**`, open `/search` → scanner, `setInputFiles` three JPEGs on the `input[capture]`, click *Start scanning* → toast `Saved on this device…`, scanner closed, IndexedDB holds the expected items (3 small files = 1 item); (2) un-abort and fulfil `POST /api/cards/recognize/jobs`: assert exactly **one** request per item, header `Idempotency-Key` present and stable, header `X-Expected-User-Id` present, and the multipart body length is ≥ the sum of the file sizes (guards the WebKit empty-body bug); item removed, `['scan-jobs']` invalidated; (3) lost-response: first request recorded then aborted, second fulfilled with `Idempotent-Replayed: true` → two requests, same key, item removed, no duplicate; (4) quota: `localStorage['pc.debug.forceQuota']='1'` → toast `Not enough storage…`, staged files still shown; (5) a 16 MB file is refused with `sync.photoTooLarge`; (6) with `VITE_PWA_DEFAULT=off` the scanner behaves exactly as before (existing `scan-review.spec.js` untouched and green). Manual: M-04, M-05, M-06, M-07, M-08, M-17 on a real iPhone (the manual evidence is pasted into the PR).
**Tests to add.** `scanSubmit.test.js` (chunk boundaries at 12 photos and 10 MiB, single 14 MiB photo forms its own chunk, position remapping, `partial` on quota after the first chunk, `sent` navigation inputs) + the Playwright spec above.
**Docs to update.** Task 4.
**Rollback.** `OFFLINE_QUEUE_ENABLED=false` returns to the old submit path instantly (queued items stay on the device); or revert.

---

#### P8 — Read cache of previously viewed data (Tier 1)

**Phase facts**
- Depends on: P6
- Safe to run in parallel with: none
- Files it touches: **create** `frontend/src/offline/readCache.js`, `frontend/src/offline/readCache.test.js`, `frontend/src/components/sync/StaleDataLabel.jsx`, `frontend/tests/pwa/read-cache.spec.js`; **modify** `frontend/src/offline/OfflineProvider.jsx`, `frontend/src/components/Layout.jsx`, `docs/PWA.md`, `docs/FRONTEND.md`
- Needs a migration: no. Version bump: **no**
- PR title: `feat: show previously loaded data offline`

**Goal.** Previously viewed collection data is readable offline, per user and origin, never leaks across users, and is labelled "saved data from …" (D1, D8, D10). Uses `dehydrate`/`hydrate` from the existing `@tanstack/react-query` dependency (no new package; F5).
**Tasks (in order).**
1. `readCache.js`: IndexedDB database `pokecollector-readcache` v1, store `qc` (key `"<origin>|<userId>"`, value `{v:1, savedAt, appVersion, state}`). `persist(queryClient, {origin, userId})`: `dehydrate(queryClient, {shouldDehydrateQuery: q => q.state.status === 'success' && ALLOW.has(String(q.queryKey[0]))})` with `ALLOW = {collection, wishlist, dashboard, sets, set-checklist, binders, binder-cards, scanner-configuration, printing-detail-tags, investment-tracker}`; drop collection queries over **10 MiB** and other queries whose `JSON.stringify(data).length > 5 MiB`; if the total exceeds **20 MiB** drop queries with the oldest `dataUpdatedAt` until it fits; write through a 5 s trailing throttle subscribed to `queryClient.getQueryCache()`. `restore(queryClient, {origin, userId})`: read; ignore when `appVersion !== __APP_VERSION__` or older than **30 days** or malformed; `hydrate(queryClient, state)`; return `savedAt` or `null`. `purge({origin, userId})`, `purgeOthers({origin, keepUserId})`, `purgeAll()`. Every IndexedDB access in try/catch (failure = feature off).
2. `OfflineProvider.jsx`: when `flags.queue`: call `persist` wiring after `ready`/`degraded`; when `status === 'degraded'` render children only after `restore` resolves or 1.5 s elapse (so protected routes mount with data present); expose `savedAt`; call `purgeOthers` whenever `user.id` becomes defined; **call `purge` inside the logout guard** (every path, including "no unsynced items"); the **Reset offline app data** action (P6 page) also calls `purge`.
3. `StaleDataLabel.jsx` + `Layout.jsx`: when reachability is not `reachable` and `savedAt` exists show `` `${t('sync.staleData')} ${formatDistanceToNow(savedAt, {addSuffix:true})}` `` (uses `date-fns`, already a dependency, `SyncStatus.jsx:5`) above the page.
4. Tests (below). 5. Docs: `docs/PWA.md` ("What you can see offline": the allow-list, 30-day/20 MiB limits, per-user separation, cleared at logout), `docs/FRONTEND.md`. 6. No version bump.

**Acceptance criteria.** `npm test`, `npm run build`, `npm run test:pwa` pass. Playwright (`chromium-page`, `webkit-page`, mocked API): load `/collection` online with 3 mocked items; abort all `/api/**`; reload → items render with the stale label and the offline banner; logout → the IndexedDB record is gone; log in as another user → no data from the first user is visible; a non-allow-listed route shows `OfflineUnavailable`. Manual: M-03.
**Tests to add.** `readCache.test.js` (filter, per-query and total caps, key namespacing, `appVersion` mismatch, 30-day expiry, corrupted record, purge/purgeOthers, IndexedDB-unavailable no-ops) + the Playwright spec above.
**Docs to update.** Task 5.
**Rollback.** Flag off, or revert; `purgeAll()` is available from the Offline center reset.

---

#### P9 — Offline collection/wishlist adds (optional; **not built**)

**Status: not built.** Kept for reference only; none of the files below exist, and offline collection/wishlist adds are not part of the delivered feature. (The P4 outbox library already defines the `collection.add` and `wishlist.add` item types in `frontend/src/offline/outbox/ops`, but nothing in the UI enqueues them.)

**Phase facts**
- Depends on: P7
- Safe to run in parallel with: none
- Files it touches: **create** `frontend/src/offline/useQueuedAdd.js`, `frontend/src/offline/useQueuedAdd.test.js`, `frontend/src/components/sync/PendingGhostRows.jsx`, `frontend/src/components/sync/QueuedChip.jsx`, `frontend/tests/pwa/offline-adds.spec.js`; **modify** `frontend/src/offline/useOutbox.js`, `frontend/src/components/CardItem.jsx`, `frontend/src/pages/Collection.jsx`, `frontend/src/pages/Wishlist.jsx`, `docs/PWA.md`, `docs/FRONTEND.md`
- Needs a migration: no. Version bump: **no**
- PR title: `feat: queue collection and wishlist adds offline`

**Goal.** Tier 2b (D3): single adds from already-visible cards, persist-then-send, with ghost rows and "queued" chips; everything else stays online-only and says so.
**Tasks (in order).**
1. `useQueuedAdd.js`: `queuedAdd(type, payload, display)` → if `!flags.queue` → call the existing API function and return its response; else `outbox.enqueue({type, payload, display})` then `outbox.sendNow([id])`: resolves the parsed JSON on success, or `{queued: true}` when the send was not possible (unreachable, 429, 5xx, blocked) — never throws for those. `display = {title: card.name, subtitle: "<SET> <number>", imageUrl}` (UI only).
2. `CardItem.jsx`: `addMutation` (`:618-627`, `mutationFn: (data) => addToCollection(data)`) and `wishlistMutation` (`:629-638`) use `queuedAdd('collection.add'|'wishlist.add', data, display)`; their `onSuccess` shows `t('sync.savedOffline')` when `result?.queued`, else today's toast; invalidations stay. Leave the custom-card dialog add (`:128-130`) and `Collection.jsx:457` as they are (online-only; document why in the PR).
3. `useOutbox.js`: add `pendingForCard(cardId)` (count of pending `collection.add`/`wishlist.add` items whose `payload.card_id` equals it) and `pendingAdds(type)`.
4. `QueuedChip.jsx` (uses `sync.pendingBadge`) on card tiles when `pendingForCard > 0`; `PendingGhostRows.jsx` rendered at the top of `Collection.jsx` and `Wishlist.jsx` with the heading `sync.waitingLabel` and the note `sync.pendingTotalsNote` under totals; ghost rows are **not** merged into any TanStack cache and **do not** count in totals.
5. Disable the non-queueable controls when `flags.queue && reachability === 'unreachable'`: wherever a button triggers `quantityMutation`/`removeMutation` (`CardItem.jsx:640-660`) or `updateCollectionItem`/`removeFromCollection` in `Collection.jsx`, set `disabled` and `title={t('sync.needsConnection')}`.
6. Edit/discard of **pending** adds happen in the sync sheet (P6 `editPending`, `discard`); no new UI beyond the sheet.
7. Tests (below). 8. Docs. 9. No version bump.

**Acceptance criteria.** `npm test`, `npm run build`, `npm run test:visual`, `npm run test:visual:webkit`, `npm run test:pwa` pass; screenshots of the ghost rows (desktop + mobile). Playwright (S13): offline add → ghost row; edit quantity in the sheet → ghost shows the new value; discard → ghost gone and **no request** is ever sent; reconnect with a kept add → exactly one `POST /api/collection/` with `Idempotency-Key`, ghost disappears after the refetch; lost response → two requests, same key, one logical add; wishlist cap `400` → item `failed` with the server text; non-queueable buttons disabled offline.
**Tests to add.** `useQueuedAdd.test.js` (flag off passthrough; queued vs sent; never throws on network failure; display snapshot never leaks into the request body) + the Playwright spec.
**Docs to update.** `docs/PWA.md` ("Adding cards without a connection", what stays online-only and why), `docs/FRONTEND.md`.
**Rollback.** `OFFLINE_QUEUE_ENABLED=false` restores direct adds; queued items remain on the device until the flag is re-enabled; or revert.

---

#### P10 — Web push for price alerts (migration; runs alone)

**Phase facts**
- Depends on: P3, P1
- Safe to run in parallel with: none (migration PRs run alone)
- Files it touches: **create** `backend/api/push.py`, `backend/services/push.py`, `backend/tests/test_push.py`, `frontend/src/pwa/push.js`, `frontend/src/components/pwa/NotificationsCard.jsx`; **modify** `backend/models.py`, `backend/database.py`, `backend/main.py`, `backend/services/sync_service.py`, `backend/requirements.txt`, `frontend/src/sw/sw.js`, `frontend/src/sw/sw.test.js`, `frontend/src/pages/Settings.jsx`, `frontend/src/api/client.js`, `frontend/src/i18n/en.js`, `frontend/src/i18n/de.js`, `frontend/src/i18n/offlineKeys.test.js`, `docs/BACKEND.md`, `docs/PWA.md`, `docs/DEPLOYMENT.md`, `README.md`
- Needs a migration: **yes** (`push_subscriptions`) — runs alone. Version bump: **no**
- PR title: `feat: web push for price alerts`

**Goal.** Optional push notifications (D15, §6.7), separable from the offline work.
**Tasks (in order).**
1. `backend/requirements.txt`: add `pywebpush==2.5.0`; in a fresh venv run `python -m pip install -r backend/requirements.txt` — **stop and report** if resolution fails (do not substitute another library).
2. `models.py` + `database.py`: `PushSubscription` model and the two migration entries of §6.7.1 appended at the tail of the list.
3. `services/push.py` and `api/push.py` per §6.7.1; register the router in `main.py` (`app.include_router(push.router, prefix="/api/push", tags=["push"])`, next to `community`, `main.py:205`).
4. `sync_service.check_wishlist_alerts` (`:624-629`): add the guarded `push.send_price_alert(...)` call.
5. `sw.js`: `push` and `notificationclick` handlers (§6.3.3) + vm tests (always shows a notification; ignores payloads without a title; same-origin `navigate` only).
6. `pwa/push.js`, `NotificationsCard.jsx`, `client.js` API functions (`getVapidPublicKey`, `subscribePush`, `unsubscribePush`, `sendTestPush`), insert the card in `Settings.jsx` near the Telegram section; i18n keys `pwa.push*` (en + de; extend the parity test).
7. Tests (below). 8. Docs: `docs/BACKEND.md` (routes, table, env `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, key file path, SSRF allow-list), `docs/PWA.md` (enable on iPhone: install first, HTTPS required), `docs/DEPLOYMENT.md` (backup note: the VAPID private key file lives in `./data/auth`, not in SQL dumps), README. 9. No version bump.

**Acceptance criteria.** Backend `unittest` suite passes (new `test_push.py` included); `npm test`, `npm run build`, `npm run test:pwa` pass; migration creates the table on an existing database; manual M-19 on a real iPhone Home Screen app over HTTPS: enable → test notification arrives; 410 handling verified by deleting the subscription on the phone and sending again (row removed).
**Tests to add.** `test_push.py` (§6.7.1 list); `sw.test.js` additions; `offlineKeys.test.js` parity incl. push keys.
**Docs to update.** Task 8.
**Rollback.** Nothing needs disabling (no subscriptions = no sends); revert the PR; the table is additive; the VAPID key file can be deleted.

---

#### P11 — Enable offline features by default (**not part of this change**)

**Status: not part of this change.** Both flags default to off. This phase describes the follow-up that would flip the defaults once the checklist in §10.3 has passed.

**Phase facts**
- Depends on: P7, P3
- Safe to run in parallel with: none
- Files it touches: `frontend/docker-entrypoint.d/45-configure-pwa.sh`, `frontend/scripts/configure-pwa.test.mjs`, `.env.example`, `README.md`, `docs/PWA.md`, `docs/DEPLOYMENT.md`
- Needs a migration: no. Version bump: **no**
- PR title: `feat: enable offline features by default`

**Goal.** Flip the container defaults so unset `PWA_ENABLED`/`OFFLINE_QUEUE_ENABLED` mean **on**.
**Tasks.** (1) In `45-configure-pwa.sh` change the two default arguments `0` → `1` (the lines marked "P11 changes this default"); (2) update `configure-pwa.test.mjs` expectations (empty value ⇒ `sw=1;queue=1`; explicit `false` ⇒ `0`); (3) `.env.example`/README/`docs/PWA.md`/`docs/DEPLOYMENT.md`: "enabled by default; set `PWA_ENABLED=false` / `OFFLINE_QUEUE_ENABLED=false` to disable"; (4) leave `__PWA_DEFAULT__` (build-time default for non-container previews) at `off` so dev/test builds and existing Playwright suites are unaffected; (5) no version bump.
**Acceptance criteria.** `npm test` passes; container check: unset env ⇒ `index.html` contains `sw=1;queue=1` and `/sw.js` equals `sw.real.js`; `PWA_ENABLED=false` ⇒ kill worker served; the PR description pastes the completed §10.3 checklist (M-01 … M-20) with device model and iOS version.
**Tests to add.** The updated node test only. **Docs.** Task 3. **Rollback.** Set the two env vars to `false` and restart (no rebuild), or revert.

---

## 10. Test strategy

### 10.1 Automated

| Layer | Tool / location | Covers |
|---|---|---|
| Backend unit | `unittest` in `backend/tests/` (SQLite in memory) | Idempotency semantics, error codes, fingerprints, cleanup, health payload, push service (P10) |
| Backend Postgres (opt-in) | `IDEMPOTENCY_POSTGRES_TEST=1` + `DATABASE_URL` (throw-away server, §9.1.5) | Concurrency (two threads), advisory lock path, FK cascade |
| Frontend unit | `vitest` (node environment) + `fake-indexeddb/auto` | Outbox store/state machine/classify/probe/lease/replay/backoff; `authSnapshot`; `durability`; `routes`; `readCache`; `scanSubmit`; `useQueuedAdd`; i18n parity |
| Service-worker unit | `vitest` + `node:vm` (`sw.test.js`) | Routing, validation, shell consistency rule, install/activate, FIFO trim, no `skipWaiting`/`claim` |
| Node script tests | `node --test` (`npm test`) | `build-sw.mjs`, `45-configure-pwa.sh`, `pwa-assets`, `nginx-config`, existing `configure-public-mode` |
| E2E (Chromium, SW allowed) | Playwright `chromium-sw` project, `scripts/serve-pwa-test.mjs` (production build + `vite preview`) | SW install/offline/update/kill switch/escape hatch; `/api` never served by SW |
| E2E (Chromium + WebKit, SW blocked) | Playwright `chromium-page`, `webkit-page` | Degraded auth, logout guard, sync center, offline scan, read cache, offline adds; multipart body length (guards the WebKit empty-body bug) |
| Existing visual suites | `npm run test:visual`, `test:visual:webkit` | No regression with flags off (`__PWA_DEFAULT__=off`) |
| CI | `.github/workflows/frontend-card-system.yml` (P3 adds `npm run test:pwa`) | Same commands as local |

Offline emulation: `context.route('**/api/**', route => route.abort())` (works for page-owned requests when the SW is blocked, X12) and `context.setOffline(true)` in the Chromium SW project (the worker does not proxy `/api`, so page `/api` fetches fail exactly as offline). The kill-switch/update tests swap bytes of `dist/sw.js` on disk because Playwright cannot route service-worker script updates (documented in X12).

### 10.2 What automation cannot prove
Playwright WebKit is **not** iOS Home Screen Safari: no standalone mode, no iOS storage eviction, no camera sheet, no status bar, no Lockdown Mode, no real iOS service-worker lifecycle (and Playwright's SW support is Chromium-only, V). Therefore a real-iPhone checklist is mandatory before P11.

### 10.3 Manual real-iPhone checklist (record device, iOS version, result; run on **iOS 26.x and 27.x** when available)

| ID | Steps | Expected |
|---|---|---|
| M-00 | If a reverse proxy with an asset cache sits in front (for example Nginx Proxy Manager with **Cache Assets** on), switch the cache off for the site (X17); in Safari open the site and check the padlock | Cache Assets off; padlock shown, no certificate warning |
| M-01 | Safari → open the HTTPS site → Share → Add to Home Screen → launch | Standalone window, correct name/icon (opaque dark background), no browser chrome |
| M-02 | Launch standalone; portrait and landscape; open a deep page | Nothing under the status bar/notch or home indicator; Home button reachable; status-bar area blends with the dark UI |
| M-03 | Visit online once, force-quit, enable Airplane Mode, launch | Shell loads; signed-in user sees Home (degraded); Offline center works; cached collection visible (after P8) |
| M-04 | Airplane Mode → Search → Scan → take 3 photos with the camera input → Start scanning | "Saved on this device"; indicator WAITING; no blank screen; photos survive force-quit and relaunch |
| M-05 | Disable Airplane Mode (home Wi-Fi) with the app open, then again after relaunch | Automatic sync; `/scans` shows the jobs; indicator clears; one job per item |
| M-06 | Start syncing a large item, force-quit mid-upload, relaunch | Item resumes with the same key; exactly one job on the server |
| M-07 | Open `https://<host>/?pc_debug=forceLostResponse` once (no Safari Web Inspector is assumed; the URL parameter sets the flag and is stripped, §6.2.6), queue an item, sync; finish with `/?pc_debug=off` | Two requests with the same key; one job on the server; item removed |
| M-08 | Open `/?pc_debug=forceQuota`, then capture (and separately, if practical, fill the device storage near full); finish with `/?pc_debug=off` | Clear "not enough storage" message; staged photos kept; nothing half-saved |
| M-09 | Deploy a new frontend image; open the app; foreground it | Banner appears; *Update* disabled while uploading or staging; after Update the queue is intact |
| M-10 | Set `PWA_ENABLED=false`, restart the frontend container; foreground the app | Service worker and `pc-*` caches removed without clearing site data; outbox intact |
| M-11 | Plain `http://192.168.x.x`: add to Home Screen; open; capture while the page is open and the server is unreachable | No service worker (capability card says so); outbox works (**settles PF2b**); sync on return; cold start offline fails as documented |
| M-12 | Tap an external link (e.g. in Settings → Community) in standalone | Observe and record: in-app sheet vs Safari; nothing breaks (**settles X7**) |
| M-13 | Navigate deep and back using the iOS edge swipe and the Home button | Always a way back; no dead end |
| M-14 | Queue items, tap logout (Home **and** a sub-page) | Four-way dialog on both; each choice behaves as specified |
| M-15 | Two accounts: A queues, logs out (keep); B logs in; A logs in again | B sees only a count; A's items sync under A |
| M-16 | Enable Lockdown Mode | App works without a service worker; no errors |
| M-17 | On iOS 26.5–26.7 (or 27 before the WebKit fix ships) with the SW enabled, scan online and offline | Uploads contain the full photo (server job shows images) — **settles X2/bug 319985** |
| M-18 | Behind an SSO proxy, let the session expire, then sync | `blocked(proxy)` message; after SSO login the items sync; no HTML ever cached as a script |
| M-19 | *(P10)* Enable push in the installed app over HTTPS; trigger a price alert/test | Notification appears; tapping opens `/wishlist`; deleting the subscription yields 410 cleanup |
| M-20 | VoiceOver + Reduce Motion on: use indicator, sheet, banner | Controls announced with text labels; no animation with Reduce Motion |

---

## 11. Risks register

| # | Risk | Likelihood | Impact | Mitigation | Phase |
|---|---|---|---|---|---|
| 1 | Double-apply after a lost response | Medium | High (wrong quantities) | Idempotency table, same-tx record, `maybeApplied`, key stable until a definitive outcome | P1, P4 |
| 2 | Bad SW release traps users | Low | High | Hand-written small SW, no auto-activation, three-level kill switch, no `/api` caching | P3 |
| 3 | iOS storage eviction / Blob-File bugs | Medium | High (lost photos) | ArrayBuffers, memory Blobs, canary, warnings, honest wording, `persist()` | P4, P6, P7 |
| 4 | 429 storms on the shared 60/min bucket | Medium | Medium | 30 req/min pacing, 429 pause (60 s default), circuit breaker | P4 |
| 5 | Cross-account replay or leakage | Low | High | `userId`+origin binding, `X-Expected-User-Id`, SW holds no user data, read cache per user and purged | P1, P4, P5, P8 |
| 6 | Reverse-proxy SSO returns HTML | Medium | Medium | `redirect:'manual'`, JSON validation, SW install validation | P3, P4 |
| 7 | Unrelated in-flight changes conflict with phases | Medium | Medium (merge work, semantic drift) | Phases are based on `main`; each phase re-reads the files it cites before starting | all |
| 8 | Default-off flags never get enabled | Medium | Low | P11 flip after the checklist; docs | P11 |
| 9 | Unverified iOS behaviours (X4, X7, X8, PF2b) | High | Medium | Manual checklist, feature-detection, fallbacks | P2, P6, P7 |
| 10 | Precache bloat / slow install | Low | Medium | 12 MiB build budget, reuse of unchanged chunks | P3 |
| 11 | Idempotency table growth | Low | Low | 14-day TTL + hourly cleanup | P1 |
| 12 | `pywebpush` dependency conflicts / MPL concerns | Medium | Low (optional) | Optional phase, stop condition, licence note | P10 |
| 13 | Reload loop on `controllerchange` | Low | Medium | `sessionStorage` guard, one reload only | P3 |
| 14 | HTTPS absent for most self-hosters → feature seems "broken" | High | Medium | Capability card, `docs/PWA.md` HTTPS section, honest copy | P3, P6 |
| 15 | Offline UI shows pages that crash without data | Medium | Medium | `OfflineUnavailable` gating allow-list | P6, P8 |
| 16 | Outbox schema migration bug | Low | High | Ordered in-transaction migrations, abort-on-failure, tests | P4 |
| 17 | A reverse-proxy asset cache (Nginx Proxy Manager **Cache Assets**) serves a stale `sw.js` or kill worker | Medium | Medium | Turn it off for the site (M-00); `docs/PWA.md` warns every proxy user; no auto-activation; the L2/L3 kill levels are not cached (X17) | P3 |

---

## 12. Decisions taken

These were the open questions when the design was written; each row records the decision that was taken.

| # | Question | Decision and why |
|---|---|---|
| Q1 | Enable by default, or opt-in first? | **Opt-in.** Both flags default off. Each phase is a release (F2), so default-off keeps `latest` safe for every self-hoster. Flipping the defaults (P11) is a separate step and is not part of this change. |
| Q2 | Reads before writes? | **Scan capture first**; P7 and P8 are interchangeable after P6. |
| Q3 | Build optional P9 (offline collection/wishlist adds)? | **Not built.** It needs ghost rows and more UI; scan capture covers the shop use case. |
| Q4 | Build optional P10 (web push)? | **Built.** It is separable and inert until a user subscribes. |
| Q5 | Self-host the Inter font (removes Google Fonts requests, makes offline typography consistent)? | **Later, separate change** (changes CSP and the privacy story). |
| Q6 | Allow parallel PRs if version bumps are deferred to a release PR? | **No version bumps in phase PRs**, and phases still merge one at a time because independent phases share files (§9.1.3). |
| Q7 | Merge unrelated in-flight branches before P1/P5/P7/P9? | **Not needed.** Phases are based on `main` and do not depend on any unmerged branch. |
| Q8 | Minimum iOS? | **16.4+** (Home Screen web apps, push, manifest `id`); older stays a normal website. |
| Q9 | Keep items of other accounts forever? | **Yes, count only**, never auto-delete; removable by that user or via browser site-data clear. |
| Q10 | One flag or two? | **Two** (SW and outbox need different kill levers; the outbox kill must never delete data). |
| Q11 | Where do the phases land? | Phases merge sequentially into one integration branch; nothing reaches `main` before the whole set has been reviewed. |
| Q12 | Extend `/api/health` or add `/api/meta`? | **Extend `/api/health`** (additive; existing consumers only check the status). |
| Q13 | Provide HTTPS guidance for LAN installs in `docs/PWA.md`? | **Yes**: reverse proxy with a real certificate, or Tailscale HTTPS; warn that untrusted self-signed certificates do not enable service workers (**U**, test). |
| Q14 | Client-side photo downscale later? | **Not now**; revisit only after a real-device matrix proves EXIF/HEIC behaviour (D11). |

---

## 13. Appendix

### 13.1 Red-team list (hostile review of this design) and resolutions

| # | Attack / failure | Resolution |
|---|---|---|
| 1 | Response lost after commit → duplicate add | Idempotency; key written in the same transaction; S2 |
| 2 | Same key replayed with a different body | `422 idempotency_key_reused`; Edit rotates the key |
| 3 | Replay under another account (two tabs, shared `localStorage` token) | `X-Expected-User-Id` → `409 wrong_account`; client filter; S4 |
| 4 | Authenticated JSON served to the next user from a cache | SW never caches `/api`; read cache keyed `origin\|userId`, purged at logout, `purgeOthers` on login |
| 5 | Reverse-proxy login HTML cached as a JS chunk | Install validation (content-type, `redirected`); install fails; S8 |
| 6 | Login HTML cached as the app shell | `validateShell` requires `id="root"`, 200, not redirected, all assets in manifest |
| 7 | New shell with an older precache → white screen offline | Consistency rule: store a shell only if every referenced asset is in this SW's manifest |
| 8 | Bad SW release | Kill switch L1–L3; kill worker same URL; no `skipWaiting`; `?pc_sw=off` |
| 9 | Kill switch itself broken | ≤ 40 lines, tested in Playwright (file swap), page-side cleanup duplicates it |
| 10 | `controllerchange` reload loop | `sessionStorage['pc.reloaded']` guard |
| 11 | IndexedDB upgrade blocked by an old tab | `versionchange` closes connections |
| 12 | Quota error leaves half an item | One transaction per enqueue |
| 13 | Zombie `sending` item after a kill | Claim expiry → `retry_wait` + `maybeApplied`, same key |
| 14 | iOS disk-backed `File` sends an empty body | ArrayBuffer storage; memory Blob uploads; multipart-length assertion in E2E; existing uploads hardened in P3 |
| 15 | Poison item stalls the queue | Skip rules; 12-error cap; circuit breaker |
| 16 | Clock skew / device clock changes | No client time sent; TTL on the server clock; only local scheduling uses the device clock |
| 17 | Replay storm after server restart | Jittered backoff, pacing, probe before every session |
| 18 | Rate-limit starvation of other users on the shared bucket | ≤ 30 req/min, 429 pause with doubling |
| 19 | Idempotency key reuse after backup restore | Post-restore delete of all keys (duplicate preferred over silent loss) |
| 20 | Blocking DB lock inside an `async` handler freezes the server | `pg_try_advisory_xact_lock` only; unique-constraint fallback |
| 21 | Intermediate commit releases the advisory lock | Unique constraint is the final safety net; loser rolls back, 409 |
| 22 | Push subscription endpoint used for SSRF | Host allow-list, https/443 only, no IPs (§6.7.1) |
| 23 | Push payload leaks collection data | Minimal payload (title, card name, `/wishlist`); encrypted end to end |
| 24 | Non-installed Safari tab loses data after 7 days | Warnings at 3/7 days, canary, honest wording, install hint, `sync.syncBeforeInstall` |
| 25 | Installed app and tab have different stores (S15) | Explicit copy; sheet shows the warning while `!standalone` |
| 26 | `PUBLIC_MODE` rewrites `index.html`, breaking a precache hash | `index.html`/`robots.txt` never precached; runtime shell with consistency rule |
| 27 | `sw.js` cached for a year by the existing regex location | Exact/regex `no-cache` location placed before the static regex; `updateViaCache:'none'` |
| 28 | `add_header` in a location drops the CSP | Shared snippet included in every location that sets headers; test asserts it |
| 29 | CRLF in `45-configure-pwa.sh` on a Windows checkout breaks the container | `.gitattributes` `*.sh text eol=lf` (P3) |
| 30 | Logout from a second entry point (Home button) bypasses the guard | Guard lives in `AuthContext.logout`, not in callers |
| 31 | Old backend + new frontend queues operations that cannot be deduplicated | `features` gating; enqueue refused; items `blocked(server_old)` |
| 32 | Concurrent changes touch the same lines | Re-read the cited files before each phase |
| 33 | Orphaned items of deleted/other users fill storage | Count shown, caps (300 MiB/500 items), documented manual removal; never replayed |

### 13.2 Sources
WebKit: https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ · https://webkit.org/tracking-prevention/ · https://webkit.org/blog/14403/updates-to-storage-policy/ · https://webkit.org/blog/14787/webkit-features-in-safari-17-2/ · https://webkit.org/blog/14205/news-from-wwdc23-webkit-features-in-safari-17-beta/ · https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ · https://webkit.org/blog/13966/webkit-features-in-safari-16-4/ · https://webkit.org/blog/16535/meet-declarative-web-push/ · https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/ · https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-safari-27-beta/ · https://webkit.org/blog/18325/webkit-features-for-safari-27-0/ · https://webkit.org/blog/10247/new-webkit-features-in-safari-13-1/ · bugs: https://bugs.webkit.org/show_bug.cgi?id=319985, 292142, 235687, 240216, 185448, 305546, 211775, 182565 (Background Sync).
Apple: https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers.
MDN: https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts/features_restricted_to_secure_contexts · …/Web/API/Navigator/onLine · …/Web/API/Service_Worker_API/Using_Service_Workers · …/Web/HTTP/Reference/Headers/Content-Security-Policy/worker-src · …/Web/API/Crypto/randomUUID · …/Web/API/Crypto/getRandomValues · …/Web/API/IndexedDB_API · browser-compat-data `api/SyncManager.json`, `api/LockManager.json`, `api/StorageManager.json`, `api/BroadcastChannel.json`, `api/ServiceWorkerRegistration.json`, `api/BeforeInstallPromptEvent.json`.
Other: https://web.dev/articles/service-worker-lifecycle · https://playwright.dev/docs/service-workers · https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-07 · https://raw.githubusercontent.com/laurentS/slowapi/v0.1.9/slowapi/extension.py · npm registry (`vite-plugin-pwa@2.0.0`, `workbox-build@7.4.1`, `fake-indexeddb@6.2.5`) · deps.dev dependency graph of `vite-plugin-pwa@2.0.0` (353 nodes) · PyPI `pywebpush` 2.5.0 · Vite build docs https://vite.dev/guide/build.
Nginx Proxy Manager: https://github.com/NginxProxyManager/nginx-proxy-manager/blob/develop/docker/rootfs/etc/nginx/conf.d/include/assets.conf · https://github.com/NginxProxyManager/nginx-proxy-manager/blob/develop/backend/templates/_assets.conf (read 2026-10-18).
Repository evidence: files and line numbers cited inline (checked against `d00efee`, v1.51.6).

### 13.3 Implementation notes

Deviations from the design that were found while testing on real iPhones. The code and `docs/PWA.md` are authoritative where they differ from the sections above.

- **Reachability is monitored even when the queue is empty** (§6.2.8). iOS keeps `navigator.onLine` true in Airplane Mode, and the design only probed `/api/health` while there was something to replay, so the offline banner never appeared. A small monitor (`offline/outbox/monitor.js`) now probes independently of the queue and drives the banner.
- **The startup auth check times out after 5 seconds** (R3, §6.6). On iOS an offline request to the API can hang instead of failing, which left the app on the connection screen; after 5 s the bootstrap gives up and the app enters the degraded (cached sign-in) state.
- **Google Fonts loads non-blocking** (`media="print"` swapped to `all` on load; Q5). iOS hangs cross-origin requests while offline, and a render-blocking stylesheet kept the offline shell from painting.
- **The update banner and the "updating" screen render through a portal into `document.body`.** `index.css` sets `#root > *` to `position: relative` (an ID selector, so it beats Tailwind's `.fixed`), which turned the banner into an ordinary block at the end of the page. The Playwright test now checks the computed position instead of class names.
- **Both banners have opaque backgrounds, and the offline banner respects the top safe-area inset**, so it is not drawn under the status bar in the standalone app.
- **Settings and exchange rates are cached per user for offline use** (D8, P8). Offline, the settings request failed and the app fell back to the defaults (EUR). The last good settings (per user) and the last good rate (per currency pair) are used on failure and for the first paint, requests that hang are timed out, and the cache is cleared at logout.
- **An offline large card image falls back to the cached small one.** The detail page requests the large image, which is not in the image cache for cards that were only seen in lists; the service worker now answers with the cached small image instead of an error.
- **The sign-in and password forms carry the markup iOS Password AutoFill needs** (`autocomplete` hints and a hidden username field on the password forms), so the cached sign-in works with the system password manager.
