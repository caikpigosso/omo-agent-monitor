import { appendFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { optionalRead } from "./storage.mjs";
import { jsonLines, watchdogConfig } from "./watchdog-signals.mjs";

export const steerMessage = "Save what you have now, then work in small increments, never more than ~250 lines per tool call, and keep each tool call short.";
const iso = time => new Date(time).toISOString();
const taskName = record => record.description || record.task_summary || record.name || record.task_id;

export async function startWatchdog({ agentDir, parentId, cwd, executeTool, sendUserMessage, onChange,
  config = watchdogConfig(), clock = { now: Date.now, setTimeout, clearTimeout } }) {
  const path = join(agentDir, "agent-monitor", "watchdog.jsonl");
  await mkdir(join(agentDir, "agent-monitor"), { recursive: true, mode: 0o700 });
  const saved = new Map();
  for (const event of jsonLines(await optionalRead(path)))
    if (event.projectId === parentId) saved.set(event.taskId, event);
  const tasks = new Map();
  let timer, stopped = false, work = Promise.resolve();
  function publish(task, kind, detail) {
    const event = { at: iso(clock.now()), projectId: parentId, project: basename(cwd),
      taskId: task.record.task_id, taskName: taskName(task.record),
      kind, state: task.health.state, reason: task.health.reason, detail, health: task.health };
    appendFileSync(path, JSON.stringify(event) + "\n", { mode: 0o600 });
    onChange?.({ taskId: event.taskId, health: structuredClone(task.health) });
  }
  function state(task, value) {
    task.health.state = value; task.health.since = iso(clock.now());
    publish(task, value);
  }
  function action(task, kind, detail) {
    task.health.actions.push({ at: iso(clock.now()), kind, detail });
    // Persist the intent before invoking a side effect: a restart never repeats it.
    publish(task, kind, detail);
  }
  function ingest(task, signals) {
    for (const signal of signals) {
      if (task.seen.has(signal.id)) continue;
      task.seen.add(signal.id);
      switch (signal.kind) {
        case "error": task.health.consecutiveErrors++; break;
        case "tool_start":
          task.pending.add(signal.callId);
          for (const path of signal.paths) task.paths.add(path);
          if (signal.paths.length) task.health.lastWriteAt = signal.at;
          task.health.lastProgressAt = signal.at;
          break;
        case "tool_end":
          task.pending.delete(signal.callId); task.health.lastProgressAt = signal.at; break;
        case "progress":
          task.health.consecutiveErrors = 0; task.health.lastProgressAt = signal.at; break;
      }
      if (signal.kind !== "error") task.health.waitingOnModelSince = signal.at;
    }
    if (task.pending.size) delete task.health.waitingOnModelSince;
    else task.health.waitingOnModelSince ||= task.health.lastProgressAt;
    if (["stalled", "steered"].includes(task.health.state)
      && Date.parse(task.health.lastProgressAt) > task.escalatedAt) state(task, "recovered");
  }
  const running = task => task.record.status === "running" && !task.pending.size;
  async function evaluate() {
    if (stopped || config.mode === "off") return;
    for (const task of tasks.values()) {
      if (!running(task) && task.health.state !== "cancelled") continue;
      if (task.health.state === "ok") {
        const waiting = Date.parse(task.health.waitingOnModelSince);
        const reason = task.health.consecutiveErrors >= config.stallErrors ? "provider_errors"
          : clock.now() - waiting >= config.stallMinutes * 60_000 ? "no_progress" : undefined;
        if (!reason) continue;
        task.health.reason = reason; task.escalatedAt = clock.now();
        state(task, "stalled"); action(task, "alert", `Watchdog detected ${reason}.`);
      }
      if (task.health.state === "stalled" && ["auto", "steer"].includes(config.mode)
        && !task.health.actions.some(value => value.kind === "steer")) {
        action(task, "steer", steerMessage);
        const result = await executeTool("task_send", { to: task.record.task_id, message: steerMessage });
        if (!result.isError && ["steered", "queued", "revived"].includes(result.result?.details?.kind))
          state(task, "steered");
      }
      const steered = task.health.actions.find(value => value.kind === "steer");
      if (task.health.state === "steered" && config.mode === "auto" && running(task)
        && !task.health.actions.some(value => value.kind === "cancel")
        && clock.now() - Date.parse(steered.at) >= config.graceMinutes * 60_000) {
        action(task, "cancel", `Cancellation requested by the agent monitor watchdog: ${task.health.reason}.`);
        const result = await executeTool("task_cancel", { task_id: task.record.task_id,
          reason: `Agent monitor watchdog: ${task.health.reason}; no progress after the ${config.graceMinutes} minute steer grace period.` });
        if (result.isError || result.result?.details?.kind !== "cancelled") continue;
        state(task, "cancelled");
      }
      if (task.health.state === "cancelled" && !task.health.actions.some(value => value.kind === "coordinator_notified")) {
        const text = `Agent monitor watchdog cancelled ${taskName(task.record)} (${task.record.task_id}, ${task.record.subagent_type || task.record.category || task.record.agent_type || "agent"}). Reason: ${task.health.reason}. Last progress: ${task.health.lastProgressAt}; stalled at ${iso(task.escalatedAt)}; grace: ${config.graceMinutes} minutes. Paths written: ${[...task.paths].join(", ") || "none"}. Re-plan the remaining work as 2-4 smaller tasks (one file or view each, increments of <=250 lines per tool call) and spawn them.`;
        action(task, "coordinator_notified", text);
        await sendUserMessage(text, { deliverAs: "followUp" });
      }
    }
  }
  function arm() {
    clock.clearTimeout(timer); timer = undefined;
    if (stopped || config.mode === "off") return;
    const deadlines = [];
    for (const task of tasks.values()) {
      if (!running(task)) continue;
      if (task.health.state === "ok")
        deadlines.push(Date.parse(task.health.waitingOnModelSince) + config.stallMinutes * 60_000);
      if (task.health.state === "steered" && config.mode === "auto"
        && !task.health.actions.some(value => value.kind === "cancel"))
        deadlines.push(Date.parse(task.health.actions.find(value => value.kind === "steer").at) + config.graceMinutes * 60_000);
    }
    const deadline = Math.min(...deadlines.filter(Number.isFinite));
    if (Number.isFinite(deadline)) {
      timer = clock.setTimeout(() => { void enqueue(evaluate); }, Math.max(0, deadline - clock.now()));
      timer?.unref?.();
    }
  }
  function enqueue(operation) {
    work = work.then(operation).catch(error => {
      console.error("[agent-monitor] watchdog failed", { parentId, error: error.message });
    }).finally(arm);
    return work;
  }
  return {
    config,
    health: id => tasks.get(id)?.health || { state: "ok", consecutiveErrors: 0, actions: [] },
    update(batch) {
      return enqueue(async () => {
        const present = new Set();
        for (const { record, signals } of batch) {
          present.add(record.task_id);
          let task = tasks.get(record.task_id);
          if (!task) {
            const prior = saved.get(record.task_id);
            task = { record, pending: new Set(), seen: new Set(), paths: new Set(),
              escalatedAt: Date.parse(prior?.health?.actions.find(value => value.kind === "alert")?.at),
              health: { state: "ok", consecutiveErrors: 0, actions: [], lastProgressAt: record.started_at || record.created_at } };
            tasks.set(record.task_id, task);
            ingest(task, signals);
            if (prior) task.health = { ...task.health, ...prior.health, consecutiveErrors: task.health.consecutiveErrors,
              lastProgressAt: task.health.lastProgressAt, waitingOnModelSince: task.health.waitingOnModelSince };
            if (prior && ["stalled", "steered"].includes(task.health.state)
              && Date.parse(task.health.lastProgressAt) > task.escalatedAt) state(task, "recovered");
          } else { task.record = record; ingest(task, signals); }
        }
        for (const id of tasks.keys()) if (!present.has(id)) tasks.delete(id);
        await evaluate();
      });
    },
    flush: () => work,
    async stop() { stopped = true; clock.clearTimeout(timer); await work; },
  };
}
