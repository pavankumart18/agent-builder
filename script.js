const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

const nodes = {
  form: $("#orchestrator-form"),
  agentContainer: $("#agent-container"),
  runButton: $("#orchestrator-form button[type='submit']"),
  clearButton: $("#clear-log"),
  flowNodes: $("#flow-nodes"),
  dummyGrid: $("#dummy-data-grid"),
  dropzone: $("#data-dropzone"),
  fileInput: $("#data-file-input"),
  uploadedList: $("#uploaded-data-list"),
  dataNotes: $("#data-notes"),
  dataSection: $("#data-input-section"),
  dataStatus: $("#data-input-status"),
  inlineRunButton: $("#inline-run-button"),
};

const RUN_LABEL = nodes.runButton?.innerHTML || "Run Agents";
let currentRunLabel = RUN_LABEL;
const MIN_AGENTS = 2;
const MAX_AGENTS = 5;
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const RUN_STAGES = { IDLE: "idle", PLAN: "plan", DATA: "data", RUN: "run" };
const PLACEHOLDER = `
  <div class="text-center text-body-secondary small border border-dashed border-secondary rounded-3 py-4 bg-body">
    Agents will appear here after you run a problem.
  </div>`;
const ARCHITECT_PROMPT = `Respond with JSON only: {"plan":[...],"inputs":[...]}.
"plan": ${MIN_AGENTS}-${MAX_AGENTS} agents, each { "agentName","systemInstruction","initialTask" }.
"inputs": up to 3 items, each { "title","type","sample" } where "type" is "text","csv", or "json". Keep sentences short.`;
const ALLOWED_INPUT_TYPES = ["text", "csv", "json"];

const state = {
  stage: RUN_STAGES.IDLE,
  plan: [],
  config: null,
  inputs: [],
  uploads: [],
};
const dataSectionHome = {
  parent: nodes.dataSection?.parentElement || null,
  next: nodes.dataSection?.nextElementSibling || null,
};

init();

function init() {
  bindEvents();
  persistFields(["model", "base-url", "problem"]);
  loadProblems();
  resetUI();
}

function bindEvents() {
  nodes.form.addEventListener("submit", onSubmit);
  nodes.clearButton.addEventListener("click", resetUI);
  nodes.dummyGrid?.addEventListener("click", (event) => {
    const card = event.target.closest("[data-input-id]");
    if (card) card.classList.toggle("active");
  });
  nodes.dropzone?.addEventListener("click", () => nodes.fileInput?.click());
  nodes.dropzone?.addEventListener("dragover", (event) => {
    event.preventDefault();
    nodes.dropzone.classList.add("dragover");
  });
  nodes.dropzone?.addEventListener("dragleave", () => nodes.dropzone.classList.remove("dragover"));
  nodes.dropzone?.addEventListener("drop", (event) => {
    event.preventDefault();
    nodes.dropzone.classList.remove("dragover");
    handleFiles(event.dataTransfer?.files);
  });
  nodes.fileInput?.addEventListener("change", (event) => handleFiles(event.target.files));
  nodes.uploadedList?.addEventListener("click", (event) => {
    const target = event.target.closest("[data-remove-upload]");
    if (!target) return;
    state.uploads = state.uploads.filter((item) => item.id !== target.dataset.removeUpload);
    renderUploadedDataList();
  });
  nodes.inlineRunButton?.addEventListener("click", () => nodes.form.requestSubmit());
  $$("[data-file-trigger]").forEach((button) =>
    button.addEventListener("click", (event) => {
      event.preventDefault();
      nodes.fileInput?.click();
    }),
  );
}

function onSubmit(event) {
  event.preventDefault();
  const cfg = readForm();
  if (!cfg.problem || !cfg.apiKey || !cfg.baseUrl) return;
  if (state.stage === RUN_STAGES.DATA && state.plan.length) runAgents(cfg);
  else runArchitect(cfg);
}

