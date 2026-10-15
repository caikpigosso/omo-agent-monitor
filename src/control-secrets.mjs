import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { filesIn, readJson } from "./storage.mjs";

// Keep terminal authentication out of every hub response, including quoted transcripts.
export async function startControlSecrets(agentDir) {
  const secrets = new Set(), watchers = [];
  let refreshing, dirty = false, stopped = false;
  async function scan() {
    const sockets = new Set();
    for (const name of await filesIn(join(agentDir, "rpc-host-daemon"))) {
      if (!/^[a-f0-9]{16}$/.test(name)) continue;
      const endpoint = await readJson(join(agentDir, "rpc-host-daemon", name, "endpoint.json"));
      if (endpoint?.endpoint_kind === "tui") sockets.add(endpoint.socket);
    }
    for (const name of await filesIn(join(agentDir, "rpc", "tui")))
      if (name.endsWith(".sock.secret")) sockets.add(join(agentDir, "rpc", "tui", name.slice(0, -7)));
    for (const socket of sockets) {
      let bytes;
      try { bytes = await readFile(`${socket}.secret`); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      secrets.add(bytes.toString("utf8"));
      // The wire uses raw bytes; diagnostic tools sometimes quote hex/base64 instead.
      secrets.add(bytes.toString("hex")); secrets.add(bytes.toString("base64"));
    }
  }
  function refresh() {
    dirty = true;
    if (!refreshing) refreshing = (async () => {
      try { while (dirty && !stopped) { dirty = false; await scan(); } }
      finally { refreshing = undefined; }
    })();
    return refreshing;
  }
  for (const directory of [join(agentDir, "rpc"), join(agentDir, "rpc-host-daemon")]) {
    try { watchers.push(watch(directory, { recursive: true }, () => {
      void refresh().catch(error => console.error("[agent-monitor-hub] control secrets refresh failed", { error: error.message }));
    })); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await refresh();
  return { secrets: () => secrets,
    async stop() { stopped = true; for (const watcher of watchers) watcher.close(); if (refreshing) await refreshing; } };
}
