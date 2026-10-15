import { watch } from "node:fs";
import { mkdir, appendFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { iso, optionalRead, readJson } from "./storage.mjs";
import { quotaCachePath } from "./paths.mjs";

export const accountKey = (provider, name) => `${provider}:${name || "unknown"}`;
export function credentialSecrets(value, result = new Set()) {
  for (const [key, item] of Object.entries(value || {})) {
    if (/token|refresh|access|key|email|accountId/i.test(key) && typeof item === "string" && item)
      result.add(item);
    if (item && typeof item === "object") credentialSecrets(item, result);
  }
  return result;
}

// Account/slot identifiers come exclusively from display names, not OAuth accountId.
export async function startAccounts({ agentDir, cachePath = quotaCachePath, onChange = () => {} }) {
  const historyPath = join(agentDir, "agent-monitor", "quota-history.jsonl");
  await mkdir(dirname(historyPath), { recursive: true, mode: 0o700 });
  const samples = (await optionalRead(historyPath)).split("\n").filter(Boolean).map(line => JSON.parse(line));
  let report, secrets = new Set(), stopped = false, refreshing, dirty = false;
  const last = new Map();
  for (const sample of samples) last.set(sample.provider, JSON.stringify(sample));
  async function rebuild() {
    const [auth, pool, cache] = await Promise.all([readJson(join(agentDir, "auth.json")),
      readJson(join(agentDir, "credential-pool-state.json")), readJson(cachePath)]);
    secrets = credentialSecrets(auth); credentialSecrets(pool, secrets);
    const quotas = [];
    for (const [key, provider] of [["claude", "anthropic-subscription"], ["codex", "chatgpt-subscription"]]) {
      const value = cache?.[key]; if (!value) continue;
      const updatedAt = iso(value.updatedAt); if (!updatedAt) continue;
      const account = key === "claude" ? value.account : "ChatGPT";
      const windows = (value.windows || []).map(window => ({ label: window.label, percent: window.percent,
        resetsAt: iso(window.resetsAt), windowMs: window.windowMs }));
      quotas.push({ provider, account, plan: value.plan, state: value.accountState, updatedAt, windows });
      const sample = { at: updatedAt, provider, account,
        windows: windows.map(({ label, percent, resetsAt }) => ({ label, percent, resetsAt })) };
      const serialized = JSON.stringify(sample);
      if (last.get(provider) !== serialized) {
        await appendFile(historyPath, serialized + "\n", { mode: 0o600 });
        samples.push(sample); last.set(provider, serialized);
      }
    }
    const accounts = [];
    for (const provider of ["anthropic-subscription", "chatgpt-subscription"]) {
      const credentials = auth?.[provider]; if (!credentials) continue;
      const quota = quotas.find(item => item.provider === provider);
      const entries = provider === "anthropic-subscription" ? credentials.accounts || []
        : [{ name: "ChatGPT", expires: credentials.expires }];
      for (const entry of entries) {
        const slot = pool?.providers?.[provider]?.lanes?.stored?.slots?.[entry.name];
        const blockedUntil = iso(entry.blockedUntil);
        const active = quota?.account === entry.name;
        accounts.push({ id: accountKey(provider, entry.name), provider, name: entry.name, active,
          pinned: credentials.pinned === entry.name,
          state: blockedUntil && new Date(blockedUntil).getTime() > Date.now() ? "blocked"
            : active ? quota.state : undefined,
          expiresAt: iso(entry.expires), blockedUntil, blockReason: entry.blockReason,
          lastSuccessAt: iso(slot?.lastSuccessAt), failureCount: slot?.failureCount });
      }
    }
    const byProvider = {};
    for (const account of accounts) byProvider[account.provider] = (byProvider[account.provider] || 0) + 1;
    const next = { counts: { total: accounts.length, byProvider }, accounts, quotas };
    if (JSON.stringify(next) !== JSON.stringify(report)) { report = next; onChange(report); }
  }
  function refresh() {
    dirty = true;
    if (!refreshing) refreshing = (async () => {
      try { while (dirty && !stopped) { dirty = false; await rebuild(); } }
      finally { refreshing = undefined; }
    })();
    return refreshing;
  }
  const watchers = [];
  async function watchPath(path) {
    // Watch the nearest existing ancestor, so atomic replacement and later creation work.
    let directory = dirname(path);
    for (;;) {
      try {
        watchers.push(watch(directory, { recursive: true }, (_event, name) => {
          if (name && String(name) !== relative(directory, path)) return;
          refresh().catch(error => console.error("[agent-monitor-hub] accounts refresh failed", { error: error.message }));
        })); break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        directory = dirname(directory);
      }
    }
  }
  for (const path of [join(agentDir, "auth.json"), join(agentDir, "credential-pool-state.json"), cachePath])
    await watchPath(path);
  await refresh();
  return {
    report: () => report,
    secrets: () => secrets,
    history: ({ from, to }) => samples.filter(sample => sample.at >= from && sample.at <= to).sort((a, b) => a.at.localeCompare(b.at)),
    accountAt(provider, at) {
      if (provider === "chatgpt-subscription") return "ChatGPT";
      if (provider !== "anthropic-subscription") return undefined;
      let prior;
      for (const sample of samples) if (sample.provider === provider && sample.at <= at
        && (!prior || sample.at >= prior.at)) prior = sample;
      return prior?.account;
    },
    async stop() {
      stopped = true; for (const watcher of watchers) watcher.close(); if (refreshing) await refreshing;
    },
  };
}
