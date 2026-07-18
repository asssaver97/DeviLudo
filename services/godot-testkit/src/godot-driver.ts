import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { GodotHarnessResult, GodotTestKitRunRequest, GodotTestPlan } from "./contracts";
import { parseGodotHarnessResult } from "./contracts";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface GodotCommandEvidence {
  readonly id:
    | "import"
    | "boot"
    | "platform-suite"
    | "production-export"
    | "production-boot"
    | "steam-client-reset"
    | "steam-install";
  readonly status: "PASSED" | "FAILED";
  readonly durationMs: number;
  readonly code: string;
}

export interface GodotDriverResult {
  readonly commands: readonly GodotCommandEvidence[];
  readonly harness: GodotHarnessResult | null;
  readonly exportRoot: string;
  readonly logs: string;
}

export interface GodotPlatformDriver {
  run(input: {
    readonly request: GodotTestKitRunRequest;
    readonly plan: GodotTestPlan;
    readonly workspace: string;
    readonly runRoot: string;
    readonly planPath: string;
  }): Promise<GodotDriverResult>;
}

export interface GodotProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export type GodotProcess = (
  executable: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }>,
) => Promise<GodotProcessResult>;

export class ExecFileGodotPlatformDriver implements GodotPlatformDriver {
  readonly #process: GodotProcess;
  readonly #hostEnvironment: Readonly<Record<string, string | undefined>>;

  constructor(
    process: GodotProcess = execGodotProcess,
    hostEnvironment: Readonly<Record<string, string | undefined>> = processEnv(),
  ) {
    this.#process = process;
    this.#hostEnvironment = hostEnvironment;
  }

  async run(input: {
    readonly request: GodotTestKitRunRequest;
    readonly plan: GodotTestPlan;
    readonly workspace: string;
    readonly runRoot: string;
    readonly planPath: string;
  }): Promise<GodotDriverResult> {
    await verifyGodot(input.request);
    const outputRoot = join(input.runRoot, "harness-output");
    const exportRoot = join(input.runRoot, "production-export");
    const home = join(input.runRoot, "godot-home");
    const temporary = join(input.runRoot, "godot-tmp");
    await Promise.all([
      mkdir(outputRoot, { recursive: false, mode: 0o700 }),
      mkdir(exportRoot, { recursive: false, mode: 0o700 }),
      mkdir(home, { recursive: false, mode: 0o700 }),
      mkdir(temporary, { recursive: false, mode: 0o700 }),
    ]);
    const harnessPath = join(input.runRoot, "platform-harness.gd");
    await writeImmutable(harnessPath, PLATFORM_HARNESS_GDSCRIPT);
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      HOME: home,
      USERPROFILE: home,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
      LANG: "C.UTF-8",
    };
    copyPlatformSessionEnvironment(this.#hostEnvironment, environment);
    const commands: GodotCommandEvidence[] = [];
    const logs: string[] = [];
    const run = async (
      id: GodotCommandEvidence["id"],
      executable: string,
      args: readonly string[],
      cwd: string,
      timeoutSeconds: number,
    ): Promise<GodotProcessResult> => {
      const result = await this.#process(executable, args, {
        cwd,
        env: environment,
        timeoutMs: timeoutSeconds * 1_000,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      });
      const status = result.exitCode === 0 ? "PASSED" as const : "FAILED" as const;
      commands.push(Object.freeze({ id, status, durationMs: result.durationMs, code: status === "PASSED" ? "OK" : `${id.toUpperCase().replaceAll("-", "_")}_FAILED` }));
      logs.push(commandLog(id, result));
      return result;
    };

    const imported = await run("import", input.request.godot.executable, [
      "--headless", "--path", input.workspace, "--editor", "--quit",
    ], input.workspace, input.plan.timeouts.importSeconds);
    if (imported.exitCode !== 0) return freezeResult(commands, null, exportRoot, logs);

    const booted = await run("boot", input.request.godot.executable, [
      "--headless", "--path", input.workspace, "--quit-after", "120",
    ], input.workspace, input.plan.timeouts.bootSeconds);
    if (booted.exitCode !== 0) return freezeResult(commands, null, exportRoot, logs);

    const videoPath = join(outputRoot, "video.avi");
    const suite = await run("platform-suite", input.request.godot.executable, [
      "--path", input.workspace,
      "--write-movie", videoPath,
      "--script", harnessPath,
      "--", "--plan", input.planPath, "--output", outputRoot,
    ], input.workspace, input.plan.timeouts.suiteSeconds);
    let harness: GodotHarnessResult | null = null;
    try {
      harness = parseGodotHarnessResult(
        JSON.parse(await readFile(join(outputRoot, "result.json"), "utf8")) as unknown,
        input.plan,
      );
      await verifyHarnessFiles(outputRoot, harness);
      if ((harness.status === "PASSED" && suite.exitCode !== 0) || (harness.status === "FAILED" && suite.exitCode !== 1)) {
        invalid("harness exit binding");
      }
    } catch {
      const index = commands.findIndex((item) => item.id === "platform-suite");
      commands[index] = Object.freeze({ ...commands[index]!, status: "FAILED", code: "HARNESS_RESULT_INVALID" });
      harness = null;
    }

    const platform = input.request.signedJob.payload.platform;
    const exportPath = exportDestination(exportRoot, platform);
    const exported = await run("production-export", input.request.godot.executable, [
      "--headless", "--path", input.workspace, "--export-release", exportPreset(platform), exportPath,
    ], input.workspace, input.plan.timeouts.exportSeconds);
    if (exported.exitCode === 0) {
      try {
        const executable = await exportedExecutable(exportPath, platform);
        await run("production-boot", executable, ["--headless", "--quit-after", "120"], exportRoot, input.plan.timeouts.bootSeconds);
      } catch {
        commands.push(Object.freeze({ id: "production-boot", status: "FAILED", durationMs: 0, code: "PRODUCTION_EXECUTABLE_INVALID" }));
      }
    }
    return freezeResult(commands, harness, exportRoot, logs);
  }
}

