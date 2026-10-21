import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadMods,
  resolveModsDirectory,
} from "../../src/composition/modLoader.js";

const directories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "rea-mods-"));
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const manifest = (overrides: Record<string, unknown> = {}) => ({
  schema_version: 1,
  id: "alpha",
  name: "Alpha mod",
  version: "1.0.0",
  summary: "A fixture mod.",
  mcp: {
    transport: "stdio",
    command: "node",
    args: ["server.mjs"],
  },
  boundaries: {
    provides: ["alpha capability"],
    excludes: ["alpha non-capability"],
    authority: "fixture authority",
  },
  ...overrides,
});

const writeMod = async (
  root: string,
  directoryName: string,
  value: unknown,
): Promise<void> => {
  const directory = join(root, directoryName);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "rea.mod.json"),
    JSON.stringify(value),
    "utf8",
  );
};

describe("REA mod loader", () => {
  it("loads valid directory and file manifests and rejects invalid ones", async () => {
    const root = await temporaryDirectory();
    await writeMod(root, "alpha", manifest());
    await writeMod(root, "alpha-copy", manifest());
    await writeMod(
      root,
      "beta",
      manifest({ id: "beta", requires: ["missing"] }),
    );
    await writeMod(root, "reserved", manifest({ id: "core" }));
    await writeMod(root, "broken", { schema_version: 1, id: "broken" });
    await writeFile(
      join(root, "gamma.json"),
      JSON.stringify(manifest({ id: "gamma", name: "Gamma mod" })),
      "utf8",
    );

    const loaded = loadMods(
      { REA_MODS_DIR: root },
      new Set(["core", "native-analysis"]),
    );
    expect(loaded.mods.map(({ manifest }) => manifest.id).sort()).toEqual([
      "alpha",
      "gamma",
    ]);
    expect(loaded.errors.length).toBeGreaterThanOrEqual(4);
    const reasons = loaded.errors.map(({ reason }) => reason).join("\n");
    expect(reasons).toContain("duplicate mod id");
    expect(reasons).toContain("missing required package");
    expect(reasons).toContain("conflicts with a built-in");
    expect(reasons).toContain("boundaries");

    const alpha = loaded.mods.find(({ manifest }) => manifest.id === "alpha");
    expect(alpha?.package).toMatchObject({
      id: "alpha",
      kind: "external",
      tools: [],
      mcp: { transport: "stdio", command: "node" },
    });
    expect(alpha?.package.boundaries.authority).toBe("fixture authority");
  });

  it("drops mods whose dependency was itself dropped", async () => {
    const root = await temporaryDirectory();
    await writeMod(root, "broken", { schema_version: 1, id: "broken" });
    await writeMod(
      root,
      "dependent",
      manifest({ id: "dependent", requires: ["broken"] }),
    );
    const loaded = loadMods({ REA_MODS_DIR: root }, new Set(["core"]));
    expect(loaded.mods).toEqual([]);
    expect(loaded.errors.map(({ reason }) => reason).join("\n")).toContain(
      "missing required package",
    );
  });

  it("returns an empty result for a missing directory and resolves the default", () => {
    const root = join(tmpdir(), `rea-missing-${String(process.pid)}`);
    expect(loadMods({ REA_MODS_DIR: root }, new Set(["core"]))).toMatchObject({
      directory: root,
      mods: [],
      errors: [],
    });
    expect(resolveModsDirectory({})).toMatch(/[\\/]\.rea[\\/]mods$/u);
  });
});
