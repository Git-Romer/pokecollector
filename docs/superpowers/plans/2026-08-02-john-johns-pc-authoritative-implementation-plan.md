# John John's PC Authoritative Implementation Plan

Date: 2026-08-02

Status: Authoritative planning document for the next implementation pass.

This plan supersedes the older July refinement plans where they conflict with later product decisions. The older plans remain useful as history, but implementation work should use this file as the current interface.

## Goal

Deliver **John John's PC** as a desktop-only, dark-only, local-first Pokemon TCG collection platform where the collection is the hero and John John is a subtle, ambient, faceless curator presence.

The first-release experience must feel like a premium local databank: Fluent 2 spatial hierarchy, DaisyUI-compatible UI primitives where already used, React Bits-inspired motion, and a practical collection workflow that preserves the familiar tracker structure.

## Non-negotiable product interface

The app's visible primary navigation is exactly:

- Collection
- Card Search
- All Cards
- Trends & Insights
- Settings

The navigation defines the collector loop:

`own -> discover -> verify -> understand -> maintain`

Visible product name:

- `John John's PC`

Collection page heading:

- `My Collection`

Compact mark:

- `∞`

Removed or forbidden:

- No `Pokemon TCG Tracker` as current product name.
- No `Dashboard` primary surface.
- No `Wishlist`; use `Chase Cards`.
- No `Sets`; use `All Cards` for catalog/set completion and `Expansions` only where it means expansions.
- No `Analytics`; use `Trends & Insights`.
- No `Discovery Pulse`; use `Discover`.
- No `Featured Expansions`.
- No `Pokemon.com` discovery source.
- No reduced-motion preference or toggle.
- No John John face, avatar, mascot, or chatbot panel.
- No JOMW Fund integration in this project.

## Codebase-design framing

Use the following module vocabulary while implementing:

- A **module** has an interface and an implementation.
- An **interface** includes every fact a caller must know: parameters, invariants, error modes, configuration, ordering constraints, and performance expectations.
- A **seam** is where behavior can vary without editing callers.
- An **adapter** satisfies an interface at a seam.
- A module should be deep: small interface, high leverage, strong locality.

Do not add seams for hypothetical future integrations. Collectr, HoloDex, PSA, TAG, Bulbapedia, JustWatch, and PokéBeach should be represented behind narrow local interfaces only when the current release actually calls or stores data from that source.

## Architectural constraints

- Preserve existing API routes unless a current route prevents a required behavior.
- Preserve existing database records.
- Use additive migrations for collection/product metadata.
- Preserve legacy routes by redirecting them to current surfaces.
- Keep live app deployment local:
  - Frontend: `http://127.0.0.1:13000`
  - Backend: `http://127.0.0.1:18080`
- Use the existing Docker override for local ports.
- Do not introduce external AI calls.
- Do not introduce authenticated Collectr or HoloDex automation in this pass.
- Do not use subscription browser sessions as APIs.

## Design system requirements

John John's PC has one visual mode:

- Desktop-only.
- Dark-only.
- Motion-on.
- Spectrum allowed liberally as identity and atmosphere.

Design references:

- Microsoft Fluent 2 / Fluent UI v9 principles.
- Microsoft Copilot, Windows 11, Loop, Designer quality bar.
- React Bits as a motion-quality reference.
- John John design system: black room, white voice, spectrum mind, Tron-program-like ambient presence.

Apply:

- Spacious desktop layouts.
- Soft depth.
- Rounded tactile surfaces.
- Strong type hierarchy with Inter.
- Clear focus states and keyboard usability.
- Meaningful page transitions.
- Hover/focus interactions.
- Animated loading states.
- Presence indicators.
- Collection reveals.
- Card hover effects.
- Context-aware motion that communicates discovery, activity, presence, or intelligence.

Do not animate merely for decoration.

Important correction from older plans:

- Do not retain an in-app reduced-motion toggle.
- Do not document reduced motion as a selectable product mode.

## Collection domain model

### Collection Lots

Owned cards are tracked as collection lots.

A collection lot represents one or more copies that share:

- Card identity.
- Ownership state.
- Condition.
- Acquisition history.
- Protection/storage.
- Cost basis.
- Notes.

Certified slabs should remain individually trackable when they carry a certification number.

### Ownership states

Use the art-collection vocabulary consistently:

- **John John's PC**: complete private collection.
- **Main Collection**: permanent collection; cards intended to keep.
- **Vault**: investment-grade cards and selected sealed product.
- **PC**: personal/passion collection; TAG slabs especially fit here.
- **Collection Theme**: curated group united by an idea or visual language.
- **Collecting Goal**: collection focus.
- **Grail Card**: top-tier chase or centerpiece, denoted with a star.
- **Card History**: provenance.
- **Add to Collection**: accession.
- **Archive as Sold / Traded / Gifted**: deaccession while preserving history.
- **Condition & Protection**: condition report and care.
- **Collection Catalog**: searchable inventory, set completion, notes, photos, identifiers.
- **Showcase Binder / Display Case**: exhibition/display.
- **Card Care**: sleeves, semi-rigids, top loaders, slabs, binders, boxes, storage notes.

