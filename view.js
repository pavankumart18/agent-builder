import { html, render } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { Marked } from "marked";
import hljs from "highlight.js";
import { formatBytes, truncate } from "./utils.js";

const marked = new Marked({
  renderer: {
    code(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : "plaintext";
      return `<pre class="hljs language-${language}"><code>${hljs.highlight(code ?? "", { language }).value.trim()}</code></pre>`;
    }
  }
});

const loading = html`<div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div>`;

export function renderDemoCards(container, demos, selectedIndex, busy, onPlan) {
  render(
    (demos || []).map((demo, index) => html`
      <div class="col-sm-6 col-lg-4">
        <div class="card demo-card h-100 shadow-sm">
          <div class="card-body d-flex flex-column">
            <div class="text-center text-primary display-5 mb-3"><i class="${demo.icon}"></i></div>
            <h5 class="card-title">${demo.title}</h5>
            <p class="card-text text-body-secondary small flex-grow-1">${demo.body}</p>
            <button class="btn btn-primary mt-auto" @click=${() => onPlan(index)} ?disabled=${busy}>
              ${busy && selectedIndex === index ? "Streaming..." : "Plan & Run"}
            </button>
          </div>
        </div>
      </div>
    `),
    container
  );
}

export function renderApp(container, state, config, actions) {
  if (state.selectedDemoIndex === null) {
    render(html`<div class="text-center text-body-secondary py-5"><p>Select a card above to stream the architect plan and run the agents.</p></div>`, container);
    return;
  }
  const demo = state.selectedDemoIndex === -1 ? state.customProblem : config.demos[state.selectedDemoIndex];
  render(html`
      ${state.error ? html`<div class="alert alert-danger">${state.error}</div>` : null}
      <section class="card mb-4">
        <div class="card-body"><h3 class="h4 mb-2">${demo.title}</h3><p class="mb-0 text-body-secondary small">${demo.problem}</p></div>
      </section>
      ${renderStageBadges(state)}
      ${renderPlan(state)}
      ${renderDataInputs(state, actions)}
      ${renderFlow(state)}
      ${renderAgentOutputs(state)}
  `, container);
}

function renderStageBadges(state) {
  const steps = [
    { label: "Architect", active: state.stage === "architect", done: state.stage !== "architect" && state.plan.length },
    { label: "Data", active: state.stage === "data", done: (state.stage === "run" || state.stage === "idle") && state.agentOutputs.length > 0 },
    { label: "Agents", active: state.stage === "run", done: state.stage === "idle" && state.agentOutputs.length > 0 },
  ];
  return html`
    <div class="d-flex gap-2 flex-wrap mb-4">
      ${steps.map(s => html`<span class="badge text-bg-${s.active ? "primary" : s.done ? "success" : "secondary"}">${s.label}</span>`)}
    </div>`;
}

function renderPlan(state) {
  const streaming = state.stage === "architect";
  const hasPlan = state.plan.length > 0;
  return html`
    <section class="card mb-4" data-running-key=${streaming ? "architect-plan" : null}>
      <div class="card-header d-flex justify-content-between align-items-center">
        <span><i class="bi bi-diagram-3 me-2"></i> Architect Plan</span>
        <span class="badge text-bg-${streaming ? "primary" : hasPlan ? "success" : "secondary"}">${streaming ? "Planning" : hasPlan ? "Ready" : "Pending"}</span>
      </div>
      <div class="card-body">
        ${streaming ? html`
            <div class="bg-dark text-white rounded-3 p-3 mb-0">
              ${state.architectBuffer ? html`<pre class="mb-0 text-white" style="white-space: pre-wrap; overflow-wrap: break-word;">${state.architectBuffer}</pre>`
        : html`<div class="d-flex align-items-center gap-2"><div class="spinner-border spinner-border-sm" role="status"></div><span>Streaming architect plan...</span></div>`}
            </div>`
      : hasPlan ? html`<ol class="list-group list-group-numbered">${state.plan.map(agent => html`
                <li class="list-group-item">
                  <div class="d-flex justify-content-between align-items-start">
                    <div><div class="fw-semibold">${agent.agentName}</div><div class="text-body-secondary small">${agent.initialTask}</div></div>
                    <span class="badge text-bg-light text-uppercase">${agent.systemInstruction ? "Instruction" : ""}</span>
                  </div>
                  ${agent.systemInstruction ? html`<p class="small mb-0 mt-2 text-body-secondary">${agent.systemInstruction}</p>` : null}
                </li>`)}</ol>`
        : html`<div class="text-center py-3 text-body-secondary small">Plan will appear here after the architect stream completes.</div>`}
      </div>
    </section>`;
}

