import { watch } from "node:fs";
import { mkdir, readdir, readFile, writeFile, chmod, unlink } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { agentDir as defaultAgentDir, runDir as defaultRunDir } from "./paths.mjs";

// Optional quota source: a module exporting readCoordinator() (e.g. a personal omo-auto launcher).
async function loadQuotaReader(agentDir) {
  const path = process.env.OMO_MONITOR_QUOTA_MODULE || join(agentDir, "tools", "omo-auto.mjs");
  if (!await Bun.file(path).exists()) return undefined;
  const module = await import(path);
  return typeof module.readCoordinator === "function" ? module.readCoordinator : undefined;
}

const terminalStates = new Set(["completed", "error", "failed", "lost", "cancelled", "interrupted"]);
const textOf = content => typeof content === "string" ? content
  : (content || []).filter(item => item.type === "text").map(item => item.text).join("\n");
const json = (value, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const packet = value => new TextEncoder().encode(`event: state\ndata: ${JSON.stringify(value)}\n\n`);
async function optionalRead(path) { try { return await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}
async function filesIn(path) { try { return await readdir(path); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
export function parseTranscript(contents) {
  const timeline = [], messages = [], calls = new Map();
  let instruction = "", seenUser = false, model;
  const lines = contents.split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    let entry;
    try { entry = JSON.parse(lines[index]); }
    catch (error) { if (index === lines.length - 1) break; throw error; }
    const at = entry.timestamp;
    if (entry.type === "model_change") {
      model = { provider: entry.provider, model: entry.modelId };
      timeline.push({ id: entry.id, at, kind: "model", text: `${entry.provider}/${entry.modelId}` });
    }
    if (entry.type !== "message") continue;
    const message = entry.message, text = textOf(message.content);
    if (text) messages.push({ id: entry.id, role: message.role === "toolResult" ? "tool" : message.role,
      text: message.role === "toolResult" ? text.slice(0, 20_000) : text, at, tool: message.toolName });
    switch (message.role) {
      case "toolResult": {
        const call = calls.get(message.toolCallId);
        if (call) Object.assign(call.tool, { result: text.slice(0, 20_000), truncated: text.length > 20_000,
          isError: message.isError === true, endedAt: at });
        break;
      }
      case "user":
        timeline.push({ id: entry.id, at, kind: seenUser ? "user" : "instruction", text });
        if (!seenUser) instruction = text;
        seenUser = true;
        break;
      case "assistant":
        for (const [i, item] of (typeof message.content === "string"
          ? [{ type: "text", text: message.content }] : message.content || []).entries()) {
          const event = { id: `${entry.id}:${i}`, at };
          switch (item.type) {
            case "text": timeline.push({ ...event, kind: "assistant", text: item.text }); break;
            case "thinking": {
              const title = /^\s*\*\*([^*\n]+)\*\*/.exec(item.thinking || "")?.[1];
              if (title) timeline.push({ ...event, kind: "thinking", text: title });
              break;
            }
            case "toolCall": {
              const args = item.arguments || {}, first = Object.values(args).find(value => typeof value === "string") || "";
              const value = item.name === "bash" ? args.command : item.name === "read" ? args.file_path || args.path
                : item.name === "grep" ? args.pattern : item.name === "ls" ? args.path : first;
              const call = { ...event, kind: "tool", tool: { callId: item.id, name: item.name,
                args: item.arguments, summary: `${item.name}${item.name === "bash" ? ":" : ""} ${value || ""}`
                  .split("\n")[0].slice(0, 240).trim() } };
              calls.set(item.id, call);
              timeline.push(call);
              break;
            }
          }
        }
        break;
    }
  }
  return { instruction, timeline, messages, model };
}

export async function startMonitor({ cwd, parentId, executeTool, sendUserMessage, sessionFile, status, model,
  agentDir = defaultAgentDir, runDir = defaultRunDir }) {
  const readCoordinator = await loadQuotaReader(agentDir);
  const registryPath = join(agentDir, "rpc", "task-stores.json");
  const hash = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 12);
  const streams = new Set(), watchers = []; let records = new Map(), transcripts = new Map(), lineage = new Map();
  const controlToken = randomBytes(32).toString("hex"), startedAt = new Date().toISOString();
  let server, store, storeWatcher, revision = 0, stopped = false, refreshing, dirty = false, snapshot, fingerprint;
  let coordinator = parseTranscript("");
  function taskView(record) {
    const detail = transcripts.get(record.task_id) || parseTranscript("");
    const requested = (record.model || "").split("/"), effective = record.effective_model || record.resolved_model;
    // Tool calls finish in seconds, so fall back to the latest one to show what a running agent is doing.
    const current = detail.timeline.findLast(event => event.tool && !event.tool.endedAt)
      || detail.timeline.findLast(event => event.tool);
    return { id: record.task_id, ...lineage.get(record.task_id),
      name: record.description || record.task_summary || record.name || record.task_id,
      agent: record.subagent_type || record.category || record.agent_type, status: record.status,
      provider: effective?.provider || detail.model?.provider || requested[0],
      model: effective?.model_id || detail.model?.model || requested.slice(1).join("/"),
      tokens: record.run_stats?.total_tokens, createdAt: record.created_at,
      startedAt: record.started_at, endedAt: record.terminal_at,
      toolCount: detail.timeline.filter(event => event.kind === "tool").length,
      current: record.status === "running" && current
        ? { name: current.tool.name, summary: current.tool.summary, at: current.at } : undefined,
      lastText: detail.messages.findLast(message => message.role === "assistant")?.text.slice(-240)
        || record.final_response?.slice(-240), sessionPath: record.sessionPath };
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
    const dags = [];
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
  if (sessionFile) watchers.push(watch(dirname(sessionFile), (_event, file) => { if (file === basename(sessionFile)) changed(); }));
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
