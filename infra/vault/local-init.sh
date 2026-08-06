#!/bin/sh
set -eu
export VAULT_ADDR=http://vault:8200
until vault status >/dev/null 2>&1 || [ "$?" -eq 2 ]; do sleep 1; done
if [ ! -s /tokens/unseal.key ]; then
  umask 077
  vault operator init -key-shares=1 -key-threshold=1 > /tokens/init.txt
  awk '/Unseal Key 1:/ {print $4}' /tokens/init.txt > /tokens/unseal.key
  awk '/Initial Root Token:/ {print $4}' /tokens/init.txt > /tokens/root.token
  rm -f /tokens/init.txt
fi
vault operator unseal "$(cat /tokens/unseal.key)" >/dev/null 2>&1 || true
export VAULT_TOKEN="$(cat /tokens/root.token)"
vault secrets enable -path=secret kv-v2 >/dev/null 2>&1 || true
vault policy write deviludo-api /policies/api.hcl >/dev/null
vault policy write deviludo-executor /policies/executor.hcl >/dev/null
umask 077
issue_service_token() {
  name=$1
  policy=$2
  owner=$3
  mode=$4
  temporary="/tokens/.${name}.token.$$"
  vault token create -policy="$policy" -orphan -period=720h -field=token > "$temporary"
  chown "$owner" "$temporary"
  chmod "$mode" "$temporary"
  mv -f "$temporary" "/tokens/${name}.token"
}
issue_service_token api deviludo-api 1001:1001 0400
issue_service_token executor deviludo-executor 0:0 0600
chown 0:0 /tokens/unseal.key /tokens/root.token /tokens/executor.token
chmod 0600 /tokens/unseal.key /tokens/root.token /tokens/executor.token
