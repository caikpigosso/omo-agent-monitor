import { readFile, readdir } from "node:fs/promises";

export async function optionalRead(path) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}

export async function filesIn(path, options) {
  try { return await readdir(path, options); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

export async function readJson(path) {
  const text = await optionalRead(path);
  return text ? JSON.parse(text) : undefined;
}

export const iso = value => value === undefined || value === null ? undefined
  : Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : undefined;

export const emptyMetrics = () => ({ messages: 0, inputTokens: 0, outputTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 });

export function usageMetrics(usage) {
  return { messages: 1, inputTokens: usage.input || 0, outputTokens: usage.output || 0,
    cacheReadTokens: usage.cacheRead || 0, cacheWriteTokens: usage.cacheWrite || 0,
    totalTokens: usage.totalTokens ?? ((usage.input || 0) + (usage.output || 0)
      + (usage.cacheRead || 0) + (usage.cacheWrite || 0)), costUsd: usage.cost?.total || 0 };
}

export function addMetrics(target, source) {
  for (const key of Object.keys(emptyMetrics())) target[key] += source[key];
}
