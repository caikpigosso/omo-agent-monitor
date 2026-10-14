# OmO Agent Monitor - architecture and API

One dashboard at `http://127.0.0.1:47800/` shows every open OmO project
session, a clickable flow (coordinator -> child agents -> grandchildren, plus
real workflow DAGs), and per-agent detail: full instruction, current activity,
and a timeline of every tool call with its arguments and result. Users can
message/abort child agents and message each project's coordinator.

## Pieces

| File | Role |
| --- | --- |
| `extensions/agent-monitor.mjs` | Extension entry. Starts the session server on `session_start`, registers it, ensures the hub, provides `/monitor` and the `agent_monitor` tool. |
| `src/server.mjs` | Per-session API (internal, random port on 127.0.0.1). |
| `src/hub.mjs` | Detached process on 127.0.0.1:47800; aggregates sessions; serves `index.html`. |
| `src/terminal.mjs` | tmux reader used by `/monitor tmux`. |
| `src/index.html` | The whole UI, vanilla HTML/CSS/JS, single file, no network/CDN. |
| `src/paths.mjs` | Shared defaults: agent dir, registry dir, hub port, runtime. |

## Registry

Each session server writes `<agent dir>/agent-monitor/run/<parentId>.json`
(mode 0600; agent dir defaults to `~/.omo/agent`) on start and deletes it on stop:

```json
{ "id": "<parentId>", "name": "<basename(cwd)>", "cwd": "/abs/path",
  "url": "http://127.0.0.1:<port>/", "token": "<session control token>",
  "pid": 12345, "startedAt": "ISO-8601" }
```

The hub ignores/removes entries whose pid is not alive (`process.kill(pid, 0)`).
The hub watches the `run/` directory (fs.watch), no polling.

## Hub HTTP API (what index.html uses; same-origin only)

All JSON responses `Cache-Control: no-store`. Bind 127.0.0.1 only.

- `GET /` -> `index.html`.
- `GET /api/projects` -> `ProjectsSnapshot`.
- `GET /api/events` -> one SSE stream for everything:
  - `event: projects` / `data: ProjectsSnapshot` (sent on connect and on change)
  - `event: state` / `data: { "projectId": "<id>", "state": SessionState }`
    (sent on connect for every project and whenever a session revision changes)
  - `event: activity` / `data: { "projectId", "taskId" | null, "event": TimelineEvent }`
    optional, for live timeline append (taskId null = coordinator).
- `GET /api/projects/:pid/state` -> `SessionState`
- `GET /api/projects/:pid/tasks/:tid` -> `TaskDetail`
- `GET /api/projects/:pid/coordinator` -> `CoordinatorDetail`
- `POST /api/projects/:pid/tasks/:tid/message` body `{ "text": string }`
- `POST /api/projects/:pid/tasks/:tid/abort`
- `POST /api/projects/:pid/coordinator/message` body `{ "text": string }`

POSTs require header `X-OmO-Control: <ProjectsSnapshot.controlToken>` and, when
present, `Origin` equal to the hub origin; otherwise 403. The hub forwards to
the session server with that session's own token. Responses:
`{ "ok": true, "outcome": "steered|revived|queued|cancelled|delivered" }` or
`{ "error": "mensagem em pt-BR" }` with 4xx/5xx. Text limit 32,000 chars.
Unknown project -> 404 `{ "error": "Projeto nao encontrado." }`.

## Types

```ts
type ProjectsSnapshot = {
  revision: number; controlToken: string;
  projects: Array<{
    id: string; name: string; cwd: string; startedAt: string;
    online: boolean;                       // session server reachable
    counts: { running: number; completed: number; failed: number; total: number };
  }>;
};

type SessionState = {           // per-session /api/state, extended from v1
  revision: number; connection: "live";
  parents: [{ id: string; name: string; cwd: string; project: string;
              model?: string; status?: "idle" | "working" }];
  tasks: TaskView[];
  dags: Array<{ id; name; status; nodes: Array<{ id; label; state; taskId?; dependsOn: string[] }> }>;
  quota: object; errors: string[];
};

type TaskView = {
  id: string; parentId: string;          // parentId = coordinator id OR another task's id
  depth: number;                          // 1 = direct child of coordinator
  name: string; agent?: string;           // subagent_type or category, if known
  status: string;                         // pending|running|completed|error|cancelled|lost|interrupted|...
  provider?: string; model?: string; tokens?: number;
  createdAt?: string; startedAt?: string; endedAt?: string;
  toolCount: number;
  current?: { name: string; summary: string; at: string }; // while running: unfinished tool call, else the latest one
  lastText?: string; sessionPath?: string;
};

type TimelineEvent = {
  id: string; at: string;                 // ISO
  kind: "instruction" | "user" | "assistant" | "thinking" | "tool" | "model";
  text?: string;                          // instruction/user/assistant text; thinking = readable title only
  tool?: {
    callId: string; name: string; args: unknown;   // raw arguments object
    summary: string;                                // one-line e.g. `ls /Users/x`, `bash: git status`
    result?: string; truncated?: boolean;           // result capped at 20,000 chars
    isError?: boolean; endedAt?: string;            // absent endedAt = still running
  };
};

type TaskDetail = {
  task: TaskView;
  instruction: string;                    // first user message text (the prompt the agent received)
  timeline: TimelineEvent[];
  messages: Array<{ id; role; text; at; tool? }>;  // v1 field kept for terminal.mjs
};

type CoordinatorDetail = { parent: SessionState["parents"][0]; timeline: TimelineEvent[] };
```

Rules: never expose thinking signatures/encrypted content; never put session
tokens in any hub response other than the hub's own `controlToken`. Tool
`args` are passed through as recorded (they are the user's own local data).
