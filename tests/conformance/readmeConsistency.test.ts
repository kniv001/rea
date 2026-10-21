import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { PRODUCT_IDENTITY } from "../../src/identity.js";

const jsonExamples = (content: string): unknown[] =>
  [...content.matchAll(/```json\s*([\s\S]*?)```/gu)].map((match): unknown =>
    JSON.parse(match[1] ?? ""),
  );

describe("onboarding documentation product facts", () => {
  it("keeps the installation MCP example aligned with the package registration command", async () => {
    const content = await readFile(resolve("docs/installation.md"), "utf8");
    expect(jsonExamples(content)).toContainEqual(
      expect.objectContaining({
        mcpServers: expect.objectContaining({
          rea: expect.objectContaining({
            command: "npx",
            args: ["-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"],
          }),
        }),
      }),
    );
  });

  it("documents this fork's package surface, mod loader, and DSH host", async () => {
    const content = await readFile(resolve("README.md"), "utf8");
    expect(content).toContain("kniv001/rea");
    expect(content).toContain("REA_MCP_TOOL_SURFACE");
    expect(content).toContain("rea.mod.json");
    expect(content).toContain("DeepSeek Harness");
  });
});
