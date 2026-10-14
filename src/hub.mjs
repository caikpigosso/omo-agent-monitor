import { watch } from "node:fs";
import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { hubPort, runDir as defaultRunDir } from "./paths.mjs";

const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
export async function startHub({ port = hubPort, runDir = defaultRunDir } = {}) {
  await mkdir(runDir, { recursive: true });
  const projects = new Map(), streams = new Set(), secrets = new Set();
  const controlToken = randomBytes(32).toString("hex");
  let revision = 0, stopped = false, syncing, dirty = false;
  function safe(value) {
    return JSON.parse(JSON.stringify(value, (key, item) => {
      if (key === "controlToken" || key === "thinkingSignature" || key === "encryptedContent") return undefined;
      if (typeof item !== "string") return item;
      for (const token of secrets) item = item.replaceAll(token, "[redacted]");
      return item;
    }));
  }
  function snapshot() {
    return { revision, controlToken, projects: [...projects.values()].map(project => {
      const tasks = project.state?.tasks || [];
      return { id: project.entry.id, name: project.entry.name, cwd: project.entry.cwd,
        startedAt: project.entry.startedAt, online: project.online,
        counts: { running: tasks.filter(task => ["pending", "queued", "running"].includes(task.status)).length,
          completed: tasks.filter(task => task.status === "completed").length,
          failed: tasks.filter(task => ["error", "failed", "lost", "interrupted"].includes(task.status)).length,
          total: tasks.length } };
    }) };
  }
  const encode = (event, value) => new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  function emit(event, value) { for (const stream of streams) stream.enqueue(encode(event, value)); }
  function publishProjects() { revision++; emit("projects", snapshot()); }
  function acceptState(project, state) {
    if (projects.get(project.entry.id) !== project || stopped) return;
    const changed = project.state?.revision !== state.revision || !project.online;
    project.state = safe(state);
    project.online = true;
    if (changed) {
      publishProjects();
      emit("state", { projectId: project.entry.id, state: project.state });
    }
  }
  async function subscribe(project) {
    let received = false;
    try {
      const response = await fetch(new URL("/api/events", project.entry.url), { signal: project.abort.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const lines = buffer.slice(0, boundary).split("\n");
          buffer = buffer.slice(boundary + 2);
          if (lines.find(line => line.startsWith("event:"))?.slice(6).trim() !== "state") continue;
          acceptState(project, JSON.parse(lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")));
          received = true; project.retry = 0;
        }
      }
    } catch (error) {
      if (!project.abort.signal.aborted)
        console.error("[agent-monitor-hub] session stream failed", { projectId: project.entry.id, error: error.message });
    } finally {
      if (!stopped && projects.get(project.entry.id) === project) {
        if (!alive(project.entry.pid)) {
          project.online = false; publishProjects(); void rescan();
        } else if (received) {
          void subscribe(project); // stream ended after working: reconnect without an offline blip
        } else {
          project.online = false; publishProjects();
          project.retry = Math.min((project.retry || 500) * 2, 30_000);
          setTimeout(() => {
            if (!stopped && projects.get(project.entry.id) === project) void subscribe(project);
          }, project.retry);
        }
      }
    }
  }
  async function scan() {
    const entries = new Map();
    for (const filename of await readdir(runDir)) {
      if (!filename.endsWith(".json")) continue;
      let entry;
      try { entry = JSON.parse(await readFile(join(runDir, filename), "utf8")); }
      catch (error) {
        if (error.code === "ENOENT" || error instanceof SyntaxError) continue;
        throw error;
      }
      if (!alive(entry.pid)) { await unlink(join(runDir, filename)); continue; }
      const address = new URL(entry.url);
      if (address.hostname !== "127.0.0.1" || address.protocol !== "http:" || address.username || address.password) continue;
      secrets.add(entry.token);
      entries.set(entry.id, entry);
    }
    let changed = false;
    for (const [id, project] of projects) {
      if (JSON.stringify(entries.get(id)) === JSON.stringify(project.entry)) continue;
      project.abort.abort(); projects.delete(id); changed = true;
    }
    for (const [id, entry] of entries) {
      if (projects.has(id)) continue;
      const project = { entry, online: false, abort: new AbortController() };
      projects.set(id, project); changed = true;
      void subscribe(project);
    }
    if (changed) publishProjects();
  }
  function rescan() {
    dirty = true;
    if (!syncing) syncing = (async () => {
      try { while (dirty && !stopped) { dirty = false; await scan(); } }
      finally { syncing = undefined; }
    })();
    return syncing;
  }
  const watcher = watch(runDir, () => {
    rescan().catch(error => console.error("[agent-monitor-hub] registry scan failed", { error: error.message }));
  });
  const json = (value, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  let server;
  try {
    server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, maxRequestBodySize: 256_000,
      async fetch(request) {
        const url = new URL(request.url), path = url.pathname;
        if (url.hostname !== "127.0.0.1") return json({ error: "Controle nao autorizado." }, 403);
        if (request.method === "GET" && path === "/") return new Response(Bun.file(join(import.meta.dir, "index.html")), {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
        if (request.method === "GET" && path === "/api/projects") return json(snapshot());
        if (request.method === "GET" && path === "/api/events") {
          let controller;
          return new Response(new ReadableStream({
            start(stream) {
              controller = stream; streams.add(stream); stream.enqueue(encode("projects", snapshot()));
              for (const project of projects.values()) if (project.state)
                stream.enqueue(encode("state", { projectId: project.entry.id, state: project.state }));
            },
            cancel() { streams.delete(controller); },
          }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
        }
        const match = /^\/api\/projects\/([^/]+)\/(state|coordinator(?:\/message)?|tasks\/st_[A-Za-z0-9_-]+(?:\/(?:message|abort))?)$/.exec(path);
        const project = match && projects.get(match[1]);
        if (!project) return json({ error: "Projeto nao encontrado." }, 404);
        const control = /\/(message|abort)$/.test(match[2]);
        if (request.method !== (control ? "POST" : "GET")) return json({ error: "Metodo invalido." }, 405);
        if (control && (request.headers.get("X-OmO-Control") !== controlToken
          || request.headers.has("Origin") && request.headers.get("Origin") !== server.url.origin))
          return json({ error: "Controle nao autorizado." }, 403);
        let body;
        if (match[2].endsWith("/message")) {
          try { body = await request.json(); }
          catch (error) { if (error instanceof SyntaxError) return json({ error: "JSON invalido." }, 400); throw error; }
          if (typeof body?.text !== "string" || !body.text.trim() || body.text.length > 32_000)
            return json({ error: "Envie uma mensagem de ate 32.000 caracteres." }, 400);
        }
        try {
          const upstream = await fetch(new URL(`/api/${match[2]}`, project.entry.url), {
            method: request.method, signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
            headers: control ? { "X-OmO-Control": project.entry.token, "Content-Type": "application/json" } : {},
            ...(body ? { body: JSON.stringify({ text: body.text }) } : {}),
          });
          const value = await upstream.json();
          if (upstream.ok && match[2] === "state") acceptState(project, value);
          return json(safe(value), upstream.status);
        } catch (error) {
          if (request.signal.aborted) return json({ error: "Requisicao cancelada." }, 499);
          project.online = false; publishProjects();
          if (!alive(project.entry.pid)) void rescan();
          console.error("[agent-monitor-hub] proxy failed", { projectId: project.entry.id, error: error.message });
          return json({ error: "Sessao indisponivel." }, 503);
        }
      },
    });
    await rescan();
  } catch (error) { watcher.close(); server?.stop(true); throw error; }
  return { url: server.url.toString(),
    async stop() {
      stopped = true; watcher.close();
      if (syncing) await syncing;
      for (const project of projects.values()) project.abort.abort();
      for (const stream of streams) stream.close();
      streams.clear(); server.stop(true);
    },
  };
}

if (import.meta.main) {
  const index = Bun.argv.indexOf("--port");
  try {
    const hub = await startHub(index === -1 ? {} : { port: Number(Bun.argv[index + 1]) });
    console.log(`READY ${hub.url}`);
    const stop = async () => { await hub.stop(); process.exit(0); };
    process.on("SIGTERM", stop); process.on("SIGINT", stop);
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    const port = index === -1 ? hubPort : Number(Bun.argv[index + 1]);
    const response = await fetch(`http://127.0.0.1:${port}/api/projects`);
    if (!response.ok || !Array.isArray((await response.json()).projects)) throw error;
    console.log(`READY http://127.0.0.1:${port}/`);
  }
}
