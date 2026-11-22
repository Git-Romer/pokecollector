# OpenID Connect Authentication

PokéCollector can authenticate multi-user installations through one configured
OpenID Connect (OIDC) provider. This is native application authentication: the
backend validates the provider's identity token and then issues the same
PokéCollector JWT used by the existing API. It is separate from reverse-proxy
forward authentication; see [Reverse proxy authentication](REVERSE_PROXY_AUTH.md)
for public-profile proxy exceptions.

## Authentication modes

Set `AUTH_MODE` in the backend environment:

| Mode | Behavior |
|------|----------|
| `local` (default) | Preserves existing local behavior. OIDC endpoints are disabled; single-user mode can authenticate implicitly as admin, and multi-user mode uses local passwords. OIDC variables are ignored. |
| `mixed` | Requires OIDC configuration and authenticated multi-user mode. Local passwords and OIDC sign-in are both available. Existing local accounts can explicitly link one identity for the configured issuer. |
| `oidc-only` | Requires OIDC configuration and an active administrator already linked to that issuer. Password login and HTTP password changes are disabled; no administrator is created from provider claims. |

`AUTH_MODE` is environment-pinned. The Settings mode toggle cannot override it.
`USER_MODE=single` conflicts with `mixed` and `oidc-only`, since those modes
always require authentication. `PUBLIC_MODE` only controls indexing/SEO; it is
not an authentication control.

OIDC accounts need nullable local password hashes, which the automatic startup
migration applies to PostgreSQL. An existing SQLite database cannot drop that
constraint in place, so enabling `mixed` or `oidc-only` against one stops at
startup with an explicit message; recreate the SQLite database or use
PostgreSQL. `AUTH_MODE=local` is unaffected and never applies the OIDC schema
changes, so a pre-OIDC database keeps starting unchanged.

For a new installation, start in `mixed`, create or bootstrap a local admin,
and link the provider identity from **Settings**. After verifying that an active
administrator is linked, change the environment to `oidc-only` and restart the
backend. Startup fails closed if no active linked administrator exists.

## Configure the provider

Register a confidential OpenID Connect client with the provider:

- Use the authorization-code flow. PokéCollector uses PKCE with `S256`.
- Allow the `openid profile` scopes.
- Register the exact redirect URI below; scheme, host, port and path must match.
- Configure a client secret and keep it private.

Example for an application served at `https://cards.example.test`:

```dotenv
AUTH_MODE=mixed
OIDC_ISSUER_URL=https://idp.example.test
OIDC_CLIENT_ID=pokecollector
OIDC_CLIENT_SECRET=replace-with-a-secret
OIDC_REDIRECT_URI=https://cards.example.test/api/auth/oidc/callback
OIDC_DISPLAY_NAME=Company sign-in
```

The issuer must be the exact issuer identifier from the provider's discovery
document. The backend discovers metadata at the issuer's standard
`/.well-known/openid-configuration` endpoint. It does not accept a request-host
derived callback or a separately supplied discovery URL.

`OIDC_REDIRECT_URI` must use HTTPS except for literal loopback development
hosts. Its path must be exactly `/api/auth/oidc/callback`; register that full
URI at the provider. The browser's application origin is derived from this
configured value, not from `Host` or forwarded headers. OIDC state-changing
POSTs require that exact origin and JSON content type.

The bundled Compose file passes these variables only to the backend. Copy the
example environment file, set the values there, and do not commit the client
secret. Leave `AUTH_MODE` unset or blank to retain local behavior.

## User accounts and identity linking

Provider identities are keyed by the exact pair `(issuer, subject)`. Email is
not used as an account key and is not used to attach an identity to an existing
user. The provider's optional `preferred_username` or `name` may be used as a
sanitized initial local username. When discovery advertises a `userinfo_endpoint`,
the backend fetches its JSON response using the access token after validating the
ID token. The response's `sub` must exactly match the validated ID-token subject.
Valid ID-token profile values take precedence; UserInfo fills missing profile
values. This supports providers such as Authelia that normally return profile
claims through UserInfo rather than the ID token.

