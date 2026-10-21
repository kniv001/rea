import { z } from "zod";

/** Conventional manifest file name inside one mod directory. */
export const MOD_MANIFEST_FILENAME = "rea.mod.json";

/** Stable mod/package identifier. */
export const modIdSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u,
    "mod id must be lowercase alphanumeric words separated by hyphens",
  );

const stdioTransportSchema = z.strictObject({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().min(1).optional(),
  timeout_ms: z.number().int().min(1).max(2_147_483_647).default(60_000),
});

const streamableHttpTransportSchema = z.strictObject({
  transport: z.literal("streamable-http"),
  url: z.url(),
  headers: z.record(z.string(), z.string()).default({}),
  timeout_ms: z.number().int().min(1).max(2_147_483_647).default(60_000),
});

/** How REA starts or reaches one mod's MCP server. */
export const modMcpTransportSchema = z.discriminatedUnion("transport", [
  stdioTransportSchema,
  streamableHttpTransportSchema,
]);

export type ModMcpTransport = z.infer<typeof modMcpTransportSchema>;

const boundariesSchema = z.strictObject({
  provides: z.array(z.string().min(1)).min(1),
  excludes: z.array(z.string().min(1)).min(1),
  authority: z.string().min(1),
  prerequisites: z.array(z.string().min(1)).default([]),
});

const profileSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  title: z.string().min(1),
  summary: z.string().min(1),
});

/**
 * One Fabric-style mod manifest (`rea.mod.json`). The mod's MCP server is the
 * mod entrypoint; REA discovers its tools only when the package is opened.
 */
export const modManifestSchema = z.strictObject({
  schema_version: z.literal(1),
  id: modIdSchema,
  name: z.string().min(1),
  version: z.string().min(1),
  summary: z.string().min(1),
  requires: z.array(modIdSchema).default([]),
  mcp: modMcpTransportSchema,
  boundaries: boundariesSchema,
  profiles: z.array(profileSchema).default([]),
  usage: z.string().min(1).optional(),
  evidence: z.string().min(1).optional(),
  tools: z
    .strictObject({
      prefix: z
        .string()
        .min(1)
        .max(30)
        .regex(/^[A-Za-z0-9_-]+$/u)
        .optional(),
    })
    .default({}),
});

export type ModManifest = z.infer<typeof modManifestSchema>;
