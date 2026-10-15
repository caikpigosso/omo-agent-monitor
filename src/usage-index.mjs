import { createReadStream, watch } from "node:fs";
import { mkdir, stat, writeFile, rename, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { filesIn, readJson, usageMetrics } from "./storage.mjs";

// Only numeric usage and session metadata are persisted, never transcript content.
export async function startUsageIndex({ agentDir, onChange = () => {} }) {
  const directory = join(agentDir, "agent-monitor", "usage-index");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = new Map(), tasks = new Map(), pending = new Set(), failures = new Set();
  let stopped = false, indexing, initial = true, indexedAt = new Date().toISOString();
  const cachePath = path => join(directory, createHash("sha256").update(path).digest("hex") + ".json");
  const sessionPath = path => path.endsWith(".jsonl") && (path.startsWith("sessions/")
    || /^projects\/[^/]+\/senpi-task\/children\//.test(path));
  const taskPath = path => /^projects\/[^/]+\/senpi-task\/tasks\/[^/]+\.json$/.test(path);
  async function indexFile(path) {
    const full = join(agentDir, path);
    let info;
    try { info = await stat(full); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      files.delete(path); tasks.delete(path);
      if (sessionPath(path)) await unlink(cachePath(path)).catch(error => { if (error.code !== "ENOENT") throw error; });
      return;
    }
    if (taskPath(path)) {
      const record = await readJson(full);
      if (record) tasks.set(path, record);
      return;
    }
    if (!info.isFile()) return;
    let entry = files.get(path) || await readJson(cachePath(path));
    if (!entry || entry.version !== 1 || entry.ino !== info.ino || entry.offset > info.size)
      entry = { version: 1, ino: info.ino, offset: 0, header: {}, rows: [] };
    if (entry.offset === info.size) { files.set(path, entry); return; }
    entry = { ...entry, rows: [...entry.rows] };
    let buffer = Buffer.alloc(0), offset = entry.offset;
    for await (const chunk of createReadStream(full, { start: offset, end: info.size - 1, highWaterMark: 128 * 1024 })) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      let start = 0, end;
      while ((end = buffer.indexOf(10, start)) !== -1) {
        const line = buffer.subarray(start, end);
        offset += end + 1 - start; start = end + 1;
        if (!line.includes('"usage"') && Object.keys(entry.header).length) continue;
        if (!line.length) continue;
        const value = JSON.parse(line.toString("utf8"));
        if (value.type === "session") entry.header = { id: value.id, cwd: value.cwd };
        if (value.type !== "message" || value.message?.role !== "assistant" || !value.message.usage) continue;
        entry.rows.push({ at: value.timestamp, provider: value.message.provider || "unknown",
          model: value.message.model || "unknown", ...usageMetrics(value.message.usage) });
      }
      buffer = buffer.subarray(start);
      await yieldTurn();
    }
    entry.offset = offset;
    const temporary = cachePath(path) + `.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(entry), { mode: 0o600 });
    await rename(temporary, cachePath(path));
    files.set(path, entry);
  }
  async function drain() {
    while (pending.size && !stopped) {
      const path = pending.values().next().value;
      pending.delete(path);
      try { await indexFile(path); failures.delete(path); }
      catch (error) {
        failures.add(path);
        console.error("[agent-monitor-hub] usage indexing failed", { path, error: error.message });
      }
      indexedAt = new Date().toISOString();
      onChange({ indexedAt });
    }
  }
  function schedule() {
    if (stopped || initial || indexing) return;
    indexing = drain().finally(() => { indexing = undefined; if (pending.size) schedule(); });
  }
  const watcher = watch(agentDir, { recursive: true }, (_event, name) => {
    if (!name || stopped) return;
    const path = String(name);
    if (sessionPath(path) || taskPath(path)) { pending.add(path); schedule(); }
  });
  const ready = (async () => {
    try {
      for (const root of ["sessions", "projects"]) {
        for (const path of await filesIn(join(agentDir, root), { recursive: true })) {
          const full = join(root, path);
          if (sessionPath(full) || taskPath(full)) pending.add(full);
        }
      }
      // Task metadata is available before the large session pass.
      const paths = [...pending].sort((a, b) => Number(sessionPath(a)) - Number(sessionPath(b)));
      pending.clear(); for (const path of paths) pending.add(path);
      await drain();
    } finally {
      initial = false;
      indexedAt = new Date().toISOString(); onChange({ indexedAt }); schedule();
    }
  })();
  return {
    ready,
    coverage: () => ({ files: files.size, indexedAt, partial: initial || !!failures.size }),
    taskRecords: () => [...tasks].map(([path, record]) => ({
      ...record, project: record.spawn_spec?.cwd ? basename(record.spawn_spec.cwd)
        : path.split("/")[1].replace(/-[a-f0-9]{12,24}$/, ""),
    })),
    *rows() {
      const byId = new Map([...tasks.values()].map(record => [record.task_id, record]));
      for (const [path, entry] of files) {
        const taskId = /^projects\/[^/]+\/senpi-task\/children\/([^/]+)/.exec(path)?.[1];
        const task = byId.get(taskId);
        for (const row of entry.rows) yield { ...row, session: entry.header.id || basename(path, ".jsonl"),
          project: basename(entry.header.cwd || "unknown"), agent: taskId
            ? task?.agent_type || task?.subagent_type || task?.category || "unknown" : "coordinator" };
      }
    },
    async stop() {
      stopped = true; watcher.close(); await ready; if (indexing) await indexing;
    },
  };
}
