import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import {
  TOOL_PACKAGE_CATALOG,
  summarizeToolDescription,
  type ToolPackageCatalog,
  type ToolPackageDescriptor,
  type ToolPackageKind,
} from "../composition/toolPackageCatalog.js";
import { TOOL_CONTRACTS, toolContract } from "../contracts/toolContracts.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { LoadedMod } from "../composition/modLoader.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import type { McpModHost, ModToolInfo } from "./mcpModHost.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

export type ToolPackageSurfaceMode = "full" | "packages";

export interface ToolPackageSurfaceOptions {
  readonly mode: ToolPackageSurfaceMode;
  readonly catalog?: ToolPackageCatalog;
  readonly contracts?: readonly ToolContract[];
  /** Package IDs to open before the first tools/list response. */
  readonly pinned?: readonly string[];
  /** MCP mod host used by packages that declare an `mcp` transport. */
  readonly modHost?: McpModHost;
  readonly mods?: ReadonlyMap<string, LoadedMod>;
}

interface PackageSummary {
  readonly id: string;
  readonly title: string;
  readonly kind: ToolPackageKind;
  readonly summary: string;
  readonly tool_count: number;
  readonly profile_count: number;
  readonly open: boolean;
}

interface ToolPackageOperation {
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  readonly description?: string;
}

const packageNotFound = (
  operation: string,
  packageId: string,
  catalog: ToolPackageCatalog,
): AnalysisInputError =>
  new AnalysisInputError(
    operation,
    { userMessage: `Unknown tool package "${packageId}".` },
    [
      {
        path: ["package_id"],
        reason: "invalid_value",
        message: `Known packages: ${catalog.packages
          .map(({ id }) => id)
          .join(", ")}.`,
      },
    ],
  );

const jsonObject = (value: unknown): JsonValue => jsonValueSchema.parse(value);

/**
 * Session-scoped progressive-disclosure controller. It owns the set of open
 * packages and reconciles the MCP SDK's per-tool enabled flags. Every concrete
 * tool stays registered; only its advertisement and callability change.
 */
export class ToolPackageSurface {
  private readonly openPackages = new Set<string>();
  private readonly contractsByName: ReadonlyMap<string, ToolContract>;

  constructor(
    private readonly server: EvidenceMcpServer,
    readonly catalog: ToolPackageCatalog,
    readonly mode: ToolPackageSurfaceMode,
    contracts: readonly ToolContract[],
    private readonly modHost: McpModHost | undefined = undefined,
    private readonly mods: ReadonlyMap<string, LoadedMod> = new Map(),
  ) {
    this.contractsByName = new Map(
      contracts.map((contract) => [contract.name, contract]),
    );
  }

  isGateway(name: string): boolean {
    return this.catalog.gatewayTools.includes(name);
  }

  /** Whether this tool is part of the currently advertised surface. */
  isAdvertised(name: string): boolean {
    if (this.mode === "full" || this.isGateway(name)) return true;
    for (const id of this.openPackages) {
      const descriptor = this.catalog.byId.get(id);
      if (descriptor?.tools.includes(name) === true) return true;
      if (
        this.modHost
          ?.toolsFor(id)
          .some(({ publicName }) => publicName === name) === true
      )
        return true;
    }
    return false;
  }

  list(kind?: ToolPackageKind): JsonValue {
    return jsonObject({
      surface: this.mode,
      packages: this.catalog.packages
        .filter((descriptor) => kind === undefined || descriptor.kind === kind)
        .map((descriptor) => this.summary(descriptor)),
    });
  }

  inspect(
    operation: string,
    packageId: string,
    detail: "summary" | "full",
  ): JsonValue {
    const descriptor = this.requirePackage(operation, packageId);
    return jsonObject({
      package: {
        ...this.summary(descriptor),
        requires: descriptor.requires,
        boundaries: descriptor.boundaries,
        operations: this.operations(operation, descriptor, detail),
        profiles: descriptor.profiles,
        usage: descriptor.usage,
        evidence: descriptor.evidence,
      },
    });
  }

