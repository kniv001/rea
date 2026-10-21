import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, onTestFinished } from "vitest";

import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

const fixtureServer = fileURLToPath(
  new URL("../../fixtures/fakeModMcpServer.mjs", import.meta.url),
);

const manifest = (timeoutMs = 2_000) => ({
  schema_version: 1,
  id: "fake-mod",
  name: "Fake MCP mod",
  version: "1.0.0",
  summary: "A test-only MCP mod.",
  mcp: {
    transport: "stdio",
    command: process.execPath,
    args: [fixtureServer],
    timeout_ms: timeoutMs,
  },
  boundaries: {
    provides: ["echo and delayed responses"],
    excludes: ["real analysis"],
    authority: "test fixture",
    prerequisites: ["Node.js"],
  },
  profiles: [{ id: "test", title: "Test profile", summary: "A test profile." }],
  usage: "Open this package to start the fixture MCP server.",
});

const createModsDirectory = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "rea-mod-surface-"));
  const directory = join(root, "fake-mod");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "rea.mod.json"),
    JSON.stringify(manifest()),
    "utf8",
  );
  return root;
};

const connect = async (
  mode: "packages" | "full",
): Promise<{
  readonly client: Client;
  readonly toolNames: () => Promise<readonly string[]>;
}> => {
  const root = await createModsDirectory();
  const server = createServer(
    {
      kind: "session",
      session: createTestBinarySession({
        identity: () => ({ id: "fixture", name: "Fixture", version: "1" }),
        capabilities: () => [],
        createClient: () => ({
          execute: () => Promise.resolve({ ok: true, value: null }),
        }),
      } as never),
    },
    {
      loadMods: true,
      environment: {
        ...process.env,
        REA_MCP_TOOL_SURFACE: mode,
        REA_MODS_DIR: root,
      },
    },
  );
  const client = new Client({ name: "mod-surface-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    toolNames: async () =>
      (await client.listTools()).tools.map(({ name }) => name).sort(),
  };
};

describe("MCP mod packages", () => {
  it("loads a mod on open and proxies its tools", async () => {
    const { client, toolNames } = await connect("packages");
    expect(await toolNames()).toEqual([
      "close_tool_package",
      "inspect_tool_package",
      "list_tool_packages",
      "open_tool_package",
    ]);

    const index = await client.callTool({
      name: "list_tool_packages",
      arguments: { kind: "external" },
    });
    const packages = (
      index.structuredContent as {
        result: { packages: { id: string }[] };
      }
    ).result.packages;
    expect(packages.find(({ id }) => id === "fake-mod")).toMatchObject({
      title: "Fake MCP mod",
      tool_count: 0,
      open: false,
    });

    const inspected = await client.callTool({
      name: "inspect_tool_package",
      arguments: { package_id: "fake-mod" },
    });
    expect(inspected.structuredContent).toMatchObject({
      result: {
        package: {
          kind: "external",
          profiles: [{ id: "test" }],
          operations: [],
          usage: "Open this package to start the fixture MCP server.",
        },
      },
    });

    const opened = await client.callTool({
      name: "open_tool_package",
      arguments: { package_id: "fake-mod" },
    });
    expect(opened.structuredContent).toMatchObject({
      result: {
        package_id: "fake-mod",
        status: "opened",
        tools_changed: true,
      },
    });
    expect(await toolNames()).toEqual(
      expect.arrayContaining(["mod__fake-mod__echo", "mod__fake-mod__slow"]),
    );

    const echoed = await client.callTool({
      name: "mod__fake-mod__echo",
      arguments: { text: "hello" },
    });
    expect(echoed.structuredContent).toEqual({ text: "hello" });

    const invalid = await client.callTool({
      name: "mod__fake-mod__echo",
      arguments: {},
    });
    expect(invalid.isError).toBe(true);

    const closed = await client.callTool({
      name: "close_tool_package",
      arguments: { package_id: "fake-mod" },
    });
    expect(closed.structuredContent).toMatchObject({
      result: {
        status: "closed",
        disabled_tools: expect.arrayContaining([
          "mod__fake-mod__echo",
          "mod__fake-mod__slow",
        ]),
      },
    });
    expect(await toolNames()).not.toContain("mod__fake-mod__echo");
    const disconnected = await client
      .callTool({ name: "mod__fake-mod__echo", arguments: { text: "x" } })
      .then(
        () => null,
        (cause: unknown) => cause,
      );
    expect(disconnected).not.toBeNull();
    expect(String(disconnected)).toMatch(/disabled|not found/iu);
  });

  it("connects a mod from full mode without hiding hosted tools", async () => {
    const { client, toolNames } = await connect("full");
    const opened = await client.callTool({
      name: "open_tool_package",
      arguments: { package_id: "fake-mod" },
    });
    expect(opened.structuredContent).toMatchObject({
      result: { status: "opened", tools_changed: true },
    });
    expect(await toolNames()).toEqual(
      expect.arrayContaining(["mod__fake-mod__echo", "open_binary"]),
    );
    const echoed = await client.callTool({
      name: "mod__fake-mod__echo",
      arguments: { text: "full" },
    });
    expect(echoed.structuredContent).toEqual({ text: "full" });
  });
});
