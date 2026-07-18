# Agent runtime and provider security

This module is the security boundary between the DeviLudo control plane and the
Claude Code/Codex CLI development workers. It is intentionally declarative:
adapters produce an executable, immutable argv, protected environment references,
files and stdin. They never spawn a process or contact an upstream model service.

## Trust boundaries

1. The control plane resolves `project → tenant → platform` once when a run is
   enqueued. The platform default is Claude Code. Platform allowlists are
   intersected with lower-scope allowlists, so a tenant or project cannot widen
   policy.
2. `snapshotProfile()` freezes the exact profile revision, installation, CLI and
   adapter versions, image digest, provider revision, canonical models,
   credential version, timeout and budget. A later admin edit cannot alter a
   queued or active run.
3. Only one agent is present in each read-only worker image. The worker executor
   creates a fresh Linux microVM, materializes adapter files relative to the run
   root, mounts the checked-out workspace, and injects protected secrets. It must
   not install either agent on E2E or Steam release runners.
4. Git writes and upstream inference are separate proxies. The CLI can write only
   its workspace; it has no GitHub credential and can reach only DeviLudo's
   inference gateway.

## Runtime adapter contract

`RuntimeAdapter` exposes the planned six operations:

- `probe(installation)` describes a version probe.
- `prepare(runContext, profileRevision)` builds isolated home/config files.
- `start(runtimeSpec, prompt, workspace)` returns a process launch plan.
- `cancel(runHandle)` returns `SIGTERM`, a 10-second grace period, then `SIGKILL`.
- `collectResult(runHandle, events)` creates a normalized terminal result.
- `collectDiagnostics(runHandle, events)` creates redacted diagnostics.

The worker executor, not the adapter, performs I/O. It must reject executable or
argv differences from the adapter plan and must never invoke a shell. Both
adapters reject permission bypass options including `--yolo` and
`--dangerously-skip-permissions`.

Immediately before process creation, the worker independently executes the
fixed `--version` probe. The observed CLI version must equal the queued exact
version, and `DEVILUDO_WORKER_IMAGE_DIGEST` supplied by immutable workload
metadata must equal the locked image digest. A mismatch is rejected before
runtime files, run-token resolution or process creation. Adapter files are then
created with exclusive/no-follow opens and `0400`/`0600` modes; retries cannot
overwrite an existing attempt and symlink parents are rejected.

### Codex CLI launch

The Codex adapter pins this shape:

```text
codex exec --json --ephemeral \
  --output-schema <run-root>/runtime/codex-output.schema.json \
  --model <exact-model> --sandbox workspace-write -
```

