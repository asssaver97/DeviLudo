# Production Agent administration

`/admin/agents` has two deliberately different execution modes:

- explicit loopback test mode uses the isolated local catalog and may display a role selector for RBAC testing;
- production accepts only a fresh HMAC assertion injected by the trusted administrator ingress and forwards an allow-listed operation to the NestJS control plane.

The browser cannot select its production role. Every assertion binds the HTTP method, exact path, actor, role, session and issue time. Management operations are limited to `/api/admin/...`; the same ingress may sign a separate read-only assertion for exactly `GET /api/auth/session` so the shell can display the trusted operator and capability-filter its navigation. An assertion for either path cannot be replayed on the other. The Web route verifies that assertion, rejects cross-origin browser mutations, strips caller authority headers, and creates a second assertion bound to the downstream `/admin/...` path.

The public session projection never returns the administrator session identifier or signature. It returns only actor display metadata, `authMode=trusted-admin`, `canSignOut=false`, and the navigation capabilities implied by the verified role. Platform logout remains the responsibility of the trusted administrator ingress; the application does not pretend that clearing invited-user cookies terminates that external session.

## Deployment boundary

Configure the Web workload with:

- `DEVILUDO_ADMIN_SESSION_HMAC_KEY`: verifies assertions from the administrator ingress;
- `DEVILUDO_ADMIN_CONTROL_PLANE_BROKER_URL`: fixed HTTPS origin of the mesh Connector;
- `DEVILUDO_ADMIN_CONTROL_PLANE_HMAC_KEY`: signs the Web-to-control-plane assertion.

Configure the control-plane workload's `DEVILUDO_ADMIN_SESSION_HMAC_KEY` with the same secret version as `DEVILUDO_ADMIN_CONTROL_PLANE_HMAC_KEY`. The two Web keys must be independent. Inject both from Vault/KMS; do not place them in image layers or environment files committed to source control.

The Connector must present the approved Web administration SPIFFE identity over mTLS. It must not expose a generic proxy or accept a caller-selected destination. The Web allow-list contains only the documented Agent administration routes and never forwards cookies, Authorization, caller role headers or query strings.

The version catalog projects the exact package source, source digest, discovery time, release-notes URL, signature result, integrity, SBOM, vulnerability state and validation receipts. The browser renders source and release-note links only when HTTPS, host, repository path, Agent kind and exact package version all match the built-in Claude Code or Codex CLI allow-list. A same-host link for another version, a redirect-style query, credentials, nonstandard port or lookalike host invalidates the projection instead of producing a clickable link.

Credential request bodies are capped at 64 KiB and are never logged. Responses are capped, must be JSON, may not contain Vault `SecretRef` values, and are rejected if they reproduce submitted credential plaintext. The browser receives only masked fingerprints and public credential metadata.

Rotating a credential used by an active Profile is a gated revision operation,
not an in-place key swap. The control-plane first writes the replacement to the
Secret Broker, stages immutable Provider/Profile successors, and runs the full
Inference Gateway probe against the new credential. Only after every probe
passes does one catalog transaction mark the old credential `PREVIOUS`, activate
the successors and move matching platform/tenant/project defaults. Probe failure
revokes the replacement and leaves the old active defaults untouched. Queued and
running tasks retain their recorded revision IDs; the retired credential is not
issued to new Gateway lease requests. The staged replacement also carries an
internal idempotency-operation binding and exact successor map (omitted from all
public projections), so a process restart replays the same immutable Vault path,
re-probes the same successors, and cannot allocate a second active key. Failure
cleanup first proves that operation owns the staged revision and that no active
successor references it; it never revokes a key committed by a concurrent recovery.

An Installation rollback is also a catalog revision operation. After the Fleet
receipt confirms `100/25/5 → 0`, the same transaction creates immutable active
Profile successors pinned to the previous healthy `100% ACTIVE` Installation,
remaps fallback-dependent Profile successors, and moves every matching default.
Provider, model, credential, permission and budget bindings do not change. If no
fully active rollback target exists, affected Profiles become `DEGRADED` and new
work fails closed; already locked runs retain their original image digest. Each
successful `100%` Fleet receipt records `activatedAt`; the next image selects the
healthy same-Agent/same-pool target with the newest activation timestamp rather
than relying on catalog insertion order.

Local testing intentionally does not contact this Connector. Production health reports `adminControlPlaneBroker=CONFIGURED` only when its fixed origin is present; a missing connector leaves all production Agent administration fail-closed.

## Operational health and usage

`GET /admin/agent-health` is authenticated with the same route-bound administrator assertion as the rest of the catalog. It combines the supply-chain probe and immutable catalog with three read-only operational projections:

- the last 24 hours of append-only `inference_usage_events`, including the exact run, Provider revision, credential version, model, token counts, and priced cost;
- configuration changes extracted from visible append-only audit records as explicit `before → after` fields;
- actionable alerts derived from failed or quarantined Installations, unhealthy active images, failed Provider probes, broken active Profile bindings, and unavailable usage telemetry.

Tenant and project administrators read usage only after the control plane sets the PostgreSQL tenant RLS context and adds the exact project predicate when present. Platform-wide roles require a database identity with `BYPASSRLS`; if that proof is unavailable, the endpoint reports `usage.available=false` and raises `INFERENCE_USAGE_TELEMETRY_UNAVAILABLE` instead of returning a partial or estimated total. The local-only website exposes the same response shape with explicitly local immutable fixtures.

## Tenant and project configuration

The platform administrator console is not reused as browser authorization for lower scopes. Two dedicated Web boundaries exchange the invited GitHub browser session for a freshly signed control-plane assertion:

- `/settings/agents` and `/api/settings/agents/**` bind `TenantAdmin` to the tenant returned by the Identity Broker. A submitted `scope` or `scopeId` is discarded and replaced server-side. `Auditor` receives the same tenant-filtered projection but cannot mutate it.
- `/projects/{projectId}/agent-settings` and its API first ask the Project Repository Broker to prove that the signed-in user can access the exact active repository binding. Only then does Web issue `ProjectOwner + tenantId + projectId` to the control plane. A URL or request body can never establish project authority.

Project defaults may reference an ACTIVE project Profile, an ACTIVE Profile belonging to the signed tenant, or an ACTIVE platform Profile. This is a reference to one immutable revision, not a credential copy. Tenant defaults may similarly select an ACTIVE tenant or platform Profile. A lower scope cannot select another tenant's Profile or loosen the platform allow-list.

TenantAdmin may write tenant BYOK credentials and create/validate tenant Provider drafts. SecurityAdmin remains the only role that can activate a third-party endpoint after the complete Provider probe. Configuration changes affect new tasks only; queued and running tasks keep their locked Profile revision.

An ACTIVE Profile may be prepared before its Installation finishes canary, but no
platform, tenant, or project default may select it until the whole serving chain
is ready: the Installation is healthy `100% ACTIVE`, its exact Agent version is
still approved, every required Provider probe is `PASS`, and the bound credential
is active in the permitted scope. A failed selection leaves the previous default
unchanged and returns `PROFILE_NOT_SERVING_READY`.
