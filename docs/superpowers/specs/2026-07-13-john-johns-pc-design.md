# John John's PC Design

## Purpose

Transform the locally hosted Pokemon TCG Tracker into **John John's PC**: a premium, collection-centric Pokemon TCG archive inspired by Bill's PC and grounded in Fluent 2.

The collection is the hero. John John is its subtle curator, not a chatbot, mascot, or financial analyst.

## Phase-one boundary

Phase one is an archive-first Fluent transformation. It preserves the current database, API contracts, local Docker override, card data, and binder records. It does not add a generative AI service, migrate collection data, or make market value the product's central experience.

The existing local Docker override remains unmodified and uncommitted.

## Information architecture

Primary navigation has five destinations:

1. **Archive** — default landing experience. Shows a featured card or set, recent additions, visual set-progress moments, and sparse Archive Notes.
2. **Collection** — art-forward card gallery, with a compact inventory view for archival work.
3. **Boxes** — primary organization metaphor, implemented over existing binder data in phase one.
4. **Sets** — visual set shelves, completion status, and missing-card discovery.
5. **Discover** — card search, scanner, wishlist, set-completion prompts, and global archive search.

Market observations, achievements, sealed products, imports, settings, and existing multi-user tools become contextual or secondary surfaces. The collection stays private by default; existing multi-user capability remains intact but is no longer part of the core experience.

Legacy URLs continue to work through redirects to their renamed destinations.

## Responsive shell

Desktop uses three zones:

- A slim navigation rail.
- A generous central collection canvas.
- A quiet contextual panel that surfaces John John only when relevant.

Mobile uses a five-item bottom navigation for Archive, Collection, Boxes, Sets, and Discover. John John appears in the Archive header rather than consuming a navigation slot.

## Visual direction

### Foundation

- Default theme: **Midnight Archive**, using deep navy-black canvas tones, softened elevated surfaces, restrained electric-blue signal color, and Pokemon card art as the principal color source.
- Companion light theme: accessible and intentionally designed, replacing the current Pokemon-type theme picker.
- Fluent 2 principles: spacious layouts, rounded geometry, soft depth, visible focus states, responsive behavior, strong hierarchy, and accessibility-first contrast.
- Typography: Segoe UI Variable with system fallbacks.

### Identity

- Product name: **John John's PC**.
- Application identity: original JJ archive mark and JOHN JOHN'S PC wordmark.
- Pokemon imagery belongs to collection content, never to the application chrome.
- Rename browser metadata, PWA manifest, navigation, headers, loading states, empty states, splash treatment, and API documentation title. Keep endpoints stable.

### John John presence

John John is represented by an abstract JJ archive signal: light, waveform, or glyph. He is never a character illustration, human avatar, Pokemon, chat panel, or permanent assistant surface.

The signal is small and persistent in the desktop context area and Archive header. It expands only for meaningful observations.

## Interaction model

### Archive and collection

- Archive opens by default, not a dashboard or raw card grid.
- A rotating Featured Card / Set is selected from collection activity; the user can pin a personal favorite.
- Collection defaults to a large, art-forward gallery with a compact list alternative.
- Card selection opens an immersive detail surface: side-by-side archive view on desktop and bottom sheet on mobile.

### Intake and discovery

- **Add to Archive** is the single intake action for scanner, search, manual entry, and import.
- Discover provides a global **Search the archive** command bar, including `/` and `Ctrl+K` shortcuts.
- Set completion uses visual shelves and missing-card moments as the primary signal; percentages are secondary.

### Boxes

Boxes are a phase-one presentation layer over binder records. The existing data model stays unchanged. Traditional binder views remain available inside the Box experience.

## John John and insights

Phase one derives John John moments solely from existing collection signals:

- New cards and recent additions.
- Set completion thresholds and missing-card proximity.
- Collection milestones.
- Notable discovery or search results.

Meaningful observations are saved in a sparse, reviewable **Archive Notes** timeline. They are not a chat log.

Market information appears only in card detail, Archive Notes, or optional observation views. It must never be the hero metric on Archive.

Future intelligence is local-first. Any external AI or market service must require explicit opt-in and must not receive collection data by default.

## Motion and accessibility

Motion communicates discovery, activity, presence, and intelligence. It includes purposeful page transitions, card hover and focus feedback, loading states, collection reveals, and restrained milestone reveals.

Milestones use a brief archive-reveal moment rather than confetti or game-like rewards. Motion honors the operating system's Reduce Motion preference, with in-app subtle and full settings.

## Implementation approach

- Introduce Fluent UI v9 as the primary component foundation.
- Retain Tailwind only where it supports app-specific layout and archive effects.
- Replace legacy visual/theme utilities with a compact token layer for color, typography, depth, spacing, motion, and accessibility states.
- Preserve APIs and data. No phase-one backend migration is required.
- Preserve the local Docker override and port arrangement.

## Validation

Before release, verify:

- Production frontend build succeeds.
- Existing local app routes and redirected legacy routes work.
- Desktop and mobile layouts are usable.
- Keyboard navigation, focus states, contrast, and reduced-motion behavior are correct.
- Collection, binders/Boxes, sets, search, scanning, and imports retain their existing behavior.
- Local hosting and API paths remain available.

## Explicit non-goals for phase one

- A chatbot or chat interface.
- A character or mascot for John John.
- A data migration to a new Box model.
- A new generative AI backend.
- Trading-site or portfolio-dashboard presentation.
- Removing existing collection functionality merely because it is no longer in primary navigation.
