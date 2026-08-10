import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/**
 * Commit the complete working tree after the caller has verified that it still
 * matches the source revision that passed E2E. The index must be clean before
 * DeviLudo stages anything: an existing staged change belongs to the user and
 * must never be folded into an automatic commit implicitly.
 */
export async function commitVerifiedGitDirectory(input) {
  const { directory, workflowId, iterationNumber, sourcePaths, includePath, verifySource } = input;
  if (!await isGitRepository(directory)) {
    return Object.freeze({ outcome: "NOT_GIT", commitHash: null, branch: null });
  }

  const branch = await currentBranch(directory);
  if (!await indexIsClean(directory)) {
    throw failure("GIT_INDEX_NOT_CLEAN", "Git 暂存区已有改动，已停止自动提交以避免混入用户暂存内容");
  }
  const status = await git(directory, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!status.stdout.trim()) {
    return Object.freeze({ outcome: "NO_CHANGES", commitHash: await currentHead(directory), branch });
  }

  await verifySource();
  let staged = false;
  try {
    const tracked = await trackedPaths(directory);
    const safePaths = [...new Set([...sourcePaths, ...tracked.filter(includePath)])].sort();
    await stagePaths(directory, safePaths);
    staged = true;
    await verifySource();
    if (await commandSucceeds(directory, ["diff", "--cached", "--quiet", "--ignore-submodules", "--"])) {
      await unstage(directory);
      return Object.freeze({ outcome: "NO_CHANGES", commitHash: await currentHead(directory), branch });
    }

    const identity = await commitIdentity(directory);
    const subject = `deviludo: complete iteration ${iterationNumber}`;
    const message = `${subject}\n\nDeviLudo-Workflow: ${workflowId}`;
    await git(directory, [
      ...identity,
      "commit",
      "--no-gpg-sign",
      "--no-verify",
      "--message",
      message,
    ], 120_000, 4 * 1024 * 1024);
    staged = false;
    return Object.freeze({
      outcome: "COMMITTED",
      commitHash: await currentHead(directory),
      branch: await currentBranch(directory),
    });
  } catch (error) {
    if (staged) await unstage(directory).catch(() => undefined);
    throw error;
  }
}

async function isGitRepository(directory) {
  try {
    const { stdout } = await git(directory, ["rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function currentBranch(directory) {
  try {
    const { stdout } = await git(directory, ["branch", "--show-current"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function currentHead(directory) {
  try {
    const { stdout } = await git(directory, ["rev-parse", "HEAD"]);
    return /^[0-9a-f]{40,64}$/i.test(stdout.trim()) ? stdout.trim() : null;
  } catch {
    return null;
  }
}

async function commitIdentity(directory) {
  const [name, email] = await Promise.all([
    configuredValue(directory, "user.name"),
    configuredValue(directory, "user.email"),
  ]);
  return Object.freeze([
    ...(name ? [] : ["-c", "user.name=DeviLudo Agent"]),
    ...(email ? [] : ["-c", "user.email=deviludo@localhost"]),
  ]);
}

async function configuredValue(directory, key) {
  try {
    const { stdout } = await git(directory, ["config", "--get", key]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function trackedPaths(directory) {
  const { stdout } = await git(directory, ["ls-files", "--cached", "--full-name", "-z"], 30_000, 16 * 1024 * 1024, "buffer");
  return stdout.toString("utf8").split("\0").filter(Boolean);
}

async function stagePaths(directory, paths) {
  if (paths.length < 1) return;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "deviludo-git-paths-"));
  const pathspecFile = join(temporaryDirectory, "paths");
  try {
    await writeFile(pathspecFile, Buffer.from(`${paths.join("\0")}\0`, "utf8"), { mode: 0o600 });
    await git(directory, [
      "add",
      "--all",
      `--pathspec-from-file=${pathspecFile}`,
      "--pathspec-file-nul",
    ]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function commandSucceeds(directory, args) {
  try {
    await git(directory, args);
    return true;
  } catch (error) {
    if (typeof error?.code === "number" && error.code === 1) return false;
    throw error;
  }
}

async function indexIsClean(directory) {
  if (await currentHead(directory)) {
    return commandSucceeds(directory, ["diff", "--cached", "--quiet", "--ignore-submodules", "--"]);
  }
  return (await trackedPaths(directory)).length === 0;
}

async function unstage(directory) {
  if (await currentHead(directory)) await git(directory, ["reset", "--mixed", "--quiet", "HEAD", "--"]);
  else await git(directory, ["rm", "--cached", "--quiet", "--ignore-unmatch", "-r", "."]);
}

function git(directory, args, timeout = 30_000, maxBuffer = 2 * 1024 * 1024, encoding = "utf8") {
  return execute("git", ["-C", directory, ...args], { timeout, maxBuffer, encoding });
}

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
