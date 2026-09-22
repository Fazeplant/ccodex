import { query, type ModelInfo, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Model } from "../codex/generated/v2/Model.js";
import type { HybridConfig } from "../config/config.js";
import type { Logger } from "../observability/logger.js";
import { MetricsRegistry } from "../observability/metrics.js";
import { modelCatalogValue, normalizeClaudeModelIdentifier } from "./modelSelection.js";
import { claudeEnvironment } from "./environment.js";

const effortDescriptions: Record<string, string> = {
  low: "Faster responses with less reasoning.",
  medium: "Balanced reasoning effort.",
  high: "Deep reasoning for complex work.",
  xhigh: "Extra-high reasoning effort.",
  max: "Maximum available reasoning effort.",
};

interface ClaudeCatalogQuery extends Query {
  getSettings(): Promise<{ readonly applied: { readonly effort: string | null } }>;
}

const requiredControls = [
  "initializationResult", "supportedModels", "reinitialize", "interrupt", "setModel", "getSettings", "close",
] as const;

export function assertClaudeControlSurface(value: unknown): asserts value is ClaudeCatalogQuery {
  if (!value || typeof value !== "object") throw new Error("Claude SDK query did not return a control object.");
  const missing = requiredControls.filter((method) => typeof (value as Record<string, unknown>)[method] !== "function");
  if (missing.length > 0) throw new Error(`Claude SDK query is missing required controls: ${missing.join(", ")}.`);
}

