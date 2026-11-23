# Installable app and offline start (PWA)

PokéCollector can be added to an iPhone Home Screen, and, when you switch it on, saves its own app files on the device so the app can start without a network. This page describes the behaviour that is shipped today. The design rationale is in [`PWA_OFFLINE_DESIGN.md`](PWA_OFFLINE_DESIGN.md).

## Install on iPhone

1. Open your PokéCollector address in **Safari** (not an in-app browser).
2. Tap **Share**, then **Add to Home Screen**, then **Add**.
3. Start it from the new icon. It opens in its own window without browser bars.

Installing needs no server setting. Offline start (below) is a separate, opt-in feature.

## HTTPS is required for offline start

Browsers only allow service workers on **secure origins**: `https://` with a trusted certificate, or `http://localhost`. On a plain `http://192.168.x.x` address the app still works and can still be added to the Home Screen, but the service worker never registers, so there is no offline start. Options:

- Put the app behind a reverse proxy with a real certificate (Nginx Proxy Manager, Caddy, Traefik, a Cloudflare Tunnel, or Tailscale `serve`), or
- Use a hostname with a certificate your devices trust. A self-signed certificate that the phone does not trust does not work.

## Reverse proxies must not cache `/sw.js`

The service worker script must always be fetched fresh, otherwise updates and the kill switch reach phones late.

- PokéCollector's own nginx sends `Cache-Control: no-cache` for `/sw.js`, `/sw.real.js` and `/sw.kill.js`. Keep any proxy in front of it from overriding that header.
- **Nginx Proxy Manager:** turn the **Cache Assets** option **off** for the PokéCollector proxy host. When it is on, NPM caches every path ending in `.js`, `.css` or an image extension (including `/sw.js`) for 30 minutes, ignores the app's `Cache-Control` and may serve a stale copy when the app is down.
- Other proxies (Caddy, Traefik, Cloudflare, Varnish, CDNs): do not add a cache rule or "cache everything" page rule that matches `/sw.js`.

## The two flags

Both are environment variables of the **frontend** container, read when it starts. Recreate the container after changing them (`docker compose up -d`). Empty means the default, which is off.

| Variable | Default | Effect |
|---|---|---|
| `PWA_ENABLED` | off | `true` serves the real service worker at `/sw.js`; the app caches its own files and can start offline. `false` serves the kill worker, which removes any installed worker. |
| `OFFLINE_QUEUE_ENABLED` | off | `true` turns on the upload hardening below, the cached sign-in, the logout protection and the offline scan queue. Setting it back to `false` stops the queue; items already waiting stay on the device, so turn it on briefly to sync them before disabling. The Sync center remains available for server synchronization when offline features are disabled. |

Accepted values: `true`, `1`, `yes`, `on`, `false`, `0`, `no`, `off` (any case). An invalid value logs a warning and uses the default.

## What the service worker does

- Saves the app's own files (`/assets/*`, icons, manifest) when it installs, then serves them from the device.
- Opens pages from the network first (2.5 seconds), and falls back to a saved copy of the app shell when the network is down. Without a saved shell it shows a short bilingual "you are offline" page.
- Saves public card, set and Pokédex images for faster loading (up to 800). Offline, a large card image that was never saved falls back to the small copy of the same card.
- **It caches no user data.** API calls, your collection, prices, photos you took and scan results are never stored by it.
- It never updates itself in the middle of your work. A bar offers **Update** when a new version is ready.

## Updating

A new release installs in the background while the old one keeps running. The bar "A new version is available." appears; tap **Update** to reload into the new version. If a scan upload is in progress the app asks you to finish first.

## Kill switch (if a release misbehaves)

You never need to clear site data. Three levels, from least to most effort:

1. **L1 – operator:** set `PWA_ENABLED=false` and recreate the frontend container. The next time a phone checks for an update (opening the app, or within 30 minutes of foregrounding it) the kill worker replaces the broken one, deletes its caches and unregisters itself.
2. **L2 – any user, one URL:** open `https://YOUR-ADDRESS/?pc_sw=off`. The page unregisters every worker, deletes the `pc-*` caches, removes the parameter and reloads. It leaves your queued data untouched.
3. **L3 – in-app reset:** with `OFFLINE_QUEUE_ENABLED` on, open **/offline** (the Offline center) and tap **Reset offline app data**. It unregisters the service worker, deletes the `pc-*` caches and the saved copies of your viewed data, and keeps items waiting to sync. The sync sheet itself has no reset button, and the Offline center needs the app to start, so L2 is the way out when it does not.

