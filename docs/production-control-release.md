# Production control-plane release

The production control plane is released from the immutable JSON receipt emitted
by `image:build-control`. A mutable image tag is never accepted by the release
tool. The receipt is checked against the current platform version,
`Dockerfile.control-plane`, `package-lock.json`, final registry digest, source
revision, pinned Node base, BuildKit provenance mode and SBOM declaration before
any manifest is rendered.

The receipt may target `linux/amd64` or `linux/arm64`; every generated pod is
node-selected to that exact OS/architecture so a single-platform digest cannot
silently land on an incompatible node.

Registry signature and provenance verification still belongs in the registry
promotion and cluster admission policy. In addition, every cluster mutation now
requires a separate short-lived Ed25519 authorization from the dedicated
Vault/KMS signing Broker. The build receipt is a binding record and cannot by
itself authorize a release.

## Security authorization

Start from
[`infra/control-release-trust-policy.example.json`](../infra/control-release-trust-policy.example.json),
replace its public key and identifiers, set the production key to `ACTIVE`, and
store the policy plus its canonical SHA-256 in independently reviewed deployment
configuration. The example key is deliberately `REVOKED` and cannot authorize a
release. Keys must be sorted by `keyId`; each key fixes Ed25519 SPKI bytes,
validity and current `ACTIVE`/`REVOKED` status.

Inspect the exact semantic digest that must be approved and passed to both later
commands:

```bash
npm --silent run inspect:control-trust -- \
  --trust-policy /absolute/reviewed/control-release-trust.json
```

The inspection output excludes public-key bytes from routine logs while showing
the policy ID, revision, canonical digest and each key lifecycle.

Configure the authorizer with a dedicated mTLS identity:

- `DEVILUDO_CONTROL_RELEASE_SIGNER_ENDPOINT` is an HTTPS origin on port 443 or
  8443. The only request path is `/v1/control-releases/sign-ed25519`.
- `DEVILUDO_CONTROL_RELEASE_SIGNER_TLS_KEY_FILE`, `_CERT_FILE` and `_CA_FILE`
  are file-mounted mTLS material.
- `DEVILUDO_CONTROL_RELEASE_SIGNING_KEY_ID` selects one `ACTIVE` trust-policy
  key. Private signing material stays inside Vault/KMS.

Request one authorization after the image receipt and target scope are final:

```bash
NODE_ENV=production npm --silent run authorize:control -- \
  --receipt /absolute/private/path/control-image-receipt.json \
  --context production-ap-east-1/platform-admin \
  --namespace deviludo-prod \
  --services agent-configuration,control-plane \
  --replicas 2 \
  --ttl-seconds 900 \
  --trust-policy /absolute/reviewed/control-release-trust.json \
  --trust-policy-digest sha256:REVIEWED_POLICY_DIGEST \
  > /absolute/private/path/control-release-authorization.json
```

The mTLS client sends only canonical claims and a digest, uses the authorization
UUID as its idempotency key, and locally verifies the returned signature before
writing the authorization. Claims bind the complete receipt digest, final OCI
digest, source revision, architecture, exact kubeconfig context, namespace,
sorted service allow-list, replica count and expiry. Lifetime is limited to 30
minutes. Rotating the policy requires an explicit new policy digest; marking a
key `REVOKED` invalidates its outstanding authorizations immediately.

## Required namespace inputs

Production secret/configuration automation must provision these objects in the
target namespace before a release:

- `deviludo-control-registry`: image-pull Secret, used by the kubelet only.
- `deviludo-schema-migrator-files`: Secret with `database-url`, `ca.pem`,
  `client.crt` and `client.key`. The URL belongs to the migration role and is
  mounted only in the one-shot migration Job.
- For every selected service `NAME`, `deviludo-NAME-config` is a ConfigMap,
  `deviludo-NAME-environment` is an application-role environment Secret, and
  `deviludo-NAME-files` is a file Secret mounted read-only at
  `/run/secrets/deviludo`.

