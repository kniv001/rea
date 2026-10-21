import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";
import {
  buildToolPackageCatalog,
  type ToolPackageDescriptor,
} from "../../../src/composition/toolPackageCatalog.js";
import {
  installToolPackageSurface,
  type ToolPackageSurface,
} from "../../../src/server/toolPackageSurface.js";
import type { ToolContract } from "../../../src/contracts/toolContractTypes.js";
import { lifecycleResultOf } from "../../../src/contracts/toolOutputSchemaPrimitives.js";

const fakeContract = (name: string): ToolContract => ({
  name,
  title: name,
  description: `${name} returns a fixed result. Additional detail stays hidden in summary mode.`,
  kind: "session",
  inputSchema: z.strictObject({}),
  outputSchema: lifecycleResultOf(z.object({ value: z.string() })),
  effects: {
    mutatesTarget: false,
    mutatesSession: false,
    writesFilesystem: false,
    launchesProcess: false,
    accessesNetwork: false,
    changesUiState: false,
    mayDiscardData: false,
    executesForeignCode: false,
    mutatesDevice: false,
    idempotent: true,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  returnsTargetContent: false,
  examples: [],
});

const boundaries = {
  provides: ["test capability"],
  excludes: ["test non-capability"],
  authority: "test only",
  prerequisites: [],
};

const descriptors = (): readonly ToolPackageDescriptor[] => [
  {
    id: "test-family",
    title: "Test family",
    summary: "Two fake tools for package-surface tests.",
    kind: "family",
    requires: [],
    boundaries,
    tools: ["alpha_tool", "beta_tool"],
    profiles: [],
    usage: null,
    evidence: "test evidence",
  },
  {
    id: "test-dependent",
    title: "Test dependent",
    summary: "A package that requires the test family.",
    kind: "family",
    requires: ["test-family"],
    boundaries,
    tools: [],
    profiles: [],
    usage: null,
    evidence: "test evidence",
  },
  {
    id: "test-external",
    title: "Test external",
    summary: "An external toolkit that REA does not drive.",
    kind: "external",
    requires: [],
    boundaries,
    tools: [],
    profiles: [{ id: "profile", title: "Profile", summary: "A profile." }],
    usage: "Use the external toolkit directly.",
    evidence: "external evidence",
  },
];

const createTestServer = async (
  mode: "full" | "packages",
  pinned: readonly string[] = [],
): Promise<{
  readonly client: Client;
  readonly surface: ToolPackageSurface;
  readonly toolNames: () => Promise<readonly string[]>;
  readonly toolListChanges: () => number;
}> => {
  const contracts = [fakeContract("alpha_tool"), fakeContract("beta_tool")];
  const server = new EvidenceMcpServer(
    { name: "package-surface-test", version: "1" },
    { capabilities: {} },
    undefined,
    createToolResultDelivery(undefined),
  );
  for (const contract of contracts)
    server.registerTool(
      contract.name,
      toolRegistrationOptions(contract),
      async () =>
        server.delivery.toCallToolResult(
          { ok: true, value: { value: contract.name } },
          contract,
        ),
    );
  const surface = installToolPackageSurface(server, {
    mode,
    catalog: buildToolPackageCatalog(contracts, descriptors()),
    contracts,
    pinned,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "package-surface-client", version: "1" });
  let toolListChanges = 0;
  client.setNotificationHandler("notifications/tools/list_changed", () => {
    toolListChanges += 1;
  });
  onTestFinished(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    surface,
    toolNames: async () =>
      (await client.listTools()).tools.map(({ name }) => name).sort(),
    toolListChanges: () => toolListChanges,
  };
};

// oxlint-disable-next-line max-lines-per-function -- one suite covers the complete lifecycle.
describe("progressive tool package surface", () => {
  it("advertises only gateways until a package is opened", async () => {
    const { client, toolNames } = await createTestServer("packages");
    const initial = await toolNames();
    expect(initial).toEqual([
      "close_tool_package",
      "inspect_tool_package",
      "list_tool_packages",
      "open_tool_package",
    ]);
    const index = await client.callTool({
      name: "list_tool_packages",
      arguments: {},
    });
    expect(index.structuredContent).toMatchObject({
      result: {
        surface: "packages",
        packages: [
          { id: "test-family", tool_count: 2, open: false },
          { id: "test-dependent", tool_count: 0, open: false },
          { id: "test-external", tool_count: 0, open: false },
        ],
      },
    });
  });

  it("inspects boundaries and operations without enabling tools", async () => {
    const { client, toolNames } = await createTestServer("packages");
    const inspected = await client.callTool({
      name: "inspect_tool_package",
      arguments: { package_id: "test-family" },
    });
    expect(inspected.structuredContent).toMatchObject({
      result: {
        package: {
          id: "test-family",
          boundaries,
          operations: [
            {
              name: "alpha_tool",
              summary: expect.stringContaining("alpha_tool"),
            },
            {
              name: "beta_tool",
              summary: expect.stringContaining("beta_tool"),
            },
          ],
          open: false,
        },
      },
    });
    expect(await toolNames()).not.toContain("alpha_tool");
  });

  it("enables package tools on open and disables them on close", async () => {
    const { client, toolNames, toolListChanges } =
      await createTestServer("packages");
    const opened = await client.callTool({
      name: "open_tool_package",
      arguments: { package_id: "test-family" },
    });
    expect(opened.structuredContent).toMatchObject({
      result: {
        package_id: "test-family",
        status: "opened",
        enabled_tools: ["alpha_tool", "beta_tool"],
        tools_changed: true,
      },
    });
    expect(await toolNames()).toEqual(
      expect.arrayContaining(["alpha_tool", "beta_tool"]),
    );
    expect(toolListChanges()).toBeGreaterThan(0);
    const call = await client.callTool({
      name: "alpha_tool",
      arguments: {},
    });
    expect(call.structuredContent).toMatchObject({
      result: { value: "alpha_tool" },
    });

    const closed = await client.callTool({
      name: "close_tool_package",
      arguments: { package_id: "test-family" },
    });
    expect(closed.structuredContent).toMatchObject({
      result: {
        status: "closed",
        disabled_tools: ["alpha_tool", "beta_tool"],
        tools_changed: true,
      },
    });
    expect(await toolNames()).not.toContain("alpha_tool");
    const disabled = await client
      .callTool({ name: "alpha_tool", arguments: {} })
      .then(
        () => null,
        (cause: unknown) => cause,
      );
    expect(disabled).not.toBeNull();
    expect(String(disabled)).toMatch(/disabled/iu);
  });

  it("keeps bundled tools visible in full mode without toggling", async () => {
    const { client, toolNames } = await createTestServer("full");
    expect(await toolNames()).toEqual(
      expect.arrayContaining(["alpha_tool", "beta_tool"]),
    );
    const opened = await client.callTool({
      name: "open_tool_package",
      arguments: { package_id: "test-family" },
    });
    expect(opened.structuredContent).toMatchObject({
      result: { status: "full-surface", tools_changed: false },
    });
    const closed = await client.callTool({
      name: "close_tool_package",
      arguments: { package_id: "test-family" },
    });
    expect(closed.structuredContent).toMatchObject({
      result: { status: "full-surface" },
    });
    expect(await toolNames()).toEqual(
      expect.arrayContaining(["alpha_tool", "beta_tool"]),
    );
  });

  it("refuses to close a package that another open package requires", async () => {
    const { client } = await createTestServer("packages");
    await client.callTool({
      name: "open_tool_package",
      arguments: { package_id: "test-dependent" },
    });
    const refused = await client.callTool({
      name: "close_tool_package",
      arguments: { package_id: "test-family" },
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("Cannot close package");
    const closed = await client.callTool({
      name: "close_tool_package",
      arguments: { package_id: "test-dependent" },
    });
    expect(closed.structuredContent).toMatchObject({
      result: { status: "closed" },
    });
  });

  it("opens pinned packages before the first tools/list", async () => {
    const { toolNames } = await createTestServer("packages", ["test-family"]);
    expect(await toolNames()).toEqual(
      expect.arrayContaining(["alpha_tool", "beta_tool"]),
    );
  });

  it("returns external usage without enabling REA tools", async () => {
    const { client, toolNames } = await createTestServer("packages");
    const opened = await client.callTool({
      name: "open_tool_package",
      arguments: { package_id: "test-external" },
    });
    expect(opened.structuredContent).toMatchObject({
      result: {
        status: "external",
        enabled_tools: [],
        usage: "Use the external toolkit directly.",
      },
    });
    expect(await toolNames()).not.toContain("alpha_tool");
  });

  it("rejects unknown packages with a typed input error", async () => {
    const { client } = await createTestServer("packages");
    const response = await client.callTool({
      name: "open_tool_package",
      arguments: { package_id: "missing-package" },
    });
    expect(response.isError).toBe(true);
    const text = JSON.stringify(response.content);
    expect(text).toContain("invalid_request");
    expect(text).toContain("Unknown tool package");
  });
});
