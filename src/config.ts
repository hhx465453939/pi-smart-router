/**
 * 配置加载：全局 ~/.pi/agent/pi-router.json + 项目级 .pi/pi-router.json（项目覆盖全局）
 * 含归一化、热加载（tick 探针）、错误模式编译。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { NormalizedRouterConfig, RouterConfig } from "./types.ts";
import { compileErrorPatterns } from "./engine/failure.ts";

const GLOBAL_REL = ".pi/agent/pi-router.json";
const PROJECT_REL = ".pi/pi-router.json";

function readJsonFile(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function globalConfigPath(): string {
  return join(homedir(), GLOBAL_REL);
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, PROJECT_REL);
}

export function deepMerge(base: RouterConfig, override: RouterConfig): RouterConfig {
  if (!override) return base;
  const out: RouterConfig = { ...base, ...override };
  if (override.fallback) out.fallback = { ...(base.fallback as object ?? {}), ...(override.fallback as object) } as RouterConfig["fallback"];
  if (override.failure) out.failure = { ...(base.failure as object ?? {}), ...(override.failure as object) } as RouterConfig["failure"];
  if (override.taskTypeRules) out.taskTypeRules = { ...(base.taskTypeRules ?? {}), ...(override.taskTypeRules ?? {}) };
  if (override.cache) out.cache = { ...(base.cache as object ?? {}), ...(override.cache as object) } as RouterConfig["cache"];
  if (override.learn) out.learn = { ...(base.learn as object ?? {}), ...(override.learn as object) } as RouterConfig["learn"];
  if (override.churn) out.churn = { ...(base.churn as object ?? {}), ...(override.churn as object) } as RouterConfig["churn"];
  if (override.difficulty) out.difficulty = { ...(base.difficulty as object ?? {}), ...(override.difficulty as object) } as RouterConfig["difficulty"];
  if (override.selfLearn) out.selfLearn = { ...(base.selfLearn as object ?? {}), ...(override.selfLearn as object) } as RouterConfig["selfLearn"];
  if (override.probe) out.probe = { ...(base.probe as object ?? {}), ...(override.probe as object) } as RouterConfig["probe"];
  return out;
}

export function normalizeConfig(raw: RouterConfig | undefined): NormalizedRouterConfig {
  const r: RouterConfig = raw ?? {};
  const cooldownMs = Number.isFinite(r.cooldownMs as number) ? Math.max(1000, Math.trunc(r.cooldownMs as number)) : 60_000;
  const routingLevel = r.routingLevel === "request" || r.routingLevel === "both" ? r.routingLevel : "turn";
  const cacheEnabled = r.cache?.enabled !== false;
  const preferCache = r.cache?.preferCache !== false;
  const minHitChars = Number.isFinite(r.cache?.minHitChars as number) ? Math.max(0, Math.trunc(r.cache!.minHitChars as number)) : 1024;
  const sticky = r.cache?.sticky !== false;
  const stickyTtlMs = Number.isFinite(r.cache?.stickyTtlMs as number) ? Math.max(0, Math.trunc(r.cache!.stickyTtlMs as number)) : 300000;
  const learnEnabled = r.learn?.enabled !== false;
  const learnWindow = Number.isFinite(r.learn?.windowSize as number) ? Math.max(1, Math.trunc(r.learn!.windowSize as number)) : 50;
  const learnMinSamples = Number.isFinite(r.learn?.minSamples as number) ? Math.max(1, Math.trunc(r.learn!.minSamples as number)) : 2;
  const learnSW = Number.isFinite(r.learn?.successWeight as number) ? (r.learn!.successWeight as number) : 1.0;
  const learnFW = Number.isFinite(r.learn?.failureWeight as number) ? (r.learn!.failureWeight as number) : -2.0;
  const learnCW = Number.isFinite(r.learn?.cacheWeight as number) ? (r.learn!.cacheWeight as number) : 0.0005;
  const learnCostW = Number.isFinite(r.learn?.costWeight as number) ? (r.learn!.costWeight as number) : -0.0001;
  const churnEnabled = r.churn?.enabled !== false;
  const churnMax = Number.isFinite(r.churn?.maxChurnTokens as number) ? Math.max(0, Math.trunc(r.churn!.maxChurnTokens as number)) : 8000;
  const diffEnabled = r.difficulty?.enabled !== false;
  const diffLow = Number.isFinite(r.difficulty?.lowThreshold as number) ? Math.max(0, r.difficulty!.lowThreshold as number) : 40;
  const diffHigh = Number.isFinite(r.difficulty?.highThreshold as number) ? Math.max(diffLow + 1, r.difficulty!.highThreshold as number) : 120;
  const slEnabled = r.selfLearn?.enabled !== false;
  const slMin = Number.isFinite(r.selfLearn?.minSamples as number) ? Math.max(1, Math.trunc(r.selfLearn!.minSamples as number)) : 3;
  const slDecay = Number.isFinite(r.selfLearn?.decay as number) ? Math.min(1, Math.max(0.1, r.selfLearn!.decay as number)) : 0.9;
  const slSW = Number.isFinite(r.selfLearn?.successWeight as number) ? (r.selfLearn!.successWeight as number) : 1.0;
  const slFW = Number.isFinite(r.selfLearn?.failureWeight as number) ? (r.selfLearn!.failureWeight as number) : -2.0;
  const slCostW = Number.isFinite(r.selfLearn?.costWeight as number) ? (r.selfLearn!.costWeight as number) : -0.0001;
  const probeEnabled = r.probe?.enabled !== false;
  const probeTimeout = Number.isFinite(r.probe?.timeoutMs as number) ? Math.max(1000, Math.trunc(r.probe!.timeoutMs as number)) : 300000;
  const probeOnStart = r.probe?.probeOnStart !== false;
  const probeExclude = r.probe?.excludeUnavailable !== false;
  const pool = Array.isArray(r.pool) ? [...new Set(r.pool.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim()))] : [];
  return {
    enabled: r.enabled !== false,
    pool,
    defaultModel: typeof r.defaultModel === "string" ? r.defaultModel.trim() || undefined : undefined,
    routingLevel,
    cooldownMs,
    cooldownOnStatus: Array.isArray(r.failure?.cooldownOnStatus) ? (r.failure!.cooldownOnStatus as number[]).filter((n) => Number.isFinite(n)) : [429, 500, 502, 503, 504],
    cooldownOnToolErrorPatterns: compileErrorPatterns(r.failure?.cooldownOnToolErrorPatterns ?? ["rate.?limit", "context.?length", "overloaded", "too.?many.?requests", "service.?unavailable", "timeout", "AccountQuotaExceeded", "quota.*exceeded", "exceeded.*quota", "insufficient.*quota", "monthly.*quota"]),
    taskTypeRules: r.taskTypeRules ?? {},
    rules: Array.isArray(r.rules) ? (r.rules as NormalizedRouterConfig["rules"]) : [],
    fallback: r.fallback ?? { mode: "off" as const },
    explicitModelPrefix: typeof r.explicitModelPrefix === "string" && r.explicitModelPrefix.trim() ? r.explicitModelPrefix.trim() : "@model:",
    verbose: Boolean(r.verbose),
    cache: { enabled: cacheEnabled, preferCache, minHitChars, sticky, stickyTtlMs },
    learn: { enabled: learnEnabled, windowSize: learnWindow, minSamples: learnMinSamples, successWeight: learnSW, failureWeight: learnFW, cacheWeight: learnCW, costWeight: learnCostW },
    churn: { enabled: churnEnabled, maxChurnTokens: churnMax },
    catalogPath: typeof r.catalogPath === "string" && r.catalogPath.trim() ? r.catalogPath.trim() : join(homedir(), ".pi/agent/pi-router-catalog.json"),
    difficulty: { enabled: diffEnabled, lowThreshold: diffLow, highThreshold: diffHigh },
    selfLearn: { enabled: slEnabled, minSamples: slMin, decay: slDecay, successWeight: slSW, failureWeight: slFW, costWeight: slCostW },
    probe: { enabled: probeEnabled, timeoutMs: probeTimeout, probeOnStart, excludeUnavailable: probeExclude },
  };
}

export function loadRawConfig(cwd: string): RouterConfig {
  const globalRaw = readJsonFile(globalConfigPath()) as RouterConfig | undefined;
  const projectRaw = readJsonFile(projectConfigPath(cwd)) as RouterConfig | undefined;
  const base: RouterConfig = {};
  let merged = globalRaw ? deepMerge(base, globalRaw) : base;
  if (projectRaw) merged = deepMerge(merged, projectRaw);
  return merged;
}

export function loadConfig(cwd: string): NormalizedRouterConfig {
  return normalizeConfig(loadRawConfig(cwd));
}

export interface ConfigWatcher {
  get(): NormalizedRouterConfig;
  reload(): NormalizedRouterConfig;
}

export function createConfigWatcher(cwd: string): ConfigWatcher {
  let cached = loadConfig(cwd);
  return {
    get() { return cached; },
    reload() { cached = loadConfig(cwd); return cached; },
  };
}

/** 持久化 enabled 开关（写入全局配置，若存在项目配置则优先写项目） */
export function persistEnabled(cwd: string, enabled: boolean): void {
  const projectPath = projectConfigPath(cwd);
  const globalPath = globalConfigPath();
  const targetPath = existsSync(projectPath) ? projectPath : globalPath;
  let raw: Record<string, unknown> = {};
  if (existsSync(targetPath)) {
    try { raw = JSON.parse(readFileSync(targetPath, "utf8")) as Record<string, unknown>; } catch { raw = {}; }
  }
  raw.enabled = enabled;
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
  } catch { /* 忽略写入失败 */ }
}

/** 持久化模型池（固定写入全局 ~/.pi/agent/pi-router.json，pi 全局生效） */
export function persistPool(pool: string[]): void {
  const targetPath = globalConfigPath();
  let raw: Record<string, unknown> = {};
  if (existsSync(targetPath)) {
    try { raw = JSON.parse(readFileSync(targetPath, "utf8")) as Record<string, unknown>; } catch { raw = {}; }
  }
  raw.pool = pool;
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
  } catch { /* 忽略写入失败 */ }
}

/** 池过滤：pool 空 → 返回全部选择器（原样）；否则只保留池内（大小写不敏感） */
export function filterByPool<T extends string>(selectors: Iterable<T>, pool: string[]): T[] {
  const arr = [...selectors];
  if (!pool || pool.length === 0) return arr;
  const pset = new Set(pool.map((s) => s.toLowerCase()));
  return arr.filter((s) => pset.has(s.toLowerCase()));
}
