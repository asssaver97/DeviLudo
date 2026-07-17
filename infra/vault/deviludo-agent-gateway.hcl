# Bind this policy to a workload identity carrying tenant_id/project_id metadata.
# Human control-plane roles may write/rotate secrets but cannot read plaintext.
path "secret/data/tenants/{{identity.entity.metadata.tenant_id}}/projects/{{identity.entity.metadata.project_id}}/providers/*" {
  capabilities = ["read"]
  required_parameters = ["run_id", "profile_revision_id"]
}

path "transit/encrypt/deviludo-sessions" {
  capabilities = ["update"]
}

path "transit/decrypt/deviludo-sessions" {
  capabilities = ["update"]
}

path "auth/token/create/deviludo-inference-run" {
  capabilities = ["update"]
  min_wrapping_ttl = "30s"
  max_wrapping_ttl = "5m"
}

path "sys/*" {
  capabilities = ["deny"]
}
