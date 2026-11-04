FROM python:3.11-slim

LABEL org.opencontainers.image.source="https://github.com/Git-Romer/pokecollector" \
      org.opencontainers.image.description="PokéCollector FastAPI backend" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
    gnupg \
    lsb-release \
    gcc \
    && install -d /etc/apt/keyrings \
    && wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/keyrings/postgresql.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-18 \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY VERSION /app/VERSION
COPY backend/ .

RUN mkdir -p /app/backups /app/debug /app/data/pokedex-images/sprites /app/data/pokedex-images/artwork

EXPOSE 8000

# Access logging is disabled: uvicorn's default access log records the full
# request target, which would retain OIDC callback `code`/`state` query values.
# External proxies must likewise suppress or path-only-log the callback; see
# frontend/nginx.conf. Application/error logs never include URLs or tokens.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
