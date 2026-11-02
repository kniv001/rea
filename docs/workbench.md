# Workbench：PC 侧虚拟化分析工作台（设计稿）

> 状态：设计稿。QEMU 第一壳 `toolkits/workbench` 已落地（status/start/stop、
> 离线 qcow2 快照、宿主文件 staging、QEMU 日志）；Guest Agent、文件网关、
> Profile Broker、被动遥测和 anti-VM hardening 仍未实现。
>
> 相关：当前 [process capture](process-capture.md) 明确不是沙箱；Windows native 控制见
> [native/windows/README.md](../native/windows/README.md)。Workbench 是新增的隔离层，
> 不复用 process capture 的 `isolation: "process"` 语义。

## 1. 定位

Workbench 是 REA 的 PC 侧**虚拟化分析工作台**：

- 目标软件运行在 Guest OS 内，Guest OS 是它的“皮肤”。
- Hypervisor、虚拟固件/设备、文件/网络网关是外面的“手套”。
- 静态工具在 Host 侧处理不可变副本；动态工具在 Guest 侧运行。
- 目标对宿主文件、注册表、硬件、网络的访问都经过显式代理。
- 记录分为被动观测和主动插桩；观测等级是 Evidence 的一等字段。

一句话：

```text
Guest OS 当皮肤，hypervisor 当手套，网关当袖口，Identity Broker 当身份映射。
```

目标是“对目标薄、对实现厚”：目标看到一台完整机器；实现是完整 VM + 代理栈。

## 2. 设计原则

1. **隔离边界是 VM，不是文件代理。** 文件/网络网关是策略边界；VM 是安全边界。
2. **Guest OS 是唯一真源。** 目标在 Guest 内的文件、注册表、进程、句柄、身份由 Guest OS 生成；不逐调用伪造。
3. **默认被动。** 默认 `passive` 观测：目标正常跑，Host 侧看；调试器/Frida/`ETW`/minifilter 按需升级。
4. **外部访问显式化。** 宿主文件、网络、配置只通过 catalog/policy；不挂共享目录，不直通宿主注册表。
5. **写入分级。** `read-only` / `cow` / `direct` 三种模式；`direct` 是真实外部写，必须审批和审计。
6. **观测等级入 Evidence。** 不把主动插桩下的行为当成“目标自然行为”。
7. **不承诺不可检测。** VM 痕迹、时序、外部身份、观察者痕迹都是残余风险；高对抗目标用独立物理机。

## 3. 非目标

- 不是“薄 API hook 沙箱”；不靠 DLL 注入/Inline Hook 充当隔离边界。
- 不承诺反 VM 不可检测；只做一致 profile、硬件虚拟化和观测点外移。
- 不替代现有 `process capture`；后者继续是 host process 观测，`isolation: "process"`。
- 不是恶意软件分发/对外执行服务；只运行操作者授权的目标。
- 不把宿主真实注册表、凭据、用户配置直接透传给 Guest。

## 4. 威胁模型与不变量

目标视为不可信：

