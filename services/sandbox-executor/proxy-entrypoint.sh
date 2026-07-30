#!/bin/sh
set -eu

allowlist=${DEVILUDO_PROVIDER_ALLOWLIST:-api.anthropic.com,api.openai.com}
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

config=/tmp/deviludo-squid.conf
{
  printf 'http_port 3128\n'
  printf 'acl allowed_provider dstdomain%s\n' "$domains"
  printf 'acl SSL_ports port 443\n'
  printf 'acl CONNECT method CONNECT\n'
  printf 'http_access allow CONNECT SSL_ports allowed_provider\n'
  printf 'http_access deny all\n'
  printf 'access_log none\n'
  printf 'cache_log /dev/null\n'
  printf 'cache deny all\n'
} > "$config"
exec /usr/sbin/squid -NYCd 1 -f "$config"
