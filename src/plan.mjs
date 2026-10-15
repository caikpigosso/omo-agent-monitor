import { dirname, join } from "node:path";
import { readJson, iso } from "./storage.mjs";

export function planItemAt(snapshots, at) {
  const snapshot = snapshots.findLast(value => value.at <= at);
  for (const phase of snapshot?.data.phases || []) {
    const item = phase.tasks.find(task => task.status === "in_progress");
    if (item) return { phase: phase.name, content: item.content, inferred: true };
  }
}

export function buildPlan(snapshots, records) {
  if (!snapshots.length) return undefined;
  const timestamps = new Map(), history = [];
  for (const snapshot of snapshots) {
    let done = 0, total = 0;
    for (const phase of snapshot.data.phases || []) {
      for (const task of phase.tasks) {
        const key = JSON.stringify([phase.name, task.content]);
        const times = timestamps.get(key) || { firstSeenAt: snapshot.at };
        timestamps.set(key, times);
        const field = { in_progress: "startedAt", completed: "completedAt", dropped: "droppedAt" }[task.status];
        if (field && !times[field]) times[field] = snapshot.at;
        total++; if (task.status === "completed") done++;
      }
    }
    history.push({ at: snapshot.at, done, total });
  }
  const latest = snapshots.at(-1), links = new Map();
  for (const record of records) {
    const item = planItemAt(snapshots, record.created_at);
    if (!item) continue;
    const key = JSON.stringify([item.phase, item.content]);
    if (!links.has(key)) links.set(key, []);
    links.get(key).push(record.task_id);
  }
  return { ask: latest.data.ask?.text, updatedAt: latest.at,
    phases: (latest.data.phases || []).map(phase => ({ name: phase.name,
      items: phase.tasks.map(task => {
        const key = JSON.stringify([phase.name, task.content]);
        return { content: task.content, status: task.status, ...timestamps.get(key),
          taskIds: links.get(key) || [], inferred: true };
      }) })), history };
}

export function goalPath(sessionFile, parentId) {
  return sessionFile ? join(dirname(sessionFile), "extensions", "goal", `${parentId}.json`) : undefined;
}

export async function readGoal(sessionFile, parentId) {
  if (!sessionFile) return undefined;
  const value = (await readJson(goalPath(sessionFile, parentId)))?.goal;
  if (!value) return undefined;
  return { id: value.id, objective: value.objective, status: value.status,
    createdAt: iso(value.createdAt * 1000), updatedAt: iso(value.updatedAt * 1000),
    tokensUsed: value.tokensUsed, timeUsedSeconds: value.timeUsedSeconds };
}
