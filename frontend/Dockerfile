FROM node:20-alpine AS builder

WORKDIR /app

ARG PUBLIC_MODE=false

COPY package*.json ./
RUN npm install

COPY . .

# Inject meta tags for public mode
RUN if [ "$PUBLIC_MODE" = "true" ]; then \
      sed -i 's|<title>Pokemon TCG Collection</title>|<title>PokéCollector — Pokemon TCG Collection Manager</title>\n    <meta name="description" content="A free, self-hosted Pokemon TCG collection manager. Track cards, monitor prices, manage binders, and analyse your portfolio." />\n    <meta name="keywords" content="Pokemon, TCG, collection, tracker, cards, prices, portfolio" />\n    <meta property="og:title" content="PokéCollector — Pokemon TCG Collection Manager" />\n    <meta property="og:description" content="Track your Pokemon card collection, monitor prices, and manage your portfolio." />\n    <meta property="og:type" content="website" />|' index.html; \
      cp public/robots-allow.txt public/robots.txt; \
    else \
      echo '<meta name="robots" content="noindex, nofollow">' > /tmp/robots-meta.txt; \
      sed -i 's|<title>Pokemon TCG Collection</title>|<meta name="robots" content="noindex, nofollow" />\n    <title>Pokemon TCG Collection</title>|' index.html; \
      cp public/robots-block.txt public/robots.txt; \
    fi

RUN npm run build

FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