The per-service environment Secret must contain only that process's application
credentials. Third-party model API keys, GitHub App private keys and Steam
sessions remain behind their dedicated brokers/Vault bindings; they must not be
copied into every workload. File paths in a service ConfigMap refer to keys below
`/run/secrets/deviludo`. Empty per-service Secret objects may be used when a
process genuinely requires no secret values, but the objects are never generated
by this repository.

The namespace and these inputs are normally reconciled ahead of time by the
cluster's secret operator. The release tool also server-side-applies the
Namespace security labels, but deliberately does not create placeholder secrets.
It installs a namespace-wide default-deny ingress/egress NetworkPolicy before
the migration Job. The production network controller must therefore provision
explicit least-privilege allow policies for DNS, PostgreSQL, Temporal, Redis,
S3, Vault, telemetry and the required service-to-service mTLS edges. A cluster
without those policies fails the migration or rollout instead of falling back
to unrestricted networking.

## Render and inspect

Create the receipt during the registry build. `npm --silent` is important when
redirecting the one-line JSON result:

```bash
npm --silent run image:build-control -- \
  --base-image registry.internal/base/node:22.13.1-bookworm-slim@sha256:BASE_DIGEST \
  --destination registry.internal/deviludo/control-plane:0.1.0-beta.1-SOURCE12 \
  --source-revision SOURCE40 \
  > /absolute/private/path/control-image-receipt.json
```

Rendering is the default and has no cluster side effect:

```bash
npm run deploy:control -- \
  --receipt /absolute/private/path/control-image-receipt.json \
  --namespace deviludo-prod \
  --render
```

The output is a `deviludo.kubernetes-control-release.v1` bundle with three
ordered stages: Namespace, migration, and workloads. It contains all 31 admitted
control processes by default. `--services` accepts a comma-separated allow-listed
subset, and `--replicas` accepts 1 through 10. Agent execution, Godot/E2E,
signing, Steam Client and local preview processes cannot be selected because they
are not present in the shared control image.

## Apply with the migration gate

Applying is never inferred from a current kubeconfig context. It requires both
`--apply`, an exact context, and the independently signed authorization:

```bash
npm run deploy:control -- \
  --apply \
  --context production-ap-east-1/platform-admin \
  --namespace deviludo-prod \
  --services agent-configuration,control-plane \
  --replicas 2 \
  --receipt /absolute/private/path/control-image-receipt.json \
  --authorization /absolute/private/path/control-release-authorization.json \
  --trust-policy /absolute/reviewed/control-release-trust.json \
  --trust-policy-digest sha256:REVIEWED_POLICY_DIGEST
```

Authorization verification and canonical manifest regeneration occur before
the first `kubectl` process is created. Any signature, key lifecycle, expiry,
context, namespace, image, service, replica or trust-policy drift therefore
produces zero cluster calls.

The tool invokes `kubectl` directly without a shell and performs only these
operations:

1. Server-side apply the Namespace with the Kubernetes Restricted Pod Security
   profile.
2. Server-side apply the tokenless ServiceAccount and default-deny network
   policy.
3. Apply the digest-bound migration Job, then wait for that exact Job to reach
   `Complete`; a failure or timeout stops here.
4. Server-side apply ClusterIP Services and Deployments.
5. Wait for Deployments at the receipt's exact source revision to become
   `Available`.

It never calls delete, prune, exec, exposes a LoadBalancer, changes kubeconfig or
uses `--force-conflicts`. All pods run as UID/GID 1000 with RuntimeDefault
seccomp, no capabilities, no privilege escalation, a read-only root filesystem,
no service-account token and only an in-memory `/tmp`. The schema Job has no
application `envFrom`; ordinary workloads have no migration credential volume.

The apply command expects `kubectl` and a reachable production cluster. Unit
tests exercise the exact invocation sequence with an injected executor; the
repository's local website and local smoke test never run this command.