- 可能反 VM、反调试、反沙箱、反注入。
- 可能尝试路径穿越、`\\?\`、ADS、reparse point、UNC、设备名、命名管道、共享内存。
- 可能通过网关发起真实外部写、外传数据、撞库、下载 payload。
- 可能尝试 VM escape（残余风险，不能承诺零）。

必须保持的不变量：

1. Guest 拿不到宿主文件/注册表/进程的原生 handle。
2. 没有共享目录、剪贴板、拖拽、SMB；Host↔Guest 只走 vsock/named pipe。
3. 每次 run 使用独立 overlay；关闭即回滚；导出必须显式。
4. 所有外部文件访问经过 Host File Broker 的 catalog/policy。
5. 所有外部网络访问经过 Network Gateway 的 egress policy。
6. `direct` 写、`active` 插桩、`allowlist` 网络必须显式审批。
7. Evidence 记录 `observability` 和 `limitations`；主动插桩不能冒充被动观察。

## 5. 总体架构

```text
Host / Windows
┌──────────────────────────────────────────────────────────────┐
│ REA Control Plane                                            │
│  workbench package / CLI / MCP                               │
│  ├─ WorkbenchLifecycle      创建、启动、暂停、快照、关闭      │
│  ├─ PolicyEngine            catalog / egress / write mode     │
│  ├─ IdentityBroker          external token/SID/credential map│
│  ├─ EvidenceSink            run/file/memory/network/profile  │
│  └─ ApprovalGate            direct write / active / egress   │
│                                                              │
│  ┌────────────────────┐  ┌────────────────────┐              │
│  │ VM Backend Adapter │  │ Host File Broker   │              │
│  │ QEMU/WHPX | VMware │  │ catalog + COW      │              │
│  │ Hyper-V (可选)     │  │ lower / upper      │              │
│  └─────────┬──────────┘  └─────────┬──────────┘              │
│            │ vsock / named pipe    │                          │
│  ┌─────────▼───────────────────────▼──────────┐              │
│  │ Guest VM / Windows                         │              │
│  │  ├─ Guest Agent (service)                  │              │
│  │  ├─ Guest File Proxy (WinFsp/minifilter)   │              │
│  │  ├─ Profile Agent (hardware/config)        │              │
│  │  ├─ Telemetry (ETW / minifilter / dump)    │              │
│  │  ├─ Dynamic tools (x64dbg / Frida / ...)   │              │
│  │  └─ Target process tree                    │              │
│  └────────────────────────────────────────────┘              │
│                                                              │
│  Host-side static tools: Ghidra / IDA / REA on immutable copy│
└──────────────────────────────────────────────────────────────┘
```

三个平面：

| 平面        | 内容                             | 边界               |
| ----------- | -------------------------------- | ------------------ |
| Control     | REA 工具、生命周期、策略、审批   | Host               |
| Data        | 文件、网络、profile、快照        | Host↔Guest 代理    |
| Observation | ETW、minifilter、VMI、pcap、dump | Guest 内或 Host 外 |

## 6. 需要搭建的“壳”

下表是首版建议的模块边界；路径是建议，不是强制。

| 壳                 | 建议位置                                | 职责                                                 | 首版                        |
| ------------------ | --------------------------------------- | ---------------------------------------------------- | --------------------------- |
| `WorkbenchControl` | `src/application/workbench/`            | 生命周期、状态机、策略编排、Evidence                 | 必须                        |
| `VmBackend`        | `src/workbench/backend/`                | `create/start/stop/snapshot/restore` 抽象            | 必须                        |
| `QemuBackend`      | `src/workbench/backend/qemu/`           | QEMU/WHPX 或 TCG 后端                                | 必须（默认候选）            |
| `VmwareBackend`    | `src/workbench/backend/vmware/`         | VMware Workstation/Fusion 适配                       | 可选                        |
| `HyperVBackend`    | `src/workbench/backend/hyperv/`         | Hyper-V 适配（宿主可用时）                           | 可选                        |
| `HostTransport`    | `native/workbench/`                     | vsock/virtio-serial/named pipe 监听与帧协议          | 必须                        |
| `GuestAgent`       | `bridge/workbench/guest-agent/`         | Guest 内服务：进程、文件代理 RPC、profile、telemetry | 必须                        |
| `HostFileBroker`   | `src/workbench/file/`                   | catalog、路径准入、import/export、COW                | 必须                        |
| `GuestFileProxy`   | `bridge/workbench/file-proxy/`          | WinFsp 虚拟盘；后续 minifilter                       | 必须                        |
| `ProfileBroker`    | `src/workbench/profile/`                | 硬件/身份/registry/WMI/locale profile bundle         | 必须                        |
| `IdentityBroker`   | `src/workbench/identity/`               | 外部 token/SID/凭据映射；Kerberos/证书/TPM 限制      | 第二阶段                    |
| `NetworkGateway`   | `src/workbench/network/`                | offline/NAT/allowlist、pcap、协议 ALG                | 第二阶段                    |
| `TelemetrySink`    | `src/workbench/telemetry/`              | ETW/minifilter/dump/VMI 归一化                       | 必须（首版可只做文件+进程） |
| `ToolAdapter`      | `src/workbench/tools/`                  | x64dbg/Frida/Procmon 的 guest 控制面                 | 第三阶段                    |
| `Evidence`         | `src/contracts/workbench/`              | run/file/memory/network/profile/snapshot schema      | 必须                        |
| `ToolPackage`      | `src/composition/toolPackageCatalog.ts` | `workbench` 包描述、默认关闭                         | 必须                        |
| `ServerTools`      | `src/server/registerWorkbenchTools.ts`  | MCP 工具注册                                         | 必须                        |
| `CLI`              | `src/cli/workbenchCommands.ts`          | CLI 入口                                             | 可选                        |

### 6.1 第一版已落地的壳

`toolkits/workbench` 是当前可用的 QEMU 第一壳（MCP mod，已安装到
`~/.rea/mods/workbench`）。打开 REA 的 `workbench` 包后暴露：

```text
mod__workbench__status
mod__workbench__start
mod__workbench__stop
mod__workbench__snapshot
mod__workbench__restore
mod__workbench__import
mod__workbench__guest_ping
mod__workbench__guest_ps
mod__workbench__guest_profile
mod__workbench__guest_ls
mod__workbench__guest_read
mod__workbench__guest_write
mod__workbench__guest_copy_in
mod__workbench__guest_copy_out
mod__workbench__guest_watch_start
mod__workbench__guest_watch_poll
mod__workbench__guest_watch_stop
mod__workbench__guest_launch
mod__workbench__gdb_status
mod__workbench__gdb_registers
mod__workbench__gdb_read_memory
mod__workbench__gdb_write_memory
mod__workbench__gdb_break
mod__workbench__gdb_unbreak
mod__workbench__gdb_continue
mod__workbench__gdb_interrupt
mod__workbench__gdb_step
mod__workbench__pcap_start
mod__workbench__pcap_stop
mod__workbench__memory_dump
mod__workbench__profile
mod__workbench__profile_check
mod__workbench__logs
```

`start` also seeds CPU/RAM/MAC/disk serial/SMBIOS and can enable QEMU
`filter-dump` pcap. This is a basic profile seed, not the full Profile Broker.

已实测：`open_tool_package {package_id:"workbench"}` 返回上述 enabled_tools，
`mod__workbench__status` 可读到 QEMU HMP 状态。限制：

- WHPX 下运行态 `savevm/loadvm` 因缺少 dirty-memory/system-state 支持而失败；
  停机后的 `qemu-img snapshot -c/-a` 可用。
- `import` 是 host→guest staging；Guest 已运行时需重启刷新 vvfat 目录。
- QEMU gdbstub 已接入并实测寄存器/内存读取；但 WHPX 下启用 gdbstub 会让 VM 间歇 paused，默认关闭（`start {"gdb":true}` 才启用）；断点/单步行为未完全验证。
- Guest Agent、透明文件 I/O 网关、完整 Profile Broker、ETW/minifilter/VMI 尚未接入。

“壳”的边界原则：

- `VmBackend` 不暴露后端细节给上层；上层只认 `WorkbenchRun`。
- `GuestAgent` 不直接访问宿主文件；只通过 vsock 请求 `HostFileBroker`。
- `HostFileBroker` 不执行目标；只做路径/策略/复制/审计。
- `ProfileBroker` 不读宿主实时注册表；只读签名 profile bundle。
- `TelemetrySink` 不改变目标行为；主动插桩必须单独标 `active`。

## 7. 生命周期

```text
defined
  → provisioning      (创建 overlay、分配 vsock、准备 profile)
  → ready             (Guest 已启动、Agent 就绪)
  → running           (目标进程树运行)
  → paused            (可选：挂起)
  → snapshotting      (内存/磁盘快照)
  → closing           (终止进程、收集证据、回滚)
  → closed
