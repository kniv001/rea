#!/usr/bin/env node
/**
 * Minimal MCP stdio client for workbench development.
 *
 *   node scripts/mcp-call.mjs <tool> '<json args>'
 *   node scripts/mcp-call.mjs --list
 *
 * Spawns server.mjs, performs initialize, calls one tool, prints the text
 * content, then exits. This is a dev harness, not part of the mod surface.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "server.mjs");
const argv = process.argv.slice(2);
const listOnly = argv[0] === "--list";
const tool = listOnly ? null : argv[0];
const args = !listOnly && argv[1] ? JSON.parse(argv[1]) : {};

if (!listOnly && !tool) {
  console.error(
    "usage: node scripts/mcp-call.mjs <tool> '<json args>' | --list",
  );
  process.exit(2);
}

const child = spawn(process.execPath, [server], {
  cwd: dirname(server),
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let buffer = "";
let stderr = "";
const pending = new Map();
let nextId = 1;
let initialized = false;
let done = false;

const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
const call = (method, params = {}) => {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
};

const finish = (code, text) => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  if (text !== undefined) {
    if (code === 0)
      process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    else process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
  }
  child.kill();
  process.exitCode = code;
};

const timer = setTimeout(
  () => {
    finish(1, `timeout\n${stderr}`);
  },
  Number(process.env.REA_MCP_TIMEOUT || 180000),
);

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined) continue;
    const waiter = pending.get(message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.once("exit", (code) => {
  if (!done) finish(1, `server exited ${code}\n${stderr}`);
});

(async () => {
  try {
    const init = await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "workbench-dev", version: "0.0.0" },
    });
    initialized = true;
    if (listOnly) {
      const tools = await call("tools/list");
      finish(
        0,
        JSON.stringify(
          { server: init.serverInfo, tools: tools.tools.map((t) => t.name) },
          null,
          2,
        ),
      );
      return;
    }
    const result = await call("tools/call", { name: tool, arguments: args });
    const text = (result.content || [])
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    finish(result.isError ? 1 : 0, text);
  } catch (error) {
    finish(1, String(error?.message ?? error));
  }
})();

process.on("SIGINT", () => finish(1));
void initialized;
