# DeepSeek Harness host

DeepSeek Harness (`dsh`) is a plugin host: its `@deepseek-ai/dsh-mcp-client`
registers external MCP servers on `ctx.tools`. REA fits that host as a
Fabric-style loader:

- `mcp-rea` mounts REA itself as one MCP mod. The model sees
  `mcp__rea__list_tool_packages`, `mcp__rea__inspect_tool_package`,
  `mcp__rea__open_tool_package`, and `mcp__rea__close_tool_package`.
- REA scans `REA_MODS_DIR` for `rea.mod.json` manifests. A mod is another MCP
  server; opening its package starts it and proxies its tools through REA.
- REA's own tool families and verification stay inside the same session. Mod
  results are external observations with the untrusted-content marker.
- DSH re-syncs on REA's `notifications/tools/list_changed`, so newly opened mod
  tools appear under `mcp__rea__*` without restarting the host.

## Install

This directory is a patch-only DSH bundle (`package.json` declares
`dsh.bundle.patch`). Either:

- open **Plugins → Add plugin** in DeepSeek Harness Desktop and enter this
  directory's absolute path (or `file:<absolute path>`), then enable and
  restart; or
- copy [`cordis.patch.yml`](cordis.patch.yml) into the host's profile/home
  patch layer, or pass it as a patch overlay.

Replace the `command`/`args` pair with an absolute
`node <checkout>/scripts/rea.mjs mcp` invocation when `rea` is not on `PATH`.
Set `GHIDRA_INSTALL_DIR` (12.1.x) and `JAVA_HOME` when the Ghidra provider is
needed. Raise `toolCallTimeoutMs` when a cold mod server's startup exceeds the
host's default.

See [Fabric-style MCP mods](../../docs/mod-packages.md) for the manifest and
lifecycle contract.
