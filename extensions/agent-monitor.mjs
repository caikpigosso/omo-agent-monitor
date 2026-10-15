import { spawn } from "node:child_process";
import { startMonitor } from "../src/server.mjs";
import { hubPort, locale, runtime, runtimeEnv } from "../src/paths.mjs";
import { text } from "../src/messages.mjs";

const hubUrl = `http://127.0.0.1:${hubPort}/`;
async function ensureHub() {
  try {
    const response = await fetch(new URL("api/projects", hubUrl), { signal: AbortSignal.timeout(2_000) });
    if (response.ok && Array.isArray((await response.json()).projects)) return;
  } catch (error) {
    if (!(error instanceof Error) || !(error instanceof TypeError) && error.name !== "TimeoutError"
      && error.code !== "ConnectionRefused" && error.code !== "ECONNREFUSED") throw error;
  }
  const child = spawn(runtime, [new URL("../src/hub.mjs", import.meta.url).pathname, "--port", String(hubPort)], {
    detached: true, stdio: ["ignore", "pipe", "ignore"], env: runtimeEnv,
  });
  await new Promise((resolve, reject) => {
    let buffer = "";
    const fail = code => reject(new Error(`Agent monitor hub exited ${code}.`));
    child.once("error", reject); child.once("exit", fail);
    child.stdout.on("data", chunk => {
      buffer += chunk.toString();
      if (!buffer.includes(`READY ${hubUrl}`)) return;
      child.off("error", reject); child.off("exit", fail);
      child.stdout.destroy(); child.unref(); resolve();
    });
  });
}

export default function registerAgentMonitor(pi) {
  if (pi.sessionKind === "worker") return;
  let monitor, tmuxSession, parentId, starting, toolCtx;
  // session_start contexts lack executeTool; the host API has it, a tool context is the fallback.
  async function executeTool(name, args) {
    if (typeof pi.executeTool === "function") {
      // The host API returns the bare tool result; ctx.executeTool wraps it as { result, isError }.
      const value = await pi.executeTool(name, args);
      return value && "result" in value ? value : { result: value, isError: value?.isError === true };
    }
    if (toolCtx) return toolCtx.executeTool(name, args);
    throw new Error(text.controlUnavailable);
  }
  async function stopReaders() {
    if (!tmuxSession) return;
    const child = Bun.spawn(["tmux", "kill-session", "-t", tmuxSession], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    await child.exited;
    tmuxSession = undefined;
  }
  async function start(ctx) {
    if (starting) return starting;
    starting = (async () => {
      const id = ctx.sessionManager.getSessionId();
      if (monitor && parentId !== id) { await stopReaders(); await monitor.stop(); monitor = undefined; }
      if (!monitor) {
        monitor = await startMonitor({
          cwd: ctx.cwd, parentId: id, sessionFile: ctx.sessionManager.getSessionFile(),
          status: ctx.isIdle() ? "idle" : "working",
          model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
          executeTool,
          sendUserMessage: (text, options) => pi.sendUserMessage(text, options),
        });
        parentId = id;
      }
      await ensureHub();
    })();
    try { await starting; } finally { starting = undefined; }
  }
  async function show(ctx, withTmux) {
    await start(ctx);
    if (withTmux && !tmuxSession) {
      const name = `omo-agents-${new URL(monitor.url).port}`;
      const child = Bun.spawn([
        "tmux", "new-session", "-d", "-s", name, "-n", "agentes", "-x", "180", "-y", "50",
        "env", "BUN_BE_BUN=1", `OMO_MONITOR_LANG=${locale}`, runtime, new URL("../src/terminal.mjs", import.meta.url).pathname,
        "--url", monitor.url, "--session", name,
      ], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const error = await new Response(child.stderr).text();
      if (await child.exited !== 0) throw new Error(error.trim());
      tmuxSession = name;
    }
    const url = `${hubUrl}#/p/${parentId}`;
    return { content: [{ type: "text", text: [`${text.dashboard}: ${url}`,
      ...(tmuxSession ? [`Terminal: tmux attach -t ${tmuxSession}`] : [])].join("\n") }],
      details: { url, tmux_session: tmuxSession } };
  }
  pi.on("session_start", async (_event, ctx) => {
    // Never block the session if the dashboard cannot start; /monitor retries and surfaces the error.
    try { await start(ctx); }
    catch (error) { console.error("[agent-monitor] dashboard did not start:", error.message); }
  });
  pi.on("agent_start", () => { monitor?.updateParent({ status: "working" }); });
  pi.on("turn_end", () => { monitor?.updateParent({ status: "working" }); });
  pi.on("agent_settled", () => { monitor?.updateParent({ status: "idle" }); });
  const offAsked = pi.events.on("ask-user:asked", event => { monitor?.questionAsked(event); });
  const offClosed = pi.events.on("ask-user:closed", event => { monitor?.questionClosed(event); });
  pi.on("session_shutdown", async () => {
    offAsked(); offClosed();
    try { if (starting) await starting; }
    finally { await stopReaders(); await monitor?.stop(); monitor = undefined; }
  });
  pi.registerTool({
    name: "agent_monitor", label: text.toolLabel,
    description: "Show the multi-project local agent dashboard; optionally create interactive tmux viewer panes.",
    parameters: { type: "object", properties: { tmux: { type: "boolean" } }, additionalProperties: false },
    async execute(_id, parameters, _signal, _update, ctx) { toolCtx = ctx; return show(ctx, parameters.tmux === true); },
  });
  pi.registerCommand("monitor", {
    description: "Show the agent dashboard: /monitor, /monitor tmux, /monitor stop.",
    async handler(args, ctx) {
      const command = args.trim();
      if (command === "stop") {
        await stopReaders();
        ctx.ui.notify(text.readersClosed, "info");
        return;
      }
      if (command && command !== "tmux") {
        ctx.ui.notify(text.usage, "warning");
        return;
      }
      const result = await show(ctx, command === "tmux");
      ctx.ui.notify(result.content[0].text, "info");
    },
  });
}
