import { emptyMetrics, usageMetrics, addMetrics } from "./storage.mjs";

export const textOf = content => typeof content === "string" ? content
  : (content || []).filter(item => item.type === "text").map(item => item.text).join("\n");

export function toolBreakdown(timeline) {
  const result = {};
  for (const event of timeline) {
    if (!event.tool) continue;
    const value = result[event.tool.name] ||= { calls: 0, errors: 0 };
    value.calls++; if (event.tool.isError) value.errors++;
  }
  return result;
}

export function parseTranscript(contents) {
  const timeline = [], messages = [], calls = new Map(), todoSnapshots = [], metrics = emptyMetrics();
  let instruction = "", seenUser = false, model, turns = 0;
  const lines = contents.split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    let entry;
    try { entry = JSON.parse(lines[index]); }
    catch (error) { if (index === lines.length - 1) break; throw error; }
    const at = entry.timestamp;
    if (entry.type === "custom" && entry.customType === "senpi.todo-state")
      todoSnapshots.push({ at, data: entry.data });
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
        turns++;
        if (message.usage) addMetrics(metrics, usageMetrics(message.usage));
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
  const { messages: _messages, ...tokens } = metrics;
  return { instruction, timeline, messages, model, todoSnapshots,
    stats: { ...tokens, turns, toolCalls: timeline.filter(event => event.tool).length,
      toolBreakdown: toolBreakdown(timeline) } };
}