### Collection intents

Use these exact labels:

- Main Collection
- Vault
- PC

### Chase Cards

Use these states:

- Track: watching it.
- Chase: actively pursuing it.
- Grail: personal top-tier chase.

Use a star to denote grails.

### Condition labels

Use simplified condition labels:

- NM
- LP
- MP
- HP
- DMG

### Protection and notes

Support notes like:

- Raw.
- Penny sleeve.
- Card Saver.
- Hard sleeve.
- Top loader.
- Binder.
- PSA slab.
- TAG slab.
- Storage location.
- Grading certification.
- Personal note.

Corrections may overwrite previous values. Do not build an immutable edit history unless explicitly requested later.

## Acquisition and cost basis

Acquisition source should be normalized but lightweight.

Supported sources:

- Pulled from pack.
- Purchased single.
- Trade.
- Gift.
- Existing bulk before tracking.
- Other.

Rules:

- If the user personally pulls a card from a pack and adds it as owned, default cost basis to `$4.49` unless the user overrides it.
- Bulk cards have no per-card purchase cost by default.
- User will not buy bulk himself.
- Use label `Cost Basis Needed` when cost basis is missing.
- Missing cost basis is included in market value totals but excluded from profit/loss calculations.
- Do not add financial or portfolio context to the Collection page.
- Keep JOMW Fund separate from this project.

## Sealed product

Sealed product is tracked separately from card lots but can participate in Trends & Insights when marked Vault or PC.

Sealed product records should support:

- Product name.
- Quantity.
- Acquisition source.
- Collection intent.
- Purchase price / cost basis when known.
- Storage/protection note.
- Market value when available from the existing reference-price mechanism.

Do not model sealed product as card lots.

## Photos and creator media

Each collection lot can have:

- One primary photo.
- User-created social links/photos for:
  - Instagram.
  - Pinterest.
  - Reels.

The user is always the creator. Do not add a creator marketplace or multi-creator model.

## External source policy

John John's PC remains the local source of truth.

Trusted references:

- Collectr: collection tracking reference only; no automation in this pass.
- HoloDex: phone scanning and AI grading reference only; scans do not imply ownership.
- PSA: Vault/investment slab reference.
- TAG: PC/personal art slab reference.
- PokéBeach: Card Search discovery/news source.
- Bulbapedia: Pokemon/media/card lore reference.
- JustWatch: streaming availability reference.

Rules:

- HoloDex scan history is retained locally for 14 days.
- Every scanned card is not automatically owned.
- If Collectr has an item missing from John John's PC, support manual sync/review later; do not build automatic overwrite now.
- Retain Gmail-derived acquisition evidence only as:
  - source reference,
  - sender,
  - recipient,
  - date,
  - timestamp,
  - normalized acquisition details.
- Do not retain unnecessary email body content.

## Card Search

Card Search is the discovery surface and opens to the full Pokemon card catalog.

Required behavior:

- Full catalog browsing/search.
- Owned Only toggle.
- Clear Add to Collection action.
- Fast card identification.
- Add lots.
- Explore sets.
- Browse inspiration signals.

Discovery rail modules:

- New Set Drops
- Meta & Deckbuilding
- Trending Cards

Source current discovery modules from PokéBeach only.

Bulbapedia references:

- Use `In Animation`.
- Use subheading format `Featured In {{TITLE}}`.

JustWatch references:

- Offer `Currently available on [#] streaming services.`
- Link to the relevant JustWatch US title page.

Do not reference Pokemon.com.

## All Cards

All Cards is the master catalog and set-completion surface.

It should support:

- Full card catalog.
- Expansion/set browsing.
- Completion progress.
- Missing cards.
- Add missing card to Chase Cards.

Use `All Cards` in primary navigation. Do not expose `Master Set` as the nav label.

## Trends & Insights

Trends & Insights contains:

- Visualize: recent additions and total growth.
- Discover: relevant news/trending cards.
- Master Set: expansions closest to completion.
- Portfolio Performance: profit/loss and portfolio analysis scoped to collection holdings only.

Portfolio Performance scope:

- Vault.
- PC.
- Only the top 5-10% by market value in Main Collection.

Rules:

- Show Vault, PC, and highest-value Main Collection subset clearly.
- Include sealed product only when marked Vault or PC.
- Show card and sealed-product counts separately when both exist.
- Use `Cost Basis Needed`.
- Include missing-basis items in market value.
- Exclude missing-basis items from profit/loss.
- Do not mention JOMW Fund or private equity integration.

## Settings

Settings should explain the local-first control model:

