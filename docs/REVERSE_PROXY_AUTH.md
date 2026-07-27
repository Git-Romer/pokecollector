# Reverse proxy authentication

PokéCollector can run behind Authentik, Authelia, oauth2-proxy, or another authentication layer at the reverse proxy.

The proxy sees every request before PokéCollector does. This means the public-profile settings inside PokéCollector cannot make a route public if the proxy still requires a login for that route.

## Public profile route contract

Allow unauthenticated access to these paths when public profiles should be reachable outside the proxy login:

| Path | Purpose |
| --- | --- |
| `/u` and `/u/*` | Public trainer directory, profiles, and binders |
| `/api/public/*` | Anonymous public-profile and binder data |
| `/api/images/card/*` | Card artwork used by public binders |
| `/api/pokedex/images/sprites/*` | Trainer avatars used by public pages |
| `/assets/*` | Compiled JavaScript, CSS, and lazy-loaded page bundles |
| `/pokeball.svg` and `/cardback.jpg` | Public-page and missing-card artwork |
| `/favicon.ico`, `/favicon-48.png`, `/apple-touch-icon.png`, `/manifest.json`, `/icon-192.png`, `/icon-512.png`, and `/robots.txt` | Browser, PWA, and crawler assets |

Keep every other application route behind the proxy. In particular, do not allow all of `/api/*`. Authenticated collection, settings, sync, backup, and administration endpoints are under that prefix.

PokéCollector still applies its own sharing controls after a request reaches the app:

1. An administrator must enable public profiles.
2. The trainer must publish their profile.
3. Each collection binder must be shared separately.
4. Collection values remain hidden unless the trainer enables them.

## Authentik

Authentik proxy providers support an **Unauthenticated Paths** or **Unauthenticated URLs** field. Each line is a Go regular expression.

For proxy mode or forward auth for a single application, Authentik matches the request path. Add:

```text
^/u(/.*)?$
^/api/public(/.*)?$
^/api/images/card/.*$
^/api/pokedex/images/sprites/.*$
^/assets/.*$
^/(pokeball\.svg|cardback\.jpg|favicon\.ico|favicon-48\.png|apple-touch-icon\.png|manifest\.json|icon-192\.png|icon-512\.png|robots\.txt)$
```

For domain-level forward auth, Authentik matches the complete URL instead. Replace `cards.example.com` with the PokéCollector host:

```text
^https://cards\.example\.com/u(/.*)?(\?.*)?$
^https://cards\.example\.com/api/public(/.*)?(\?.*)?$
^https://cards\.example\.com/api/images/card/.*$
^https://cards\.example\.com/api/pokedex/images/sprites/.*$
^https://cards\.example\.com/assets/.*$
^https://cards\.example\.com/(pokeball\.svg|cardback\.jpg|favicon\.ico|favicon-48\.png|apple-touch-icon\.png|manifest\.json|icon-192\.png|icon-512\.png|robots\.txt)(\?.*)?$
```

If the installation uses HTTP or a non-standard port internally, match the URL that Authentik receives. Authentik documents the difference between provider modes in its [proxy provider documentation](https://docs.goauthentik.io/add-secure-apps/providers/proxy/#allowing-unauthenticated-requests).

These exceptions expose the files and endpoints needed to render anonymous public views. Compiled frontend assets and globally visible card artwork are available through the listed routes, but protected collection data and administration APIs remain behind authentication. They do not make PokéCollector use the identity supplied by Authentik. Native OIDC support would be a separate authentication integration.

## Verification

Test from a private browser window without an Authentik session:

1. Open `/u`.
2. Open a trainer profile and one shared binder.
3. Confirm trainer sprites and card images load.
4. Confirm `/settings` still requires the proxy login.
5. Confirm a protected API route such as `/api/collection/` still requires the proxy login.

If the public page HTML loads but remains blank, inspect the browser network panel. A redirect or HTML login response for `/assets/*` usually means the frontend bundles are still protected. Missing card images usually mean `/api/images/card/*` or `/cardback.jpg` is still protected.
