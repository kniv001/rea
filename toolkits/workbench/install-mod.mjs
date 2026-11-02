#!/usr/bin/env node
/**
 * Install the workbench mod into REA's mod directory.
 *
 * Usage: node install-mod.mjs [--force] [--dir <mods-dir>]
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (flag("--help") || flag("-h")) {
  process.stdout.write(
    "Usage: node install-mod.mjs [--force] [--dir <mods-dir>]\n",
  );
  process.exit(0);
}

const modsDir = resolve(
  option("--dir") ||
    process.env.REA_MODS_DIR ||
    join(homedir(), ".rea", "mods"),
);
const target = join(modsDir, "workbench");

if (existsSync(target)) {
  if (!flag("--force")) {
    process.stderr.write(
      `target already exists: ${target}\nPass --force to replace it.\n`,
    );
    process.exit(1);
  }
  rmSync(target, { recursive: true, force: true });
}

mkdirSync(target, { recursive: true });
for (const name of ["server.mjs", "rea.mod.json", "README.md"]) {
  cpSync(join(source, name), join(target, name));
}
cpSync(join(source, "guest"), join(target, "guest"), { recursive: true });

process.stdout.write(`installed ${target}\n`);
process.stdout.write(
  "\nRestart REA, then in a package-surface session run:\n" +
    "  list_tool_packages\n" +
    '  open_tool_package { "package_id": "workbench" }\n' +
    "The proxied tools appear as mod__workbench__status, mod__workbench__start, ...\n",
);
