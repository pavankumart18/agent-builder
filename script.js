import { openaiConfig } from "bootstrap-llm-provider";
import hljs from "highlight.js";
import { html, render } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { Marked } from "marked";
import saveform from "saveform";
import { createFlowchart } from "./flowchart.js";

const $ = (selector, el = document) => el.querySelector(selector);
const loading = html`<div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div>`;
const DEFAULT_BASE_URLS = [
  "https://api.openai.com/v1",
  "https://llmfoundry.straivedemo.com/openai/v1",
  "https://llmfoundry.straive.com/openai/v1",
];

const marked = new Marked();
marked.use({
  renderer: {
    code(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : "plaintext";
      const highlighted = hljs.highlight(code ?? "", { language }).value.trim();
      return `<pre class="hljs language-${language}"><code>${highlighted}</code></pre>`;
    },
  },
});

const settingsForm = saveform("#settings-form");
const settingsFormEl = $("#settings-form");
const flowOrientationInput = $("#flow-orientation");
const flowColumnsInput = $("#flow-columns");
$("#settings-form [type=reset]").addEventListener("click", () => settingsForm.clear());
flowOrientationInput?.addEventListener("change", handleFlowLayoutInput);
flowColumnsInput?.addEventListener("input", handleFlowLayoutInput);
flowColumnsInput?.addEventListener("change", handleFlowLayoutInput);
settingsFormEl?.addEventListener("reset", () => {
  setTimeout(() => {
    applyFlowLayoutSettingsFromForm();
    scheduleFlowchartSync();
  }, 0);
});

const llmSession = { creds: null };
$("#configure-llm").addEventListener("click", async () => {
  llmSession.creds = await openaiConfig({ defaultBaseUrls: DEFAULT_BASE_URLS, show: true });
});

const config = await fetch("config.json").then((res) => res.json());
config.demos = (config.demos || []).map((demo) => ({
  ...demo,
  inputs: (demo.inputs || []).map((input) => ({ ...input, id: uniqueId("input") })),
}));

const customProblemForm = $("#custom-problem-form");
const customProblemField = $("#custom-problem");
const customProblemButton = $("#run-custom-problem");

customProblemForm?.addEventListener("submit", handleCustomProblemSubmit);

const state = {
  selectedDemoIndex: null,
  stage: "idle",
  plan: [],
  suggestedInputs: [],
  selectedInputs: new Set(),
  uploads: [],
  notes: "",
  agentOutputs: [],
  architectBuffer: "",
  error: "",
  customProblem: null,
  focusedNodeId: null,
  runningNodeIds: new Set(),
  latestNodeId: null,
  flowOrientation: normalizeFlowOrientation(config.defaults?.flowOrientation),
  flowColumns: clampFlowColumns(config.defaults?.flowColumns ?? 2),
};

const scrollState = { key: null, height: 0 };
let scrollScheduled = false;
let flowchartController = null;
let flowchartElementsKey = "";
let flowchartSyncScheduled = false;

initializeSettings(config.defaults || {});
renderDemoCards();
renderApp();
syncCustomProblemControls();

function initializeSettings(defaults) {
  if ($("#model") && !$("#model").value) $("#model").value = defaults.model || "gpt-5-mini";
  if ($("#architect-prompt") && !$("#architect-prompt").value) $("#architect-prompt").value = defaults.architectPrompt || "";
  if ($("#agent-style") && !$("#agent-style").value) $("#agent-style").value = defaults.agentStyle || "";
  if ($("#max-agents") && !$("#max-agents").value) $("#max-agents").value = defaults.maxAgents || 4;
  if (flowOrientationInput && !flowOrientationInput.value) flowOrientationInput.value = normalizeFlowOrientation(defaults.flowOrientation);
  if (flowColumnsInput && !flowColumnsInput.value) flowColumnsInput.value = clampFlowColumns(defaults.flowColumns ?? 2).toString();
  applyFlowLayoutSettingsFromForm();
  scheduleFlowchartSync();
}

function setState(updates) {
  Object.assign(state, updates);
  renderDemoCards();
  renderApp();
  syncCustomProblemControls();
}

function renderDemoCards() {
  const busy = state.stage === "architect" || state.stage === "run";
  render(
    (config.demos || []).map((demo, index) => html`
      <div class="col-sm-6 col-lg-4">
        <div class="card demo-card h-100 shadow-sm">
          <div class="card-body d-flex flex-column">
            <div class="text-center text-primary display-5 mb-3"><i class="${demo.icon}"></i></div>
            <h5 class="card-title">${demo.title}</h5>
            <p class="card-text text-body-secondary small flex-grow-1">${demo.body}</p>
            <button class="btn btn-primary mt-auto" @click=${() => planDemo(index)} ?disabled=${busy}>
              ${busy && state.selectedDemoIndex === index ? "Streaming..." : "Plan & Run"}
            </button>
          </div>
        </div>
      </div>
    `),
    $("#demo-cards"),
  );
}

