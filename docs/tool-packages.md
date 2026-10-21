# Plugin-style tool packages

REA's canonical MCP catalog stays complete. The **package surface** is a
session-level projection for agents: at session start the client advertises only
four package gateway tools, and each package's concrete tools become available
after the agent inspects and opens that package. This is a modular, plugin-style
disclosure layer, not a second tool implementation.

Use it when an agent host sends every advertised tool definition with every
request, or when a session should begin with capability summaries instead of
the complete concrete tool catalog.

## Modes

| Setting                                      | Behavior                                                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `REA_MCP_TOOL_SURFACE=full` (default)        | Every tool is advertised from the first `tools/list`; package gateways are also available as a catalog. Existing clients and tests keep the complete catalog.                  |
| `REA_MCP_TOOL_SURFACE=packages`              | Only `list_tool_packages`, `inspect_tool_package`, `open_tool_package`, and `close_tool_package` are advertised initially. The MCP instructions carry a compact package index. |
| `REA_MCP_TOOL_PACKAGES=core,native-analysis` | Opens the listed packages before the first `tools/list`, so their tools are advertised immediately. Only meaningful with `packages`.                                           |

Both settings are read at startup; restart the server to apply changes.

The canonical contracts, output schemas, canonical validation, Evidence
semantics, annotations, effects, and CLI behavior do not change. The catalog in
`docs/public/product-catalog.json` remains complete. Package membership is
validated at startup: a tool that belongs to no package fails the server build
and the catalog test, so upstream additions cannot silently disappear.

## Lifecycle

1. `list_tool_packages` returns compact summaries: `id`, `title`, `kind`,
   one-line purpose, `tool_count`, `profile_count`, and `open`.
2. `inspect_tool_package` returns one package's boundaries (`provides`,
   `excludes`, `authority`, `prerequisites`), profiles, and operations. The
   default `detail: "summary"` returns one sentence per operation; `detail:
   "full"` returns complete canonical descriptions. Inspection never enables a
   tool, starts analysis, or contacts an external toolkit.
3. `open_tool_package` enables the package's members and emits
   `notifications/tools/list_changed`. Required lifecycle packages open first.
   The agent then calls the concrete tools with their normal schemas.
4. `close_tool_package` hides the package's members again unless another open
   package still owns them. A package required by another open package cannot
   be closed until its dependents close.

Opening a package does not open a target, start a provider, or grant extra
authority. Every concrete tool retains its own target, lifecycle, effects, and
approval semantics.

## Package kinds

| Kind       | Meaning                                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`     | Target lifecycle and `binary_session`: `open_binary`, `close_binary`, `binary_session`.                                                                          |
| `family`   | REA-owned tool families such as native analysis, artifacts, Android, web/Electron, workflows, Evidence, and process/network.                                     |
| `provider` | One deep-analysis provider profile (Ghidra, IDA, Hopper). Provider packages overlap family tools by design; a tool stays enabled while any open package owns it. |
| `external` | A toolkit REA does not drive. The package exposes only its summary, boundaries, profiles, and usage; it enables no REA tools.                                    |

Current package IDs:

- `core`
- `native-analysis`, `frida-instrumentation`, `artifacts`, `android`, `web`,
  `workflows`, `session-evidence`, `process-and-network`
- `ghidra`, `ida`, `hopper`
- `vmp` (external; profiles `demo-product`, `commercial-product`,
  `commercial-body`)
- `mt-manager` (external)
- `phone-mcp-bridge` (external)

External packages deliberately do not list concrete scripts or bridge tools.
`inspect_tool_package` is the entry point that reveals their profiles and
usage; the toolkit's own interface remains authoritative after that.

An external package can also be backed by a local MCP server manifest. Opening
it starts that server and proxies its tools through REA; see
[Fabric-style MCP mods](mod-packages.md).

### VMProtect

`vmp` covers offline VMProtect analysis for the Demo 3.11 and commercial 3.8.4
products and the VMProtect Ultimate self-protection body. Its boundary excludes
live injection, debugger attachment, target mutation, registration or license
bypass, and generalization beyond recorded snapshots. Concrete scripts stay in
the caller-provided `vmp-probe` workspace; the package points to its `INDEX.md`
and pipeline commands instead of reproducing them as REA tools.

### MT Manager and the phone MCP bridge

`mt-manager` is a manual Android GUI toolkit. REA cannot drive its UI; the
package directs scripted Android work to the `android` family (ADB, apktool,
JADX, or JEB).

`phone-mcp-bridge` is the phone-local MCP bridge that sits in front of MT
Manager. REA treats it as an external toolkit: it does not proxy or register
the bridge's concrete tools and does not store the bridge token. The token is
read at runtime by the caller, never written into configuration files, and the
bridge's own server remains the authority for its operations.

## `binary_session` inventory

In `packages` mode, `binary_session.tool_availability` is scoped to the tools the
active surface currently advertises. It is no longer a complete inventory until
more packages open. `list_tool_packages` and `inspect_tool_package` are the
authoritative discovery path for unopened packages. In `full` mode the
inventory remains complete.

## Client behavior and limits

- A client must honor `notifications/tools/list_changed` to see newly opened
  tools without reconnecting. If it does not, pin the packages at startup with
  `REA_MCP_TOOL_PACKAGES` or use `full`.
- Opening a package does not make an unavailable provider available. Provider
  health, host support, client features, and target requirements still apply.
- Package metadata is REA-authored. It receives no untrusted-target-content
  marker. Concrete tool results keep their own provenance markers and
  limitations.
- `full` remains the compatibility default. The package surface is opt-in so a
  client that expects the complete catalog is unaffected.

## Adding a package

1. Add a descriptor to `src/composition/toolPackageCatalog.ts` with `id`, `title`,
   `summary`, `kind`, `requires`, boundaries, member tool names, profiles,
   usage, and evidence.
2. Assign every new tool to at least one package. The catalog builder rejects
   uncovered tools and unknown members.
3. Add a focused test when the package has a distinct lifecycle or external
   usage boundary.
4. Regenerate the MCP catalog and product catalog, then run the MCP boundary
   tests and `docs:check`.
