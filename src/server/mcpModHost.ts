import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import type {
  CallToolResult,
  RegisteredTool,
  StandardSchemaWithJSON,
  ToolCallback,
} from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";

import type { LoadedMod } from "../composition/modLoader.js";
import { resolveModWorkingDirectory } from "../composition/modLoader.js";
import type { ModMcpTransport } from "../domain/mod/modManifest.js";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import type { Logger } from "pino";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

export interface ModToolInfo {
  readonly publicName: string;
  readonly rawName: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
}

interface ModConnection {
  readonly mod: LoadedMod;
  readonly client: Client;
  readonly transport: StdioClientTransport | StreamableHTTPClientTransport;
  tools: readonly ModToolInfo[];
  handles: readonly RegisteredTool[];
}

const MAX_TOOL_NAME_LENGTH = 64;

/** Stable, collision-resistant public name for one proxied mod tool. */
export const modToolPublicName = (
  modId: string,
  prefix: string | undefined,
  rawName: string,
): string => {
  const joined = `mod__${prefix ?? modId}__${rawName}`;
  const normalized = joined.replace(/[^A-Za-z0-9_-]/gu, "_");
  if (normalized === joined && normalized.length <= MAX_TOOL_NAME_LENGTH)
    return normalized;
  const hash = createHash("sha256")
    .update(`${modId}\0${rawName}`)
    .digest("hex")
    .slice(0, 12);
  return `${normalized.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
};

const passthroughInputSchema = (
  schema: Record<string, unknown> | undefined,
): StandardSchemaWithJSON => {
  const advertised =
    schema === undefined
      ? { type: "object" }
      : schema.type === undefined
        ? { type: "object", ...schema }
        : schema;
  return {
    "~standard": {
      version: 1,
      vendor: "rea-mod",
      validate: (value: unknown) => ({ value }),
      jsonSchema: {
        input: () => advertised,
        output: () => advertised,
      },
    },
  } as StandardSchemaWithJSON;
};

const passthroughOutputSchema = (
  schema: Record<string, unknown>,
): StandardSchemaWithJSON =>
  ({
    "~standard": {
      version: 1,
      vendor: "rea-mod",
      validate: (value: unknown) => ({ value }),
      jsonSchema: {
        input: () => ({ type: "object" }),
        output: () => schema,
      },
    },
  }) as StandardSchemaWithJSON;

const transportFor = (
  mod: LoadedMod,
  mcp: ModMcpTransport,
): StdioClientTransport | StreamableHTTPClientTransport => {
  if (mcp.transport === "stdio") {
    // Default to the host's working directory. Relative manifest paths resolve
    // against the mod directory, but an inherited cwd keeps Windows from
    // locking the mod's own directory while its server runs.
    const cwd = resolveModWorkingDirectory(mod, mcp.cwd);
    return new StdioClientTransport({
      command: mcp.command,
      args: [...mcp.args],
      env: { ...getDefaultEnvironment(), ...mcp.env },
      stderr: "pipe",
      ...(cwd === undefined ? {} : { cwd }),
    });
  }
  return new StreamableHTTPClientTransport(new URL(mcp.url), {
    requestInit: {
      redirect: "error",
      headers: mcp.headers,
    },
  });
};

const cleanup = async (
  client: Client,
  transport: StdioClientTransport | StreamableHTTPClientTransport,
): Promise<void> => {
  const results = await Promise.allSettled([client.close(), transport.close()]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0)
    throw new AggregateError(failures, "Mod MCP connection cleanup failed");
};

/**
 * Hosts Fabric-style MCP mods for one REA server. Opening a mod connects its
 * MCP server, discovers tools, and registers namespaced proxy tools on the REA
 * MCP surface; closing removes them and releases the child process.
 */
export class McpModHost {
  private readonly connections = new Map<string, ModConnection>();
  private readonly closing = new Map<string, Promise<void>>();

  constructor(
    private readonly server: EvidenceMcpServer,
    private readonly logger: Logger,
  ) {}

  isOpen(modId: string): boolean {
    return this.connections.has(modId);
  }

  toolsFor(modId: string): readonly ModToolInfo[] {
    return this.connections.get(modId)?.tools ?? [];
  }

  async open(
    mod: LoadedMod,
    signal?: AbortSignal,
  ): Promise<readonly ModToolInfo[]> {
    const existing = this.connections.get(mod.manifest.id);
    if (existing !== undefined) return existing.tools;
    const pendingClose = this.closing.get(mod.manifest.id);
    if (pendingClose !== undefined) await pendingClose;

    const client = new Client({
      name: `rea-mod-${mod.manifest.id}`,
      version: "1",
    });
    const transport = transportFor(mod, mod.manifest.mcp);
    if (transport instanceof StdioClientTransport)
      transport.stderr?.on("data", (chunk: unknown) => {
        this.logger.debug(
          { mod: mod.manifest.id, stderr: String(chunk) },
          "Mod MCP server stderr",
        );
      });

    try {
      await client.connect(transport, signal === undefined ? {} : { signal });
      const listing = await client.listTools(
        {},
        {
          ...(signal === undefined ? {} : { signal }),
          cacheMode: "bypass",
        },
      );
      const tools = listing.tools.map((tool) => this.describeTool(mod, tool));
      const connection: ModConnection = {
        mod,
        client,
        transport,
        tools,
        handles: [],
      };
      const handles = this.registerTools(connection, tools);
      const live: ModConnection = { ...connection, handles };
      this.connections.set(mod.manifest.id, live);
      client.setNotificationHandler("notifications/tools/list_changed", () => {
        void this.resync(mod.manifest.id).catch((cause: unknown) => {
          this.logger.warn(
            {
              mod: mod.manifest.id,
              error: cause instanceof Error ? cause.message : String(cause),
            },
            "Mod tool list changed but resynchronization failed",
          );
        });
      });
      return tools;
    } catch (cause: unknown) {
      try {
        await cleanup(client, transport);
      } catch (cleanupCause: unknown) {
        throw new AggregateError(
          [cause, cleanupCause],
          `Mod ${mod.manifest.id} failed to start and cleanup also failed`,
        );
      }
      throw new AnalysisCapabilityUnavailableError(
        mod.manifest.id,
        "open_tool_package",
        cause instanceof Error ? cause.message : String(cause),
        {
          cause,
          userMessage: `Mod "${mod.manifest.id}" could not start its MCP server.`,
          retryable: true,
        },
      );
    }
  }

  async close(modId: string): Promise<void> {
    const connection = this.connections.get(modId);
    if (connection === undefined) return;
    const pending = this.closing.get(modId);
    if (pending !== undefined) return pending;
    this.connections.delete(modId);
    const operation = (async () => {
      for (const handle of connection.handles) handle.remove();
      await cleanup(connection.client, connection.transport);
    })();
    this.closing.set(modId, operation);
    try {
      await operation;
    } finally {
      this.closing.delete(modId);
    }
  }

  async closeAll(): Promise<void> {
    const ids = [...this.connections.keys()];
    const results = await Promise.allSettled(ids.map((id) => this.close(id)));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(failures, "Mod MCP cleanup failed");
  }

  private describeTool(
    mod: LoadedMod,
    tool: {
      readonly name: string;
      readonly description?: string | undefined;
      readonly inputSchema: unknown;
      readonly outputSchema?: unknown;
    },
  ): ModToolInfo {
    const inputSchema =
      typeof tool.inputSchema === "object" && tool.inputSchema !== null
        ? (tool.inputSchema as Record<string, unknown>)
        : { type: "object" };
    const outputSchema =
      typeof tool.outputSchema === "object" && tool.outputSchema !== null
        ? (tool.outputSchema as Record<string, unknown>)
        : undefined;
    return {
      publicName: modToolPublicName(
        mod.manifest.id,
        mod.manifest.tools.prefix,
        tool.name,
      ),
      rawName: tool.name,
      title: `${mod.manifest.name}: ${tool.name}`,
      description:
        `[mod ${mod.manifest.id}] ${tool.description ?? "MCP mod tool."}`.trim(),
      inputSchema,
      ...(outputSchema === undefined ? {} : { outputSchema }),
    };
  }

  private registerTools(
    connection: ModConnection,
    tools: readonly ModToolInfo[],
  ): readonly RegisteredTool[] {
    const handles: RegisteredTool[] = [];
    try {
      for (const tool of tools) {
        const callback = (async (
          args: unknown,
          context: { readonly mcpReq: { readonly signal: AbortSignal } },
        ): Promise<CallToolResult> => {
          const result = await connection.client.callTool(
            {
              name: tool.rawName,
              arguments: (args ?? {}) as Record<string, unknown>,
            },
            {
              signal: context.mcpReq.signal,
              timeout: connection.mod.manifest.mcp.timeout_ms,
            },
          );
          return result as CallToolResult;
        }) as ToolCallback<StandardSchemaWithJSON | undefined>;
        handles.push(
          this.server.registerTool(
            tool.publicName,
            {
              title: tool.title,
              description: tool.description,
              inputSchema: passthroughInputSchema(tool.inputSchema),
              ...(tool.outputSchema === undefined
                ? {}
                : {
                    outputSchema: passthroughOutputSchema(tool.outputSchema),
                  }),
              annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: true,
              },
            },
            callback,
          ),
        );
      }
      return handles;
    } catch (cause: unknown) {
      for (const handle of handles) handle.remove();
      throw cause;
    }
  }

  private async resync(modId: string): Promise<void> {
    const connection = this.connections.get(modId);
    if (connection === undefined) return;
    const listing = await connection.client.listTools(
      {},
      { cacheMode: "bypass" },
    );
    const tools = listing.tools.map((tool) =>
      this.describeTool(connection.mod, tool),
    );
    for (const handle of connection.handles) handle.remove();
    const handles = this.registerTools({ ...connection, handles: [] }, tools);
    this.connections.set(modId, { ...connection, tools, handles });
  }
}
