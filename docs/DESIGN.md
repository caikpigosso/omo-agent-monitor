# OmO Agent Monitor v2

## 0. Research Log
Existing project with a v1 `DESIGN.md` (branch 3 of the frontend workflow):
this file is updated, not replaced from scratch. v1 behaviors that work are
kept as contract (see section 6). User feedback on v1: "too simple"; wanted a
clickable flow, per-agent instruction and activity, every nested command,
a better overview, and all open projects switchable in one place.
Direction: calm operational dashboard in the Linear/Vercel family (neutral
ink, hairline borders, one monochrome primary, status color only as
semantic chips). External research lanes, concept images, installs and
independent reviewer agents were skipped: the brief forbids network, CDN and
child agents. Verified instead with real WebKit renders against a scratch
mock hub (`/tmp/omo-monitor-mock`, synthetic fixtures, never shipped).

## 1. Atmosphere & Identity
A bilingual control room for local agent sessions (English by default,
Brazilian Portuguese as the alternative; see section 9). The agent flow is the hero:
coordinator -> children -> grandchildren drawn as connected cards. No
marketing hero, no decorative motion, no fictional activity, no invented DAG.
Owner wordmark: OmO. Page title: Agent dashboard · OmO / Painel de agentes · OmO.

## 2. Color
All colors are CSS custom properties; light / dark (`data-theme` on `<html>`,
selected by the theme select: System / Light / Dark, default System).

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| --page | #f6f7f8 | #0e0f11 | main background |
| --surface | #ffffff | #15171a | panels, nodes, detail |
| --sidebar | #fbfbfc | #121316 | project rail |
| --subtle | #f3f4f6 | #1b1d21 | code, pinned blocks, hover |
| --wash | #eceef1 | #22252a | hover, segmented track |
| --wash-strong | #e2e5e9 | #2b2f35 | selected project/active press |
| --ink | #15171c | #eceef2 | text |
| --muted | #5b616c | #9ca2ac | secondary text, selected node edge |
| --line / --line-strong | #e3e5e9 / #cfd3d9 | #262a30 / #363b43 | borders |
| --edge | #c3c8cf | #3e444d | flow edges |
| --primary / --primary-ink | #15171c / #fff | #eceef2 / #15171a | Enviar button |
| --info (+wash) | #1d5fd0 | #83b3ff | running/working, live tool |
| --success (+wash) | #15784a | #62d394 | completed, online, live hub |
| --warning (+wash) | #8f5500 | #f0c264 | pending/blocked, notices |
| --danger (+wash, -ink) | #bf3228 | #ff9189 | error/failed, destructive |
| --focus | #2f6fe4 | #83b3ff | focus-visible ring only |

Status is always a chip: dot + translated text. Unknown statuses show the raw
value. Selection is a neutral wash + check glyph (projects, nodes); the
active tab is a neutral ink underline. No colored accent side-borders.

## 3. Typography
System UI sans (`--font`) and `ui-monospace` (`--mono`) for paths, models,
tool names, summaries, args and results. No downloaded fonts.
Desktop scale: --fs-xs 12, --fs-sm 13, --fs-body 14, --fs-lg 16,
--fs-title 20, --fs-metric 22. Mobile (<=760px): 13 / 15 / 17 / 18 / 22.
Weights 400/500/600/650/700. Numbers use tabular figures. All data text is
selectable; long strings wrap (`overflow-wrap:anywhere`), single-line labels
ellipsize with a `title` carrying the full value.

## 4. Spacing & Layout
4px base: --s1 4, --s2 8, --s3 12, --s4 16, --s5 20, --s6 24, --s8 32.
App shell, each region owns its own scroll (no nested same-axis scroll):
- >=1200px: `sidebar 248px | main | detail clamp(380px,30vw,600px)`; the
  detail column exists only while a node is open.
- 761-1199px: sidebar + main; detail is a right drawer (min(560px,92vw)).
- <=760px: main only. A sticky top bar holds the project switcher button
  that opens the sidebar as a full-screen sheet; detail is a full-screen
  sheet. Safe-area insets respected. Targets 44px.
Main column: project header (name, online, cwd, quota line, coordinator
link) -> metrics strip (auto-fit, min 112px) -> Fluxo de agentes -> Workflows.
Flow canvases scroll horizontally inside their panel; the page never
scrolls horizontally (checked at 390px).

Flow geometry (JS reads the CSS vars): --node-w 200 / --node-h 136,
--node-gap-x 32, --node-gap-y 12 (mobile 256 x 172, gap-x 28). Tree layout
left -> right by depth: leaves stacked in creation order, each parent
vertically centered on its children. Tasks whose `parentId` is unknown or
cyclic attach to the coordinator. DAG nodes: --dag-w 196 / --dag-h 100
(mobile 236 x 120), --dag-gap-x 40, topological layers as columns.

