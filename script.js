import { openaiConfig } from "bootstrap-llm-provider";
import saveform from "saveform";
import { createFlowchart } from "./flowchart.js";
import * as Utils from "./utils.js";
import * as View from "./view.js";

const $ = (s) => document.querySelector(s);
const DEFAULT_BASE_URLS = ["https://api.openai.com/v1", "https://llmfoundry.straivedemo.com/openai/v1"];

let config = {};
let state = {
  selectedDemoIndex: null, stage: "idle", plan: [], suggestedInputs: [], selectedInputs: new Set(),
  uploads: [], notes: "", agentOutputs: [], architectBuffer: "", error: "", customProblem: null,
  focusedNodeId: null, runningNodeIds: new Set(), latestNodeId: null,
  flowOrientation: "horizontal", flowColumns: 2
};

const llmSession = { creds: null };
const actions = {
  planDemo: (i) => { selectDemo(i); runArchitect(); },
  startAgents: () => startAgents(),
  toggleSuggestedInput: (id) => {
    const next = new Set(state.selectedInputs);
    next.has(id) ? next.delete(id) : next.add(id);
    setState({ selectedInputs: next });
  },
  handleFileUpload: (e) => {
    Array.from(e.target.files || []).forEach(file => {
      const reader = new FileReader();
      reader.onload = () => setState({ uploads: [...state.uploads, { id: Utils.uniqueId("upload"), title: file.name, type: Utils.inferTypeFromName(file.name), content: reader.result?.toString() || "", meta: { size: file.size } }] });
      reader.readAsText(file);
    });
    e.target.value = "";
  },
  removeUpload: (id) => setState({ uploads: state.uploads.filter(u => u.id !== id) }),
  setNotes: (val) => setState({ notes: val }),
  handleCustomProblemSubmit: (e) => {
    e.preventDefault();
    const val = $("#custom-problem")?.value?.trim();
    if (!val) return setState({ error: "Enter a problem first.", stage: "idle" }); // Fix focus later
    selectCustomProblem(val);
    runArchitect();
  }
};

// Initialization
(async () => {
  config = await fetch("config.json").then(r => r.json());
  config.demos = (config.demos || []).map(d => ({ ...d, inputs: (d.inputs || []).map(i => ({ ...i, id: Utils.uniqueId("input") })) }));

  const defaults = config.defaults || {};
  if ($("#model") && !$("#model").value) $("#model").value = defaults.model || "gpt-5-mini";
  if ($("#architect-prompt")) $("#architect-prompt").value = defaults.architectPrompt || "";

  setState({
    flowOrientation: Utils.normalizeFlowOrientation(defaults.flowOrientation),
    flowColumns: Utils.clampFlowColumns(defaults.flowColumns)
  });

  // Pre-fill settings form
  if ($("#model")) $("#model").value = defaults.model || "gpt-5-mini";
  if ($("#architect-prompt")) $("#architect-prompt").value = defaults.architectPrompt || "";
  if ($("#agent-style")) $("#agent-style").value = defaults.agentStyle || "";
  if ($("#max-agents")) $("#max-agents").value = defaults.maxAgents || 4;
  if ($("#flow-orientation")) $("#flow-orientation").value = Utils.normalizeFlowOrientation(defaults.flowOrientation);
  if ($("#flow-columns")) $("#flow-columns").value = Utils.clampFlowColumns(defaults.flowColumns);

  View.renderDemoCards($("#demo-cards"), config.demos, state.selectedDemoIndex, ["architect", "run"].includes(state.stage), actions.planDemo);
  render();

  // Event Listeners
  $("#configure-llm")?.addEventListener("click", async () => llmSession.creds = await openaiConfig({ defaultBaseUrls: DEFAULT_BASE_URLS, show: true }));
  $("#custom-problem-form")?.addEventListener("submit", actions.handleCustomProblemSubmit);

  const settingsForm = saveform("#settings-form");
  $("#settings-form")?.addEventListener("reset", () => setTimeout(() => {
    settingsForm.clear();
    const fd = new FormData($("#settings-form")); // re-read defaults if needed or just reset state
    // simpler to just call scheduleSync
    scheduleFlowchartSync();
  }, 0));

  const updateLayout = () => {
    const o = $("#flow-orientation")?.value, c = $("#flow-columns")?.value;
    if (o && c) setState({ flowOrientation: Utils.normalizeFlowOrientation(o), flowColumns: Utils.clampFlowColumns(c) });
  };
  $("#flow-orientation")?.addEventListener("change", updateLayout);
  $("#flow-columns")?.addEventListener("input", updateLayout);
})();

