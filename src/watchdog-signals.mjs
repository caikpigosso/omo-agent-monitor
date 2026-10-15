export function jsonLines(text) {
  const lines = text.split("\n"), entries = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); }
    catch (error) { if (index === lines.length - 1 && error instanceof SyntaxError) break; throw error; }
  }
  return entries;
}

const providerError = /(?:idle.*timeout|(?:stream|websocket|socket).*(?:timeout|timed out|clos|disconnect)|(?:timeout|timed out).*(?:stream|websocket|socket))/i;
const writeTool = /(?:^|[_.:-])(?:write|edit|apply_patch|patch)(?:$|[_.:-])/i;

function writtenPaths(call) {
  if (!writeTool.test(call.name)) return [];
  const args = call.arguments || {};
  const paths = [args.path, args.file_path, args.filePath, args.filename].filter(value => typeof value === "string");
  const patch = args.patch || args.input || "";
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) paths.push(match[1]);
  return paths;
}

export function watchdogSignals(transcript, log = "") {
  const signals = [], errors = [];
  for (const entry of jsonLines(transcript)) {
    if (entry.type !== "message") continue;
    const message = entry.message, at = entry.timestamp;
    const id = entry.id;
    switch (message.role) {
      case "assistant": {
        if (message.stopReason === "error") {
          const signal = { id, at, kind: "error" };
          errors.push(signal);
          if (providerError.test(message.errorMessage || "")) {
            signals.push(signal);
          }
        } else signals.push({ id, at, kind: "progress" });
        for (const call of Array.isArray(message.content) ? message.content : []) {
          if (call.type !== "toolCall") continue;
          signals.push({ id: `${id}:${call.id}`, at, kind: "tool_start", callId: call.id, paths: writtenPaths(call) });
        }
        break;
      }
      case "toolResult":
        signals.push({ id, at, kind: "tool_end", callId: message.toolCallId }); break;
    }
  }
  let errorIndex = 0;
  for (const [index, entry] of jsonLines(log).entries()) {
    if (entry.type !== "child_error") continue;
    // Each child_error mirrors a transcript error. Untimed logs must not count it twice.
    const matched = errors[errorIndex++];
    if (matched) {
      if (!signals.includes(matched)) signals.push(matched);
      continue;
    }
    // Legacy task logs have no clock. Observe a log-only failure on its arrival edge.
    const at = entry.timestamp || entry.at || new Date().toISOString();
    signals.push({ id: `log:${index}`, at, kind: "error" });
  }
  return signals.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function watchdogConfig(env = process.env) {
  const number = (key, fallback) => {
    const value = Number(env[key]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return { mode: ["auto", "steer", "alert", "off"].includes(env.OMO_MONITOR_WATCHDOG)
    ? env.OMO_MONITOR_WATCHDOG : "auto",
  stallErrors: Math.ceil(number("OMO_MONITOR_STALL_ERRORS", 2)),
  stallMinutes: number("OMO_MONITOR_STALL_MINUTES", 12),
  graceMinutes: number("OMO_MONITOR_STALL_GRACE_MINUTES", 8) };
}
