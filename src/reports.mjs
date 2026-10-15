import { emptyMetrics, addMetrics, iso } from "./storage.mjs";
import { accountKey } from "./accounts.mjs";
import { modelName } from "./task-view.mjs";

export function reportQuery(params) {
  const to = params.has("to") ? iso(params.get("to")) : new Date().toISOString();
  const from = params.has("from") ? iso(params.get("from"))
    : to && new Date(new Date(to).getTime() - 7 * 86_400_000).toISOString();
  const bucket = params.get("bucket") || "day", groupBy = params.get("groupBy") || "provider";
  if (!from || !to || from > to || !["hour", "day"].includes(bucket)
    || !["provider", "model", "project", "agent", "session", "account"].includes(groupBy)) return undefined;
  return { from, to, bucket, groupBy };
}

export function usageReport(index, accounts, query) {
  const totals = emptyMetrics(), groups = new Map();
  for (const row of index.rows()) {
    if (row.at < query.from || row.at > query.to) continue;
    let key, label;
    switch (query.groupBy) {
      case "provider": key = row.provider; label = key; break;
      case "model": key = `${row.provider}/${row.model}`; label = key; break;
      case "project": key = row.project; label = key; break;
      case "agent": key = row.agent; label = key; break;
      case "session": key = row.session; label = key; break;
      case "account": {
        const account = accounts.accountAt(row.provider, row.at);
        key = accountKey(row.provider, account); label = `${row.provider} / ${account || "unknown"}`; break;
      }
    }
    if (!groups.has(key)) groups.set(key, { key, label,
      ...(query.groupBy === "account" ? { inferred: true } : {}), points: new Map() });
    const group = groups.get(key);
    const t = query.bucket === "hour" ? row.at.slice(0, 13) + ":00:00.000Z" : row.at.slice(0, 10) + "T00:00:00.000Z";
    if (!group.points.has(t)) group.points.set(t, { t, ...emptyMetrics() });
    addMetrics(group.points.get(t), row); addMetrics(totals, row);
  }
  return { ...query, series: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))
    .map(group => ({ ...group, points: [...group.points.values()].sort((a, b) => a.t.localeCompare(b.t)) })),
    totals, coverage: index.coverage() };
}

function burnReport(index, accounts, query) {
  const burn = [], history = accounts.history(query);
  for (const quota of accounts.report().quotas) {
    if (quota.updatedAt > query.to || quota.updatedAt < query.from) continue;
    for (const window of quota.windows) {
      const start = window.windowMs ? new Date(new Date(window.resetsAt).getTime() - window.windowMs).toISOString() : query.from;
      const matching = history.filter(sample => sample.provider === quota.provider && sample.account === quota.account
        && sample.at >= start && sample.at <= quota.updatedAt).map(sample => ({ at: sample.at,
          window: sample.windows.find(value => value.label === window.label && value.resetsAt === window.resetsAt) }))
        .filter(sample => sample.window);
      const first = matching[0], last = matching.at(-1);
      const hours = first && last ? (new Date(last.at) - new Date(first.at)) / 3_600_000 : 0;
      const delta = first && last ? last.window.percent - first.window.percent : 0;
      const percentPerHour = hours > 0 ? delta / hours : undefined;
      let tokensPerPercent;
      if (delta > 0) {
        let tokens = 0;
        for (const row of index.rows()) {
          if (row.provider === quota.provider && row.at > first.at && row.at <= last.at
            && accounts.accountAt(row.provider, row.at) === quota.account) tokens += row.totalTokens;
        }
        tokensPerPercent = tokens / delta;
      }
      burn.push({ provider: quota.provider, account: quota.account, window: window.label, percent: window.percent,
        resetsAt: window.resetsAt, percentPerHour, tokensPerPercent,
        projectedExhaustAt: percentPerHour > 0 ? new Date(new Date(quota.updatedAt).getTime()
          + Math.max(0, 100 - window.percent) / percentPerHour * 3_600_000).toISOString() : undefined,
        inferred: true });
    }
  }
  return burn;
}

export function insightsReport(index, accounts, context) {
  const { query, projects: openProjects } = context;
  const models = new Map(), projects = new Map(), tools = new Map();
  function projectFor(name) {
    if (!projects.has(name)) projects.set(name, { project: name, costUsd: 0, totalTokens: 0, tasks: 0, sessions: new Set() });
    return projects.get(name);
  }
  function modelFor(provider, model) {
    const key = `${provider}/${model}`;
    if (!models.has(key)) models.set(key, { provider, model, messages: 0, totalTokens: 0, costUsd: 0, fallbackCount: 0 });
    return models.get(key);
  }
  for (const row of index.rows()) {
    if (row.at < query.from || row.at > query.to) continue;
    const model = modelFor(row.provider, row.model);
    model.messages++; model.totalTokens += row.totalTokens; model.costUsd += row.costUsd;
    const project = projectFor(row.project);
    project.costUsd += row.costUsd; project.totalTokens += row.totalTokens; project.sessions.add(row.session);
  }
  const topTasks = [];
  for (const task of index.taskRecords()) {
    if (task.created_at < query.from || task.created_at > query.to) continue;
    const effective = modelName(task.effective_model) || modelName(task.resolved_model) || modelName(task.model);
    const requested = modelName(task.requested_model) || modelName(task.model);
    if (effective && requested && effective !== requested) {
      const [provider, ...model] = effective.split("/");
      modelFor(provider, model.join("/")).fallbackCount++;
    }
    projectFor(task.project).tasks++;
    const open = [...openProjects.values()].find(project => project.entry.id === task.root_session_id)
      || [...openProjects.values()].find(project => project.entry.cwd === task.spawn_spec?.cwd);
    topTasks.push({ project: task.project, projectId: open?.entry.id, taskId: task.task_id,
      name: task.description || task.task_summary || task.name || task.task_id,
      agent: task.agent_type || task.subagent_type || task.category, status: task.status, model: effective,
      costUsd: task.run_stats?.cost_usd, totalTokens: task.run_stats?.total_tokens,
      runtimeMs: task.run_stats?.runtime_ms, createdAt: task.created_at });
  }
  for (const project of openProjects.values()) {
    const state = project.state;
    for (const breakdown of [state?.coordinatorStats?.toolBreakdown, ...(state?.tasks || []).map(task => task.toolBreakdown)]) {
      for (const [name, counts] of Object.entries(breakdown || {})) {
        if (!tools.has(name)) tools.set(name, { name, calls: 0, errors: 0 });
        const tool = tools.get(name); tool.calls += counts.calls; tool.errors += counts.errors;
      }
    }
  }
  return { burn: burnReport(index, accounts, query),
    topTasks: topTasks.sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0)),
    models: [...models.values()].sort((a, b) => b.costUsd - a.costUsd),
    tools: [...tools.values()].sort((a, b) => b.calls - a.calls),
    projects: [...projects.values()].map(project => ({ ...project, sessions: project.sessions.size }))
      .sort((a, b) => b.costUsd - a.costUsd) };
}
