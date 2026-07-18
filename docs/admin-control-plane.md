# Production Agent administration

`/admin/agents` has two deliberately different execution modes:

- explicit loopback test mode uses the isolated local catalog and may display a role selector for RBAC testing;
- production accepts only a fresh HMAC assertion injected by the trusted administrator ingress and forwards an allow-listed operation to the NestJS control plane.

The browser cannot select its production role. Every assertion binds the HTTP method, exact `/api/admin/...` path, actor, role, session and issue time. The Web route verifies that assertion, rejects cross-origin browser mutations, strips caller authority headers, and creates a second assertion bound to the downstream `/admin/...` path.

## Deployment boundary

Configure the Web workload with:

- `DEVILUDO_ADMIN_SESSION_HMAC_KEY`: verifies assertions from the administrator ingress;
- `DEVILUDO_ADMIN_CONTROL_PLANE_BROKER_URL`: fixed HTTPS origin of the mesh Connector;
- `DEVILUDO_ADMIN_CONTROL_PLANE_HMAC_KEY`: signs the Web-to-control-plane assertion.

Configure the control-plane workload's `DEVILUDO_ADMIN_SESSION_HMAC_KEY` with the same secret version as `DEVILUDO_ADMIN_CONTROL_PLANE_HMAC_KEY`. The two Web keys must be independent. Inject both from Vault/KMS; do not place them in image layers or environment files committed to source control.

The Connector must present the approved Web administration SPIFFE identity over mTLS. It must not expose a generic proxy or accept a caller-selected destination. The Web allow-list contains only the documented Agent administration routes and never forwards cookies, Authorization, caller role headers or query strings.

Credential request bodies are capped at 64 KiB and are never logged. Responses are capped, must be JSON, may not contain Vault `SecretRef` values, and are rejected if they reproduce submitted credential plaintext. The browser receives only masked fingerprints and public credential metadata.

Local testing intentionally does not contact this Connector. Production health reports `adminControlPlaneBroker=CONFIGURED` only when its fixed origin is present; a missing connector leaves all production Agent administration fail-closed.
