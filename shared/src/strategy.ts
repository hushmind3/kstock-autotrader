import type { DailyBar, Quote } from "./domain.js";

export type StrategyAction = "BUY" | "SELL" | "HOLD" | "NOT_READY";

export interface StrategyRequirements {
  minimumDailyBars: number;
  needsCurrentPrice: boolean;
  needsCumulativeVolume: boolean;
}

export interface StrategyMarketSnapshot {
  symbol: string;
  completedDailyBars: DailyBar[];
  quote: Quote | null;
  hasPosition: boolean;
}

export interface StrategyDecision {
  action: StrategyAction;
  reasonCodes: string[];
  metrics: Record<string, number | string | boolean | null>;
}

export type StrategyConfigFieldKind = "number" | "percent";

export interface StrategyConfigField {
  key: string;
  label: string;
  kind: StrategyConfigFieldKind;
  defaultValue: number;
  help: string;
  suffix?: string;
  min?: number;
  max?: number;
  step?: number;
}

export interface StrategySummary {
  id: string;
  name: string;
  version: string;
  description: string;
  defaultConfig: Record<string, number | string | boolean | null>;
  configFields: StrategyConfigField[];
}

export interface StrategyDefinition<TConfig = unknown> {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description?: string;
  readonly defaultConfig?: () => TConfig;
  readonly configFields?: readonly StrategyConfigField[];
  requirements(config: TConfig): StrategyRequirements;
  validateConfig(input: unknown): TConfig;
  evaluate(snapshot: StrategyMarketSnapshot, config: TConfig): StrategyDecision;
}

export interface StrategyRegistryContract {
  list(): StrategySummary[];
  get(id: string): StrategyDefinition;
}