export function execGodotProcess(
  executable: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }>,
): Promise<GodotProcessResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    execFile(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
      shell: false,
    }, (error, stdout, stderr) => resolve(Object.freeze({
      exitCode: error ? (typeof (error as NodeJS.ErrnoException & { code?: number }).code === "number"
        ? (error as NodeJS.ErrnoException & { code: number }).code : 1) : 0,
      stdout: bounded(stdout),
      stderr: bounded(stderr),
      durationMs: Math.round(performance.now() - started),
    })));
  });
}

async function verifyGodot(request: GodotTestKitRunRequest): Promise<void> {
  const metadata = await lstat(request.godot.executable);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 1024 * 1024 * 1024) invalid("Godot executable");
  const file = await open(request.godot.executable, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < metadata.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.byteLength, metadata.size - position), position);
      if (bytesRead < 1) invalid("Godot executable read");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || hash.digest("hex") !== request.godot.binaryDigest) {
      invalid("Godot executable digest");
    }
  } finally { await file.close(); }
}

async function verifyHarnessFiles(root: string, result: GodotHarnessResult): Promise<void> {
  for (const screenshot of result.screenshots) {
    await verifyFile(join(root, ...screenshot.file.split("/")), screenshot.sha256, 1, 128 * 1024 * 1024);
  }
  await verifyFile(join(root, ...result.videoFile.split("/")), null, 1, 4 * 1024 * 1024 * 1024);
}

async function verifyFile(path: string, digest: string | null, minimum: number, maximum: number): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < minimum || metadata.size > maximum) invalid("harness artifact");
  if (digest !== null) {
    const observed = createHash("sha256").update(await readFile(path)).digest("hex");
    if (observed !== digest) invalid("harness artifact digest");
  }
}

