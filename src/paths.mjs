import { homedir } from "node:os";
import { join } from "node:path";

// Shared by the extension, session servers and the hub so they always agree.
export const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omo", "agent");
export const runDir = process.env.OMO_MONITOR_RUN_DIR || join(agentDir, "agent-monitor", "run");
export const hubPort = Number(process.env.OMO_MONITOR_PORT || 47800);

// OmO ships as a compiled Bun binary; with BUN_BE_BUN=1 it runs scripts like the bun CLI,
// so the hub and tmux readers need no separate Bun installation.
export const runtime = process.execPath;
export const runtimeEnv = { ...process.env, BUN_BE_BUN: "1" };
