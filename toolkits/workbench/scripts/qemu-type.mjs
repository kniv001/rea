#!/usr/bin/env node
/**
 * Send keystrokes to the guest through QMP. Development helper for blind
 * logons on a headless VM.
 *
 *   node scripts/qemu-type.mjs --text '<guest-password>'
 *   node scripts/qemu-type.mjs --keys ctrl alt delete
 */
import net from "node:net";

const args = process.argv.slice(2);
const qmpHost = "127.0.0.1";
const qmpPort = 5556;

const qmp = (execute, params = {}) =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: qmpHost, port: qmpPort });
    let buffer = "";
    let stage = 0;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("QMP timeout"));
    }, 8000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
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
        if (stage === 0 && message.QMP) {
          stage = 1;
          socket.write(
            JSON.stringify({ execute: "qmp_capabilities", id: 1 }) + "\n",
          );
          continue;
        }
        if (stage === 1 && message.id === 1) {
          stage = 2;
          socket.write(
            JSON.stringify({ execute, arguments: params, id: 2 }) + "\n",
          );
          continue;
        }
        if (stage === 2 && message.id === 2) {
          clearTimeout(timer);
          socket.destroy();
          if (message.error) reject(new Error(JSON.stringify(message.error)));
          else resolve(message.return);
          return;
        }
      }
    });
    socket.once("error", reject);
  });

const charToKeys = (char) => {
  if (/[a-z]/.test(char)) return [char];
  if (/[A-Z]/.test(char)) return ["shift", char.toLowerCase()];
  if (/[0-9]/.test(char)) return [char];
  const shifted = {
    "!": "1",
    "@": "2",
    "#": "3",
    $: "4",
    "%": "5",
    "^": "6",
    "&": "7",
    "*": "8",
    "(": "9",
    ")": "0",
    _: "minus",
    "+": "equal",
    ":": "semicolon",
    '"': "apostrophe",
    "<": "comma",
    ">": "dot",
    "?": "slash",
    "~": "grave_accent",
    "{": "bracket_left",
    "}": "bracket_right",
    "|": "backslash",
  };
  if (shifted[char]) return ["shift", shifted[char]];
  const plain = {
    " ": "spc",
    "-": "minus",
    "=": "equal",
    "[": "bracket_left",
    "]": "bracket_right",
    "\\": "backslash",
    ";": "semicolon",
    "'": "apostrophe",
    ",": "comma",
    ".": "dot",
    "/": "slash",
    "`": "grave_accent",
    "\n": "ret",
    "\t": "tab",
  };
  if (plain[char]) return [plain[char]];
  return null;
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const textIndex = args.indexOf("--text");
const keysIndex = args.indexOf("--keys");
if (textIndex < 0 && keysIndex < 0) {
  console.error("usage: --text <string> | --keys <qcode> [qcode...]");
  process.exit(2);
}

if (keysIndex >= 0) {
  const keys = args.slice(keysIndex + 1);
  await qmp("send-key", {
    keys: keys.map((key) => ({ type: "qcode", data: key })),
    "hold-time": 100,
  });
  process.stdout.write(`sent chord: ${keys.join("+")}\n`);
} else {
  const text = args[textIndex + 1] ?? "";
  const interval = Number(process.env.REA_TYPE_INTERVAL || 120);
  for (const char of text) {
    const keys = charToKeys(char);
    if (!keys) {
      process.stderr.write(
        `skip unsupported character: ${JSON.stringify(char)}\n`,
      );
      continue;
    }
    await qmp("send-key", {
      keys: keys.map((key) => ({ type: "qcode", data: key })),
      "hold-time": 60,
    });
    await delay(interval);
  }
  await qmp("send-key", {
    keys: [{ type: "qcode", data: "ret" }],
    "hold-time": 60,
  });
  process.stdout.write(`typed ${text.length} characters and pressed Enter\n`);
}
