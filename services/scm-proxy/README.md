# DeviLudo SCM proxy

`LocalGitScmProxy` is the local, no-network implementation of the SCM trust
boundary. It prepares a base commit before an Agent runs and finalizes the
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
- There is no remote and no GitHub credential. A production GitHub SCM adapter
  must use a short-lived GitHub App installation token in a separate connector.

Run its contract tests from the repository root:

```bash
npm run test:scm-proxy
```