export function claudeModelDisplayName(model: ModelInfo): string {
  const displayName = model.displayName.replace(/\s*\(1M context\)\s*$/iu, "");
  const resolved = model.resolvedModel && normalizeClaudeModelIdentifier(model.resolvedModel);
  const version = resolved && /^claude-([a-z][a-z0-9]*?)-(\d+)(?:-(\d{1,2})(?=-|$))?/u.exec(resolved);
  if (!version) return displayName;
  const [, family, major, minor] = version;
  const label = `${family![0]!.toUpperCase()}${family!.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
  if (displayName.toLocaleLowerCase().includes(label.toLocaleLowerCase())) return displayName;
  if (displayName.toLocaleLowerCase().startsWith(family!)) {
    return `${displayName.slice(0, family!.length)} ${major}${minor ? `.${minor}` : ""}${displayName.slice(family!.length)}`;
  }
  return `${displayName} · ${label}`;
}

export function mapClaudeModel(model: ModelInfo, prefix: string, appliedEffort: string | null): Model {
  const efforts = model.supportsEffort ? (model.supportedEffortLevels ?? []) : [];
  const serviceTiers = model.supportsFastMode
    ? [
        { id: "default", name: "Default", description: "Standard Claude execution." },
        { id: "fast", name: "Fast", description: "Claude fast mode." },
      ]
    : [];
  const id = `${prefix}${modelCatalogValue(model)}`;
  return {
    id,
    model: id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    modelSpecialty: null,
    multiAgentVersion: null,
    displayName: claudeModelDisplayName(model),
    description: model.description,
    hidden: false,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: effortDescriptions[reasoningEffort] ?? `${reasoningEffort} reasoning effort.`,
    })),
    // The Codex model schema requires a value even when this model has no effort setting.
    defaultReasoningEffort: appliedEffort ?? "medium",
    inputModalities: ["text", "image"],
    supportsPersonality: true,
    additionalSpeedTiers: [],
    serviceTiers,
    defaultServiceTier: serviceTiers.length > 0 ? "default" : null,
    isDefault: false,
  };
}

export function mapClaudeModels(
  models: readonly ModelInfo[],
  prefix: string,
  appliedEfforts: ReadonlyMap<string, string | null>,
): Model[] {
  return models.filter((model) => model.value !== "default")
    .map((model) => mapClaudeModel(model, prefix, appliedEfforts.get(model.value)!));
}

export function claudeDefaultModelValue(models: readonly ModelInfo[]): string | undefined {
  const resolved = models.find((model) => model.value === "default")?.resolvedModel;
  return resolved ? normalizeClaudeModelIdentifier(resolved) : undefined;
}

export function claudeModelPickerIds(models: readonly ModelInfo[], prefix: string): ReadonlyMap<string, string> {
  const ids = new Map<string, string>();
  for (const model of models) {
    if (model.value === "default") continue;
    const id = `${prefix}${modelCatalogValue(model)}`;
    ids.set(normalizeClaudeModelIdentifier(model.value), id);
    if (model.resolvedModel) ids.set(normalizeClaudeModelIdentifier(model.resolvedModel), id);
  }
  return ids;
}

async function* idlePrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

export class ClaudeModelCatalog {
  private cache: {
    readonly key: string;
    readonly expiresAt: number;
    readonly models: Model[];
  } | undefined;
  private loading: Promise<Model[]> | undefined;
  private pickerIds: ReadonlyMap<string, string> = new Map();
  private defaultValue: string | undefined;

  public constructor(
    private readonly config: HybridConfig,
    private readonly logger: Logger,
    private readonly metrics: MetricsRegistry = new MetricsRegistry(),
    private readonly queryFactory: typeof query = query,
  ) {}

  public async list(): Promise<Model[]> {
    const key = this.cacheKey();
    if (this.cache && this.cache.key === key && this.cache.expiresAt > Date.now()) return this.cache.models;
    if (this.cache?.key !== key) this.cache = undefined;
    this.loading ??= this.load().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  public invalidate(): void {
    this.cache = undefined;
  }

  public cachedPickerId(model: string): string | undefined {
    const normalized = normalizeClaudeModelIdentifier(model);
    const value = normalized.startsWith(this.config.modelPrefix)
      ? normalized.slice(this.config.modelPrefix.length) : normalized;
    return this.pickerIds.get(value);
  }

  public cachedModels(): readonly Model[] {
    return this.cache?.models ?? [];
  }

  public defaultModelId(): string | undefined {
    return this.defaultValue && `${this.config.modelPrefix}${this.defaultValue}`;
  }

  private async load(): Promise<Model[]> {
    const abort = new AbortController();
    const sdkQuery = this.queryFactory({
      prompt: idlePrompt(abort.signal),
      options: {
        pathToClaudeCodeExecutable: this.config.claudeBinary,
        persistSession: false,
        abortController: abort,
        allowedTools: [],
        settingSources: ["user", "project", "local"],
        env: claudeEnvironment(),
        stderr: (line) => this.logger.debug("claude.model-probe.stderr", { output: line }),
      },
    });

    try {
      assertClaudeControlSurface(sdkQuery);
      const [, models] = await Promise.race([
        Promise.all([sdkQuery.initializationResult(), sdkQuery.supportedModels()]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Claude model probe timed out.")), 10_000),
        ),
      ]);
      const appliedEfforts = new Map<string, string | null>();
      for (const model of models) {
        if (model.value === "default") continue;
        await sdkQuery.setModel(model.value);
        appliedEfforts.set(model.value, (await sdkQuery.getSettings()).applied.effort);
      }
      await sdkQuery.reinitialize();
      await sdkQuery.interrupt();
      const mapped = mapClaudeModels(models, this.config.modelPrefix, appliedEfforts);
      this.pickerIds = claudeModelPickerIds(models, this.config.modelPrefix);
      this.defaultValue = claudeDefaultModelValue(models);
      this.cache = {
        key: this.cacheKey(),
        expiresAt: Date.now() + this.config.modelCacheSeconds * 1_000,
        models: mapped,
      };
      this.logger.info("claude.models.loaded", { count: mapped.length, controls: requiredControls });
      return mapped;
    } catch (error) {
      this.metrics.modelProbeFailed();
      throw error;
    } finally {
      abort.abort();
    }
  }

  private cacheKey(): string {
    const binary = existsSync(this.config.claudeBinary) ? realpathSync(this.config.claudeBinary) : this.config.claudeBinary;
    const identity = existsSync(binary) ? statSync(binary) : undefined;
    const environment = [
      "HOME", "CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
    ].map((name) => [name, process.env[name] ?? null]);
    return createHash("sha256").update(JSON.stringify({
      binary, size: identity?.size ?? null, mtimeMs: identity?.mtimeMs ?? null, environment,
    })).digest("hex");
  }
}
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
