import { createHash } from "node:crypto";

const APP_ID = /^[1-9][0-9]{0,19}$/;
const BUILD_ID = /^[1-9][0-9]{0,19}$/;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 16;
const MAX_ENTRIES = 20_000;

type KeyValuesObject = ReadonlyMap<string, string | KeyValuesObject>;

export interface VerifiedSteamAppManifest {
  readonly appId: string;
  readonly buildId: string;
  readonly stateFlags: number;
  readonly installDirectoryName: string;
  readonly manifestDigest: string;
}

/**
 * Parses Steam's appmanifest_<appid>.acf as bounded KeyValues data and proves
 * that the clean client actually installed the exact authorized BuildID.
 */
export function verifySteamAppManifest(
  bytes: Buffer,
  expected: Readonly<{ appId: string; buildId: string }>,
): VerifiedSteamAppManifest {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 2 || bytes.byteLength > MAX_MANIFEST_BYTES
    || !APP_ID.test(expected.appId) || !BUILD_ID.test(expected.buildId)) invalid();
  const text = bytes.toString("utf8");
  if (Buffer.byteLength(text, "utf8") !== bytes.byteLength || text.includes("\u0000")) invalid();
  const parser = new KeyValuesParser(text);
  const document = parser.parseDocument();
  if (document.size !== 1) invalid();
  const appState = child(document, "AppState");
  const appId = scalar(appState, "appid");
  const buildId = scalar(appState, "buildid");
  const flagsText = scalar(appState, "StateFlags");
  const installDirectoryName = scalar(appState, "installdir");
  const stateFlags = Number(flagsText);
  if (appId !== expected.appId || buildId !== expected.buildId
    || !/^[0-9]{1,10}$/.test(flagsText) || !Number.isSafeInteger(stateFlags) || stateFlags > 0xffff_ffff
    || (stateFlags & 4) !== 4 || !safeInstallDirectory(installDirectoryName)) invalid();
  return Object.freeze({
    appId,
    buildId,
    stateFlags,
    installDirectoryName,
    manifestDigest: createHash("sha256").update(bytes).digest("hex"),
  });
}

class KeyValuesParser {
  #position = 0;
  #entries = 0;

  constructor(private readonly input: string) {}

  parseDocument(): KeyValuesObject {
    const result = this.#parseObject(false, 0);
    this.#skipTrivia();
    if (this.#position !== this.input.length) invalid();
    return result;
  }

  #parseObject(expectClosingBrace: boolean, depth: number): KeyValuesObject {
    if (depth > MAX_DEPTH) invalid();
    const values = new Map<string, string | KeyValuesObject>();
    const normalized = new Set<string>();
    while (true) {
      this.#skipTrivia();
      if (this.#position >= this.input.length) {
        if (expectClosingBrace) invalid();
        return values;
      }
      if (this.input[this.#position] === "}") {
        if (!expectClosingBrace) invalid();
        this.#position += 1;
        return values;
      }
      const key = this.#quoted();
      const folded = key.toLocaleLowerCase("en-US");
      if (!key || normalized.has(folded) || ++this.#entries > MAX_ENTRIES) invalid();
      normalized.add(folded);
      this.#skipTrivia();
      if (this.input[this.#position] === "{") {
        this.#position += 1;
        values.set(key, this.#parseObject(true, depth + 1));
      } else {
        values.set(key, this.#quoted());
      }
    }
  }

  #quoted(): string {
    this.#skipTrivia();
    if (this.input[this.#position] !== "\"") invalid();
    this.#position += 1;
    let result = "";
    while (this.#position < this.input.length) {
      const character = this.input[this.#position++]!;
      if (character === "\"") return result;
      if (character === "\\") {
        const escaped = this.input[this.#position++]!;
        const mapped = escaped === "\\" || escaped === "\"" ? escaped
          : escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : null;
        if (mapped === null) invalid();
        result += mapped;
      } else {
        if (character < " " || character === "\u007f") invalid();
        result += character;
      }
      if (result.length > 16_384) invalid();
    }
    invalid();
  }

  #skipTrivia(): void {
    while (this.#position < this.input.length) {
      const character = this.input[this.#position];
      if (/\s/u.test(character!)) {
        this.#position += 1;
        continue;
      }
      if (character === "/" && this.input[this.#position + 1] === "/") {
        this.#position += 2;
        while (this.#position < this.input.length && this.input[this.#position] !== "\n") this.#position += 1;
        continue;
      }
      return;
    }
  }
}

function child(value: KeyValuesObject, key: string): KeyValuesObject {
  const found = lookup(value, key);
  if (!(found instanceof Map)) invalid();
  return found;
}

function scalar(value: KeyValuesObject, key: string): string {
  const found = lookup(value, key);
  if (typeof found !== "string") invalid();
  return found;
}

function lookup(value: KeyValuesObject, key: string): string | KeyValuesObject | undefined {
  const folded = key.toLocaleLowerCase("en-US");
  for (const [candidate, item] of value) {
    if (candidate.toLocaleLowerCase("en-US") === folded) return item;
  }
  return undefined;
}

function safeInstallDirectory(value: string): boolean {
  return value.length >= 1 && value.length <= 200 && value.trim() === value
    && value !== "." && value !== ".." && !/[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(value);
}

function invalid(): never {
  throw new Error("Steam appmanifest is invalid or does not match the authorized build");
}
