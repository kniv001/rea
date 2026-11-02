#!/usr/bin/env node
/**
 * REA Workbench — QEMU-backed Windows analysis workbench (first slice).
 *
 * Controls one local QEMU guest: start/stop, status, qcow2 snapshots,
 * host-to-guest file staging, packet capture, and log tail.
 *
 * It does not install a guest agent, proxy guest file I/O, or claim that the
 * guest is undetectable. Those remain later workbench phases.
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import net from "node:net";

const VERSION = "0.2.0";
const HOME = resolve(process.env.REA_WORKBENCH_HOME || "D:\\vm\\rea-workbench");
const QEMU = resolve(
  process.env.REA_QEMU || "D:\\vs\\tools\\qemu\\qemu-system-x86_64.exe",
);
const QEMU_IMG = resolve(
  process.env.REA_QEMU_IMG || join(dirname(QEMU), "qemu-img.exe"),
);
const TRACERPT = resolve(
  process.env.REA_TRACERPT || "C:\\Windows\\System32\\tracerpt.exe",
);
const DISK = join(HOME, "win11-ltsc.qcow2");
const FIRMWARE_CODE = resolve(
  process.env.REA_WORKBENCH_FIRMWARE ||
    "D:\\vs\\tools\\qemu\\share\\edk2-x86_64-code.fd",
);
const FIRMWARE_VARS = join(HOME, "OVMF_VARS.fd");
const SHARE = join(HOME, "share");
const EXPORTS = join(HOME, "exports");
const RUN = join(HOME, "run");
const LOGS = join(HOME, "logs");
const LOG = join(LOGS, "qemu-workbench.log");
const PID_FILE = join(RUN, "qemu.pid");
const PROFILE_FILE = join(RUN, "last-profile.json");
const QMP_HOST = "127.0.0.1";
const QMP_PORT = 5556;
const MONITOR_PORT = 5555;
const VNC_DEFAULT = "127.0.0.1:1";
const GUEST_HOST = "127.0.0.1";
const GUEST_PORT = 45999;
const GUEST_PORT_USER = 45998;
const GUEST_IP = "10.0.2.15";
const GDB_HOST = "127.0.0.1";
const GDB_PORT = 1234;
const DEFAULT_CPU = "qemu64,+sse4.2,+popcnt";
const DEFAULT_MAC = "52:54:00:12:34:56";

const ensureLayout = () => {
  for (const dir of [HOME, SHARE, EXPORTS, RUN, LOGS]) {
    mkdirSync(dir, { recursive: true });
  }
};

const sha256File = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const readPid = () => {
  try {
    const value = Number(readFileSync(PID_FILE, "utf8").trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
};

const pidAlive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
};

const portOpen = (port, host = "127.0.0.1", timeoutMs = 600) =>
  new Promise((resolvePromise) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });

const delay = (ms) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const waitForPort = async (port, wantOpen, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await portOpen(port)) === wantOpen) return true;
    await delay(300);
  }
  return false;
};

const qmp = (execute, args = {}, timeoutMs = 8000) =>
  new Promise((resolvePromise, rejectPromise) => {
    const socket = net.createConnection({ host: QMP_HOST, port: QMP_PORT });
    let buffer = "";
    let stage = "greeting";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      socket.destroy();
      rejectPromise(new Error(`QMP timeout: ${execute}`));
    }, timeoutMs);
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const send = (payload) => socket.write(`${JSON.stringify(payload)}\n`);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      // Wait for the QMP greeting before capabilities.
    });
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
        if (stage === "greeting" && message.QMP) {
          stage = "capabilities";
          send({ execute: "qmp_capabilities", id: 1 });
          continue;
        }
        if (stage === "capabilities" && message.id === 1) {
          if (message.error) {
            finish(
              new Error(
                `QMP capabilities failed: ${JSON.stringify(message.error)}`,
              ),
            );
            return;
          }
          stage = "command";
          send({ execute, arguments: args, id: 2 });
          continue;
        }
        if (stage === "command" && message.id === 2) {
          if (message.error) {
            finish(
              new Error(
                `QMP ${execute} failed: ${message.error.desc || JSON.stringify(message.error)}`,
              ),
            );
          } else {
            finish(null, message.return ?? null);
          }
          return;
        }
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (!finished)
        finish(new Error(`QMP closed before ${execute} completed`));
    });
  });

const hmp = async (command) => {
  const result = await qmp("human-monitor-command", {
    "command-line": command,
  });
  return typeof result === "string" ? result : "";
};

const qemuImg = (args, timeout = 15000) => {
  try {
    const stdout = execFileSync(QEMU_IMG, args, {
      encoding: "utf8",
      timeout,
      windowsHide: true,
    });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout ?? "").trim(),
      stderr: String(error?.stderr ?? error?.message ?? error).trim(),
    };
  }
};

const validateName = (value) => {
  const name = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new Error("snapshot name must match [A-Za-z0-9._-]{1,64}");
  }
  return name;
};

const validateCpu = (value) => {
  const cpu = String(value ?? DEFAULT_CPU).trim();
  if (!/^[A-Za-z0-9+_,.-]{1,100}$/.test(cpu)) {
    throw new Error("cpu must match [A-Za-z0-9+_,.-]{1,100}");
  }
  return cpu;
};

const validateMemory = (value) => {
  const mb = value === undefined ? 8192 : Number(value);
  if (!Number.isInteger(mb) || mb < 1024 || mb > 32768) {
    throw new Error("memory_mb must be an integer between 1024 and 32768");
  }
  return mb;
};

const validateMac = (value) => {
  const mac = String(value ?? DEFAULT_MAC).trim();
  if (!/^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}$/.test(mac)) {
    throw new Error("mac must be six colon-separated hex bytes");
  }
  return mac;
};

const validateVnc = (value) => {
  const vnc = String(value ?? VNC_DEFAULT).trim();
  if (!/^127\.0\.0\.1:[1-9][0-9]?$/.test(vnc)) {
    throw new Error("vnc must be 127.0.0.1:<display 1-99>");
  }
  return vnc;
};

const validateProfileText = (name, value, max = 64) => {
  const text = String(value ?? "").trim();
  if (!text || text.length > max || /[,\r\n]/.test(text)) {
    throw new Error(
      `${name} must be 1-${max} chars without commas or newlines`,
    );
  }
  return text;
};

const validateUuid = (value) => {
  const uuid = String(value ?? "").trim();
  if (
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      uuid,
    )
  ) {
    throw new Error("smbios.uuid must be a canonical UUID");
  }
  return uuid;
};

const smbiosArgs = (input) => {
  if (input.smbios === undefined) return [];
  if (typeof input.smbios !== "object" || input.smbios === null) {
    throw new Error("smbios must be an object");
  }
  const allowed = ["manufacturer", "product", "version", "serial", "uuid"];
  for (const key of Object.keys(input.smbios)) {
    if (!allowed.includes(key))
      throw new Error(`unsupported smbios field: ${key}`);
  }
  const parts = [];
  for (const key of allowed) {
    if (input.smbios[key] === undefined) continue;
    const value =
      key === "uuid"
        ? validateUuid(input.smbios[key])
        : validateProfileText(`smbios.${key}`, input.smbios[key]);
    parts.push(`${key}=${value}`);
  }
  return parts.length ? ["-smbios", `type=1,${parts.join(",")}`] : [];
};

const underLogs = (value) => {
  const path = resolve(String(value ?? ""));
  if (!isAbsolute(path)) throw new Error("pcap_path must be absolute");
  const base = LOGS.toLowerCase() + sep;
  if (!(path.toLowerCase() + sep).startsWith(base)) {
    throw new Error(`pcap_path must be under ${LOGS}`);
  }
  return path;
};

const buildQemuArgs = (input = {}) => {
  const cpu = validateCpu(input.cpu);
  const memory = validateMemory(input.memory_mb);
  const mac = validateMac(input.mac);
  const vnc = validateVnc(input.vnc);
  const diskSerial = validateProfileText(
    "disk_serial",
    input.disk_serial ?? "REA20261102",
  );
  const args = [
    "-accel",
    "whpx",
    "-machine",
    "q35",
    "-global",
    "ICH9-LPC.disable_s3=1",
    "-global",
    "ICH9-LPC.disable_s4=1",
    "-cpu",
    cpu,
    "-smp",
    "4,sockets=1,cores=4,threads=1",
    "-m",
    String(memory),
    "-rtc",
    "base=localtime,clock=host",
    "-drive",
    `if=pflash,format=raw,readonly=on,file=${FIRMWARE_CODE}`,
    "-drive",
    `if=pflash,format=raw,file=${FIRMWARE_VARS}`,
    "-drive",
    `file=${DISK},if=none,id=disk,format=qcow2`,
    "-device",
    `nvme,drive=disk,serial=${diskSerial}`,
    ...smbiosArgs(input),
    "-netdev",
    `user,id=net0,hostfwd=tcp:${GUEST_HOST}:${GUEST_PORT}-${GUEST_IP}:${GUEST_PORT},hostfwd=tcp:${GUEST_HOST}:${GUEST_PORT_USER}-${GUEST_IP}:${GUEST_PORT_USER}`,
    "-device",
    `e1000,netdev=net0,mac=${mac}`,
    "-vnc",
    vnc,
    "-monitor",
    `tcp:${QMP_HOST}:${MONITOR_PORT},server,nowait`,
    "-qmp",
    `tcp:${QMP_HOST}:${QMP_PORT},server,nowait`,
    ...(input.gdb === true ? ["-gdb", `tcp:${GDB_HOST}:${GDB_PORT}`] : []),
    "-display",
    "none",
    "-boot",
    "order=c",
    "-name",
    "REA-Workbench",
  ];
  args.push("-device", "qemu-xhci,id=xhci", "-device", "usb-tablet");
  if (input.share !== false) {
    const sharePath = SHARE.replaceAll("\\", "/");
    args.push(
      "-drive",
      `file=fat:rw:${sharePath},format=raw,if=none,id=share`,
      "-device",
      "usb-storage,drive=share,removable=on",
    );
  }
  if (input.pcap_path !== undefined) {
    const pcap = underLogs(input.pcap_path);
    mkdirSync(dirname(pcap), { recursive: true });
    args.push(
      "-object",
      `filter-dump,id=dump0,netdev=net0,file=${pcap.replaceAll("\\", "/")}`,
    );
  }
  return args;
};

const status = async () => {
  ensureLayout();
  const qmpOpen = await portOpen(QMP_PORT);
  const monitorOpen = await portOpen(MONITOR_PORT);
  const running = qmpOpen || monitorOpen;
  const pid = readPid();
  const disk = qemuImg(["info", DISK]);
  let vm = null;
  if (qmpOpen) {
    try {
      vm = {
        status: (await hmp("info status")).trim(),
        block: (await hmp("info block")).trim(),
        usernet: (await hmp("info usernet")).trim(),
      };
    } catch (error) {
      vm = { error: String(error?.message ?? error) };
    }
  }
  return {
    running,
    managed: qmpOpen,
    qmp_open: qmpOpen,
    monitor_open: monitorOpen,
    pid,
    pid_alive: pidAlive(pid),
    qmp: `${QMP_HOST}:${QMP_PORT}`,
    monitor: `${QMP_HOST}:${MONITOR_PORT}`,
    gdb: `${GDB_HOST}:${GDB_PORT}`,
    vnc: VNC_DEFAULT,
    guest_ports: { system: GUEST_PORT, user: GUEST_PORT_USER },
    home: HOME,
    disk: DISK,
    disk_info: disk.ok ? disk.stdout : disk.stderr,
    cpu: DEFAULT_CPU,
    vm,
    note: qmpOpen
      ? "GUI access is local VNC; guest health is not visually verified by this tool."
      : monitorOpen
        ? "QEMU monitor is in use but QMP is not; this VM was started outside the workbench mod."
        : "Start the workbench to launch the installed Windows guest.",
  };
};

const start = async (input = {}) => {
  ensureLayout();
  if (await portOpen(QMP_PORT)) {
    return { already_running: true, ...(await status()) };
  }
  if (await portOpen(MONITOR_PORT)) {
    throw new Error(
      `QEMU monitor ${MONITOR_PORT} is already in use by a VM this mod did not start; stop that VM or use its own controller.`,
    );
  }
  if (!existsSync(QEMU)) throw new Error(`QEMU not found: ${QEMU}`);
  if (!existsSync(QEMU_IMG)) throw new Error(`qemu-img not found: ${QEMU_IMG}`);
  if (!existsSync(DISK)) throw new Error(`guest disk not found: ${DISK}`);
  if (!existsSync(FIRMWARE_CODE))
    throw new Error(`firmware not found: ${FIRMWARE_CODE}`);
  if (!existsSync(FIRMWARE_VARS))
    throw new Error(`vars not found: ${FIRMWARE_VARS}`);
  const profile = {
    cpu: validateCpu(input.cpu),
    memory_mb: validateMemory(input.memory_mb),
    mac: validateMac(input.mac),
    disk_serial: validateProfileText(
      "disk_serial",
      input.disk_serial ?? "REA20261102",
    ),
    smbios: input.smbios ?? null,
  };
  writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2), "utf8");
  const args = buildQemuArgs(input);
  const logFd = openSync(LOG, "a");
  const child = spawn(QEMU, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  closeSync(logFd);
  writeFileSync(PID_FILE, String(child.pid), "utf8");
  const ready = await waitForPort(QMP_PORT, true, 15000);
  if (!ready) {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // ignore
    }
    throw new Error(
      `QEMU did not open QMP ${QMP_HOST}:${QMP_PORT}; see ${LOG}`,
    );
  }
  return {
    started: true,
    pid: child.pid,
    vnc: validateVnc(input.vnc),
    ...(await status()),
  };
};

const stop = async (input = {}) => {
  if (!(await portOpen(QMP_PORT))) {
    try {
      const pid = readPid();
      if (pidAlive(pid)) process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }
    return { stopped: false, already_stopped: true, ...(await status()) };
  }
  try {
    await qmp("system_powerdown");
  } catch {
    // fall through to quit
  }
  let closed = await waitForPort(QMP_PORT, false, input.force ? 3000 : 12000);
  if (!closed) {
    try {
      await qmp("quit");
    } catch {
      // ignore
    }
    closed = await waitForPort(QMP_PORT, false, 3000);
  }
  if (!closed) {
    const pid = readPid();
    if (pidAlive(pid)) process.kill(pid, "SIGKILL");
    closed = await waitForPort(QMP_PORT, false, 3000);
  }
  return { stopped: closed, ...(await status()) };
};

const snapshot = async (input = {}) => {
  const name = validateName(input.name);
  const running = await portOpen(QMP_PORT);
  if (running) {
    const output = (await hmp(`savevm ${name}`)).trim();
    const list = (await hmp("info snapshots")).trim();
    if (/error|missing|blocked|failed/i.test(output)) {
      return {
        mode: "running",
        name,
        supported: false,
        output,
        snapshots: list,
        hint: "WHPX does not provide the dirty-memory/system-state support required by savevm. Stop the guest and call snapshot again for an offline qcow2 snapshot.",
      };
    }
    return { mode: "running", name, supported: true, output, snapshots: list };
  }
  const created = qemuImg(["snapshot", "-c", name, DISK], 60000);
  if (!created.ok)
    throw new Error(created.stderr || created.stdout || "snapshot failed");
  const list = qemuImg(["snapshot", "-l", DISK], 30000);
  return {
    mode: "offline",
    name,
    output: created.stdout,
    snapshots: list.stdout,
  };
};

const restore = async (input = {}) => {
  const name = validateName(input.name);
  const running = await portOpen(QMP_PORT);
  if (running) {
    const output = (await hmp(`loadvm ${name}`)).trim();
    if (/error|missing|blocked|failed/i.test(output)) {
      return {
        mode: "running",
        name,
        supported: false,
        output,
        hint: "WHPX may not support loadvm. Stop the guest and call restore again for an offline qcow2 snapshot.",
      };
    }
    return { mode: "running", name, supported: true, output };
  }
  const applied = qemuImg(["snapshot", "-a", name, DISK], 60000);
  if (!applied.ok)
    throw new Error(applied.stderr || applied.stdout || "restore failed");
  return { mode: "offline", name, output: applied.stdout };
};

const importFile = async (input = {}) => {
  ensureLayout();
  const source = resolve(String(input.host_path ?? ""));
  if (!isAbsolute(source)) throw new Error("host_path must be absolute");
  let info;
  try {
    info = lstatSync(source);
  } catch {
    throw new Error(`host_path not found: ${source}`);
  }
  if (info.isSymbolicLink()) throw new Error("host_path must not be a symlink");
  if (!info.isFile()) throw new Error("host_path must be a regular file");
  if (info.size > 2 * 1024 * 1024 * 1024)
    throw new Error("host_path exceeds 2 GiB");
  const name = basename(source);
  if (!name || name === "." || name === "..")
    throw new Error("invalid file name");
  const target = join(SHARE, name);
  if (existsSync(target) && input.overwrite !== true) {
    throw new Error(`share target exists: ${target}; pass overwrite: true`);
  }
  copyFileSync(source, target);
  const running = await portOpen(QMP_PORT);
  return {
    host_path: source,
    share_path: target,
    guest_hint: `可移动磁盘:${name}`,
    bytes: statSync(target).size,
    sha256: sha256File(target),
    running,
    note: running
      ? "The guest is already running; restart it to refresh the vvfat directory listing. This slice does not proxy guest writes back to the host."
      : "The guest will see the shared removable disk on next start. This slice does not proxy guest writes back to the host.",
  };
};

const gdbHex = (value) => {
  const text = String(value ?? "").trim();
  if (/^0x[0-9a-f]+$/i.test(text) || /^[0-9]+$/.test(text)) {
    return BigInt(text).toString(16);
  }
  throw new Error("address must be a hex 0x... or decimal integer");
};

const gdbPacket = (payload) => {
  const data = Buffer.from(payload, "latin1");
  let sum = 0;
  for (const byte of data) sum = (sum + byte) & 0xff;
  return Buffer.concat([
    Buffer.from("$", "latin1"),
    data,
    Buffer.from("#" + sum.toString(16).padStart(2, "0"), "latin1"),
  ]);
};

const gdbCommands = (commands, { resume = true, timeout = 8000 } = {}) =>
  new Promise((resolvePromise, rejectPromise) => {
    const socket = net.createConnection({ host: GDB_HOST, port: GDB_PORT });
    let buffer = "";
    const packets = [];
    let waiter = null;
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      socket.destroy();
      rejectPromise(new Error(`gdbstub timeout on ${GDB_HOST}:${GDB_PORT}`));
    }, timeout);
    const deliver = () => {
      if (!waiter || packets.length === 0) return;
      const resolve = waiter.resolve;
      waiter = null;
      resolve(packets.shift());
    };
    const parse = () => {
      for (;;) {
        const start = buffer.indexOf("$");
        if (start < 0) {
          buffer = "";
          return;
        }
        buffer = buffer.slice(start);
        const hash = buffer.indexOf("#");
        if (hash < 0) return;
        if (buffer.length < hash + 3) return;
        const payload = buffer.slice(1, hash);
        buffer = buffer.slice(hash + 3);
        if (payload === "" || payload === "+" || payload === "-") continue;
        socket.write("+");
        packets.push(payload);
      }
    };
    const wait = () =>
      new Promise((resolve, reject) => {
        if (packets.length) return resolve(packets.shift());
        waiter = { resolve, reject };
        if (!deliver) reject(new Error("gdb parser unavailable"));
      });
    const send = (payload) => socket.write(gdbPacket(payload));
    const fail = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      rejectPromise(error);
    };
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => {
      buffer += chunk;
      parse();
      deliver();
    });
    socket.on("error", fail);
    socket.on("close", () => {
      if (!finished) fail(new Error("gdbstub closed before response"));
    });
    socket.once("connect", async () => {
      try {
        send("qSupported:multiprocess+;swbreak+;hwbreak+");
        await wait();
        const responses = [];
        for (const command of commands) {
          send(command);
          responses.push(await wait());
        }
        if (resume) {
          send("c");
          await delay(120);
        }
        finished = true;
        clearTimeout(timer);
        socket.destroy();
        resolvePromise(responses);
      } catch (error) {
        fail(error);
      }
    });
  });

const gdbResume = () =>
  new Promise((resolvePromise, rejectPromise) => {
    const socket = net.createConnection({ host: GDB_HOST, port: GDB_PORT });
    let buffer = "";
    let gotSupported = false;
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      socket.destroy();
      rejectPromise(new Error("gdbstub resume timeout"));
    }, 5000);
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.write(gdbPacket("c"));
      setTimeout(() => {
        socket.destroy();
        resolvePromise({ resumed: true, gdb: `${GDB_HOST}:${GDB_PORT}` });
      }, 120);
    };
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!gotSupported && buffer.includes("#")) {
        gotSupported = true;
        socket.write("+");
        finish();
      }
    });
    socket.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    socket.once("connect", () => {
      socket.write(gdbPacket("qSupported:multiprocess+;swbreak+;hwbreak+"));
    });
  });

const gdbInterrupt = () =>
  new Promise((resolvePromise, rejectPromise) => {
    const socket = net.createConnection({ host: GDB_HOST, port: GDB_PORT });
    let buffer = "";
    let sent = false;
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      socket.destroy();
      rejectPromise(new Error("gdbstub interrupt timeout"));
    }, 5000);
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const hash = buffer.indexOf("#");
      if (!sent && hash >= 0) {
        sent = true;
        buffer = "";
        socket.write("+");
        socket.write(Buffer.from([0x03]));
        return;
      }
      if (sent && hash >= 0 && buffer.includes("$")) {
        finished = true;
        clearTimeout(timer);
        const start = buffer.lastIndexOf("$", hash);
        const payload = start >= 0 ? buffer.slice(start + 1, hash) : "";
        socket.write("+");
        socket.destroy();
        resolvePromise({ interrupted: true, stop_reply: payload });
      }
    });
    socket.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    socket.once("connect", () => {
      socket.write(gdbPacket("qSupported:multiprocess+;swbreak+;hwbreak+"));
    });
  });

const X86_REGISTERS = [
  "rax",
  "rbx",
  "rcx",
  "rdx",
  "rsi",
  "rdi",
  "rbp",
  "rsp",
  "r8",
  "r9",
  "r10",
  "r11",
  "r12",
  "r13",
  "r14",
  "r15",
  "rip",
  "eflags",
];

const parseGdbRegisters = (payload) => {
  if (!/^[0-9a-f]+$/i.test(payload)) return { raw: payload, registers: {} };
  const registers = {};
  let offset = 0;
  for (let i = 0; i < X86_REGISTERS.length; i += 1) {
    const width = i >= 17 ? 8 : 8;
    const chunk = payload.slice(offset, offset + width * 2);
    if (chunk.length !== width * 2) break;
    const pairs = chunk.match(/../g) ?? [];
    const littleEndian = pairs.reverse().join("");
    registers[X86_REGISTERS[i]] =
      "0x" + BigInt("0x" + littleEndian).toString(16);
    offset += width * 2;
  }
  return { raw: payload, registers };
};

const resumeVm = async () => {
  const output = (await hmp("cont")).trim();
  return { resumed: true, output, ...(await status()) };
};

const pauseVm = async () => {
  const output = (await hmp("stop")).trim();
  return { paused: true, output, ...(await status()) };
};

const gdbStatus = async () => {
  const responses = await gdbCommands(["?", "?"], { resume: true });
  const stop = responses.at(-1);
  return { gdb: `${GDB_HOST}:${GDB_PORT}`, stop_reply: stop };
};

const gdbRegisters = async (input = {}) => {
  const responses = await gdbCommands(["?", "g"], {
    resume: input.resume !== false,
  });
  const stop = responses.at(-2);
  const regs = responses.at(-1);
  return {
    gdb: `${GDB_HOST}:${GDB_PORT}`,
    stop_reply: stop,
    ...parseGdbRegisters(regs),
    resumed: input.resume !== false,
  };
};

const gdbReadMemory = async (input = {}) => {
  const address = gdbHex(input.address);
  const length = Number(input.length ?? 64);
  if (!Number.isInteger(length) || length < 1 || length > 1024 * 1024) {
    throw new Error("length must be an integer between 1 and 1048576");
  }
  const responses = await gdbCommands(
    ["?", `m${address},${length.toString(16)}`],
    {
      resume: input.resume !== false,
    },
  );
  const data = responses.at(-1);
  if (!/^[0-9a-f]*$/i.test(data)) throw new Error(`gdb read failed: ${data}`);
  return {
    address: "0x" + address,
    length,
    hex: data,
    resumed: input.resume !== false,
  };
};

const gdbWriteMemory = async (input = {}) => {
  const address = gdbHex(input.address);
  const hex = String(input.hex ?? "").replace(/\s+/g, "");
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    throw new Error("hex must be an even-length hex byte string");
  }
  if (hex.length > 128 * 1024) throw new Error("write exceeds 64 KiB");
  const responses = await gdbCommands(
    ["?", `M${address},${(hex.length / 2).toString(16)}:${hex}`],
    { resume: input.resume !== false },
  );
  const reply = responses.at(-1);
  return {
    address: "0x" + address,
    bytes: hex.length / 2,
    reply,
    resumed: input.resume !== false,
  };
};

const gdbBreak = async (input = {}) => {
  const address = gdbHex(input.address);
  const kind = Math.max(1, Number(input.kind ?? 1));
  const responses = await gdbCommands(
    ["?", `Z0,${address},${kind.toString(16)}`],
    {
      resume: input.resume !== false,
    },
  );
  const reply = responses.at(-1);
  return {
    address: "0x" + address,
    kind,
    reply,
    resumed: input.resume !== false,
  };
};

const gdbUnbreak = async (input = {}) => {
  const address = gdbHex(input.address);
  const kind = Math.max(1, Number(input.kind ?? 1));
  const responses = await gdbCommands(
    ["?", `z0,${address},${kind.toString(16)}`],
    {
      resume: input.resume !== false,
    },
  );
  const reply = responses.at(-1);
  return {
    address: "0x" + address,
    kind,
    reply,
    resumed: input.resume !== false,
  };
};

const gdbContinue = () => gdbResume();

const gdbStep = async () => {
  const responses = await gdbCommands(["s"], { resume: false, timeout: 10000 });
  const reply = responses.at(-1);
  return {
    stop_reply: reply,
    note: "stepped and left stopped; call gdb_continue to resume.",
  };
};

const guestRequest = (payload, timeoutMs = 10000, port = GUEST_PORT) =>
  new Promise((resolvePromise, rejectPromise) => {
    const socket = net.createConnection({ host: GUEST_HOST, port });
    let buffer = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      socket.destroy();
      rejectPromise(
        new Error(
          `guest agent timeout at ${GUEST_HOST}:${port}; is guest/agent.ps1 running on that port?`,
        ),
      );
    }, timeoutMs);
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const line = buffer.slice(0, index).trim();
      if (!line) return;
      try {
        finish(null, JSON.parse(line));
      } catch (error) {
        finish(new Error(`invalid guest agent response: ${String(error)}`));
      }
    });
    socket.once("error", (error) => {
      if (error && error.code === "ECONNREFUSED") {
        finish(
          new Error(
            `guest agent not reachable on ${GUEST_HOST}:${port}. Import guest/agent.ps1 and run it inside the guest; QEMU must be started with hostfwd (start this workbench after the update).`,
          ),
        );
      } else {
        finish(error);
      }
    });
    socket.once("close", () => {
      if (!finished) finish(new Error("guest agent closed before a response"));
    });
  });

const validateGuestPath = (value) => {
  const path = String(value ?? "").trim();
  if (
    !/^[A-Za-z]:[\\/]/.test(path) ||
    path.includes("\0") ||
    path.startsWith("\\\\")
  ) {
    throw new Error(
      "guest path must be an absolute drive path such as C:\\path",
    );
  }
  return path;
};

const guestPing = () => guestRequest({ cmd: "ping" });
const guestProfile = () => guestRequest({ cmd: "profile" });
const guestPs = () => guestRequest({ cmd: "ps" });
const guestLs = (input = {}) =>
  guestRequest({ cmd: "ls", path: validateGuestPath(input.path) });
const guestRead = (input = {}) =>
  guestRequest({
    cmd: "read",
    path: validateGuestPath(input.path),
    ...(input.max_bytes === undefined ? {} : { max_bytes: input.max_bytes }),
  });
const guestWrite = (input = {}) => {
  const path = validateGuestPath(input.path);
  const data = String(input.data_base64 ?? "");
  if (!data || data.length > 24 * 1024 * 1024) {
    throw new Error("data_base64 must be 1..24 MiB of base64 text");
  }
  return guestRequest({
    cmd: "write",
    path,
    base64: data,
    append: input.append === true,
  });
};
const guestLaunch = async (input = {}) => {
  const path = validateGuestPath(input.path);
  const args = Array.isArray(input.arguments)
    ? input.arguments.map(String)
    : [];
  const cwd =
    input.cwd === undefined ? undefined : validateGuestPath(input.cwd);
  const payload = {
    cmd: "launch",
    path,
    arguments: args,
    ...(cwd === undefined ? {} : { cwd }),
  };
  try {
    const result = await guestRequest(payload, 15000, GUEST_PORT_USER);
    return { ...result, channel: "user" };
  } catch (error) {
    if (!/not reachable/i.test(String(error?.message ?? error))) throw error;
    const result = await guestRequest(payload, 15000, GUEST_PORT);
    return {
      ...result,
      channel: "system",
      warning:
        "interactive agent on 45998 is not reachable; launched through the SYSTEM channel and the process may run in session 0",
    };
  }
};

const readProfile = () => {
  try {
    return JSON.parse(readFileSync(PROFILE_FILE, "utf8"));
  } catch {
    return null;
  }
};

const normalize = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase();
const normalizeMac = (value) => normalize(value).replace(/[:-]/g, "");
const normalizeSerial = (value) => normalize(value).replace(/[^a-z0-9]/g, "");
const serialMatches = (expected, actual) => {
  const left = normalizeSerial(expected);
  const right = normalizeSerial(actual);
  return (
    left.length > 0 &&
    (right === left || right.startsWith(left) || left.startsWith(right))
  );
};

const profileCheck = async () => {
  const host = readProfile();
  if (!host)
    throw new Error(`no profile at ${PROFILE_FILE}; start the guest first`);
  const guest = await guestProfile();
  if (!guest || guest.ok !== true)
    throw new Error(`guest profile failed: ${JSON.stringify(guest)}`);
  const checks = [];
  const add = (field, expected, actual, norm = normalize) => {
    const ok = norm(expected) === norm(actual);
    checks.push({ field, expected, actual, ok });
  };
  if (host.smbios) {
    if (host.smbios.manufacturer)
      add(
        "computer.manufacturer",
        host.smbios.manufacturer,
        guest.computer?.manufacturer,
      );
    if (host.smbios.product)
      add("computer.model", host.smbios.product, guest.computer?.model);
    if (host.smbios.serial)
      add("bios.serial", host.smbios.serial, guest.bios?.serial);
  }
  checks.push({
    field: "disk.serial",
    expected: host.disk_serial,
    actual: guest.disks?.[0]?.serial,
    ok: serialMatches(host.disk_serial, guest.disks?.[0]?.serial),
  });
  add("nic.mac", host.mac, guest.nics?.[0]?.mac, normalizeMac);
  return {
    profile_file: PROFILE_FILE,
    host,
    guest,
    checks,
    ok: checks.every((check) => check.ok),
  };
};

const PROFILE_BIOS_KEYS = [
  "BaseBoardManufacturer",
  "BaseBoardProduct",
  "BaseBoardSerialNumber",
  "BaseBoardVersion",
  "BIOSVendor",
  "BIOSVersion",
  "BIOSReleaseDate",
  "SystemManufacturer",
  "SystemProductName",
  "SystemSerialNumber",
  "SystemVersion",
  "SystemSKU",
];

const profileApply = (input = {}) => {
  if (input.confirm !== true) {
    throw new Error("profile_apply changes guest identity; pass confirm: true");
  }
  const payload = { cmd: "identity_apply" };
  const has = (key) => input[key] !== undefined;
  if (has("machine_guid")) {
    const value = String(input.machine_guid).trim();
    if (
      !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        value,
      )
    ) {
      throw new Error("machine_guid must be a canonical UUID");
    }
    payload.machine_guid = value;
  }
  if (has("product_id")) {
    const value = String(input.product_id).trim();
    if (!/^[A-Za-z0-9-]{5,40}$/.test(value)) {
      throw new Error("product_id must be 5-40 alphanumeric/dash chars");
    }
    payload.product_id = value;
  }
  if (has("computer_name")) {
    const value = String(input.computer_name).trim();
    if (!/^[A-Za-z0-9-]{1,15}$/.test(value)) {
      throw new Error("computer_name must be 1-15 alphanumeric/dash chars");
    }
    payload.computer_name = value;
  }
  if (has("cpu_name")) {
    const value = String(input.cpu_name);
    if (!value || value.length > 96 || /[\0\r\n]/.test(value)) {
      throw new Error("cpu_name must be 1-96 chars without control characters");
    }
    payload.cpu_name = value;
  }
  if (has("bios")) {
    if (typeof input.bios !== "object" || input.bios === null) {
      throw new Error("bios must be an object");
    }
    const bios = {};
    for (const [key, value] of Object.entries(input.bios)) {
      if (!PROFILE_BIOS_KEYS.includes(key))
        throw new Error(`unsupported bios field: ${key}`);
      const text = String(value);
      if (!text || text.length > 96 || /[\0\r\n]/.test(text)) {
        throw new Error(
          `bios.${key} must be 1-96 chars without control characters`,
        );
      }
      bios[key] = text;
    }
    if (Object.keys(bios).length) payload.bios = bios;
  }
  payload.persist = input.persist !== false;
  const fields = Object.keys(payload).filter(
    (key) => !["cmd", "persist"].includes(key),
  );
  if (!fields.length) throw new Error("no identity fields supplied");
  return guestCommand(payload, 120000);
};

const profileVerify = async (input = {}) => {
  const host = readProfile();
  const identity = await guestIdentity();
  if (!identity || identity.ok !== true) {
    throw new Error(`guest identity failed: ${JSON.stringify(identity)}`);
  }
  let guest = null;
  try {
    guest = await guestProfile();
  } catch {
    guest = null;
  }
  const checks = [];
  const add = (layer, field, expected, actual) => {
    const ok =
      expected !== undefined && normalize(expected) === normalize(actual);
    checks.push({
      layer,
      field,
      expected: expected ?? null,
      actual: actual ?? null,
      ok,
    });
  };
  const smbios = identity.smbios ?? {};
  const bios = identity.bios_registry ?? {};
  const cpu = identity.cpu_registry ?? {};
  add(
    "firmware/registry",
    "bios.SystemManufacturer",
    smbios.vendor,
    bios.SystemManufacturer,
  );
  add(
    "firmware/registry",
    "bios.SystemProductName",
    smbios.name,
    bios.SystemProductName,
  );
  add(
    "firmware/registry",
    "bios.SystemSerialNumber",
    smbios.serial,
    bios.SystemSerialNumber,
  );
  add(
    "firmware/registry",
    "bios.SystemVersion",
    smbios.version,
    bios.SystemVersion,
  );
  add(
    "wmi/registry",
    "cpu.ProcessorNameString",
    identity.wmi_cpu_name,
    cpu.ProcessorNameString,
  );
  if (host?.smbios) {
    if (host.smbios.manufacturer)
      add(
        "host/firmware",
        "computer.manufacturer",
        host.smbios.manufacturer,
        smbios.vendor,
      );
    if (host.smbios.product)
      add("host/firmware", "computer.model", host.smbios.product, smbios.name);
    if (host.smbios.serial)
      add("host/firmware", "bios.serial", host.smbios.serial, smbios.serial);
  }
  if (guest?.ok === true) {
    add(
      "firmware/wmi",
      "computer.manufacturer",
      smbios.vendor,
      guest.computer?.manufacturer,
    );
    add("firmware/wmi", "computer.model", smbios.name, guest.computer?.model);
  }
  const expected =
    input.expected && typeof input.expected === "object" ? input.expected : {};
  const expectedFields = {
    machine_guid: () => identity.machine_guid,
    product_id: () => identity.product_id,
    computer_name: () => identity.computer,
    "bios.SystemManufacturer": () => bios.SystemManufacturer,
    "bios.SystemProductName": () => bios.SystemProductName,
    "bios.SystemSerialNumber": () => bios.SystemSerialNumber,
    "bios.BIOSVendor": () => bios.BIOSVendor,
    "bios.BIOSVersion": () => bios.BIOSVersion,
    "cpu.ProcessorNameString": () => cpu.ProcessorNameString,
  };
  for (const [field, value] of Object.entries(expected)) {
    const getter = expectedFields[field];
    if (!getter) throw new Error(`unsupported expected field: ${field}`);
    add("expected", field, value, getter());
  }
  return {
    profile_file: PROFILE_FILE,
    identity,
    guest,
    checks,
    ok: checks.every((check) => check.ok),
    note: "firmware values come from QEMU -smbios; registry values come from Profile Broker persistence. A mismatch means the two layers disagree.",
  };
};

const TELEMETRY_NAME = (value) => {
  const name = String(value ?? "rea-kernel").trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
    throw new Error("telemetry name must match [A-Za-z0-9_-]{1,32}");
  }
  return name;
};

const telemetryStart = (input = {}) => {
  const name = TELEMETRY_NAME(input.name);
  const payload = { cmd: "etw_start", name };
  if (Array.isArray(input.providers)) {
    payload.providers = input.providers.map(String);
  }
  return guestCommand(payload, 60000);
};

const telemetryStatus = (input = {}) =>
  guestCommand({ cmd: "etw_status", name: TELEMETRY_NAME(input.name) }, 60000);

const telemetryStop = (input = {}) =>
  guestCommand({ cmd: "etw_stop", name: TELEMETRY_NAME(input.name) }, 120000);

const telemetryFetch = async (input = {}) => {
  const name = TELEMETRY_NAME(input.name);
  const status = await guestCommand({ cmd: "etw_status", name }, 60000);
  const guestFile = status?.file?.path;
  if (!guestFile) {
    throw new Error(`no trace file for ${name}; start and stop a trace first`);
  }
  const target = join(EXPORTS, "telemetry", basename(guestFile));
  const copied = await copyGuestFileToHost(guestFile, target, {
    overwrite: input.overwrite === true,
    maxBytes: 512 * 1024 * 1024,
  });
  let summary = null;
  if (input.summary !== false) {
    const summaryPath = join(
      dirname(target),
      `${basename(target).replace(/\.etl$/i, "")}.summary.txt`,
    );
    try {
      execFileSync(TRACERPT, [target, "-summary", summaryPath, "-y"], {
        encoding: "utf8",
        timeout: 60000,
        windowsHide: true,
      });
      const text = readFileSync(summaryPath, "utf8");
      summary = {
        ok: true,
        host_path: summaryPath,
        bytes: statSync(summaryPath).size,
        sha256: sha256File(summaryPath),
        summary: text.length > 12000 ? `${text.slice(0, 12000)}...` : text,
        note: "summary generated on the host from the exported ETL; it does not block the guest agent",
      };
    } catch (error) {
      summary = {
        ok: false,
        error: String(error?.stderr ?? error?.message ?? error),
      };
    }
  }
  return {
    name,
    etl: {
      guest_path: guestFile,
      host_path: target,
      bytes: copied.bytes,
      sha256: copied.sha256,
      guest_sha256: copied.guest_sha256,
      match: copied.sha256 === copied.guest_sha256,
    },
    summary,
  };
};

const BROKERS = join(HOME, "brokers");

const validateBrokerName = (value) => {
  const name = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(name) || name === "." || name === "..") {
    throw new Error("broker name must match [A-Za-z0-9._-]{1,32}");
  }
  return name;
};

const brokerPath = (name) => join(BROKERS, validateBrokerName(name));
const brokerManifestPath = (name) => join(brokerPath(name), "manifest.json");

const readJsonFile = (path, fallback = null) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJsonFile = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
};

const loadBroker = (name) => {
  const manifest = readJsonFile(brokerManifestPath(name));
  if (!manifest)
    throw new Error(`broker not found: ${validateBrokerName(name)}`);
  return manifest;
};

const saveBroker = (name, manifest) => {
  manifest.updated_at = new Date().toISOString();
  writeJsonFile(brokerManifestPath(name), manifest);
  return manifest;
};

const auditBroker = (name, entry) => {
  mkdirSync(brokerPath(name), { recursive: true });
  appendFileSync(
    join(brokerPath(name), "audit.jsonl"),
    `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`,
    "utf8",
  );
};

const safeRel = (value) => {
  const rel = String(value ?? "")
    .replaceAll("\\", "/")
    .trim();
  if (
    !rel ||
    rel.length > 300 ||
    rel.startsWith("/") ||
    /^[A-Za-z]:/.test(rel)
  ) {
    throw new Error("relative path must be a non-empty relative path");
  }
  const parts = rel.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("relative path must not contain empty, . or .. segments");
  }
  return rel;
};

const joinGuest = (dir, rel) =>
  `${String(dir).replace(/[\\/]+$/, "")}\\${rel.replaceAll("/", "\\")}`;

const brokerInit = (input = {}) => {
  const name = validateBrokerName(input.name);
  const dir = brokerPath(name);
  const existing = readJsonFile(brokerManifestPath(name));
  if (existing && input.reset !== true) {
    return { name, created: false, manifest: existing, dir };
  }
  mkdirSync(join(dir, "lower"), { recursive: true });
  mkdirSync(join(dir, "upper"), { recursive: true });
  const manifest = existing ?? {
    schema: 1,
    name,
    mode: "cow",
    created_at: new Date().toISOString(),
    lower: {},
    upper: {},
    deployed: {},
  };
  if (input.reset === true) {
    rmSync(join(dir, "upper"), { recursive: true, force: true });
    mkdirSync(join(dir, "upper"), { recursive: true });
    manifest.upper = {};
    manifest.deployed = {};
  }
  saveBroker(name, manifest);
  auditBroker(name, { action: existing ? "reset" : "init" });
  return {
    name,
    created: !existing,
    reset: input.reset === true,
    manifest,
    dir,
  };
};

const brokerPut = (input = {}) => {
  const name = validateBrokerName(input.name);
  const manifest = loadBroker(name);
  const source = resolve(String(input.host_path ?? ""));
  if (!isAbsolute(source)) throw new Error("host_path must be absolute");
  const info = lstatSync(source);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("host_path must be a regular file, not a symlink");
  }
  if (info.size > 2 * 1024 * 1024 * 1024)
    throw new Error("host_path exceeds 2 GiB");
  const rel = safeRel(input.as ?? basename(source));
  const target = join(brokerPath(name), "lower", rel);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  const entry = {
    bytes: statSync(target).size,
    sha256: sha256File(target),
    source,
    added_at: new Date().toISOString(),
  };
  manifest.lower[rel] = entry;
  saveBroker(name, manifest);
  auditBroker(name, { action: "put", rel, ...entry });
  return { name, rel, host_path: target, ...entry };
};

const brokerStatus = (input = {}) => {
  const name = validateBrokerName(input.name);
  const manifest = loadBroker(name);
  const dir = brokerPath(name);
  const size = (sub) => {
    let total = 0;
    const walk = (path) => {
      for (const item of readdirSync(path, { withFileTypes: true })) {
        if (item.isDirectory()) walk(join(path, item.name));
        else total += statSync(join(path, item.name)).size;
      }
    };
    try {
      walk(join(dir, sub));
    } catch {
      // missing upper is fine
    }
    return total;
  };
  return {
    name,
    dir,
    mode: manifest.mode,
    lower_files: Object.keys(manifest.lower).length,
    upper_files: Object.keys(manifest.upper).length,
    deployed_files: Object.keys(manifest.deployed).length,
    lower_bytes: size("lower"),
    upper_bytes: size("upper"),
    created_at: manifest.created_at,
    updated_at: manifest.updated_at,
    manifest,
  };
};

const brokerList = (input = {}) => {
  const name = validateBrokerName(input.name);
  const manifest = loadBroker(name);
  return {
    name,
    lower: Object.entries(manifest.lower).map(([rel, entry]) => ({
      rel,
      ...entry,
    })),
    upper: Object.entries(manifest.upper).map(([rel, entry]) => ({
      rel,
      ...entry,
    })),
    deployed: Object.entries(manifest.deployed).map(([rel, entry]) => ({
      rel,
      ...entry,
    })),
  };
};

const brokerDeploy = async (input = {}) => {
  const name = validateBrokerName(input.name);
  const manifest = loadBroker(name);
  const guestDir = validateGuestPath(input.guest_dir);
  const files = Array.isArray(input.files)
    ? input.files.map((item) => safeRel(item))
    : Object.keys(manifest.lower);
  if (!files.length)
    throw new Error("broker lower is empty; call broker_put first");
  const deployed = [];
  for (const rel of files) {
    const entry = manifest.lower[rel];
    if (!entry) throw new Error(`not in broker lower: ${rel}`);
    const source = join(brokerPath(name), "lower", rel);
    const guestPath = joinGuest(guestDir, rel);
    const copied = await copyHostFileToGuest(source, guestPath);
    manifest.deployed[rel] = {
      guest_path: guestPath,
      bytes: copied.bytes,
      sha256: copied.guest_sha256,
      source_sha256: copied.sha256,
      deployed_at: new Date().toISOString(),
    };
    deployed.push({ rel, guest_path: guestPath, ...copied });
    auditBroker(name, {
      action: "deploy",
      rel,
      guest_path: guestPath,
      sha256: copied.guest_sha256,
    });
  }
  saveBroker(name, manifest);
  return { name, guest_dir: guestDir, deployed };
};

const brokerDiff = async (input = {}) => {
  const name = validateBrokerName(input.name);
  const manifest = loadBroker(name);
  const guestDir = validateGuestPath(input.guest_dir);
  const tree = await guestLsTree({
    path: guestDir,
    max: input.max === undefined ? 20000 : input.max,
    depth: input.depth === undefined ? 32 : input.depth,
    hash: true,
  });
  if (!tree || tree.ok !== true)
    throw new Error(`guest ls_tree failed: ${JSON.stringify(tree)}`);
  const observed = new Map();
  for (const entry of tree.entries) {
    if (!entry.directory) {
      observed.set(String(entry.rel).replaceAll("\\", "/"), entry);
    }
  }
  const changes = [];
  for (const [rel, deployed] of Object.entries(manifest.deployed)) {
    const seen = observed.get(rel);
    if (!seen) {
      changes.push({
        rel,
        change: "deleted",
        expected_sha256: deployed.sha256,
      });
      continue;
    }
    const expected = manifest.lower[rel]?.sha256;
    if (expected && seen.sha256 && seen.sha256 !== expected) {
      changes.push({
        rel,
        change: "modified",
        expected_sha256: expected,
        actual_sha256: seen.sha256,
        bytes: seen.bytes,
      });
    }
  }
  for (const [rel, seen] of observed) {
    if (!manifest.deployed[rel] && !manifest.lower[rel]) {
      changes.push({
        rel,
        change: "created",
        actual_sha256: seen.sha256 ?? null,
        bytes: seen.bytes,
      });
    }
  }
  return {
    name,
    guest_dir: guestDir,
    observed_files: observed.size,
    changes,
    truncated: tree.truncated === true,
  };
};

const brokerHarvest = async (input = {}) => {
  const name = validateBrokerName(input.name);
  const manifest = loadBroker(name);
  const guestDir = validateGuestPath(input.guest_dir);
  const diff = await brokerDiff({
    name,
    guest_dir: guestDir,
    ...(input.max === undefined ? {} : { max: input.max }),
    ...(input.depth === undefined ? {} : { depth: input.depth }),
  });
  const wanted = Array.isArray(input.files)
    ? new Set(input.files.map((item) => safeRel(item)))
    : null;
  const candidates = diff.changes.filter(
    (change) => change.change === "modified" || change.change === "created",
  );
  const selected = candidates.filter(
    (change) => !wanted || wanted.has(change.rel),
  );
  const harvested = [];
  for (const change of selected) {
    const guestPath = joinGuest(guestDir, change.rel);
    const target = join(brokerPath(name), "upper", change.rel);
    const copied = await copyGuestFileToHost(guestPath, target, {
      overwrite: true,
      maxBytes: 128 * 1024 * 1024,
    });
    manifest.upper[change.rel] = {
      bytes: copied.bytes,
      sha256: copied.sha256,
      guest_sha256: copied.guest_sha256,
      change: change.change,
      harvested_at: new Date().toISOString(),
    };
    harvested.push({ rel: change.rel, change: change.change, ...copied });
    auditBroker(name, {
      action: "harvest",
      rel: change.rel,
      change: change.change,
      sha256: copied.sha256,
    });
  }
  saveBroker(name, manifest);
  return { name, guest_dir: guestDir, harvested, changes: diff.changes };
};

const brokerCommit = (input = {}) => {
  if (input.confirm !== true) {
    throw new Error(
      "broker_commit writes into a host directory; pass confirm: true",
    );
  }
  const name = validateBrokerName(input.name);
  const manifest = loadBroker(name);
  const targetDir = resolve(String(input.target_dir ?? ""));
  if (!isAbsolute(targetDir)) throw new Error("target_dir must be absolute");
  const entries = Object.entries(manifest.upper);
  if (!entries.length) return { name, committed: [], note: "upper is empty" };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = join(HOME, "backups", `broker-${name}-${stamp}`);
  const committed = [];
  for (const [rel, entry] of entries) {
    const source = join(brokerPath(name), "upper", rel);
    const target = resolve(join(targetDir, rel));
    if (!(target === targetDir || target.startsWith(targetDir + sep))) {
      throw new Error(`path escape: ${rel}`);
    }
    let backup = null;
    if (existsSync(target)) {
      backup = join(backupRoot, rel);
      mkdirSync(dirname(backup), { recursive: true });
      copyFileSync(target, backup);
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    committed.push({
      rel,
      target,
      bytes: statSync(target).size,
      sha256: sha256File(target),
      upper_sha256: entry.sha256,
      backup,
    });
    auditBroker(name, { action: "commit", rel, target, backup });
  }
  manifest.committed_at = new Date().toISOString();
  manifest.committed_to = targetDir;
  saveBroker(name, manifest);
  return { name, target_dir: targetDir, backup_dir: backupRoot, committed };
};

const brokerReset = (input = {}) => {
  const name = validateBrokerName(input.name);
  const dir = brokerPath(name);
  if (input.scope === "all") {
    if (input.confirm !== true)
      throw new Error(
        "broker_reset scope=all removes the broker; pass confirm: true",
      );
    rmSync(dir, { recursive: true, force: true });
    return { name, dropped: true };
  }
  const manifest = loadBroker(name);
  rmSync(join(dir, "upper"), { recursive: true, force: true });
  mkdirSync(join(dir, "upper"), { recursive: true });
  manifest.upper = {};
  manifest.deployed = {};
  saveBroker(name, manifest);
  auditBroker(name, { action: "reset_upper" });
  return { name, reset: "upper", manifest };
};

const evidenceExport = async (input = {}) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const label = input.label
    ? String(input.label)
        .replace(/[^A-Za-z0-9._-]/g, "-")
        .slice(0, 32)
    : "";
  const dir = join(EXPORTS, `evidence-${stamp}${label ? `-${label}` : ""}`);
  if (existsSync(dir))
    throw new Error(`evidence directory already exists: ${dir}`);
  mkdirSync(dir, { recursive: true });
  const artifacts = [];
  const addJson = (name, value) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
    artifacts.push({
      path: name,
      bytes: statSync(path).size,
      sha256: sha256File(path),
    });
  };
  let degraded = false;
  addJson("host-profile.json", readProfile() ?? { missing: true });
  try {
    addJson("qemu-status.json", await status());
  } catch (error) {
    degraded = true;
    addJson("qemu-status.error.json", {
      error: String(error?.message ?? error),
    });
  }
  try {
    addJson("guest-identity.json", await guestIdentity());
  } catch (error) {
    degraded = true;
    addJson("guest-identity.error.json", {
      error: String(error?.message ?? error),
    });
  }
  try {
    addJson("guest-profile.json", await guestProfile());
  } catch (error) {
    degraded = true;
    addJson("guest-profile.error.json", {
      error: String(error?.message ?? error),
    });
  }
  const captures = [];
  try {
    for (const name of readdirSync(LOGS)) {
      if (!name.endsWith(".pcap")) continue;
      const path = join(LOGS, name);
      captures.push({
        file: path,
        bytes: statSync(path).size,
        sha256: sha256File(path),
      });
    }
  } catch {
    // no logs yet
  }
  addJson("captures.json", { pcap: captures });
  try {
    const tail = readFileSync(LOG, "utf8")
      .trimEnd()
      .split(/\r?\n/)
      .slice(-200)
      .join("\n");
    const path = join(dir, "qemu-log-tail.txt");
    writeFileSync(path, tail, "utf8");
    artifacts.push({
      path: "qemu-log-tail.txt",
      bytes: statSync(path).size,
      sha256: sha256File(path),
    });
  } catch {
    // missing log is fine
  }
  try {
    const brokers = [];
    for (const name of readdirSync(BROKERS)) {
      const manifest = readJsonFile(brokerManifestPath(name));
      if (manifest) brokers.push(manifest);
    }
    addJson("brokers.json", brokers);
  } catch {
    // no brokers
  }
  const manifest = {
    schema: 1,
    kind: "external-observation",
    created_at: new Date().toISOString(),
    label: label || null,
    degraded,
    note: "Workbench external observations. This is not REA core Evidence; importing it requires an adapter and must not be treated as canonical Evidence.",
    artifacts,
  };
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return {
    dir,
    manifest: manifestPath,
    artifacts: artifacts.length,
    degraded,
  };
};

const guestWatchStart = (input = {}) =>
  guestRequest({
    cmd: "watch_start",
    path: validateGuestPath(input.path),
    recursive: input.recursive === true,
    ...(input.id === undefined ? {} : { id: String(input.id) }),
  });
const guestWatchPoll = (input = {}) =>
  guestRequest({
    cmd: "watch_poll",
    id: String(input.id ?? ""),
    ...(input.max === undefined ? {} : { max: input.max }),
  });
const guestWatchStop = (input = {}) =>
  guestRequest({ cmd: "watch_stop", id: String(input.id ?? "") });

const guestCommand = (payload, timeoutMs = 60000) =>
  guestRequest(payload, timeoutMs);

const validateRegPath = (value) => {
  const path = String(value ?? "").trim();
  if (!/^(HKLM|HKCU|HKCR|HKU|HKCC|HKEY_[A-Z_]+)[:\\/]/i.test(path)) {
    throw new Error(
      "registry path must start with HKLM/HKCU/HKCR/HKU/HKCC/HKEY_...",
    );
  }
  if (!path || path.length > 512 || /[\0\r\n]/.test(path)) {
    throw new Error(
      "registry path is empty, too long, or contains control characters",
    );
  }
  return path;
};

const REG_TYPES = [
  "String",
  "ExpandString",
  "DWord",
  "QWord",
  "Binary",
  "MultiString",
];

const guestWhoami = () => guestCommand({ cmd: "whoami" }, 30000);
const guestIdentity = () => guestCommand({ cmd: "identity" }, 30000);
const guestNetConns = () => guestCommand({ cmd: "net_conns" }, 30000);
const guestDnsCache = () => guestCommand({ cmd: "dns_cache" }, 30000);
const guestAutoruns = () => guestCommand({ cmd: "autoruns" }, 60000);

const guestServices = (input = {}) => {
  const filter = String(input.filter ?? "").trim();
  if (filter.length > 96 || /[\0\r\n]/.test(filter)) {
    throw new Error(
      "filter must be at most 96 chars without control characters",
    );
  }
  return guestCommand(
    { cmd: "services", ...(filter ? { filter } : {}) },
    60000,
  );
};

const guestEventlog = (input = {}) => {
  const log = String(input.log ?? "System").trim();
  if (!log || log.length > 96 || /[\0\r\n]/.test(log)) {
    throw new Error("log must be 1-96 chars without control characters");
  }
  const max = input.max === undefined ? 50 : Number(input.max);
  if (!Number.isInteger(max) || max < 1 || max > 500) {
    throw new Error("max must be an integer between 1 and 500");
  }
  const payload = { cmd: "eventlog", log, max };
  if (input.level !== undefined) payload.level = String(input.level).trim();
  if (input.since_minutes !== undefined) {
    const minutes = Number(input.since_minutes);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 100000) {
      throw new Error("since_minutes must be a non-negative number");
    }
    payload.since_minutes = minutes;
  }
  return guestCommand(payload, 60000);
};

const guestRegRead = (input = {}) => {
  const payload = { cmd: "reg_read", path: validateRegPath(input.path) };
  if (input.name !== undefined) {
    const name = String(input.name);
    if (name.length > 255 || /[\0\r\n]/.test(name))
      throw new Error("invalid registry value name");
    payload.name = name;
  }
  return guestCommand(payload, 30000);
};

const guestRegWrite = (input = {}) => {
  if (input.confirm !== true) {
    throw new Error("guest_reg_write changes guest state; pass confirm: true");
  }
  const path = validateRegPath(input.path);
  const name = String(input.name ?? "").trim();
  if (!name || name.length > 255 || /[\0\r\n]/.test(name)) {
    throw new Error(
      "registry value name is required and must be at most 255 chars",
    );
  }
  const type = String(input.type ?? "String");
  if (!REG_TYPES.includes(type))
    throw new Error(`type must be one of ${REG_TYPES.join(", ")}`);
  if (input.value === undefined || input.value === null)
    throw new Error("value is required");
  return guestCommand(
    { cmd: "reg_write", path, name, type, value: input.value },
    30000,
  );
};

const guestStat = (path) =>
  guestCommand({ cmd: "stat", path: validateGuestPath(path) }, 60000);

const guestLsTree = (input = {}) => {
  const max = input.max === undefined ? 5000 : Number(input.max);
  const depth = input.depth === undefined ? 16 : Number(input.depth);
  if (!Number.isInteger(max) || max < 1 || max > 50000)
    throw new Error("max must be 1..50000");
  if (!Number.isInteger(depth) || depth < 0 || depth > 64)
    throw new Error("depth must be 0..64");
  return guestCommand(
    {
      cmd: "ls_tree",
      path: validateGuestPath(input.path),
      max,
      depth,
      hash: input.hash === true,
    },
    180000,
  );
};

const guestChannels = async () => {
  const probe = async (port) => {
    try {
      const result = await guestRequest({ cmd: "ping" }, 4000, port);
      return { port, reachable: true, ...result };
    } catch (error) {
      return { port, reachable: false, error: String(error?.message ?? error) };
    }
  };
  const [system, user] = await Promise.all([
    probe(GUEST_PORT),
    probe(GUEST_PORT_USER),
  ]);
  return { system, user };
};

const copyHostFileToGuest = async (
  hostPath,
  guestPath,
  { append = false } = {},
) => {
  const source = resolve(String(hostPath));
  if (!isAbsolute(source)) throw new Error("host_path must be absolute");
  const info = lstatSync(source);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("host_path must be a regular file, not a symlink");
  }
  if (info.size === 0)
    throw new Error("empty files are not supported by agent write");
  const bytes = readFileSync(source);
  const chunkSize = 8 * 1024 * 1024;
  let offset = 0;
  let first = true;
  while (offset < bytes.length) {
    const end = Math.min(offset + chunkSize, bytes.length);
    const chunk = bytes.subarray(offset, end);
    const result = await guestCommand(
      {
        cmd: "write",
        path: guestPath,
        base64: chunk.toString("base64"),
        append: first ? append === true : true,
      },
      60000,
    );
    if (!result || result.ok !== true) {
      throw new Error(`guest write failed: ${JSON.stringify(result)}`);
    }
    offset = end;
    first = false;
  }
  const stat = await guestStat(guestPath);
  if (!stat.ok) throw new Error(`guest stat failed: ${JSON.stringify(stat)}`);
  return {
    bytes: bytes.length,
    sha256: sha256File(source),
    guest_sha256: stat.sha256,
  };
};

const copyGuestFileToHost = async (
  guestPath,
  hostPath,
  {
    maxBytes = 512 * 1024 * 1024,
    overwrite = false,
    chunkSize = 8 * 1024 * 1024,
  } = {},
) => {
  const stat = await guestStat(guestPath);
  if (!stat || stat.ok !== true) {
    throw new Error(`guest stat failed: ${JSON.stringify(stat)}`);
  }
  if (stat.directory) throw new Error("guest path is a directory");
  if (stat.bytes > maxBytes)
    throw new Error(`guest file exceeds ${maxBytes} bytes`);
  if (existsSync(hostPath) && overwrite !== true) {
    throw new Error(`host target exists: ${hostPath}; pass overwrite: true`);
  }
  mkdirSync(dirname(hostPath), { recursive: true });
  writeFileSync(hostPath, Buffer.alloc(0));
  let offset = 0;
  while (offset < stat.bytes) {
    const length = Math.min(chunkSize, stat.bytes - offset);
    const result = await guestCommand(
      { cmd: "read", path: guestPath, offset, max_bytes: length },
      60000,
    );
    if (!result || result.ok !== true || typeof result.base64 !== "string") {
      throw new Error(`guest read failed: ${JSON.stringify(result)}`);
    }
    const buffer = Buffer.from(result.base64, "base64");
    if (buffer.length !== result.bytes) {
      throw new Error(
        `guest read chunk length mismatch: ${buffer.length} != ${result.bytes}`,
      );
    }
    appendFileSync(hostPath, buffer);
    if (buffer.length === 0) break;
    offset += buffer.length;
  }
  const actual = statSync(hostPath).size;
  if (actual !== stat.bytes) {
    throw new Error(`copied size mismatch: ${actual} != ${stat.bytes}`);
  }
  return {
    bytes: actual,
    sha256: sha256File(hostPath),
    guest_sha256: stat.sha256,
  };
};

const guestCopyIn = async (input = {}) => {
  const source = resolve(String(input.host_path ?? ""));
  if (!isAbsolute(source)) throw new Error("host_path must be absolute");
  const info = lstatSync(source);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("host_path must be a regular file, not a symlink");
  }
  if (info.size > 64 * 1024 * 1024) throw new Error("host_path exceeds 64 MiB");
  if (info.size === 0)
    throw new Error("empty files are not supported by agent write");
  const guestPath = validateGuestPath(input.guest_path);
  const copied = await copyHostFileToGuest(source, guestPath);
  return {
    host_path: source,
    guest_path: guestPath,
    bytes: copied.bytes,
    sha256: copied.sha256,
    guest_sha256: copied.guest_sha256,
    match: copied.sha256 === copied.guest_sha256,
  };
};

const guestCopyOut = async (input = {}) => {
  const guestPath = validateGuestPath(input.guest_path);
  const name = basename(guestPath);
  if (!name || name === "." || name === "..")
    throw new Error("invalid guest file name");
  const target = join(EXPORTS, name);
  if (existsSync(target) && input.overwrite !== true) {
    throw new Error(`export target exists: ${target}; pass overwrite: true`);
  }
  const copied = await copyGuestFileToHost(guestPath, target, {
    maxBytes: 512 * 1024 * 1024,
    overwrite: input.overwrite === true,
  });
  return {
    guest_path: guestPath,
    host_path: target,
    bytes: copied.bytes,
    sha256: copied.sha256,
    guest_sha256: copied.guest_sha256,
    match: copied.sha256 === copied.guest_sha256,
  };
};

const PCAP_ID = "rea-pcap";

const pcapStart = async (input = {}) => {
  ensureLayout();
  if (!(await portOpen(QMP_PORT))) {
    throw new Error("The guest must be running to start a pcap filter.");
  }
  const netdev = String(input.netdev ?? "net0").trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(netdev)) {
    throw new Error("netdev must match [A-Za-z0-9_-]{1,32}");
  }
  const file =
    input.path === undefined
      ? join(LOGS, `net-${Date.now()}.pcap`)
      : underLogs(input.path);
  mkdirSync(dirname(file), { recursive: true });
  await qmp("object-add", {
    "qom-type": "filter-dump",
    id: PCAP_ID,
    netdev,
    file: file.replaceAll("\\", "/"),
  });
  return {
    id: PCAP_ID,
    netdev,
    file,
    note: "QMP filter-dump is attached at runtime; call pcap_stop to remove it and hash the file.",
  };
};

const pcapStop = async () => {
  ensureLayout();
  if (!(await portOpen(QMP_PORT))) {
    throw new Error("The guest must be running to stop the pcap filter.");
  }
  await qmp("object-del", { id: PCAP_ID });
  const candidates = [];
  const dir = LOGS;
  try {
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".pcap")) {
        const file = join(dir, name);
        candidates.push({
          file,
          bytes: statSync(file).size,
          sha256: sha256File(file),
        });
      }
    }
  } catch {
    // ignore listing failures
  }
  return { id: PCAP_ID, stopped: true, captures: candidates };
};

const memoryDump = async (input = {}) => {
  ensureLayout();
  if (!(await portOpen(QMP_PORT))) {
    throw new Error("The guest must be running for a physical memory dump.");
  }
  const sizeMb = Math.max(1, Math.min(1024, Number(input.size_mb ?? 64)));
  const offset = Math.max(0, Number(input.offset ?? 0));
  if (!Number.isInteger(sizeMb) || !Number.isInteger(offset)) {
    throw new Error("size_mb and offset must be integers");
  }
  const size = sizeMb * 1024 * 1024;
  const file =
    input.path === undefined
      ? join(LOGS, `memory-${Date.now()}.bin`)
      : underLogs(input.path);
  mkdirSync(dirname(file), { recursive: true });
  const output = (
    await hmp(
      `pmemsave 0x${offset.toString(16)} 0x${size.toString(16)} ${file.replaceAll("\\", "/")}`,
    )
  ).trim();
  if (/error|invalid|failed|cannot/i.test(output)) {
    throw new Error(output || "pmemsave failed");
  }
  return {
    file,
    offset,
    size_mb: sizeMb,
    bytes: statSync(file).size,
    sha256: sha256File(file),
    note: "Guest physical memory dump; not a full-system forensic capture.",
  };
};

const logs = (input = {}) => {
  ensureLayout();
  const lines = Math.max(1, Math.min(2000, Number(input.lines ?? 120)));
  try {
    const content = readFileSync(LOG, "utf8").trimEnd().split(/\r?\n/);
    return {
      log: LOG,
      lines: content.slice(-lines).join("\n"),
      total_lines: content.length,
    };
  } catch {
    return { log: LOG, lines: "", total_lines: 0 };
  }
};

const TOOLS = [
  {
    name: "status",
    description:
      "Report QEMU workbench state, disk size, monitor/VNC endpoints, and HMP status when running.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: () => status(),
  },
  {
    name: "start",
    description:
      "Start the installed Windows guest under QEMU/WHPX. Defaults: qemu64,+sse4.2,+popcnt, 8 GiB RAM, VNC 127.0.0.1:1, shared removable disk.",
    inputSchema: {
      type: "object",
      properties: {
        cpu: { type: "string" },
        memory_mb: { type: "integer", minimum: 1024, maximum: 32768 },
        mac: { type: "string" },
        vnc: { type: "string" },
        disk_serial: { type: "string" },
        smbios: {
          type: "object",
          properties: {
            manufacturer: { type: "string" },
            product: { type: "string" },
            version: { type: "string" },
            serial: { type: "string" },
            uuid: { type: "string" },
          },
          additionalProperties: false,
        },
        share: { type: "boolean", default: true },
        gdb: { type: "boolean", default: false },
        pcap_path: { type: "string" },
      },
      additionalProperties: false,
    },
    handler: (input) => start(input),
  },
  {
    name: "stop",
    description:
      "Request ACPI powerdown, fall back to QEMU quit, then force-kill if needed.",
    inputSchema: {
      type: "object",
      properties: { force: { type: "boolean", default: false } },
      additionalProperties: false,
    },
    handler: (input) => stop(input),
  },
  {
    name: "snapshot",
    description:
      "Create a qcow2 snapshot. While stopped uses qemu-img snapshot -c; while running tries HMP savevm, which WHPX may refuse (missing dirty-memory/system-state support).",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    handler: (input) => snapshot(input),
  },
  {
    name: "restore",
    description:
      "Restore a qcow2 snapshot. While running uses HMP loadvm; while stopped uses qemu-img snapshot -a.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    handler: (input) => restore(input),
  },
  {
    name: "import",
    description:
      "Copy one host file into the workbench share directory; the guest sees it on the shared removable disk. Host writes, not guest-write proxy.",
    inputSchema: {
      type: "object",
      properties: {
        host_path: { type: "string" },
        overwrite: { type: "boolean", default: false },
      },
      required: ["host_path"],
      additionalProperties: false,
    },
    handler: (input) => importFile(input),
  },
  {
    name: "guest_ping",
    description:
      "Ping the guest agent over QEMU hostfwd. Requires guest/agent.ps1 running inside the guest.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: () => guestPing(),
  },
  {
    name: "guest_ps",
    description: "List guest processes through guest/agent.ps1.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: () => guestPs(),
  },
  {
    name: "guest_profile",
    description:
      "Read guest computer/BIOS/OS/disk/NIC identity through guest/agent.ps1 for profile consistency checks.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: () => guestProfile(),
  },
  {
    name: "guest_watch_start",
    description:
      "Start a FileSystemWatcher inside the guest for one directory. Returns a watch id; poll it with guest_watch_poll.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean", default: false },
        id: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: (input) => guestWatchStart(input),
  },
  {
    name: "guest_watch_poll",
    description:
      "Drain up to max FileSystemWatcher events for a guest watch id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        max: { type: "integer", minimum: 1, maximum: 5000 },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: (input) => guestWatchPoll(input),
  },
  {
    name: "guest_watch_stop",
    description: "Stop a guest FileSystemWatcher and return its log path.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    handler: (input) => guestWatchStop(input),
  },
  {
    name: "profile",
    description:
      "Return the host-side profile seed written by the last start (CPU/RAM/MAC/disk serial/SMBIOS).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: () => {
      const profile = readProfile();
      if (!profile)
        throw new Error(`no profile at ${PROFILE_FILE}; start the guest first`);
      return { profile_file: PROFILE_FILE, profile };
    },
  },
  {
    name: "profile_check",
    description:
      "Compare the last host profile seed with guest_computer/BIOS/disk/NIC identity read by guest_profile.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: () => profileCheck(),
  },
  {
    name: "guest_copy_in",
    description:
      "Copy one host file into the guest through guest/agent.ps1 in 8 MiB chunks. Max 64 MiB; returns both hashes.",
    inputSchema: {
      type: "object",
      properties: {
        host_path: { type: "string" },
        guest_path: { type: "string" },
      },
      required: ["host_path", "guest_path"],
      additionalProperties: false,
    },
    handler: (input) => guestCopyIn(input),
  },
  {
    name: "guest_copy_out",
    description:
      "Copy one guest file to the workbench exports directory in 8 MiB chunks. Max 512 MiB; returns both hashes.",
    inputSchema: {
      type: "object",
      properties: {
        guest_path: { type: "string" },
        overwrite: { type: "boolean", default: false },
      },
      required: ["guest_path"],
      additionalProperties: false,
    },
    handler: (input) => guestCopyOut(input),
  },
  {
    name: "guest_ls",
    description: "List a guest directory through guest/agent.ps1.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    handler: (input) => guestLs(input),
  },
  {
    name: "guest_read",
    description:
      "Read a guest file through guest/agent.ps1 and return base64 plus SHA-256. Max 16 MiB.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        max_bytes: { type: "integer", minimum: 1, maximum: 16777216 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: (input) => guestRead(input),
  },
  {
    name: "guest_write",
    description:
      "Write a guest file through guest/agent.ps1 from base64. Max 16 MiB payload.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        data_base64: { type: "string" },
        append: { type: "boolean", default: false },
      },
      required: ["path", "data_base64"],
      additionalProperties: false,
    },
    handler: (input) => guestWrite(input),
  },
  {
    name: "guest_launch",
    description:
      "Launch a guest process through guest/agent.ps1 and return its PID.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        arguments: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: (input) => guestLaunch(input),
  },
  {
    name: "resume",
    description:
      "Resume a paused QEMU VM with HMP cont. Use this when VNC clicks stop responding and status shows paused.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: () => resumeVm(),
  },
  {
    name: "pause",
    description: "Pause the QEMU VM with HMP stop.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: () => pauseVm(),
  },
  {
    name: "gdb_status",
    description:
      "Query the QEMU gdbstub stop reply. Attaching stops the guest briefly; the tool resumes it by default.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: () => gdbStatus(),
  },
  {
    name: "gdb_registers",
    description:
      "Read x86_64 GPRs/RIP/EFLAGS through the QEMU gdbstub. Default resumes the guest after reading.",
    inputSchema: {
      type: "object",
      properties: { resume: { type: "boolean", default: true } },
      additionalProperties: false,
    },
    handler: (input) => gdbRegisters(input),
  },
  {
    name: "gdb_read_memory",
    description:
      "Read guest virtual memory through the QEMU gdbstub. Max 1 MiB; default resumes the guest.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string" },
        length: { type: "integer", minimum: 1, maximum: 1048576 },
        resume: { type: "boolean", default: true },
      },
      required: ["address"],
      additionalProperties: false,
    },
    handler: (input) => gdbReadMemory(input),
  },
  {
    name: "gdb_write_memory",
    description:
      "Write guest virtual memory through the QEMU gdbstub. Max 64 KiB; default resumes the guest.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string" },
        hex: { type: "string" },
        resume: { type: "boolean", default: true },
      },
      required: ["address", "hex"],
      additionalProperties: false,
    },
    handler: (input) => gdbWriteMemory(input),
  },
  {
    name: "gdb_break",
    description:
      "Set a software breakpoint through the QEMU gdbstub. Default resumes after setting it.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string" },
        kind: { type: "integer", minimum: 1, maximum: 16 },
        resume: { type: "boolean", default: true },
      },
      required: ["address"],
      additionalProperties: false,
    },
    handler: (input) => gdbBreak(input),
  },
  {
    name: "gdb_unbreak",
    description:
      "Remove a software breakpoint through the QEMU gdbstub. Default resumes after removal.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string" },
        kind: { type: "integer", minimum: 1, maximum: 16 },
        resume: { type: "boolean", default: true },
      },
      required: ["address"],
      additionalProperties: false,
    },
    handler: (input) => gdbUnbreak(input),
  },
  {
    name: "gdb_continue",
    description: "Resume the guest through the QEMU gdbstub.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: () => gdbContinue(),
  },
  {
    name: "gdb_interrupt",
    description: "Send Ctrl-C to the QEMU gdbstub and return the stop reply.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: () => gdbInterrupt(),
  },
  {
    name: "gdb_step",
    description:
      "Single-step one instruction through the QEMU gdbstub; leaves the guest stopped.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: () => gdbStep(),
  },
  {
    name: "pcap_start",
    description:
      "Attach a QEMU filter-dump to the running guest's user-mode network. Writes only under the workbench logs directory.",
    inputSchema: {
      type: "object",
      properties: {
        netdev: { type: "string" },
        path: { type: "string" },
      },
      additionalProperties: false,
    },
    handler: (input) => pcapStart(input),
  },
  {
    name: "pcap_stop",
    description:
      "Remove the runtime pcap filter and return existing pcap files with size and SHA-256.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: () => pcapStop(),
  },
  {
    name: "memory_dump",
    description:
      "Dump a bounded range of guest physical memory with HMP pmemsave. Requires a running guest; writes only under the workbench logs directory.",
    inputSchema: {
      type: "object",
      properties: {
        offset: { type: "integer", minimum: 0 },
        size_mb: { type: "integer", minimum: 1, maximum: 1024 },
        path: { type: "string" },
      },
      additionalProperties: false,
    },
    handler: (input) => memoryDump(input),
  },
  {
    name: "logs",
    description: "Tail the QEMU workbench log.",
    inputSchema: {
      type: "object",
      properties: { lines: { type: "integer", minimum: 1, maximum: 2000 } },
      additionalProperties: false,
    },
    handler: (input) => logs(input),
  },
  {
    name: "guest_channels",
    description:
      "Probe both guest agent channels: system (45999, SYSTEM task) and user (45998, interactive Run entry).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: () => guestChannels(),
  },
  {
    name: "guest_whoami",
    description:
      "Report the guest agent identity, SID, session, elevation, integrity level, and privileges.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: () => guestWhoami(),
  },
  {
    name: "guest_identity",
    description:
      "Read deep guest identity: MachineGuid, ProductId, install date, volume serial, BIOS registry strings, CPU registry strings, and firmware SMBIOS values.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: () => guestIdentity(),
  },
  {
    name: "guest_net_conns",
    description:
      "List guest TCP/UDP endpoints with owning process ids and names (T2 in-guest observation).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: () => guestNetConns(),
  },
  {
    name: "guest_services",
    description:
      "List guest services through the SYSTEM agent; optional substring filter.",
    inputSchema: {
      type: "object",
      properties: { filter: { type: "string" } },
      additionalProperties: false,
    },
    handler: (input) => guestServices(input),
  },
  {
    name: "guest_autoruns",
    description:
      "Collect guest autoruns: Run/RunOnce keys (32/64-bit), Startup folders, scheduled tasks, and auto-start services.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: () => guestAutoruns(),
  },
  {
    name: "guest_eventlog",
    description:
      "Query a guest event log (default System) with optional level and time window. Messages are truncated to 800 chars.",
    inputSchema: {
      type: "object",
      properties: {
        log: { type: "string" },
        max: { type: "integer", minimum: 1, maximum: 500 },
        level: { type: "string" },
        since_minutes: { type: "number", minimum: 0 },
      },
      additionalProperties: false,
    },
    handler: (input) => guestEventlog(input),
  },
  {
    name: "guest_dns_cache",
    description: "Read the guest DNS client cache.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: () => guestDnsCache(),
  },
  {
    name: "guest_reg_read",
    description:
      "Read one guest registry value, or enumerate a key's values and subkeys, through the SYSTEM agent.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        name: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: (input) => guestRegRead(input),
  },
  {
    name: "guest_reg_write",
    description:
      "Write one guest registry value through the SYSTEM agent. Requires confirm: true. Supports String, ExpandString, DWord, QWord, Binary, MultiString.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        name: { type: "string" },
        value: {
          type: ["string", "number", "array"],
          items: { type: "string" },
        },
        type: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["path", "name", "value", "confirm"],
      additionalProperties: false,
    },
    handler: (input) => guestRegWrite(input),
  },
  {
    name: "profile_apply",
    description:
      "Apply identity fields to the guest registry (MachineGuid, ProductId, BIOS strings, CPU name) and persist them through a SYSTEM startup task. Requires confirm: true. Firmware SMBIOS still comes from the QEMU start profile.",
    inputSchema: {
      type: "object",
      properties: {
        confirm: { type: "boolean" },
        machine_guid: { type: "string" },
        product_id: { type: "string" },
        computer_name: { type: "string" },
        cpu_name: { type: "string" },
        bios: {
          type: "object",
          properties: {
            BaseBoardManufacturer: { type: "string" },
            BaseBoardProduct: { type: "string" },
            BaseBoardSerialNumber: { type: "string" },
            BaseBoardVersion: { type: "string" },
            BIOSVendor: { type: "string" },
            BIOSVersion: { type: "string" },
            BIOSReleaseDate: { type: "string" },
            SystemManufacturer: { type: "string" },
            SystemProductName: { type: "string" },
            SystemSerialNumber: { type: "string" },
            SystemVersion: { type: "string" },
            SystemSKU: { type: "string" },
          },
          additionalProperties: false,
        },
        persist: { type: "boolean", default: true },
      },
      required: ["confirm"],
      additionalProperties: false,
    },
    handler: (input) => profileApply(input),
  },
  {
    name: "profile_verify",
    description:
      "Cross-check firmware SMBIOS, registry identity, and WMI identity, and optionally assert caller-supplied expected values.",
    inputSchema: {
      type: "object",
      properties: {
        expected: { type: "object" },
      },
      additionalProperties: false,
    },
    handler: (input) => profileVerify(input),
  },
  {
    name: "telemetry_start",
    description:
      "Start kernel ETW collection in the guest (logman provider file). Default providers: process, registry, network; add file for kernel file I/O. Files are written under C:\\ProgramData\\rea-workbench\\telemetry.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        providers: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    handler: (input) => telemetryStart(input),
  },
  {
    name: "telemetry_status",
    description:
      "Report whether a guest ETW session is running and the current ETL file size.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    },
    handler: (input) => telemetryStatus(input),
  },
  {
    name: "telemetry_stop",
    description:
      "Stop a guest ETW session and return the ETL path, size, and SHA-256.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    },
    handler: (input) => telemetryStop(input),
  },
  {
    name: "telemetry_fetch",
    description:
      "Copy a stopped ETL to the workbench exports directory in chunks, verify both hashes, and optionally run tracerpt for a summary.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        overwrite: { type: "boolean", default: false },
        summary: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
    handler: (input) => telemetryFetch(input),
  },
  {
    name: "broker_init",
    description:
      "Create or reset a host-side copy-on-write file broker (lower/upper) under the workbench home.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        reset: { type: "boolean", default: false },
      },
      required: ["name"],
      additionalProperties: false,
    },
    handler: (input) => brokerInit(input),
  },
  {
    name: "broker_put",
    description: "Copy one host file into the broker's immutable lower layer.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        host_path: { type: "string" },
        as: { type: "string" },
      },
      required: ["name", "host_path"],
      additionalProperties: false,
    },
    handler: (input) => brokerPut(input),
  },
  {
    name: "broker_status",
    description: "Report broker counts, byte usage, and the full manifest.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    handler: (input) => brokerStatus(input),
  },
  {
    name: "broker_list",
    description: "List broker lower, upper, and deployed entries.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    handler: (input) => brokerList(input),
  },
  {
    name: "broker_deploy",
    description:
      "Deploy broker lower files into a guest directory with chunked writes and hash verification.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        guest_dir: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      required: ["name", "guest_dir"],
      additionalProperties: false,
    },
    handler: (input) => brokerDeploy(input),
  },
  {
    name: "broker_diff",
    description:
      "Compare the guest directory against broker lower hashes; reports created, modified, and deleted files.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        guest_dir: { type: "string" },
        max: { type: "integer", minimum: 1, maximum: 50000 },
        depth: { type: "integer", minimum: 0, maximum: 64 },
      },
      required: ["name", "guest_dir"],
      additionalProperties: false,
    },
    handler: (input) => brokerDiff(input),
  },
  {
    name: "broker_harvest",
    description:
      "Copy guest-created or guest-modified files back into the broker upper layer with hash verification.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        guest_dir: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        max: { type: "integer", minimum: 1, maximum: 50000 },
        depth: { type: "integer", minimum: 0, maximum: 64 },
      },
      required: ["name", "guest_dir"],
      additionalProperties: false,
    },
    handler: (input) => brokerHarvest(input),
  },
  {
    name: "broker_commit",
    description:
      "Write broker upper files into a host target directory, backing up existing targets first. Requires confirm: true.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        target_dir: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["name", "target_dir", "confirm"],
      additionalProperties: false,
    },
    handler: (input) => brokerCommit(input),
  },
  {
    name: "broker_reset",
    description:
      "Reset broker upper/deployed state, or drop the whole broker with scope=all and confirm: true.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        scope: { type: "string", enum: ["upper", "all"] },
        confirm: { type: "boolean" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    handler: (input) => brokerReset(input),
  },
  {
    name: "evidence_export",
    description:
      "Write an external-observation evidence directory: host profile, QEMU status, guest identity/profile, pcap hashes, log tail, broker manifests, and a SHA-256 manifest. Not REA core Evidence.",
    inputSchema: {
      type: "object",
      properties: { label: { type: "string" } },
      additionalProperties: false,
    },
    handler: (input) => evidenceExport(input),
  },
];

const TOOL_INDEX = new Map(TOOLS.map((tool) => [tool.name, tool]));
const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
const toolResult = (id, text, isError = false) =>
  ok(id, {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  });

const publicTool = (tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
});

const dispatch = async (message) => {
  if (!message || typeof message !== "object") return null;
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;
  if (method === "initialize") {
    return ok(id, {
      protocolVersion:
        typeof params?.protocolVersion === "string"
          ? params.protocolVersion
          : "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "rea-workbench", version: VERSION },
      instructions:
        "QEMU Windows workbench: lifecycle, qcow2 snapshots, dual guest agent channels (privileged 45999 and interactive 45998), T2 introspection (processes, services, autoruns, event logs, registry, identity), kernel ETW collection with host-side tracerpt, copy-on-write file broker, and external-observation evidence export. Guest effects are visible to the guest; this is not a stealth or anti-VM guarantee.",
    });
  }
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS.map(publicTool) });
  if (method === "resources/list") return ok(id, { resources: [] });
  if (method === "resources/templates/list")
    return ok(id, { resourceTemplates: [] });
  if (method === "prompts/list") return ok(id, { prompts: [] });
  if (method === "logging/setLevel") return ok(id, {});
  if (method === "tools/call") {
    const name = params?.name;
    const tool = TOOL_INDEX.get(name);
    if (!tool) return toolResult(id, `unknown tool: ${String(name)}`, true);
    const args =
      params?.arguments && typeof params.arguments === "object"
        ? params.arguments
        : {};
    const missing = (tool.inputSchema.required || []).filter(
      (key) =>
        args[key] === undefined || args[key] === null || args[key] === "",
    );
    if (missing.length) {
      return toolResult(
        id,
        `missing required arguments: ${missing.join(", ")}`,
        true,
      );
    }
    try {
      const value = await tool.handler(args);
      return toolResult(
        id,
        typeof value === "string" ? value : JSON.stringify(value, null, 2),
      );
    } catch (error) {
      return toolResult(
        id,
        error && typeof error === "object" && "message" in error
          ? String(error.message)
          : String(error),
        true,
      );
    }
  }
  if (isNotification) return null;
  return fail(id, -32601, `Method not found: ${String(method)}`);
};

const handleMessage = async (message) => {
  if (Array.isArray(message)) {
    const responses = [];
    for (const item of message) {
      const response = await dispatch(item);
      if (response) responses.push(response);
    }
    if (responses.length) send(responses);
    return;
  }
  const response = await dispatch(message);
  if (response) send(response);
};

let queue = Promise.resolve();
const input = createInterface({ input: process.stdin, terminal: false });
input.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  queue = queue.then(async () => {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      send(fail(null, -32700, "Parse error"));
      return;
    }
    try {
      await handleMessage(parsed);
    } catch (error) {
      send(
        fail(
          null,
          -32603,
          error && typeof error === "object" && "message" in error
            ? String(error.message)
            : String(error),
        ),
      );
    }
  });
});
