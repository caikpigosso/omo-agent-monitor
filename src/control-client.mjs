import { createConnection } from "node:net";
import { watch } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { filesIn, readJson } from "./storage.mjs";

export function connectControl(socketPath, onEvent = () => {}) {
  const pending = new Map();
  let socket, buffer = "", sequence = 0, closed = false;
  const ready = readFile(`${socketPath}.secret`).then(secret => new Promise((resolve, reject) => {
    socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    socket.once("connect", () => { socket.write(secret); resolve(); });
    socket.once("error", reject);
    socket.on("data", chunk => {
      buffer += chunk.toString();
      let boundary;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        if (!line) continue;
        let frame;
        try { frame = JSON.parse(line); }
        catch (error) { if (error instanceof SyntaxError) { socket.destroy(error); return; } throw error; }
        const waiter = pending.get(frame.id);
        if (frame.type === "response" && waiter) {
          pending.delete(frame.id); clearTimeout(waiter.timer); waiter.resolve(frame);
        } else onEvent(frame);
      }
    });
    socket.on("error", () => {});
    socket.once("close", () => {
      closed = true;
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("Control endpoint disconnected.")); }
      pending.clear(); onEvent({ type: "disconnected" });
    });
  }));
  return {
    async request(type, fields = {}) {
      await ready;
      if (closed) throw new Error("Control endpoint disconnected.");
      const id = `monitor-${process.pid}-${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id); reject(new Error("Control endpoint request timed out.")); socket.destroy();
        }, 1500);
        pending.set(id, { resolve, reject, timer });
        socket.write(JSON.stringify({ ...fields, type, id }) + "\n");
      });
    },
    close() { socket?.destroy(); },
  };
}

export async function startControlClient({ agentDir, parentId, onState, onAvailability }) {
  const registry = join(agentDir, "rpc-host-daemon");
  await mkdir(registry, { recursive: true, mode: 0o700 });
  let client, stopped = false, scanning, dirty = false, pendingIds = [];
  function acceptQuestions(data) {
    if (Array.isArray(data?.pendingQuestions)) { onState(data); return []; }
    if (!Array.isArray(data?.pending)) return [];
    pendingIds = data.pending;
    return onState({ pendingQuestionIds: pendingIds }) || [];
  }
  async function scan() {
    if (stopped) return;
    if (client) { await hydrate(); return; }
    for (const name of await filesIn(registry)) {
      if (!/^[a-f0-9]{16}$/.test(name)) continue;
      const endpoint = await readJson(join(registry, name, "endpoint.json"));
      if (endpoint?.endpoint_kind !== "tui") continue;
      let subscribed = false, replay;
      const candidate = connectControl(endpoint.socket, event => {
        if (candidate !== client) return;
        if (event.type === "disconnected") { client = undefined; onAvailability(false); }
        else if (event.type === "session_control_event" && ["state", "question"].includes(event.kind)) {
          // Replayed transitions may include a preserved question detaching and
          // reattaching. Hydrate only the last snapshot, not those old transitions.
          if (!subscribed) { if (event.kind === "question") replay = event.data; return; }
          const missing = event.kind === "question" ? acceptQuestions(event.data) : [];
          void hydrate(missing).catch(() => { candidate.close(); });
        }
      });
      try {
        const reply = await candidate.request("list_sessions");
        if (!reply.success || !reply.data?.sessions?.some(row =>
          row.durableSessionId === parentId || row.sessionId === parentId || row.id === parentId)) {
          candidate.close(); continue;
        }
        if (stopped) { candidate.close(); return; }
        client = candidate; pendingIds = [];
        // Subscribe before taking a snapshot so a question opening during hydration is not lost.
        await client.request("subscribe", { cursor: 0 });
        subscribed = true;
        await hydrate(replay ? acceptQuestions(replay) : []); onAvailability(true); return;
      } catch (error) {
        candidate.close(); if (client === candidate) { client = undefined; onAvailability(false); }
      }
    }
  }
  async function hydrate(missing = []) {
    const current = client;
    if (!current) return;
    const reply = await current.request("get_state");
    if (reply.success && current === client) onState(reply.data);
    if (!missing.length || current !== client || Array.isArray(reply.data?.pendingQuestions)) return;
    // TUI snapshots omit request metadata. Recover only IDs confirmed by its feed,
    // using the same canonical question IDs as the built-in tools.
    const messages = await current.request("get_messages");
    if (!messages.success || current !== client) return;
    const requests = messages.data.messages.flatMap(message => message.role !== "assistant" ? []
      : (Array.isArray(message.content) ? message.content : []).filter(call => call.type === "toolCall" && missing.includes(call.id)
        && pendingIds.includes(call.id) && ["ask_user_question", "request_user_input"].includes(call.name))
        .map(call => ({ id: call.id, requestId: call.id, askedAtMs: message.timestamp,
          waitForAnswer: call.name === "request_user_input" ? call.arguments.wait_for_answer : call.arguments.waitForAnswer,
          questions: call.arguments.questions.map((question, index) => ({
            id: call.name === "request_user_input" ? question.id.trim() : `q${index + 1}`,
            header: question.header.trim(), question: question.question.trim(), multiSelect: question.multiSelect === true,
            options: (question.options || []).map(option => ({ label: option.label.trim(),
              description: option.description?.trim() || undefined })) })) })));
    onState({ pendingQuestionIds: pendingIds, pendingQuestions: requests });
  }
  function refresh() {
    dirty = true;
    if (!scanning) scanning = (async () => {
      try { while (dirty && !stopped) { dirty = false; await scan(); } }
      finally { scanning = undefined; }
    })();
    return scanning;
  }
  const watcher = watch(registry, { recursive: true }, () => {
    void refresh().catch(error => console.error("[agent-monitor] question bridge discovery failed",
      { parentId, error: error.message }));
  });
  await refresh();
  return {
    available: () => !!client,
    refresh,
    async answer(requestId, body) {
      if (!client) await refresh();
      if (!client) return undefined;
      return client.request("extension_ui_response", { uiRequestId: requestId, ...body });
    },
    async stop() { stopped = true; watcher.close(); client?.close(); if (scanning) await scanning; },
  };
}
