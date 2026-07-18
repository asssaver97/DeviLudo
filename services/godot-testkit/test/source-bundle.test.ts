import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import { createEvidencePackage } from "../src/evidence-package";
import { extractSourceBundle } from "../src/source-bundle";
import { createSourceBundle } from "../src/source-bundle-builder";

test("source bundle builder creates deterministic extractable archives from one safe snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-source-builder-"));
  try {
    const source = join(root, "source");
    await mkdir(join(source, "scripts"), { recursive: true });
    await Promise.all([
      writeFile(join(source, "project.godot"), "config_version=5\n[application]\nconfig/name=\"Fixture\"\n"),
      writeFile(join(source, "scripts", "main.gd"), "extends Node\n"),
    ]);
    if (process.platform !== "win32") await chmod(join(source, "scripts", "main.gd"), 0o700);
    const firstPath = join(root, "first.tar.zst");
    const secondPath = join(root, "second.tar.zst");
    const first = await createSourceBundle(source, firstPath);
    const second = await createSourceBundle(source, secondPath);
    assert.deepEqual(first, second);
    assert.deepEqual(await readFile(firstPath), await readFile(secondPath));
    const destination = join(root, "extracted");
    assert.deepEqual(await extractSourceBundle(firstPath, destination), { files: 2, directories: 0, totalBytes: 66 });
    assert.equal(await readFile(join(destination, "scripts", "main.gd"), "utf8"), "extends Node\n");
    if (process.platform !== "win32") assert.notEqual((await lstat(join(destination, "scripts", "main.gd"))).mode & 0o111, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source bundle builder rejects SCM snapshots containing links or repository metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-source-builder-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "project.godot"), "config_version=5\nconfig-data");
    await symlink(join(source, "project.godot"), join(source, "linked.godot"));
    await assert.rejects(createSourceBundle(source, join(root, "linked.tar.zst")), /source symlink/);
    await rm(join(source, "linked.godot"));
    await mkdir(join(source, ".git"));
    await assert.rejects(createSourceBundle(source, join(root, "git.tar.zst")), /source path/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source bundle extracts only the fixed Zstandard USTAR subset", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-source-bundle-"));
  try {
    const archive = join(root, "source.tar.zst");
    await writeFile(archive, sourceBundle([
      { name: "project.godot", body: Buffer.from("config_version=5\n[application]\nconfig/name=\"Fixture\"\n") },
      { name: "scripts/main.gd", body: Buffer.from("extends Node\n") },
    ]));
    const destination = join(root, "workspace");
    assert.deepEqual(await extractSourceBundle(archive, destination), { files: 2, directories: 0, totalBytes: 66 });
    assert.equal(await readFile(join(destination, "scripts/main.gd"), "utf8"), "extends Node\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source bundle rejects traversal, links, duplicate paths and malformed checksums", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-source-bundle-"));
  try {
    const cases = [
      [{ name: "../escape", body: Buffer.from("bad") }],
      [{ name: ".git/config", body: Buffer.from("bad") }],
      [{ name: "project.godot", body: Buffer.from("config_version=5\nconfig-data") }, { name: "project.godot", body: Buffer.from("again") }],
      [{ name: "project.godot", body: Buffer.from("config_version=5\nconfig-data"), type: "2" }],
    ] as const;
    for (let index = 0; index < cases.length; index += 1) {
      const archive = join(root, `bad-${index}.tar.zst`);
      await writeFile(archive, sourceBundle(cases[index]));
      await assert.rejects(extractSourceBundle(archive, join(root, `out-${index}`)), /invalid/);
    }
    const corrupt = rawTar([{ name: "project.godot", body: Buffer.from("config_version=5\nconfig-data") }]);
    corrupt[0] = 0x78;
    const archive = join(root, "checksum.tar.zst");
    await writeFile(archive, zstdCompressSync(corrupt));
    await assert.rejects(extractSourceBundle(archive, join(root, "checksum")), /invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("evidence package is deterministic, ordered and content-bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-evidence-package-"));
  try {
    const source = join(root, "frame.png");
    await writeFile(source, "png-bytes");
    const entries = [
      { name: "manifest.json", body: Buffer.from('{"schemaVersion":1}') },
      { name: "screenshots/frame.png", sourcePath: source },
    ] as const;
    const first = await createEvidencePackage(join(root, "one.tar"), entries);
    const second = await createEvidencePackage(join(root, "two.tar"), entries);
    assert.deepEqual(first, second);
    assert.deepEqual(await readFile(join(root, "one.tar")), await readFile(join(root, "two.tar")));
    await assert.rejects(createEvidencePackage(join(root, "bad.tar"), [...entries].reverse()), /ordering/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

type TarEntry = Readonly<{ name: string; body: Buffer; type?: string }>;

function sourceBundle(entries: readonly TarEntry[]): Buffer {
  return zstdCompressSync(rawTar(entries));
}

function rawTar(entries: readonly TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    octal(header, 100, 8, 0o600);
    octal(header, 108, 8, 0);
    octal(header, 116, 8, 0);
    octal(header, 124, 12, entry.body.byteLength);
    octal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    header.write("ustar", 257, "ascii");
    header.write("00", 263, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    const encoded = checksum.toString(8).padStart(6, "0");
    header.write(encoded, 148, "ascii");
    header[154] = 0;
    header[155] = 32;
    chunks.push(header, entry.body);
    const padding = (512 - (entry.body.byteLength % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function octal(target: Buffer, offset: number, length: number, value: number): void {
  target.write(value.toString(8).padStart(length - 1, "0"), offset, length - 1, "ascii");
  target[offset + length - 1] = 0;
}

export { sourceBundle };
