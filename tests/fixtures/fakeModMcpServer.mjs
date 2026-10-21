import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const server = new McpServer(
  { name: "fake-mod", version: "1" },
  { capabilities: {} },
);

server.registerTool(
  "echo",
  {
    description: "Return the supplied text.",
    inputSchema: z.object({ text: z.string() }),
    outputSchema: z.object({ text: z.string() }),
  },
  async ({ text }) => ({
    content: [{ type: "text", text }],
    structuredContent: { text },
  }),
);

server.registerTool(
  "slow",
  {
    description: "Answer after a delay.",
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
  },
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    return {
      content: [{ type: "text", text: "done" }],
      structuredContent: { ok: true },
    };
  },
);

await server.connect(new StdioServerTransport());
