#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

COMPOSE=(docker compose)
DB_SERVICE="${POSTGRES_SERVICE:-postgres}"
DB_USER="${POSTGRES_USER:-pokemon}"
DB_NAME="${POSTGRES_DB:-pokemon_tcg}"
TARGET_MAJOR="18"
BACKUP_DIR="${POSTGRES_UPGRADE_BACKUP_DIR:-${REPO_ROOT}/backups}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
DUMP_PATH="${BACKUP_DIR}/postgres15_to_18_${TIMESTAMP}.sql"
rollback_volume=""
temp_source_container=""
use_temp_source="false"
temp_source_mount=""
upgrade_completed="false"

log() {
  printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"
}

fail() {
  printf '\nERROR: %s\n' "$*" >&2
  if [[ -n "${temp_source_container}" ]]; then
    docker stop "${temp_source_container}" >/dev/null 2>&1 || true
    temp_source_container=""
  fi
  exit 1
}

cleanup_temp_source() {
  if [[ -n "${temp_source_container}" ]]; then
    docker stop "${temp_source_container}" >/dev/null 2>&1 || true
    temp_source_container=""
  fi
}

on_error() {
  local line_no="${1:-unknown}"
  if [[ "${upgrade_completed}" == "true" ]]; then
    return
  fi

  cat >&2 <<EOF

ERROR: PostgreSQL upgrade failed near line ${line_no}.

Recovery notes:
  * SQL dump path: ${DUMP_PATH}
  * Rollback volume: ${rollback_volume:-not created yet}
  * If only the app services were stopped and the old PostgreSQL volume is still present, you can usually run 'docker compose up -d' to return to the previous state.
  * If the old volume was already removed, restore the previous app version/compose file, remove the new PostgreSQL volume if it exists, and copy the rollback volume back to the original volume name.

Keep any dump and rollback volume until you have verified the application.
EOF

  cleanup_temp_source
}

trap 'on_error ${LINENO}' ERR

if ! command -v docker >/dev/null 2>&1; then
  fail "docker is required"
fi

if ! docker compose version >/dev/null 2>&1; then
  fail "docker compose is required"
fi

mkdir -p "${BACKUP_DIR}"

inspect_postgres_volume() {
  local inspected_container_id="$1"
  docker inspect "${inspected_container_id}" --format '{{ range .Mounts }}{{ if or (eq .Destination "/var/lib/postgresql/data") (eq .Destination "/var/lib/postgresql") }}{{ .Name }}{{ end }}{{ end }}'
}

detect_volume_pg_major() {
  local inspected_volume_name="$1"
  docker run --rm \
    -v "${inspected_volume_name}:/volume:ro" \
    alpine:3.22 \
    sh -c 'for f in /volume/PG_VERSION /volume/data/PG_VERSION; do if [ -s "$f" ]; then cat "$f"; exit 0; fi; done' \
    | tr -d '[:space:]' \
    | cut -c1-2
}

detect_temp_source_mount() {
  local inspected_volume_name="$1"
  docker run --rm \
    -v "${inspected_volume_name}:/volume:ro" \
    alpine:3.22 \
    sh -c 'if [ -s /volume/PG_VERSION ]; then echo /var/lib/postgresql/data; elif [ -s /volume/data/PG_VERSION ]; then echo /var/lib/postgresql; fi'
}

find_legacy_postgres_volume() {
  local detected_volume=""
  local candidate=""
  local compose_project_name="${COMPOSE_PROJECT_NAME:-$(basename "${REPO_ROOT}")}"
  local default_volume_name="${compose_project_name}_postgres_data"

  while IFS= read -r candidate; do
    [[ -n "${candidate}" ]] || continue
    if [[ "$(detect_volume_pg_major "${candidate}")" == "15" ]]; then
      if [[ -n "${detected_volume}" && "${detected_volume}" != "${candidate}" ]]; then
        fail "Found multiple PostgreSQL 15 Docker volumes for this compose project (${detected_volume}, ${candidate}). Set POSTGRES_SERVICE or restore/start the intended stack before running the upgrade."
      fi
      detected_volume="${candidate}"
    fi
  done < <(
    {
      docker volume ls -q --filter label=com.docker.compose.project="${compose_project_name}" --filter label=com.docker.compose.volume=postgres_data 2>/dev/null || true
      docker volume ls -q --filter label=com.docker.compose.project="${compose_project_name}" --filter label=com.docker.compose.service="${DB_SERVICE}" 2>/dev/null || true
      if docker volume inspect "${default_volume_name}" >/dev/null 2>&1; then
        printf '%s\n' "${default_volume_name}"
      fi
    } | awk 'NF && !seen[$0]++'
  )

  printf '%s' "${detected_volume}"
}