**Access control in `mixed` mode:** any identity that the provider authenticates
is provisioned a trainer account on its first sign-in. PokéCollector does not
consult groups, roles or an allowlist before creating that account, so the
provider's own access rules are the only gate: restrict which users may obtain
tokens for this client at the provider. `mixed` is intended for linking existing
local accounts during rollout, not as open self-service registration.

Providers without a UserInfo endpoint retain ID-token-only profile lookup. If
neither source supplies a usable name for a new identity, the completion page
asks the user to choose an account name before creating the local account. Names
must be 2–32 characters after trimming and available; a rejected name can be
corrected while the original browser-bound sign-in remains valid. No account or
application token is created merely by displaying the form. The existing
60-second completion window is not extended by the form or validation errors;
after it expires, start sign-in again.

Usable provider-supplied names are still assigned automatically, with a random
suffix on collision. A manually chosen name is never silently suffixed. New
OIDC-only accounts are trainers and have no local password. Later sign-ins do not
overwrite an existing local username or ask for a new one; users can change it in
Settings without changing their identity link or collection ownership. Roles
remain local to PokéCollector.

In `mixed` mode, an active local user can link one identity for the configured
issuer from **Settings**. Linking requires the current local password, the same
browser and bearer session throughout the flow, and a fresh provider
authentication. It does not change the user's role or replace the application
session. A second start in the same browser invalidates the older flow.

Unlinking is available only in `mixed` mode. It requires the current local
password and explicit confirmation; the identity and its outstanding flows are
removed, but the user, role, password and collection are retained. Passwordless
OIDC-only accounts cannot unlink themselves. To change an OIDC-only deployment
back to mixed/local password behavior, change `AUTH_MODE` in the environment
and restart; logout or a Settings toggle does not change authentication policy.

## Recovery

If an OIDC-only deployment cannot start because no active administrator is
linked, use an operator-controlled backend command to repair one exact identity.
The command is local database maintenance, not an HTTP endpoint. It does not
change `AUTH_MODE`, assign roles, reset passwords, or move an identity from one
user to another.

Run from the backend working directory (or inside the backend container):

```bash
python -m scripts.oidc_identity_repair \
  --user-id 123 \
  --issuer 'https://idp.example.test' \
  --subject 'exact-provider-subject'
```

Without `--confirm`, this is a preview and makes no changes. Review the local
user id, configured issuer and exact provider subject, then repeat with
`--confirm` to apply. The command refuses an issuer mismatch or a subject already
linked to another user. It invalidates pending link transactions for the target
user and login handoffs for that exact identity. It does not print provider
tokens or change user data beyond the identity link.

For a containerized deployment whose backend cannot finish startup, run the
command as a one-off backend container with the same Compose environment and
database configuration:

```bash
docker compose run --rm --entrypoint python backend \
  -m scripts.oidc_identity_repair \
  --user-id 123 \
  --issuer 'https://idp.example.test' \
  --subject 'exact-provider-subject'
```

Do not run it against a different installation or database. Preserve a verified
database backup before manual identity repair.

## Security and operational notes

- The backend uses authorization code + PKCE, a browser-bound, one-use state
  transaction, nonce validation, signed ID-token validation, and short-lived
  handoffs. Transaction secrets are not stored in plaintext.
- The configured issuer and returned metadata must match. Provider endpoints
  must use HTTPS except for literal loopback development endpoints. Treat the
  configured provider as trusted; this is not a general defense against a
  malicious or compromised provider or DNS rebinding.
- Provider tokens and ID-token claims are not persisted as application sessions.
  The app issues its normal JWT; local logout clears that app
  session but does not perform provider logout or revoke the provider session.
- UserInfo requests have a bounded timeout, do not follow redirects and are
  size-capped. An advertised endpoint must use HTTPS (or loopback HTTP for
  development). Transport, HTTP, size or JSON failures and a subject that does
  not match the validated ID token are treated as *no profile hints*: the
  sign-in continues with the validated ID-token identity and asks for a
  username when nothing usable is left. UserInfo can never replace the ID-token
  issuer, subject or fresh-authentication proof, and provider tokens and full
  UserInfo responses are never persisted or logged.
