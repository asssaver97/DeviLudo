import { generateKeyPairSync } from "node:crypto";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";

const directory = new URL("../.deviludo/local/", import.meta.url);
const privateKey = new URL("executor-ed25519.pem", directory);
const publicKey = new URL("executor-ed25519.pub", directory);
const e2ePrivateKey = new URL("e2e-macos-ed25519.pem", directory);
const e2ePublicKey = new URL("e2e-macos-ed25519.pub", directory);
const s3Credentials = new URL("s3.credentials", directory);
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
try {
  await access(privateKey);
} catch {
  const pair = generateKeyPairSync("ed25519");
  await writeFile(privateKey, pair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  await writeFile(publicKey, pair.publicKey.export({ format: "pem", type: "spki" }), { mode: 0o644 });
}
await chmod(privateKey, 0o600);
try {
  await access(e2ePrivateKey);
} catch {
  const pair = generateKeyPairSync("ed25519");
  await writeFile(e2ePrivateKey, pair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  await writeFile(e2ePublicKey, pair.publicKey.export({ format: "pem", type: "spki" }), { mode: 0o644 });
}
await chmod(e2ePrivateKey, 0o600);
await writeFile(s3Credentials, "[default]\naws_access_key_id=deviludo-local\naws_secret_access_key=deviludo-local-secret\n", { mode: 0o600 });
await chmod(s3Credentials, 0o600);
