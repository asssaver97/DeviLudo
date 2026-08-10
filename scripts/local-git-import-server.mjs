import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import sourceArchive from "../lib/product/source-archive.ts";
import projectImport from "../services/core/src/project-import.ts";
import { commitVerifiedGitDirectory } from "./local-git-commit.mjs";

const { normalizeGitBranchName, normalizeGitHubRepositoryUrl } = projectImport;
const { normalizeProjectPath, shouldIncludeProjectPath } = sourceArchive;
const execute = promisify(execFile);
const MAX_REQUEST_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const configFile = new URL("../.deviludo/local/git-import.json", import.meta.url);
const bindingsFile = new URL("../.deviludo/local/project-directories.json", import.meta.url);
const config = JSON.parse(await readFile(configFile, "utf8"));
if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65_535) {
  throw new Error("Local project bridge port is invalid");
}
if (typeof config.internalToken !== "string" || !/^[A-Za-z0-9_-]{40,200}$/.test(config.internalToken)) {
  throw new Error("Local project bridge internal token is invalid");
}
const allowedOrigin = new URL(config.allowedOrigin);
if (allowedOrigin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(allowedOrigin.hostname)
  || allowedOrigin.username || allowedOrigin.password || allowedOrigin.pathname !== "/"
  || allowedOrigin.search || allowedOrigin.hash) {
  throw new Error("Local project bridge origin is invalid");
}

let activeOperations = 0;
const server = createServer(async (request, response) => {
  if (request.url === "/health" && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ ready: true }));
    return;
  }
  try {
    if (request.url?.startsWith("/internal/")) {
      await handleInternalRequest(request, response);
      return;
    }
    const cors = browserCors(request);
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    if (request.method !== "POST" || ![
      "/directory/select",
      "/github/clone",
      "/directory/git/status",
      "/directory/git/branch",
    ].includes(request.url ?? "")) {
      sendJson(response, 404, { code: "NOT_FOUND", message: "本地项目接口不存在" }, cors);
      return;
    }
    if (activeOperations >= 1) throw failure("LOCAL_PROJECT_BUSY", "已有本地项目正在处理，请稍后重试");
    activeOperations += 1;
    try {
      const body = await readJsonBody(request);
      if (request.url === "/directory/git/status") {
        const binding = await requireBinding(body.bindingId);
        sendJson(response, 200, await inspectGitDirectory(binding.path), cors);
        return;
      }
      if (request.url === "/directory/git/branch") {
        const binding = await requireBinding(body.bindingId);
        const branchName = requestedGitBranch(body.branchName);
        sendJson(response, 200, await createGitBranch(binding.path, branchName), cors);
        return;
      }
      const result = request.url === "/directory/select"
        ? await importLocalDirectory()
        : await cloneGitHubDirectory(typeof body.repositoryUrl === "string" ? body.repositoryUrl : "");
      sendJson(response, 200, result, cors);
    } finally {
      activeOperations -= 1;
    }
  } catch (error) {
    const mapped = importFailure(error);
    const cors = request.headers.origin === allowedOrigin.origin ? browserCors(request) : {};
    sendJson(response, mapped.status, { code: mapped.code, message: mapped.message }, cors);
  }
});

