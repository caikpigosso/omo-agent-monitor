import { locale } from "./paths.mjs";

// Terminal-facing text for the extension and the tmux readers; the browser UI has its own dictionaries.
const messages = {
  en: {
    dashboard: "Dashboard",
    toolLabel: "Agent dashboard",
    readersClosed: "tmux readers closed; the dashboard and agents keep running.",
    usage: "Use /monitor, /monitor tmux or /monitor stop.",
    controlUnavailable: "Control unavailable in this session; run /monitor once and try again.",
    messagePrompt: "message> ",
    messageConfirmed: "Message confirmed by OmO.",
    abortConfirmed: "Abort confirmed by OmO.",
    waitPrevious: "Wait for the previous confirmation.",
    pickPane: "Pick an agent pane with Ctrl+B and the arrows; Ctrl+B Z zooms.",
    refused: "Refused",
    agentHeader: "OmO agent | type to send a message | /abort stops | /output | /quit",
    listHeader: "OmO agents | observe-and-control panes only; no duplicate executor.",
    noAgents: "No agents in this session.",
  },
  "pt-BR": {
    dashboard: "Painel",
    toolLabel: "Painel dos agentes",
    readersClosed: "Leitores tmux encerrados; o painel e os agentes continuam.",
    usage: "Use /monitor, /monitor tmux ou /monitor stop.",
    controlUnavailable: "Controle indisponivel nesta sessao; rode /monitor uma vez e tente de novo.",
    messagePrompt: "mensagem> ",
    messageConfirmed: "Mensagem confirmada pelo OmO.",
    abortConfirmed: "Interrupcao confirmada pelo OmO.",
    waitPrevious: "Aguarde a confirmacao anterior.",
    pickPane: "Escolha o painel do agente com Ctrl+B e as setas; Ctrl+B Z amplia.",
    refused: "Recusado",
    agentHeader: "OmO agente | texto envia mensagem | /abort interrompe | /output | /quit",
    listHeader: "OmO agentes | paineis somente de observacao e controle; nenhum executor duplicado.",
    noAgents: "Nenhum agente nesta sessao.",
  },
};

export const text = messages[locale];
