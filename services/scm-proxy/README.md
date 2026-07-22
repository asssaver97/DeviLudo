# DeviLudo SCM proxy

This service contains both the local no-network candidate finalizer and the
production-shaped GitHub App boundary.

`LocalGitScmProxy` prepares a base commit before an Agent runs and finalizes the
candidate only after the Agent process has terminated.

Security properties:

- Git metadata is stored under a platform-owned `.scm` directory outside the
  Agent workspace.
- Git is invoked by absolute path with `shell: false`; terminal prompting,
  credential helpers, hooks, file protocol and global/system configuration are
  disabled.
- The workspace must be a real child of the configured storage root. Symlinks,
  special files, nested `.git`, unsafe paths and oversized trees are rejected.
- Finalization verifies the exact base commit lock, creates a platform-owned
  `deviludo/*` branch and returns the authoritative changed-file list, commit
  SHA and SHA-256 tree digest.
- The local implementation has no remote and no GitHub credential.

`GitHubAppScmProxy` consumes an Ed25519-attested candidate artifact, verifies
every binding and content digest, and delegates only fixed GitHub operations to
`GitHubRestConnector`. The connector:

- requests a short-lived GitHub App installation token scoped to one numeric
  repository ID with only Contents and Pull requests write permissions;
- starts with a single-use, server-side installation state and then performs a
  separate PKCE-protected GitHub user authorization. The setup callback's
  `installation_id` is accepted only after the user token proves that the
  signed-in numeric GitHub user can access that exact installation;
- stores only state/session digests and a one-use Vault reference for the PKCE
  verifier. OAuth codes, user tokens and refresh tokens are never persisted,
  and the ephemeral user token is revoked after verification;
- fixes the upstream to `https://api.github.com`, sends the versioned API
  header, rejects redirects and never includes upstream bodies or tokens in
  errors;
- creates blobs/tree/commit/ref and a Draft PR, with exact base/head checks;
- marks the exact Draft ready and merges only after a fresh signed user
  acceptance and authoritative PASSED evidence gate;
- reserves each external operation under a five-minute fencing claim before
  side effects, allowing crash recovery without concurrent duplicate PRs or
  merges.

`ScmProxyWorkflowHandler` consumes only the durable `MERGING` command. It binds
the exact candidate SHA, Draft PR number, candidate evidence bundle and final
`USER_ACCEPTED` signal to the idempotent merge call. Its receipt must repeat all
four bindings; the next release gate always receives GitHub's observed default-
branch head after merge, even when that head has already advanced beyond the
merge commit.

The production workflow entry is `npm run start:scm-proxy-workflow`. Its
destination host sends only immutable IDs and digests over TLS 1.3 mTLS to the
fixed `/v1/merges` endpoint of an isolated GitHub SCM Broker. The Broker resolves
the repository binding, signed acceptance and evidence server-side, persists
the append-only merge receipt including the actual `main_source_digest`, and
returns the observed default-branch head. GitHub installation tokens and App
signing keys never enter the Temporal destination process. Broker health is a
readiness gate and long merges heartbeat the workflow job lease.

The isolated endpoint itself starts with `npm run start:scm-merge-broker` and
the file-mounted `.env.merge.example` contract. Before touching GitHub it
re-resolves the currently RUNNING workflow job, delivered `USER_ACCEPTED`
outbox, immutable user decision, active repository installation, exact Draft
PR receipt and non-invalidated PASSED candidate evidence under tenant RLS. A
five-minute acceptance proof is signed by an mTLS Vault/KMS Broker and verified
locally; neither the Ed25519 acceptance key nor the GitHub App key is loaded by
the merge process. The archived merge row binds the user operation, workflow
request digest, candidate, evidence and GitHub-observed main SHA/source digest.

The isolated source-snapshot Broker uses a separate installation-token profile
with only repository Contents read. It resolves the exact candidate or fresh
merged-main SHA and source digest from append-only PostgreSQL receipts under
tenant RLS, reconstructs the tree from integrity-checked Git blobs, uploads a
deterministic zstd USTAR to immutable storage, and returns only a five-minute
download grant to the Artifact Preparer. Git redirects, floating branch names,
symlinks, submodules and mutable source archives are not accepted.

Before the first Agent run, the same read-only Broker also exposes the isolated
`/v1/source-baselines` route to the Agent Configuration service. It resolves
the active repository's exact default-branch commit and canonical source digest
and persists an append-only receipt bound to the approved specification, frozen
test plan and approval operation. Its mTLS allow-list is distinct from the
Artifact Preparer, and every retry must repeat the receipt operation key as the
HTTP idempotency key.

The Agent execution Worker submits only an Ed25519-attested candidate artifact
to the TLS 1.3 mTLS `/v1/candidates` boundary. The production entry is
`npm run start:scm-candidate-broker`, configured from
`.env.candidate.example`. This Broker re-resolves the locked Run, source
baseline, repository binding and active GitHub App installation under tenant
RLS, then creates and archives the Draft PR. The Worker receives only the
archived receipt; it never receives a GitHub installation token or App key.

Every production SCM `/healthz` is a traffic-readiness gate rather than a
socket liveness response. Candidate publication verifies all Run, baseline,
repository and receipt relations plus its external-operation claim ledger;
merge verifies the complete delivered-acceptance and non-invalidated E2E
authority; source snapshots verify baseline, candidate and merged-main receipt
relations. Missing migrations or a downstream KMS identity failure returns a
bounded `503`. Clients accept only the fixed health schema and reject extra
diagnostic fields or floating candidate Broker versions.

The App private key remains behind the injected `GitHubAppJwtSigner` (normally
Vault/KMS transit signing). Agent workers never receive an installation token.
GitHub Enterprise Server/custom API origins are intentionally unsupported in v1
until a SecurityAdmin-approved, DNS-pinning Connector is added.

Run the production source boundary with `npm run start:source-snapshot` and the
file-mounted configuration in `.source-snapshot.env.example`. The process uses
an mTLS Vault/KMS signing Broker; it has no GitHub App private-key file setting.

The public Web preview returns `503` for install/setup/callback routes until
`DEVILUDO_GITHUB_AUTH_BROKER_URL` and a Vault-injected session HMAC key are
configured. When enabled, the Web route verifies a short-lived, method/path-
bound session assertion, calls only the fixed internal HTTPS Broker, validates
every returned GitHub redirect, and never reflects callback code/state.
`registerGitHubAuthorizationBrokerRoutes` exposes the workload-authenticated
internal endpoint; `PostgresGitHubAuthorizationStore` persists only state and
session digests under tenant RLS and records the numeric GitHub user that proved
access to the exact installation. It never simulates a successful connection.
The workload-authenticated `POST /v1/github/connections/status` projection
re-reads only ACTIVE installations for that same tenant and numeric GitHub
user. The Web connection page uses this projection after every refresh and
treats the OAuth return query flag as a notification, never as authorization.

Run its contract tests from the repository root:

```bash
npm run test:scm-proxy
```