async function runArchitect(cfg) {
  state.stage = RUN_STAGES.PLAN;
  state.plan = [];
  state.inputs = [];
  state.uploads = [];
  state.config = { ...cfg };
  toggleInlineRunButton(false);
  resetDataSection();
  nodes.agentContainer.innerHTML = "";
  resetFlowDiagram();
  restoreDataSectionPosition();
  setRunningState(true, "Planning");
  setDataStatus("Generating architect plan...");

  const architectCard = createAgentCard("Architect", "Generates the execution order", "Plan");
  nodes.agentContainer.appendChild(architectCard.wrapper);
  activateCard(architectCard, "Planning");
  const planNode = addFlowNode("Architect Plan");
  let planText = "";
  await streamOpenAI({
    ...cfg,
    messages: [
      { role: "system", content: ARCHITECT_PROMPT },
      { role: "user", content: cfg.problem },
    ],
    onChunk: (txt) => {
      planText += txt;
      architectCard.output.textContent = planText;
      bumpProgress(planNode, 6);
    },
  });
  const parsed = parsePlanResponse(planText, cfg.problem);
  state.plan = parsed.plan;
  state.inputs = parsed.inputs;
  renderPlanSummary(architectCard, state.plan, planText);
  setFlowConfidence(planNode, randomConfidence());
  finishFlowNode(planNode);
  deactivateCard(architectCard, "Done");

  renderInputCards(state.inputs);
  placeDataSectionAfter(architectCard.wrapper);
  highlightDataSection(true);
  setDataStatus("Select or add at least one data source, then press Start Agents.");
  toggleInlineRunButton(true);
  setRunLabel("Start Agents");
  state.stage = RUN_STAGES.DATA;
  setRunningState(false);
}

async function runAgents(cfg) {
  const dataEntries = collectDataEntries();
  if (!dataEntries.length) {
    highlightDataSection(true);
    return;
  }
  const execCfg = {
    ...(state.config || {}),
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
  };
  execCfg.problem = execCfg.problem || cfg.problem;
  state.stage = RUN_STAGES.RUN;
  toggleInlineRunButton(false);
  highlightDataSection(false);
  setRunningState(true, "Running");

  await runAgentStage(execCfg, state.plan, dataEntries);
  finishRunState();
}

async function runAgentStage(cfg, plan, dataEntries) {
  const dataContext = formatDataEntries(dataEntries);
  let context = dataContext;
  const transcript = [];
  for (let index = 0; index < plan.length; index += 1) {
    const agent = plan[index];
    const card = createAgentCard(agent.agentName || `Agent ${index + 1}`, agent.systemInstruction || "", `Step ${index + 1}`);
    nodes.agentContainer.appendChild(card.wrapper);
    activateCard(card);
    const validating = /validate|compliance|checker|verification|risk|quality|anomaly|audit/i.test(`${agent.agentName} ${agent.systemInstruction}`);
    const node = addFlowNode(card.title, validating ? "validation" : "process");
    let output = "";
    await streamOpenAI({
      ...cfg,
      messages: [
        {
          role: "system",
          content: `${(agent.systemInstruction || "Deliver the next actionable step.").trim()}. Answer in <=50 words using short bullet sentences.`,
        },
        {
          role: "user",
          content: `Problem:\n${cfg.problem}\n\nInput Data:\n${dataContext}\n\nTask:\n${
            agent.initialTask || "Next step."
          }\n\nPrevious Output:\n${truncate(context, 600)}\n`,
        },
      ],
      onChunk: (txt) => {
        output += txt;
        card.output.textContent = output;
        bumpProgress(node, 7);
      },
    });
    context = output.trim() || context;
    transcript.push({ name: agent.agentName || `Agent ${index + 1}`, text: context });
    const confidence = randomConfidence(validating ? 0.65 : 0.75);
    setFlowConfidence(node, confidence);
    if (validating && confidence < 0.8) showFlowLoop(node);
    finishFlowNode(node);
    deactivateCard(card, "Done");
  }

  const summaryCard = createAgentCard("Conclusion", "Summarizes the chain", "Summary");
  nodes.agentContainer.appendChild(summaryCard.wrapper);
  activateCard(summaryCard, "Synthesizing");
  const summaryNode = addFlowNode("Final Deliverable");
  let finalText = "";
  await streamOpenAI({
    ...cfg,
    messages: [
      { role: "system", content: "Summarize in <=120 words and include 2 follow-up recommendations." },
      { role: "user", content: buildSummaryPrompt(cfg.problem, transcript, dataEntries) },
    ],
    onChunk: (txt) => {
      finalText += txt;
      summaryCard.output.textContent = finalText;
      bumpProgress(summaryNode, 10);
    },
  });
  setFlowConfidence(summaryNode, randomConfidence());
  finishFlowNode(summaryNode);
  deactivateCard(summaryCard, "Done");
}

