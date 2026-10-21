import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

export const mcpToolSurfaceSchema = z.enum(["full", "packages"]);

export type McpToolSurface = z.infer<typeof mcpToolSurfaceSchema>;

const surfaceConstraint =
  'REA_MCP_TOOL_SURFACE must be "full" (default) or "packages". The packages surface advertises only the package gateway tools until a package is opened.';

const packagesConstraint =
  "REA_MCP_TOOL_PACKAGES must be a comma-separated list of package IDs (lowercase alphanumeric words separated by hyphens), for example core,native-analysis.";

export interface McpToolSurfaceSelection {
  readonly mode: McpToolSurface;
  /** Packages to open before the first tools/list response. */
  readonly pinned: readonly string[];
}

const parsePinned = (
  value: string | undefined,
): Result<readonly string[], ConfigurationError> => {
  if (value === undefined || value.trim().length === 0) return ok([]);
  const ids = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const invalid = ids.filter((id) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id));
  if (invalid.length > 0)
    return err(
      new ConfigurationError(packagesConstraint, {
        settings: [
          {
            setting: "REA_MCP_TOOL_PACKAGES",
            constraint: `${packagesConstraint} Invalid: ${invalid.join(", ")}.`,
          },
        ],
      }),
    );
  return ok([...new Set(ids)]);
};

/** Parse the agent-facing MCP tool surface selection. */
export const parseMcpToolSurface = (
  modeValue: string | undefined,
  packagesValue: string | undefined,
): Result<McpToolSurfaceSelection, ConfigurationError> => {
  const parsedMode = mcpToolSurfaceSchema.safeParse(modeValue ?? "full");
  if (!parsedMode.success)
    return err(
      new ConfigurationError(surfaceConstraint, {
        settings: [
          {
            setting: "REA_MCP_TOOL_SURFACE",
            constraint: surfaceConstraint,
          },
        ],
      }),
    );
  const pinned = parsePinned(packagesValue);
  return pinned.ok
    ? ok({ mode: parsedMode.data, pinned: pinned.value })
    : pinned;
};
