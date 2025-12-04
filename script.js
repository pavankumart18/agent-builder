import { openaiConfig } from "bootstrap-llm-provider";
import hljs from "highlight.js";
import { html, render } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { Marked } from "marked";
import saveform from "saveform";

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
$("#settings-form [type=reset]").addEventListener("click", () => settingsForm.clear());

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
  runningAgentIndex: null,
  error: "",
  customProblem: null,
};

let lastScrollKey = null;
let scrollScheduled = false;

initializeSettings(config.defaults || {});
renderDemoCards();
renderApp();
syncCustomProblemControls();

function initializeSettings(defaults) {
  if ($("#model") && !$("#model").value) $("#model").value = defaults.model || "gpt-5-mini";
  if ($("#architect-prompt") && !$("#architect-prompt").value) $("#architect-prompt").value = defaults.architectPrompt || "";
  if ($("#agent-style") && !$("#agent-style").value) $("#agent-style").value = defaults.agentStyle || "";
  if ($("#max-agents") && !$("#max-agents").value) $("#max-agents").value = defaults.maxAgents || 4;
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
  return html`
    <section class="card mb-4">
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
  const status = (index) => {
    if (state.stage === "architect") return "secondary";
    if (state.stage === "run") {
      if (index < (state.runningAgentIndex ?? 0)) return "success";
      if (index === state.runningAgentIndex) return "primary";
      return "secondary";
    }
    return state.agentOutputs[index] ? "success" : "secondary";
  };
  return html`
    <section class="card mb-4">
      <div class="card-header d-flex justify-content-between align-items-center">
        <span>Flow Diagram</span>
        <small class="text-body-secondary">Agent titles</small>
      </div>
      <div class="card-body">
        <div class="flow-grid">
          ${state.plan.map((agent, index) => html`
            <div class="card border-${status(index)} border-2 flex-shrink-0 flow-node text-center">
              <div class="card-body py-3">
                <div class="fw-semibold">${agent.agentName}</div>
              </div>
            </div>
          `)}
        </div>
      </div>
    </section>
  `;
}

function renderAgentOutputs() {
  if (!state.agentOutputs.length) return null;
  return html`
    <section class="mb-5">
      ${state.agentOutputs.map((agent, index) => html`
        <div class="card mb-3 shadow-sm" data-running-key=${`agent-${index}`}>
          <div class="card-body row g-3 align-items-stretch">
            <div class="col-md-4 d-flex flex-column">
              <p class="text-uppercase small text-body-secondary mb-1">Step ${index + 1}</p>
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
      `)}
    </section>
  `;
}

function renderAgentOutputBody(agent) {
  if (!agent.text) {
    return html`<div class="text-center py-3">${loading}</div>`;
  }
  if (agent.status === "done") {
    return unsafeHTML(marked.parse(agent.text));
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
    runningAgentIndex: null,
    error: "",
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
    runningAgentIndex: null,
    error: "",
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
    setState({ stage: "architect", plan: [], suggestedInputs: [], selectedInputs: new Set(), architectBuffer: "", error: "" });
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
    });
  } catch (error) {
    setState({ stage: "idle", runningAgentIndex: null, error: error?.message || String(error) });
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
    setState({ stage: "run", agentOutputs: [], runningAgentIndex: null, error: "" });
    let context = inputBlob;
    for (let index = 0; index < state.plan.length; index += 1) {
      const agent = state.plan[index];
      const agentId = uniqueId("agent");
      setState({
        agentOutputs: [
          ...state.agentOutputs,
          {
            id: agentId,
            name: agent.agentName,
            task: agent.initialTask,
            instruction: agent.systemInstruction,
            text: "",
            status: "running",
          },
        ],
        runningAgentIndex: index,
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
      }
    }
    setState({ stage: "idle", runningAgentIndex: null });
  } catch (error) {
    setState({ stage: "idle", runningAgentIndex: null, error: error?.message || String(error) });
  }
}

function updateAgentOutput(agentId, text, status) {
  setState({
    agentOutputs: state.agentOutputs.map((entry) => (entry.id === agentId ? { ...entry, text, status: status || entry.status } : entry)),
  });
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

function normalizePlan(list, maxAgents) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && typeof item === "object")
    .slice(0, maxAgents)
    .map((item, index) => ({
      agentName: (item.agentName || `Agent ${index + 1}`).trim(),
      systemInstruction: (item.systemInstruction || "Deliver the next actionable step.").trim(),
      initialTask: (item.initialTask || item.systemInstruction || "Next step.").trim(),
    }));
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

function sanitizeInputType(value) {
  const allowed = ["text", "csv", "json"];
  const lower = (value || "").toString().trim().toLowerCase();
  return allowed.includes(lower) ? lower : "text";
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
      lastScrollKey = null;
      return;
    }
    if (key === lastScrollKey) return;
    const target = document.querySelector(`[data-running-key="${key}"]`);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      lastScrollKey = key;
    }
  });
}

function getRunningScrollKey() {
  if (state.stage === "architect") return "architect-plan";
  if (state.stage === "run" && typeof state.runningAgentIndex === "number") {
    return `agent-${state.runningAgentIndex}`;
  }
  return null;
}
