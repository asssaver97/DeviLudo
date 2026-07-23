import { cp, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { LocalAgentExecutionRequest } from "./contracts";
import type { LocalWorkspaceProvisioner } from "./isolated-executor";

const MAX_FILES = 10_000;
const MAX_BYTES = 128 * 1024 * 1024;

/** Copies the platform-owned Godot scaffold into a new attempt workspace. */
export class FixtureWorkspaceProvisioner implements LocalWorkspaceProvisioner {
  readonly #fixtureRoot: string;

  constructor(fixtureRoot: string) {
    if (!path.isAbsolute(fixtureRoot)) throw new Error("Local fixture root must be absolute");
    this.#fixtureRoot = path.normalize(fixtureRoot);
  }

  async provision(_request: LocalAgentExecutionRequest, workspaceRoot: string): Promise<void> {
    if (!path.isAbsolute(workspaceRoot)) throw new Error("Local workspace root must be absolute");
    try {
      await lstat(workspaceRoot);
      throw new Error("Local Agent workspace already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const fixture = await realpath(this.#fixtureRoot);
    await scanFixture(fixture);
    await mkdir(path.dirname(workspaceRoot), { recursive: true, mode: 0o700 });
    await cp(fixture, workspaceRoot, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: false,
    });
  }
}

async function scanFixture(root: string): Promise<void> {
  let files = 0;
  let bytes = 0;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".godot") {
        throw new Error("Local fixture contains forbidden control metadata");
      }
      const target = path.join(directory, entry.name);
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink()) throw new Error("Local fixture must not contain symbolic links");
      if (metadata.isDirectory()) pending.push(target);
      else if (metadata.isFile()) {
        files += 1;
        bytes += metadata.size;
        if (files > MAX_FILES || metadata.size > 32 * 1024 * 1024 || bytes > MAX_BYTES) {
          throw new Error("Local fixture exceeds workspace bounds");
        }
      } else throw new Error("Local fixture contains an unsupported filesystem entry");
    }
  }
  const project = await lstat(path.join(root, "project.godot"));
  if (!project.isFile() || project.isSymbolicLink()) throw new Error("Local fixture is not a Godot project");
}
