#!/usr/bin/env node
import { chmod, chown, mkdir } from "node:fs/promises";

const root = "/var/lib/deviludo-runtime";
await mkdir(root, { recursive: true, mode: 0o700 });
await chown(root, 10001, 10001);
await chmod(root, 0o700);
