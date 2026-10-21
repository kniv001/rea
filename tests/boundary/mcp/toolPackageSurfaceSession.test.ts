import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, onTestFinished } from "vitest";

import type {
  AnalysisProvider,
  CapabilityDescriptor,
} from "../../../src/application/AnalysisProvider.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

const availabilityProvider = (): AnalysisProvider => {
  const identity = { id: "fixture", name: "Fixture", version: "1" };
  const capability = (
    operation: CapabilityDescriptor["operation"],
  ): CapabilityDescriptor => ({
    provider: identity,
    operation,
    available: true,
    reason: null,
    effects: {
      mutatesArtifact: false,
      launchesProcess: false,
      mayShowUi: false,
      mayAccessNetwork: false,
      mayWriteFilesystem: false,
      changesPermissions: false,
      requiresRoot: false,
    },
    limitations: [],
  });
  return {
    identity: () => identity,
    capabilities: () => [capability("current_address")],
    createClient: () => ({
      execute: () =>
        Promise.resolve({
          ok: true,
          value: { name: "fixture", value: "0x1000" },
        }),
    }),
  } as unknown as AnalysisProvider;
};

const connectPackages = async () => {
  const server = createServer(
    {
      kind: "session",
      session: createTestBinarySession(availabilityProvider()),
    },
    {
      environment: {
        ...process.env,
        REA_MCP_TOOL_SURFACE: "packages",
      },
    },
  );
  const client = new Client({ name: "package-session-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  onTestFinished(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const toolNames = async () =>
    (await client.listTools()).tools.map(({ name }) => name).sort();
  return { client, toolNames };
};

describe("progressive package surface on a real session", () => {
  it("advertises only gateways, opens core, and filters binary_session inventory", async () => {
    const { client, toolNames } = await connectPackages();
    expect(await toolNames()).toEqual([
      "close_tool_package",
      "inspect_tool_package",
      "list_tool_packages",
      "open_tool_package",
    ]);

    const opened = await client.callTool({
      name: "open_tool_package",
      arguments: { package_id: "core" },
    });
    expect(opened.structuredContent).toMatchObject({
      result: {
        status: "opened",
        enabled_tools: ["open_binary", "close_binary", "binary_session"],
      },
    });
    expect(await toolNames()).toEqual(
      expect.arrayContaining([
        "open_binary",
        "close_binary",
        "binary_session",
        "open_tool_package",
      ]),
    );

    const status = await client.callTool({
      name: "binary_session",
      arguments: {},
    });
    const inventory = status.structuredContent as {
      result: {
        tool_availability: {
          groups: { names: string[] }[];
        };
      };
    };
    const advertised = inventory.result.tool_availability.groups
      .flatMap(({ names }) => names)
      .sort();
    expect(advertised).toEqual([
      "binary_session",
      "close_binary",
      "close_tool_package",
      "inspect_tool_package",
      "list_tool_packages",
      "open_binary",
      "open_tool_package",
    ]);
  });

  it("enables a family and hides it again without duplicating core", async () => {
    const { client, toolNames } = await connectPackages();
    await client.callTool({
      name: "open_tool_package",
      arguments: { package_id: "native-analysis" },
    });
    expect(await toolNames()).toEqual(
      expect.arrayContaining(["analyze_function", "open_binary"]),
    );
    expect(await toolNames()).not.toContain("inspect_android_package");

    const closed = await client.callTool({
      name: "close_tool_package",
      arguments: { package_id: "native-analysis" },
    });
    expect(closed.structuredContent).toMatchObject({
      result: { status: "closed" },
    });
    expect(await toolNames()).not.toContain("analyze_function");
    expect(await toolNames()).toEqual(
      expect.arrayContaining(["open_binary", "binary_session"]),
    );
  });

  it("inspects vmp boundaries without exposing scripts", async () => {
    const { client, toolNames } = await connectPackages();
    const inspected = await client.callTool({
      name: "inspect_tool_package",
      arguments: { package_id: "vmp", detail: "summary" },
    });
    const detail = inspected.structuredContent as {
      result: {
        package: {
          kind: string;
          profiles: { id: string }[];
          operations: unknown[];
          usage: string;
          boundaries: { excludes: string[] };
        };
      };
    };
    expect(detail.result.package.kind).toBe("external");
    expect(detail.result.package.profiles.map(({ id }) => id)).toEqual([
      "demo-product",
      "commercial-product",
      "commercial-body",
    ]);
    expect(detail.result.package.operations).toEqual([]);
    expect(detail.result.package.boundaries.excludes.join(" ")).toContain(
      "Registration",
    );
    expect(await toolNames()).not.toContain("analyze_function");
  });
});