function renderDataInputs(state, actions) {
  const disabled = !state.plan.length || ["architect", "run"].includes(state.stage);
  return html`
    <section class="card mb-4" data-running-key=${state.stage === "data" ? "data-inputs" : null}>
      <div class="card-header d-flex justify-content-between align-items-center flex-wrap gap-2">
        <div><i class="bi bi-database me-2"></i> Data Inputs</div>
        <button class="btn btn-sm btn-primary" @click=${actions.startAgents} ?disabled=${disabled}>${state.stage === "run" ? "Running..." : "Start Agents"}</button>
      </div>
      <div class="card-body">
        <div class="row g-3">
          <div class="col-lg-7">
            <div class="list-group">
                ${state.suggestedInputs.map(input => {
    const selected = state.selectedInputs.has(input.id);
    return html`
                      <button type="button" class="list-group-item list-group-item-action d-flex flex-column gap-1 ${selected ? "active text-white" : ""}" @click=${() => actions.toggleSuggestedInput(input.id)}>
                        <div class="d-flex justify-content-between align-items-center w-100">
                          <span class="fw-semibold ${selected ? "text-white" : ""}">${input.title}</span>
                          <span class="badge text-uppercase bg-secondary">${input.type}</span>
                        </div>
                        <pre class="mb-0 small ${selected ? "text-white" : "text-body-secondary"}" style="white-space: pre-wrap; word-break: break-word;">${truncate(input.content, 420)}</pre>
                      </button>`;
  })}
            </div>
            ${!state.suggestedInputs.length ? html`<p class="text-body-secondary small">Architect suggestions will appear here.</p>` : null}
          </div>
          <div class="col-lg-5">
            <div class="mb-3">
              <label class="form-label small fw-semibold">Upload CSV/JSON/TXT</label>
              <input class="form-control" type="file" multiple accept=".txt,.csv,.json" @change=${actions.handleFileUpload} />
              <ul class="list-group list-group-flush mt-2 small">
                ${state.uploads.map(u => html`
                  <li class="list-group-item d-flex justify-content-between align-items-center">
                    <div><div class="fw-semibold">${u.title}</div><div class="text-body-secondary">${formatBytes(u.meta?.size)} · ${u.type.toUpperCase()}</div></div>
                    <button class="btn btn-link btn-sm text-danger" @click=${() => actions.removeUpload(u.id)}>Remove</button>
                  </li>`)}
              </ul>
              ${!state.uploads.length ? html`<p class="small text-body-secondary mt-2 mb-0">Attached files stay in the browser.</p>` : null}
            </div>
            <div>
              <label class="form-label small fw-semibold">Inline notes</label>
              <textarea class="form-control" rows="4" placeholder="Paste quick metrics, KPIs, transcripts..." .value=${state.notes} @input=${e => actions.setNotes(e.target.value)}></textarea>
            </div>
          </div>
        </div>
      </div>
    </section>`;
}

function renderFlow(state) {
  if (!state.plan.length) return null;
  return html`
    <section class="card mb-4" data-running-key="execution-flow">
      <div class="card-header d-flex justify-content-between align-items-center flex-wrap gap-2">
        <span><i class="bi bi-diagram-3 me-2"></i>Execution Flow</span>
        <small class="text-body-secondary">Click nodes to inspect prior output, click outside to resume live view.</small>
      </div>
      <div class="card-body">
        <div class="row g-3 align-items-stretch">
          <div class="col-xl-8 col-lg-7">
            <div id="flowchart-canvas" class="flowchart-canvas border rounded-3 bg-body-tertiary" data-flow-orientation=${state.flowOrientation} data-flow-columns=${state.flowColumns}></div>
          </div>
          <div class="col-xl-4 col-lg-5">${renderFlowOutputPanel(state)}</div>
        </div>
      </div>
    </section>`;
}