The prompt is stdin (`-`), not a process-list argument. Every task has an isolated
`CODEX_HOME`. Its generated config fixes `model_provider`, the internal gateway
`base_url`, `wire_api = "responses"`, and `env_key = "DEVILUDO_RUN_TOKEN"`.
`DEVILUDO_RUN_TOKEN` is a protected SecretRef injected by the executor, not an
upstream key. Self-update is impossible in the read-only image; updates are new,
scanned image digests only. See the official [Codex custom provider
configuration](https://developers.openai.com/codex/config-advanced) and [non-interactive
mode](https://developers.openai.com/codex/noninteractive).

### Claude Code launch

The Claude adapter pins this shape:

```text
claude -p --input-format stream-json --output-format stream-json --verbose \
  --model <exact-model> --max-turns <n> --max-budget-usd <usd> \
  --no-session-persistence --setting-sources user \
  --settings <isolated-settings> --strict-mcp-config \
  --mcp-config <empty-mcp-config> --permission-mode acceptEdits
```

The prompt is a stream-JSON stdin event. `CLAUDE_CONFIG_DIR` points at a fresh
task directory; only the generated user settings source is loaded. The settings
disable all hooks, project MCP and plugins, while `--strict-mcp-config` supplies
an empty server map. `DISABLE_UPDATES=1` and nonessential traffic suppression are
fixed. All primary/planning/fast/subagent model environment mappings are exact
IDs from the profile. `ANTHROPIC_BASE_URL` always names the internal gateway and
the protected `ANTHROPIC_API_KEY` value is a short-lived run token reference.
See the official [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage),
[gateway configuration](https://code.claude.com/docs/en/llm-gateway), and [model
configuration](https://code.claude.com/docs/en/model-config).

The outer microVM sandbox remains mandatory: `acceptEdits` permits edits only
inside the already isolated workspace; it does not grant host, SCM or arbitrary
network access.

## Provider schemas and activation

Codex and Claude have separate discriminated schemas:

- Codex: `openai-responses`, `wireApi: responses`, bearer authentication.
- Claude: `anthropic-messages`, Anthropic version, x-api-key or bearer gateway
  authentication.

They cannot be exchanged by changing a URL. `primaryModel` is required; omitted
role models are normalized to primary. Active IDs reject `latest`, `default`,
`stable`, `preview`, `sonnet`, `opus`, `haiku` and suffix forms, and must include
a release/version number. Discovery may show an alias, but activation must store
the canonical ID returned by the probe.

Draft save and activation are separate. `activateAfterProbe()` does not replace
the active revision unless all of these checks pass:

1. endpoint policy;
2. authentication;
3. canonical model existence;
4. streaming;
5. tool call;
6. cancellation;
7. usage accounting;
8. timeout;
9. minimal inference with tools disabled.

Ready/active third-party provider revisions also record data region, retention,
training policy and the confirming administrator.

## SSRF and DNS rebinding

`validateProviderBaseUrl()` rejects non-HTTPS schemes, unapproved ports, URL
userinfo, query strings, fragments, localhost/reserved metadata names and literal
non-public IPs. IPv4 checks include loopback, RFC1918, link-local/metadata,
carrier-grade NAT, benchmark/documentation ranges, multicast and reserved space.
IPv6 checks reject unspecified/loopback, IPv4-compatible/mapped forms, ULA,
link-local, multicast, documentation and other non-global-unicast space.

Static validation is not sufficient. The inference connector must implement the
`DnsResolver`/`ValidatedEndpoint` contract:

- call `validateEndpointForConnection()` for **every connection attempt**;
- report every followed CNAME;
- abort if any answer is non-public (mixed public/private answers fail closed);
- connect to one of `connectAddresses` without doing a second DNS lookup;
- call `validateRedirectForConnection()` for every 3xx hop;
- never downgrade HTTPS and stop after the configured redirect limit.

This makes the address checked by policy the address used by the socket, while
fresh validation on subsequent requests and redirects prevents cached trust from
becoming a DNS rebinding bypass. Private gateways/custom CAs belong behind a
separately approved isolated Connector and must not weaken this public endpoint
policy.

## Credentials and run tokens

The application database stores `SecretRef` and safe metadata only. Secret input
is fingerprinted from mutable bytes, shown as a masked SHA-256 fingerprint, then
the ingress component must zero its buffer. Rotation keeps one `PREVIOUS` version
for already-bound work while new token issuance uses only `ACTIVE`; revoke stops
new issuance immediately.

`issueRunToken()` signs a maximum-15-minute internal token bound to tenant,
project, run, exact profile/provider/credential revisions, model allowlist,
expiry and budget. The inference gateway verifies signature, audience, expiry
and all run bindings before fetching the upstream key from Vault/KMS. The CLI
never receives a long-lived key or the short-lived run token itself.

Long tasks keep a stable SecretRef while the Worker replaces its token value
before expiry; every replacement is another independently capped 15-minute
token and cannot outlive the immutable run authorization. A loopback-only HTTPS
relay inside the microVM gives the CLI a random attempt-local credential,
resolves the current SecretRef for every inference request, then replaces that
credential with the DLRT on a separate mTLS connection to the Gateway. The
relay URL uses literal `127.0.0.1` with a matching certificate IP SAN, and its
CA is fixed in the immutable image. Lease heartbeat or renewal failure aborts the native launcher,
so a stale Worker cannot continue and later commit a result.

Protected secret environment entries contain only the relay's attempt-local
SecretRef in persisted launch plans. The executor resolves it at process start
and redacts it from logs, errors and evidence.

The service implementation also compares the token against the active run
registry (including nonce, exact model order and budget), checks the locked
Provider/credential revision and cumulative usage, caps the outgoing request by
the remaining output-token allowance, and performs a fresh public DNS check.
Its HTTP layer never accepts a Base URL, Provider id, SecretRef or upstream key
from the CLI. Upstream traffic is unavailable until a trusted Connector can
resolve the exact Vault credential, connect only to the validated addresses,
revalidate redirects and atomically record response usage.

## SCM proxy and candidate provenance

The Agent process never owns a GitHub token and does not create the authoritative
candidate commit. Before execution, the SCM proxy places Git metadata in a
platform-owned directory outside the writable workspace and records the exact
base SHA. After the supervised Agent process terminates, the proxy rejects
symlinks, special files, nested `.git`, unsafe paths and resource-limit
violations, then stages the workspace with an absolute Git binary and no shell.

Hooks, credential helpers, terminal prompting, the file protocol and
global/system Git configuration are disabled. The proxy creates only a validated
`deviludo/*` branch and returns the base SHA, candidate SHA, authoritative diff
paths and a SHA-256 digest of the committed tree listing. Adapter file-change
events are advisory; E2E and delivery state bind to the SCM proxy receipt.

The GitHub adapter accepts only an Ed25519-attested candidate artifact whose
tenant, project, run, attempt, specification, base SHA, branch, file content
digests and source digest are fixed. Its trusted Connector obtains a short-lived
installation token restricted to the numeric repository ID and `contents:write`
plus `pull_requests:write`; neither the Agent nor SCM business logic receives
that token. The endpoint is fixed to `https://api.github.com`, redirects are
disabled, upstream error bodies are discarded, and the versioned Git Data API
creates blobs, a tree, deterministic commit, branch and Draft PR.

Installation binding is a separate two-stage protocol: a one-use installation
state is followed by explicit GitHub user authorization with PKCE. A setup
callback's `installation_id` remains untrusted until the ephemeral user token
proves that the signed-in numeric user can access it. Only state/session digests
and a one-use Vault reference for the verifier are persisted; OAuth codes,
access tokens and refresh tokens are not, and the user token is revoked after
verification.

Merge requires a ten-minute control-plane acceptance signature and an
authoritative, still-valid PASSED evidence lookup. The PR node, base, branch and
head SHA are fetched again before the Draft is marked ready and merged. Candidate
evidence never authorizes release: the merge receipt records the returned merge
SHA and the then-observed default-branch head so a fresh main snapshot and full
gate can follow. Every external operation is authorized into a persistent
five-minute claim before network effects; an expired claim can be recovered
without silently re-authorizing or allowing two workers to execute concurrently.

## Steam publisher and Guard session

The public Web control plane never accepts a Steam password or Guard code and
does not fabricate a ready session. Interactive enrollment occurs in an isolated
broker; only the encrypted `config.vdf` Vault reference, build-account identity,
credential revision, exact allowed App IDs, verified minimal permissions and
expiry are persisted.

The Agent-free publisher accepts an Ed25519-signed RC bound to the merged main
SHA and full release evidence plus an independent ten-minute MFA publish
authorization. SteamCMD is invoked without a shell and with `+login <account>`
but no password; the session file is materialized into its private runtime.
Build scripts are platform-generated, `SetLive` rejects `default` and `public`,
and the private branch password is another SecretRef. A lease-claimed upload
records the BuildID and every depot manifest, then dispatches clean Steam Client
installs for the exact target matrix. Only authoritative reinstall evidence may
advance to Valve review, first-release and default-branch confirmation gates.

## Failure behavior and audit requirements

`selectRunnableProfile()` returns `WAITING_PROVIDER` when the primary provider is
not healthy. It selects a fallback only when both the immutable primary profile
and project policy explicitly list the exact fallback revision and that revision
is healthy. There is no automatic Claude↔Codex or provider switch.

The executor/gateway audit stream should contain IDs, fingerprints, byte/token
counts, latency, decisions and safe error codes. It must never contain prompts,
source fragments, tokens, upstream keys, protected environment values or runtime
files marked for redaction.
