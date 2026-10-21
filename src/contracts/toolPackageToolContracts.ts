import { z } from "zod";

import { lifecycleResultOf } from "./toolOutputSchemaPrimitives.js";
import { examplesFor } from "./toolContractHelpers.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";

/** Stable package identifier: lowercase words separated by single hyphens. */
export const toolPackageIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u,
    "package_id must be lowercase alphanumeric words separated by hyphens",
  )
  .describe(
    "Stable tool-package identifier from list_tool_packages, for example native-analysis or vmp.",
  );

export const toolPackageKindSchema = z
  .enum(["core", "family", "provider", "external"])
  .describe(
    "Package kind: core lifecycle, internal tool family, analysis provider profile, or external toolkit.",
  );

const toolPackageSummarySchema = z.object({
  id: toolPackageIdSchema,
  title: z.string(),
  kind: toolPackageKindSchema,
  summary: z.string(),
  tool_count: z.number().int().min(0),
  profile_count: z.number().int().min(0),
  open: z.boolean(),
});

const toolPackageBoundariesSchema = z.object({
  provides: z.array(z.string()),
  excludes: z.array(z.string()),
  authority: z.string(),
  prerequisites: z.array(z.string()),
});

const toolPackageOperationSchema = z.object({
  name: z.string(),
  title: z.string(),
  summary: z.string(),
  description: z.string().optional(),
});

const toolPackageProfileSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
});

const toolPackageDetailSchema = toolPackageSummarySchema.extend({
  requires: z.array(toolPackageIdSchema),
  boundaries: toolPackageBoundariesSchema,
  operations: z.array(toolPackageOperationSchema),
  profiles: z.array(toolPackageProfileSchema),
  usage: z.string().nullable(),
  evidence: z.string(),
});

export const listToolPackagesInputSchema = z.strictObject({
  kind: toolPackageKindSchema.optional(),
});

export const inspectToolPackageInputSchema = z.strictObject({
  package_id: toolPackageIdSchema,
  detail: z
    .enum(["summary", "full"])
    .default("summary")
    .describe(
      "summary returns one sentence per operation; full returns complete canonical tool descriptions.",
    ),
});

export const openToolPackageInputSchema = z.strictObject({
  package_id: toolPackageIdSchema,
});

export const closeToolPackageInputSchema = z.strictObject({
  package_id: toolPackageIdSchema,
});

const listToolPackagesResultSchema = z.object({
  surface: z.enum(["full", "packages"]),
  packages: z.array(toolPackageSummarySchema),
});

const inspectToolPackageResultSchema = z.object({
  package: toolPackageDetailSchema,
});

const openToolPackageResultSchema = z.object({
  package_id: toolPackageIdSchema,
  kind: toolPackageKindSchema,
  status: z.enum(["opened", "already-open", "external", "full-surface"]),
  enabled_tools: z.array(z.string()),
  dependency_packages: z.array(toolPackageIdSchema),
  tools_changed: z.boolean(),
  usage: z.string().nullable(),
});

const closeToolPackageResultSchema = z.object({
  package_id: toolPackageIdSchema,
  kind: toolPackageKindSchema,
  status: z.enum(["closed", "not-open", "external", "full-surface"]),
  disabled_tools: z.array(z.string()),
  still_enabled: z.array(z.string()),
  tools_changed: z.boolean(),
});

const packageTool = <
  Name extends string,
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodObject,
>(
  name: Name,
  description: string,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
) =>
  ({
    name,
    ...toolContractMetadata(name),
    description,
    // Package-surface tools are session-scoped but registered only on the
    // long-lived MCP adapter, like other session tools.
    kind: "session",
    inputSchema,
    outputSchema,
    examples: examplesFor(name, inputSchema),
  }) satisfies ToolContract<Name, InputSchema, OutputSchema>;

/** Progressive-disclosure package surface for agent MCP sessions. */
export const TOOL_PACKAGE_TOOL_CONTRACTS = [
  packageTool(
    "list_tool_packages",
    "List tool packages as compact summaries: id, title, kind, one-line purpose, tool count, profile count, and open state. This is the progressive-disclosure index; it intentionally omits concrete operation schemas and package boundaries. Call inspect_tool_package for one package's boundaries and operations, then open_tool_package to enable its advertised tools. External packages describe toolkits that REA does not drive.",
    listToolPackagesInputSchema,
    lifecycleResultOf(listToolPackagesResultSchema),
  ),
  packageTool(
    "inspect_tool_package",
    "Return one tool package's boundaries (provides, excludes, authority, prerequisites), profiles, and operations. detail=summary (default) returns a one-sentence summary for each operation; detail=full returns complete canonical tool descriptions. Inspection does not enable tools, start analysis, or contact an external toolkit. External package usage describes where that toolkit's own concrete interface lives.",
    inspectToolPackageInputSchema,
    lifecycleResultOf(inspectToolPackageResultSchema),
  ),
  packageTool(
    "open_tool_package",
    "Enable one package's advertised MCP tools in this session and request a tools/list change. Required lifecycle packages open first. Opening an external package returns its usage and enables no REA tools. Already-open packages report already-open. Unknown package identifiers are rejected with a typed input error.",
    openToolPackageInputSchema,
    lifecycleResultOf(openToolPackageResultSchema),
  ),
  packageTool(
    "close_tool_package",
    "Hide one package's MCP tools again unless another open package still owns them. Required lifecycle packages remain open until explicitly closed. External packages need no close. Closing a package never closes the active target or discards Evidence.",
    closeToolPackageInputSchema,
    lifecycleResultOf(closeToolPackageResultSchema),
  ),
] as const satisfies readonly ToolContract[];