  async open(
    operation: string,
    packageId: string,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const descriptor = this.requirePackage(operation, packageId);
    if (descriptor.mcp !== undefined)
      return this.openMod(operation, descriptor, signal);
    if (this.mode === "full")
      return jsonObject({
        package_id: descriptor.id,
        kind: descriptor.kind,
        status: "full-surface",
        enabled_tools: descriptor.tools,
        dependency_packages: descriptor.requires,
        tools_changed: false,
        usage: descriptor.usage,
      });
    if (descriptor.kind === "external")
      return jsonObject({
        package_id: descriptor.id,
        kind: descriptor.kind,
        status: "external",
        enabled_tools: [],
        dependency_packages: [],
        tools_changed: false,
        usage: descriptor.usage,
      });
    const alreadyOpen = this.openPackages.has(descriptor.id);
    for (const id of this.openClosure(descriptor)) this.openPackages.add(id);
    const toolsChanged = this.reconcile();
    return jsonObject({
      package_id: descriptor.id,
      kind: descriptor.kind,
      status: alreadyOpen ? "already-open" : "opened",
      enabled_tools: descriptor.tools,
      dependency_packages: descriptor.requires,
      tools_changed: toolsChanged,
      usage: null,
    });
  }

  async close(operation: string, packageId: string): Promise<JsonValue> {
    const descriptor = this.requirePackage(operation, packageId);
    if (descriptor.mcp !== undefined)
      return this.closeMod(operation, descriptor);
    if (this.mode === "full")
      return jsonObject({
        package_id: descriptor.id,
        kind: descriptor.kind,
        status: "full-surface",
        disabled_tools: [],
        still_enabled: descriptor.tools,
        tools_changed: false,
      });
    if (descriptor.kind === "external")
      return jsonObject({
        package_id: descriptor.id,
        kind: descriptor.kind,
        status: "external",
        disabled_tools: [],
        still_enabled: [],
        tools_changed: false,
      });
    if (!this.openPackages.has(descriptor.id))
      return jsonObject({
        package_id: descriptor.id,
        kind: descriptor.kind,
        status: "not-open",
        disabled_tools: [],
        still_enabled: descriptor.tools,
        tools_changed: false,
      });
    const dependents = [...this.openPackages].filter(
      (id) =>
        id !== descriptor.id &&
        this.catalog.byId.get(id)?.requires.includes(descriptor.id) === true,
    );
    if (dependents.length > 0)
      throw new AnalysisInputError(
        operation,
        {
          userMessage: `Cannot close package "${descriptor.id}" while open packages require it.`,
        },
        [
          {
            path: ["package_id"],
            reason: "invalid_value",
            message: `Close these packages first: ${dependents.join(", ")}.`,
          },
        ],
      );
    this.openPackages.delete(descriptor.id);
    const toolsChanged = this.reconcile();
    const stillEnabled = new Set(this.enabledToolNames());
    return jsonObject({
      package_id: descriptor.id,
      kind: descriptor.kind,
      status: "closed",
      disabled_tools: descriptor.tools.filter(
        (name) => !stillEnabled.has(name),
      ),
      still_enabled: descriptor.tools.filter((name) => stillEnabled.has(name)),
      tools_changed: toolsChanged,
    });
  }

  /** Concrete tools currently advertised through an open package. */
  enabledToolNames(): readonly string[] {
    const names = new Set<string>(this.catalog.gatewayTools);
    for (const id of this.openPackages) {
      const descriptor = this.catalog.byId.get(id);
      if (descriptor === undefined) continue;
      for (const name of descriptor.tools) names.add(name);
      for (const tool of this.modHost?.toolsFor(id) ?? [])
        names.add(tool.publicName);
    }
    return [...names];
  }

  private async openMod(
    operation: string,
    descriptor: ToolPackageDescriptor,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const host = this.modHost;
    const loaded = this.mods.get(descriptor.id);
    if (host === undefined || loaded === undefined)
      throw new AnalysisCapabilityUnavailableError(
        descriptor.id,
        operation,
        "No MCP mod host is configured for this package.",
        {
          userMessage: `Mod "${descriptor.id}" is not available in this REA server.`,
        },
      );
    const alreadyOpen =
      this.openPackages.has(descriptor.id) && host.isOpen(descriptor.id);
    const dependencies = [...this.openClosure(descriptor)]
      .filter((id) => id !== descriptor.id)
      .reverse();
    const newlyOpened: string[] = [];
    let tools: readonly ModToolInfo[];
    try {
      for (const id of dependencies) {
        const dependency = this.catalog.byId.get(id);
        if (dependency === undefined) continue;
        if (dependency.mcp !== undefined && !host.isOpen(id)) {
          const dependencyMod = this.mods.get(id);
          if (dependencyMod === undefined)
            throw new AnalysisCapabilityUnavailableError(
              id,
              operation,
              "Required mod package has no loaded manifest.",
              { userMessage: `Required mod "${id}" is not loaded.` },
            );
          await host.open(dependencyMod, signal);
          newlyOpened.push(id);
        }
      }
      tools = await host.open(loaded, signal);
    } catch (cause: unknown) {
      // Roll back dependency servers started for this failed open.
      await Promise.allSettled(newlyOpened.map((id) => host.close(id)));
      throw cause;
    }
    for (const id of dependencies) this.openPackages.add(id);
    this.openPackages.add(descriptor.id);
    const reconciled = this.mode === "full" ? false : this.reconcile();
    return jsonObject({
      package_id: descriptor.id,
      kind: descriptor.kind,
      status: alreadyOpen ? "already-open" : "opened",
      enabled_tools: tools.map(({ publicName }) => publicName),
      dependency_packages: descriptor.requires,
      tools_changed: tools.length > 0 || reconciled,
      usage: descriptor.usage,
    });
  }

