import { createInterface, clearLine, cursorTo } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { locale } from "./paths.mjs";
import { text } from "./messages.mjs";

const args = Bun.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const address = new URL(option("--url"));
if (address.hostname !== "127.0.0.1" || address.username || address.password) {
  throw new Error("The monitor must be on localhost.");
}
const taskId = args.includes("--task") ? option("--task") : undefined;
const sessionName = args.includes("--session") ? option("--session") : undefined;
const panes = new Map();
let state, busy = false, lastRevision = -1;
const printed = new Set();
const abort = new AbortController();
const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.setPrompt(taskId ? text.messagePrompt : "monitor> ");

function output(text) {
  if (process.stdout.isTTY) {
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
  }
  const width = Math.max(20, process.stdout.columns || 100);
  process.stdout.write(Bun.wrapAnsi(stripVTControlCharacters(text), width) + "\n");
  rl.prompt(true);
}

async function tmux(command) {
  const child = Bun.spawn(["tmux", ...command], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [text, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(error.trim() || `tmux exited ${code}`);
  return text.trim();
}

async function syncPanes(snapshot) {
  const live = snapshot.tasks.filter(task =>
    ["pending", "queued", "running"].includes(task.status)).slice(0, 4);
  const ids = new Set(live.map(task => task.id));
  for (const task of live) {
    if (panes.has(task.id)) continue;
    if (panes.size === 4) {
      const retired = [...panes].find(([id]) => !ids.has(id));
      if (!retired) continue;
      await tmux(["kill-pane", "-t", retired[1]]);
      panes.delete(retired[0]);
    }
    const pane = await tmux([
      "split-window", "-d", "-P", "-F", "#{pane_id}", "-t", sessionName,
      "env", "BUN_BE_BUN=1", `OMO_MONITOR_LANG=${locale}`, process.execPath, import.meta.path, "--url", address.toString(),
      "--task", task.id,
    ]);
    panes.set(task.id, pane);
    await tmux(["select-layout", "-t", sessionName, "tiled"]);
  }
}

async function showTask() {
  const response = await fetch(new URL(`/api/tasks/${taskId}`, address));
  const detail = await response.json();
  if (!response.ok) throw new Error(detail.error || `HTTP ${response.status}`);
  const task = detail.task;
  output(`${task.name} | ${task.status} | ${task.provider}/${task.model}`);
  for (const message of detail.messages) {
    const key = message.id || `${message.at}:${message.role}:${message.text}`;
    if (printed.has(key)) continue;
    printed.add(key);
    output(`[${message.role}${message.tool ? ` ${message.tool}` : ""}]\n${message.text}`);
  }
}

async function control(action, text) {
  if (!state?.controlToken) throw new Error("Monitor not connected.");
  const response = await fetch(new URL(`/api/tasks/${taskId}/${action}`, address), {
    method: "POST",
    headers: {
      "X-OmO-Control": state.controlToken,
      ...(action === "message" ? { "Content-Type": "application/json" } : {}),
    },
    ...(action === "message" ? { body: JSON.stringify({ text }) } : {}),
  });
  const data = await response.json();
  if (!response.ok || data.ok !== true) throw new Error(data.error || `HTTP ${response.status}`);
  output(action === "message" ? text.messageConfirmed : text.abortConfirmed);
}

rl.on("line", async input => {
  if (busy) { output(text.waitPrevious); return; }
  if (!input.trim()) { rl.prompt(); return; }
  if (input === "/quit") { abort.abort(); rl.close(); return; }
  if (!taskId) { output(text.pickPane); return; }
  busy = true;
  try {
    if (input === "/output") {
      printed.clear();
      await showTask();
    } else await control(input === "/abort" ? "abort" : "message", input);
  } catch (error) {
    output(`${text.refused}: ${error.message}`);
    if (input !== "/abort" && input !== "/output") rl.write(input);
  } finally { busy = false; rl.prompt(true); }
});
rl.on("SIGINT", () => { abort.abort(); rl.close(); });

output(taskId
  ? text.agentHeader
  : text.listHeader);
try {
  const response = await fetch(new URL("/api/events", address), { signal: abort.signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const packet = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (!packet.startsWith("event: state\n")) continue;
      const snapshot = JSON.parse(packet.slice("event: state\ndata: ".length));
      if (snapshot.revision <= lastRevision) continue;
      lastRevision = snapshot.revision;
      state = snapshot;
      if (taskId) {
        if (snapshot.tasks.some(task => task.id === taskId)) await showTask();
      } else {
        output(snapshot.tasks.map(task =>
          `${task.id} ${task.status} ${task.name} ${task.provider}/${task.model}`).join("\n")
          || text.noAgents);
        if (sessionName) await syncPanes(snapshot);
      }
    }
  }
  if (!abort.signal.aborted) throw new Error("Monitor disconnected.");
} catch (error) {
  if (!abort.signal.aborted) { output(`Monitor offline: ${error.message}`); process.exitCode = 1; }
} finally { rl.close(); }
