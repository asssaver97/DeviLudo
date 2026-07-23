import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  FinalizeLocalCandidateRequest,
  LocalScmBinding,
  LocalScmCandidateReceipt,
  LocalScmMergeReceipt,
  MaterializeLocalCandidateRequest,
  MergeLocalCandidateRequest,
  PreparedLocalRepository,
} from "./contracts";

const execFileAsync = promisify(execFile);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const MAX_FILES = 100_000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TREE_BYTES = 256 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

type BaseManifest = PreparedLocalRepository & { readonly workspaceRoot: string };
type CandidateManifest = LocalScmCandidateReceipt & Pick<LocalScmBinding, "projectId" | "runId" | "attemptId" | "specRevisionId" | "workspaceRoot">;
type MergeManifest = LocalScmMergeReceipt & Pick<LocalScmBinding, "projectId" | "runId" | "attemptId" | "specRevisionId" | "workspaceRoot">;
type ScmPaths = {
  workspace: string;
  workspaceBinding: string;
  controlDirectory: string;
  repository: string;
  gitDirectory: string;
  baseManifest: string;
  candidateManifest: string;
  mergeManifest: string;
};

/**
 * Local implementation of the SCM trust boundary. Git metadata and identity
 * live outside the Agent workspace; no credential, remote or shell is used.
 */
export class LocalGitScmProxy {
  readonly #storageRoot: string;
  readonly #gitBinary: string;

  constructor(options: { storageRoot: string; gitBinary?: string }) {
    if (!path.isAbsolute(options.storageRoot)) throw new Error("SCM storageRoot must be absolute");
    const gitBinary = options.gitBinary ?? "/usr/bin/git";
    if (!path.isAbsolute(gitBinary)) throw new Error("SCM gitBinary must be absolute");
    this.#storageRoot = path.normalize(options.storageRoot);
    this.#gitBinary = path.normalize(gitBinary);
  }