function renderApp() {
  const container = $("#output");
  if (!container) return;
  if (state.selectedDemoIndex === null) {
    render(
      html`
        <div class="text-center text-body-secondary py-5">
          <p>Select a card above to stream the architect plan and run the agents.</p>
        </div>
      `,
      container,
    );
    scheduleScrollToRunningSection();
    return;
  }
  const demo = getSelectedDemo();
  render(
    html`
      ${state.error ? html`<div class="alert alert-danger">${state.error}</div>` : null}
      <section class="card mb-4">
        <div class="card-body">
          <h3 class="h4 mb-2">${demo.title}</h3>
          <p class="mb-0 text-body-secondary small">${demo.problem}</p>
        </div>
      </section>
      ${renderStageBadges()}
      ${renderPlan()}
      ${renderDataInputs()}
      ${renderFlow()}
      ${renderAgentOutputs()}
    `,
    container,
  );
  scheduleScrollToRunningSection();
  scheduleFlowchartSync();
}

function renderStageBadges() {
  const steps = [
    { label: "Architect", active: state.stage === "architect", done: state.stage === "data" || state.stage === "run" || state.stage === "idle" && state.plan.length },
    { label: "Data", active: state.stage === "data", done: state.stage === "run" || (state.stage === "idle" && state.agentOutputs.length) },
    { label: "Agents", active: state.stage === "run", done: state.stage === "idle" && state.agentOutputs.length },
  ];
  return html`
    <div class="d-flex gap-2 flex-wrap mb-4">
      ${steps.map((step) => html`
        <span class="badge text-bg-${step.active ? "primary" : step.done ? "success" : "secondary"}">
          ${step.label}
        </span>
      `)}
    </div>
  `;
}

function renderPlan() {
  const streaming = state.stage === "architect";
  const hasPlan = state.plan.length > 0;
  return html`
    <section class="card mb-4" data-running-key=${streaming ? "architect-plan" : null}>
      <div class="card-header d-flex justify-content-between align-items-center">
        <span><i class="bi bi-diagram-3 me-2"></i> Architect Plan</span>
        <span class="badge text-bg-${streaming ? "primary" : hasPlan ? "success" : "secondary"}">
          ${streaming ? "Planning" : hasPlan ? "Ready" : "Pending"}
        </span>
      </div>
      <div class="card-body">
        ${streaming
          ? html`<pre class="bg-dark text-white rounded-3 p-3 mb-0" style="white-space: pre-wrap;">${state.architectBuffer || "Streaming architect plan..."}</pre>`
          : hasPlan
            ? html`
            <ol class="list-group list-group-numbered">
              ${state.plan.map((agent) => html`
                <li class="list-group-item">
                  <div class="d-flex justify-content-between align-items-start">
                    <div>
                      <div class="fw-semibold">${agent.agentName}</div>
                      <div class="text-body-secondary small">${agent.initialTask}</div>
                    </div>
                    <span class="badge text-bg-light text-uppercase">${agent.systemInstruction ? "Instruction" : ""}</span>
                  </div>
                  ${agent.systemInstruction
                    ? html`<p class="small mb-0 mt-2 text-body-secondary">${agent.systemInstruction}</p>`
                    : null}
                </li>
              `)}
            </ol>
          `
            : html`<div class="text-center py-3 text-body-secondary small">Plan will appear here after the architect stream completes.</div>`}
      </div>
    </section>
  `;
}

