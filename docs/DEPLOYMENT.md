# Deployment and releases

PokéCollector's normal Docker installation uses published container images. A
source checkout and local image build are optional development tools, not
installation requirements.

## Published images

Each release publishes two public multi-platform images to GitHub Container
Registry:

| Service | Image |
| --- | --- |
| Backend | `ghcr.io/git-romer/pokecollector-backend` |
| Frontend | `ghcr.io/git-romer/pokecollector-frontend` |

Both images support `linux/amd64` and `linux/arm64`. PostgreSQL continues to use
the official `postgres:18-alpine` image.

Every application release has a stable version tag such as `1.51.0`. The
Compose file downloaded from that release defaults both application services to
that exact version. A `latest` alias is also published for discovery, but it is
not the default: two separate repository tags cannot be promoted atomically, so
an interrupted promotion could briefly leave frontend and backend `latest`
pointing at different releases.

Set `POKECOLLECTOR_VERSION` in `.env` to pin or override both application
images together:

```env
POKECOLLECTOR_VERSION=1.51.0
```

## Install without cloning the repository

```bash
mkdir pokecollector
cd pokecollector
curl -fsSL -o docker-compose.yml.new https://github.com/Git-Romer/pokecollector/releases/latest/download/docker-compose.yml
mv docker-compose.yml.new docker-compose.yml
curl -fsSL -o .env.new https://github.com/Git-Romer/pokecollector/releases/latest/download/pokecollector.env.example
mv .env.new .env
```

Set a secure `POSTGRES_PASSWORD` in `.env`. `JWT_SECRET_KEY` may be set
explicitly or left empty so the backend creates a strong key under
`./data/auth`. Then start the stack:

```bash
mkdir -p data/pokedex-images backups
docker compose pull
docker compose up -d
```

The published frontend image applies `PUBLIC_MODE` when the container starts,
so public/private SEO behavior does not require a different frontend build.

## Update

First create and retain a manual database backup:

```bash
backup_file="backup_$(date +%Y%m%d_%H%M%S).sql"
umask 077
docker compose exec -T postgres pg_dump -U pokemon pokemon_tcg --clean --if-exists > "$backup_file"
test -s "$backup_file"
```

Do not continue if the final check fails. Full SQL dumps can contain user
settings and scanner API credentials, so keep the restrictive permissions and
store the file securely.

For a no-clone installation, download the newest Compose definition safely:

```bash
curl -fsSL -o docker-compose.yml.new https://github.com/Git-Romer/pokecollector/releases/latest/download/docker-compose.yml
mv docker-compose.yml.new docker-compose.yml
docker compose pull
docker compose up -d
```

Confirm that the services are running and the backend responds. Replace port
`8000` if `BACKEND_PORT` is customized:

```bash
docker compose ps
curl -fsS http://localhost:8000/api/health
```

For an installation backed by a Git checkout, run `git pull` before the two
Compose commands. Existing PostgreSQL 15 installations must first follow the
one-time procedure in `scripts/upgrade-postgres-15-to-18.sh`, as described in
the README.

Before startup migrations run for a new application version, the backend also
creates a full automatic SQL dump in `./backups`. Startup stops before migration
when that safety backup fails unless `PRE_UPGRADE_BACKUP_REQUIRED=false` was
explicitly selected.

## Roll back

1. Retain the failed/current database state for diagnosis, then stop frontend
   and backend writes while leaving PostgreSQL running.
2. Set `POKECOLLECTOR_VERSION` to the previous release version.
3. Restore the matching pre-upgrade/full SQL backup when the newer version ran
   database migrations.
4. Pull and restart both application services together.

```bash
docker compose stop frontend backend
docker compose exec -T postgres psql --set ON_ERROR_STOP=on --single-transaction -U pokemon -d pokemon_tcg < backup.sql
docker compose pull backend frontend
docker compose up -d
```

The Settings restore action accepts `.sql` files, streams the upload into a
temporary file, and executes it with PostgreSQL `ON_ERROR_STOP` in a single
transaction. Any statement failure rolls back the complete restore, and the
temporary upload is deleted afterward.

Selective backup groups are useful for targeted exports, but they may depend on
rows outside their group and do not currently include every newer feature
table. Full backups are the recovery and upgrade format.

## Local development images

Contributors can build from source with the checked-in override:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

Use both `-f` arguments for later lifecycle commands. A plain
`docker compose up` returns to the published GHCR images. See
[`CONTRIBUTING.md`](../CONTRIBUTING.md) for the development workflow.

## Automated release flow

`.github/workflows/release.yml` starts when `VERSION` changes on `main` and may
also be dispatched manually. It:

1. validates that the repository version sources agree;
2. creates or reuses a recoverable draft release;
3. builds frontend and backend for `amd64` and `arm64` in parallel;
4. publishes exact-version images and verifies anonymous access;
5. promotes the current version to `latest`;
6. uploads `docker-compose.yml` and `pokecollector.env.example`; and
7. publishes the GitHub release only after the images and assets succeed.

The workflow uses one release-wide concurrency group. A rerun can reuse valid
versioned images, repair assets with `--clobber`, and finish an incomplete draft.
If the default branch has already advanced to a newer version, recovery of the
older release does not replace the mutable `latest` pointers.

Normal future releases require no package-visibility interaction. Repository
Actions permissions and public GHCR package visibility are persistent settings.
Intervention is only expected after a build/release failure, a change to the
external Actions allowlist, or another explicit infrastructure change.
