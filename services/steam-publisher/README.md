# DeviLudo Steam publisher

This service is the Agent-free trust boundary for Steam delivery. It accepts
only an Ed25519-signed RC bound to the merged main SHA and authoritative release
evidence, plus a separate short-lived publish authorization backed by fresh MFA.

The coordinator:

- verifies tenant, project, release, App ID, main/source/spec/test-plan/evidence
  digests, exact target matrix and one depot artifact per selected platform;
- accepts only an active dedicated build-account session restricted to the
  exact App ID and the Steamworks build permissions;
- persists only a Vault `SecretRef` for the enrolled `config.vdf`; Steam account
  passwords, Guard codes and session plaintext never enter the Web API;
- rejects `default`/`public` and uploads only to a fixed password-protected Beta
  branch under a lease-claimed idempotency key. The same operation key/digest is
  passed to the Connector so it reconciles an existing Build after interruption
  instead of uploading a duplicate;
- schedules clean Steam Client installs on every selected OS and requires a
  second authoritative evidence bundle before reaching external approvals;
- leaves Valve review, first release and default-branch confirmation as explicit
  human/external gates.

`buildSteamCmdRuntimePlan()` produces a shell-free invocation using `+login
<account>` without a password and a platform-generated VDF build script. The
encrypted `config.vdf` SecretRef is materialized only inside the isolated Steam
publisher runtime and is not placed in arguments, environment values or logs.

The public preview deliberately returns `503` from the Steam enrollment route
until an isolated interactive enrollment broker and Vault ingress are wired.

Run the contract tests from the repository root:

```bash
npm run test:steam-publisher
```