function renderDataInputs() {
  const disabled = !state.plan.length || state.stage === "architect" || state.stage === "run";
  const highlightKey = state.stage === "data" ? "data-inputs" : null;
  return html`
    <section class="card mb-4" data-running-key=${highlightKey}>
      <div class="card-header d-flex justify-content-between align-items-center flex-wrap gap-2">
        <div><i class="bi bi-database me-2"></i> Data Inputs</div>
        <button class="btn btn-sm btn-primary" @click=${startAgents} ?disabled=${disabled}>
          ${state.stage === "run" ? "Running..." : "Start Agents"}
        </button>
      </div>
      <div class="card-body">
        <div class="row g-3">
          <div class="col-lg-7">
            ${state.suggestedInputs.length
              ? html`
                <div class="list-group">
                  ${state.suggestedInputs.map((input) => {
                    const selected = state.selectedInputs.has(input.id);
                    const mutedTextClass = selected ? "text-white" : "text-body-secondary";
                    return html`
                      <button type="button" class="list-group-item list-group-item-action d-flex flex-column gap-1 ${selected ? "active text-white" : ""}" @click=${() => toggleSuggestedInput(input.id)}>
                        <div class="d-flex justify-content-between align-items-center w-100">
                          <span class="fw-semibold ${selected ? "text-white" : ""}">${input.title}</span>
                          <span class="badge text-uppercase bg-secondary">${input.type}</span>
                        </div>
                        <pre class="mb-0 small ${mutedTextClass}" style="white-space: pre-wrap; word-break: break-word;">${truncate(input.content, 420)}</pre>
                      </button>
                    `;
                  })}
                </div>
              `
              : html`<p class="text-body-secondary small">Architect suggestions will appear here.</p>`}
          </div>
          <div class="col-lg-5">
            <div class="mb-3">
              <label class="form-label small fw-semibold" for="data-upload">Upload CSV/JSON/TXT</label>
              <input id="data-upload" class="form-control" type="file" multiple accept=".txt,.csv,.json" @change=${handleFileUpload} />
              ${state.uploads.length
                ? html`
                  <ul class="list-group list-group-flush mt-2 small">
                    ${state.uploads.map((upload) => html`
                      <li class="list-group-item d-flex justify-content-between align-items-center">
                        <div>
                          <div class="fw-semibold">${upload.title}</div>
                          <div class="text-body-secondary">${formatBytes(upload.meta?.size || 0)} · ${upload.type.toUpperCase()}</div>
                        </div>
                        <button class="btn btn-link btn-sm text-danger" type="button" @click=${() => removeUpload(upload.id)}>Remove</button>
                      </li>
                    `)}
                  </ul>
                `
                : html`<p class="small text-body-secondary mt-2 mb-0">Attached files stay in the browser.</p>`}
            </div>
            <div>
              <label class="form-label small fw-semibold" for="data-notes">Inline notes</label>
              <textarea
                id="data-notes"
                class="form-control"
                rows="4"
                placeholder="Paste quick metrics, KPIs, transcripts..."
                .value=${state.notes}
                @input=${(event) => setState({ notes: event.target.value })}
              ></textarea>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderFlow() {
  if (!state.plan.length) return null;
  return html`
    <section class="card mb-4">
      <div class="card-header d-flex justify-content-between align-items-center flex-wrap gap-2">
        <span><i class="bi bi-diagram-3 me-2"></i>Execution Flow</span>
        <small class="text-body-secondary">Click nodes to inspect prior output, click outside to resume live view.</small>
      </div>
      <div class="card-body">
        <div class="row g-3 align-items-stretch">
          <div class="col-xl-8 col-lg-7">
            <div
              id="flowchart-canvas"
              class="flowchart-canvas border rounded-3 bg-body-tertiary"
              data-flow-orientation=${state.flowOrientation}
              data-flow-columns=${state.flowColumns}
            ></div>
          </div>
          <div class="col-xl-4 col-lg-5">
            ${renderFlowOutputPanel()}
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderFlowOutputPanel() {
  const focusedNodeId = state.focusedNodeId;
  const liveNodeId = focusedNodeId ?? getLiveNodeId();
  const agentOutput = liveNodeId ? getAgentOutputByNodeId(liveNodeId) : null;
  const stepLabel = liveNodeId ? getNodeStepLabel(liveNodeId) : null;
  const nodeTitle = liveNodeId ? getNodeLabel(liveNodeId) : "Agent Output";
  const panelTitle = focusedNodeId
    ? stepLabel || "Pinned Step"
    : stepLabel
      ? `Live Output · ${stepLabel}`
      : "Live Output";
  const helper = focusedNodeId
    ? agentOutput
      ? "Showing saved response from this node."
      : "Waiting for this node's first output."
    : "Streaming the latest agent response.";
  const emptyMessage = focusedNodeId ? "No output recorded yet for this node." : "Run the agents to stream their output here.";
  const streamClass = agentOutput ? agentStreamClasses(agentOutput) : "agent-stream border rounded-3 p-3 bg-body";
  const status = agentOutput ? statusMeta(agentOutput.status) : null;
  const footer = focusedNodeId
    ? "Click outside the graph to return to the live stream."
    : "Click any node to inspect its previous output.";
  return html`
    <div class="flow-output-panel h-100 d-flex flex-column">
      <div class="d-flex justify-content-between align-items-start mb-2">
        <div>
          <p class="text-uppercase small text-body-secondary mb-1">${panelTitle}</p>
          <h6 class="mb-1">${nodeTitle}</h6>
          <small class="text-body-secondary">${helper}</small>
        </div>
        ${status ? html`<span class="badge text-bg-${status.color}">${status.label}</span>` : null}
      </div>
      <div class="${streamClass} flex-grow-1 overflow-auto">
        ${agentOutput
          ? renderAgentOutputBody(agentOutput)
          : html`<div class="text-body-secondary small">${emptyMessage}</div>`}
      </div>
      <p class="text-body-secondary small mt-3 mb-0">${footer}</p>
    </div>
  `;
}

function renderAgentOutputs() {
  if (!state.agentOutputs.length) return null;
  return html`
    <section class="mb-5">
      ${state.agentOutputs.map((agent, index) => {
        const stepLabel = getNodeStepLabel(agent.nodeId) || `Run ${index + 1}`;
        return html`
        <div class="card mb-3 shadow-sm" data-running-key=${`node-${agent.nodeId || index}`}>
          <div class="card-body row g-3 align-items-stretch">
            <div class="col-md-4 d-flex flex-column">
              <p class="text-uppercase small text-body-secondary mb-1">${stepLabel}</p>
              <h6 class="mb-2">${agent.name}</h6>
              <p class="text-body-secondary small flex-grow-1 mb-3">${agent.task || agent.instruction || "Specialist executing next action."}</p>
              ${(() => {
                const meta = statusMeta(agent.status);
                return html`<span class="badge text-bg-${meta.color} align-self-start">${meta.label}</span>`;
              })()}
            </div>
            <div class="col-md-8">
              <div class="${agentStreamClasses(agent)}">
                ${renderAgentOutputBody(agent)}
              </div>
            </div>
          </div>
        </div>
      `;
      })}
    </section>
  `;
}

function renderAgentOutputBody(agent) {
  if (!agent.text) {
    return html`<div class="text-center py-3">${loading}</div>`;
  }
  if (agent.status === "done") {
    return html`<div class="agent-markdown">${unsafeHTML(marked.parse(agent.text))}</div>`;
  }
  const tone = agent.status === "error" ? "text-warning" : "text-white";
  return html`<pre class="mb-0 ${tone}" style="white-space: pre-wrap;">${agent.text}</pre>`;
}

function statusMeta(status) {
  if (status === "done") return { label: "Done", color: "success" };
  if (status === "error") return { label: "Error", color: "danger" };
  return { label: "Running", color: "primary" };
}

function agentStreamClasses(agent) {
  if (agent.status === "error") return "agent-stream border rounded-3 p-3 bg-dark text-warning";
  if (agent.status === "done") return "agent-stream border rounded-3 p-3 bg-body";
  return "agent-stream border rounded-3 p-3 bg-black text-white";
}

async function planDemo(index) {
  selectDemo(index);
  await runArchitect();
}

async function handleCustomProblemSubmit(event) {
  event.preventDefault();
  if (state.stage === "architect" || state.stage === "run") return;
  const value = customProblemField?.value?.trim();
  if (!value) {
    setState({ error: "Enter a custom problem statement before running." });
    customProblemField?.focus();
    return;
  }
  selectCustomProblem(value);
  await runArchitect();
}

function selectDemo(index) {
  const demo = config.demos[index];
  const baseInputs = (demo?.inputs || []).map((input) => ({ ...input, id: input.id || uniqueId("input") }));
  setState({
    selectedDemoIndex: index,
    customProblem: null,
    stage: "architect",
    plan: [],
    suggestedInputs: baseInputs,
    selectedInputs: new Set(baseInputs.map((input) => input.id)),
    uploads: [],
    notes: "",
    agentOutputs: [],
    architectBuffer: "",
    error: "",
    focusedNodeId: null,
    runningNodeIds: new Set(),
    latestNodeId: null,
  });
}

function selectCustomProblem(problemText) {
  const customDemo = {
    title: "Custom Problem",
    body: "User-supplied brief",
    problem: problemText,
    inputs: [],
  };
  setState({
    selectedDemoIndex: -1,
    customProblem: customDemo,
    stage: "architect",
    plan: [],
    suggestedInputs: [],
    selectedInputs: new Set(),
    uploads: [],
    notes: "",
    agentOutputs: [],
    architectBuffer: "",
    error: "",
    focusedNodeId: null,
    runningNodeIds: new Set(),
    latestNodeId: null,
  });
}

async function ensureLLMConfig() {
  if (!llmSession.creds) {
    llmSession.creds = await openaiConfig({ defaultBaseUrls: DEFAULT_BASE_URLS });
  }
  return llmSession.creds;
}

async function runArchitect() {
  const demo = getSelectedDemo();
  if (!demo) return;
  try {
    const llm = await ensureLLMConfig();
    if (!llm?.baseUrl || !llm?.apiKey) throw new Error("Configure the LLM base URL and API key first.");
    const model = getModel();
    const prompt = getArchitectPrompt();
    const maxAgents = getMaxAgents();
    const systemPrompt = `${prompt}\nLimit to <= ${maxAgents} agents.`.trim();
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: demo.problem },
    ];
    const body = { model, messages, stream: true };
    setState({
      stage: "architect",
      plan: [],
      suggestedInputs: [],
      selectedInputs: new Set(),
      architectBuffer: "",
      error: "",
      focusedNodeId: null,
      runningNodeIds: new Set(),
      latestNodeId: null,
    });
    let buffer = "";
    await streamChatCompletion({
      llm,
      body,
      onChunk: (text) => {
        buffer += text;
        setState({ architectBuffer: buffer });
      },
    });
    const parsed = safeParseJson(buffer);
    const plan = normalizePlan(parsed.plan, maxAgents);
    const inputs = normalizeInputs(parsed.inputs, demo);
    setState({
      plan,
      suggestedInputs: inputs,
      selectedInputs: new Set(inputs.map((input) => input.id)),
      stage: "data",
      architectBuffer: buffer,
      focusedNodeId: null,
      runningNodeIds: new Set(),
      latestNodeId: null,
    });
  } catch (error) {
    setState({
      stage: "idle",
      error: error?.message || String(error),
      focusedNodeId: null,
      runningNodeIds: new Set(),
      latestNodeId: null,
    });
  }
}