  private async closeMod(
    operation: string,
    descriptor: ToolPackageDescriptor,
  ): Promise<JsonValue> {
    const host = this.modHost;
    if (host === undefined)
      throw new AnalysisCapabilityUnavailableError(
        descriptor.id,
        operation,
        "No MCP mod host is configured for this package.",
        {
          userMessage: `Mod "${descriptor.id}" is not available in this REA server.`,
        },
      );
    const dependents = [...this.openPackages].filter(
      (id) =>
        id !== descriptor.id &&
        this.catalog.byId.get(id)?.requires.includes(descriptor.id) === true,
    );
    if (dependents.length > 0)
      throw new AnalysisInputError(
        operation,
        {
          userMessage: `Cannot close package "${descriptor.id}" while open packages require it.`,
        },
        [
          {
            path: ["package_id"],
            reason: "invalid_value",
            message: `Close these packages first: ${dependents.join(", ")}.`,
          },
        ],
      );
    const tools = host.toolsFor(descriptor.id);
    if (!this.openPackages.has(descriptor.id) && !host.isOpen(descriptor.id))
      return jsonObject({
        package_id: descriptor.id,
        kind: descriptor.kind,
        status: "not-open",
        disabled_tools: [],
        still_enabled: [],
        tools_changed: false,
      });
    await host.close(descriptor.id);
    this.openPackages.delete(descriptor.id);
    const reconciled = this.mode === "full" ? false : this.reconcile();
    return jsonObject({
      package_id: descriptor.id,
      kind: descriptor.kind,
      status: "closed",
      disabled_tools: tools.map(({ publicName }) => publicName),
      still_enabled: [],
      tools_changed: tools.length > 0 || reconciled,
    });
  }

  private summary(descriptor: ToolPackageDescriptor): PackageSummary {
    return {
      id: descriptor.id,
      title: descriptor.title,
      kind: descriptor.kind,
      summary: descriptor.summary,
      tool_count:
        descriptor.tools.length +
        (this.modHost?.toolsFor(descriptor.id).length ?? 0),
      profile_count: descriptor.profiles.length,
      open: this.mode === "full" || this.openPackages.has(descriptor.id),
    };
  }

  private operations(
    operation: string,
    descriptor: ToolPackageDescriptor,
    detail: "summary" | "full",
  ): readonly ToolPackageOperation[] {
    const declared = descriptor.tools.map((name) =>
      this.operation(operation, name, detail),
    );
    const proxied = (this.modHost?.toolsFor(descriptor.id) ?? []).map(
      (tool) => ({
        name: tool.publicName,
        title: tool.title,
        summary: summarizeToolDescription(tool.description),
        ...(detail === "full" ? { description: tool.description } : {}),
      }),
    );
    return [...declared, ...proxied];
  }

  private operation(
    operation: string,
    name: string,
    detail: "summary" | "full",
  ): ToolPackageOperation {
    const contract = this.contractsByName.get(name);
    if (contract === undefined)
      throw new AnalysisInputError(operation, {
        userMessage: `Tool package member "${name}" has no canonical contract.`,
      });
    return {
      name,
      title: contract.title,
      summary: summarizeToolDescription(contract.description),
      ...(detail === "full" ? { description: contract.description } : {}),
    };
  }

  private requirePackage(
    operation: string,
    packageId: string,
  ): ToolPackageDescriptor {
    const descriptor = this.catalog.byId.get(packageId);
    if (descriptor === undefined)
      throw packageNotFound(operation, packageId, this.catalog);
    return descriptor;
  }

  private openClosure(descriptor: ToolPackageDescriptor): readonly string[] {
    const closure = new Set<string>([descriptor.id]);
    const visit = (id: string): void => {
      const current = this.catalog.byId.get(id);
      if (current === undefined) return;
      for (const dependency of current.requires) {
        if (closure.has(dependency)) continue;
        closure.add(dependency);
        visit(dependency);
      }
    };
    visit(descriptor.id);
    return [...closure];
  }

