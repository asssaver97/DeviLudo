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
vault token create -policy=deviludo-api -orphan -period=24h -field=token > /tokens/api.token
vault token create -policy=deviludo-executor -orphan -period=24h -field=token > /tokens/executor.token
chown 1001:1001 /tokens/api.token
chmod 0400 /tokens/api.token
chown 0:0 /tokens/unseal.key /tokens/root.token /tokens/executor.token
chmod 0600 /tokens/unseal.key /tokens/root.token /tokens/executor.token
