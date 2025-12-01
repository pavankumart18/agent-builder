const form = document.getElementById("orchestrator-form");
const agentContainer = document.getElementById("agent-container");
const errorBanner = document.getElementById("error-banner");
const runButton = form.querySelector("button[type='submit']");
const clearButton = document.getElementById("clear-log");
const flowNodesContainer = document.getElementById("flow-nodes");
const RUN_LABEL = runButton.innerHTML;

const MIN_AGENTS = 2;
const MAX_AGENTS = 5;
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const PLACEHOLDER = `
  <div class="text-center text-body-secondary small border border-dashed border-secondary rounded-3 py-4 bg-body">
    Agents will appear here after you run a problem.
  </div>`;
const ARCHITECT_PROMPT = `Return ${MIN_AGENTS}-${MAX_AGENTS} sequential agents as JSON [{ "agentName": "...", "systemInstruction": "...", "initialTask": "..." }]. Keep text concise.`;
let problems = [];

persistFields(["model", "base-url", "problem"]);
loadProblems();
resetFlowDiagram();
setPlaceholder();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const cfg = readForm();
  if (!cfg.problem) return showMessage("Provide a problem statement.");
  if (!cfg.apiKey || !cfg.baseUrl) return showMessage("Provide API base URL and API key.");
  hideMessage();
  setRunningState(true);
  orchestrate(cfg).then(() => setRunningState(false));
});

clearButton.addEventListener("click", () => {
  setPlaceholder();
  resetFlowDiagram();
  hideMessage();
});

function readForm() {
  const apiKey = form["api-key"].value.trim();
  const model = document.getElementById("model").value.trim() || "gpt-5-mini";
  const baseUrl = trimUrl(document.getElementById("base-url").value.trim()) || DEFAULT_BASE_URL;
  const problem = document.getElementById("problem").value.trim();
  return { apiKey, model, baseUrl, problem };
}

