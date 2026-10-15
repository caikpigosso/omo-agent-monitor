import { startControlClient } from "./control-client.mjs";

const failure = (code, error, status = 400) => ({ status, value: { error, code } });
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

export async function startQuestions({ agentDir, parentId, emit, changed }) {
  const pending = new Map(), closed = new Set(), aliases = new Map(), observed = new Set();
  let available = false, nativeIds = new Set(), bridge;
  function ask(request, fromEndpoint = false) {
    const requestId = request.uiRequestId || request.id || request.requestId;
    if (!requestId || closed.has(requestId)) return;
    if (fromEndpoint && request.requestId && request.requestId !== requestId) pending.delete(request.requestId);
    if (request.requestId) aliases.set(request.requestId, requestId);
    const previous = pending.get(requestId);
    const value = { requestId,
      askedAt: request.askedAt || (request.askedAtMs ? new Date(request.askedAtMs).toISOString() : previous?.askedAt || new Date().toISOString()),
      deadlineAt: request.deadlineAtMs ? new Date(request.deadlineAtMs).toISOString() : request.deadlineAt,
      blocking: request.waitForAnswer === true || request.blocking === true,
      questions: (request.questions || []).map(question => ({ id: question.id, header: question.header,
        question: question.question, multiSelect: question.multiSelect === true,
        options: (question.options || []).map(option => ({ label: option.label, description: option.description })) })),
      answerable: available && nativeIds.has(requestId) };
    pending.set(requestId, value);
    if (!previous) emit({ requestId, kind: "asked" });
    if (JSON.stringify(previous) !== JSON.stringify(value)) changed();
  }
  function close({ requestId, status, resolvedBy }) {
    requestId = aliases.get(requestId) || requestId;
    if (!requestId || closed.has(requestId)) return;
    closed.add(requestId);
    if (pending.delete(requestId)) {
      emit({ requestId, kind: "closed", status, ...(resolvedBy ? { resolvedBy } : {}) }); changed();
    }
  }
  bridge = await startControlClient({ agentDir, parentId,
    onAvailability(value) {
      available = value;
      for (const question of pending.values()) question.answerable = value && nativeIds.has(question.requestId);
      changed();
    },
    onState(state) {
      // TUI feeds carry IDs, while RPC state can carry complete request records.
      // A missing field is not an empty authoritative snapshot.
      const requests = Array.isArray(state.pendingQuestions) ? state.pendingQuestions : [];
      const ids = Array.isArray(state.pendingQuestionIds) ? new Set(state.pendingQuestionIds)
        : Array.isArray(state.pendingQuestions)
          ? new Set(requests.map(request => request.uiRequestId || request.id || request.requestId)) : undefined;
      if (!ids) return;
      nativeIds = ids;
      for (const request of requests) {
        ask(request, true);
      }
      for (const question of pending.values()) question.answerable = available && ids.has(question.requestId);
      for (const id of ids) observed.add(id);
      for (const requestId of observed) if (!ids.has(requestId)) close({ requestId, status: "resolved" });
      changed();
      return [...ids].filter(id => !pending.has(id) && !closed.has(id));
    } });
  return {
    list: () => [...pending.values()],
    ask(event) {
      ask(event.request);
      void bridge.refresh().catch(error => console.error("[agent-monitor] question bridge refresh failed",
        { parentId, error: error.message }));
    },
    close,
    async answer(requestId, body) {
      if (closed.has(requestId)) return failure("question_already_resolved", "This question has already been resolved.", 409);
      const question = pending.get(requestId);
      if (!question) return failure("question_unknown", "Question not found.", 404);
      if (!object(body) || body.cancelled !== undefined && body.cancelled !== true)
        return failure("question_invalid", "Invalid question answer.");
      if (body.cancelled !== true) {
        if (!object(body.answers) || body.comment !== undefined && typeof body.comment !== "string"
          || body.comment?.length > 32_000) return failure("question_invalid", "Invalid question answer.");
        for (const [id, answer] of Object.entries(body.answers)) {
          const field = question.questions.find(value => value.id === id);
          if (!field || !object(answer) || !Array.isArray(answer.selected)
            || answer.selected.some(value => typeof value !== "string")
            || !field.multiSelect && answer.selected.length > 1
            || answer.text !== undefined && (typeof answer.text !== "string" || answer.text.length > 32_000))
            return failure("question_invalid", "Invalid question answer.");
        }
        if (!body.comment?.trim() && !Object.keys(body.answers).length)
          return failure("question_incomplete", "Provide an answer or a comment.");
      }
      const payload = body.cancelled === true ? { cancelled: true }
        : { answers: body.answers, ...(body.comment !== undefined ? { comment: body.comment } : {}) };
      if (!nativeIds.has(requestId)) return failure("question_bridge_unavailable", "Question control endpoint unavailable.", 503);
      let reply;
      try { reply = await bridge.answer(requestId, payload); }
      catch (error) { return failure("question_bridge_unavailable", "Question control endpoint unavailable.", 503); }
      if (!reply) return failure("question_bridge_unavailable", "Question control endpoint unavailable.", 503);
      if (!reply.success) {
        const code = reply.error;
        if (code === "question_incomplete") return failure(code, "Provide an answer or a comment.");
        if (code === "invalid_response") return failure("question_invalid", "Invalid question answer.");
        if (code === "unknown_request" || code === "question_already_resolved") {
          if (code === "question_already_resolved" || closed.has(requestId)) {
            close({ requestId, status: "resolved" });
            return failure("question_already_resolved", "This question has already been resolved.", 409);
          }
          return failure("question_bridge_unavailable", "Question control endpoint unavailable.", 503);
        }
        return failure("question_bridge_unavailable", "Question control endpoint unavailable.", 503);
      }
      const outcome = payload.cancelled ? "cancelled" : payload.comment?.trim() ? "comment-submitted" : "answered";
      close({ requestId, status: outcome });
      return { value: { ok: true, outcome } };
    },
    stop: () => bridge.stop(),
  };
}
