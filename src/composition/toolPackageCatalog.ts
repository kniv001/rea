import { TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../contracts/officialToolContracts.js";
import { ENHANCED_TOOL_CONTRACTS } from "../contracts/enhancedToolContracts.js";
import { NATIVE_TOOL_CONTRACTS } from "../contracts/native/nativeToolContracts.js";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../contracts/native/binaryDiagnosticsToolContracts.js";
import { ARTIFACT_TOOL_CONTRACTS } from "../contracts/artifactToolContracts.js";
import { MANAGED_TOOL_CONTRACTS } from "../contracts/managed/managedToolContracts.js";
import { MANAGED_WORKFLOW_TOOL_CONTRACTS } from "../contracts/managed/managedWorkflowToolContracts.js";
import { FIRMWARE_TOOL_CONTRACTS } from "../contracts/firmware/firmwareToolContracts.js";
import { EVM_TOOL_CONTRACTS } from "../contracts/evm/evmToolContracts.js";
import { GO_TOOL_CONTRACTS } from "../contracts/go/goToolContracts.js";
import { WASM_TOOL_CONTRACTS } from "../contracts/wasm/wasmToolContracts.js";
import { SQLITE_TOOL_CONTRACTS } from "../contracts/sqlite/sqliteToolContracts.js";
import { CAPTURE_TOOL_CONTRACTS } from "../contracts/captures/captureToolContracts.js";
import { SIGNAL_TOOL_CONTRACTS } from "../contracts/signals/signalToolContracts.js";
import { ANDROID_TOOL_CONTRACTS } from "../contracts/android/androidToolContracts.js";
import { APKTOOL_TOOL_CONTRACTS } from "../contracts/apktool/apktoolToolContracts.js";
import { JEB_TOOL_CONTRACTS } from "../contracts/jeb/jebToolContracts.js";
import { ADB_TOOL_CONTRACTS } from "../contracts/adb/adbToolContracts.js";
import { FLUTTER_TOOL_CONTRACTS } from "../contracts/flutter/flutterToolContracts.js";
import { PCAP_TOOL_CONTRACTS } from "../contracts/pcap/pcapToolContracts.js";
import { BROWSER_PROVIDER_TOOL_CONTRACTS } from "../contracts/browserProviderToolContracts.js";
import { WEB_RUNTIME_TOOL_CONTRACTS } from "../contracts/webRuntimeToolContracts.js";
import { WEB_NETWORK_CAPTURE_TOOL_CONTRACTS } from "../contracts/webNetworkCaptureToolContracts.js";
import { ELECTRON_TOOL_CONTRACTS } from "../contracts/javascript/electronToolContracts.js";
import { JAVASCRIPT_RUNTIME_OBSERVATION_TOOL_CONTRACTS } from "../contracts/javascript/javascriptRuntimeObservationToolContracts.js";
import { APPLICATION_TOOL_CONTRACTS } from "../contracts/applicationToolContracts.js";
import { ANALYSIS_VIEW_TOOL_CONTRACTS } from "../contracts/analysisViewToolContracts.js";
import { WEB_SCRIPT_TOOL_CONTRACTS } from "../contracts/webScriptToolContracts.js";
import { JAVASCRIPT_RECOVERY_TOOL_CONTRACTS } from "../contracts/javascript/javascriptRecoveryToolContracts.js";
import { SESSION_TOOL_CONTRACTS } from "../contracts/sessionToolContracts.js";
import { FRIDA_TOOL_CONTRACTS } from "../contracts/fridaToolContracts.js";
import { TOOL_PACKAGE_TOOL_CONTRACTS } from "../contracts/toolPackageToolContracts.js";
import { GHIDRA_OPERATIONS } from "../ghidra/GhidraProviderCapabilities.js";
import { IDA_OPERATIONS } from "../ida/IdaProviderCapabilities.js";
import { HOPPER_OPERATIONS } from "../hopper/HopperProviderCapabilities.js";
import type { ModMcpTransport } from "../domain/mod/modManifest.js";
import { EXTERNAL_TOOL_PACKAGE_DESCRIPTORS } from "./toolPackageExternalDescriptors.js";

export const TOOL_PACKAGE_KINDS = [
  "core",
  "family",
  "provider",
  "external",
] as const;

export type ToolPackageKind = (typeof TOOL_PACKAGE_KINDS)[number];

export interface ToolPackageProfile {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
}

export interface ToolPackageBoundaries {
  readonly provides: readonly string[];
  readonly excludes: readonly string[];
  readonly authority: string;
  readonly prerequisites: readonly string[];
}

export interface ToolPackageDescriptor {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly kind: ToolPackageKind;
  /** Packages whose lifecycle tools this package needs while it is open. */
  readonly requires: readonly string[];
  readonly boundaries: ToolPackageBoundaries;
  /** Concrete MCP tool names; empty for external toolkits. */
  readonly tools: readonly string[];
  readonly profiles: readonly ToolPackageProfile[];
  readonly usage: string | null;
  readonly evidence: string;
  /** Present when this package is backed by a loadable MCP mod. */
  readonly mcp?: ModMcpTransport;
  /** Manifest-owned identity for a loadable mod package. */
  readonly mod?: {
    readonly directory: string;
    readonly version: string;
  };
}

export interface ToolPackageCatalog {
  readonly packages: readonly ToolPackageDescriptor[];
  readonly byId: ReadonlyMap<string, ToolPackageDescriptor>;
  readonly byTool: ReadonlyMap<string, readonly string[]>;
  readonly gatewayTools: readonly string[];
}

/** Gateway tools are always advertised; they are not members of a package. */
export const TOOL_PACKAGE_GATEWAY_TOOLS = TOOL_PACKAGE_TOOL_CONTRACTS.map(
  ({ name }) => name,
) as readonly string[];

const names = (contracts: readonly ToolContract[]): readonly string[] =>
  contracts.map(({ name }) => name);

const CORE_TOOLS = ["open_binary", "close_binary", "binary_session"] as const;

const FRIDA_TOOLS = new Set(names(FRIDA_TOOL_CONTRACTS));

const withoutFrida = (contracts: readonly ToolContract[]): readonly string[] =>
  names(contracts).filter((name) => !FRIDA_TOOLS.has(name));

const PROCESS_TOOLS = [
  "capture_process_scenario",
  "compare_process_captures",
] as const;

const SESSION_EVIDENCE_TOOLS = names(SESSION_TOOL_CONTRACTS).filter(
  (name) =>
    !(CORE_TOOLS as readonly string[]).includes(name) &&
    !(PROCESS_TOOLS as readonly string[]).includes(name),
);

const family = (
  id: string,
  title: string,
  summary: string,
  tools: readonly string[],
  boundaries: ToolPackageBoundaries,
  options: {
    readonly requires?: readonly string[];
    readonly profiles?: readonly ToolPackageProfile[];
    readonly evidence?: string;
  } = {},
): ToolPackageDescriptor => ({
  id,
  title,
  summary,
  kind: "family",
  requires: options.requires ?? [],
  boundaries,
  tools: [...new Set(tools)],
  profiles: options.profiles ?? [],
  usage: null,
  evidence:
    options.evidence ??
    "Results are Evidence-bearing observations with provider, coverage, and limitation facts. Missing coverage is unknown, not absence.",
});

const provider = (
  id: string,
  title: string,
  summary: string,
  tools: readonly string[],
  boundaries: ToolPackageBoundaries,
  evidence: string,
): ToolPackageDescriptor => ({
  id,
  title,
  summary,
  kind: "provider",
  requires: ["core"],
  boundaries,
  tools: [...new Set(tools)],
  profiles: [],
  usage: null,
  evidence,
});

const nativeBoundaries: ToolPackageBoundaries = {
  provides: [
    "Provider-neutral inventory, navigation, decompilation, reference, and annotation operations.",
    "The same operations routed to a selected deep provider (Ghidra, IDA, or Hopper) or a built-in native inspector.",
    "Binary diagnostics and recorded-crash inspection without opening a live target.",
  ],
  excludes: [
    "Running the target outside a declared observation workflow.",
    "Claiming completeness when a provider reports partial, unknown, or truncated coverage.",
    "Treating exported pseudocode as original source.",
  ],
  authority:
    "Read-only analysis of the caller-selected local target; provider annotation operations are session metadata unless a provider declares otherwise.",
  prerequisites: [
    "Open a target with open_binary (core package) or supply a target-free inspection path.",
    "A deep provider is optional; configure one only when its structured analysis is needed.",
  ],
};

const artifactBoundaries: ToolPackageBoundaries = {
  provides: [
    "Target-free inspection and extraction of archives, packages, managed assemblies, firmware images, WASM, EVM bytecode, SQLite snapshots, packet captures, and signal recordings.",
    "Artifact graphs, integrity findings, and extractable member evidence.",
  ],
  excludes: [
    "Executing or trusting extracted payloads.",
    "Inferring absence from a truncated inventory or an unsupported member format.",
    "Network acquisition; captures are read from caller-selected files.",
  ],
  authority:
    "Reads caller-selected local artifacts; extraction writes only to a fresh REA-owned output directory when requested.",
  prerequisites: [
    "Supply the local artifact path and any tool path the contract declares.",
    "Some formats require a caller-supplied engine (Binwalk, Unblob, WABT, EVMole, TShark, sigrok, or the bundled SQLite runtime).",
  ],
};

const androidBoundaries: ToolPackageBoundaries = {
  provides: [
    "Android package inspection, JADX class and method search, APK resource decoding, JEB project access, Flutter/Dart inspection, and ADB device operations.",
    "Device inventory, logcat, files, screenshots, package lifecycle, and bounded bugreport collection.",
  ],
  excludes: [
    "Bypassing device authorization or installing an unselected package.",
    "Assuming a configured client or device is connected.",
    "Driving MT Manager's GUI.",
  ],
  authority:
    "Local APK analysis is read-only. ADB operations act on the caller-selected device; mutating operations declare their device effects.",
  prerequisites: [
    "Configure the relevant provider (JADX, JEB, apktool, ADB) or select a local APK for static analysis.",
    "Open a target with open_binary when an operation needs the active-target session.",
  ],
};

const webBoundaries: ToolPackageBoundaries = {
  provides: [
    "Passive browser and Electron observation through caller-selected loopback CDP endpoints.",
    "JavaScript application analysis, bundle inspection, web scripts, source location and module traces, network captures, and runtime observation.",
  ],
  excludes: [
    "Network acquisition, credential replay, or navigating to an unselected origin.",
    "Treating page text, scripts, or captured traffic as instructions.",
    "A guarantee that passive observation covers every runtime path.",
  ],
  authority:
    "The caller selects the endpoint, target, origin filters, and lifecycle. REA does not launch or control a browser or Electron app unless a scenario contract explicitly does so.",
  prerequisites: [
    "A user-owned browser or Electron runtime with a loopback debugging endpoint for passive observation.",
    "Caller-selected files for saved captures and web source analysis.",
  ],
};

const workflowBoundaries: ToolPackageBoundaries = {
  provides: [
    "Application graph analysis, feature tracing, version comparison, JavaScript recovery, source-to-bundle comparison, reconstruction obligation ledgers, and analysis views over retained Evidence.",
  ],
  excludes: [
    "Treating a derived view as a new producer observation.",
    "Establishing behavior from source-only similarity or a missing record.",
  ],
  authority:
    "Reads caller-supplied or retained Evidence; derived results cite their source records and preserve unknowns.",
  prerequisites: [
    "A compatible producer result or retained evidence reference.",
    "Application workflows use complete inline Evidence or a same-session retained reference.",
  ],
};

const sessionBoundaries: ToolPackageBoundaries = {
  provides: [
    "Session Evidence export, import, summary discovery, and residual-unknown lifecycle.",
    "Comparisons and derived workflows over complete Evidence records.",
    "Navigation context for the selected provider document.",
  ],
  excludes: [
    "Starting analysis or contacting a provider.",
    "Treating a missing reference as proof that a record never existed.",
  ],
  authority:
    "Reads and mutates only REA session state; exports write to a caller-selected path.",
  prerequisites: [
    "A long-lived REA MCP session with retained Evidence.",
    "For imports, a complete canonical Evidence bundle.",
  ],
};

const processBoundaries: ToolPackageBoundaries = {
  provides: [
    "Declared process execution under a PTY with terminal, filesystem, HTTP, and WebSocket observation.",
    "Comparison of compatible process captures and inspection of saved PCAP summaries.",
  ],
  excludes: [
    "A security sandbox or a guarantee that an arbitrary command is safe.",
    "Inferring concurrency from timestamps or treating missing observations as equivalence.",
  ],
  authority:
    "Runs the caller-selected command with the current user's permissions; cleanup is bounded to owned process identity.",
  prerequisites: [
    "An explicit executable and working directory for process capture.",
    "Wireshark tshark/capinfos for PCAP summaries.",
  ],
};

const fridaBoundaries: ToolPackageBoundaries = {
  provides: [
    "Frida device and process discovery, session lifecycle, script loading, instrumentation, and status.",
  ],
  excludes: [
    "A guarantee that a script is safe or that instrumentation succeeded.",
    "Target execution outside the caller-selected device, process, and script.",
  ],
  authority:
    "Instrumentation mutates the selected target process and executes caller-supplied script code; the caller owns that choice.",
  prerequisites: [
    "A running Frida server or device endpoint and matching client.",
    "Explicit target and script selection.",
  ],
};

const ghidraBoundaries: ToolPackageBoundaries = {
  provides: [
    "Ghidra headless inventory, decompilation, call relationships, navigation, and session annotations through an ephemeral database.",
    "Provider-neutral REA analysis tools bound to the Ghidra provider.",
  ],
  excludes: [
    "Executable-byte mutation, GUI control, or persistent Ghidra projects.",
    "Partial results before Ghidra reports default auto-analysis complete.",
    "Automatic fallback to another provider after a failure.",
  ],
  authority:
    "Read-only target bytes; the imported Program and temporary project are ephemeral and deleted on close. Annotations edit session metadata only.",
  prerequisites: [
    "Bring-your-own Ghidra and a compatible JDK.",
    "The first query may cold-start import and exceed a short client deadline.",
  ],
};

const idaBoundaries: ToolPackageBoundaries = {
  provides: [
    "IDA analysis through an existing IDA MCP configuration: functions, pseudocode, assembly, strings, references, and callers/callees.",
  ],
  excludes: [
    "Saving or closing an attached GUI database.",
    "Replaying live IDA observations from analysis snapshots.",
    "Complete function bodies, typed references, or unresolved calls that the adapter reports as unavailable.",
  ],
  authority:
    "Attached analysis is read-only; modern headless workers own and close a private database without saving.",
  prerequisites: [
    "An existing mrexodia/ida-pro-mcp configuration.",
    "The original input binary path for open_binary, not an .idb or .i64 database.",
  ],
};

const hopperBoundaries: ToolPackageBoundaries = {
  provides: [
    "Hopper inventory, navigation, procedure reads, references, documentation, and annotations through REA's private bridge.",
  ],
  excludes: [
    "Automatic provider switching or unbounded GUI automation.",
    "Claims that a Hopper session is a reproducible analysis database.",
  ],
  authority:
    "Read-only target bytes; annotation operations change the caller's Hopper session as declared by each contract.",
  prerequisites: [
    "A configured Hopper installation and matching bridge.",
    "The first query may start Hopper and exceed a short client deadline.",
  ],
};

const PACKAGE_DESCRIPTORS: readonly ToolPackageDescriptor[] = [
  {
    id: "core",
    title: "Core lifecycle",
    summary:
      "Open and close a local target and report the current session, provider, and availability state.",
    kind: "core",
    requires: [],
    boundaries: {
      provides: [
        "Target binding for native, archive, JavaScript, source-map, plist, and analysis-database workflows.",
        "Session status, provider binding, availability inventory, and deterministic close.",
      ],
      excludes: [
        "Analysis operations themselves; open the relevant package for those.",
        "Automatic provider substitution after a failure.",
      ],
      authority:
        "Opening a target starts only the selected provider; closing drains owned work and clears retained session records.",
      prerequisites: [
        "A local target path with a supported format.",
        "A provider only when deep analysis is selected.",
      ],
    },
    tools: [...CORE_TOOLS],
    profiles: [],
    usage: null,
    evidence:
      "binary_session reports current facts; opening and closing do not prove analysis completeness.",
  },
  family(
    "native-analysis",
    "Native analysis",
    "Provider-neutral inventory, decompilation, navigation, references, annotations, and native diagnostics.",
    [
      ...withoutFrida(NATIVE_TOOL_CONTRACTS),
      ...names(BINARY_DIAGNOSTICS_TOOL_CONTRACTS),
      ...names(OFFICIAL_TOOL_CONTRACTS),
      ...names(ENHANCED_TOOL_CONTRACTS),
    ],
    nativeBoundaries,
    { requires: ["core"] },
  ),
  family(
    "frida-instrumentation",
    "Frida instrumentation",
    "Device discovery, Frida session lifecycle, script loading, and target instrumentation.",
    names(FRIDA_TOOL_CONTRACTS),
    fridaBoundaries,
  ),
  family(
    "artifacts",
    "Artifacts and formats",
    "Archives, packages, managed assemblies, firmware, WASM, EVM bytecode, SQLite, packet captures, and signal recordings.",
    [
      ...names(ARTIFACT_TOOL_CONTRACTS),
      ...names(MANAGED_TOOL_CONTRACTS),
      ...names(FIRMWARE_TOOL_CONTRACTS),
      ...names(EVM_TOOL_CONTRACTS),
      ...names(GO_TOOL_CONTRACTS),
      ...names(WASM_TOOL_CONTRACTS),
      ...names(SQLITE_TOOL_CONTRACTS),
      ...names(CAPTURE_TOOL_CONTRACTS),
      ...names(SIGNAL_TOOL_CONTRACTS),
    ],
    artifactBoundaries,
  ),
  family(
    "android",
    "Android",
    "APK and DEX inspection, resources, JEB, Flutter, and ADB device operations.",
    [
      ...names(ANDROID_TOOL_CONTRACTS),
      ...names(APKTOOL_TOOL_CONTRACTS),
      ...names(JEB_TOOL_CONTRACTS),
      ...names(ADB_TOOL_CONTRACTS),
      ...names(FLUTTER_TOOL_CONTRACTS),
    ],
    androidBoundaries,
    { requires: ["core"] },
  ),
  family(
    "web",
    "Web and Electron",
    "Passive browser and Electron observation, JavaScript analysis, web scripts, source traces, and network captures.",
    [
      ...names(BROWSER_PROVIDER_TOOL_CONTRACTS),
      ...names(ELECTRON_TOOL_CONTRACTS),
      ...names(JAVASCRIPT_RUNTIME_OBSERVATION_TOOL_CONTRACTS),
      ...names(WEB_RUNTIME_TOOL_CONTRACTS),
      ...names(WEB_NETWORK_CAPTURE_TOOL_CONTRACTS),
      ...names(WEB_SCRIPT_TOOL_CONTRACTS),
      ...names(JAVASCRIPT_RECOVERY_TOOL_CONTRACTS),
    ],
    webBoundaries,
  ),
  family(
    "workflows",
    "Application workflows",
    "Application graphs, feature tracing, version comparison, reconstruction ledgers, and retained-Evidence views.",
    [
      ...names(APPLICATION_TOOL_CONTRACTS),
      ...names(ANALYSIS_VIEW_TOOL_CONTRACTS),
      ...names(MANAGED_WORKFLOW_TOOL_CONTRACTS),
    ],
    workflowBoundaries,
  ),
  family(
    "session-evidence",
    "Evidence and unknowns",
    "Evidence export, import, retained discovery, residual-unknown lifecycle, comparisons, and derived verification.",
    SESSION_EVIDENCE_TOOLS,
    sessionBoundaries,
  ),
  family(
    "process-and-network",
    "Process and network",
    "Declared process capture, capture comparison, and saved PCAP summaries.",
    [...PROCESS_TOOLS, ...names(PCAP_TOOL_CONTRACTS)],
    processBoundaries,
  ),
  provider(
    "ghidra",
    "Ghidra provider",
    "Ghidra headless deep analysis for native binaries.",
    GHIDRA_OPERATIONS,
    ghidraBoundaries,
    "Ghidra results are provider observations; the ephemeral database is deleted on close and annotations are not saved to the executable.",
  ),
  provider(
    "ida",
    "IDA provider",
    "IDA analysis through an existing IDA MCP configuration.",
    IDA_OPERATIONS,
    idaBoundaries,
    "Live IDA results describe the current database; input identity does not prove an unmodified database.",
  ),
  provider(
    "hopper",
    "Hopper provider",
    "Hopper analysis through REA's private bridge.",
    HOPPER_OPERATIONS,
    hopperBoundaries,
    "Hopper observations describe the current GUI session and preserve provider limitations.",
  ),
  ...EXTERNAL_TOOL_PACKAGE_DESCRIPTORS,
];

const validateCatalog = (
  packages: readonly ToolPackageDescriptor[],
  contracts: readonly ToolContract[],
): void => {
  const contractNames = new Map(contracts.map(({ name }) => [name, true]));
  const ids = new Set<string>();
  const covered = new Set<string>();
  for (const descriptor of packages) {
    if (ids.has(descriptor.id))
      throw new Error(`Duplicate tool package id: ${descriptor.id}`);
    ids.add(descriptor.id);
    for (const dependency of descriptor.requires)
      if (!packages.some(({ id }) => id === dependency))
        throw new Error(
          `Tool package ${descriptor.id} requires unknown package ${dependency}`,
        );
    for (const tool of descriptor.tools) {
      if (!contractNames.has(tool))
        throw new Error(
          `Tool package ${descriptor.id} names unknown tool ${tool}`,
        );
      covered.add(tool);
    }
  }
  for (const descriptor of packages)
    for (const dependency of descriptor.requires)
      if (!ids.has(dependency))
        throw new Error(
          `Tool package ${descriptor.id} requires unknown package ${dependency}`,
        );
  const gateway = new Set(TOOL_PACKAGE_GATEWAY_TOOLS);
  const missing = contracts
    .map(({ name }) => name)
    .filter((name) => !gateway.has(name) && !covered.has(name));
  if (missing.length > 0)
    throw new Error(
      `Tool packages do not cover: ${missing.join(", ")}. Add each tool to a package.`,
    );
};

/** Build the package catalog and verify complete, non-dangling tool coverage. */
export const buildToolPackageCatalog = (
  contracts: readonly ToolContract[] = TOOL_CONTRACTS,
  descriptors: readonly ToolPackageDescriptor[] = PACKAGE_DESCRIPTORS,
): ToolPackageCatalog => {
  validateCatalog(descriptors, contracts);
  const byId = new Map(
    descriptors.map((descriptor) => [descriptor.id, descriptor]),
  );
  const byTool = new Map<string, string[]>();
  for (const descriptor of descriptors)
    for (const tool of descriptor.tools) {
      const owners = byTool.get(tool);
      if (owners === undefined) byTool.set(tool, [descriptor.id]);
      else owners.push(descriptor.id);
    }
  return {
    packages: descriptors,
    byId,
    byTool,
    gatewayTools: TOOL_PACKAGE_GATEWAY_TOOLS,
  };
};

export const TOOL_PACKAGE_CATALOG = buildToolPackageCatalog();

/** Merge discovered MCP mod packages into the built-in package catalog. */
export const buildToolPackageCatalogWithMods = (
  modPackages: readonly ToolPackageDescriptor[],
): ToolPackageCatalog =>
  modPackages.length === 0
    ? TOOL_PACKAGE_CATALOG
    : buildToolPackageCatalog(TOOL_CONTRACTS, [
        ...PACKAGE_DESCRIPTORS,
        ...modPackages,
      ]);

/** One-sentence operation summary that leaves full text to detail=full. */
export const summarizeToolDescription = (
  description: string,
  maximum = 180,
): string => {
  const sentence = description.split(/(?<=[.!?])\s+/u)[0] ?? description;
  return sentence.length <= maximum
    ? sentence
    : `${sentence.slice(0, Math.max(0, maximum - 3))}...`;
};

/** Compact index appended to MCP instructions in progressive mode. */
export const renderToolPackageIndex = (catalog: ToolPackageCatalog): string =>
  [
    "Tool packages are progressively disclosed. A host may prefix these names (for example mcp__rea__). Call list_tool_packages for the index, inspect_tool_package for one package's boundaries and operations, open_tool_package to enable its advertised tools, and close_tool_package when done. Until opened, only the package tools are advertised; the host's own tools do not replace them.",
    "Packages:",
    ...catalog.packages.map(
      (descriptor) =>
        `- ${descriptor.id} (${descriptor.kind}): ${descriptor.summary}`,
    ),
  ].join("\n");