  async prepare(binding: LocalScmBinding): Promise<PreparedLocalRepository> {
    validateBinding(binding);
    const paths = await this.#resolvePaths(binding);
    const replay = await readJson<BaseManifest>(paths.baseManifest);
    if (replay) {
      assertBaseBinding(replay, binding);
      return publicBase(replay);
    }
    if (await exists(paths.repository)) throw new Error("SCM preparation is incomplete and cannot be resumed in place");

    await scanWorkspace(paths.workspace);
    await mkdir(paths.controlDirectory, { recursive: true, mode: 0o700 });
    await this.#git(["init", "--initial-branch=main", paths.repository], paths.controlDirectory);
    await this.#repo(paths, ["add", "--all", "--", "."]);
    await this.#repo(paths, ["commit", "--allow-empty", "--no-verify", "-m", `base: ${binding.specRevisionId}`]);
    const baseCommitSha = (await this.#repo(paths, ["rev-parse", "HEAD"])).trim();
    if (!SHA1.test(baseCommitSha)) throw new Error("SCM proxy produced an invalid base commit");
    const manifest: BaseManifest = Object.freeze({
      projectId: binding.projectId,
      runId: binding.runId,
      attemptId: binding.attemptId,
      specRevisionId: binding.specRevisionId,
      workspaceRoot: paths.workspaceBinding,
      baseBranch: "main",
      baseCommitSha,
      preparedAt: new Date().toISOString(),
    });
    await writeExclusiveJson(paths.baseManifest, manifest);
    return publicBase(manifest);
  }

  async finalize(request: FinalizeLocalCandidateRequest): Promise<LocalScmCandidateReceipt> {
    validateBinding(request);
    validateBranch(request.candidateBranch);
    if (!SHA1.test(request.expectedBaseCommitSha)) throw new Error("SCM expected base commit is invalid");
    if (!request.commitMessage.trim() || request.commitMessage.length > 500 || request.commitMessage.includes("\0")) {
      throw new Error("SCM commit message is invalid");
    }
    const paths = await this.#resolvePaths(request);
    const replay = await readJson<CandidateManifest>(paths.candidateManifest);
    if (replay) {
      assertCandidateBinding(replay, request);
      return publicCandidate(replay);
    }
    const base = await readJson<BaseManifest>(paths.baseManifest);
    if (!base) throw new Error("SCM workspace was not prepared");
    assertBaseBinding(base, request);
    if (base.baseCommitSha !== request.expectedBaseCommitSha) throw new Error("SCM base commit lock does not match");
    const head = (await this.#repo(paths, ["rev-parse", "HEAD"])).trim();
    if (head !== request.expectedBaseCommitSha) throw new Error("SCM repository HEAD drifted before finalization");

    await scanWorkspace(paths.workspace);
    const status = await this.#repo(paths, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (!status) throw new Error("Agent completed without a candidate file change");
    await this.#repo(paths, ["branch", request.candidateBranch, request.expectedBaseCommitSha]);
    await this.#repo(paths, ["symbolic-ref", "HEAD", `refs/heads/${request.candidateBranch}`]);
    await this.#repo(paths, ["add", "--all", "--", "."]);
    await this.#repo(paths, ["commit", "--no-verify", "-m", request.commitMessage.trim()]);
    const commitSha = (await this.#repo(paths, ["rev-parse", "HEAD"])).trim();
    if (!SHA1.test(commitSha) || commitSha === request.expectedBaseCommitSha) throw new Error("SCM proxy did not create a new candidate commit");
    const changedFiles = parseNullList(await this.#repo(paths, ["diff", "--name-only", "-z", request.expectedBaseCommitSha, commitSha]));
    if (!changedFiles.length || changedFiles.some((file) => !safeRelativePath(file))) {
      throw new Error("SCM proxy candidate file list is invalid");
    }
    const tree = await this.#repo(paths, ["ls-tree", "-r", "-z", "--full-tree", commitSha]);
    const sourceDigest = createHash("sha256").update(tree, "utf8").digest("hex");
    const manifest: CandidateManifest = Object.freeze({
      projectId: request.projectId,
      runId: request.runId,
      attemptId: request.attemptId,
      specRevisionId: request.specRevisionId,
      workspaceRoot: paths.workspaceBinding,
      scmProxy: "local-git-proxy-v1",
      branch: request.candidateBranch,
      commitSha,
      sourceDigest,
      changedFiles: Object.freeze([...changedFiles].sort()),
      draftPullRequest: null,
      baseCommitSha: request.expectedBaseCommitSha,
      createdAt: new Date().toISOString(),
    });
    await writeExclusiveJson(paths.candidateManifest, manifest);
    return publicCandidate(manifest);
  }

  async merge(request: MergeLocalCandidateRequest): Promise<LocalScmMergeReceipt> {
    validateBinding(request);
    if (!SHA1.test(request.expectedCandidateCommitSha)) {
      throw new Error("SCM merge commit binding is invalid");
    }
    if (!/^[a-f0-9]{64}$/.test(request.expectedSourceDigest)) throw new Error("SCM merge source digest is invalid");
    const paths = await this.#resolvePaths(request);
    const replay = await readJson<MergeManifest>(paths.mergeManifest);
    if (replay) {
      assertMergeBinding(replay, request);
      return publicMerge(replay);
    }
    const candidate = await readJson<CandidateManifest>(paths.candidateManifest);
    if (!candidate) throw new Error("SCM candidate is missing before merge");
    if (candidate.commitSha !== request.expectedCandidateCommitSha
      || candidate.sourceDigest !== request.expectedSourceDigest) {
      throw new Error("SCM candidate does not match the accepted evidence");
    }
    const candidateRef = (await this.#repo(paths, ["rev-parse", `refs/heads/${candidate.branch}`])).trim();
    if (candidateRef !== candidate.commitSha) throw new Error("SCM candidate branch drifted before merge");
    const currentMain = (await this.#repo(paths, ["rev-parse", "refs/heads/main"])).trim();
    if (currentMain === candidate.baseCommitSha) {
      await this.#repo(paths, ["update-ref", "refs/heads/main", candidate.commitSha, candidate.baseCommitSha]);
    } else if (currentMain !== candidate.commitSha) {
      throw new Error("SCM main branch drifted before merge");
    }
    await this.#repo(paths, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await this.#repo(paths, ["reset", "--hard", "refs/heads/main"]);
    const mainCommitSha = (await this.#repo(paths, ["rev-parse", "HEAD"])).trim();
    const tree = await this.#repo(paths, ["ls-tree", "-r", "-z", "--full-tree", mainCommitSha]);
    const sourceDigest = createHash("sha256").update(tree, "utf8").digest("hex");
    if (mainCommitSha !== candidate.commitSha || sourceDigest !== candidate.sourceDigest) {
      throw new Error("SCM merged main does not match the accepted candidate tree");
    }
    const manifest: MergeManifest = Object.freeze({
      projectId: request.projectId,
      runId: request.runId,
      attemptId: request.attemptId,
      specRevisionId: request.specRevisionId,
      workspaceRoot: paths.workspaceBinding,
      scmProxy: "local-git-proxy-v1",
      branch: "main",
      candidateBranch: candidate.branch,
      baseCommitSha: candidate.baseCommitSha,
      candidateCommitSha: candidate.commitSha,
      mainCommitSha,
      sourceDigest,
      mergedAt: new Date().toISOString(),
    });
    await writeExclusiveJson(paths.mergeManifest, manifest);
    return publicMerge(manifest);
  }

  /**
   * Independently checks an immutable candidate manifest/ref/tree and exports
   * exactly that Git tree into a new metadata-free validation workspace.
   */
  async materializeCandidate(request: MaterializeLocalCandidateRequest): Promise<LocalScmCandidateReceipt> {
    validateBinding(request);
    validateBranch(request.expectedBranch);
    if (!SHA1.test(request.expectedBaseCommitSha) || !SHA1.test(request.expectedCandidateCommitSha)) {
      throw new Error("SCM materialization commit binding is invalid");
    }
    if (!/^[a-f0-9]{64}$/.test(request.expectedSourceDigest)) {
      throw new Error("SCM materialization source digest is invalid");
    }
    if (!path.isAbsolute(request.destinationRoot)) throw new Error("SCM materialization destination must be absolute");
    const paths = await this.#resolvePaths(request);
    const candidate = await readJson<CandidateManifest>(paths.candidateManifest);
    if (!candidate
      || candidate.projectId !== request.projectId
      || candidate.runId !== request.runId
      || candidate.attemptId !== request.attemptId
      || candidate.specRevisionId !== request.specRevisionId
      || candidate.workspaceRoot !== path.resolve(request.workspaceRoot)
      || candidate.scmProxy !== "local-git-proxy-v1"
      || candidate.branch !== request.expectedBranch
      || candidate.baseCommitSha !== request.expectedBaseCommitSha
      || candidate.commitSha !== request.expectedCandidateCommitSha
      || candidate.sourceDigest !== request.expectedSourceDigest) {
      throw new Error("SCM candidate does not match the validation authority");
    }
    const candidateRef = (await this.#repo(paths, ["rev-parse", `refs/heads/${candidate.branch}`])).trim();
    if (candidateRef !== candidate.commitSha) throw new Error("SCM candidate branch drifted before materialization");
    const tree = await this.#repo(paths, ["ls-tree", "-r", "-z", "--full-tree", candidate.commitSha]);
    if (createHash("sha256").update(tree, "utf8").digest("hex") !== candidate.sourceDigest) {
      throw new Error("SCM candidate tree drifted before materialization");
    }

    const destination = path.resolve(request.destinationRoot);
    if (destination === paths.workspace || destination.startsWith(`${paths.controlDirectory}${path.sep}`)) {
      throw new Error("SCM materialization destination overlaps protected source state");
    }
    await mkdir(destination, { recursive: true, mode: 0o700 });
    if ((await lstat(destination)).isSymbolicLink() || (await readdir(destination)).length !== 0) {
      throw new Error("SCM materialization destination must be an empty non-symlink directory");
    }
    await this.#git([
      `--git-dir=${paths.gitDirectory}`,
      `--work-tree=${destination}`,
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      "-c", "credential.helper=",
      "-c", "protocol.file.allow=never",
      "checkout", "--force", candidate.commitSha, "--", ".",
    ], destination);
    await scanWorkspace(destination);
    return publicCandidate(candidate);
  }

  async #resolvePaths(binding: LocalScmBinding) {
    await mkdir(this.#storageRoot, { recursive: true, mode: 0o700 });
    const storageReal = await realpath(this.#storageRoot);
    const requestedWorkspace = path.resolve(binding.workspaceRoot);
    if ((await lstat(requestedWorkspace)).isSymbolicLink()) throw new Error("SCM workspace root must not be a symlink");
    const workspace = await realpath(requestedWorkspace);
    requireWithin(storageReal, workspace, "workspace");
    const controlDirectory = path.join(storageReal, ".scm", binding.projectId, binding.runId, binding.attemptId);
    requireWithin(storageReal, controlDirectory, "SCM control directory");
    if (workspace === controlDirectory || workspace.startsWith(`${controlDirectory}${path.sep}`)) {
      throw new Error("Agent workspace cannot contain SCM control metadata");
    }
    return {
      workspace,
      workspaceBinding: requestedWorkspace,
      controlDirectory,
      repository: path.join(controlDirectory, "repository"),
      gitDirectory: path.join(controlDirectory, "repository", ".git"),
      baseManifest: path.join(controlDirectory, "base.json"),
      candidateManifest: path.join(controlDirectory, "candidate.json"),
      mergeManifest: path.join(controlDirectory, "merge.json"),
    };
  }

  async #repo(paths: ScmPaths, args: readonly string[]): Promise<string> {
    return this.#git([
      `--git-dir=${paths.gitDirectory}`,
      `--work-tree=${paths.workspace}`,
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      "-c", "credential.helper=",
      "-c", "protocol.file.allow=never",
      ...args,
    ], paths.workspace);
  }

  async #git(args: readonly string[], cwd: string): Promise<string> {
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/usr/bin/false",
      GIT_AUTHOR_NAME: "DeviLudo SCM Proxy",
      GIT_AUTHOR_EMAIL: "scm-proxy@deviludo.invalid",
      GIT_COMMITTER_NAME: "DeviLudo SCM Proxy",
      GIT_COMMITTER_EMAIL: "scm-proxy@deviludo.invalid",
    };
    try {
      const result = await execFileAsync(this.#gitBinary, [...args], {
        cwd,
        env: environment,
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: 60_000,
        windowsHide: true,
      });
      return result.stdout;
    } catch (error) {
      const failure = error as Error & { code?: number | string };
      throw new Error(`SCM git operation failed${typeof failure.code === "number" ? ` with code ${failure.code}` : ""}`);
    }
  }
}

function validateBinding(binding: LocalScmBinding): void {
  for (const value of [binding.projectId, binding.runId, binding.attemptId, binding.specRevisionId]) {
    if (!IDENTIFIER.test(value)) throw new Error("SCM binding identifier is invalid");
  }
  if (!path.isAbsolute(binding.workspaceRoot)) throw new Error("SCM workspaceRoot must be absolute");
}

function validateBranch(value: string): void {
  if (value.length > 128
    || !/^deviludo\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i.test(value)
    || value.includes("..")
    || value.endsWith(".lock")) {
    throw new Error("SCM candidate branch is invalid");
  }
}

async function scanWorkspace(workspace: string): Promise<void> {
  const root = await stat(workspace);
  if (!root.isDirectory()) throw new Error("SCM workspace is not a directory");
  let files = 0;
  let bytes = 0;
  async function walk(directory: string, relative: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") throw new Error("Agent workspace must not contain Git metadata");
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (!safeRelativePath(childRelative)) throw new Error("Agent workspace contains an unsafe path");
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error("Agent workspace symlinks are forbidden");
      if (info.isDirectory()) {
        await walk(absolute, childRelative);
      } else if (info.isFile()) {
        files += 1;
        bytes += info.size;
        if (info.size > MAX_FILE_BYTES || files > MAX_FILES || bytes > MAX_TREE_BYTES) {
          throw new Error("Agent workspace exceeds SCM resource limits");
        }
      } else {
        throw new Error("Agent workspace contains a special file");
      }
    }
  }
  await walk(workspace, "");
}

