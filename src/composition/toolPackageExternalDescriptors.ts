import type {
  ToolPackageBoundaries,
  ToolPackageDescriptor,
  ToolPackageProfile,
} from "./toolPackageCatalog.js";

interface ExternalPackageInput {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly boundaries: ToolPackageBoundaries;
  readonly profiles?: readonly ToolPackageProfile[];
  readonly usage: string;
  readonly evidence: string;
}

const external = (input: ExternalPackageInput): ToolPackageDescriptor => ({
  id: input.id,
  title: input.title,
  summary: input.summary,
  kind: "external",
  requires: [],
  boundaries: input.boundaries,
  tools: [],
  profiles: input.profiles ?? [],
  usage: input.usage,
  evidence: input.evidence,
});

/** Toolkits REA describes but does not drive or proxy. */
export const EXTERNAL_TOOL_PACKAGE_DESCRIPTORS: readonly ToolPackageDescriptor[] =
  [
    external({
      id: "vmp",
      title: "VMProtect toolkit",
      summary:
        "Offline VMProtect analysis for Demo 3.11, commercial 3.8.4, and the VMProtect Ultimate self-protection body.",
      boundaries: {
        provides: [
          "Offline Unicorn snapshot analysis without injection or a debugger.",
          "VM state signatures, ISA family coarsening, block semantics, key-schedule and anchor audits.",
          "Separate Demo, commercial, and self-protection body profiles.",
        ],
        excludes: [
          "Live process injection, debugger attachment, or target mutation.",
          "Registration, license, or activation bypass; commercial registration material stays redacted.",
          "Automatic generalization beyond the recorded snapshots and measured windows.",
        ],
        authority:
          "Read-only local artifacts and recorded snapshots; commands run only in the caller-provided workspace.",
        prerequisites: [
          "The vmp-probe workspace and its recorded snapshots and traces.",
          "Python 3 with the workspace's pinned dependencies.",
        ],
      },
      profiles: [
        {
          id: "demo-product",
          title: "Demo product",
          summary:
            "VMProtect Demo 3.11 generated targets; 256-opcode table engine.",
        },
        {
          id: "commercial-product",
          title: "Commercial product",
          summary:
            "VMProtect 3.8.4 generated targets; threaded block engine with 748-entry block semantics.",
        },
        {
          id: "commercial-body",
          title: "Commercial body",
          summary:
            "VMProtect Ultimate self-protection body; loader, key schedule, license phase, and payload.",
        },
      ],
      usage:
        "Enter through the vmp-probe workspace INDEX.md and its pipeline and audit commands. This package intentionally exposes no concrete scripts until inspected.",
      evidence:
        "Recorded snapshots are ground truth for the emulated world; distinguish observed, derived, and inferred facts. A coarse signature match is not a contract-level proof.",
    }),
    external({
      id: "mt-manager",
      title: "MT Manager",
      summary:
        "Android GUI file manager and APK editor; a manual UI toolkit, not a scriptable REA provider.",
      boundaries: {
        provides: [
          "Manual on-device file, APK, and archive inspection and editing through its UI.",
          "Visual inspection of installed packages and file systems.",
        ],
        excludes: [
          "A machine API or MCP endpoint; REA cannot drive its UI.",
          "Automated mutation without a caller-selected device workflow.",
        ],
        authority:
          "User-driven UI actions on the user's device; every edit requires explicit user action.",
        prerequisites: [
          "MT Manager installed on the device.",
          "A human operator for any edit.",
        ],
      },
      usage:
        "Use the app directly. For scripted Android work, open the android package (ADB, apktool, JADX, or JEB) instead.",
      evidence:
        "UI observations are user-reported; they are not REA Evidence unless captured separately.",
    }),
    external({
      id: "phone-mcp-bridge",
      title: "Phone MCP bridge",
      summary:
        "Phone-local MCP bridge in front of MT Manager, exposing device-side operations as a separate MCP toolkit.",
      boundaries: {
        provides: [
          "Device-side file, package, UI, and shell operations through the bridge's own MCP tools.",
          "A root-holding phone app as the local authority.",
        ],
        excludes: [
          "REA does not proxy or register the bridge's concrete tools and does not store its token.",
          "No operation without the phone app running and the caller's authorization.",
        ],
        authority:
          "The phone app holds root; REA is a client, not the authority. The bridge token is read at runtime and never written to configuration files.",
        prerequisites: [
          "The phone MCP bridge app installed and running.",
          "Its token read at runtime, for example through adb shell run-as; never persisted in config.",
        ],
      },
      usage:
        "Connect to the bridge's own MCP endpoint and use its advertised tools. Read the token at runtime; do not persist it.",
      evidence:
        "Bridge results are device observations; preserve their source and import them as REA Evidence only when explicitly captured.",
    }),
  ];
