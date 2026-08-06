#!/bin/sh
set -eu

allowlist=${DEVILUDO_PROVIDER_ALLOWLIST:-api.anthropic.com,api.openai.com}
upstream=${DEVILUDO_PROVIDER_UPSTREAM_PROXY:-}
domains=
old_ifs=$IFS
IFS=,
for domain in $allowlist; do
  case "$domain" in
    ''|*[!A-Za-z0-9.-]*|.*|*.) echo "invalid provider allowlist" >&2; exit 64 ;;
  esac
  domains="$domains .$domain"
done
IFS=$old_ifs
[ -n "$domains" ] || { echo "empty provider allowlist" >&2; exit 64; }

upstream_host=
upstream_port=
if [ -n "$upstream" ]; then
  case "$upstream" in
    http://*) authority=${upstream#http://} ;;
    *) echo "invalid provider upstream proxy" >&2; exit 64 ;;
  esac
  case "$authority" in
    ''|*/*|*\?*|*\#*|*@*|*:*)
      upstream_host=${authority%:*}
      upstream_port=${authority##*:}
      ;;
    *) echo "invalid provider upstream proxy" >&2; exit 64 ;;
  esac
  case "$upstream_host" in ''|*[!A-Za-z0-9.-]*) echo "invalid provider upstream proxy host" >&2; exit 64 ;; esac
  case "$upstream_port" in ''|*[!0-9]*) echo "invalid provider upstream proxy port" >&2; exit 64 ;; esac
  [ "$upstream_port" -ge 1 ] 2>/dev/null && [ "$upstream_port" -le 65535 ] 2>/dev/null \
    || { echo "invalid provider upstream proxy port" >&2; exit 64; }
fi

config=/tmp/deviludo-squid.conf
{
  printf 'http_port 3128\n'
  printf 'acl allowed_provider dstdomain%s\n' "$domains"
  printf 'acl SSL_ports port 443\n'
  printf 'acl CONNECT method CONNECT\n'
  printf 'http_access allow CONNECT SSL_ports allowed_provider\n'
  printf 'http_access deny all\n'
  if [ -n "$upstream_host" ]; then
    printf 'cache_peer %s parent %s 0 no-query default\n' "$upstream_host" "$upstream_port"
    printf 'never_direct allow all\n'
  fi
  printf 'access_log none\n'
  printf 'cache_log /dev/null\n'
  printf 'cache deny all\n'
} > "$config"
exec /usr/sbin/squid -NYCd 1 -f "$config"
