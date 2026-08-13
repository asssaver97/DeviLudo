# DeviLudo

English | [简体中文](README.md)

DeviLudo is an AI game delivery platform for Godot. It turns game requirements and conversations into versioned source code, image assets, and verified builds, then publishes them to Steam after human approval.

> The project is currently an MVP. The complete local workflow targets macOS; production requires dedicated infrastructure and five server pools.

## What it can do

- Generate, modify, and repair Godot projects with Claude Code or Codex CLI agents.
- Link an existing local Godot project directory directly, or clone a GitHub repository to a chosen location and link it; successful Agent changes are written back in place.
- After linking, local Git and GitHub projects can create and switch to a new branch from the project page; private GitHub repositories reuse the host's Git credentials.
- Persist source revisions for conversational iteration, failure repair, and stage reruns.
- Generate images from an Agent-authored asset manifest, accept user uploads, or continue with placeholders.
- Build Godot artifacts and enforce a requirement-mapped manifest of unit checks, real keyboard/mouse interaction, and visual baselines; a successful launch is never treated as a test.
- Run E2E in disposable graphical VMs on Linux, Windows, and macOS, producing an evidence ZIP with self-contained HTML, JSON, logs, real game screenshots, and visual diffs.
- Sign release artifacts, require human approval, publish to Steam, and verify a clean installation.
- Run in standalone mode or integrate with an external account authority in platform mode.
- Back up and restore PostgreSQL, S3 artifacts, and project sources, with built-in observability and restricted task execution.

## Delivery workflows

| Profile | Pipeline |
| --- | --- |
| `VALIDATE` | Agent generation → image assets ready → Godot build → selected-platform E2E |
| `RELEASE` | Agent generation → image assets ready → build → three-platform E2E → signing → human approval → Steam publish → clean install |

The Agent submits an `assetManifest` and `deviludo.test-manifest.v2` with its source output. Images are materialized into the Godot project before the build. E2E must complete a core-loop journey, inject real input, and capture start/key-state/completion frames; missing checks, Godot script errors, blank screenshots, and excessive visual differences fail the run. In local mode, opening an E2E report launches its self-contained HTML directly.

## Local quick start

The complete local workflow currently supports Apple Silicon macOS only and uses Node.js 22, Docker/Colima, Homebrew, and Tart. Godot runs inside a disposable Tart VM without taking focus on the host desktop.

```bash
git clone <repository-url>
cd DeviLudo
npm ci
npm run local:bootstrap
npm run local:up
```

Open <http://127.0.0.1:3100>. Local installations use `standalone` by default and require no account. Configure a Claude Code or Codex CLI provider in Settings; an image-generation provider is optional.

Linking a local project never uploads or copies it. Once you choose the project root, DeviLudo immediately creates a project named after the directory; source reading and Agent analysis continue asynchronously while the project card is dimmed and shows progress. DeviLudo records only a restricted directory binding, reads the latest source from the original directory before each Agent run, and safely writes results back in place when the directory has not changed concurrently. For GitHub, DeviLudo runs the host's `git`, clones into the location you choose, and links that working tree under the repository name. Project contents never travel through a browser upload, so the former 64 MiB import ceiling does not apply. Credential helpers and SSH agents remain host-only; credentials are never mounted into containers or stored by DeviLudo.

Common commands:

```bash
npm run local:status   # Show service status
npm run local:logs     # Follow logs
npm run local:down     # Stop services and keep data
npm run local:reset    # Stop services and remove local data
```

The first `local:up` automatically installs missing Tart/SSH helpers, downloads a roughly 25 GB macOS base image, and builds a versioned E2E golden image, so keep at least 35 GiB free. Initialization fails explicitly and never falls back to host execution. Later starts reuse the golden image by configuration fingerprint and do not refresh it merely because remote `latest` changed. Refresh it explicitly with:

```bash
npm run local:up -- --refresh-e2e-vm
```

