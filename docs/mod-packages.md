# Fabric-style MCP mods

REA can act as a small Fabric-style loader for MCP servers. The host agent
starts one REA MCP session; REA's package surface lists installed mods without
starting them. Opening a mod package starts its MCP server, discovers its
tools, and proxies them into the same REA session. Closing the package removes
the proxy tools and releases the server process.

The mapping is intentional:

| Fabric concept     | REA / MCP concept                                             |
| ------------------ | ------------------------------------------------------------- |
| Minecraft          | The agent host, for example DeepSeek Harness                  |
| Fabric Loader      | REA's mod loader and package lifecycle                        |
| Fabric API         | REA's core tools, package surface, Evidence, and verification |
| `fabric.mod.json`  | `rea.mod.json`                                                |
| Mod entrypoint     | The mod's MCP server (`initialize` + `tools/list`)            |
| Mod dependencies   | `requires` in `rea.mod.json`                                  |
| Mod enable/disable | `open_tool_package` / `close_tool_package`                    |
| Mod list           | `list_tool_packages` / `inspect_tool_package`                 |
| Mixins/events      | REA core guards and proxy lifecycle; mods stay out-of-process |

REA itself is also a mod: the host mounts REA as one MCP server, and REA's
core tool families remain available through its package surface.

## Manifest

A mod is a directory under `REA_MODS_DIR` (default `~/.rea/mods`) containing
`rea.mod.json`, or a single `.json` manifest directly in that directory:

```json
{
  "schema_version": 1,
  "id": "vmp",
  "name": "VMProtect toolkit",
  "version": "0.1.0",
  "summary": "Offline VMProtect analysis for Demo, commercial, and body targets.",
  "requires": ["core"],
  "mcp": {
    "transport": "stdio",
    "command": "node",
    "args": ["D:/tools/vmp-mod/server.mjs"],
    "env": {},
    "timeout_ms": 60000
  },
  "boundaries": {
    "provides": ["offline VM state analysis"],
    "excludes": ["live injection or target mutation"],
    "authority": "read-only local artifacts and recorded snapshots",
    "prerequisites": ["the vmp-probe workspace"]
  },
  "profiles": [
    {
      "id": "commercial-body",
      "title": "Commercial body",
      "summary": "VMProtect Ultimate self-protection body."
    }
  ],
  "usage": "Open this package, then inspect the proxied tools.",
  "tools": { "prefix": "vmp" }
}
```

Streamable HTTP is also supported:

```json
"mcp": {
  "transport": "streamable-http",
  "url": "http://127.0.0.1:8765/mcp",
  "headers": { "Authorization": "Bearer ${RUNTIME_VALUE}" },
  "timeout_ms": 60000
}
```

Header values are passed to the transport as written. Do not place long-lived
secrets in the manifest when a runtime environment source is available.

A manifest is an installed mod. Loading it does not start anything; opening
its package does. Manifest discovery validates IDs, dependencies, transport
shape, and boundaries. Invalid, duplicate, built-in-conflicting, or
missing-dependency mods are reported in the server log and skipped without
preventing REA from starting.

## Lifecycle

1. `list_tool_packages` shows each mod as an external package with its summary,
   boundary counts, and open state. It does not start the MCP server.
2. `inspect_tool_package` shows the manifest's boundaries, profiles, and usage.
   Operations remain empty until the mod is open.
3. `open_tool_package` starts the mod's MCP server, lists its tools, and
   registers namespaced proxy tools (`mod__<prefix>__<raw>`). Required packages
   open first. A failed start removes any partial registration and returns a
   typed capability error.
4. The host observes `notifications/tools/list_changed` and can call the proxy
   tools directly.
5. `close_tool_package` removes the proxy tools and closes the MCP client and
   transport. A package required by another open package cannot close first.

Proxy input and output schemas use the mod's advertised JSON Schemas. REA does
not reinterpret or narrow them; canonical argument validation remains the
mod's responsibility, and REA's response/delivery budget still applies to the
final MCP result. Proxy results keep the untrusted-target-content marker and
are external observations, not REA Evidence.

## Defaults and limits

