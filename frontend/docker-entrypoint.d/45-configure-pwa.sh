#!/bin/sh
set -eu

web_root="${WEB_ROOT:-/usr/share/nginx/html}"
index_file="${web_root}/index.html"

# $1 = raw value, $2 = default (0 or 1)
flag() {
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "${value}" in
    true|1|yes|on) echo 1 ;;
    false|0|no|off) echo 0 ;;
    '') echo "$2" ;;
    *) echo >&2 "WARNING: Invalid flag value '$1'. Using default $2."; echo "$2" ;;
  esac
}

sw_enabled="$(flag "${PWA_ENABLED:-}" 0)"            # P11 changes this default to 1
queue_enabled="$(flag "${OFFLINE_QUEUE_ENABLED:-}" 0)" # P11 changes this default to 1

if [ "${sw_enabled}" = 1 ]; then
  cp "${web_root}/sw.real.js" "${web_root}/sw.js"
else
  cp "${web_root}/sw.kill.js" "${web_root}/sw.js"
fi

# 40-configure-public-mode.sh already reset index.html from its template on this start,
# so this insertion cannot accumulate across restarts. </head> is a stable anchor
# (the <title> line is rewritten by PUBLIC_MODE).
sed -i "s|</head>|<meta name=\"pokecollector-pwa\" content=\"sw=${sw_enabled};queue=${queue_enabled}\" /></head>|" "${index_file}"
