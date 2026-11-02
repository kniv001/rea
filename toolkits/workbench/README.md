# REA Workbench (v0.2, QEMU + Windows guest)

A local QEMU-backed Windows analysis workbench exposed as an REA MCP mod. The
host controls one guest; the guest runs two small PowerShell agents and optional
kernel ETW collection. All activity is explicit and observable inside the
guest — this is not a stealth or anti-VM guarantee.

## Install

```powershell
node install-mod.mjs
```

Then restart REA, open the `workbench` package, and use the proxied tools
(`mod__workbench__status`, `mod__workbench__start`, ...).

## Tools

### Lifecycle and storage

| Tool                   | Function                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `status`               | QEMU process, ports, guest channels, disk size, HMP status                                          |
| `start`                | Launch the installed Windows guest; accepts CPU/RAM/MAC/disk serial/SMBIOS and optional `pcap_path` |
| `stop`                 | ACPI powerdown, then quit/kill fallback                                                             |
| `resume` / `pause`     | HMP `cont` / `stop`                                                                                 |
| `snapshot` / `restore` | qcow2 snapshots; running `savevm` is refused under WHPX, so use offline snapshots                   |
| `import`               | Copy a host file to the shared removable disk                                                       |
| `logs`                 | Tail the QEMU log                                                                                   |

### Agent channels

The guest agent listens on two loopback-forwarded ports:

- `45999`: privileged channel (SYSTEM task, or an elevated user agent)
- `45998`: interactive channel (non-elevated user Run entry, session 1)

`guest_channels` probes both. `guest_launch` prefers `45998` so launched
processes appear on the logged-in desktop; if that channel is down it falls
back to the privileged channel and reports `channel: "system"` (the process may
run in session 0).

### Guest introspection and file I/O

| Tool                                           | Function                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `guest_ping`, `guest_whoami`                   | liveness, identity, SID, session, integrity, privileges               |
| `guest_ps`, `guest_services`, `guest_autoruns` | processes, services, Run keys/Startup/tasks/auto services             |
| `guest_net_conns`, `guest_dns_cache`           | TCP/UDP endpoints and DNS cache                                       |
| `guest_eventlog`                               | event log query with level and time window                            |
| `guest_profile`, `guest_identity`              | WMI identity and deep registry/firmware identity                      |
| `guest_reg_read`, `guest_reg_write`            | registry read/enumerate and typed writes (`confirm: true` required)   |
| `guest_ls`, `guest_stat`, `guest_ls_tree`      | directory listings, file metadata/SHA-256, recursive tree with hashes |
| `guest_read`, `guest_write`                    | explicit base64 file access, 16 MiB per call                          |
| `guest_copy_in`, `guest_copy_out`              | chunked 8 MiB copies, 64 MiB in / 512 MiB out, SHA-256 on both sides  |
| `guest_watch_start` / `poll` / `stop`          | polling directory snapshot diff                                       |
| `guest_launch`                                 | launch a guest process on the interactive channel                     |

### Profile Broker

| Tool             | Function                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `profile`        | host profile seed from the last `start`                                                                                |
| `profile_check`  | compare host seed with WMI identity                                                                                    |
| `profile_verify` | cross-check firmware SMBIOS, registry identity, and WMI identity                                                       |
| `profile_apply`  | write MachineGuid, ProductId, BIOS registry strings, CPU name; persists via the SYSTEM `REAIdentityApply` startup task |

Registry writes affect registry readers. Firmware-visible values (WMI
`Win32_BIOS`, `Win32_ComputerSystemProduct`) still come from the QEMU `-smbios`
start profile; use both layers for consistency.

### Kernel ETW telemetry

| Tool               | Function                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `telemetry_start`  | start a `logman` kernel trace (default providers: process, registry, network; add `file` for file I/O) |
| `telemetry_status` | session state and ETL size                                                                             |
| `telemetry_stop`   | stop the session and hash the ETL                                                                      |
| `telemetry_fetch`  | chunked ETL copy to `exports/telemetry`, then host-side `tracerpt` summary                             |

ETW files are written under `C:\ProgramData\rea-workbench\telemetry`. The agent
starts `tracerpt` detached and only reports the summary file; reading large
trace text inside the single-threaded agent is deliberately avoided.

### Copy-on-write file broker

| Tool                                           | Function                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `broker_init`                                  | create/reset `HOME/brokers/<name>` with lower/upper                                  |
| `broker_put`                                   | add a host file to the immutable lower layer                                         |
| `broker_deploy`                                | copy lower files into a guest directory with hash verification                       |
| `broker_diff`                                  | compare guest files against lower hashes (created/modified/deleted)                  |
| `broker_harvest`                               | copy guest changes back into the upper layer                                         |
| `broker_commit`                                | write upper files into a host directory, backing up existing files (`confirm: true`) |
| `broker_status`, `broker_list`, `broker_reset` | manifest, entries, reset upper or drop                                               |

