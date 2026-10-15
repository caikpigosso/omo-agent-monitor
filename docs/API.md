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
`{ "error": "<English message>", "code": "<stable code>" }` with 4xx/5xx. Text limit
32,000 chars. Unknown project -> 404 `{ "error": "Project not found.", "code": "project_not_found" }`.

Error codes (the UI translates by code and falls back to `error`): `unauthorized`,
`task_not_found`, `project_not_found`, `method_not_allowed`, `agent_finished`,
`invalid_json`, `invalid_message`, `coordinator_unavailable`, `control_failed`,
`control_rejected` (`error` carries the native OmO reason), `request_cancelled`,
`session_unavailable`.

## Types

```ts
type ProjectsSnapshot = {
  revision: number; controlToken: string;
  locale: "en" | "pt-BR";                 // default UI language, from OMO_MONITOR_LANG (default "en")
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

## v1.2 additions: tasks, plan, usage, accounts and correlations

Goal: correlate as much as possible. A task's cost must be traceable to its plan
item, model, the account that (probably) paid for it, and the quota burned in the
same period. Everything stays local; account data never includes tokens, emails
or installation keys. Anything inferred carries `inferred: true`.

### Extended per-session data (session server -> hub, same endpoints)

```ts
type TaskView = /* v1 fields */ & {
  rootId?: string;
  requestedModel?: string; effectiveModel?: string; fallbackUsed: boolean;
  stats?: { runtimeMs?: number; turns?: number; toolCalls?: number;
    inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number;
    totalTokens?: number; costUsd?: number; tokensPerSecond?: number; cacheHitRate?: number };
  dag?: { runId: string; nodeId: string };            // when the task is a workflow node
  planItem?: { phase: string; content: string; inferred: true }; // todo item in_progress when the task was created
  toolBreakdown?: Record<string, { calls: number; errors: number }>;
};

type SessionState = /* v1 fields */ & {
  coordinatorStats: { inputTokens: number; outputTokens: number; cacheReadTokens: number;
    cacheWriteTokens: number; totalTokens: number; costUsd: number; turns: number; toolCalls: number;
    toolBreakdown: Record<string, { calls: number; errors: number }> };
  plan?: PlanView;        // from the coordinator session's "senpi.todo-state" entries
  goal?: GoalView;        // only if the goal store is found; never invented
};

type PlanView = {
  ask?: string; updatedAt: string;
  phases: Array<{ name: string; items: Array<{ content: string; status: string;
    firstSeenAt: string; startedAt?: string; completedAt?: string; droppedAt?: string;
    taskIds: string[] /* inferred: tasks created while this item was in_progress */ }> }>;
  history: Array<{ at: string; done: number; total: number }>;   // one point per todo-state snapshot
};

type GoalView = { id: string; objective: string; status: string; createdAt: string; updatedAt: string;
  tokensUsed?: number; timeUsedSeconds?: number };
