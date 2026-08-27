/**
 * 配置加载：全局 ~/.pi/agent/pi-router.json + 项目级 .pi/pi-router.json（项目覆盖全局）
 * 含归一化、热加载（tick 探针）、错误模式编译。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { NormalizedRouterConfig, RouterConfig } from "../types.ts";
import { compileErrorPatterns } from "../engine/failure.ts";

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

function deepMerge(base: RouterConfig, override: RouterConfig): RouterConfig {
  if (!override) return base;
  const out: RouterConfig = { ...base, ...override };
  if (override.fallback) out.fallback = { ...(base.fallback as object ?? {}), ...(override.fallback as object) } as RouterConfig["fallback"];
  if (override.failure) out.failure = { ...(base.failure as object ?? {}), ...(override.failure as object) } as RouterConfig["failure"];
  if (override.taskTypeRules) out.taskTypeRules = { ...(base.taskTypeRules ?? {}), ...(override.taskTypeRules ?? {}) };
  if (override.cache) out.cache = { ...(base.cache as object ?? {}), ...(override.cache as object) } as RouterConfig["cache"];
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
  return {
    enabled: r.enabled !== false,
    defaultModel: typeof r.defaultModel === "string" ? r.defaultModel.trim() || undefined : undefined,
    routingLevel,
    cooldownMs,
    cooldownOnStatus: Array.isArray(r.failure?.cooldownOnStatus) ? (r.failure!.cooldownOnStatus as number[]).filter((n) => Number.isFinite(n)) : [429, 500, 502, 503, 504],
    cooldownOnToolErrorPatterns: compileErrorPatterns(r.failure?.cooldownOnToolErrorPatterns ?? ["rate.?limit", "context.?length", "overloaded", "too.?many.?requests", "service.?unavailable", "timeout"]),
    taskTypeRules: r.taskTypeRules ?? {},
    rules: Array.isArray(r.rules) ? (r.rules as NormalizedRouterConfig["rules"]) : [],
    fallback: r.fallback ?? { mode: "off" as const },
    explicitModelPrefix: typeof r.explicitModelPrefix === "string" && r.explicitModelPrefix.trim() ? r.explicitModelPrefix.trim() : "@model:",
    verbose: Boolean(r.verbose),
    cache: { enabled: cacheEnabled, preferCache, minHitChars, sticky, stickyTtlMs },
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