async function exportedExecutable(exportPath: string, platform: GodotTestPlan["targetMatrix"][number]): Promise<string> {
  if (platform !== "macos") {
    const metadata = await lstat(exportPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1) invalid("production executable");
    if (platform === "linux" && process.platform !== "win32") await chmod(exportPath, 0o500);
    return exportPath;
  }
  const macos = join(exportPath, "Contents", "MacOS");
  const entries = (await readdir(macos, { withFileTypes: true })).filter((entry) => entry.isFile() && !entry.isSymbolicLink());
  if (entries.length !== 1) invalid("macOS production executable");
  return join(macos, entries[0]!.name);
}

function exportDestination(root: string, platform: GodotTestPlan["targetMatrix"][number]): string {
  if (platform === "windows") return join(root, "DeviLudo.exe");
  if (platform === "linux") return join(root, "DeviLudo.x86_64");
  return join(root, "DeviLudo.app");
}

function exportPreset(platform: GodotTestPlan["targetMatrix"][number]): string {
  if (platform === "windows") return "DeviLudo Windows";
  if (platform === "linux") return "DeviLudo Linux";
  return "DeviLudo macOS";
}

function freezeResult(
  commands: readonly GodotCommandEvidence[],
  harness: GodotHarnessResult | null,
  exportRoot: string,
  logs: readonly string[],
): GodotDriverResult {
  return Object.freeze({ commands: Object.freeze([...commands]), harness, exportRoot, logs: `${logs.join("\n\n")}\n` });
}

async function writeImmutable(path: string, value: string): Promise<void> {
  const file = await open(path, "wx", 0o400);
  try { await file.writeFile(value, "utf8"); await file.sync(); }
  finally { await file.close(); }
}

function commandLog(id: string, result: GodotProcessResult): string {
  return `[${id}] exit=${result.exitCode} duration_ms=${result.durationMs}\n${bounded(result.stdout)}${bounded(result.stderr)}`;
}

function bounded(value: string): string {
  return Buffer.byteLength(value) <= MAX_OUTPUT_BYTES ? value : Buffer.from(value).subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
}

function invalid(label: string): never {
  throw new Error(`Godot TestKit ${label} is invalid`);
}

