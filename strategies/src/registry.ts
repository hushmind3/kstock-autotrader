import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  StrategyConfigValue,
  StrategyDefinition,
  StrategyRegistryContract,
  StrategySummary,
} from "@kstock/shared";
import { breakoutVolumeStrategy } from "./breakout-volume.js";
import { movingAverageStrategy } from "./moving-average.js";
import { rsiBollingerReboundStrategy } from "./rsi-bollinger-rebound.js";

function configRecord(value: unknown): Record<string, StrategyConfigValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, StrategyConfigValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      item === null ||
      typeof item === "number" ||
      typeof item === "string" ||
      typeof item === "boolean"
    ) {
      result[key] = item;
    }
  }
  return result;
}

function isStrategy(value: unknown): value is StrategyDefinition {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StrategyDefinition>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.version === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.requirements === "function" &&
    typeof candidate.validateConfig === "function" &&
    typeof candidate.evaluate === "function"
  );
}

export class StrategyRegistry implements StrategyRegistryContract {
  readonly #strategies = new Map<string, StrategyDefinition>();

  constructor(initialStrategies: StrategyDefinition[] = [
    movingAverageStrategy,
    breakoutVolumeStrategy,
    rsiBollingerReboundStrategy,
  ]) {
    for (const strategy of initialStrategies) this.register(strategy);
  }

  register(strategy: StrategyDefinition): void {
    if (this.#strategies.has(strategy.id)) {
      throw new Error(`Strategy already registered: ${strategy.id}`);
    }
    this.#strategies.set(strategy.id, strategy);
  }

  async loadExternal(directory: string): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const loaded: string[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".mjs") && !entry.endsWith(".js")) continue;
      const module = (await import(pathToFileURL(path.join(directory, entry)).href)) as {
        default?: unknown;
        strategy?: unknown;
      };
      const strategy = module.default ?? module.strategy;
      if (!isStrategy(strategy)) throw new Error(`Invalid strategy module: ${entry}`);
      this.register(strategy);
      loaded.push(strategy.id);
    }
    return loaded;
  }

  list(): StrategySummary[] {
    return [...this.#strategies.values()].map((strategy) => ({
      id: strategy.id,
      name: strategy.name,
      version: strategy.version,
      description: strategy.description ?? "설정된 계산 규칙으로 매수·매도 후보를 찾습니다.",
      defaultConfig: configRecord(strategy.defaultConfig?.()),
      configFields: strategy.configFields?.map((field) => ({ ...field })) ?? [],
    }));
  }

  get(id: string): StrategyDefinition {
    const strategy = this.#strategies.get(id);
    if (!strategy) throw new Error(`Unknown strategy: ${id}`);
    return strategy;
  }
}