function finishRunState() {
  state.stage = RUN_STAGES.IDLE;
  toggleInlineRunButton(false);
  setRunLabel(RUN_LABEL);
  setRunningState(false);
  setDataStatus("Run completed. Rerun the architect for a new plan or adjust data and rerun.");
}

function resetUI() {
  state.stage = RUN_STAGES.IDLE;
  state.plan = [];
  state.inputs = [];
  state.uploads = [];
  state.config = null;
  setPlaceholder();
  resetFlowDiagram();
  resetDataSection();
  setDataStatus("Run the architect to generate suggested data.");
  toggleInlineRunButton(false);
  setRunLabel(RUN_LABEL);
  setRunningState(false);
}

function readForm() {
  return {
    apiKey: nodes.form["api-key"].value.trim(),
    model: $("#model").value.trim() || "gpt-5-mini",
    baseUrl: trimUrl($("#base-url").value.trim()) || DEFAULT_BASE_URL,
    problem: $("#problem").value.trim(),
  };
}

function renderInputCards(list) {
  if (!nodes.dummyGrid) return;
  nodes.dummyGrid.innerHTML = "";
  if (!list.length) {
    nodes.dummyGrid.classList.add("visually-hidden");
    return;
  }
  list.forEach((item) => {
    const col = document.createElement("div");
    col.className = "col";
    const card = document.createElement("div");
    card.className = "dummy-data-card h-100";
    card.dataset.inputId = item.id;
    card.innerHTML = `
      <div class="d-flex justify-content-between align-items-center mb-2">
        <span class="fw-semibold">${item.title}</span>
        <span class="badge bg-secondary text-uppercase">${item.type.toUpperCase()}</span>
      </div>
      <pre class="small mb-0">${truncate(item.content, 280)}</pre>
      <p class="small text-body-secondary mb-0 mt-2">Click to toggle selection.</p>`;
    col.appendChild(card);
    nodes.dummyGrid.appendChild(col);
  });
  nodes.dummyGrid.classList.remove("visually-hidden");
}

function collectDataEntries() {
  const selected = nodes.dummyGrid
    ? Array.from(nodes.dummyGrid.querySelectorAll("[data-input-id].active")).map((card) => card.dataset.inputId)
    : [];
  const suggestions = state.inputs.filter((input) => selected.includes(input.id)).map((item) => ({ ...item, source: "suggested" }));
  const uploads = state.uploads.map((item) => ({ ...item, source: "upload" }));
  const entries = [...suggestions, ...uploads];
  if (nodes.dataNotes?.value.trim()) {
    entries.push({
      id: uniqueId("note"),
      title: "User Notes",
      type: "text",
      content: nodes.dataNotes.value.trim(),
      source: "notes",
    });
  }
  return entries;
}

function renderUploadedDataList() {
  if (!nodes.uploadedList) return;
  nodes.uploadedList.innerHTML = "";
  if (!state.uploads.length) {
    nodes.uploadedList.classList.add("d-none");
    return;
  }
  state.uploads.forEach((entry) => {
    const item = document.createElement("li");
    item.className = "list-group-item d-flex justify-content-between align-items-start";
    item.innerHTML = `
      <div>
        <div class="fw-semibold">${entry.title}</div>
        <div class="small text-body-secondary">${formatBytes(entry.meta?.size || 0)} - ${entry.type.toUpperCase()}</div>
      </div>
      <button type="button" class="btn btn-link btn-sm text-danger" data-remove-upload="${entry.id}">Remove</button>`;
    nodes.uploadedList.appendChild(item);
  });
  nodes.uploadedList.classList.remove("d-none");
}

