#!/bin/sh
# Railway assigns $PORT per deploy and it is not known at build time, so the nginx config is
# templated and rendered on start. The variable list passed to envsubst is explicit, so nginx's own
# $-prefixed variables in the template ($http_host, $uri, ...) are left untouched.
set -e

: "${PORT:?PORT is not set. Railway sets this automatically; do not set it yourself.}"
: "${API_INTERNAL_URL:?Set API_INTERNAL_URL to the api-worker service's private address, for example http://beacon-api.railway.internal:3000. See docs/RAILWAY.md.}"

envsubst '${PORT} ${API_INTERNAL_URL}' \
  < /etc/nginx/templates/nginx.conf.template \
  > /etc/nginx/conf.d/default.conf

exec nginx -g 'daemon off;'