function renderFlowOutputPanel(state) {
  const liveId = state.focusedNodeId ?? (state.latestNodeId || (state.plan[0]?.nodeId));
  const output = state.agentOutputs.find(o => o.nodeId === liveId);
  const agent = state.plan.find(a => a.nodeId === liveId);

  const title = agent ? agent.agentName : "Agent Output";
  const stepLabel = agent ? (agent.phase ? `Stage ${agent.phase}` : "Step") : null;
  const panelTitle = state.focusedNodeId ? (stepLabel || "Pinned Step") : "Live Output";
  const status = output ? (output.status === "done" ? { l: "Done", c: "success" } : output.status === "error" ? { l: "Error", c: "danger" } : { l: "Running", c: "primary" }) : null;

  return html`
    <div class="flow-output-panel h-100 d-flex flex-column">
      <div class="d-flex justify-content-between align-items-start mb-2">
        <div><p class="text-uppercase small text-body-secondary mb-1">${panelTitle}</p><h6 class="mb-1">${title}</h6></div>
        ${status ? html`<span class="badge text-bg-${status.c}">${status.l}</span>` : null}
      </div>
      <div class="${output ? agentStreamClasses(output) : "agent-stream border rounded-3 p-3 bg-body"} flex-grow-1 overflow-auto">
        ${output ? renderOutputBody(output) : html`<div class="text-body-secondary small">${state.focusedNodeId ? "No output recorded." : "Run agents to stream output."}</div>`}
      </div>
    </div>`;
}

function renderAgentOutputs(state) {
  if (!state.agentOutputs.length) return null;
  const groups = new Map();
  state.agentOutputs.forEach(a => { const p = a.phase ?? "unknown"; if (!groups.has(p)) groups.set(p, []); groups.get(p).push(a); });
  const keys = [...groups.keys()].sort((a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : String(a).localeCompare(String(b)));

  return html`<section class="mb-5">
    ${keys.map(key => {
    const group = groups.get(key);
    if (group.length > 1) {
      return html`
              <div class="card mb-4 shadow-sm">
                  <div class="card-header d-flex justify-content-between align-items-center">
                      <div class="d-flex align-items-center gap-2"><span class="badge bg-secondary">Stage ${key}</span><span class="fw-semibold">Parallel Execution</span></div>
                  </div>
                  <div class="card-body bg-body-tertiary">
                      <div class="row g-3">${group.map(a => html`<div class="col-lg-6 col-xl-${Math.max(Math.floor(12 / group.length), 4)}">${renderAgentCard(a, state, true)}</div>`)}</div>
                  </div>
              </div>`;
    }
    return html`<div class="card mb-3 shadow-sm" data-running-key=${`node-${group[0].nodeId}`}><div class="card-body row g-3 align-items-stretch">${renderAgentCard(group[0], state, false)}</div></div>`;
  })}
  </section>`;
}

function renderAgentCard(agent, state, simple) {
  const meta = agent.status === "done" ? { l: "Done", c: "success" } : agent.status === "error" ? { l: "Error", c: "danger" } : { l: "Running", c: "primary" };
  if (simple) {
    return html`
          <div class="h-100 d-flex flex-column border rounded-3 overflow-hidden shadow-sm">
              <div class="p-3 bg-body-tertiary border-bottom d-flex justify-content-between align-items-center gap-2">
                   <div class="text-truncate"><h6 class="mb-0 text-truncate" title="${agent.name}">${agent.name}</h6><small class="text-body-secondary text-truncate d-block" title="${agent.task}">${agent.task}</small></div>
                   <span class="badge text-bg-${meta.c}">${meta.l}</span>
              </div>
              <div class="${agentStreamClasses(agent)} flex-grow-1 border-0 rounded-0" style="min-height: 200px;">${renderOutputBody(agent)}</div>
          </div>`;
  }
  return html`
      <div class="col-md-4 d-flex flex-column">
        <p class="text-uppercase small text-body-secondary mb-1">${agent.phase ? `Stage ${agent.phase}` : "Step"}</p>
        <h6 class="mb-2">${agent.name}</h6>
        <p class="text-body-secondary small flex-grow-1 mb-3">${agent.task}</p>
        <span class="badge text-bg-${meta.c} align-self-start">${meta.l}</span>
      </div>
      <div class="col-md-8"><div class="${agentStreamClasses(agent)}">${renderOutputBody(agent)}</div></div>`;
}

function renderOutputBody(agent) {
  if (!agent.text) return loading;
  if (agent.status === "done") return html`<div class="agent-markdown">${unsafeHTML(marked.parse(agent.text))}</div>`;
  const tone = agent.status === "error" ? "text-warning" : "text-white";
  return html`<pre class="mb-0 ${tone}" style="white-space: pre-wrap;">${agent.text}</pre>`;
}

function agentStreamClasses(agent) {
  const base = "agent-stream border rounded-3 p-2";
  if (agent.status === "error") return `${base} bg-dark text-warning`;
  if (agent.status === "done") return `${base} bg-body`;
  return `${base} bg-black text-white`;
}