- Existing application JWTs are not revoked by changing `AUTH_MODE`; they remain
  valid until expiry or user deactivation.
- The JWT secret (`JWT_SECRET_KEY`) also derives the key that encrypts pending
  transaction secrets (nonce and PKCE verifier). Rotating it invalidates every
  in-flight OIDC login or link, which fails closed and must be restarted from the
  sign-in page; there is no re-encryption path. Replicas must share the same
  secret, because a transaction started on one process must be readable on any
  other. Leaving the secret unset generates a per-instance key, which is only
  suitable for a single-replica deployment with persistent storage.
- OIDC throttles are per backend process and keyed on the browser-binding
  cookie, falling back to the client address for requests that do not present
  one yet (the first `/oidc/start` of a new browser). The cookie value is
  client-supplied, so this isolates users behind a shared proxy but is not an
  anti-abuse control: an OIDC-only deployment must also enforce a shared rate
  limit at the trusted ingress/proxy.
- Callback and completion responses use `Cache-Control: no-store` and
  `Referrer-Policy: no-referrer`. The bundled nginx passes both through
  unchanged and suppresses its own site-wide referrer policy for these paths,
  so a single, stricter policy applies. Normal access logging stays enabled: the
  backend and the bundled nginx record OIDC requests path-only, so the one-time
  `code`/`state` query string is never written to a log. Keep equivalent
  protections if replacing the bundled proxy.
- The existing bearer JWT is stored by the frontend in browser local storage.
  Protect the application origin against script injection and use HTTPS in
  production.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Backend refuses to start | Check `AUTH_MODE`, required OIDC variables, the exact issuer, `USER_MODE`, and that `OIDC_REDIRECT_URI` uses the exact callback path. Configuration errors do not include secret values. |
| Provider reports redirect mismatch | Compare the provider's registered URI byte-for-byte with `OIDC_REDIRECT_URI`, including scheme, port and path. |
| Callback reports an expired/restart error | Start a new flow in the same browser. State is one-use, browser-bound, short-lived, and a newer flow invalidates the older one. |
| Sign-in fails after successful provider authentication | Check that discovery advertises the endpoints you expect, that the issuer is exact, and that the provider returns RS256 or ES256 ID tokens. If UserInfo is advertised, a broken endpoint only removes profile hints (the user is asked for a username); it does not fail the sign-in. Do not log tokens or full responses. |
| OIDC-only startup reports no linked administrator | Start in `mixed`, link an active administrator, then switch to `oidc-only`; or use the host-only recovery procedure above after verifying the account and subject. |
| Browser rejects a link/completion request | Serve the app at the origin configured in `OIDC_REDIRECT_URI`; OIDC POSTs reject absent or different `Origin` headers. |

## Testing

The focused backend suites need no external service:

```bash
cd backend
python -m unittest discover -s tests -p 'test_auth*.py'
```

The transaction and identity race evidence needs a disposable PostgreSQL 18
database. Those suites drop and recreate the `public` schema, so the guard only
accepts a literal loopback host and a database named exactly
`oidc_auth_test_<32 lowercase hex>`; setting the opt-in without a safe URL is a
hard failure, never a skip.

```bash
podman run --rm -d --name oidc-pg-test \
  -e POSTGRES_PASSWORD='<password>' -p 127.0.0.1::5432 postgres:18-alpine
podman exec oidc-pg-test createdb -U postgres oidc_auth_test_<32 lowercase hex>

OIDC_AUTH_POSTGRES_TEST=1 \
OIDC_AUTH_TEST_DATABASE_URL='postgresql://postgres:<password>@127.0.0.1:<port>/oidc_auth_test_<32 lowercase hex>' \
python -m unittest discover -s tests -p 'test_auth_oidc_*postgres.py'
```

The real-nginx serving checks (path-only log format, inherited server headers,
configuration syntax) need a container runtime and a local `nginx:alpine` image,
so they run only when explicitly requested:

```bash
OIDC_AUTH_NGINX_TEST=1 python -m unittest tests.test_auth_oidc_routes.ServingConfigurationTests
```