// This script is materialized by the locked controller outside the project
// workspace. Project code can satisfy its published node/action contract but
// cannot replace the test loop or verdict logic.
export const PLATFORM_HARNESS_GDSCRIPT = String.raw`extends SceneTree

var plan: Dictionary
var output_root: String
var checks: Array = []
var timeline: Array = []
var screenshots: Array = []
var failed := false

func _initialize() -> void:
	call_deferred("run_suite")

func run_suite() -> void:
	var args := OS.get_cmdline_user_args()
	var plan_index := args.find("--plan")
	var output_index := args.find("--output")
	if plan_index < 0 or output_index < 0 or plan_index + 1 >= args.size() or output_index + 1 >= args.size():
		quit(2)
		return
	output_root = args[output_index + 1]
	var file := FileAccess.open(args[plan_index + 1], FileAccess.READ)
	if file == null:
		quit(2)
		return
	var parsed = JSON.parse_string(file.get_as_text())
	file.close()
	if typeof(parsed) != TYPE_DICTIONARY:
		quit(2)
		return
	plan = parsed
	DirAccess.make_dir_recursive_absolute(output_root.path_join("screenshots"))
	for scenario in plan.scenarios:
		await run_scenario(scenario)
	var performance := await measure_performance()
	if performance.averageFrameMs > float(plan.performance.maximumAverageFrameMs) or performance.p95FrameMs > float(plan.performance.maximumP95FrameMs):
		failed = true
	var result := {
		"schemaVersion": "deviludo.godot-harness-result.v1",
		"status": "FAILED" if failed else "PASSED",
		"checks": checks,
		"inputTimeline": timeline,
		"screenshots": screenshots,
		"performance": performance,
		"videoFile": "video.avi",
		"createdAt": Time.get_datetime_string_from_system(true, true),
	}
	var result_file := FileAccess.open(output_root.path_join("result.json"), FileAccess.WRITE)
	if result_file == null:
		quit(2)
		return
	result_file.store_string(JSON.stringify(result))
	result_file.close()
	quit(1 if failed else 0)

func run_scenario(scenario: Dictionary) -> void:
	var started := Time.get_ticks_msec()
	var passed := true
	var code := "OK"
	var main_scene := str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if main_scene.is_empty() or change_scene_to_file(main_scene) != OK:
		passed = false
		code = "MAIN_SCENE_LOAD_FAILED"
	else:
		await process_frame
		await process_frame
		for index in range(scenario.steps.size()):
			var step: Dictionary = scenario.steps[index]
			timeline.append({"scenarioId": scenario.id, "stepIndex": index, "kind": step.kind, "frame": Engine.get_process_frames()})
			if not await apply_step(step):
				passed = false
				code = "STEP_ASSERTION_FAILED"
				break
	for action in InputMap.get_actions():
		Input.action_release(action)
	checks.append({"id": scenario.id, "outcome": scenario.outcome, "status": "PASSED" if passed else "FAILED", "durationMs": Time.get_ticks_msec() - started, "code": code})
	if not passed:
		failed = true

func apply_step(step: Dictionary) -> bool:
	match step.kind:
		"WAIT_FRAMES":
			for frame in range(int(step.frames)):
				await process_frame
			return true
		"ACTION":
			if not InputMap.has_action(str(step.action)):
				return false
			if bool(step.pressed): Input.action_press(str(step.action))
			else: Input.action_release(str(step.action))
			for frame in range(int(step.framesAfter)):
				await process_frame
			return true
		"ASSERT_PROPERTY":
			var node := resolve_node(str(step.nodePath))
			return node != null and node.get(str(step.property)) == step.equals
		"ASSERT_GROUP_COUNT":
			var count := get_nodes_in_group(str(step.group)).size()
			return count >= int(step.minimum) and count <= int(step.maximum)
		"SCREENSHOT":
			await RenderingServer.frame_post_draw
			var viewport_texture := get_root().get_texture()
			if viewport_texture == null: return false
			var image := viewport_texture.get_image()
			if image == null or image.is_empty(): return false
			var relative := "screenshots/" + str(step.name) + ".png"
			var target := output_root.path_join(relative)
			if image.save_png(target) != OK: return false
			screenshots.append({"name": step.name, "file": relative, "sha256": FileAccess.get_sha256(target), "width": image.get_width(), "height": image.get_height()})
			return true
	return false

func resolve_node(value: String) -> Node:
	if value.begins_with("/root/"):
		return get_root().get_node_or_null(NodePath(value.trim_prefix("/root/")))
	if current_scene == null: return null
	if value == ".": return current_scene
	return current_scene.get_node_or_null(NodePath(value.trim_prefix("./")))

func measure_performance() -> Dictionary:
	for frame in range(int(plan.performance.warmupFrames)):
		await process_frame
	var samples: Array[float] = []
	for frame in range(int(plan.performance.sampleFrames)):
		var started := Time.get_ticks_usec()
		await process_frame
		samples.append(float(Time.get_ticks_usec() - started) / 1000.0)
	samples.sort()
	var total := 0.0
	for sample in samples: total += sample
	var p95_index := mini(samples.size() - 1, int(ceil(samples.size() * 0.95)) - 1)
	return {"averageFrameMs": total / samples.size(), "p95FrameMs": samples[p95_index], "sampledFrames": samples.size()}
`;

function processEnv(): Readonly<Record<string, string | undefined>> {
  return process.env;
}

function copyPlatformSessionEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  destination: NodeJS.ProcessEnv,
): void {
  for (const name of [
    "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
    "PULSE_SERVER", "PIPEWIRE_REMOTE", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
  ] as const) {
    const value = source[name];
    if (value !== undefined && value.length <= 4_096 && !/[\0\r\n]/.test(value)) destination[name] = value;
  }
}