This is explicit deploy/harvest COW, not a minifilter or transparent `C:\`
redirection. Guest programs must operate on the deployed directory.

### Evidence

| Tool              | Function                                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evidence_export` | write an external-observation directory with host profile, QEMU status, guest identity/profile, pcap hashes, log tail, broker manifests, and a SHA-256 manifest |

`evidence_export` output is **not** REA core Evidence. Importing it requires a
future adapter and must not be treated as canonical Evidence.

### Debugging

`gdb_status`, `gdb_registers`, `gdb_read_memory`, `gdb_write_memory`,
`gdb_break`, `gdb_unbreak`, `gdb_continue`, `gdb_interrupt`, `gdb_step`.

QEMU gdbstub is disabled by default because it makes WHPX pause the VM
intermittently even without a client. Start with `{"gdb": true}` for a debug
session. Breakpoint/step behavior is experimental.

## Guest agent install

`guest/agent.ps1` is a PowerShell TCP agent. `-Install`:

1. copies the agent to `%LOCALAPPDATA%\rea-workbench\agent.ps1`
2. adds an HKCU Run entry on `45998`
3. opens both loopback ports in Windows Firewall
4. registers `REAWorkbenchAgent` (SYSTEM, AtStartup) on `45999`

When run elevated, the SYSTEM task is registered. When run non-elevated, only
the interactive channel is installed. The agent retries binding for up to 120 s
so a boot-time start does not lose the race with network initialization.

Manual bootstrap inside the guest: open the shared removable disk and run
`run-agent.cmd` (self-elevating). The agent logs startup and bind results to
`C:\ProgramData\rea-workbench\agent.log`.

## Defaults

```text
home:    D:\vm\rea-workbench
qemu:    D:\vs\tools\qemu\qemu-system-x86_64.exe
disk:    D:\vm\rea-workbench\win11-ltsc.qcow2
firmware D:\vs\tools\qemu\share\edk2-x86_64-code.fd
vars:    D:\vm\rea-workbench\OVMF_VARS.fd
cpu:     qemu64,+sse4.2,+popcnt
memory:  8192 MiB
vnc:     127.0.0.1:1
qmp:     127.0.0.1:5556
monitor: 127.0.0.1:5555
agent:   127.0.0.1:45999 (privileged), 45998 (interactive)
```

Environment overrides: `REA_WORKBENCH_HOME`, `REA_QEMU`, `REA_QEMU_IMG`,
`REA_WORKBENCH_FIRMWARE`, `REA_TRACERPT`.

## Profile seed

`start` can vary a small part of the machine identity before boot:

```json
{
  "cpu": "qemu64,+sse4.2,+popcnt",
  "memory_mb": 8192,
  "mac": "52:54:00:12:34:56",
  "disk_serial": "REA20261102",
  "smbios": {
    "manufacturer": "ASUS",
    "product": "REA Workbench",
    "version": "1.0",
    "serial": "REA-LAB",
    "uuid": "00000000-0000-0000-0000-000000000001"
  },
  "pcap_path": "D:\\vm\\rea-workbench\\logs\\net.pcap"
}
```

Use the same values in `profile_apply` (BIOS registry fields) so the registry
and firmware layers agree. `profile_verify` reports each layer separately.

## Development helpers

`scripts/` is not copied into the installed mod; it holds dev harnesses:

- `wb.mjs` — send one JSON command to a guest agent port
- `mcp-call.mjs` — spawn `server.mjs` and call one tool over MCP stdio
- `gshell.mjs` — run a guest `cmd.exe` command and print redirected output
- `qemu-type.mjs` — send QMP keystrokes for blind logons on a headless VM

`guest/elevate-setup.ps1` + `guest/elevate-launch.ps1` start a fresh privileged
agent through a UAC consent prompt; they kill stale `agent.ps1` processes that
hold the privileged port first.

## Known constraints

- WHPX does not support running `savevm`/`loadvm`; use offline qcow2 snapshots.
- `Nehalem`/`Haswell` are not valid boot CPU models for this installed guest;
  use `qemu64,+sse4.2,+popcnt`.
- The shared disk is QEMU `fat:rw` mounted as USB mass storage. It is a staging
  area, not a write proxy. Restart the guest to refresh the vvfat listing.
- VNC is bound to `127.0.0.1` with no password. Do not expose it.
- The agent is single-threaded: one long command blocks the channel. Long ETW
  summaries are therefore done on the host.
- Boot-time agent startup depends on the SYSTEM `REAWorkbenchAgent` task. Task
  Scheduler ACLs can hide the task from non-elevated `schtasks` queries; query
  it through the privileged agent.
- Guest-side effects (registry writes, identity changes, ETW sessions) are
  visible to software in the guest and are not hidden.
