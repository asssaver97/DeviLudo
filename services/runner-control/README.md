# Runner control and evidence ingress

This service core models the production E2E trust boundary without pretending
that a localhost process is a real Windows/Linux/macOS fleet.

- Runner identity comes from an authorized mutual-TLS peer certificate and a
  single SPIFFE URI SAN. HTTP headers are not an identity source.
- Registration fixes OS, architecture, Godot binary, export-template image,
  GPU/display/audio and runner-image digests. Any installed autonomous Agent is
  rejected.
- A matrix attempt creates a separate lease and monotonically increasing
  fencing token for every selected platform. Re-leasing one platform makes all
  late events from its previous runner stale.
- Job envelopes are canonicalized and Ed25519-signed. They bind the complete
  spec/test/source/commit matrix, source object digest, TestKit, export template,
  runner capability, expiry and required evidence set.
- A runner can terminate only its platform stream. It cannot send
  `ATTEMPT_COMPLETED`; the coordinator derives PASSED/FAILED after all selected
  platforms terminate.
- `PLATFORM_COMPLETED` is accepted only after a content-addressed manifest binds
  logs, JUnit, deterministic inputs, screenshots, video and production export
  to the exact lease. The coordinator then creates the immutable bundle.

`RunnerMatrixCoordinator` uses in-memory maps only as a deterministic contract
implementation. A production adapter must perform its lease/event mutations in
PostgreSQL transactions with forced RLS and store artifact bytes in the
content-addressed object store. It must expose the coordinator only behind a
dedicated mTLS listener; the public web application route is not runner ingress.
