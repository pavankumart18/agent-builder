import { openaiConfig } from "bootstrap-llm-provider";
import saveform from "saveform";
import { createFlowchart } from "./flowchart.js";
import * as Utils from "./utils.js";
import * as View from "./view.js";
import { Storage } from "./storage.js";

const $ = (s) => document.querySelector(s);
const DEFAULT_BASE_URLS = ["https://api.openai.com/v1", "https://llmfoundry.straivedemo.com/openai/v1"];

let config = {};
let state = {
  selectedDemoIndex: null, stage: "idle", plan: [], suggestedInputs: [], selectedInputs: new Set(),
  uploads: [], notes: "", agentOutputs: [], architectBuffer: "", error: "", customProblem: null,
  focusedNodeId: null, runningNodeIds: new Set(), latestNodeId: null,
  flowOrientation: "horizontal", flowColumns: 2,
  focusedNodeId: null, runningNodeIds: new Set(), latestNodeId: null,
  flowOrientation: "horizontal", flowColumns: 2,
  savedAgents: [], supabaseConfigured: false, session: null,
  editingAgentId: null
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
  },
  // Supabase Actions
  configureSupabase: async () => {
    // If config is missing, prompt user to edit config.json for persistence, or use prompt for temp session
    const choice = confirm("To configure Supabase permanently, add your URL and Key to 'config.json'.\n\nClick OK to reload config from file (if you edited it).\nClick Cancel to enter credentials temporarily for this session.");

    if (choice) {
      // Reload config
      try {
        const newConfig = await fetch("config.json").then(r => r.json());
        const url = newConfig.supabase?.url;
        const key = newConfig.supabase?.key;
        if (url && key) {
          const ok = await Storage.init(url, key);
          setState({ supabaseConfigured: ok, session: Storage.getSession() });
          if (ok) refreshAgents();
          alert(ok ? "Supabase connected from config.json!" : "Connection failed even with config.");
        } else {
          alert("No credentials found in config.json. Please edit the file.");
        }
      } catch (e) { alert("Error reloading config: " + e.message); }
    } else {
      const url = prompt("Enter Supabase Project URL (e.g., https://xyz.supabase.co):");
      const key = prompt("Enter Supabase PUBLIC ANON Key:\n(Note: This key is safe to use in the browser as long as your database has RLS enabled. Do NOT use the Service Role key.)");
      if (url && key) {
        localStorage.setItem("supabase_url", url);
        localStorage.setItem("supabase_key", key);
        const ok = await Storage.init(url, key);
        setState({ supabaseConfigured: ok, session: Storage.getSession() });
        if (ok) refreshAgents();
      }
    }
  },
  login: async () => {
    try { await Storage.login(); } catch (e) { alert(e.message); }
  },
  logout: async () => {
    await Storage.logout();
    setState({ session: null, savedAgents: [] });
  },
  saveAgent: async () => {
    // If editing, try to find existing title
    const existingTitle = state.editingAgentId
      ? state.savedAgents.find(a => a.id === state.editingAgentId)?.title
      : "";

    const title = prompt("Name your agent:", existingTitle || "My Custom Agent");
    if (!title) return;
    try {
      const inputsToSave = state.suggestedInputs.filter(i => state.selectedInputs.has(i.id));
      const agent = {
        id: state.editingAgentId || crypto.randomUUID(),
        title,
        problem: state.selectedDemoIndex === -1 ? state.customProblem?.problem : config.demos[state.selectedDemoIndex]?.problem,
        plan: state.plan,
        inputs: inputsToSave
      };
      await Storage.saveAgent(agent);
      refreshAgents();
      // Keep edit ID so subsequent saves update the same agent, or clear? 
      // User might want to version. But typically "Save" means save this.
      // Let's keep it.
      setState({ editingAgentId: agent.id });
      alert("Agent saved!");
    } catch (e) { alert("Save failed: " + e.message); }
  },
  deleteAgent: async (id) => {
    if (!confirm("Delete this agent?")) return;
    try {
      await Storage.deleteAgent(id);
      refreshAgents();
    } catch (e) { alert("Delete failed: " + e.message); }
  },
  loadSavedAgent: (agent) => {
    // Directly go to data/run stage, skipping architect
    // User requirement: "these saved agents should not again call plan or architect"
    // We load them into the state as if they were just planned.
    setState({
      selectedDemoIndex: -2, // Special index for saved agent
      customProblem: { title: agent.title, problem: agent.problem },
      plan: agent.plan,
      suggestedInputs: agent.inputs || [],
      selectedInputs: new Set((agent.inputs || []).map(i => i.id)),
      stage: "data", // Ready to start inputs or run
      agentOutputs: [],
      error: "",
      editingAgentId: null // Clear separate edit session
    });
  },
  editAgent: (agent) => {
    // Populate custom problem and enter edit mode
    $("#custom-problem").value = agent.problem;

    // Reset to idle so we don't auto-scroll to 'data' or 'run' via the main render loop
    setState({
      editingAgentId: agent.id,
      error: "",
      stage: "idle",
      plan: [],
      agentOutputs: [],
      selectedDemoIndex: -1 // Ensure we are in custom mode
    });

    // UI Feedback & Focus
    setTimeout(() => {
      const section = $("#custom-problem-section");
      const textarea = $("#custom-problem");
      if (section) section.scrollIntoView({ behavior: "smooth", block: "center" });
      if (textarea) textarea.focus();
    }, 50);
  }
};

