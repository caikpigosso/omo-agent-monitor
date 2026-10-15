import { planItemAt } from "./plan.mjs";
import { toolBreakdown } from "./transcript.mjs";

export const modelName = value => typeof value === "string" ? value : value
  ? `${value.provider}/${value.model_id}` : undefined;

export function taskStats(stats) {
  if (!stats) return undefined;
  return { runtimeMs: stats.runtime_ms, turns: stats.turns, toolCalls: stats.tool_calls,
    inputTokens: stats.input_tokens, outputTokens: stats.output_tokens,
    cacheReadTokens: stats.cache_read_tokens, cacheWriteTokens: stats.cache_write_tokens,
    totalTokens: stats.total_tokens, costUsd: stats.cost_usd,
    tokensPerSecond: stats.tokens_per_second, cacheHitRate: stats.cache_hit_rate_run };
}

export function buildTaskView(record, detail, context) {
  const requestedModel = modelName(record.requested_model) || modelName(record.model);
  const effectiveModel = modelName(record.effective_model) || modelName(record.resolved_model)
    || (detail.model ? `${detail.model.provider}/${detail.model.model}` : undefined) || requestedModel;
  const effective = effectiveModel?.split("/") || [];
  const current = detail.timeline.findLast(event => event.tool && !event.tool.endedAt)
    || detail.timeline.findLast(event => event.tool);
  let dag;
  for (const run of context.dags) {
    const node = run.nodes.find(node => node.taskId === record.task_id);
    if (node) { dag = { runId: run.id, nodeId: node.id }; break; }
  }
  return { id: record.task_id, ...context.lineage,
    rootId: record.root_session_id, depth: record.depth ?? context.lineage?.depth,
    name: record.description || record.task_summary || record.name || record.task_id,
    agent: record.subagent_type || record.category || record.agent_type, status: record.status,
    provider: effective[0], model: effective.slice(1).join("/"),
    requestedModel, effectiveModel, fallbackUsed: !!requestedModel && !!effectiveModel && requestedModel !== effectiveModel,
    tokens: record.run_stats?.total_tokens, createdAt: record.created_at,
    startedAt: record.started_at, endedAt: record.terminal_at,
    stats: taskStats(record.run_stats), dag, planItem: planItemAt(context.snapshots, record.created_at),
    toolCount: detail.timeline.filter(event => event.kind === "tool").length,
    toolBreakdown: toolBreakdown(detail.timeline),
    current: record.status === "running" && current
      ? { name: current.tool.name, summary: current.tool.summary, at: current.at } : undefined,
    lastText: detail.messages.findLast(message => message.role === "assistant")?.text.slice(-240)
      || record.final_response?.slice(-240), sessionPath: record.sessionPath };
}
