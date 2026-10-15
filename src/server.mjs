import { watch } from "node:fs";
import { mkdir, readdir, readFile, writeFile, chmod, unlink } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { agentDir as defaultAgentDir, runDir as defaultRunDir } from "./paths.mjs";
import { parseTranscript, textOf } from "./transcript.mjs";
import { buildTaskView } from "./task-view.mjs";
import { buildPlan, readGoal } from "./plan.mjs";
export { parseTranscript } from "./transcript.mjs";

// Optional quota source: a module exporting readCoordinator() (e.g. a personal omo-auto launcher).
async function loadQuotaReader(agentDir) {
  const path = process.env.OMO_MONITOR_QUOTA_MODULE || join(agentDir, "tools", "omo-auto.mjs");
  if (!await Bun.file(path).exists()) return undefined;
  const module = await import(path);
  return typeof module.readCoordinator === "function" ? module.readCoordinator : undefined;
}

const terminalStates = new Set(["completed", "error", "failed", "lost", "cancelled", "interrupted"]);
const json = (value, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const packet = value => new TextEncoder().encode(`event: state\ndata: ${JSON.stringify(value)}\n\n`);
async function optionalRead(path) { try { return await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}
async function filesIn(path) { try { return await readdir(path); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
export async function startMonitor({ cwd, parentId, executeTool, sendUserMessage, sessionFile, status, model,
  agentDir = defaultAgentDir, runDir = defaultRunDir }) {
  const readCoordinator = await loadQuotaReader(agentDir);
  const registryPath = join(agentDir, "rpc", "task-stores.json");
  const hash = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 12);
  const streams = new Set(), watchers = []; let records = new Map(), transcripts = new Map(), lineage = new Map();
  const controlToken = randomBytes(32).toString("hex"), startedAt = new Date().toISOString();
  let server, store, storeWatcher, revision = 0, stopped = false, refreshing, dirty = false, snapshot, fingerprint;
  let coordinator = parseTranscript(""), dags = [];
  function taskView(record) {
    const detail = transcripts.get(record.task_id) || parseTranscript("");
    return buildTaskView(record, detail, { lineage: lineage.get(record.task_id), dags,
      snapshots: coordinator.todoSnapshots });
  }
  async function rebuild() {
    const registry = await optionalRead(registryPath);
    const nextStore = Object.keys(registry ? JSON.parse(registry).stores : {})
      .find(path => path.endsWith(`-${hash}/senpi-task`));
    if (nextStore !== store) {
      storeWatcher?.close();
      store = nextStore;
      storeWatcher = store ? watch(store, { recursive: true }, changed) : undefined;
    }
    const nextRecords = new Map(), nextLineage = new Map(), all = [];
    for (const filename of store ? await filesIn(join(store, "tasks")) : []) {
      if (!/^st_[A-Za-z0-9_-]+\.json$/.test(filename)) continue;
      const text = await optionalRead(join(store, "tasks", filename));
      if (text) all.push(JSON.parse(text));
    }
    const parents = new Map([[parentId, { parentId, depth: 1 }]]);
    let added = true;
    while (added) {
      added = false;
      for (const record of all) {
        if (nextRecords.has(record.task_id) || !parents.has(record.parent_session_id)) continue;
        nextRecords.set(record.task_id, record);
        const parent = parents.get(record.parent_session_id);
        nextLineage.set(record.task_id, parent);
        if (record.child_session_id) parents.set(record.child_session_id, { parentId: record.task_id, depth: parent.depth + 1 });
        added = true;
      }
    }
    const nextTranscripts = new Map(await Promise.all([...nextRecords.values()].map(async record => {
      let path = record.host_session?.session_path;
      if (!path && record.child_session_id) {
        const directory = join(store, "children", record.task_id, "sessions", record.task_id);
        const filename = (await filesIn(directory)).find(name => name.endsWith(`_${record.child_session_id}.jsonl`));
        if (filename) path = join(directory, filename);
      }
      record.sessionPath = path;
      return [record.task_id, parseTranscript(path ? await optionalRead(path) : "")];
    })));
    coordinator = parseTranscript(sessionFile ? await optionalRead(sessionFile) : "");
    dags = [];
    for (const filename of store ? await filesIn(join(store, "dag", "runs")) : []) {
      if (!filename.endsWith(".json")) continue;
      const text = await optionalRead(join(store, "dag", "runs", filename));
      if (!text) continue;
      const value = JSON.parse(text);
      if (!parents.has(value.parentSessionId)) continue;
      dags.push({ id: value.runId, name: value.name, status: value.status,
        nodes: value.nodes.map(node => ({ id: node.id, label: node.label || node.id,
          state: node.state, taskId: node.taskId, dependsOn: node.dependsOn })) });
    }
    const quota = readCoordinator ? await readCoordinator() : { kind: "none" };
    records = nextRecords; lineage = nextLineage; transcripts = nextTranscripts;
    const next = { connection: "live", controlToken,
      parents: [{ id: parentId, name: "OmO coordinator", cwd, project: basename(cwd),
        model: coordinator.model ? `${coordinator.model.provider}/${coordinator.model.model}` : model, status }],
      tasks: [...records.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)).map(taskView), dags,
      coordinatorStats: coordinator.stats,
      plan: buildPlan(coordinator.todoSnapshots, [...records.values()]),
      goal: await readGoal(sessionFile, parentId),
      quota: quota.kind === "selected" ? { ...quota.remaining, selectedProvider: quota.provider } : {},
      errors: quota.kind === "selected" || quota.kind === "none" ? []
        : ["Quota has fewer than two recent readings; refresh it in the native usage panel."] };
    const nextFingerprint = JSON.stringify([next, coordinator.timeline, [...transcripts]]); if (nextFingerprint === fingerprint) return;
    fingerprint = nextFingerprint;
    snapshot = { revision: ++revision, ...next };
    for (const stream of streams) stream.enqueue(packet(snapshot));
  }
  function refresh() { dirty = true;
    if (!refreshing) refreshing = (async () => {
      try { while (dirty && !stopped) { dirty = false; await rebuild(); } }
      finally { refreshing = undefined; }
    })();
    return refreshing;
  }
  function changed() { refresh().catch(error => console.error("[agent-monitor] refresh failed", { parentId, error: error.message })); }
  await mkdir(dirname(registryPath), { recursive: true });
  watchers.push(watch(dirname(registryPath), (_event, file) => { if (file === "task-stores.json") changed(); }));
  if (sessionFile) watchers.push(watch(dirname(sessionFile), { recursive: true }, (_event, file) => {
    if (file === basename(sessionFile) || file === join("extensions", "goal", `${parentId}.json`)) changed();
  }));
  await refresh();
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, maxRequestBodySize: 256_000,
    async fetch(request) {
      const url = new URL(request.url), path = url.pathname;
      if (url.hostname !== "127.0.0.1") return json({ error: "Control not authorized.", code: "unauthorized" }, 403);
      if (request.method === "GET" && path === "/") return new Response(Bun.file(join(import.meta.dir, "index.html")));
      if (request.method === "GET" && path === "/api/state") return json(snapshot);
      if (request.method === "GET" && path === "/api/events") {
        let controller;
        return new Response(new ReadableStream({
          start(stream) { controller = stream; streams.add(stream); stream.enqueue(packet(snapshot)); },
          cancel() { streams.delete(controller); },
        }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
      }
      const match = /^\/api\/tasks\/(st_[A-Za-z0-9_-]+)(?:\/(message|abort))?$/.exec(path);
      const isCoordinator = path === "/api/coordinator" || path === "/api/coordinator/message";
      if (!isCoordinator && (!match || !records.has(match[1]))) return json({ error: "Agent is not part of this session.", code: "task_not_found" }, 404);
      if (request.method === "GET" && (path === "/api/coordinator" || !isCoordinator && !match[2])) {
        await refresh();
        if (isCoordinator) return json({ parent: snapshot.parents[0], timeline: coordinator.timeline });
        const record = records.get(match[1]), detail = transcripts.get(match[1]);
        if (!record) return json({ error: "Agent is not part of this session.", code: "task_not_found" }, 404);
        return json({ task: taskView(record), instruction: detail.instruction, timeline: detail.timeline, messages: detail.messages });
      }
      if (request.method !== "POST" || isCoordinator && path !== "/api/coordinator/message" || !isCoordinator && !match[2])
        return json({ error: "Method not allowed.", code: "method_not_allowed" }, 405);
      if (request.headers.get("X-OmO-Control") !== controlToken
        || request.headers.has("Origin") && request.headers.get("Origin") !== server.url.origin)
        return json({ error: "Control not authorized.", code: "unauthorized" }, 403);
      try {
        const action = isCoordinator ? "message" : match[2], record = isCoordinator ? undefined : records.get(match[1]);
        if (action === "abort" && terminalStates.has(record.status)) return json({ error: "This agent has already finished.", code: "agent_finished" }, 409);
        let body = {};
        try { if (action === "message") body = await request.json(); }
        catch (error) { if (error instanceof SyntaxError) return json({ error: "Invalid JSON.", code: "invalid_json" }, 400); throw error; }
        if (action === "message" && (typeof body?.text !== "string" || !body.text.trim() || body.text.length > 32_000))
          return json({ error: "Send a message of up to 32,000 characters.", code: "invalid_message" }, 400);
        if (isCoordinator) {
          if (!sendUserMessage) return json({ error: "Coordinator unavailable.", code: "coordinator_unavailable" }, 503);
          await sendUserMessage(body.text, { deliverAs: "followUp" });
          return json({ ok: true, outcome: "delivered" });
        }
        const nested = await executeTool(action === "message" ? "task_send" : "task_cancel",
          action === "message" ? { to: record.task_id, message: body.text }
            : { task_id: record.task_id, reason: "Interrupted from the local agent monitor." });
        const details = nested.result.details;
        const accepted = action === "message" ? ["steered", "revived", "queued"].includes(details?.kind)
          : details?.kind === "cancelled" && details.status === "cancelled";
        return nested.isError || !accepted ? json({ error: textOf(nested.result.content), code: "control_rejected" }, 409)
          : json({ ok: true, outcome: details.kind });
      } catch (error) {
        console.error("[agent-monitor] control failed", { parentId, error: error.message });
        return json({ error: "Failed to control the agent.", code: "control_failed" }, 500);
      }
    },
  });
  await mkdir(runDir, { recursive: true }); const registration = join(runDir, `${parentId}.json`);
  await writeFile(registration, JSON.stringify({ id: parentId, name: basename(cwd), cwd,
    url: server.url.toString(), token: controlToken, pid: process.pid, startedAt }), { mode: 0o600 });
  await chmod(registration, 0o600);
  return { url: server.url.toString(),
    updateParent(value) { ({ status, model, sessionFile } = { status, model, sessionFile, ...value }); changed(); },
    async stop() {
      stopped = true; for (const watcher of watchers) watcher.close(); storeWatcher?.close();
      if (refreshing) await refreshing;
      for (const stream of streams) stream.close();
      streams.clear(); server.stop(true); await unlink(registration);
    },
  };
}