```

### Hub-only endpoints (global, across every project on disk)

- `GET /api/usage?from=ISO&to=ISO&bucket=hour|day&groupBy=provider|model|project|agent|session|account`
  -> `UsageReport`. Source: every assistant message with `usage` in every session file
  on disk (coordinator sessions under `<agentDir>/sessions/**` and agent sessions under
  `<agentDir>/projects/*/senpi-task/children/**`). Indexed incrementally (byte offsets),
  persisted under `<agentDir>/agent-monitor/usage-index/`, kept current with fs.watch.
  `project` = basename of the session header cwd; `agent` = task agent type or
  `coordinator`. `account` grouping is inferred (see accounts) and flagged.
- `GET /api/accounts` -> `AccountsReport`.
- `GET /api/quota-history?from=ISO&to=ISO` -> `{ samples: QuotaSample[] }`.
- `GET /api/insights?from=ISO&to=ISO` -> `Insights`.
- SSE `/api/events` adds `event: usage` (`{ indexedAt }`, refetch hint) and
  `event: accounts` (`AccountsReport`) when those change.

```ts
type Metrics = { messages: number; inputTokens: number; outputTokens: number; cacheReadTokens: number;
  cacheWriteTokens: number; totalTokens: number; costUsd: number };
type UsageReport = { from: string; to: string; bucket: "hour" | "day"; groupBy: string;
  series: Array<{ key: string; label: string; inferred?: boolean; points: Array<{ t: string } & Metrics> }>;
  totals: Metrics; coverage: { files: number; indexedAt: string; partial: boolean } };

type AccountsReport = {
  counts: { total: number; byProvider: Record<string, number> };
  accounts: Array<{ id: string; provider: string; name: string; active: boolean; pinned: boolean;
    state?: string; expiresAt?: string; blockedUntil?: string; blockReason?: string;
    lastSuccessAt?: string; failureCount?: number }>;
  quotas: Array<{ provider: string; account?: string; plan?: string; state?: string; updatedAt: string;
    windows: Array<{ label: string; percent: number; resetsAt: string; windowMs: number }> }>;
};
// Sources: <agentDir>/auth.json (names/states only), <agentDir>/credential-pool-state.json,
// $XDG_CACHE_HOME|~/.cache/omo-senpi/side-panel-usage.json (current quota, active account only).

type QuotaSample = { at: string; provider: string; account?: string;
  windows: Array<{ label: string; percent: number; resetsAt: string }> };
// Appended to <agentDir>/agent-monitor/quota-history.jsonl whenever the usage cache changes
// (fs.watch, deduplicated). History therefore starts when the hub first runs.

type Insights = {
  burn: Array<{ provider: string; account?: string; window: string; percent: number; resetsAt: string;
    percentPerHour?: number; projectedExhaustAt?: string; tokensPerPercent?: number; inferred: true }>;
  topTasks: Array<{ project: string; projectId?: string; taskId: string; name: string; agent?: string;
    status: string; model?: string; costUsd?: number; totalTokens?: number; runtimeMs?: number; createdAt: string }>;
  models: Array<{ provider: string; model: string; messages: number; totalTokens: number; costUsd: number;
    fallbackCount: number }>;
  tools: Array<{ name: string; calls: number; errors: number }>;  // from open sessions' timelines
  projects: Array<{ project: string; costUsd: number; totalTokens: number; tasks: number; sessions: number }>;
};
// topTasks/projects read every task record on disk (<agentDir>/projects/*/senpi-task/tasks/*.json),
// not only open sessions. projectId is set when that project has an open session in the hub.
```

## v1.3 additions: stall watchdog and questions on the web

### Stall watchdog (runs inside each session server)

Config (env, read once at session start; the hub reports it):
`OMO_MONITOR_WATCHDOG` = `auto` (default) | `steer` | `alert` | `off`;
`OMO_MONITOR_STALL_ERRORS` (default 2 consecutive provider stream errors);
`OMO_MONITOR_STALL_MINUTES` (default 12, fractional allowed: no progress while the agent is waiting on the model);
`OMO_MONITOR_STALL_GRACE_MINUTES` (default 8, after the steer, before cancelling).

Signals per running task, from its transcript and task log:
- provider stream errors: assistant messages with `stopReason: "error"` whose `errorMessage` matches idle/stream/WebSocket timeouts or closes, and `child_error` log records; reset by any successful assistant message.
- progress: any new tool call, tool result or non-error assistant message. Time spent inside an unfinished tool call (a long build) is NOT a stall; only waiting on the model counts.
- writes: tool calls whose name is write/edit/apply_patch-like (record the target paths for the coordinator note).

States and actions (one escalation per task, persisted in `<agentDir>/agent-monitor/watchdog.jsonl` so restarts never repeat an action):
1. `stalled` (reason `provider_errors` | `no_progress`) -> action `alert` (all modes except off).
2. `steered` -> action `steer` (modes steer/auto): `task_send` to the agent with a fixed message: save what you have now, then work in small increments, never more than ~250 lines per tool call, keep each tool call short.
3. `cancelled` -> (mode auto, still no progress after the grace period) action `cancel` (`task_cancel`, reason names the watchdog) then `coordinator_notified`: `pi.sendUserMessage(text, { deliverAs: "followUp" })` with: task name/id/agent, reason and timing, paths it wrote, and the instruction to re-plan the remaining work as 2-4 smaller tasks (one file or view each, increments of <=250 lines per tool call) and spawn them.
4. `recovered` when progress resumes after stalled/steered (no further action).
Timers: one setTimeout armed for the next deadline, re-armed on every change. No polling loops.

```ts
type TaskHealth = { state: "ok" | "stalled" | "steered" | "cancelled" | "recovered";
  reason?: "provider_errors" | "no_progress"; since?: string; consecutiveErrors: number;
  lastProgressAt?: string; lastWriteAt?: string; waitingOnModelSince?: string;
  actions: Array<{ at: string; kind: "alert" | "steer" | "cancel" | "coordinator_notified"; detail?: string }> };
// TaskView gains: health: TaskHealth
// ProjectsSnapshot gains: watchdog: { mode: string; stallErrors: number; stallMinutes: number; graceMinutes: number }
//   and projects[].counts gains stalled: number, questions: number
// SSE gains: event "watchdog" { projectId, taskId, health }  (emitted on every state change or action)
// GET /api/watchdog?from=ISO&to=ISO -> { events: Array<{ at, projectId, project, taskId, taskName, kind, state, reason?, detail? }> }
```

### Questions on the web

Only coordinators ask (subagents cannot). OmO's thread component already registers the terminal control
endpoint (`<agentDir>/rpc/tui/t-<16hex>.sock` + secret file beside it, registry `endpoint_kind: "tui"`); the
monitor must NOT register another. The session server is a client of its own terminal's endpoint: find the
endpoint whose `list_sessions` row is this session, send the secret first, then LF-delimited JSON.
Pending questions come from `pi.events.on("ask-user:asked" | "ask-user:closed")` in-process, plus the
endpoint's `get_state`/`subscribe` (`question` feed) to recover questions pending before the monitor started.

```ts
type PendingQuestion = { requestId: string;            // the uiRequestId to answer
  askedAt: string; deadlineAt?: string; blocking: boolean;
  questions: Array<{ id: string; header: string; question: string; multiSelect: boolean;
    options: Array<{ label: string; description?: string }> }>;
  answerable: boolean };                               // false when no control endpoint is reachable
// SessionState gains: questions: PendingQuestion[]   (pending only)
// POST /api/projects/:pid/questions/:requestId/answer  (hub -> session server, X-OmO-Control like other controls)
//   body { answers: Record<questionId, { selected: string[]; text?: string }>, comment?: string } | { cancelled: true }
//   -> { ok: true, outcome: "answered" | "comment-submitted" | "cancelled" }
//   errors (code): question_already_resolved, question_unknown, question_incomplete, question_invalid,
//   question_bridge_unavailable
// SSE gains: event "question" { projectId, requestId, kind: "asked" | "closed", status? }
```
The answer is sent as `{ type: "extension_ui_response", id, uiRequestId: requestId, answers, comment }`
(or `cancelled: true`), so it reaches the model exactly like a terminal answer (`resolvedBy: control_endpoint`).
