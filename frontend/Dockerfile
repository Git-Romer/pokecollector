FROM node:20-alpine AS builder

WORKDIR /app

ARG PUBLIC_MODE=false

COPY package*.json ./
RUN npm install

COPY . .

# SEO: configure based on PUBLIC_MODE
RUN if [ "$PUBLIC_MODE" = "true" ]; then \
      # Public mode: allow indexing, add meta tags \
      cp public/robots-allow.txt public/robots.txt; \
      sed -i 's|<title>Pokemon TCG Collection</title>|<title>PokéCollector — Pokemon TCG Collection Manager</title>\
    <meta name="description" content="A free, self-hosted Pokemon TCG collection manager. Track cards, monitor prices, manage binders, and analyse your portfolio." />\
    <meta name="keywords" content="Pokemon, TCG, collection, tracker, cards, prices, portfolio, self-hosted" />\
    <meta property="og:title" content="PokéCollector — Pokemon TCG Collection Manager" />\
    <meta property="og:description" content="Track your Pokemon card collection, monitor prices from Cardmarket and TCGPlayer, and manage your portfolio." />\
    <meta property="og:type" content="website" />\
    <meta property="og:image" content="/icon-512.png" />\
    <meta name="twitter:card" content="summary" />\
    <meta name="twitter:title" content="PokéCollector — Pokemon TCG Collection Manager" />\
    <meta name="twitter:description" content="Free, self-hosted Pokemon TCG collection manager." />\
    <meta name="twitter:image" content="/icon-512.png" />|' index.html; \
    else \
      # Private mode: block all crawlers \
      cp public/robots-block.txt public/robots.txt; \
      sed -i 's|<title>Pokemon TCG Collection</title>|<meta name="robots" content="noindex, nofollow" />\
    <title>Pokemon TCG Collection</title>|' index.html; \
    fi

RUN npm run build

FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
