FROM node:20-alpine AS builder

WORKDIR /app

ARG PUBLIC_MODE=false

COPY frontend/package*.json ./
RUN npm ci --prefer-offline --no-audit --no-fund

ARG BUILD_REVISION=dev
RUN echo "Building revision ${BUILD_REVISION}"

COPY VERSION /VERSION
COPY frontend/ .

# Local archives remain private by default; public mode changes only crawler policy.
RUN if [ "$PUBLIC_MODE" = "true" ]; then cp public/robots-allow.txt public/robots.txt; else cp public/robots-block.txt public/robots.txt; fi

RUN npm run build

FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