server.listen(config.port, "127.0.0.1", () => {
  console.log(JSON.stringify({ ready: true, address: `http://127.0.0.1:${config.port}` }));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}

function browserCors(request) {
  const origin = request.headers.origin ?? "";
  if (origin !== allowedOrigin.origin) throw failure("ORIGIN_REJECTED", "本地项目请求来源无效");
  return {
    "access-control-allow-origin": allowedOrigin.origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
    vary: "Origin",
  };
}

async function handleInternalRequest(request, response) {
  if (request.headers["x-deviludo-bridge-token"] !== config.internalToken) {
    sendJson(response, 403, { code: "BRIDGE_AUTH_REJECTED", message: "本地项目桥接认证失败" });
    return;
  }
  if (request.method === "POST" && request.url === "/internal/directory/source") {
    const body = await readJsonBody(request);
    const binding = await requireBinding(body.bindingId);
    const files = await readProjectFiles(binding.path);
    const source = encodeSourceStream(files);
    response.writeHead(200, {
      "content-type": "application/x-deviludo-source-v1",
      "content-length": String(source.length),
      "x-deviludo-source-digest": sourceDigest(files),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(source);
    return;
  }
  if (request.method === "POST" && request.url === "/internal/directory/sync") {
    const bindingId = String(request.headers["x-deviludo-directory-binding"] ?? "");
    const expectedDigest = String(request.headers["x-deviludo-base-digest"] ?? "");
    if (!/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) throw failure("INVALID_SOURCE_DIGEST", "本地项目基线无效");
    const binding = await requireBinding(bindingId);
    const source = await readBody(request);
    const files = parseSourceStream(source);
    const digest = await syncProjectDirectory(binding.path, files, expectedDigest);
    sendJson(response, 200, { synced: true, digest });
    return;
  }
  if (request.method === "POST" && request.url === "/internal/directory/git/commit") {
    const body = await readJsonBody(request);
    const binding = await requireBinding(body.bindingId);
    const expectedDigest = typeof body.expectedDigest === "string" ? body.expectedDigest : "";
    const workflowId = typeof body.workflowId === "string" ? body.workflowId : "";
    const iterationNumber = Number(body.iterationNumber);
    if (!/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) {
      throw failure("INVALID_SOURCE_DIGEST", "E2E 源码 digest 无效");
    }
    if (!UUID.test(workflowId) || !Number.isSafeInteger(iterationNumber) || iterationNumber < 1) {
      throw failure("INVALID_GIT_COMMIT_REQUEST", "自动 Git 提交请求无效");
    }
    const verifySource = async () => {
      const current = await readProjectFiles(binding.path);
      if (sourceDigest(current) !== expectedDigest) {
        throw failure("LOCAL_PROJECT_CHANGED", "E2E 完成后本地项目又发生了变化，已停止自动提交以避免提交未经测试的内容");
      }
      return current;
    };
    const current = await verifySource();
    const result = await commitVerifiedGitDirectory({
      directory: binding.path,
      workflowId,
      iterationNumber,
      sourcePaths: current.map(file => file.path),
      includePath: path => {
        try { return shouldIncludeProjectPath(path); } catch { return false; }
      },
      verifySource,
    });
    sendJson(response, 200, result);
    return;
  }
  sendJson(response, 404, { code: "NOT_FOUND", message: "本地项目内部接口不存在" });
}

async function importLocalDirectory() {
  const selected = await chooseDirectory("选择需要由 DeviLudo 原地修改的 Godot 项目文件夹");
  const projectPath = await validateProjectDirectory(selected);
  const git = await inspectGitDirectory(projectPath);
  const bindingId = await registerBinding(projectPath);
  return Object.freeze({
    bindingId,
    displayName: basename(projectPath),
    gitRepository: git.repository,
    gitBranch: git.branch,
  });
}

async function cloneGitHubDirectory(repositoryUrl) {
  let repository;
  try { repository = normalizeGitHubRepositoryUrl(repositoryUrl); }
  catch (error) { throw Object.assign(error, { code: "INVALID_GITHUB_REPOSITORY" }); }
  const parent = await validateParentDirectory(await chooseDirectory("选择 GitHub 项目的本地保存位置"));
  const target = join(parent, repository.displayName);
  if (await exists(target)) throw failure(
    "GITHUB_TARGET_EXISTS",
    `目标目录已存在：${target}。如需继续使用，请从“本地项目”选择该目录。`,
  );
  let created = false;
  try {
    created = true;
    await execute("git", [
      "-c", "core.hooksPath=/dev/null",
      "-c", "filter.lfs.smudge=",
      "-c", "filter.lfs.required=false",
      "clone", "--depth=1", "--single-branch", "--no-tags", "--",
      repository.cloneUrl, target,
    ], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: 30 * 60 * 1_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const projectPath = await validateProjectDirectory(target);
    const git = await inspectGitDirectory(projectPath);
    const bindingId = await registerBinding(projectPath);
    return Object.freeze({
      bindingId,
      displayName: repository.displayName,
      gitRepository: true,
      gitBranch: git.branch,
    });
  } catch (error) {
    if (created) await rm(target, { recursive: true, force: true });
    throw error;
  }
}

async function inspectGitDirectory(directory) {
  const repository = await gitRepository(directory);
  return Object.freeze({ repository, branch: repository ? await currentGitBranch(directory) : null });
}

async function createGitBranch(directory, branchName) {
  if (!await gitRepository(directory)) {
    throw failure("NOT_A_GIT_REPOSITORY", "当前项目目录不是 Git 仓库，不能创建分支");
  }
  try {
    await execute("git", ["check-ref-format", "--branch", branchName], { timeout: 10_000, maxBuffer: 64 * 1024 });
  } catch {
    throw failure("INVALID_GIT_BRANCH", "新分支名称无效");
  }
  try {
    await execute("git", ["-C", directory, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    throw failure("GIT_BRANCH_EXISTS", `分支 ${branchName} 已存在，请输入新的分支名称`);
  } catch (error) {
    if (error?.code === "GIT_BRANCH_EXISTS") throw error;
    if (typeof error?.code === "number" && error.code !== 1) throw error;
  }
  await execute("git", ["-C", directory, "switch", "-c", branchName], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  return Object.freeze({ repository: true, branch: branchName });
}

function requestedGitBranch(value) {
  try {
    const branch = normalizeGitBranchName(typeof value === "string" ? value : "");
    if (!branch) throw new Error("branch is required");
    return branch;
  } catch {
    throw failure("INVALID_GIT_BRANCH", "新分支名称无效");
  }
}

async function gitRepository(directory) {
  try {
    const { stdout } = await execute("git", ["-C", directory, "rev-parse", "--is-inside-work-tree"], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    return stdout.trim() === "true";
  } catch { return false; }
}

async function currentGitBranch(directory) {
  try {
    const { stdout } = await execute("git", ["-C", directory, "branch", "--show-current"], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    return stdout.trim() || null;
  } catch { return null; }
}

async function chooseDirectory(prompt) {
  if (process.platform !== "darwin") throw failure("DIRECTORY_PICKER_UNAVAILABLE", "本地目录选择目前仅支持 macOS");
  try {
    const script = `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`;
    const { stdout } = await execute("/usr/bin/osascript", ["-e", script], { maxBuffer: 64 * 1024 });
    return stdout.trim().replace(/\/$/, "");
  } catch (error) {
    if (/User canceled|-128/i.test(String(error?.stderr ?? error?.message ?? ""))) {
      throw failure("DIRECTORY_SELECTION_CANCELLED", "已取消选择项目文件夹");
    }
    throw error;
  }
}

async function validateParentDirectory(value) {
  const directory = await realpath(value);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || directory === sep || directory === homedir()) {
    throw failure("INVALID_TARGET_DIRECTORY", "请选择具体的项目保存目录，不要选择磁盘根目录或用户主目录");
  }
  return directory;
}

async function validateProjectDirectory(value) {
  const directory = await validateParentDirectory(value);
  const projectFile = await lstat(join(directory, "project.godot")).catch(() => null);
  if (!projectFile?.isFile() || projectFile.isSymbolicLink()) {
    throw failure("NOT_A_GODOT_PROJECT", "所选目录不是 Godot 项目根目录（缺少 project.godot）");
  }
  return directory;
}

async function registerBinding(projectPath) {
  const bindings = await readBindings();
  const existing = Object.entries(bindings).find(([, binding]) => binding.path === projectPath)?.[0];
  if (existing) return existing;
  const bindingId = randomUUID();
  bindings[bindingId] = { path: projectPath, createdAt: new Date().toISOString() };
  await writeBindings(bindings);
  return bindingId;
}

async function requireBinding(value) {
  const bindingId = typeof value === "string" ? value : "";
  if (!UUID.test(bindingId)) throw failure("INVALID_DIRECTORY_BINDING", "本地项目目录绑定无效");
  const binding = (await readBindings())[bindingId];
  if (!binding) throw failure("DIRECTORY_BINDING_NOT_FOUND", "本地项目目录绑定已失效，请重新关联");
  const current = await validateProjectDirectory(binding.path);
  if (current !== binding.path) throw failure("DIRECTORY_BINDING_CHANGED", "本地项目目录位置已变化，请重新关联");
  return Object.freeze({ id: bindingId, path: current });
}

async function readBindings() {
  try {
    const value = JSON.parse(await readFile(bindingsFile, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.entries(value).some(([id, binding]) => !UUID.test(id)
        || !binding || typeof binding !== "object" || Array.isArray(binding)
        || typeof binding.path !== "string" || !isAbsolute(binding.path))) {
      throw failure("BINDING_REGISTRY_CORRUPTED", "本地项目目录绑定记录已损坏，请检查 .deviludo/local/project-directories.json");
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    if (error?.code === "BINDING_REGISTRY_CORRUPTED") throw error;
    throw failure("BINDING_REGISTRY_CORRUPTED", "本地项目目录绑定记录无法读取，请检查 .deviludo/local/project-directories.json");
  }
}

async function writeBindings(bindings) {
  const staging = new URL(`../.deviludo/local/project-directories-${randomUUID()}.json`, import.meta.url);
  await writeFile(staging, `${JSON.stringify(bindings, null, 2)}\n`, { mode: 0o600 });
  await rename(staging, bindingsFile);
}

async function readProjectFiles(root) {
  const files = [];
  const visit = async directory => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (!shouldIncludeProjectPath(path)) continue;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!info.isFile()) continue;
      const bytes = await readFile(absolute);
      files.push(Object.freeze({ path: normalizeProjectPath(path), bytes }));
    }
  };
  await visit(root);
  if (!files.some(file => file.path === "project.godot")) throw failure("NOT_A_GODOT_PROJECT", "项目缺少 project.godot");
  return Object.freeze(files.sort((left, right) => left.path.localeCompare(right.path)));
}

function encodeSourceStream(files) {
  const parts = [Buffer.from("DEVILUDO_SOURCE_V1\0")];
  for (const file of files) {
    const path = Buffer.from(file.path, "utf8");
    const header = Buffer.allocUnsafe(12);
    header.writeUInt32BE(path.length, 0);
    header.writeBigUInt64BE(BigInt(file.bytes.length), 4);
    parts.push(header, path, file.bytes);
  }
  return Buffer.concat(parts);
}

function parseSourceStream(value) {
  const magic = Buffer.from("DEVILUDO_SOURCE_V1\0");
  if (value.length < magic.length || !value.subarray(0, magic.length).equals(magic)) {
    throw failure("INVALID_SOURCE_STREAM", "Agent 源码流无效");
  }
  const files = [];
  const seen = new Set();
  let offset = magic.length;
  while (offset < value.length) {
    if (offset + 12 > value.length) throw failure("INVALID_SOURCE_STREAM", "Agent 源码流已截断");
    const pathLength = value.readUInt32BE(offset);
    const contentLength = Number(value.readBigUInt64BE(offset + 4));
    offset += 12;
    if (pathLength < 1 || pathLength > 4096 || !Number.isSafeInteger(contentLength)
      || contentLength < 0
      || offset + pathLength + contentLength > value.length) {
      throw failure("INVALID_SOURCE_STREAM", "Agent 源码条目无效");
    }
    const encodedPath = value.subarray(offset, offset + pathLength);
    const decodedPath = encodedPath.toString("utf8");
    if (!Buffer.from(decodedPath, "utf8").equals(encodedPath)) throw failure("INVALID_SOURCE_STREAM", "Agent 源码路径编码无效");
    const path = normalizeProjectPath(decodedPath);
    if (!shouldIncludeProjectPath(path) || seen.has(path)) throw failure("INVALID_SOURCE_STREAM", `Agent 源码路径不允许写回：${path}`);
    offset += pathLength;
    const bytes = Buffer.from(value.subarray(offset, offset + contentLength));
    offset += contentLength;
    seen.add(path);
    files.push(Object.freeze({ path, bytes }));
  }
  if (!files.some(file => file.path === "project.godot")) throw failure("NOT_A_GODOT_PROJECT", "Agent 输出缺少 project.godot");
  return Object.freeze(files.sort((left, right) => left.path.localeCompare(right.path)));
}

async function syncProjectDirectory(root, files, expectedDigest) {
  const current = await readProjectFiles(root);
  if (sourceDigest(current) !== expectedDigest) {
    throw failure("LOCAL_PROJECT_CHANGED", "Agent 运行期间本地项目已被修改，为避免覆盖你的更改，本次写回已停止");
  }
  const nextPaths = new Set(files.map(file => file.path));
  const staged = [];
  try {
    for (const file of files) {
      const target = safeTarget(root, file.path);
      await ensureSafeParents(root, dirname(target));
      const staging = join(dirname(target), `.deviludo-${randomUUID()}.tmp`);
      await writeFile(staging, file.bytes, { mode: 0o644 });
      staged.push(Object.freeze({ staging, target }));
    }
    for (const entry of staged) await rename(entry.staging, entry.target);
    for (const file of current) {
      if (!nextPaths.has(file.path)) await rm(safeTarget(root, file.path), { force: true });
    }
  } finally {
    await Promise.all(staged.map(entry => rm(entry.staging, { force: true }).catch(() => undefined)));
  }
  return sourceDigest(files);
}

async function ensureSafeParents(root, target) {
  const path = relative(root, target);
  if (!path) return;
  let current = root;
  for (const segment of path.split(sep)) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw failure("UNSAFE_LOCAL_PROJECT", "本地项目包含不安全的目录链接");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o755 });
    }
  }
}

function safeTarget(root, path) {
  const target = resolve(root, normalizeProjectPath(path));
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!target.startsWith(prefix)) throw failure("UNSAFE_LOCAL_PROJECT", "本地项目路径越界");
  return target;
}

function sourceDigest(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    const path = Buffer.from(file.path, "utf8");
    const size = Buffer.allocUnsafe(8);
    size.writeBigUInt64BE(BigInt(file.bytes.length));
    hash.update(path).update("\0").update(size).update(file.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function readJsonBody(request) {
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw failure("INVALID_REQUEST", "请求必须使用 JSON");
  }
  const bytes = await readBody(request, MAX_REQUEST_BYTES);
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw failure("INVALID_REQUEST", "本地项目请求格式无效"); }
}

async function readBody(request, maximumBytes = Number.MAX_SAFE_INTEGER) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw failure("INVALID_REQUEST", "本地项目请求元数据过大");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function importFailure(error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const statusByCode = {
    ORIGIN_REJECTED: 403,
    BRIDGE_AUTH_REJECTED: 403,
    INVALID_REQUEST: 400,
    INVALID_GITHUB_REPOSITORY: 400,
    INVALID_GIT_BRANCH: 400,
    INVALID_DIRECTORY_BINDING: 400,
    INVALID_SOURCE_DIGEST: 400,
    INVALID_SOURCE_STREAM: 400,
    INVALID_GIT_COMMIT_REQUEST: 400,
    DIRECTORY_SELECTION_CANCELLED: 409,
    GIT_BRANCH_EXISTS: 409,
    GITHUB_TARGET_EXISTS: 409,
    GIT_INDEX_NOT_CLEAN: 409,
    LOCAL_PROJECT_CHANGED: 409,
    LOCAL_PROJECT_BUSY: 429,
    NOT_A_GODOT_PROJECT: 422,
    NOT_A_GIT_REPOSITORY: 422,
    DIRECTORY_BINDING_NOT_FOUND: 422,
    DIRECTORY_BINDING_CHANGED: 422,
    INVALID_TARGET_DIRECTORY: 422,
    UNSAFE_LOCAL_PROJECT: 422,
    BINDING_REGISTRY_CORRUPTED: 500,
    DIRECTORY_PICKER_UNAVAILABLE: 501,
  };
  if (code in statusByCode) return { status: statusByCode[code], code, message: error.message };
  console.error(JSON.stringify({ event: "local_project_bridge_failed", message: error instanceof Error ? error.message : String(error) }));
  return {
    status: 422,
    code: "LOCAL_PROJECT_OPERATION_FAILED",
    message: "本地项目操作失败；如为 GitHub 仓库，请先在终端确认 git clone 可用",
  };
}

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

async function exists(path) {
  try { await lstat(path); return true; } catch { return false; }
}