See [Tart Quick Start](https://tart.run/quick-start/) for the base-image size note. The first application-image build may also take several minutes; later starts reuse images, migrations, bootstrap state, and the Tart golden image.

The Agent runs one task at a time by default for Docker environments around 8 GiB. On a larger machine, set `DEVILUDO_SANDBOX_CONCURRENCY=2` before startup to process two Core tasks concurrently; this increases memory use and Provider traffic, and only `1` or `2` is accepted.

## Production deployment

Production uses five server pools:

| Pool | Recommended OS | Responsibility |
| --- | --- | --- |
| `WEB` | Ubuntu 24.04 | Next.js site, BFF, and the only public entry point |
| `CORE` | Ubuntu 24.04 x86_64 | API, scheduling, Agent, build, and publishing tasks |
| `E2E_LINUX` | Ubuntu 24.04 x86_64 | Linux real-window validation in a KVM graphical session |
| `E2E_WINDOWS` | Windows 11 Pro x86_64 | Windows real-window validation in a Hyper-V interactive session |
| `E2E_MACOS` | macOS 15+ Apple Silicon | macOS real-window validation on a Tart graphical desktop |

You also need external PostgreSQL, S3, Vault/KMS, OpenTelemetry, and load balancing. Public traffic may enter only WEB; E2E nodes reach CORE only through outbound mTLS.

Pushing a `v*` tag starts the [release workflow](.github/workflows/release.yml), which runs native acceptance on all three platforms and builds signed GHCR images and server bundles. Then, on each target server:

1. Copy and complete the matching configuration:
   - [WEB](deploy/web/deploy.env.example)
   - [CORE](deploy/core/deploy.env.example)
   - [Linux E2E](deploy/e2e-linux/deploy.env.example)
   - [Windows E2E](deploy/e2e-windows/deploy.json.example)
   - [macOS E2E](deploy/e2e-macos/deploy.env.example)
2. Put database, S3, Vault, TLS, signing, Steam, and golden-VM credentials in the permission-restricted files referenced by that configuration. Each golden image must include Godot 4.5.1, Node 22, the guest runner, its platform GUI driver, and a passing window/input/screenshot smoke.
3. Run the deployment script on every target server.

Bash hosts:

```bash
sudo ./deploy/<role>/deploy.sh preflight
sudo ./deploy/<role>/deploy.sh bootstrap
sudo ./deploy/<role>/deploy.sh deploy
sudo ./deploy/<role>/deploy.sh status
```

Windows:

```powershell
.\deploy\e2e-windows\deploy.ps1 -Action preflight
.\deploy\e2e-windows\deploy.ps1 -Action bootstrap
.\deploy\e2e-windows\deploy.ps1 -Action deploy
```

Deployment consumes digest-pinned, Cosign-signed releases and does not compile on the server. Bash deployments also support `rollback`, limited to verified releases with a compatible database schema.

On the first deployment of a new E2E protocol, the scheduler batch-revalidates only the latest terminal iteration that existed for each project at upgrade time: it reuses a valid build first, rebuilds from source next, and reruns the Agent only when source is unavailable. Set `DEVILUDO_E2E_REVALIDATION_BATCH_SIZE` to `1`–`20` (default `2`). A finally successful revalidation still auto-commits local Git projects and never pushes them.

## Development and verification

```bash
npm run check                 # Lint, types, unit tests, architecture checks, production build
npm run local:executor:test   # Fixture Agent, image injection, Godot, MinIO, macOS E2E
npm run local:database:test   # PostgreSQL RLS, concurrent claims, fencing, recovery, workflow gates
npm run local:permissions:test
```

The real-provider smoke test may incur charges and must be started explicitly with `npm run local:test`.

## Security notes

- `standalone` has no login system. Anyone who can reach the Web service can administer the instance; never expose it to an untrusted network.
- `platform` asserts sessions and membership through an external account API. Core does not store accounts, passwords, or OAuth data.
- Production agents run in Kata microVMs. Build and publishing containers use non-root users, read-only filesystems, resource limits, and pinned image digests.
- Provider, Steam, database, and signing credentials must not be committed or passed on command lines. Production reads them only from Vault or permission-restricted files.

## Learn more

- [Architecture](docs/architecture.md)
- [CI workflow](.github/workflows/ci.yml)
- [Release workflow](.github/workflows/release.yml)

Issues and pull requests are welcome. Run `npm run check` before submitting a change.