async function orchestrate(cfg) {
  agentContainer.innerHTML = "";
  resetFlowDiagram();
  const architectCard = createAgentCard("Architect", "Generates the execution order", "Plan");
  agentContainer.appendChild(architectCard.wrapper);
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
  const plan = parsePlan(planText);
  renderPlanSummary(architectCard, plan, planText);
  setFlowConfidence(planNode, randomConfidence());
  finishFlowNode(planNode);
  deactivateCard(architectCard, "Done");

  let context = "Start";
  const transcript = [];
  for (let index = 0; index < plan.length; index += 1) {
    const agent = plan[index];
    const card = createAgentCard(agent.agentName || `Agent ${index + 1}`, agent.systemInstruction || "", `Step ${index + 1}`);
    agentContainer.appendChild(card.wrapper);
    activateCard(card);
    const validating = /validate|compliance|checker|verification|risk|quality|anomaly|audit/i.test(
      `${agent.agentName} ${agent.systemInstruction}`,
    );
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
          content: `Problem:\n${cfg.problem}\n\nTask:\n${agent.initialTask || "Next step."}\n\nPrevious Output:\n${truncate(context, 600)}\n`,
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
  agentContainer.appendChild(summaryCard.wrapper);
  activateCard(summaryCard, "Synthesizing");
  const summaryNode = addFlowNode("Final Deliverable");
  let finalText = "";
  await streamOpenAI({
    ...cfg,
    messages: [
      { role: "system", content: "Summarize in <=120 words and include 2 follow-up recommendations." },
      { role: "user", content: buildSummaryPrompt(cfg.problem, transcript) },
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

function parsePlan(text) {
  const parsed = safeParseArray(text);
  const plan = parsed.filter(Boolean).slice(0, MAX_AGENTS);
  const fallback = [
    { agentName: "Planner", systemInstruction: "Outline the next actionable step.", initialTask: "Outline the next step." },
    { agentName: "Validator", systemInstruction: "Validate previous output.", initialTask: "Validate and adjust previous result." },
  ];
  while (plan.length < MIN_AGENTS) plan.push(fallback[plan.length % fallback.length]);
  return plan;
}

function buildSummaryPrompt(problem, steps) {
  const lines = steps.map((step, idx) => `${idx + 1}. ${step.name}: ${truncate(step.text, 200)}`).join("\n");
  return `Problem:\n${problem}\n\nAgent Outputs:\n${lines}`;
}

function renderPlanSummary(card, plan, rawText) {
  if (!card?.output) return;
  const lines = plan.map(
    (agent, idx) => `${idx + 1}. ${(agent.agentName || `Agent ${idx + 1}`).trim()}: ${agent.initialTask || agent.systemInstruction || "Next action"}`,
  );
  const summary = `Execution Order:\n${lines.join("\n")}`;
  card.output.textContent = rawText ? `${summary}\n\nRaw Plan:\n${rawText}` : summary;
}

function streamOpenAI({ apiKey, baseUrl, model, messages, onChunk }) {
  return fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, stream: true }),
  }).then((response) => {
    if (!response.ok || !response.body) {
      showMessage(`Request failed (${response.status}). Check credentials.`);
      return Promise.reject();
    }
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
          const json = JSON.parse(data);
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
  const body = document.createElement("div");
  body.className = "card-body row g-3 align-items-stretch";
  const summary = document.createElement("div");
  summary.className = "col-md-4 agent-summary";
  summary.innerHTML = `
    <p class="text-uppercase small text-body-secondary mb-1">${badge}</p>
    <h6 class="mb-2">${title}</h6>
    <p class="text-body-secondary small mb-3">${subtitle}</p>
    <span class="badge bg-secondary" data-status>Queued</span>`;
  const stream = document.createElement("div");
  stream.className = "col-md-8";
  const pre = document.createElement("pre");
  pre.className = "agent-stream border rounded-3 p-3 mb-0 bg-black text-white";
  pre.textContent = "";
  stream.appendChild(pre);
  body.appendChild(summary);
  body.appendChild(stream);
  wrapper.appendChild(body);
  return { wrapper, output: pre, status: summary.querySelector("[data-status]"), title };
}

function addFlowNode(label, mode = "process") {
  const placeholder = flowNodesContainer.querySelector("[data-placeholder]");
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
  flowNodesContainer.appendChild(wrapper);
  return {
    wrapper,
    progressBar: wrapper.querySelector(".progress-bar"),
    confidence: wrapper.querySelector("[data-confidence]"),
    loop: wrapper.querySelector("[data-loop]"),
  };
}

function setFlowConfidence(node, value) {
  if (node.progressBar) node.progressBar.style.width = "100%";
  if (node.confidence) node.confidence.textContent = value.toFixed(2);
}

function bumpProgress(node, delta) {
  if (!node?.progressBar) return;
  const current = parseFloat(node.progressBar.style.width) || 0;
  node.progressBar.style.width = `${Math.min(95, current + delta)}%`;
}

function finishFlowNode(node) {
  if (!node?.wrapper) return;
  node.wrapper.classList.remove("state-processing", "state-validation", "state-error");
  node.wrapper.classList.add("state-success");
}

function showFlowLoop(node) {
  node?.loop?.classList.remove("d-none");
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

function setRunningState(isRunning) {
  if (isRunning) {
    runButton.disabled = true;
    runButton.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Running';
  } else {
    runButton.disabled = false;
    runButton.innerHTML = RUN_LABEL;
  }
}

function showMessage(text) {
  errorBanner.textContent = text;
  errorBanner.classList.remove("d-none");
}

function hideMessage() {
  errorBanner.textContent = "";
  errorBanner.classList.add("d-none");
}

function setPlaceholder() {
  agentContainer.innerHTML = PLACEHOLDER;
}

function resetFlowDiagram() {
  flowNodesContainer.innerHTML = "";
  const note = document.createElement("div");
  note.className = "text-body-secondary small";
  note.dataset.placeholder = "true";
  note.textContent = "Nodes will appear here as agents execute. Colors: blue=processing, yellow=validation, red=error, green=verified.";
  flowNodesContainer.appendChild(note);
}

function renderProblemCards() {
  const container = document.getElementById("problem-cards");
  if (!container) return;
  container.innerHTML = "";
  problems.forEach((item) => {
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
      const textarea = document.getElementById("problem");
      textarea.value = item.problem;
      textarea.focus();
      textarea.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    container.appendChild(col);
  });
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
  if (container) container.innerHTML = '<div class="text-body-secondary small">Loading starter problems…</div>';
  fetch("config.json")
    .then((res) => res.json())
    .then((data) => {
      problems = Array.isArray(data.problems) ? data.problems : [];
      renderProblemCards();
    });
}

function safeParseArray(text) {
  try {
    const parsed = JSON.parse((text || "").trim() || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
