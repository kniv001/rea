#!/usr/bin/env node
/**
 * Dev harness: send one JSON command to the guest agent and print the reply.
 *
 *   node scripts/wb.mjs '{"cmd":"ping"}'
 *   node scripts/wb.mjs '{"cmd":"ping"}' 45998
 *
 * This bypasses REA/MCP on purpose; it is only for workbench development and
 * smoke tests. Host tools still go through server.mjs.
 */
import net from "node:net";

const payload = process.argv[2];
if (!payload) {
  console.error("usage: node scripts/wb.mjs <json> [port]");
  process.exit(2);
}
let parsed;
try {
  parsed = JSON.parse(payload);
} catch (error) {
  console.error("invalid json:", String(error));
  process.exit(2);
}
const port = Number(process.argv[3] ?? 45999);
const host = process.env.REA_GUEST_HOST || "127.0.0.1";
const timeoutMs = Number(process.env.REA_GUEST_TIMEOUT || 20000);

const socket = net.createConnection({ host, port });
let buffer = "";
const timer = setTimeout(() => {
  console.error(`timeout after ${timeoutMs}ms at ${host}:${port}`);
  socket.destroy();
  process.exit(1);
}, timeoutMs);
socket.setEncoding("utf8");
socket.once("connect", () => {
  socket.write(`${JSON.stringify(parsed)}\n`);
});
socket.on("data", (chunk) => {
  buffer += chunk;
  const index = buffer.indexOf("\n");
  if (index < 0) return;
  clearTimeout(timer);
  const line = buffer.slice(0, index).trim();
  socket.destroy();
  try {
    console.log(JSON.stringify(JSON.parse(line), null, 2));
  } catch {
    console.log(line);
  }
});
socket.once("error", (error) => {
  clearTimeout(timer);
  console.error(`socket error: ${error.message}`);
  process.exit(1);
});
socket.once("close", () => {
  if (!buffer.trim()) {
    clearTimeout(timer);
    console.error("closed without a response");
    process.exit(1);
  }
});