```

失败分支：

```text
provisioning → failed
ready/running → crashed
closing → cleanup_failed（保留资源待重试）
```

每次 `run` 都有独立 `run_id`、overlay、Evidence 目录；`close` 默认丢弃 overlay。

## 8. 核心流程

### 8.1 创建与启动

```text
REA → WorkbenchControl.create(profile)
  → VmBackend.create(base_image, overlay, vsock)
  → GuestAgent.hello()
  → ProfileBroker.apply(profile)
  → WorkbenchControl.ready
```

### 8.2 动态运行

```text
REA → WorkbenchControl.run(target, args, cwd, observability)
  → GuestAgent.launch(target)
  → target 在 Guest 内正常执行
  → TelemetrySink 开始收集（按等级）
  → WorkbenchControl 返回 run_id
```

### 8.3 文件读（import / gateway）

```text
target open  R:\samples\a.exe
  → GuestFileProxy
  → HostFileBroker.resolve(R:\samples\a.exe)
  → PolicyEngine 检查 catalog / mode
  → Host 读取真实文件
  → lower 层写入副本（只读）
  → Guest 返回 handle
  → target 读取
```

### 8.4 文件写（cow / direct）

```text
target write R:\samples\a.exe
  → GuestFileProxy
  → HostFileBroker
      ├─ cow: 写 upper 层；宿主不变；read-after-write 走同一路径
      └─ direct: 策略/审批后真实写宿主；记录 audit
  → target 看到成功
