# Security Policy

PokéCollector is a self-hosted app that holds people's collections, accounts, and
optional API keys, so security reports are taken seriously. Thank you for helping
keep it safe.

## Reporting a vulnerability

**Please do not report security problems in a public issue, pull request, or
discussion.** Public details help attackers before a fix is available.

1. Open the repository's **Security and quality** tab (sometimes shown as
   **Security**) and choose **Report a vulnerability**.
   GitHub submits this as a private vulnerability report. The reporter and
   people with access to repository security advisories can see it, including
   repository or organization owners, security managers, users with admin
   access, and collaborators added to the advisory. If I accept the report, I
   can open it as a private draft advisory while working on a fix.
2. If you cannot use GitHub's private reporting form, email
   [info@romerg.de](mailto:info@romerg.de) to arrange a private reporting
   channel.
3. If neither private route is available, open a public issue titled
   **"Security contact request"** with *no* technical details. I will then
   arrange a private channel.

A useful report includes:

- what is affected (route, page, setting, or file) and the version shown in
  Settings; include the `POKECOLLECTOR_VERSION` image tag if it differs;
- how the instance was configured: single-user or multi-user mode, reverse proxy,
  and relevant `.env` settings, with secrets redacted;
- clear steps to reproduce, ideally against an instance you own;
- the impact: what an attacker gains, and what they need first (an account, an
  admin login, network access to the server);
- a suggested fix or patch, if you have one. A pull request is welcome once I have
  agreed it is safe to make public.

Do not attach a raw `.env` file or include live passwords, API keys, tokens, or
private keys in a report. Redact examples, and rotate any secret you may have
disclosed.

If you used an AI tool to find the issue, please say so. Reproduce it on an
instance you own or are authorized to test when it is safe and feasible. If you
cannot reproduce it safely, explain what you observed and how you found it.
Reports that describe only a hypothetical problem without supporting evidence are
hard to assess.

## What to expect

I maintain PokéCollector, so these are goals rather than guarantees:

- an acknowledgement within about 7 days;
- an assessment and a rough plan within about 14 days of acknowledgement;
- a fix released as soon as it has been tested, with the advisory published after
  users have had a reasonable chance to update;
- credit in the advisory if you would like it.

I ask that you give me reasonable time to fix the issue before sharing details
publicly, and that you tell me if you plan to publish. If I cannot reach you or
cannot agree on a timeline, I will say so openly.

## Supported versions

Only the **latest release** receives security fixes. Please report vulnerabilities
affecting older releases too, and include the version(s) you tested. I may ask
you to confirm the issue on the latest release when feasible.

## Scope

In scope are problems in this repository's code and shipped configuration, for
example:

- authentication, sessions, and password handling;
- one user reaching another user's data, or a normal user reaching admin features;
- the public-profile and sharing routes exposing more than the owner chose;
- injection, cross-site scripting, request forgery, or server-side request forgery;
- unsafe handling of uploads (scanner photos, card photos, backup files) or of the
  image proxy;
- secrets (API keys, tokens, password hashes) leaking through the API, logs, or
  backups;
- the Docker, nginx, and compose files as shipped.

Usually **not** vulnerabilities (please file ordinary issues for improvements):

- **Single-user mode has no login by design.** Anyone who can reach an instance in
  that mode can use it as the administrator. Do not expose such an instance to
  networks you do not trust. Turn on multi-user mode (or set `USER_MODE=multi`)
  for anything reachable from the internet.
- Attacks that only work after the attacker has already compromised an
  administrator account and do not cross a user or role boundary are usually out
  of scope. Bugs that let a lower-privileged user bypass authorization, access
  another user's data, or gain admin access remain in scope.
- Settings only the server operator controls (environment variables,
  `OPENAI_BASE_URL`, database credentials) are not in scope unless the app handles
  them unsafely.
- Weak passwords an administrator chose, or an instance running without HTTPS.
- Vulnerabilities in third-party products themselves (such as TCGdex, Gemini or
  OpenAI, Telegram, Docker, PostgreSQL, or reverse-proxy software) should be
  reported to their respective projects. Vulnerabilities in this repository's
  shipped Docker, nginx, or Compose configuration remain in scope.
- Denial of service through sheer request volume, spam, social engineering, or
  anything that requires physical access to a device.
- Missing hardening headers or "best practice" gaps with no demonstrated impact.
- Features that deliberately share data between signed-in users of the same instance
  (for example the leaderboard). If one of them exposes more than its documentation
  says, that is worth reporting.

## Testing guidelines

- Test only against an instance you own or have permission to test. Please do not
  probe other people's PokéCollector servers.
- Do not read, change, or delete data that is not yours, degrade the service for
  others, or run automated scanners at high volume.
- If you reach data that is not yours by accident, stop, do not keep a copy, and
  tell me.

I welcome good-faith security research that follows these guidelines and
applicable law. I will not pursue action against researchers for that activity.

## Running PokéCollector safely

A few habits go a long way:

- Keep the app on the latest release.
- Serve it over HTTPS, behind a reverse proxy, and do not publish the database port.
- Use multi-user mode with strong passwords whenever the app is reachable beyond
  your own machine.
- Set `POSTGRES_PASSWORD` to something unique instead of the default.
- Treat backups as sensitive: a full SQL backup contains database data for all
  accounts, including password hashes and any saved API keys. Scanner trace and
  queued-photo files stored on disk are not part of SQL backups. Only restore
  backups you created yourself.
- Give AI scanner keys the smallest permissions and spending limit your provider
  allows.