wait_for_pg_ready() {
  local exec_prefix=("$@")
  for _ in $(seq 1 60); do
    if "${exec_prefix[@]}" pg_isready -U "${DB_USER}" -d "${DB_NAME}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

log "Checking running PostgreSQL container"
container_id="$(${COMPOSE[@]} ps -q "${DB_SERVICE}")"
stopped_container_id=""
if [[ -n "${container_id}" ]]; then
  container_running="$(docker inspect "${container_id}" --format '{{ .State.Running }}' 2>/dev/null || true)"
  container_restarting="$(docker inspect "${container_id}" --format '{{ .State.Restarting }}' 2>/dev/null || true)"
  if [[ "${container_running}" != "true" || "${container_restarting}" == "true" ]]; then
    stopped_container_id="${container_id}"
    container_id=""
  fi
fi

if [[ -z "${container_id}" ]]; then
  if [[ -z "${stopped_container_id}" ]]; then
    stopped_container_id="$(${COMPOSE[@]} ps -a -q "${DB_SERVICE}" | head -n 1 || true)"
  fi
  if [[ -z "${stopped_container_id}" ]]; then
    volume_name="$(find_legacy_postgres_volume)"
    if [[ -z "${volume_name}" ]]; then
      fail "${DB_SERVICE} is not running and no PostgreSQL 15 Docker volume was found. Start the existing PostgreSQL 15 stack before running this upgrade script. If you ran 'docker compose down -v' or removed Docker volumes, restore from your manual backup."
    fi
  else
    if ! docker inspect "${stopped_container_id}" >/dev/null 2>&1; then
      fail "Could not inspect stopped ${DB_SERVICE} container"
    fi

    volume_name="$(inspect_postgres_volume "${stopped_container_id}")"
    if [[ -z "${volume_name}" ]]; then
      volume_name="$(find_legacy_postgres_volume)"
    fi

    if [[ -z "${volume_name}" ]]; then
      fail "${DB_SERVICE} is stopped and no PostgreSQL Docker volume could be found. Start the existing PostgreSQL 15 stack before running this upgrade script."
    fi
  fi

  source_major="$(detect_volume_pg_major "${volume_name}")"
  temp_source_mount="$(detect_temp_source_mount "${volume_name}")"
  if [[ "${source_major}" == "15" && -n "${temp_source_mount}" ]]; then
    docker stop "${stopped_container_id}" >/dev/null 2>&1 || true
    use_temp_source="true"
    log "${DB_SERVICE} is not running, but PostgreSQL ${source_major} data was found in ${volume_name}. A temporary PostgreSQL ${source_major} container will be used for the dump."
  else
    fail "${DB_SERVICE} is not running and no PostgreSQL 15 data directory was found in ${volume_name}. If you accidentally ran 'docker compose up' first, do not delete any volumes; restore/start the previous PostgreSQL 15 stack or recover from backup."
  fi
else
  if ! docker inspect "${container_id}" >/dev/null 2>&1; then
    fail "Could not inspect ${DB_SERVICE} container"
  fi

  source_major="$(${COMPOSE[@]} exec -T "${DB_SERVICE}" psql -U "${DB_USER}" -d "${DB_NAME}" -Atc "SHOW server_version_num;" | tr -d '[:space:]' | cut -c1-2)"
  volume_name="$(inspect_postgres_volume "${container_id}")"
fi

if [[ -z "${source_major}" ]]; then
  fail "Could not detect PostgreSQL server version"
fi

if [[ "${source_major}" == "${TARGET_MAJOR}" ]]; then
  if [[ -n "${volume_name:-}" ]]; then
    legacy_major="$(detect_volume_pg_major "${volume_name}")"
    if [[ -n "${legacy_major}" && "${legacy_major}" != "${TARGET_MAJOR}" ]]; then
      fail "Detected PostgreSQL ${TARGET_MAJOR} running while legacy PostgreSQL ${legacy_major} data is still present in ${volume_name}. This usually means 'docker compose up' was run before the upgrade script. Stop the stack and recover the PostgreSQL ${legacy_major} data with the upgrade script or a backup before using the app."
    fi
  fi
  log "PostgreSQL is already ${TARGET_MAJOR}. No major-version upgrade is needed."
  exit 0
fi

if [[ "${source_major}" != "15" && "${ALLOW_NON_15_SOURCE:-false}" != "true" ]]; then
  fail "Detected PostgreSQL major version ${source_major}, expected 15. Set ALLOW_NON_15_SOURCE=true if you intentionally want to dump/restore this version into PostgreSQL ${TARGET_MAJOR}."
fi

if [[ -z "${volume_name}" ]]; then
  fail "Could not find the Docker volume mounted at /var/lib/postgresql/data or /var/lib/postgresql"
fi

rollback_volume="${volume_name}_pg${source_major}_backup_${TIMESTAMP}"

cat <<EOF

This will upgrade the Docker-managed PostgreSQL data volume from major ${source_major} to ${TARGET_MAJOR} by dump/restore.

It will:
  1. Stop app services so PostgreSQL ${source_major} cannot receive app writes
  2. Create SQL dump: ${DUMP_PATH}
  3. Stop the compose stack
  4. Copy the old data volume to rollback volume: ${rollback_volume}
  5. Remove the original old data volume so PostgreSQL ${TARGET_MAJOR} can initialize a fresh one
  6. Start PostgreSQL ${TARGET_MAJOR} with the Docker volume mounted at /var/lib/postgresql
  7. Restore the SQL dump
  8. Rebuild/start the full stack

The old data is preserved in the rollback volume until you delete it manually.
EOF

if [[ "${POSTGRES_UPGRADE_ASSUME_YES:-false}" != "true" ]]; then
  read -r -p "Continue? Type 'upgrade to postgres 18' to proceed: " confirmation
  if [[ "${confirmation}" != "upgrade to postgres 18" ]]; then
    fail "Upgrade cancelled"
  fi
fi

mapfile -t app_services < <("${COMPOSE[@]}" config --services | grep -v -x "${DB_SERVICE}" || true)
if (( ${#app_services[@]} > 0 )); then
  log "Stopping app services before the dump to prevent writes during the upgrade"
  "${COMPOSE[@]}" stop "${app_services[@]}"
fi

log "Creating SQL dump from PostgreSQL ${source_major}"
if [[ "${use_temp_source}" == "true" ]]; then
  temp_source_container="pokecollector-postgres-${source_major}-upgrade-${TIMESTAMP}"
  docker run -d --rm \
    --name "${temp_source_container}" \
    -e POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-temporary-upgrade-password}" \
    -v "${volume_name}:${temp_source_mount}" \
    "postgres:${source_major}-alpine" >/dev/null

  if ! wait_for_pg_ready docker exec "${temp_source_container}"; then
    fail "Temporary PostgreSQL ${source_major} container did not become ready"
  fi

  docker exec -i "${temp_source_container}" pg_dump \
    -U "${DB_USER}" \
    -d "${DB_NAME}" \
    --clean \
    --if-exists \
    > "${DUMP_PATH}"
else
  "${COMPOSE[@]}" exec -T "${DB_SERVICE}" pg_dump \
    -U "${DB_USER}" \
    -d "${DB_NAME}" \
    --clean \
    --if-exists \
    > "${DUMP_PATH}"
fi

if [[ ! -s "${DUMP_PATH}" ]]; then
  fail "SQL dump was not created or is empty: ${DUMP_PATH}"
fi

log "Stopping compose stack"
if [[ -n "${temp_source_container}" ]]; then
  docker stop "${temp_source_container}" >/dev/null
  temp_source_container=""
fi
"${COMPOSE[@]}" down

log "Copying old PostgreSQL ${source_major} volume for rollback"
docker volume create "${rollback_volume}" >/dev/null
docker run --rm \
  -v "${volume_name}:/from:ro" \
  -v "${rollback_volume}:/to" \
  alpine:3.22 \
  sh -c 'cd /from && tar cf - . | tar xf - -C /to'

log "Removing old PostgreSQL ${source_major} volume ${volume_name}"
docker volume rm "${volume_name}" >/dev/null

log "Starting PostgreSQL ${TARGET_MAJOR} with a fresh data volume"
"${COMPOSE[@]}" up -d "${DB_SERVICE}"

log "Waiting for PostgreSQL ${TARGET_MAJOR} to become ready"
for _ in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T "${DB_SERVICE}" pg_isready -U "${DB_USER}" -d "${DB_NAME}" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! "${COMPOSE[@]}" exec -T "${DB_SERVICE}" pg_isready -U "${DB_USER}" -d "${DB_NAME}" >/dev/null 2>&1; then
  fail "PostgreSQL ${TARGET_MAJOR} did not become ready"
fi

actual_major="$(${COMPOSE[@]} exec -T "${DB_SERVICE}" psql -U "${DB_USER}" -d "${DB_NAME}" -Atc "SHOW server_version_num;" | tr -d '[:space:]' | cut -c1-2)"
if [[ "${actual_major}" != "${TARGET_MAJOR}" ]]; then
  fail "Expected PostgreSQL ${TARGET_MAJOR}, got major version ${actual_major}"
fi

log "Restoring SQL dump into PostgreSQL ${TARGET_MAJOR}"
"${COMPOSE[@]}" exec -T "${DB_SERVICE}" psql \
  -U "${DB_USER}" \
  -d "${DB_NAME}" \
  -v ON_ERROR_STOP=1 \
  < "${DUMP_PATH}"

log "Rebuilding and starting the full stack"
"${COMPOSE[@]}" up -d --build

log "Verifying restored database"
"${COMPOSE[@]}" exec -T "${DB_SERVICE}" psql -U "${DB_USER}" -d "${DB_NAME}" -Atc "SELECT 'postgres_' || current_setting('server_version'), count(*) FROM information_schema.tables WHERE table_schema = 'public';"

cat <<EOF

PostgreSQL ${TARGET_MAJOR} upgrade completed.

SQL dump:        ${DUMP_PATH}
Rollback volume: ${rollback_volume}

Keep both until you have verified the application. If you need to roll back, stop the stack, restore the old compose/version, remove the new ${volume_name} volume, and copy ${rollback_volume} back to ${volume_name}.
EOF

upgrade_completed="true"