  /**
   * Match every registered tool's SDK enabled flag to the union of open
   * packages plus the always-visible gateways. Returns whether any flag moved.
   */
  private reconcile(): boolean {
    const target = new Set(this.enabledToolNames());
    let changed = false;
    for (const name of this.server.registeredToolNames()) {
      const handle = this.server.toolHandle(name);
      if (handle === undefined) continue;
      const shouldEnable = target.has(name) || this.isGateway(name);
      if (shouldEnable !== handle.enabled) {
        if (shouldEnable) handle.enable();
        else handle.disable();
        changed = true;
      }
    }
    return changed;
  }
}

const runSurfaceOperation = async (
  server: EvidenceMcpServer,
  contract: ToolContract,
  operation: () => JsonValue | Promise<JsonValue>,
): Promise<ReturnType<EvidenceMcpServer["delivery"]["toCallToolResult"]>> => {
  try {
    return server.delivery.toCallToolResult(
      { ok: true, value: await operation() },
      contract,
    );
  } catch (cause: unknown) {
    if (
      cause instanceof AnalysisInputError ||
      cause instanceof AnalysisCapabilityUnavailableError
    )
      return server.delivery.toCallToolResult(
        { ok: false, error: cause as AnalysisError },
        contract,
      );
    throw cause;
  }
};

/** Register the four package-gateway tools. */
export const registerToolPackageTools = (
  server: EvidenceMcpServer,
  surface: ToolPackageSurface,
): void => {
  const listContract = toolContract("list_tool_packages");
  server.registerTool(
    listContract.name,
    toolRegistrationOptions(listContract),
    async (input) =>
      runSurfaceOperation(server, listContract, () => surface.list(input.kind)),
  );
  const inspectContract = toolContract("inspect_tool_package");
  server.registerTool(
    inspectContract.name,
    toolRegistrationOptions(inspectContract),
    async (input) =>
      runSurfaceOperation(server, inspectContract, () =>
        surface.inspect(inspectContract.name, input.package_id, input.detail),
      ),
  );
  const openContract = toolContract("open_tool_package");
  server.registerTool(
    openContract.name,
    toolRegistrationOptions(openContract),
    async (input, context) =>
      runSurfaceOperation(server, openContract, () =>
        surface.open(
          openContract.name,
          input.package_id,
          context.mcpReq.signal,
        ),
      ),
  );
  const closeContract = toolContract("close_tool_package");
  server.registerTool(
    closeContract.name,
    toolRegistrationOptions(closeContract),
    async (input) =>
      runSurfaceOperation(server, closeContract, () =>
        surface.close(closeContract.name, input.package_id),
      ),
  );
};

/** Create the controller before dependent tools need its advertisement view. */
export const createToolPackageSurface = (
  server: EvidenceMcpServer,
  options: ToolPackageSurfaceOptions,
): ToolPackageSurface => {
  const catalog = options.catalog ?? TOOL_PACKAGE_CATALOG;
  const contracts = options.contracts ?? TOOL_CONTRACTS;
  return new ToolPackageSurface(
    server,
    catalog,
    options.mode,
    contracts,
    options.modHost,
    options.mods,
  );
};

/**
 * Install the progressive-disclosure surface. In `packages` mode every
 * non-gateway tool is disabled immediately after registration; opening a
 * package re-enables its members and emits tools/list_changed.
 */
export const installToolPackageSurface = (
  server: EvidenceMcpServer,
  options: ToolPackageSurfaceOptions,
  existing?: ToolPackageSurface,
): ToolPackageSurface => {
  const surface = existing ?? createToolPackageSurface(server, options);
  registerToolPackageTools(server, surface);
  if (options.mode === "full") return surface;

  const registered = new Set(server.registeredToolNames());
  const missing = surface.catalog.packages
    .flatMap((descriptor) => descriptor.tools)
    .filter((name) => !registered.has(name));
  if (missing.length > 0)
    throw new Error(
      `Tool packages name unregistered tools: ${[...new Set(missing)].join(", ")}`,
    );
  for (const name of server.registeredToolNames())
    if (!surface.isGateway(name)) server.toolHandle(name)?.disable();
  const unknownPinned = (options.pinned ?? []).filter(
    (id) => !surface.catalog.byId.has(id),
  );
  if (unknownPinned.length > 0)
    throw new Error(
      `REA_MCP_TOOL_PACKAGES names unknown packages: ${unknownPinned.join(", ")}`,
    );
  for (const packageId of options.pinned ?? [])
    surface.open("startup", packageId);
  return surface;
};