function setState(updates) {
  Object.assign(state, updates);
  render();
}

function render() {
  View.renderDemoCards($("#demo-cards"), config.demos, state.selectedDemoIndex, ["architect", "run"].includes(state.stage), actions.planDemo);
  View.renderApp($("#output"), state, config, actions);
  syncCustomButton();
  scheduleFlowchartSync();
  scheduleScrollToRunningSection();
}

// Logic
function selectDemo(index) {
  const demo = config.demos[index];
  const inputs = (demo?.inputs || []).map(i => ({ ...i, id: Utils.uniqueId("input") }));
  resetRunState({ selectedDemoIndex: index, suggestedInputs: inputs, selectedInputs: new Set(inputs.map(i => i.id)) });
}

function selectCustomProblem(problem) {
  resetRunState({ selectedDemoIndex: -1, customProblem: { title: "Custom", body: "User Brief", problem, inputs: [] } });
}

function resetRunState(extras) {
  setState({ ...extras, stage: "architect", plan: [], agentOutputs: [], architectBuffer: "", error: "", focusedNodeId: null, runningNodeIds: new Set(), latestNodeId: null });
}

async function runArchitect() {
  try {
    const creds = await ensureCreds();
    const demo = state.selectedDemoIndex === -1 ? state.customProblem : config.demos[state.selectedDemoIndex];
    const model = $("#model")?.value || "gpt-5-mini";
    const maxAgents = Math.min(Math.max(parseInt($("#max-agents")?.value || 5), 2), 6);

    setState({ stage: "architect", plan: [], architectBuffer: "" });
    let buffer = "";

    await Utils.streamChatCompletion({
      llm: creds,
      body: { model, stream: true, messages: [{ role: "system", content: `${$("#architect-prompt")?.value}\nLimit to <= ${maxAgents} agents.` }, { role: "user", content: demo.problem }] },
      onChunk: (text) => { buffer += text; setState({ architectBuffer: buffer }); }
    });

    const parsed = Utils.safeParseJson(buffer);
    setState({
      plan: Utils.normalizePlan(parsed.plan, maxAgents),
      suggestedInputs: Utils.normalizeInputs(parsed.inputs, demo),
      stage: "data"
    });
    // Auto-select inputs
    setState({ selectedInputs: new Set(state.suggestedInputs.map(i => i.id)) });

  } catch (e) { setState({ error: e.message, stage: "idle" }); }
}