function handleFiles(list) {
  const files = Array.from(list || []);
  files.forEach((file) => {
    const inferredType = inferTypeFromName(file.name);
    if (!ALLOWED_INPUT_TYPES.includes(inferredType)) return;
    const reader = new FileReader();
    reader.onload = () => {
      state.uploads.push({
        id: uniqueId("upload"),
        title: file.name,
        type: inferredType,
        content: reader.result ? reader.result.toString() : "",
        meta: { size: file.size },
      });
      renderUploadedDataList();
      setDataStatus("Files attached. Add notes or select suggested data.");
    };
    reader.readAsText(file);
  });
  if (nodes.fileInput) nodes.fileInput.value = "";
}

function inferTypeFromName(name = "") {
  const lower = name.toLowerCase();
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".txt")) return "text";
  return "file";
}

function sanitizeInputType(value) {
  const lower = (value || "").toString().trim().toLowerCase();
  return ALLOWED_INPUT_TYPES.includes(lower) ? lower : "text";
}

function formatDataEntries(entries) {
  if (!entries.length) return "User did not attach additional datasets.";
  return entries.map((entry, idx) => `${idx + 1}. ${entry.title} [${entry.type}]\n${truncate(entry.content, 500)}`).join("\n\n");
}

function parsePlanResponse(text, problem) {
  const parsed = safeParseJson(text);
  const plan = normalizePlan(parsed.plan);
  const inputs = normalizeInputs(parsed.inputs, problem);
  return { plan, inputs: inputs.length ? inputs : defaultInputs(problem) };
}

function normalizePlan(list) {
  if (!Array.isArray(list)) return fallbackPlan();
  const base = fallbackPlan();
  const normalized = list
    .filter((item) => item && typeof item === "object")
    .slice(0, MAX_AGENTS)
    .map((item, index) => ({
      agentName: (item.agentName || `Agent ${index + 1}`).trim(),
      systemInstruction: (item.systemInstruction || "Deliver the next actionable step.").trim(),
      initialTask: (item.initialTask || item.systemInstruction || "Next step.").trim(),
    }));
  while (normalized.length < MIN_AGENTS) normalized.push(base[normalized.length % base.length]);
  return normalized;
}

function normalizeInputs(list, problem) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && typeof item === "object")
    .slice(0, 3)
    .map((item, index) => ({
      id: uniqueId("input"),
      title: (item.title || `Input ${index + 1}`).trim(),
      type: sanitizeInputType(item.type),
      content: (item.sample || item.example || item.content || truncate(problem, 200) || "Provide context.").trim(),
    }));
}

function fallbackPlan() {
  return [
    { agentName: "Planner", systemInstruction: "Outline the next actionable step.", initialTask: "Outline the next step." },
    { agentName: "Validator", systemInstruction: "Validate previous output.", initialTask: "Validate and adjust previous result." },
  ];
}

function defaultInputs(problem) {
  return [
    { id: uniqueId("input"), title: "Problem Brief", type: "text", content: truncate(problem, 280) || "Summarize the request." },
    { id: uniqueId("input"), title: "Sample Metrics", type: "csv", content: "metric,value\nMetric A,0\nMetric B,0\nMetric C,0" },
    { id: uniqueId("input"), title: "Notes", type: "text", content: "- Constraint: TBD\n- Stakeholders: TBD\n- Risk: TBD" },
  ];
}

function streamOpenAI({ apiKey, baseUrl, model, messages, onChunk }) {
  return fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, stream: true }),
  }).then((response) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    function read() {
      return reader.read().then(({ done, value }) => {
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        parts.forEach((part) => {
          if (!part.startsWith("data:")) return;
          const data = part.slice(5).trim();
          if (data === "[DONE]") return;
          const json = safeParseJson(data);
          const text = json.choices?.[0]?.delta?.content;
          if (text) onChunk(text);
        });
        return read();
      });
    }
    return read();
  });
}

