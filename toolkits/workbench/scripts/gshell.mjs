#!/usr/bin/env node
/**
 * Run one cmd.exe command in the guest and print its redirected output.
 *
 *   node scripts/gshell.mjs 45998 "schtasks /query /tn REAWorkbenchAgent /v /fo LIST"
 *   node scripts/gshell.mjs 45999 "whoami /priv"
 *
 * Development helper only; the command runs through the guest agent launch
 * primitive, which is visible to the guest and not a hidden channel.
 */
import net from "node:net";

const port = Number(process.argv[2] || 45998);
const command = process.argv.slice(3).join(" ");
if (!command) {
  console.error("usage: node scripts/gshell.mjs <port> <command>");
  process.exit(2);
}

const call = (payload) =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () =>
      socket.write(`${JSON.stringify(payload)}\n`),
    );
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index >= 0) {
        resolve(JSON.parse(buffer.slice(0, index)));
        socket.destroy();
      }
    });
    socket.on("error", reject);
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const outPath = String.raw`C:\Users\lab\rea-cmd-out.txt`;
const line = `${command} > ${outPath} 2>&1`;
const launched = await call({
  cmd: "launch",
  path: "C:/Windows/System32/cmd.exe",
  arguments: ["/c", line],
});
if (!launched.ok) {
  console.error("launch failed:", JSON.stringify(launched));
  process.exit(1);
}
await sleep(2500);
const read = await call({ cmd: "read", path: outPath, max_bytes: 1048576 });
if (!read.ok) {
  console.error("read failed:", JSON.stringify(read));
  process.exit(1);
}
const bytes = Buffer.from(read.base64, "base64");
let text = bytes.toString("utf8");
if (text.includes("�")) {
  try {
    text = new TextDecoder("gbk").decode(bytes);
  } catch {
    // keep the UTF-8 replacement text
  }
}
process.stdout.write(text);