async function startAgents() {
  if (!state.plan.length || state.stage === "architect" || state.stage === "run") return;
  const demo = getSelectedDemo();
  if (!demo) return;
  const dataEntries = collectDataEntries();
  if (!dataEntries.length) {
    setState({ error: "Select or add at least one dataset before running agents." });
    return;
  }
  try {
    const llm = await ensureLLMConfig();
    if (!llm?.baseUrl || !llm?.apiKey) throw new Error("Configure the LLM base URL and API key first.");
    const model = getModel();
    const agentStyle = getAgentStyle();
    const inputBlob = formatDataEntries(dataEntries);
    setState({
      stage: "run",
      agentOutputs: [],
      error: "",
      focusedNodeId: null,
      runningNodeIds: new Set(),
      latestNodeId: null,
    });
    let context = inputBlob;
    for (let index = 0; index < state.plan.length; index += 1) {
      const agent = state.plan[index];
      const nodeId = agent?.nodeId || `agent-${index + 1}`;
      const agentId = uniqueId("agent");
      const runningNodes = new Set(state.runningNodeIds);
      runningNodes.add(nodeId);
      setState({
        agentOutputs: [
          ...state.agentOutputs,
          {
            id: agentId,
            nodeId,
            name: agent.agentName,
            task: agent.initialTask,
            instruction: agent.systemInstruction,
            text: "",
            status: "running",
          },
        ],
        runningNodeIds: runningNodes,
        latestNodeId: nodeId,
      });
      let buffer = "";
      try {
        await streamChatCompletion({
          llm,
          body: {
            model,
            stream: true,
            messages: [
              { role: "system", content: `${agent.systemInstruction}\n${agentStyle}`.trim() },
              {
                role: "user",
                content: `Problem:\n${demo.problem}\n\nTask:\n${agent.initialTask}\n\nInput Data:\n${inputBlob}\n\nPrevious Output:\n${truncate(context, 800)}`,
              },
            ],
          },
          onChunk: (text) => {
            buffer += text;
            updateAgentOutput(agentId, buffer, "running");
          },
        });
        updateAgentOutput(agentId, buffer, "done");
        context = buffer.trim() || context;
      } catch (error) {
        updateAgentOutput(agentId, buffer, "error");
        throw error;
      } finally {
        const nextRunning = new Set(state.runningNodeIds);
        nextRunning.delete(nodeId);
        setState({ runningNodeIds: nextRunning });
      }
    }
    setState({ stage: "idle", focusedNodeId: null, runningNodeIds: new Set() });
  } catch (error) {
    setState({
      stage: "idle",
      error: error?.message || String(error),
      focusedNodeId: null,
      runningNodeIds: new Set(),
    });
  }
}

