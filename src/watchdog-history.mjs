import { join } from "node:path";
import { optionalRead } from "./storage.mjs";
import { jsonLines } from "./watchdog-signals.mjs";

export async function watchdogHistory(agentDir, params) {
  const from = params.get("from"), to = params.get("to");
  if (from && !Number.isFinite(Date.parse(from)) || to && !Number.isFinite(Date.parse(to))
    || from && to && Date.parse(from) > Date.parse(to))
    return { value: { error: "Invalid report query.", code: "invalid_query" }, status: 400 };
  const events = jsonLines(await optionalRead(join(agentDir, "agent-monitor", "watchdog.jsonl")))
    .filter(event => (!from || Date.parse(event.at) >= Date.parse(from)) && (!to || Date.parse(event.at) <= Date.parse(to)))
    .map(({ health, ...event }) => event);
  return { value: { events } };
}