function createAgentCard(title, subtitle, badge) {
  const wrapper = document.createElement("section");
  wrapper.className = "agent-card card shadow-sm";
  wrapper.innerHTML = `
    <div class="card-body row g-3 align-items-stretch">
      <div class="col-md-4 agent-summary">
        <p class="text-uppercase small text-body-secondary mb-1">${badge}</p>
        <h6 class="mb-2">${title}</h6>
        <p class="text-body-secondary small mb-3">${subtitle}</p>
        <span class="badge bg-secondary" data-status>Queued</span>
      </div>
      <div class="col-md-8">
        <pre class="agent-stream border rounded-3 p-3 mb-0 bg-black text-white"></pre>
      </div>
    </div>`;
  return { wrapper, output: wrapper.querySelector("pre"), status: wrapper.querySelector("[data-status]"), title };
}

function addFlowNode(label, mode = "process") {
  const placeholder = nodes.flowNodes.querySelector("[data-placeholder]");
  if (placeholder) placeholder.remove();
  const wrapper = document.createElement("div");
  wrapper.className = "flow-node";
  wrapper.classList.add(mode === "validation" ? "state-validation" : "state-processing");
  wrapper.innerHTML = `
    <div class="fw-semibold">${label}</div>
    <div class="text-body-secondary small mb-2">${mode === "validation" ? "Validation" : "Processing"}</div>
    <div class="progress mb-2"><div class="progress-bar bg-primary" style="width:0%"></div></div>
    <div class="small text-body-secondary">Confidence: <span data-confidence>--</span></div>
    <div class="text-warning small mt-1 d-none" data-loop>Validation loop</div>`;
  nodes.flowNodes.appendChild(wrapper);
  return {
    wrapper,
    progressBar: wrapper.querySelector(".progress-bar"),
    confidence: wrapper.querySelector("[data-confidence]"),
    loop: wrapper.querySelector("[data-loop]"),
  };
}