function updateAgentOutput(agentId, text, status) {
  let latestNodeId = state.latestNodeId;
  const agentOutputs = state.agentOutputs.map((entry) => {
    if (entry.id !== agentId) return entry;
    latestNodeId = entry.nodeId;
    return { ...entry, text, status: status || entry.status };
  });
  setState({ agentOutputs, latestNodeId });
}

function toggleSuggestedInput(id) {
  const next = new Set(state.selectedInputs);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  setState({ selectedInputs: next });
}

function handleFileUpload(event) {
  const files = Array.from(event.target.files || []);
  files.forEach((file) => {
    const reader = new FileReader();
    reader.onload = () => {
      const entry = {
        id: uniqueId("upload"),
        title: file.name,
        type: inferTypeFromName(file.name),
        content: reader.result?.toString() || "",
        meta: { size: file.size },
        source: "upload",
      };
      setState({ uploads: [...state.uploads, entry] });
    };
    reader.readAsText(file);
  });
  event.target.value = "";
}

function removeUpload(id) {
  setState({ uploads: state.uploads.filter((upload) => upload.id !== id) });
}

function collectDataEntries() {
  const suggestions = state.suggestedInputs.filter((input) => state.selectedInputs.has(input.id));
  const uploads = state.uploads || [];
  const entries = [...suggestions, ...uploads];
  const note = (state.notes || "").trim();
  if (note) {
    entries.push({ id: uniqueId("note"), title: "User Notes", type: "text", content: state.notes.trim(), source: "notes" });
  }
  return entries;
}

function getSelectedDemo() {
  if (state.selectedDemoIndex === null) return null;
  if (state.selectedDemoIndex === -1) return state.customProblem;
  return config.demos[state.selectedDemoIndex];
}

function getModel() {
  return ($("#model")?.value || config.defaults?.model || "gpt-5-mini").trim();
}

function getArchitectPrompt() {
  return ($("#architect-prompt")?.value || config.defaults?.architectPrompt || "").trim();
}

function getAgentStyle() {
  return ($("#agent-style")?.value || config.defaults?.agentStyle || "").trim();
}

function getMaxAgents() {
  const value = parseInt($("#max-agents")?.value || config.defaults?.maxAgents || 5, 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, 2), 6) : 5;
}

function handleFlowLayoutInput() {
  if (!flowOrientationInput && !flowColumnsInput) return;
  const orientation = getFlowOrientationSetting();
  const columns = getFlowColumnsSetting();
  if (orientation === state.flowOrientation && columns === state.flowColumns) return;
  setState({ flowOrientation: orientation, flowColumns: columns });
  scheduleFlowchartSync();
}

function getFlowOrientationSetting() {
  if (!flowOrientationInput) return state.flowOrientation || "horizontal";
  return normalizeFlowOrientation(flowOrientationInput.value || config.defaults?.flowOrientation);
}

function getFlowColumnsSetting() {
  if (!flowColumnsInput) return state.flowColumns || 2;
  return clampFlowColumns(flowColumnsInput.value || config.defaults?.flowColumns || 2);
}

function applyFlowLayoutSettingsFromForm() {
  state.flowOrientation = getFlowOrientationSetting();
  state.flowColumns = getFlowColumnsSetting();
}

function normalizePlan(list, maxAgents) {
  if (!Array.isArray(list)) return [];
  const usedIds = new Set();
  return list
    .filter((item) => item && typeof item === "object")
    .slice(0, maxAgents)
    .map((item, index) => {
      const fallbackId = `agent-${index + 1}`;
      const candidateId = sanitizeNodeId(item.nodeId || item.id || item.key || item.slug || item.agentName, fallbackId);
      const nodeId = ensureUniqueNodeId(candidateId, usedIds, fallbackId);
      const stageValue = item.stage ?? item.phase ?? item.step ?? item.sequence ?? item.order;
      const phase = parsePhase(stageValue, index + 1);
      const phaseLabel = extractPhaseLabel(item, phase);
      return {
        nodeId,
        agentName: (item.agentName || `Agent ${index + 1}`).trim(),
        systemInstruction: (item.systemInstruction || "Deliver the next actionable step.").trim(),
        initialTask: (item.initialTask || item.systemInstruction || "Next step.").trim(),
        graphTargets: normalizeTargetRefs(item),
        graphIncoming: normalizeIncomingRefs(item),
        phase,
        phaseLabel,
        branchKey: sanitizeBranchKey(item.branch || item.parallelGroup || item.lane || item.track || item.cluster),
      };
    });
}