- **No auto-start.** Listing, inspecting, and pinning a mod never starts its
  server; only `open_tool_package` does.
- **Working directory.** A relative `mcp.cwd` resolves against the mod
  directory. Omission inherits the host process's working directory.
- **Environment.** Stdio mods receive the MCP client's safe inherited
  environment plus the manifest's `env` map. Values are never echoed by
  `list_tool_packages` or `inspect_tool_package`.
- **Names.** Proxy names are `mod__<prefix>__<raw>` normalized to
  `[A-Za-z0-9_-]`, with a deterministic hash suffix when truncation or
  replacement would collide.
- **Tool-list changes.** A mod that changes its tool list at runtime is
  resynchronized after `notifications/tools/list_changed`. If resynchronization
  fails, close and reopen the package.
- **No hot reload.** Replacing a manifest requires restarting REA. This is a
  first-version loader, not a full HMR mod platform.
- **Authority.** A mod's MCP server runs with the host user's permissions. The
  manifest boundary and the explicit open action are the consent boundary;
  REA does not sandbox third-party mods.
- **Host re-namespacing.** A host may wrap REA's tool names again. DeepSeek
  Harness registers them as `mcp__rea__*` and normalizes long names; use the
  host's final tool list rather than assuming REA's proxy spelling.
- **Host schema subset.** When mounted through DeepSeek Harness, a proxy tool's
  advertised JSON Schema must fit the host's supported schema vocabulary.
  Unsupported mod schemas fail registration at the host, not inside REA.

## DeepSeek Harness host

DeepSeek Harness already provides the host role: its `dsh-mcp-client` plugin
registers external MCP servers on `ctx.tools`. Mount REA as one row and let REA
load its mods:

```yaml
- insert:
    - id: mcp-rea
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: node
        args:
          - "D:/vs/rea/scripts/rea.mjs"
          - "mcp"
        env:
          REA_MCP_TOOL_SURFACE: packages
          REA_MODS_DIR: "D:/vs/rea-mods"
```

The model sees `mcp__rea__list_tool_packages`,
`mcp__rea__inspect_tool_package`, and so on. After a package opens, REA emits
`tools/list_changed`; the DSH client re-syncs and exposes the proxied tools as
`mcp__rea__mod__<prefix>__<raw>`. DSH remains the game host; REA remains the
loader/API; each mod remains a separate MCP server behind REA.

Opening a cold mod starts a child process and waits for `initialize` and
`tools/list`. If the host's per-call timeout is shorter than the mod's startup,
raise `toolCallTimeoutMs` on the `mcp-rea` row or in the individual call.

See [tool packages](tool-packages.md) for the package surface and
[plugin-style tool packages](tool-packages.md#package-kinds) for the built-in
package kinds.

## Model-facing policy in a host

The MCP bridge carries the server contract, not every REA convention:

- **Carried:** the MCP server instructions (including the package index in
  `packages` mode), each advertised tool's name, description, and input JSON
  Schema, text/structured results, and dynamic `tools/list_changed` updates.
- **Host-transformed:** tool names gain the host prefix
  (`mcp__rea__...`); the host may normalize long names again.
- **Not carried by the bridge:** REA's per-result `_meta.provenance` marker,
  MCP tool annotations/effects, and MCP prompts. The host's approval policy is
  independent of REA's effects.
- **Separate from the MCP server:** the `reverse-engineer-anything` skill and
  its detailed routing, Evidence, and unknown-discipline guidance. A host only
  sees that skill when it is installed in one of the host's skill roots.

For DeepSeek Harness, install the packaged skill under a root its
`skill-filesystem` provider scans, for example:

```text
~/.agents/skills/reverse-engineer-anything/
```

or a workspace `.agents/skills/reverse-engineer-anything/`. The host then
offers the skill alongside `mcp__rea__*`. Without it, the model still sees
REA's server instructions and tool descriptions, but not the full routing and
Evidence workflow.

If a host needs stricter authority than a generic MCP client provides, add a
host-side guard or approval policy for the `mcp__rea__*` namespace. REA's
server-side checks still apply; a host approval does not widen the target or
make an external mod result trustworthy.