- John John's PC is local-first.
- External AI is disabled unless explicitly added later.
- Imports are manual and reviewed.
- Excel export is local.
- Backups use the configured local/OneDrive path.
- Collectr and HoloDex are trusted references, not active automations.

No reduced-motion setting.

## Export and backup

Excel `.xlsx` is the official portable backup format.

Backup destination pattern:

- `C:\Users\%USERNAME%\OneDrive\John John's PC`

Use a Grandfather-Father-Son backup scheme.

Excel export should include:

- Cards.
- Sealed Product.
- Acquisition & Storage.
- Cost basis fields.
- Condition/protection fields.
- Source references.

Do not export credentials, external tokens, or unnecessary email contents.

## Implementation modules and seams

### Collection Lot module

Interface:

- Create/update owned lots.
- Normalize acquisition source.
- Apply default cost basis only when omitted.
- Store condition/protection/card-history metadata.

Implementation:

- SQLAlchemy model additions.
- Pydantic schema validation.
- Existing collection route preservation.
- Frontend lot editor controls.

Depth requirement:

- Callers should not know cost-basis defaulting rules or source normalization details.

### Product Inventory module

Interface:

- Track sealed products.
- Mark collection intent.
- Store acquisition/source/storage/cost basis.
- Report sealed counts and value.

Implementation:

- Existing product model and product routes.
- Additive storage/acquisition fields where missing.

Depth requirement:

- Do not force Collection page callers to know sealed-product schema details.

### Portfolio Summary module

Interface:

- Return scoped value, cost basis, profit/loss, missing-basis count/value.
- Separate card counts and sealed-product counts.

Implementation:

- Backend analytics calculation.
- UI labels and cards.

Depth requirement:

- UI should not reimplement P/L exclusion logic.

### Discovery module

Interface:

- Provide discovery rail groups:
  - New Set Drops.
  - Meta & Deckbuilding.
  - Trending Cards.

Implementation:

- PokéBeach adapter for current release.
- Static fallback data if network unavailable.

Depth requirement:

- Card Search should render normalized discovery items, not source-specific scraping details.

### Scan History module

Interface:

- Retain local scan history for 14 days.
- Distinguish scanned from owned.

Implementation:

- Local persistence/API as currently appropriate.

Depth requirement:

- Collection ownership flows must not infer ownership from scans.

### Export module

Interface:

- Download `.xlsx` backup.
- Include cards, sealed product, acquisition/storage.

Implementation:

- openpyxl workbook stream.
- Existing export route family.

Depth requirement:

- Frontend calls one export function and does not know workbook details.

## Test plan

Every behavior change should be covered by focused tests before broad validation.

Required focused tests:

- Primary nav exact labels.
- Product name and metadata show `John John's PC`.
- Collection heading is `My Collection`.
- No reduced-motion setting is rendered.
- Card Search opens as full catalog.
- Owned Only toggle remains.
- Add to Collection remains.
- Discovery rail uses:
  - New Set Drops.
  - Meta & Deckbuilding.
  - Trending Cards.
- Pokemon.com does not appear in discovery UI.
- Wishlist does not appear; Chase Cards does.
- `Track`, `Chase`, `Grail` appear where chase status is managed.
- Grail star appears.
- `Cost Basis Needed` appears for missing basis.
- Missing cost basis is excluded from P/L.
- Missing cost basis remains included in market value.
- Portfolio scope states Vault, PC, and top 5-10% Main Collection.
- Sealed product counts separate from card counts.
- Excel export contains cards, sealed product, and acquisition/storage sheets.
- Settings describes local-first, manual imports, and local Excel export.
- HoloDex scans do not create ownership.

Required broad validation:

- Frontend tests.
- Frontend production build.
- Backend tests.
- Local frontend health:
  - `http://127.0.0.1:13000`
- Local backend health:
  - `http://127.0.0.1:18080/api/health`
- Manual browser smoke of:
  - Collection.
  - Card Search.
  - All Cards.
  - Trends & Insights.
  - Settings.

## Deployment plan

1. Confirm current git status and preserve unrelated user changes.
2. Apply implementation in small patches by module.
3. Run focused tests after each module.
4. Run full frontend tests and build.
5. Run backend tests.
6. Rebuild Docker frontend/backend if code changed.
7. Restart local containers with the local override.
8. Smoke localhost routes.
9. Report exact passing checks and any skipped checks.

## Completion criteria

This plan is complete when:

- The visible app is John John's PC.
- The five primary nav labels are exact.
- Collection is headed My Collection.
- Card Search is the full catalog/discovery surface.
- All Cards is the catalog and completion surface.
- Trends & Insights uses the settled four-section model.
- Settings states local-first controls.
- Motion is present and intentional.
- No reduced-motion setting exists.
- John John is faceless, ambient, and Tron-program-like.
- Cost basis and missing-basis behavior are correct.
- Sealed product and card lots are both represented correctly.
- Excel export is working.
- Local Docker deployment is running and smoke-tested.

