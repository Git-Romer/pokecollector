#!/bin/sh
set -eu

web_root="${WEB_ROOT:-/usr/share/nginx/html}"
index_file="${web_root}/index.html"
index_template="${index_file}.template"
public_mode="$(printf '%s' "${PUBLIC_MODE:-false}" | tr '[:upper:]' '[:lower:]')"

# Reset the generated file so container restarts never accumulate SEO tags.
cp "${index_template}" "${index_file}"

configure_private_mode() {
  cp "${web_root}/robots-block.txt" "${web_root}/robots.txt"
  sed -i 's|<title>Pokemon TCG Collection</title>|<meta name="robots" content="noindex, nofollow" />\
    <title>Pokemon TCG Collection</title>|' "${index_file}"
}

case "${public_mode}" in
  true|1|yes|on)
    cp "${web_root}/robots-allow.txt" "${web_root}/robots.txt"
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
    <meta name="twitter:image" content="/icon-512.png" />|' "${index_file}"
    ;;
  false|0|no|off|'')
    configure_private_mode
    ;;
  *)
    echo >&2 "WARNING: Invalid PUBLIC_MODE value '${PUBLIC_MODE}'. Defaulting to private mode."
    configure_private_mode
    ;;
esac
