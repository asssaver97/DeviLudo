# Example least-privilege policy for the production Secret Broker when
# DEVILUDO_SECRET_BROKER_VAULT_KV_MOUNT=secret. Bind it to a short-lived
# workload token without Vault's default policy. Add one exact read stanza for
# every approved static SecretRef; never replace it with a static/* wildcard.

path "sys/capabilities-self" {
  capabilities = ["update"]
}

path "secret/config" {
  capabilities = ["read"]
}

path "secret/data/deviludo/records/*" {
  capabilities = ["create", "read"]
}

path "secret/metadata/deviludo/records/*" {
  capabilities = ["delete"]
}

path "secret/data/deviludo/static/github-oauth-client-secret" {
  capabilities = ["read"]
}