async function startAgents() {
  const entries = [...state.suggestedInputs.filter(i => state.selectedInputs.has(i.id)), ...state.uploads];
  if (state.notes?.trim()) entries.push({ title: "User Notes", type: "text", content: state.notes });
  if (!entries.length) return setState({ error: "No data." });

  try {
    const creds = await ensureCreds();
    const model = $("#model")?.value || "gpt-5-mini";
    const agentStyle = $("#agent-style")?.value || "";
    const inputBlob = Utils.formatDataEntries(entries);

    setState({ stage: "run", agentOutputs: [], error: "", runningNodeIds: new Set(), latestNodeId: null });

    // Group by phase
    const phases = new Map();
    state.plan.forEach(a => { const p = a.phase ?? 0; if (!phases.has(p)) phases.set(p, []); phases.get(p).push(a); });
    const sortedPhases = [...phases.keys()].sort((a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : String(a).localeCompare(String(b)));

    let context = inputBlob;
    for (const phase of sortedPhases) {
      const agents = phases.get(phase);
      const outputs = agents.map(a => ({ id: Utils.uniqueId("out"), nodeId: a.nodeId, phase, name: a.agentName, task: a.initialTask, instruction: a.systemInstruction, text: "", status: "running" }));

      setState({ agentOutputs: [...state.agentOutputs, ...outputs], runningNodeIds: new Set([...state.runningNodeIds, ...outputs.map(o => o.nodeId)]), latestNodeId: outputs[0]?.nodeId });

      const results = await Promise.all(outputs.map(out => (async () => {
        let buffer = "";
        try {
          await Utils.streamChatCompletion({
            llm: creds,
            body: {
              model, stream: true, messages: [
                { role: "system", content: `${out.instruction}\n${agentStyle}\nOutput Markdown. Keep response under 150 words.` },
                { role: "user", content: `Problem:\n${state.selectedDemoIndex === -1 ? state.customProblem.problem : config.demos[state.selectedDemoIndex].problem}\n\nTask:\n${out.task}\n\nInput:\n${inputBlob}\n\nContext:\n${Utils.truncate(context, 1200)}` }
              ]
            },
            onChunk: (t) => { buffer += t; updateAgent(out.id, buffer, "running"); }
          });
          updateAgent(out.id, buffer, "done");
          return buffer;
        } catch (e) { updateAgent(out.id, buffer || e.message, "error"); return ""; }
        finally {
          const run = new Set(state.runningNodeIds); run.delete(out.nodeId); setState({ runningNodeIds: run });
        }
      })()));
      context += `\n\n--- Stage ${phase} ---\n${results.map((r, i) => `Output ${agents[i].agentName}:\n${r}`).join("\n")}`;
    }
    setState({ stage: "idle" });

  } catch (e) { setState({ error: e.message, stage: "idle" }); }
}

function updateAgent(id, text, status) {
  const outputs = state.agentOutputs.map(o => o.id === id ? { ...o, text, status } : o);
  setState({ agentOutputs: outputs });
}

async function ensureCreds() {
  if (!llmSession.creds) llmSession.creds = await openaiConfig({ defaultBaseUrls: DEFAULT_BASE_URLS });
  if (!llmSession.creds?.apiKey) throw new Error("No API Key.");
  return llmSession.creds;
}

function syncCustomButton() {
  const btn = $("#run-custom-problem");
  if (btn) { btn.disabled = ["architect", "run"].includes(state.stage); btn.textContent = btn.disabled ? "Streaming..." : "Plan & Run Custom"; }
}

// Queue scrolling
let scrollSched = false;
let scrollState = { key: null, height: 0 };

function scheduleScrollToRunningSection() {
  if (scrollSched) return;
  scrollSched = true;
  requestAnimationFrame(() => {
    scrollSched = false;
    const key = getRunningScrollKey();
    if (!key) {
      scrollState = { key: null, height: 0 };
      return;
    }

    const target = document.querySelector(`[data-running-key="${key}"]`);
    if (!target) return;

    // Force scroll if the key changed implies we moved to a new step
    const keyChanged = scrollState.key !== key;

    if (keyChanged) {
      // Scroll to the new active element immediately
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      // If same key, only scroll if it's pushed off screen bottom (content growing)
      const rect = target.getBoundingClientRect();
      const viewHeight = window.innerHeight || document.documentElement.clientHeight;
      if (rect.bottom > viewHeight) {
        target.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
    scrollState = { key, height: target.scrollHeight };
  });
}

function getRunningScrollKey() {
  if (state.stage === "architect") return "architect-plan";
  if (state.stage === "data") return "data-inputs";

  // Prioritize focused node if user clicked one
  if (state.focusedNodeId) return `node-${state.focusedNodeId}`;

  // Otherwise follow the latest or running node
  if (state.stage === "run" || state.stage === "idle") {
    // If we have a latest active node (from streaming), use that
    if (state.latestNodeId) return `node-${state.latestNodeId}`;

    // Fallback to the last output in the list
    const lastOutput = state.agentOutputs[state.agentOutputs.length - 1];
    if (lastOutput) return `node-${lastOutput.nodeId}`;
  }
  return null;
}

// Flowchart
let fcCtrl, fcKey = "", fcSched = false;
function scheduleFlowchartSync() {
  if (fcSched) return;
  fcSched = true;
  requestAnimationFrame(() => { fcSched = false; syncFlowchart(); });
}

function syncFlowchart() {
  const canvas = $("#flowchart-canvas");
  const graph = Utils.buildGraphFromPlan(state.plan);
  if (!canvas || !graph.nodes.length) { fcCtrl?.destroy(); fcCtrl = null; return; }

  if (!fcCtrl || fcCtrl.container !== canvas) {
    fcCtrl?.destroy();
    fcCtrl = createFlowchart(canvas, [], { orientation: state.flowOrientation, columnCount: state.flowColumns, onNodeSelected: (id) => setState({ focusedNodeId: id }) });
    fcKey = "";
  } else {
    fcCtrl.setOrientation(state.flowOrientation);
    fcCtrl.setColumns(state.flowColumns);
  }

  const elements = [...graph.nodes.map(n => ({ data: { id: n.id, label: n.label } })), ...graph.edges.map(e => ({ data: { source: e.source, target: e.target } }))];
  const sig = JSON.stringify(elements.map(e => e.data));
  if (sig !== fcKey) { fcCtrl.setElements(elements); fcKey = sig; }

  fcCtrl.setNodeState({
    activeIds: [...state.runningNodeIds],
    completedIds: state.agentOutputs.filter(o => o.status === "done").map(o => o.nodeId),
    failedIds: state.agentOutputs.filter(o => o.status === "error").map(o => o.nodeId),
    selectedId: state.focusedNodeId
  });
  fcCtrl.resize();
}

window.addEventListener("resize", () => scheduleFlowchartSync());