L2 and L3 do not depend on `/sw.js`, so they also work when a proxy cached a stale worker.

## Photo upload hardening

Safari on iOS has a bug where a photo chosen from the library can upload as an empty file. When `PWA_ENABLED` or `OFFLINE_QUEUE_ENABLED` is on, uploads (scanner photos, collection card photos, CSV and backup restore) are first copied into memory (files up to 8 MiB) or re-sliced (larger files) with the original filename kept. If a photo still arrives empty the server answers with an explicit error instead of saving it. With both flags off the upload code behaves exactly as before.

## Push notifications for price alerts

Wishlist price alerts can also arrive as a notification, next to Telegram.

1. Serve the app over HTTPS and set `PWA_ENABLED=true` (push needs the service worker).
2. On iPhone, install the app first: Share, then **Add to Home Screen**, and open it from the Home Screen icon. Safari tabs cannot receive push; Settings then shows a hint instead of buttons.
3. Open Settings, **Notifications**, and tap **Enable on this device**, then allow notifications. **Send test notification** checks that it works.

Each device is enabled separately. If notifications stop, tap **Disable** and **Enable** again. A subscription the phone has dropped is removed from the server automatically the next time it fails. The server keeps its signing key in `./data/auth` (see [DEPLOYMENT.md](DEPLOYMENT.md)); losing it only means turning notifications on again. Details: [BACKEND.md](BACKEND.md#web-push).

## Opening the app offline (cached sign-in)

With `OFFLINE_QUEUE_ENABLED` on, the app remembers who was signed in (id, name, role, avatar; never the password or token) in this browser for up to 90 days. If the server cannot be reached when the app starts, it opens in a *degraded* state from that memory instead of the "Cannot reach PokéCollector" screen. The remembered user is only for display; the server checks every request. The startup check gives up after 5 seconds, so a request that hangs (as iOS does for some offline requests) does not hold the app on the connection screen. The app keeps retrying in the background and switches to normal as soon as the server answers. Without a remembered sign-in (first visit, after logout, expired, or a pending password change) the connection screen shows as before.

## Logging out with unsynced items

If items are waiting on this device, logging out asks what to do:

- **Sync first** sends them now. If anything is still waiting afterwards, you are asked again.
- **Log out and keep items** logs out and leaves them on the device, tied to your account and this server address. They are not shown to other accounts.
- **Log out and delete items** deletes the waiting items of your account from this device. Choose this on a shared device.
- **Cancel** stays signed in.

Sync before moving the app to a different address or port: waiting items belong to the old address.

## Sync center

The existing red **Sync** button at the top right of **Home** opens **Sync center** at **/offline**, instead of starting synchronization immediately. It is the only in-app entry to the center; there is no additional global button or shortcut on other pages. It is available to all signed-in users for their personal controls, including when the queue is empty or a server job is running. Shared server actions inside the center remain admin-only.

Page navigation uses one shared scroll policy across the app. Opening a different page starts at the top once it is ready. Back/Forward keeps the existing browser or list restoration, while in-page filters, tabs and explicit section anchors do not trigger a page reset.

**Reset offline app data** requires confirmation before clearing cached app files, saved pages and downloaded artwork. Cancel, Escape or closing the dialog leaves data untouched. Queued changes and scan photos, along with the online collection, are preserved after a confirmed reset. A confirmation from a previous page or sign-in cannot reset a later session.

- **Automatic offline downloads** saves the signed-in user's collection and artwork on this device. It has moved out of Settings → General and remains off by default. This is separate from sending waiting changes to the server.
- With offline features enabled, the button also shows *Offline mode*, *Waiting to sync*, *Syncing…* or *Needs attention*, with a count. **Changes waiting on this device** lists each waiting item with its state and age. **Retry** puts a failed or blocked item back in line, **Discard** removes it after a confirmation (it has not reached the server and cannot be recovered). **Sync now** sends everything immediately, even with **Automatic sync** switched off; that switch only stops background attempts to send queued changes.
- **Server catalogue and prices** is admin-only. It contains the existing full catalogue and price sync actions, intervals, catalogue languages, digital-set and cross-language fallback options, plus the custom-card matching shortcut. These settings affect the installation, not just the signed-in user's device. Existing API endpoints and scheduling behavior are unchanged. They have moved out of Settings → Data & Sync; that tab is now **Data**, with backups, import and export still there.
- A banner appears when the server could not be reached twice in a row, or when the device says it is offline. It is based on actually asking the server (`/api/health`), not on the phone's own online flag, and it disappears after the first successful answer. While it shows, pages that need the server (anything except Home, Dashboard, Collection, Wishlist, Sets, Binders, Search and the sync center) show "This page isn't available offline." instead.
- The page also shows connection state and server version. With offline features enabled, it includes device storage use, what this browser supports (HTTPS, service worker, storage, installed, push), the iPhone install hint and **Reset offline app data**. Reset removes cached app files and the saved copies of your data and keeps waiting items. Items for other accounts are counted without exposing their contents.

Items waiting here exist only on this device until they reach the server. The app asks the browser to protect its storage (`navigator.storage.persist()`), shows how much space is used, and keeps a marker so it can tell you when the browser deleted its offline data anyway ("Some offline data was removed by the browser…"). In a Safari tab (not the Home Screen app) it warns once an item is 3 days old, and more strongly after 7 days, because Safari can delete data of websites that were not opened for about a week. Sync items in the browser before adding the app to the Home Screen: the installed app has its own storage.

Only scan uploads are queued from the app. Offline collection and wishlist adds are not part of this work, so there is no *Edit* for queued adds; the center offers Retry and Discard only.

## What you can see offline

With `OFFLINE_QUEUE_ENABLED` and **Automatic offline collection** on, the app keeps a copy of the data you have already looked at, so a degraded start (server unreachable) shows it instead of empty pages. Above the page it says *Showing saved data from <time ago>* while the server cannot be reached.

- **Which pages:** Collection, Wishlist, Dashboard, Sets and their checklists, Binders and their cards, the scanner configuration, printing tags and the investment tracker. Only data you actually opened is saved, after a successful load (at most every 5 seconds). Saved pages you do not open again are kept until they are 30 days old.
- **Limits:** collection metadata has a 10 MiB limit; other pages have a 5 MiB limit. The total stays under 20 MiB (the oldest data goes first); a copy older than 30 days, or saved by a different app version, is ignored.
- **Per user:** each account on this device and server address has its own copy, in a separate browser database from the waiting items. Signing in as someone else deletes every other account's copy.
- **Cleared at logout:** logging out (whatever you choose about waiting items; cancelling keeps you signed in) deletes your copy. **Reset offline app data** on /offline deletes every copy.
- **Settings and exchange rates:** the last settings (per user) and exchange rate (per currency pair) are also kept in the browser, so an offline start keeps your currency instead of falling back to EUR. They are cleared at logout.
- **Read-only:** you can look, but changes still need the server. Pages outside this list say "This page isn't available offline."

## Save the whole collection for offline use

With `PWA_ENABLED` and `OFFLINE_QUEUE_ENABLED` on, **Sync center → Automatic offline downloads** is off by default for each user. After explicitly enabling it, while signed in, online and using the app, it saves the complete collection metadata and downloads every available public card original automatically, regardless of the current page or filter. Downloads can use mobile data; iPhone web apps cannot reliably detect Wi-Fi, so enable this only when comfortable with that data usage. Explicitly saved user preferences are preserved. It uses a separate cache, so the browsing cache's 800-image limit does not remove these originals.

- The Sync center shows saved and total image counts. Reopening or reconnecting resumes the download. Each cached URL and revision is checked, so completed files are reused and only missing files or changed artwork are downloaded again.
- Switching the setting off first asks for confirmation with **Cancel** and **Deactivate and delete**. Cancelling or dismissing the dialog leaves downloads, saved data and the preference unchanged. Confirming cancels the transfer, waits for already-started storage writes, and removes saved read-only snapshots and public artwork from this browser. A persistent worker policy prevents ordinary browsing from recreating artwork caches while it is off. Other open tabs using the same account and storage receive the changed preference. The installed shell, push registration, waiting scan photos and online collection are preserved. Reset and logout also stop the automatic writer before clearing metadata.
- Downloads run while the app can execute JavaScript, not as a guaranteed closed-app background job. iPhone may pause them when the app closes or the screen locks. Automatic downloads can use mobile data.
- Custom, private, or thumbnail-only artwork is not downloaded. The count is shown explicitly and those cards use a card back offline. Owner photos are never placed in the public image cache.
- A failed or oversized metadata save is reported as a failure, never as a completed download. Collection metadata is limited to 10 MiB and all saved query data to 20 MiB. Image requests have a timeout and storage/quota failures stop the download without deleting waiting scan uploads.
- Public image bytes and private collection metadata use different storage. Metadata stays account-specific and is removed at logout or an offline-data reset. Reset also removes downloaded artwork but keeps waiting uploads.
- Browsers can still remove stored data. This is a download, not a permanent backup. Offline changes to collection ownership are not supported.

For other clients, authenticated **`GET /api/collection/offline-manifest`** returns `version`, `user_id`, the complete `items`, distinct versioned `image_urls`, and `missing_artwork_card_ids`. Its response is private and must not be cached by a shared proxy. The endpoint reads only the signed-in account's collection and does not change ownership or download files onto a device. A client must fetch the listed same-origin artwork URLs and save its own account-scoped metadata. The opt-in per-user preference is `offline_collection_enabled` (`"true"` or `"false"`, default `"false"`) through the existing authenticated settings API, including **`PUT /api/settings/`**. An API change is applied when an app instance loads the updated setting; the server cannot directly delete storage from a closed browser.

To keep an older request from overwriting a newer choice, read **`GET /api/settings/`** and send its `offline_collection_revision` value in the **`X-Offline-Preference-Revision`** header with the preference PUT. For example, send `{"offline_collection_enabled":"false"}` with `X-Offline-Preference-Revision: 0` if GET returned `"offline_collection_revision":"0"`. A successful save increments the revision and returns it in the settings response. A stale revision returns **409 Conflict** without changing the preference. Read the revision again and retry only if that choice is still the user's latest intent. The revision belongs to the signed-in account and is read-only; including it in the JSON body returns 422. Existing clients without the header retain unconditional-save compatibility, but should use the header when requests can overlap.

The app saves a confirmed disable locally before contacting the server, including while offline. It keeps that account's pending choice across reloads and uses conditional saves after reconnecting. An acknowledgement for an older choice cannot clear a newer pending choice.

## Scanning without a connection

With `OFFLINE_QUEUE_ENABLED` on, **Start scanning** never waits for the network. The photos are saved on the phone first; then:

- If the server is known to be reachable, the app tries to upload straight away and waits at most about 5 seconds. If that finishes you land on the scan as before. If it does not, the scanner closes with "Saved on this device. It will sync automatically." and the upload carries on in the background.
- If the server is not (yet) known to be reachable, the scanner closes at once with the same message and the photos upload when the server answers.
- Each upload is sent exactly once: it carries a key the server uses to ignore a repeat, so a lost response does not create a second scan.

Limits: 15 MB per photo, 12 photos or about 10 MB per waiting item (a bigger batch becomes several items, so several scan jobs), 50 photos per scan and 300 MB of waiting photos in total. If there is not enough space the scanner stays open with your photos and says so. The server's 14-day retention of scan photos starts when the upload arrives, not when you took the photo. HEIC/HEIF photos are stored and uploaded unchanged. While photos are staged or being saved, the "new version available" banner will not reload the page.

## Limitations

- The first visit must happen online; there is nothing to start from before that.
- Plain `http://` addresses never get a service worker (see HTTPS above).
- iOS can remove stored website data after a long period of non-use; the app then behaves like a first visit.
- Safari Lockdown Mode disables service workers. The app keeps working online.
- Offline start shows the app shell; data you viewed earlier is shown from a saved copy (see What you can see offline); anything you never opened is not available.

## Privacy

The service worker caches no user data. It stores the app's public static files and public card images only. The saved copy of your viewed data (above) is kept by the app itself, per user, and deleted at logout. Per-user information stays in the places it already lived in.

## For developers

See [`FRONTEND.md`](FRONTEND.md) (service-worker build, tests, file map) and [`DEPLOYMENT.md`](DEPLOYMENT.md) (headers, entrypoint order, rollback).