## 5. Components
- **Project item** (`<a href="#/p/id">`): name + check when current, short
  cwd (home -> `~`, deep paths -> `…/a/b`, full path in title), online
  state, non-zero counts (em execução / com falha / concluídos) or "sem
  agentes". Arrow keys/Home/End move between items; ArrowDown from filter.
- **Status chip**: dot + text in a tinted pill; running/working dots pulse.
- **Metric**: label, value, optional sub-line; unknown values use an em dash.
- **Flow node** (button, `aria-pressed`): name, chip + agent type,
  provider/model, activity line (live `tool: summary` in info color when
  running; else first line of the last text), stats (tools, tokens, short
  duration) with icons plus screen-reader labels. Coordinator node uses the
  subtle surface. Edges are SVG cubic curves; the path to the selected node
  is darker, edges into running agents are dashed info.
  Keyboard: Up/Down preorder, Right first child, Left parent.
- **Workflow (DAG)**: one section per `SessionState.dags` entry, chip,
  step count, nodes with dependency text; node is a button only when its
  `taskId` exists. Cycles and missing dependencies are reported in text.
- **Detail panel**: kind label, title, meta (chip, agent, model, duration,
  tokens, tools, "Origem" link to parent), live "Agora:" line. Tabs
  Atividade / Instrução / Resultado (coordinator: Atividade only), roving
  tabindex with arrow keys.
- **Atividade**: pinned collapsible instruction; segmented filter Tudo /
  Comandos / Erros; search over text, tool name, summary, args and result;
  count line. Timeline rows: messages (Agente / Mensagem recebida /
  Usuário / Coordenador), muted thinking titles, model changes, and tool rows
  `icon name summary duration chevron`. A tool row expands to start/end/id,
  pretty-printed args and the result in monospace; error results tinted
  danger; running calls show a spinner + "em execução"; results over 30
  lines / 4,000 chars collapse behind "Mostrar tudo (N linhas)"; truncated
  results say so. Tool rows are deduped by `callId`.
- **Composer**: visible label naming the target, textarea, Cmd/Ctrl+Enter
  hint (character counter near the 32,000 limit), Interromper (secondary
  danger) and Enviar (primary). Interromper opens an inline confirmation
  whose default focus is Cancelar; hidden for the coordinator, disabled for
  terminal states. Busy labels, success only after `ok:true` (outcome
  mapped to pt-BR), refusal shown inline with the draft kept. Drafts are
  kept per target while switching nodes.
- **States**: loading, hub unavailable (retry), no projects, unknown
  project (link to the first), project offline (with or without last
  state), no agents yet, detail loading/failed (retry), refresh failure as
  an inline notice, empty filter/search results.

## 6. Motion & Interaction
Motion only where it carries state: pulsing dot on running/working chips and
live lines, spinner on running tool calls, 150ms chevron rotation. Under
`prefers-reduced-motion: reduce` all three are static.
Data contract kept from v1: EventSource is subscribed before the initial
`GET /api/projects`; ProjectsSnapshot and each SessionState ignore older
revisions (state also ignores equal ones); no timers or polling. A `state`
event for the open project refetches the open detail (aborting the stale
fetch), keeps scroll position unless the user was at the bottom (then
follows) and restores focus by key. `activity` events append to the open
timeline. Deep links drive all navigation (pushState; back/forward work):
`#/overview`, `#/accounts`, `#/p/<projectId>[/tasks|/plan|/usage][/t/<taskId>|/c]`
(no view segment = Flow, so v1 links keep working; the detail stays open
while switching project tabs). Escape closes, in order: abort
confirmation, project sheet, detail.

## 7. Depth & Surface
Borders over shadows: 1px hairlines. Radii --r-sm 6, --r-md 8, --r-lg 12,
--r-pill 999. One overlay shadow (--shadow-overlay) only for the drawer
and mobile sheets. Focus ring: 2px --focus, 2px offset.

## 8. Accessibility Constraints & Accepted Debt
WCAG AA text contrast in both themes; visible focus on every control; named
inputs and landmarks (aside Projects, main, aside detail); status never
color-only; icon-only buttons carry aria-labels; flow stats carry
screen-reader text. All data is inserted with `textContent`; the control
token lives only in memory and in the `X-OmO-Control` header; only the
theme and language preferences are persisted (localStorage
`omo-monitor-theme`, `omo-monitor-lang`).
Accepted debt: the flow tree is a group of buttons, not a full ARIA tree;
node durations update on each state revision, not every second (no timers);
a very wide tree scrolls horizontally inside the flow panel; Lighthouse and
independent reviewer passes are not claimed (no installs or child agents
authorized for this task).