function activateCard(card, label = "Running") {
  card.status.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>${label}`;
  card.status.classList.remove("bg-secondary", "bg-success");
  card.status.classList.add("bg-primary");
  card.wrapper.scrollIntoView({ behavior: "smooth", block: "center" });
}

function deactivateCard(card, label) {
  card.status.textContent = label;
  card.status.classList.remove("bg-primary");
  card.status.classList.add("bg-success");
}

function renderPlanSummary(card, plan, rawText) {
  const lines = plan.map(
    (agent, idx) => `${idx + 1}. ${(agent.agentName || `Agent ${idx + 1}`).trim()}: ${agent.initialTask || agent.systemInstruction || "Next action"}`,
  );
  const summary = `Execution Order:\n${lines.join("\n")}`;
  card.output.textContent = rawText ? `${summary}\n\nRaw Plan:\n${rawText}` : summary;
}

function setPlaceholder() {
  nodes.agentContainer.innerHTML = PLACEHOLDER;
}

function resetFlowDiagram() {
  nodes.flowNodes.innerHTML = "";
  const note = document.createElement("div");
  note.className = "text-body-secondary small";
  note.dataset.placeholder = "true";
  note.textContent = "Nodes will appear here as agents execute. Colors: blue=processing, yellow=validation, red=error, green=verified.";
  nodes.flowNodes.appendChild(note);
}

function setFlowConfidence(node, value) {
  node.progressBar.style.width = "100%";
  node.confidence.textContent = value.toFixed(2);
}

function bumpProgress(node, delta) {
  const current = parseFloat(node.progressBar.style.width) || 0;
  node.progressBar.style.width = `${Math.min(95, current + delta)}%`;
}

function finishFlowNode(node) {
  node.wrapper.classList.remove("state-processing", "state-validation", "state-error");
  node.wrapper.classList.add("state-success");
}

function showFlowLoop(node) {
  node.loop.classList.remove("d-none");
}

function setRunningState(isRunning, label = "Running") {
  if (!nodes.runButton) return;
  if (isRunning) {
    nodes.runButton.disabled = true;
    nodes.runButton.innerHTML = `<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>${label}`;
  } else {
    nodes.runButton.disabled = false;
    nodes.runButton.innerHTML = currentRunLabel;
  }
}

function setRunLabel(text) {
  if (!nodes.runButton) return;
  currentRunLabel = text;
  nodes.runButton.innerHTML = text;
  nodes.runButton.disabled = false;
}

function setDataStatus(text) {
  if (nodes.dataStatus) nodes.dataStatus.textContent = text;
}

function placeDataSectionAfter(element) {
  if (!nodes.dataSection || !element) return;
  element.insertAdjacentElement("afterend", nodes.dataSection);
  nodes.dataSection.classList.remove("d-none");
}

function restoreDataSectionPosition() {
  if (!nodes.dataSection || !dataSectionHome.parent) return;
  if (dataSectionHome.next && dataSectionHome.next.parentNode === dataSectionHome.parent) {
    dataSectionHome.parent.insertBefore(nodes.dataSection, dataSectionHome.next);
  } else {
    dataSectionHome.parent.appendChild(nodes.dataSection);
  }
  nodes.dataSection.classList.add("d-none");
  nodes.dataSection.classList.remove("data-section-highlight");
}

function highlightDataSection(active) {
  if (!nodes.dataSection) return;
  if (active) nodes.dataSection.classList.remove("d-none");
  nodes.dataSection.classList[active ? "add" : "remove"]("data-section-highlight");
  if (active) nodes.dataSection.scrollIntoView({ behavior: "smooth", block: "center" });
}

function toggleInlineRunButton(visible) {
  if (!nodes.inlineRunButton) return;
  nodes.inlineRunButton.classList[visible ? "remove" : "add"]("d-none");
  nodes.inlineRunButton.disabled = !visible;
}

function resetDataSection() {
  renderInputCards([]);
  renderUploadedDataList();
  if (nodes.dataNotes) nodes.dataNotes.value = "";
  restoreDataSectionPosition();
}

function truncate(text, max) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function trimUrl(url) {
  return url ? url.replace(/\/+$/, "") : "";
}

function randomConfidence(base = 0.7) {
  return Math.min(0.99, base + Math.random() * 0.25);
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = (bytes / 1024 ** exponent).toFixed(1);
  return `${value} ${units[exponent]}`;
}

function uniqueId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildSummaryPrompt(problem, steps, dataEntries) {
  const lines = steps.map((step, idx) => `${idx + 1}. ${step.name}: ${truncate(step.text, 200)}`).join("\n");
  return `Problem:\n${problem}\n\nInput Data:\n${formatDataEntries(dataEntries)}\n\nAgent Outputs:\n${lines}`;
}

function persistFields(ids) {
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const key = `orchestrator:${id}`;
    const stored = localStorage.getItem(key);
    if (stored && !el.value) el.value = stored;
    el.addEventListener("input", () => localStorage.setItem(key, el.value || ""));
  });
}

function loadProblems() {
  const container = document.getElementById("problem-cards");
  if (container) container.innerHTML = '<div class="text-body-secondary small">Loading starter problems...</div>';
  fetch("config.json")
    .then((res) => res.json())
    .then((data) => {
      const problems = Array.isArray(data.problems) ? data.problems : [];
      renderProblemCards(problems);
    });
}

function renderProblemCards(list) {
  const container = document.getElementById("problem-cards");
  if (!container) return;
  container.innerHTML = "";
  list.forEach((item) => {
    const col = document.createElement("div");
    col.className = "col";
    col.innerHTML = `
      <div class="card h-100 shadow-sm">
        <div class="card-body d-flex flex-column">
          <p class="text-uppercase small text-body-secondary mb-1">${item.tag}</p>
          <h5>${item.title}</h5>
          <p class="text-body-secondary small flex-grow-1 mb-3">${item.summary}</p>
          <button type="button" class="btn btn-outline-primary btn-sm mt-auto">Use problem</button>
        </div>
      </div>`;
    col.querySelector("button").addEventListener("click", () => {
      const textarea = $("#problem");
      textarea.value = item.problem;
      textarea.focus();
      textarea.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    container.appendChild(col);
  });
}

function safeParseJson(text) {
  try {
    return JSON.parse((text || "").trim() || "{}");
  } catch {
    return {};
  }
}