```

`direct` 是真实外部写；它不是默认模式，也不允许无审批使用。

### 8.5 配置/身份读取

```text
target reads CPUID / SMBIOS / WMI / registry / disk serial / MAC
  → Guest OS / hypervisor firmware / Profile Agent
  → 返回同一 profile 的一致值
```

Profile 是**签名、脱敏的 bundle**，不是宿主实时配置。

### 8.6 被动观测

```text
T1: Host 侧 pcap / 磁盘 diff / 内存 dump / VMI
T2: Guest 内 ETW / minifilter / Agent
T3: 调试器 / Frida / API hook
```

T1 默认；T2/T3 必须显式选择并写入 Evidence。

### 8.7 快照、导出、关闭

```text
snapshot: 磁盘 overlay + 内存 dump + profile 元数据
export:   显式选择文件/目录，HostFileBroker 从 upper 导出
close:    终止 job/进程树 → 收集证据 → 丢弃 overlay → 释放 vsock
```

### 8.8 静态分析

```text
REA → workbench_stage(artifact)
  → Host 不可变副本 + SHA-256
  → Ghidra/IDA/REA 静态分析
  → 不启动 Guest，不执行目标
```

静态与动态共享同一 Evidence Store，但 `isolation` 和 `observability` 不同。

## 9. 文件网关设计

### 9.1 三种模式

| 模式        | 行为                    | 宿主副作用 | 用途                 |
| ----------- | ----------------------- | ---------- | -------------------- |
| `read-only` | Host 读，Guest 只读副本 | 无         | 样本、配置、依赖库   |
| `cow`       | Host 读，Guest 写 upper | 无（默认） | 常规动态分析         |
| `direct`    | 网关真实读写宿主/外部   | 有，需审批 | 必须访问真实外部资源 |

### 9.2 路径准入

拒绝：

- `..`、`.`、重复分隔符、尾点/尾空格
- `\\?\`、`\\.\`、UNC、设备名、ADS
- reparse point / junction / symlink
- 非 catalog root
- 超过大小/数量/深度限制

保留：

- requested path 与 final handle path 分开记录
- volume serial / file ID / hash / size
- 失败原因分类：not-found / denied / unsupported / policy

### 9.3 元数据与身份

内容可以复制，但以下不保证逐位一致：

- volume serial、file ID
- ACL/owner/SID
- USN、change notification
- ADS、sparse/compression/encryption
- reparse point、hardlink
- share mode / lock / oplock

这些必须写入 `limitations`；不能声称“文件身份完全一致”。

## 10. Profile / 身份虚拟化

### 10.1 Profile 分层

```text
machine profile
  ├─ firmware: SMBIOS/DMI, ACPI OEM, PCI IDs, EFI vars
  ├─ cpu: CPUID leaves, hypervisor bit, vendor
  ├─ devices: disk serial, MAC OUI, GPU, monitor EDID
  ├─ os: build, edition, locale, timezone, uptime
  ├─ registry: HKLM\HARDWARE\DESCRIPTION\System\BIOS ...
  ├─ wmi: Win32_ComputerSystem / BIOS / DiskDrive / NetworkAdapter
  └─ software: installed apps, services, drivers, updates
