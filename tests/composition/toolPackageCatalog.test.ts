import { describe, expect, it } from "vitest";

import { TOOL_CONTRACTS } from "../../src/contracts/toolContracts.js";
import {
  TOOL_PACKAGE_CATALOG,
  TOOL_PACKAGE_GATEWAY_TOOLS,
  buildToolPackageCatalog,
  renderToolPackageIndex,
  summarizeToolDescription,
} from "../../src/composition/toolPackageCatalog.js";

describe("tool package catalog", () => {
  it("assigns every non-gateway tool to at least one package", () => {
    const gateway = new Set(TOOL_PACKAGE_GATEWAY_TOOLS);
    const covered = new Set(
      TOOL_PACKAGE_CATALOG.packages.flatMap(({ tools }) => tools),
    );
    const missing = TOOL_CONTRACTS.map(({ name }) => name).filter(
      (name) => !gateway.has(name) && !covered.has(name),
    );
    expect(missing).toEqual([]);
  });

  it("names only canonical tools and unique package IDs", () => {
    const names = new Set<string>(TOOL_CONTRACTS.map(({ name }) => name));
    const ids = TOOL_PACKAGE_CATALOG.packages.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const descriptor of TOOL_PACKAGE_CATALOG.packages) {
      expect(descriptor.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
      for (const tool of descriptor.tools) expect(names.has(tool)).toBe(true);
      for (const dependency of descriptor.requires)
        expect(TOOL_PACKAGE_CATALOG.byId.has(dependency)).toBe(true);
    }
  });

  it("keeps gateway tools out of packages and exposes external toolkits abstractly", () => {
    const gateway = new Set(TOOL_PACKAGE_GATEWAY_TOOLS);
    for (const descriptor of TOOL_PACKAGE_CATALOG.packages)
      for (const tool of descriptor.tools)
        expect(gateway.has(tool), `${descriptor.id}:${tool}`).toBe(false);
    const external = TOOL_PACKAGE_CATALOG.packages.filter(
      ({ kind }) => kind === "external",
    );
    expect(external.map(({ id }) => id)).toEqual(
      expect.arrayContaining(["vmp", "mt-manager", "phone-mcp-bridge"]),
    );
    for (const descriptor of external) {
      expect(descriptor.tools).toEqual([]);
      expect(descriptor.usage).not.toBeNull();
    }
  });

  it("refuses a catalog that leaves a tool unassigned", () => {
    expect(() =>
      buildToolPackageCatalog(TOOL_CONTRACTS, [
        {
          id: "core",
          title: "Core",
          summary: "Core",
          kind: "core",
          requires: [],
          boundaries: {
            provides: [],
            excludes: [],
            authority: "none",
            prerequisites: [],
          },
          tools: ["open_binary"],
          profiles: [],
          usage: null,
          evidence: "none",
        },
      ]),
    ).toThrow(/do not cover/u);
  });

  it("renders a compact index without operation schemas", () => {
    const index = renderToolPackageIndex(TOOL_PACKAGE_CATALOG);
    expect(index).toContain("vmp (external)");
    expect(index).toContain("native-analysis (family)");
    expect(index).not.toContain("analyze_function");
  });

  it("keeps one-sentence summaries bounded", () => {
    const summary = summarizeToolDescription(
      `${"a".repeat(400)}. Second sentence.`,
      80,
    );
    expect(summary.length).toBeLessThanOrEqual(80);
    expect(summary.endsWith("...")).toBe(true);
  });
});
