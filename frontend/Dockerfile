FROM node:20-alpine AS builder

WORKDIR /app

COPY frontend/package*.json ./
RUN npm ci

COPY VERSION /VERSION
COPY frontend/ .

RUN cp public/robots-block.txt public/robots.txt \
    && npm run build

FROM nginx:alpine

LABEL org.opencontainers.image.source="https://github.com/Git-Romer/pokecollector" \
      org.opencontainers.image.description="PokéCollector web frontend" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

COPY --from=builder /app/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/docker-entrypoint.d/40-configure-public-mode.sh /docker-entrypoint.d/40-configure-public-mode.sh

RUN cp /usr/share/nginx/html/index.html /usr/share/nginx/html/index.html.template \
    && chmod +x /docker-entrypoint.d/40-configure-public-mode.sh

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