## 9. Language
English (`en`, formats with `en-US`) is the default; Brazilian Portuguese
(`pt-BR`) is the alternative. Component names elsewhere in this file use the
English labels; the pt-BR wording is the v2 original (Atividade, Instrução,
Coordenador, Interromper, Enviar...).
- All copy lives in two flat dictionaries with identical keys, read through
  `t(key, vars)`: the v1 strings inside `index.html`, the v1.2 view strings in
  `src/ui/i18n.js` (merged into the same dictionaries at load). Plural entries are `{one, other}`
  selected by `Intl.PluralRules`; zero always takes `other`. Numbers,
  compact tokens (`12.9M` / `12,9 mi`), times and durations (`3m 4s` /
  `3 min 4 s`) use `Intl` with the active locale. Static markup carries
  `data-i18n`, `data-i18n-aria` and `data-i18n-ph`.
- Selector: "Language / Idioma" next to Appearance in the sidebar footer
  (inside the project sheet on mobile); options are endonyms (English,
  Português (BR)) and never translate. Initial language: stored choice,
  else `ProjectsSnapshot.locale` from the hub (`OMO_MONITOR_LANG`), else
  English; never the browser locale. `<html lang>`, the title and the meta
  description follow it.
- Switching re-renders in place: route, open rows, tab, filter, search text,
  composer drafts and scroll positions are kept.
- Backend errors `{ error, code }` are translated by `code`; an unknown or
  missing code shows the raw `error`. `control_rejected` shows a translated
  prefix plus OmO's own reason. `SessionState.errors` are shown verbatim
  except the known stale-quota message. The coordinator is always labelled
  by the UI, never by `parents[0].name`. User and agent data (names,
  prompts, tool output) is never translated.

## 10. v1.2 views (tasks, plan, usage, overview, accounts)
Code: `src/ui/*.js` ES modules (served flat at `/ui/<name>.js`) plus
`src/ui/ui.css`; `index.html` keeps the shell and exposes `window.OMO`
(t, formatters, chip, routing, state) and calls `window.OMOUI` hooks.
- **Navigation:** sidebar global entries Overview / Accounts above the
  project list (same wash + check selection as projects); project tabs
  Flow | Tasks | Plan | Usage as links with the ink underline.
- **Tasks:** Gantt (rows in tree order, bars = status tone, running bars
  striped, plan phases as shaded bands, dashed now line). Dragging on the
  track selects a time range; phase chips select a phase range (keyboard
  path); the selection filters the table and dims bars outside it.
  Sortable table (`aria-sort`), search + status + agent filters, totals
  row, fallback badge (warning tone, title = requested -> effective), plan
  item with the inferred tag. Row, name button and bar open the agent.
- **Plan:** KPIs (done/total with progress bar, in progress, phases,
  updated), request text, goal card, burn-up (done = filled success step
  area, total = dashed step line), phase cards with item chip, timestamps,
  time spent and linked-task chips (inferred) that open the agent.
- **Usage (project) / Overview (global):** KPIs today / 7 d / 30 d for
  tokens, cost and messages (plus sessions, running agents, accounts on
  Overview); stacked bar card with range 24 h / 7 d / 30 d, group by
  (Overview only: provider, model, project, agent, session, account) and
  metric; top 7 series + "others". `/api/usage` has no project filter, so
  the project tab charts its own `groupBy=project` series and builds the
  model / agent / tool / top-task tables from the session state.
- **Accounts:** totals per provider, one card per account (active,
  pinned, state, block with a live countdown only when in the future,
  otherwise "last block expired", credential expiry with an expired tag,
  last success, failures), ring gauges per quota window (info < 70%,
  warning < 90%, danger) with reset countdown and burn rate or "collecting
  data", and quota-history lines (left axis, %) over hourly token bars
  (right axis) on one time axis. Unattributed (`<provider>:unknown`) usage
  gets its own card.
- **Charts:** inline SVG drawn at the card's measured width after each
  render (window resize redraws); a minimum width makes the chart scroll
  inside its card (default scrolled to the latest data); `role=img` with an
  aria summary, hover tooltip, and a "Show as table" toggle. Series colors
  `--c1..--c8` + `--c-other` (light/dark pairs in `ui.css`).
- **Labels:** cost is always "API-equivalent cost" with a tooltip;
  anything inferred (plan item, task links, account attribution, burn
  rate) carries a dashed `inferred` tag with a tooltip.
- **Live data:** one fetch cache per key; a new URL aborts the stale
  request, an SSE refresh while loading is coalesced into one follow-up.
  `usage` refetches the visible usage/insights data, `accounts` the
  accounts/quota data, `state` the insights; hidden views' entries are
  dropped and refetched on return. No polling; one 1 s interval runs only
  while a `[data-countdown]` is on screen and repaints when one crosses 0.
- **Accepted debt:** the Gantt time brush is pointer-only (phase chips
  are the keyboard path); tables scroll horizontally inside their card on
  phones; the burn-up shows every todo re-plan as a drop in done.
