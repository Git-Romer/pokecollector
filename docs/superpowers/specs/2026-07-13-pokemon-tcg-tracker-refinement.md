# Pokémon TCG Tracker Refinement

## Purpose

Refine the locally hosted Pokémon TCG Tracker into a personal, collection-first
databank. The tracker remains the visible product and the user’s source of
truth. John John supplies an ambient, local-only design presence; he does not
rename, own, or compete with the collection.

## Product identity and navigation

- Visible product name and browser/PWA metadata: **Pokémon TCG Tracker**.
- The tracker wordmark returns to the root **Collection Overview** route.
- Primary navigation remains exactly: **Collection**, **Card Search**, **Sets**,
  **Analytics**, and **Settings**.
- Existing routes remain reachable; renamed or retired paths redirect quietly.
- The existing multi-user capability remains available in Settings but the
  experience is personal and single-user by default.

## Collection Overview and John John

Collection Overview is an unpriced landing surface, not a dashboard. It shows:

1. a manually pinnable Featured Card;
2. recent additions;
3. sets close to completion; and
4. dismissible John John’s Notes.

Notes are derived locally from collection state, explain why they appear, and
never send collection data to an AI service. The JJ signal is compact and
faceless. It is quiet at rest, and may animate only while collection data is
loading, a file is importing, or a new note appears. It is never a chat panel,
avatar, notification channel, or permanent side panel.

## Visual system

- Desktop uses a slim left rail; mobile uses the same five destinations in a
  bottom navigation bar.
- Use a black, warm-white, and restrained orange collection palette inspired by
  the requested City Connect reference. The John John spectrum is reserved for
  the JJ signal.
- Use Inter: Black for display, Semi Bold for UI labels, and Regular for body
  copy.
- Dark is the default, with a complete accessible light theme.
- Motion is purposeful: gallery reveals, card hover/focus feedback, and loading
  transitions. It must respect system and in-app reduced-motion preferences.
- Fluent 2 principles remain the UI foundation: spacious layouts, rounded
  surfaces, soft depth, visible focus states, responsive behavior, and
  accessible contrast.

## Collection model

- Collection opens to **Owned** and defaults to an art-forward Gallery Showcase;
  a compact inventory view remains available for management.
- Reference price appears only in card detail, never as Collection Overview’s
  primary content. Analytics emphasizes duplicates, rarity, completion, and
  activity; financial performance is secondary or hidden by default.
- Each intake record has an acquisition source: Pulled, Bulk / before tracking,
  Purchased, Trade, Gift, or Other.
- Pulled cards prefill a $4.49 cost basis that remains editable.
- Existing bulk is captured as Bulk / before tracking with a $0 cost basis;
  purchased-bulk lot management is not required.
- Protection/storage uses structured values (Raw, Penny Sleeve, Card Saver,
  Top Loader, PSA Slab, Sealed) plus an optional freeform note.
- Physical location uses reusable categories (Binder, Storage Box, Display,
  Slab Case, Other) plus an optional detail.
- Graded cards support grader, grade, and optional certification number.
- Sealed product lives in Collection as its own record type and captures product
  name, quantity, acquisition source/date, cost basis, location, and notes.

## Discovery, organization, and data control

- Typed Card Search is primary; the existing scanner remains optional.
- Near-complete sets can offer a one-click, manual add-to-wishlist action.
- Physical organization is called **Binders**, preserving the original tracker
  language.
- HoloDex, Collectr, and PSA are supplementary manual-import sources. Their
  records enter a review queue and never automatically overwrite or merge the
  tracker’s records.
- The official portable backup is Excel (.xlsx), with Cards, Sealed Product, and
  Acquisition/Storage sheets. Create weekly local backups and retain eight.
- Keep operational data and backups with the tracker. Obsidian receives only a
  lightweight journal of milestones, acquisition decisions, and backup links.
- Future external AI is disabled by default and must use explicit, explained
  opt-in. Collection insights remain in-app only: no email, push, or external
  notifications.

## Boundaries and validation

Preserve the existing database, API paths, Docker override, card records, and
collection behavior. Do not change the protected uncommitted
`docker-compose.local.yml` file. Validate refined UI behavior with focused
tests, full frontend tests/build, backend tests, and local-stack smoke checks.
