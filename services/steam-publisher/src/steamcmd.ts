import path from "node:path";
import type { SteamBuildSession, SteamRcArtifactClaims } from "./contracts";

export interface SteamCmdRuntimePlan {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly shell: false;
  readonly configVdfSecretRef: string;
  readonly configVdfTarget: string;
  readonly files: readonly { readonly path: string; readonly content: string; readonly mode: 0o600 }[];
}

export function buildSteamCmdRuntimePlan(input: {
  readonly executable: string;
  readonly runtimeRoot: string;
  readonly rc: SteamRcArtifactClaims;
  readonly session: SteamBuildSession;
  readonly betaBranch: string;
  readonly contentRoots: Readonly<Record<string, string>>;
}): SteamCmdRuntimePlan {
  const executable = validateAbsoluteFile(input.executable, "SteamCMD executable");
  const root = path.resolve(input.runtimeRoot);
  if (!path.isAbsolute(input.runtimeRoot) || root === path.parse(root).root) throw new Error("SteamCMD runtime root is invalid");
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(input.session.accountName)) throw new Error("Steam build account name is invalid");
  if (!/^[a-z0-9][a-z0-9_-]{2,39}$/.test(input.betaBranch) || input.betaBranch === "default" || input.betaBranch === "public") {
    throw new Error("SteamCMD SetLive branch is invalid");
  }
  if (!/^vault:\/\/[A-Za-z0-9._~:/-]{1,500}$/.test(input.session.configVdfSecretRef)) throw new Error("Steam config.vdf SecretRef is invalid");
  if (Object.keys(input.contentRoots).length !== input.rc.depots.length) throw new Error("SteamCMD content root matrix is incomplete");

  const scripts = path.join(root, "scripts");
  const output = path.join(root, "output");
  const files: Array<{ path: string; content: string; mode: 0o600 }> = [];
  const depotScriptPaths: Array<[string, string]> = [];
  for (const depot of input.rc.depots) {
    const rawContentRoot = input.contentRoots[depot.depotId];
    if (!rawContentRoot) throw new Error("SteamCMD depot content root is missing");
    const contentRoot = requireChild(root, rawContentRoot, "depot content root");
    const depotScript = path.join(scripts, `depot_${depot.depotId}.vdf`);
    files.push({
      path: depotScript,
      mode: 0o600,
      content: renderVdf("DepotBuild", {
        DepotID: depot.depotId,
        ContentRoot: contentRoot,
        FileMapping: { LocalPath: "*", DepotPath: ".", Recursive: "1" },
      }),
    });
    depotScriptPaths.push([depot.depotId, depotScript]);
  }

  const appScript = path.join(scripts, `app_${input.rc.steamAppId}_${input.rc.releaseId}.vdf`);
  files.push({
    path: appScript,
    mode: 0o600,
    content: renderVdf("AppBuild", {
      AppID: input.rc.steamAppId,
      Desc: `DeviLudo ${input.rc.releaseId} ${input.rc.mainCommitSha}`,
      BuildOutput: output,
      SetLive: input.betaBranch,
      Preview: "0",
      Depots: Object.fromEntries(depotScriptPaths),
    }),
  });
  const configVdfTarget = path.join(root, "steam", "config", "config.vdf");
  return Object.freeze({
    executable,
    args: Object.freeze(["+login", input.session.accountName, "+run_app_build", appScript, "+quit"]),
    cwd: root,
    shell: false,
    configVdfSecretRef: input.session.configVdfSecretRef,
    configVdfTarget,
    files: Object.freeze(files.map((file) => Object.freeze(file))),
  });
}

type VdfValue = string | VdfObject;
interface VdfObject { readonly [key: string]: VdfValue }

function renderVdf(root: string, value: VdfObject): string {
  return `${renderPair(root, value, 0)}\n`;
}

function renderPair(key: string, value: VdfValue, depth: number): string {
  const indentation = "  ".repeat(depth);
  const safeKey = vdfString(key);
  if (typeof value === "string") return `${indentation}"${safeKey}" "${vdfString(value)}"`;
  const children = Object.entries(value).map(([childKey, child]) => renderPair(childKey, child, depth + 1)).join("\n");
  return `${indentation}"${safeKey}"\n${indentation}{\n${children}\n${indentation}}`;
}

function vdfString(value: string): string {
  if (!value || value.length > 2_048 || /["\\\u0000-\u001f]/.test(value)) throw new Error("SteamCMD VDF value is unsafe");
  return value;
}

function validateAbsoluteFile(value: string, label: string): string {
  if (!path.isAbsolute(value) || /[\u0000-\u001f]/.test(value)) throw new Error(`${label} path is invalid`);
  return path.normalize(value);
}

function requireChild(root: string, value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new Error(`SteamCMD ${label} must be absolute`);
  const resolved = path.resolve(value);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`) || /[\u0000-\u001f]/.test(resolved)) {
    throw new Error(`SteamCMD ${label} escapes its runtime root`);
  }
  return resolved;
}