async function refreshAgents() {
  const agents = await Storage.listAgents();
  setState({ savedAgents: agents });
}

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

  if ($("#flow-columns")) $("#flow-columns").value = Utils.clampFlowColumns(defaults.flowColumns);

  // Init Supabase from config.json if present, else localStorage
  let sbUrl = config.supabase?.url || localStorage.getItem("supabase_url");
  let sbKey = config.supabase?.key || localStorage.getItem("supabase_key");

  // If config has placeholders, ignore them
  if (sbUrl === "") sbUrl = null;
  if (sbKey === "") sbKey = null;

  if (sbUrl && sbKey) {
    const ok = await Storage.init(sbUrl, sbKey);
    setState({ supabaseConfigured: ok, session: Storage.getSession() });
    if (ok) refreshAgents();
  }

  View.renderDemoCards($("#demo-cards"), config.demos, state.savedAgents, state, actions);
  render();

  // Event Listeners
  $("#configure-llm")?.addEventListener("click", async () => llmSession.creds = await openaiConfig({ defaultBaseUrls: DEFAULT_BASE_URLS, show: true }));
  $("#custom-problem-form")?.addEventListener("submit", actions.handleCustomProblemSubmit);

  // Supabase UI Bindings (We will add these buttons in View)
  // For global nav buttons that might not be re-rendered:
  // We'll rely on View to render auth buttons inside the app or a specific container if we add one.
  // Actually, let's just use the View.renderApp to handling the auth UI.

  const settingsForm = saveform("#settings-form");
  $("#settings-form")?.addEventListener("reset", () => setTimeout(() => {
    settingsForm.clear();
    // simpler to just call scheduleSync
    scheduleFlowchartSync();
  }, 0));

  const updateLayout = () => {
    const o = $("#flow-orientation")?.value, c = $("#flow-columns")?.value;
    if (o && c) setState({ flowOrientation: Utils.normalizeFlowOrientation(o), flowColumns: Utils.clampFlowColumns(c) });
  };
  $("#flow-orientation")?.addEventListener("change", updateLayout);
  $("#flow-columns")?.addEventListener("input", updateLayout);

  window.addEventListener('auth-changed', (e) => {
    setState({ session: e.detail });
    if (e.detail) refreshAgents();
    else setState({ savedAgents: [] });
  });
})();

function setState(updates) {
  Object.assign(state, updates);
  render();
}

function render() {
  View.renderDemoCards($("#demo-cards"), config.demos, state.savedAgents, state, actions);
  View.renderApp($("#output"), state, config, actions);
  View.renderAuth($("#auth-controls"), state, actions);
  syncCustomButton();
  scheduleFlowchartSync();
  scheduleScrollToRunningSection();
}

// Logic
function selectDemo(index) {
  const demo = config.demos[index];
  const inputs = (demo?.inputs || []).map(i => ({ ...i, id: Utils.uniqueId("input") }));
  resetRunState({ selectedDemoIndex: index, suggestedInputs: inputs, selectedInputs: new Set(inputs.map(i => i.id)), editingAgentId: null });
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
    if (state.selectedDemoIndex === -2) { // saved agent re-run (shouldn't really happen here but safe guard)
      // just go to data
      setState({ stage: "data" });
      return;
    }

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
                { role: "user", content: `Problem:\n${(state.selectedDemoIndex >= 0 ? config.demos[state.selectedDemoIndex].problem : state.customProblem?.problem || "Problem")}\n\nTask:\n${out.task}\n\nInput:\n${inputBlob}\n\nContext:\n${Utils.truncate(context, 1200)}` }
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
  if (state.stage === "run") return "execution-flow";
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