function safeRelativePath(value: string): boolean {
  return Boolean(value)
    && value.length <= 500
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.includes("\0")
    && !/[\x00-\x1f\x7f]/.test(value)
    && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function parseNullList(value: string): string[] {
  const items = value.split("\0").filter(Boolean);
  if (new Set(items).size !== items.length) throw new Error("SCM proxy returned duplicate file paths");
  return items;
}

function requireWithin(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a child of SCM storageRoot`);
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("SCM manifest is invalid");
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeExclusiveJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function assertBaseBinding(manifest: BaseManifest, binding: LocalScmBinding): void {
  if (manifest.projectId !== binding.projectId
    || manifest.runId !== binding.runId
    || manifest.attemptId !== binding.attemptId
    || manifest.specRevisionId !== binding.specRevisionId
    || manifest.workspaceRoot !== path.resolve(binding.workspaceRoot)
    || manifest.baseBranch !== "main"
    || !SHA1.test(manifest.baseCommitSha)) {
    throw new Error("SCM base manifest binding mismatch");
  }
}

function assertCandidateBinding(manifest: CandidateManifest, request: FinalizeLocalCandidateRequest): void {
  assertBaseBinding({ ...manifest, baseBranch: "main", preparedAt: manifest.createdAt }, request);
  if (manifest.baseCommitSha !== request.expectedBaseCommitSha
    || manifest.branch !== request.candidateBranch
    || manifest.scmProxy !== "local-git-proxy-v1"
    || !SHA1.test(manifest.commitSha)
    || !/^[a-f0-9]{64}$/.test(manifest.sourceDigest)) {
    throw new Error("SCM candidate manifest binding mismatch");
  }
}

function assertMergeBinding(manifest: MergeManifest, request: MergeLocalCandidateRequest): void {
  if (manifest.projectId !== request.projectId
    || manifest.runId !== request.runId
    || manifest.attemptId !== request.attemptId
    || manifest.specRevisionId !== request.specRevisionId
    || manifest.workspaceRoot !== path.resolve(request.workspaceRoot)
    || manifest.scmProxy !== "local-git-proxy-v1"
    || manifest.branch !== "main"
    || manifest.candidateCommitSha !== request.expectedCandidateCommitSha
    || manifest.mainCommitSha !== request.expectedCandidateCommitSha
    || manifest.sourceDigest !== request.expectedSourceDigest) {
    throw new Error("SCM merge manifest binding mismatch");
  }
}

function publicBase(manifest: BaseManifest): PreparedLocalRepository {
  return Object.freeze({
    projectId: manifest.projectId,
    runId: manifest.runId,
    attemptId: manifest.attemptId,
    specRevisionId: manifest.specRevisionId,
    baseBranch: "main",
    baseCommitSha: manifest.baseCommitSha,
    preparedAt: manifest.preparedAt,
  });
}

function publicCandidate(manifest: CandidateManifest): LocalScmCandidateReceipt {
  return Object.freeze({
    scmProxy: "local-git-proxy-v1",
    branch: manifest.branch,
    commitSha: manifest.commitSha,
    sourceDigest: manifest.sourceDigest,
    changedFiles: Object.freeze([...manifest.changedFiles]),
    draftPullRequest: null,
    baseCommitSha: manifest.baseCommitSha,
    createdAt: manifest.createdAt,
  });
}

function publicMerge(manifest: MergeManifest): LocalScmMergeReceipt {
  return Object.freeze({
    scmProxy: "local-git-proxy-v1",
    branch: "main",
    candidateBranch: manifest.candidateBranch,
    baseCommitSha: manifest.baseCommitSha,
    candidateCommitSha: manifest.candidateCommitSha,
    mainCommitSha: manifest.mainCommitSha,
    sourceDigest: manifest.sourceDigest,
    mergedAt: manifest.mergedAt,
  });
}
