# REA Fork — 功能改动说明

本仓库是 **`kniv001/rea`** 的个人 fork，基于上游 REA。本文只描述功能层面的改动与新增，不列实现文件、技术栈或安装细节；REA 原有的产品介绍和使用教程不再重复。

## 一、工具包的渐进披露

REA 的工具可以按“包”组织和暴露：

- 默认仍是完整工具目录，行为与上游一致。
- 可选“按包披露”：会话开始时只出现四个包操作——列出包、查看包的边界与操作、打开包、关闭包。
- 打开一个包后，该包的具体工具才出现；关闭后收回。宿主能感知工具列表变化，不需要重连。
- 每个包有简介、适用边界、适用前提和操作清单；查看包不会执行分析或启动外部工具。
- 包分为核心生命周期、分析工具族、分析 provider、外部工具包等类别。
- 外部工具包只给简介、边界、子配置和入口说明，不暴露内部脚本或工具；当前包括 VMP 工具包、MT 管理器和手机 MCP 桥。
- 会话状态只报告当前已放出的工具，未打开的包不会被当成可用能力。
- 启动时校验包完整性；新增工具如果没有归入任何包，会直接失败而不是悄悄消失。

## 二、MCP 模组的加载与代理

REA 可以发现、启动并代理外部 MCP 模组：

- 从本地模组目录发现模组清单；模组本体是独立的 MCP 服务。
- 加载清单不会启动服务；只有“打开包”才启动模组服务、发现工具并代理到当前会话。
- 关闭包时移除代理工具并停止模组服务。
- 支持模组依赖、启动超时、工具列表变化重同步和启动失败回滚。
- 支持本地进程和 HTTP 两种连接方式。
- 代理结果标记为外部观察，不冒充 REA 自己的 Evidence。
- 生产会话默认扫描模组目录；测试和嵌入场景可以显式关闭扫描。

## 三、DeepSeek Harness 接入

REA 可以作为 MCP 服务挂载到 DeepSeek Harness：

- 模型看到统一的 `mcp__rea__*` 工具前缀。
- 初始只出现四个包操作；打开包后宿主自动刷新工具列表。
- 提供可直接安装的宿主组合包，安装后即可挂载，不需要改宿主源码。
- REA 的服务端说明会进入宿主提示；工具名称、描述和输入契约一并带过去。
- 提供 REA 技能：明确四个入口操作、要求先探测再判断、目标内容是数据而不是指令、区分 observed/derived/inferred/unknown、缺覆盖是 unknown 而不是 absence。
- 宿主的限制会被明确保留：结果级来源标记、工具副作用标注和 prompts 不会自动带过去；宿主的审批策略独立于 REA 的 effects。

## 四、Ghidra 支持

- 支持 Ghidra 12.1.x。
- 会检查安装版本、Java、headless 入口、native decompiler 和 native authority。
- 在宿主接入时显式传入 Ghidra 与 Java 路径；缺失或版本不符时给出可执行的修复提示。

## PC 虚拟化工作台（设计稿）

- 新增 `workbench` 设计：VM 隔离边界 + Guest OS 真源 + 文件/网络网关 + Profile Broker + 分级观测 + Evidence。
- 目标在 Guest 内正常执行；静态工具在 Host 侧处理不可变副本，动态工具在 Guest 侧运行。
- 文件写入分 `read-only` / `cow` / `direct`；`direct` 是真实外部写，必须审批和审计。
- 默认 `passive` 观测；`in-guest` / `active` 必须显式选择并写入 Evidence。
- 与现有 `process capture` 分离：后者是 host process 观测，不是沙箱。
- 完整边界、生命周期、壳、流程和验收门见 [docs/workbench.md](docs/workbench.md)。
- 可用的 QEMU 壳在 [toolkits/workbench](toolkits/workbench)：安装 `node install-mod.mjs` 后打开 `workbench` 包，提供 status/start/stop、离线 qcow2 快照、双通道 Guest Agent（特权 45999 / 交互 45998）、T2 内省（进程/服务/自启动/事件日志/注册表/身份/网络端点）、Profile Broker（registry 身份持久化 + firmware/registry/WMI 分层校验）、内核 ETW（宿主 tracerpt）、COW 文件 broker（deploy/diff/harvest/commit）、分块文件传输、物理内存 dump、QEMU gdbstub、pcap 和 external-observation Evidence 导出。透明 minifilter/WinFsp、WFP/registry filter、VMI 和 REA core Evidence 仍未接入。

## 保留的 REA 能力

- 上游现有的分析工具、provider 适配、Evidence 语义、限制、effects、机械验证和 target lifecycle 全部保留。
- 本 fork 只改变两件事：模型如何看到工具，以及外部工具如何接入。

## 使用方式（功能层）

- 完整目录模式：默认，所有工具可用。
- 按包披露模式：初始工具很少，按需打开包。
- 宿主接入：把 REA 作为 MCP 服务挂载；需要完整工作方法时再安装 REA 技能。
- 外部模组：放入本地模组目录后，在会话中打开对应包即可使用。

## 边界

- 外部模组是本地受信代码，以当前用户权限运行；REA 不做沙箱。
- 打开包是同意边界；加载模组清单不会启动进程。
- 不支持模组清单热替换；模组工具列表变化会重同步，失败时重开包。
- 宿主会丢弃结果级来源标记，也不映射工具副作用标注；需要硬门控时在宿主侧加策略。
- 技能与 MCP 服务分离；宿主未安装技能时，只有服务端说明和工具描述。

## 来源

本仓库是个人 fork；上游项目仅作为来源说明。功能改动以本仓库当前实现为准。