function normalizeInputs(list, demo) {
  if (!Array.isArray(list) || !list.length) return (demo?.inputs || []).map((input) => ({ ...input, id: input.id || uniqueId("input") }));
  return list
    .filter((item) => item && typeof item === "object")
    .slice(0, 3)
    .map((item, index) => ({
      id: uniqueId("input"),
      title: (item.title || `Input ${index + 1}`).trim(),
      type: sanitizeInputType(item.type),
      content: (item.sample || item.content || item.example || demo?.problem || "").trim(),
    }));
}

function sanitizeNodeId(value, fallback) {
  const base = (value || fallback || "").toString().trim().toLowerCase();
  const normalized = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback || `node-${Date.now().toString(36)}`;
}

function ensureUniqueNodeId(candidate, usedIds, fallback) {
  const base = candidate || fallback || `node-${usedIds.size + 1}`;
  let next = base;
  let attempt = 1;
  while (usedIds.has(next)) {
    attempt += 1;
    next = `${base}-${attempt}`;
  }
  usedIds.add(next);
  return next;
}

function normalizeTargetRefs(item) {
  const pools = [
    item.next,
    item.children,
    item.targets,
    item.links,
    item.branches,
    item.connections,
    item.to,
  ];
  if (Array.isArray(item.parallel)) pools.push(item.parallel);
  if (Array.isArray(item.graphTargets)) pools.push(item.graphTargets);
  if (Array.isArray(item.edges)) pools.push(item.edges);
  if (Array.isArray(item.graph?.edges)) pools.push(item.graph.edges);
  if (Array.isArray(item.graph?.connections)) pools.push(item.graph.connections);
  const refs = [];
  pools.forEach((pool) => {
    refs.push(...coerceTargetPool(pool));
  });
  return Array.from(new Set(refs.filter(Boolean)));
}

function normalizeIncomingRefs(item) {
  const pools = [
    item.dependsOn,
    item.requires,
    item.after,
    item.parents,
    item.prerequisites,
    item.inputsFrom,
    item.waitFor,
    item.sources,
    item.fanIn,
    item.branchOf,
  ];
  if (Array.isArray(item.graph?.parents)) pools.push(item.graph.parents);
  if (Array.isArray(item.graph?.sources)) pools.push(item.graph.sources);
  const refs = [];
  pools.forEach((pool) => {
    refs.push(...coerceTargetPool(pool));
  });
  return Array.from(new Set(refs.filter(Boolean)));
}

function coerceTargetPool(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(coerceSingleTarget).filter(Boolean);
  if (typeof value === "string" || typeof value === "number") {
    return value
      .toString()
      .split(/[,;\n]/)
      .map((segment) => segment.trim())
      .filter(Boolean);
  }
  if (typeof value === "object") {
    const entry = coerceSingleTarget(value);
    return entry ? [entry] : [];
  }
  return [];
}

function coerceSingleTarget(entry) {
  if (!entry) return null;
  if (typeof entry === "string" || typeof entry === "number") return entry.toString().trim();
  if (typeof entry !== "object") return null;
  return (
    entry.id?.toString().trim() ||
    entry.target?.toString().trim() ||
    entry.to?.toString().trim() ||
    entry.nodeId?.toString().trim() ||
    entry.name?.toString().trim() ||
    entry.label?.toString().trim() ||
    null
  );
}

function sanitizeInputType(value) {
  const allowed = ["text", "csv", "json"];
  const lower = (value || "").toString().trim().toLowerCase();
  return allowed.includes(lower) ? lower : "text";
}

function parsePhase(value, fallback) {
  if (value === null || value === undefined) return fallback;
  const num = Number(value);
  if (Number.isFinite(num)) return num;
  if (typeof value === "string") {
    const match = value.match(/\d+/);
    if (match) return Number(match[0]);
  }
  return fallback;
}

function extractPhaseLabel(item, phase) {
  if (typeof item.stageLabel === "string" && item.stageLabel.trim()) return item.stageLabel.trim();
  if (typeof item.phaseLabel === "string" && item.phaseLabel.trim()) return item.phaseLabel.trim();
  if (typeof item.stage === "string" && item.stage.trim() && Number.isNaN(Number(item.stage))) return item.stage.trim();
  if (typeof item.phase === "string" && item.phase.trim() && Number.isNaN(Number(item.phase))) return item.phase.trim();
  if (typeof item.group === "string" && item.group.trim()) return item.group.trim();
  if (Number.isFinite(phase)) return `Stage ${phase}`;
  return null;
}

function sanitizeBranchKey(value) {
  if (!value) return null;
  return value.toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || null;
}

function normalizeFlowOrientation(value) {
  return value === "vertical" ? "vertical" : "horizontal";
}

function clampFlowColumns(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 2;
  return Math.min(6, Math.max(1, Math.round(num)));
}

function formatDataEntries(entries) {
  if (!entries.length) return "User did not attach additional datasets.";
  return entries.map((entry, idx) => `${idx + 1}. ${entry.title} [${entry.type}]\n${truncate(entry.content, 600)}`).join("\n\n");
}

