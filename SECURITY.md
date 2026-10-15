# Security Policy

PokéCollector is a self-hosted app that holds people's collections, accounts, and
optional API keys, so security reports are taken seriously. Thank you for helping
keep it safe.

## Reporting a vulnerability

**Please do not report security problems in a public issue, pull request, or
discussion.** Public details help attackers before a fix is available.

1. Open the repository's **Security** tab and choose **Report a vulnerability**.
   This creates a private advisory that only you and the maintainers can see.
2. If that button is not available, open a public issue titled
   **"Security contact request"** that contains *no* technical details, and a
   maintainer will arrange a private channel.

A useful report includes:

- what is affected (route, page, setting, or file) and the version you tested
  (the `VERSION` file or the image tag);
- how the instance was configured (single-user or multi-user mode, reverse proxy,
  anything unusual in `.env`);
- clear steps to reproduce, ideally against an instance you own;
- the impact: what an attacker gains, and what they need first (an account, an
  admin login, network access to the server);
- a suggested fix or patch, if you have one. A pull request is welcome once we have
  agreed it is safe to make public.

If you used an AI tool to find the issue, please say so and confirm you reproduced
it yourself. Reports that describe a hypothetical problem without a working
reproduction are hard to act on.

## What to expect

PokéCollector is maintained by volunteers, so these are goals rather than
guarantees:

- an acknowledgement within about 7 days;
- an assessment and a rough plan within about 14 days of acknowledgement;
- a fix released as soon as it has been tested, with the advisory published after
  users have had a reasonable chance to update;
- credit in the advisory if you would like it.

We ask that you give us reasonable time to fix the issue before sharing details
publicly, and that you tell us if you plan to publish. If we cannot reach you or
cannot agree on a timeline, we will say so openly.

## Supported versions

Only the **latest release** receives security fixes. Please upgrade before
reporting, and mention the version if the problem only appears on an older one.

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
- Actions that need an administrator account the attacker already has, or settings
  only the server operator controls (environment variables, `OPENAI_BASE_URL`,
  database credentials).
- Weak passwords an administrator chose, or an instance running without HTTPS.
- Findings in third-party services or components: TCGdex, Gemini or OpenAI, Telegram,
  Docker, PostgreSQL, a reverse proxy. Report those to their own projects.
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
  tell us.

Good-faith research that follows these guidelines is welcome, and we will not
pursue action against it.

## Running PokéCollector safely

A few habits go a long way:

- Keep the app on the latest release.
- Serve it over HTTPS, behind a reverse proxy, and do not publish the database port.
- Use multi-user mode with strong passwords whenever the app is reachable beyond
  your own machine.
- Set `POSTGRES_PASSWORD` to something unique instead of the default.
- Treat backup files as secrets: they contain every account's data, password
  hashes, and any saved API keys. Only restore backups you created yourself.
- Give AI scanner keys the smallest permissions and spending limit your provider
  allows.
