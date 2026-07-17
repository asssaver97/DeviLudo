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
- fixes the upstream to `https://api.github.com`, sends the versioned API
  header, rejects redirects and never includes upstream bodies or tokens in
  errors;
- creates blobs/tree/commit/ref and a Draft PR, with exact base/head checks;
- marks the exact Draft ready and merges only after a fresh signed user
  acceptance and authoritative PASSED evidence gate;
- reserves each external operation under a five-minute fencing claim before
  side effects, allowing crash recovery without concurrent duplicate PRs or
  merges.

The App private key remains behind the injected `GitHubAppJwtSigner` (normally
Vault/KMS transit signing). Agent workers never receive an installation token.
GitHub Enterprise Server/custom API origins are intentionally unsupported in v1
until a SecurityAdmin-approved, DNS-pinning Connector is added.

Run its contract tests from the repository root:

```bash
npm run test:scm-proxy
```