async function streamChatCompletion({ llm, body, onChunk = () => {} }) {
  const response = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`HTTP ${response.status} ${response.statusText} - ${message}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Streaming not supported in this browser.");
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    parts.forEach((part) => {
      if (!part.startsWith("data:")) return;
      const payload = part.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      const json = safeParseJson(payload);
      const text = json.choices?.[0]?.delta?.content;
      if (text) onChunk(text);
    });
  }
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = (bytes / 1024 ** exp).toFixed(1);
  return `${value} ${units[exp]}`;
}

function inferTypeFromName(name = "") {
  const lower = name.toLowerCase();
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".txt")) return "text";
  return "text";
}

function truncate(text, max) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function uniqueId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

function safeParseJson(text) {
  try {
    return JSON.parse((text || "").trim() || "{}");
  } catch {
    return {};
  }
}

function syncCustomProblemControls() {
  if (!customProblemButton) return;
  const busy = state.stage === "architect" || state.stage === "run";
  customProblemButton.disabled = busy;
  customProblemButton.textContent = busy ? "Streaming..." : "Plan & Run Custom";
}

function scheduleScrollToRunningSection() {
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    const key = getRunningScrollKey();
    if (!key) {
      resetScrollTracking();
      return;
    }
    const target = document.querySelector(`[data-running-key="${key}"]`);
    if (!target) return;
    const height = target.scrollHeight;
    const sameKey = scrollState.key === key;
    const heightChanged = sameKey && Math.abs(height - scrollState.height) > 32;
    const shouldFollow = state.stage === "architect" || state.stage === "run";
    const needsScroll = !sameKey || !isElementMostlyVisible(target) || (shouldFollow && heightChanged);
    if (needsScroll) {
      scrollElementIntoView(target);
    }
    scrollState.key = key;
    scrollState.height = height;
  });
}

function getRunningScrollKey() {
  if (state.stage === "architect") return "architect-plan";
  if (state.stage === "data") return "data-inputs";
  const nodeId = state.focusedNodeId || state.latestNodeId || state.agentOutputs[state.agentOutputs.length - 1]?.nodeId;
  return nodeId ? `node-${nodeId}` : null;
}

function resetScrollTracking() {
  scrollState.key = null;
  scrollState.height = 0;
}

function isElementMostlyVisible(element) {
  const rect = element.getBoundingClientRect();
  const viewHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const buffer = Math.min(120, viewHeight * 0.15);
  return rect.bottom > buffer && rect.top < viewHeight - buffer;
}

function scrollElementIntoView(element) {
  const rect = element.getBoundingClientRect();
  const viewHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const block = rect.top < 0 || rect.top < viewHeight * 0.25 ? "start" : "center";
  element.scrollIntoView({ behavior: "smooth", block });
}

function scheduleFlowchartSync() {
  if (flowchartSyncScheduled) return;
  flowchartSyncScheduled = true;
  requestAnimationFrame(() => {
    flowchartSyncScheduled = false;
    syncFlowchartCanvas();
  });
}

function syncFlowchartCanvas() {
  const container = document.querySelector("#flowchart-canvas");
  const graph = buildGraphFromPlan(state.plan);
  if (!container || !graph.nodes.length) {
    if (flowchartController) {
      flowchartController.destroy();
      flowchartController = null;
      flowchartElementsKey = "";
    }
    return;
  }
  if (!flowchartController || flowchartController.container !== container) {
    flowchartController?.destroy();
    flowchartController = createFlowchart(container, [], {
      orientation: state.flowOrientation,
      columnCount: state.flowColumns,
      onNodeSelected: handleFlowNodeSelected,
    });
    flowchartElementsKey = "";
  } else {
    flowchartController.setOrientation(state.flowOrientation);
    flowchartController.setColumns(state.flowColumns);
  }
  const elements = buildFlowElementsFromGraph(graph);
  const signature = JSON.stringify(elements.map((element) => element.data));
  if (signature !== flowchartElementsKey) {
    flowchartController.setElements(elements);
    flowchartElementsKey = signature;
  }
  flowchartController.setNodeState({
    activeIds: getActiveNodeIds(),
    completedIds: getCompletedNodeIds(),
    failedIds: getFailedNodeIds(),
    selectedId: state.focusedNodeId || null,
  });
  flowchartController.resize();
}

function buildFlowElementsFromGraph(graph) {
  const nodes = graph.nodes.map((node) => ({
    data: { id: node.id, label: node.label },
  }));
  const edges = graph.edges.map((edge) => ({
    data: { source: edge.source, target: edge.target },
  }));
  return [...nodes, ...edges];
}

function getCompletedNodeIds() {
  const completed = new Set();
  state.agentOutputs.forEach((entry) => {
    if (entry?.status === "done" && entry.nodeId) completed.add(entry.nodeId);
  });
  return Array.from(completed);
}

function getFailedNodeIds() {
  const failed = new Set();
  state.agentOutputs.forEach((entry) => {
    if (entry?.status === "error" && entry.nodeId) failed.add(entry.nodeId);
  });
  return Array.from(failed);
}

function handleFlowNodeSelected(nodeId) {
  if (!nodeId) {
    if (state.focusedNodeId) setState({ focusedNodeId: null });
    return;
  }
  if (state.focusedNodeId === nodeId) return;
  const exists = state.plan.some((agent) => agent.nodeId === nodeId);
  if (!exists) return;
  setState({ focusedNodeId: nodeId });
}

function buildGraphFromPlan(plan = []) {
  if (!plan.length) return { nodes: [], edges: [] };
  const nodes = plan.map((agent, index) => ({
    id: agent.nodeId || `agent-${index + 1}`,
    label: agent.agentName || `Agent ${index + 1}`,
    index,
    phase: Number.isFinite(agent.phase) ? agent.phase : index + 1,
    phaseLabel: agent.phaseLabel || null,
  }));
  const aliasMap = new Map();
  nodes.forEach((node, index) => {
    const agent = plan[index];
    registerNodeAlias(aliasMap, node.id, node);
    registerNodeAlias(aliasMap, node.label, node);
    if (agent.phaseLabel) registerNodeAlias(aliasMap, agent.phaseLabel, node);
    if (agent.branchKey) registerNodeAlias(aliasMap, agent.branchKey, node);
    registerNodeAlias(aliasMap, `step ${index + 1}`, node);
    registerNodeAlias(aliasMap, `${index + 1}`, node);
  });
  const edges = [];
  const seen = new Set();
  const orderedPhases = Array.from(new Set(nodes.map((node) => node.phase))).sort((a, b) => a - b);
  const phaseBuckets = new Map();
  nodes.forEach((node) => {
    const bucket = phaseBuckets.get(node.phase) || [];
    bucket.push(node);
    phaseBuckets.set(node.phase, bucket);
  });

  function addEdge(sourceId, targetId) {
    const signature = `${sourceId}->${targetId}`;
    if (sourceId === targetId || seen.has(signature)) return;
    edges.push({ source: sourceId, target: targetId });
    seen.add(signature);
  }

  nodes.forEach((node, index) => {
    const agent = plan[index];
    const inboundRefs = Array.isArray(agent?.graphIncoming) ? agent.graphIncoming : [];
    inboundRefs.forEach((ref) => {
      const source = resolveGraphTarget(ref, aliasMap);
      if (source) addEdge(source.id, node.id);
    });

    let explicitTargetsAdded = false;
    const targets = Array.isArray(agent?.graphTargets) ? agent.graphTargets : [];
    if (targets.length) {
      targets.forEach((target) => {
        const resolved = resolveGraphTarget(target, aliasMap);
        if (resolved) {
          addEdge(node.id, resolved.id);
          explicitTargetsAdded = true;
        }
      });
    }
    if (explicitTargetsAdded) return;

    const nextPhaseNodes = getNextPhaseNodes(node.phase, orderedPhases, phaseBuckets);
    if (nextPhaseNodes.length) {
      nextPhaseNodes.forEach((target) => addEdge(node.id, target.id));
      return;
    }

    if (!inboundRefs.length && index < nodes.length - 1) {
      addEdge(node.id, nodes[index + 1].id);
    }
  });

  return { nodes, edges };
}

function getNextPhaseNodes(currentPhase, orderedPhases, phaseBuckets) {
  const nextPhase = orderedPhases.find((phase) => phase > currentPhase);
  if (nextPhase === undefined) return [];
  return phaseBuckets.get(nextPhase) || [];
}

function registerNodeAlias(map, key, node) {
  if (!key || !node) return;
  const value = key.toString().trim();
  if (!value) return;
  map.set(value, node);
  map.set(value.toLowerCase(), node);
}

function resolveGraphTarget(target, aliasMap) {
  if (!target) return null;
  const key = target.toString().trim();
  if (!key) return null;
  return aliasMap.get(key) || aliasMap.get(key.toLowerCase()) || null;
}

function findPlanEntry(nodeId) {
  if (!nodeId) return null;
  return state.plan.find((entry) => entry.nodeId === nodeId) || null;
}

function getNodeLabel(nodeId) {
  const agent = findPlanEntry(nodeId);
  if (agent) return agent.agentName;
  return state.plan.length ? state.plan[state.plan.length - 1].agentName : "Agent Output";
}

function getNodeStepNumber(nodeId) {
  const index = state.plan.findIndex((entry) => entry.nodeId === nodeId);
  return index >= 0 ? index + 1 : null;
}

function getNodeStepLabel(nodeId) {
  const agent = findPlanEntry(nodeId);
  if (!agent) return null;
  if (agent.phaseLabel) return agent.phaseLabel;
  if (Number.isFinite(agent.phase)) return `Stage ${agent.phase}`;
  const stepNumber = getNodeStepNumber(nodeId);
  return stepNumber ? `Step ${stepNumber}` : null;
}

function getAgentOutputByNodeId(nodeId) {
  if (!nodeId) return null;
  for (let index = state.agentOutputs.length - 1; index >= 0; index -= 1) {
    const entry = state.agentOutputs[index];
    if (entry?.nodeId === nodeId) return entry;
  }
  return null;
}

function getActiveNodeIds() {
  const ordered = [];
  state.plan.forEach((agent) => {
    if (agent.nodeId && state.runningNodeIds.has(agent.nodeId)) ordered.push(agent.nodeId);
  });
  state.runningNodeIds.forEach((nodeId) => {
    if (!ordered.includes(nodeId)) ordered.push(nodeId);
  });
  return ordered;
}

function getLiveNodeId() {
  if (state.latestNodeId) return state.latestNodeId;
  const running = getActiveNodeIds();
  if (running.length) return running[running.length - 1];
  if (state.agentOutputs.length) return state.agentOutputs[state.agentOutputs.length - 1]?.nodeId || null;
  if (state.plan.length) return state.plan[0]?.nodeId || null;
  return null;
}

window.addEventListener("resize", () => scheduleFlowchartSync());
