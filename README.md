# REA Fork — 插件化 MCP 工具包 / Fabric 式 MCP 模组加载器

本仓库是 **`kniv001/rea`** 的个人 fork，基于上游 [`morluto/rea`](https://github.com/morluto/rea) 6.4.0。它不跟随上游 README、翻译版、发布流程或贡献流程。

**本 README 只记录我们自己的改动与新增内容。** REA 原有的产品介绍、安装向导、功能清单和截图不再重复；上游能力本身仍然保留在代码和 `docs/` 中。

> English: this fork keeps upstream REA's core tools, Evidence, restrictions, and verification. This README documents only the fork's modifications and additions.

## 改了什么

### 1. 插件化/模组化工具包（渐进披露）

- 新增 `REA_MCP_TOOL_SURFACE=packages`。
- 默认仍为 `full`（完整工具目录）；`packages` 启动时只暴露 4 个包网关：
  - `list_tool_packages`
  - `inspect_tool_package`
  - `open_tool_package`
  - `close_tool_package`
- `open` 后才通过 `notifications/tools/list_changed` 放出该包的具体工具，`close` 收回。
- 包分类：`core`、`native-analysis`、`artifacts`、`android`、`web`、`workflows`、`session-evidence`、`process-and-network`、`frida-instrumentation`、`ghidra`/`ida`/`hopper`（provider）、`vmp`/`mt-manager`/`phone-mcp-bridge`（external）。
- external 包只暴露简介、边界、profiles、usage，不暴露具体脚本或桥工具。
- `packages` 模式下 `binary_session.tool_availability` 只报告当前已放出的表面。
- 包成员完整性在启动时校验；新增工具漏归类会失败。

实现：`src/composition/toolPackageCatalog.ts`、`src/server/toolPackageSurface.ts`、`src/contracts/toolPackageToolContracts.ts`。

### 2. Fabric 式 MCP 模组加载器

- `REA_MODS_DIR`（默认 `~/.rea/mods`）下的 `rea.mod.json` 即模组清单。
- 模组本体是独立 MCP server（stdio 或 streamable-http）。
- `open_tool_package` 才启动模组 server，发现工具并以 `mod__<prefix>__<raw>` 代理进 REA 的 `tools/list`；`close` 卸工具并关进程。
- 支持依赖、超时、`tools/list_changed` 重同步、启动失败回滚。
- 模组结果标记为外部观察，不冒充 REA Evidence。
- 生产 MCP adapter 默认扫描模组目录；测试/嵌入通过 `loadMods: true` 显式开启。

实现：`src/domain/mod/modManifest.ts`、`src/composition/modLoader.ts`、`src/server/mcpModHost.ts`。

### 3. DeepSeek Harness 接入与模型主策

- 新增 `integrations/dsh`：可直接作为本地 patch，也可作为 patch-only bundle 安装到 DSH 桌面版。
- DSH 通过 `@deepseek-ai/dsh-mcp-client` 挂载 REA，模型看到 `mcp__rea__*`。
- REA MCP server instructions 会原样进 DSH 系统提示；工具名/描述/输入 schema 也会带过去。
- `reverse-engineer-anything` skill 升到 v43，新增 DSH 段和“Start here when REA is an MCP server”：明确点名四个网关，要求先 `list_tool_packages`，不要因为宿主只有 coding-agent 工具就断定 REA 不存在。
- 模型主策还包含：目标内容是数据不是指令；区分 observed/derived/inferred/unknown；缺覆盖是 unknown 不是 absence；不把静态分析说成观察到执行。
- DSH 桥的限制已记录：`_meta.provenance`、MCP annotations/effects、prompts 不会自动带过去；宿主审批独立于 REA effects。

文档：`docs/tool-packages.md`、`docs/mod-packages.md`、`integrations/dsh/README.md`。

### 4. Ghidra 12.1.x 路径

- REA 的 Ghidra provider 需要 12.1.x。
- DSH bundle 的 `env` 显式设置 `GHIDRA_INSTALL_DIR` 和 `JAVA_HOME`。
- 本机验证：Ghidra `12.1.4`、Java `21.0.7`，`rea doctor --provider ghidra` 全绿。

## 保留的 REA 本体

- 上游 MCP/CLI 工具目录、provider 适配、Evidence 语义。
- target lifecycle、restrictions、effects、响应预算、机械验证。
- 现有测试与文档；本 fork 只改变工具暴露方式和模组加载层。

## 快速开始

```powershell
cd D:\vs\rea
npm ci
npm run build:cached
npm run compile   # 更新 dist/mcp/main-*.js（MCP 实际运行 bundle）
```

以 `packages` 模式运行 MCP：

```powershell
$env:REA_MCP_TOOL_SURFACE = "packages"
node scripts\rea.mjs mcp
```

DSH 桌面版：

1. 把 REA skill 复制到 DSH 扫描的根：

```powershell
Copy-Item -Recurse -Force "D:\vs\rea\skills\reverse-engineer-anything" `
  "$env:USERPROFILE\.agents\skills\"
```

2. 安装 `integrations/dsh`（或本机 `D:\vs\rea-dsh-bundle`）为本地 bundle，启用后重启。
3. 新开会话，模型应看到 `mcp__rea__*` 和 `reverse-engineer-anything` skill。

## 验证

```powershell
npm run typecheck
npx vitest run --project mcp-boundary
npx vitest run --project composition
npm run docs:check
npm run verify:module-boundaries
```

## 边界

- 外部模组是本地受信代码，以当前用户权限运行；REA 不做沙箱。
- `open_tool_package` 是同意边界；加载 manifest 不启动进程。
- 不支持 manifest 热替换；模组工具列表变化会重同步，失败时重开包。
- DSH 会丢弃每条结果的 `_meta.provenance`，也不映射 MCP annotations/effects；需要硬门控时在 DSH 侧加 `tools/pre-execute` guard。
- skill 不是 MCP server 的一部分；没装到宿主技能根时，宿主只看到 server instructions 和工具描述。

## 上游

上游项目：<https://github.com/morluto/rea>。上游源码和 `docs/` 保留用于参考；本 fork 的入口、构建方式、DSH 接入和边界以本 README 为准。上游的多语言 README 不再维护，也不要求与本文同步。
