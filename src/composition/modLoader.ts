import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  MOD_MANIFEST_FILENAME,
  modManifestSchema,
  type ModManifest,
} from "../domain/mod/modManifest.js";
import type { ToolPackageDescriptor } from "./toolPackageCatalog.js";

export interface LoadedMod {
  readonly manifest: ModManifest;
  readonly directory: string;
  readonly package: ToolPackageDescriptor;
}

export interface ModLoadError {
  readonly path: string;
  readonly reason: string;
}

export interface LoadedMods {
  readonly directory: string;
  readonly mods: readonly LoadedMod[];
  readonly errors: readonly ModLoadError[];
}

const expandHome = (value: string): string =>
  value === "~"
    ? homedir()
    : value.startsWith("~/") || value.startsWith("~\\")
      ? join(homedir(), value.slice(2))
      : value;

/** Resolve the caller-selected mods root, defaulting to `~/.rea/mods`. */
export const resolveModsDirectory = (
  environment: Readonly<Record<string, string | undefined>>,
): string => {
  const configured = environment.REA_MODS_DIR;
  return configured === undefined || configured.trim().length === 0
    ? join(homedir(), ".rea", "mods")
    : resolve(expandHome(configured));
};

const manifestError = (cause: unknown): string => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "issues" in cause &&
    Array.isArray(cause.issues)
  )
    return cause.issues
      .map((issue: unknown) => {
        if (typeof issue !== "object" || issue === null) return String(issue);
        const path =
          "path" in issue && Array.isArray(issue.path)
            ? issue.path.join(".")
            : "";
        const message = "message" in issue ? String(issue.message) : "invalid";
        return path.length === 0 ? message : `${path}: ${message}`;
      })
      .join("; ");
  return cause instanceof Error ? cause.message : String(cause);
};

const readManifest = (
  path: string,
): { readonly manifest: ModManifest } | { readonly error: string } => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const result = modManifestSchema.safeParse(parsed);
    return result.success
      ? { manifest: result.data }
      : { error: manifestError(result.error) };
  } catch (cause: unknown) {
    return { error: manifestError(cause) };
  }
};

const modPackage = (
  manifest: ModManifest,
  directory: string,
): ToolPackageDescriptor => ({
  id: manifest.id,
  title: manifest.name,
  summary: manifest.summary,
  kind: "external",
  requires: manifest.requires,
  boundaries: manifest.boundaries,
  tools: [],
  profiles: manifest.profiles,
  usage: manifest.usage ?? null,
  evidence:
    manifest.evidence ??
    "This mod's results are external observations. REA proxies them and does not claim they are REA Evidence.",
  mcp: manifest.mcp,
  mod: { directory, version: manifest.version },
});

interface Candidate {
  readonly manifest: ModManifest;
  readonly directory: string;
}

/**
 * Discover Fabric-style mod manifests under the caller-selected directory.
 * Loading a manifest does not start its MCP server; that happens on package
 * open. Invalid manifests, duplicate IDs, and unresolved dependencies are
 * reported and dropped without preventing the host from starting.
 */
export const loadMods = (
  environment: Readonly<Record<string, string | undefined>>,
  reservedIds: ReadonlySet<string>,
): LoadedMods => {
  const directory = resolveModsDirectory(environment);
  if (!existsSync(directory)) return { directory, mods: [], errors: [] };

  const errors: ModLoadError[] = [];
  const candidates: Candidate[] = [];
  let entries: readonly {
    name: string;
    path: string;
    isDirectory: boolean;
  }[];
  try {
    const discovered: {
      name: string;
      path: string;
      isDirectory: boolean;
    }[] = [];
    for (const entry of readdirSync(directory, {
      withFileTypes: true,
    }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory())
        discovered.push({
          name: entry.name,
          path: join(path, MOD_MANIFEST_FILENAME),
          isDirectory: true,
        });
      else if (entry.isFile() && entry.name.endsWith(".json"))
        discovered.push({ name: entry.name, path, isDirectory: false });
    }
    entries = discovered;
  } catch (cause: unknown) {
    return {
      directory,
      mods: [],
      errors: [{ path: directory, reason: manifestError(cause) }],
    };
  }

  const seen = new Map<string, string>();
  for (const entry of entries) {
    if (!existsSync(entry.path)) continue;
    try {
      if (!statSync(entry.path).isFile()) continue;
    } catch (cause: unknown) {
      errors.push({ path: entry.path, reason: manifestError(cause) });
      continue;
    }
    const loaded = readManifest(entry.path);
    if ("error" in loaded) {
      errors.push({ path: entry.path, reason: loaded.error });
      continue;
    }
    const manifest = loaded.manifest;
    if (reservedIds.has(manifest.id)) {
      errors.push({
        path: entry.path,
        reason: `mod id "${manifest.id}" conflicts with a built-in tool package`,
      });
      continue;
    }
    const previous = seen.get(manifest.id);
    if (previous !== undefined) {
      errors.push({
        path: entry.path,
        reason: `duplicate mod id "${manifest.id}" (already loaded from ${previous})`,
      });
      continue;
    }
    seen.set(manifest.id, entry.path);
    candidates.push({
      manifest,
      directory: entry.isDirectory ? dirname(entry.path) : directory,
    });
  }

  // Drop mods whose declared dependencies are neither built-in packages nor
  // other loadable mods. Repeat because one dropped mod may orphan another.
  let surviving = candidates;
  for (;;) {
    const available = new Set<string>([
      ...reservedIds,
      ...surviving.map(({ manifest }) => manifest.id),
    ]);
    const next = surviving.filter(({ manifest, directory: modDirectory }) => {
      const missing = manifest.requires.filter((id) => !available.has(id));
      if (missing.length === 0) return true;
      errors.push({
        path: join(modDirectory, MOD_MANIFEST_FILENAME),
        reason: `missing required package(s): ${missing.join(", ")}`,
      });
      return false;
    });
    if (next.length === surviving.length) break;
    surviving = next;
  }

  return {
    directory,
    mods: surviving.map(({ manifest, directory: modDirectory }) => ({
      manifest,
      directory: modDirectory,
      package: modPackage(manifest, modDirectory),
    })),
    errors,
  };
};

/** Resolve one stdio mod's working directory against its manifest directory. */
export const resolveModWorkingDirectory = (
  loaded: LoadedMod,
  configured: string | undefined,
): string | undefined =>
  configured === undefined
    ? undefined
    : isAbsolute(configured)
      ? configured
      : resolve(loaded.directory, configured);