```

### 10.2 一致性规则

- 同一 run 内所有来源必须来自同一 profile。
- 不允许“CPUID 是 Intel、SMBIOS 是 QEMU、磁盘是 VMware”。
- 每次 run 可随机化，但随机化要可复现（seed）。
- Profile bundle 签名；不含宿主密钥/凭据/用户隐私。

### 10.3 Profile bundle 骨架

```json
{
  "schema": "rea.workbench-profile/1",
  "seed": "hex-string",
  "backend": "qemu",
  "guest": {
    "os": "windows-11-x64",
    "build": "26100",
    "image_hash": "sha256:..."
  },
  "firmware": {
    "smbios": { "vendor": "...", "product": "...", "serial": "..." },
    "acpi_oem_id": "...",
    "efi_vars": []
  },
  "cpu": {
    "vendor": "GenuineIntel",
    "brand": "...",
    "cpuid_leaves": {},
    "hypervisor_present": false
  },
  "devices": {
    "disk_serial": "...",
    "mac": "...",
    "gpu": "...",
    "monitor_edid": "...",
    "pci_ids": []
  },
  "os": {
    "hostname": "...",
    "domain": "...",
    "locale": "zh-CN",
    "timezone": "China Standard Time",
    "uptime_seconds": 0
  },
  "registry_seed": [],
  "wmi_seed": [],
  "software": {
    "installed": [],
    "services": [],
    "drivers": []
  },
  "limitations": []
}
```

Profile bundle 必须签名；`image_hash`、`seed`、`backend` 进入 Evidence。宿主真实序列号/密钥/用户信息不得进入 bundle。

### 10.4 身份边界

| 身份                                  | 来源               | 能否保持                        |
| ------------------------------------- | ------------------ | ------------------------------- |
| Guest 进程身份（PID/TID/句柄/模块）   | Guest OS           | 内部一致                        |
| Guest 机器身份（hostname/domain/SID） | Guest OS + Profile | 可配置                          |
| 外部账户身份（token/SID/凭据）        | Identity Broker    | 部分；受 Kerberos/证书/TPM 限制 |
| 硬件身份（TPM/EK/disk serial/MAC）    | vTPM/虚拟固件      | 可虚拟化，不保证原机逐位一致    |

不伪造目标自己的 PID/TID/句柄/内存布局；这些由 Guest OS 生成。

## 11. 观测与 Evidence

### 11.1 观测等级

| 等级       | 位置       | 能看到                          | 目标可见性                  |
| ---------- | ---------- | ------------------------------- | --------------------------- |
| `static`   | Host       | 文件/字节/符号                  | 目标未运行                  |
| `passive`  | Host/VM 外 | pcap、磁盘 diff、内存 dump、VMI | 低；VM 痕迹仍在             |
| `in-guest` | Guest      | ETW、minifilter、Agent          | 中；驱动/服务/Provider 可见 |
| `active`   | Guest      | 调试器、Frida、API hook         | 高；反调试/反注入可检测     |

默认 `passive`。`active` 必须显式审批，Evidence 标注 `observability: "active"`。

### 11.2 Evidence 类型

```text
rea.workbench-run
rea.workbench-file-event
rea.workbench-memory-event
rea.workbench-network-event
rea.workbench-config-profile
rea.workbench-snapshot
```

每个 Evidence 至少带：

```text
run_id
isolation: "vm"
observability: "static" | "passive" | "in-guest" | "active"
backend
profile_hash
limitations[]
```

### 11.3 记录内容

- 文件：create/read/write/rename/delete、PID、路径、hash、bytes、结果。
- 内存：进程/模块/区域、dump hash、快照时间点。
- 网络：五元组、方向、pcap 引用、TLS 指纹（如可用）。
- 配置：profile 版本、读取的键/接口、与 profile 的一致性。
- 进程：进程树、命令行、退出码、job 归属。

## 12. REA 工具面

建议新增 `workbench` 包，默认关闭；打开需要审批（`executesForeignCode`）。

| 工具                 | 作用                        | 关键 effects                                                |
| -------------------- | --------------------------- | ----------------------------------------------------------- |
| `workbench_create`   | 创建 VM + overlay + profile | `writesFilesystem`, `launchesProcess`                       |
| `workbench_open`     | 启动/恢复工作台             | `launchesProcess`, `executesForeignCode`                    |
| `workbench_run`      | 在 Guest 内运行目标         | `launchesProcess`, `executesForeignCode`, `accessesNetwork` |
| `workbench_snapshot` | 磁盘/内存快照               | `writesFilesystem`, `mayDiscardData`                        |
| `workbench_restore`  | 回滚                        | `mayDiscardData`                                            |
| `workbench_observe`  | 开始/停止/收集遥测          | `mutatesSession`                                            |
| `workbench_export`   | 从 upper 导出               | `writesFilesystem`                                          |
| `workbench_close`    | 终止、回滚、清理            | `mayDiscardData`                                            |
| `workbench_status`   | 状态/资源/限制              | 只读                                                        |

`workbench_run` 的输入至少包含：

```json
{
  "run_id": "...",
  "target": "R:\\samples\\a.exe",
  "arguments": [],
  "cwd": "R:\\samples",
  "observability": "passive",
  "file_policy": "cow",
  "network_policy": "offline",
  "timeout_ms": 60000
}
```

`direct` 写、`active` 观测、`allowlist` 网络必须单独审批，不能由 `workbench_run` 隐式升级。

## 13. 安全策略

- Host 侧专用低权限账户；Guest 内不使用宿主凭据。
- 网络默认 `offline`；`nat` 仅出站；`allowlist` 需逐项审批。
- 无共享目录、无剪贴板、无拖拽、无 SMB；只走 vsock/named pipe。
- `direct` 写只允许 catalog 内路径；写前记录 hash/backup；写后 audit。
- Guest 镜像、profile、agent 二进制签名；启动前校验。
- 快照/overlay 加密可选；Evidence 中不写明文密钥。
- VM escape 是残余风险：专用宿主、快照回滚、最小共享面；不能承诺绝对不逃逸。

## 14. 后端与镜像

### 14.1 Backend 接口

```text
create(baseImage, overlay, vsock, profile) -> vmHandle
start(vmHandle) -> guestReady
stop(vmHandle)
snapshot(vmHandle) -> snapshotRef
restore(vmHandle, snapshotRef)
export(vmHandle, path) -> artifact
```

首版候选：

- QEMU/WHPX 或 QEMU TCG（不依赖 Hyper-V）
- VMware（若已安装）
- Hyper-V（仅宿主可用时）

不假设 Windows 11 Home 一定有 Hyper-V；后端必须可替换。

### 14.2 Guest 镜像

- Windows 10/11 x64 黄金镜像。
- 预装 Guest Agent、File Proxy、Profile Agent。
- 关闭无关服务；固定驱动集；记录镜像 hash。
- sysprep/首次启动脚本由操作者提供，不自动改宿主策略。

### 14.3 本机 QEMU/WHPX 实测（2026-11-02）

- QEMU 11.1.0 安装在 `D:\vs\tools\qemu`，`-accel whpx` 可用；OVMF 使用
  `share\edk2-x86_64-code.fd` + `edk2-i386-vars.fd`。
- 安装 Windows 11 Enterprise LTSC 2024 Evaluation 时，`-cpu Nehalem` 可启动
  OVMF/Setup；安装后用它引导会报 `WHPX: Unexpected VP exit code 4`。
- `-cpu Haswell-noTSX` / `max` 报 `failed to get xsave state`；已安装系统可用
  `-accel whpx -cpu qemu64,+sse4.2,+popcnt` 启动。
- 无人值守文件必须作为 **USB mass storage** 挂载：
  `-drive file=fat:rw:...,if=none,id=unattend` + `-device qemu-xhci` +
  `-device usb-storage,drive=unattend,removable=on`；普通 vvfat 磁盘或 floppy
  方式不会被 Windows Setup 自动读取。
- 回退：`-accel tcg,thread=multi -cpu max` 可启动，但明显变慢。

### 14.4 v0.2 已实现（2026-11-02）

工具面（61 个 `mod__workbench__*`）：

- **双通道 Agent**：`45999` 特权通道（SYSTEM 启动任务，或手动提升的 user agent），
  `45998` 交互通道（HKCU Run，session 1）。`guest_launch` 优先走 45998；
  45998 不可用时回退 45999 并标注 `channel: "system"`。
- **T2 内省**：进程、服务、自启动、事件日志、DNS 缓存、TCP/UDP 端点、注册表
  读写、深度身份（MachineGuid/ProductId/BIOS registry/CPU registry/SMBIOS）。
- **Profile Broker v1**：`profile_apply` 写 registry 身份并由 SYSTEM 启动任务
  `REAIdentityApply` 持久化；`profile_verify` 分层校验 firmware/registry/WMI。
- **ETW**：`telemetry_start/status/stop/fetch`，`logman -pf` provider 文件；
  默认 process/registry/network，`file` 可选。ETL 分块回传后由**宿主**
  `tracerpt` 生成 summary，避免单线程 agent 被阻塞。
- **COW File Broker**：`broker_init/put/deploy/diff/harvest/commit/status/list/reset`；
  lower 不可变、upper 只接收 guest 变更、commit 前备份宿主目标。
- **分块文件传输**：8 MiB 分块，in 64 MiB / out 512 MiB，双侧 SHA-256。
- **Evidence 导出**：`evidence_export` 生成 external-observation 目录与
  SHA-256 manifest；明确不是 REA core Evidence。
- **启动任务**：`REAWorkbenchAgent`（SYSTEM，AtStartup）与
  `REAIdentityApply`（SYSTEM，AtStartup）；两者在非提升 `schtasks` 查询中
  可能因 ACL 不可见，需用特权通道查询。

实测（2026-11-02）：

- 20 MiB 分块 copy in/out，双侧 SHA-256 一致。
- ETW process+network 6 秒，ETL 1,310,720 B，guest/host SHA-256 一致；
  宿主 tracerpt summary 正常。
- broker deploy→guest 修改/新建→diff→harvest→commit→备份，hash 全部一致。
- `evidence_export` 7 个 artifact，manifest hash 复核通过。

仍未做：透明 minifilter/WinFsp 虚拟盘、WFP/registry filter 内核遥测、VMI、
REA core Evidence 适配、gdb breakpoint/step 稳定性。Agent 单线程，长命令会
阻塞所在通道；任务计划 ACL 会隐藏 SYSTEM 任务。冷启动后 QEMU slirp hostfwd
到 45999/45998 可能 3–5 分钟才可达（agent 已 bound，guest 内自连正常），
需重试 `guest_channels` 或在 VNC 内重跑 `run-agent.cmd`。

## 15. 实施阶段

### Phase 0：契约与文档

- `WorkbenchProfile` / `WorkbenchRun` / Evidence schema。
- 工具包描述、effects、审批规则。
- 本文档 + `docs/index.md` 入口。

### Phase 1：VM 生命周期

- `VmBackend` 接口 + 一个后端。
- Guest Agent hello/launch/terminate。
- overlay、快照、关闭回滚。
- 验收：启动、运行计算器、快照、回滚、关闭。

### Phase 2：文件网关

- `HostFileBroker` catalog + path admission。
- `GuestFileProxy` 虚拟盘 `R:`（WinFsp）。
- `read-only` / `cow`；read-after-write；export。
- 验收：样本导入 hash 一致；写只落 upper；宿主文件不变；导出显式。

### Phase 3：Profile Broker

- 机器/CPU/设备/OS/registry/WMI profile。
- 一致性检查（同一 profile 多源读取）。
- 验收：profile 内部一致；反 VM 测试记录已知命中，不声称零检测。

### Phase 4：被动观测

- pcap、磁盘 diff、内存 dump、进程树。
- Evidence 归一化；`observability` 标注。
- 验收：事件可追溯、限制可见、无宿主副作用。

### Phase 5：动态工具适配

- x64dbg/WinDbg/Frida/Procmon 的 Guest 控制面。
- `active` 观测审批；目标检测记录。
- 验收：工具可用；Evidence 明确标注主动插桩。

### Phase 6：加固与可选 minifilter

- 透明 `C:\` 路径重定向（minifilter）。
- hypervisor 反 VM profile、时序/设备一致性。
- 网络 ALG、身份映射。
- 验收：路径重定向覆盖、已知反 VM 语料、残余风险清单。

## 16. 验收门（首版）

1. **隔离**：Guest 无法打开宿主任意路径；无共享目录/剪贴板/SMB；vsock 是唯一控制面。
2. **文件**：import hash 一致；`cow` 写不落宿主；read-after-write 一致；export 显式。
3. **回滚**：快照后修改，restore 回到快照；close 丢弃 overlay。
4. **Profile**：CPUID/SMBIOS/WMI/registry/disk/MAC 同源一致；不一致时报告 limitations。
5. **观测**：`passive` 不依赖 Guest 内调试器；`active` 明确标注；Evidence 可追溯。
6. **安全**：`direct`/`active`/`allowlist` 均需审批；失败不静默降级。
7. **不冒充**：`isolation: "vm"` 与 `isolation: "process"` 不混用；不把 VM 结果说成 host 结果。

## 17. 未决问题

- 首版后端选 QEMU/WHPX 还是 VMware？Windows 11 Home 的可用性需实测。
- Guest Windows 镜像与许可证由谁提供？
- 文件代理首版用 WinFsp 还是直接 minifilter？minifilter 的签名/测试签名策略？
- 是否需要 VMI（LibVMI/DRAKVUF）？它提升被动性，但增加后端复杂度。
- 网络网关的协议 ALG 范围：HTTP/SOCKS 够不够？是否需要 SMB/RPC/Kerberos？
- Identity Broker 的深度：只做 token/SID 映射，还是要 Kerberos 委派/证书/TPM？
- Profile 的历史状态（事件日志/Prefetch/Amcache）如何生成？是否纳入首版？
- 审批 UX：`direct` 写和 `active` 插桩如何在 CLI/MCP 中确认？

## 18. 一句话总结

Workbench 不是“薄 hook 沙箱”，而是：

```text
VM 隔离
  + Guest OS 真源
  + Host File Broker / Network Gateway
  + Profile Broker
  + 分级观测
  + Evidence
```

它能把本地行为/身份做到高度一致，把外部访问收进策略；但不能同时做到“实现薄、反 VM 不可检测、外部身份完全一致”。这三者的取舍必须在每次 run 的 `observability` 和 `limitations` 里说清楚。
