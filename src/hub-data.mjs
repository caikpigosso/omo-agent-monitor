import { startAccounts } from "./accounts.mjs";
import { startUsageIndex } from "./usage-index.mjs";
import { reportQuery, usageReport, insightsReport } from "./reports.mjs";

export const dataEndpoints = new Set(["/api/usage", "/api/accounts", "/api/quota-history", "/api/insights"]);

export async function startHubData({ agentDir, projects, emit }) {
  const accounts = await startAccounts({ agentDir, onChange: report => emit("accounts", report) });
  let index;
  try {
    index = await startUsageIndex({ agentDir, onChange: hint => emit("usage", hint) });
  } catch (error) { await accounts.stop(); throw error; }
  index.ready.catch(error => console.error("[agent-monitor-hub] initial usage scan failed", { error: error.message }));
  return {
    ready: index.ready,
    secrets: accounts.secrets,
    initial: () => ({ accounts: accounts.report(), usage: { indexedAt: index.coverage().indexedAt } }),
    response(path, params) {
      if (path === "/api/accounts") return { value: accounts.report() };
      const query = reportQuery(params);
      if (!query) return { status: 400, value: { error: "Invalid report query.", code: "invalid_query" } };
      switch (path) {
        case "/api/usage": return { value: usageReport(index, accounts, query) };
        case "/api/quota-history": return { value: { samples: accounts.history(query) } };
        case "/api/insights": return { value: insightsReport(index, accounts, { query, projects }) };
      }
    },
    async stop() { await Promise.all([accounts.stop(), index.stop()]); },
  };
}
