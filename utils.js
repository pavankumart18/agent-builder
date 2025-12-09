export function uniqueId(prefix) {
    return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

export function safeParseJson(text) {
    try {
        return JSON.parse((text || "").trim() || "{}");
    } catch {
        return {};
    }
}

export function truncate(text, max) {
    if (!text) return "";
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** exp).toFixed(1)} ${units[exp]}`;
}

export function inferTypeFromName(name = "") {
    const lower = name.toLowerCase();
    return lower.endsWith(".csv") ? "csv" : lower.endsWith(".json") ? "json" : "text"; // simplified
}

export function formatDataEntries(entries) {
    if (!entries.length) return "User did not attach additional datasets.";
    return entries.map((entry, idx) => `${idx + 1}. ${entry.title} [${entry.type}]\n${truncate(entry.content, 600)}`).join("\n\n");
}

export function sanitizeInputType(value) {
    const allowed = ["text", "csv", "json"];
    const lower = (value || "").toString().trim().toLowerCase();
    return allowed.includes(lower) ? lower : "text";
}

export function normalizeFlowOrientation(value) {
    return value === "vertical" ? "vertical" : "horizontal";
}

export function clampFlowColumns(value) {
    const num = Number(value);
    return Number.isFinite(num) ? Math.min(6, Math.max(1, Math.round(num))) : 2;
}

export async function streamChatCompletion({ llm, body, onChunk = () => { } }) {
    const response = await fetch(`${llm.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} - ${await response.text()}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Streaming not supported.");
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

// Plan Normalization & Graph Helpers

export function normalizePlan(list, maxAgents) {
    if (!Array.isArray(list)) return [];
    const usedIds = new Set();
    return list
        .filter((item) => item && typeof item === "object")
        .slice(0, maxAgents)
        .map((item, index) => {
            const fallbackId = `agent-${index + 1}`;
            const candidateId = sanitizeNodeId(item.nodeId || item.id || item.agentName, fallbackId);
            const nodeId = ensureUniqueNodeId(candidateId, usedIds, fallbackId);
            const phase = parsePhase(item.stage ?? item.phase ?? item.step, index + 1);
            return {
                nodeId,
                agentName: (item.agentName || `Agent ${index + 1}`).trim(),
                systemInstruction: (item.systemInstruction || "Deliver the next actionable step.").trim(),
                initialTask: (item.initialTask || item.systemInstruction || "Next step.").trim(),
                graphTargets: collectRefs(item, ['next', 'children', 'targets', 'links', 'branches', 'connections', 'to', 'parallel']),
                graphIncoming: collectRefs(item, ['dependsOn', 'requires', 'after', 'parents', 'prerequisites', 'inputsFrom', 'waitFor', 'sources']),
                phase,
                phaseLabel: extractPhaseLabel(item, phase),
                branchKey: sanitizeBranchKey(item.branch || item.parallelGroup || item.lane),
            };
        });
}

export function normalizeInputs(list, demo) {
    const defaults = (demo?.inputs || []).map((input) => ({ ...input, id: input.id || uniqueId("input") }));
    if (!Array.isArray(list) || !list.length) return defaults;
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
    let next = candidate || fallback || `node-${usedIds.size + 1}`;
    let attempt = 1;
    const base = next;
    while (usedIds.has(next)) {
        attempt++;
        next = `${base}-${attempt}`;
    }
    usedIds.add(next);
    return next;
}

function collectRefs(item, keys) {
    const pools = keys.map(k => item[k]).filter(Boolean);
    if (item.graph) {
        if (keys.includes('targets')) pools.push(item.graph.edges, item.graph.connections);
        if (keys.includes('parents')) pools.push(item.graph.parents, item.graph.sources);
    }
    const refs = pools.flatMap(coerceTargetPool);
    return Array.from(new Set(refs.filter(Boolean)));
}

function coerceTargetPool(value) {
    if (Array.isArray(value)) return value.map(coerceSingleTarget).filter(Boolean);
    if (typeof value === "string" || typeof value === "number") {
        return value.toString().split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
    }
    if (typeof value === "object") return [coerceSingleTarget(value)].filter(Boolean);
    return [];
}

function coerceSingleTarget(entry) {
    if (!entry) return null;
    if (typeof entry !== "object") return entry.toString().trim();
    return (entry.id || entry.target || entry.to || entry.nodeId || entry.name || entry.label || "").toString().trim() || null;
}

function parsePhase(value, fallback) {
    if (value == null) return fallback;
    const num = Number(value);
    if (Number.isFinite(num)) return num;
    const match = String(value).match(/\d+/);
    return match ? Number(match[0]) : fallback;
}

function extractPhaseLabel(item, phase) {
    const val = item.stageLabel || item.phaseLabel || item.stage || item.phase || item.group;
    if (val && typeof val === 'string' && isNaN(Number(val))) return val.trim();
    return Number.isFinite(phase) ? `Stage ${phase}` : null;
}

function sanitizeBranchKey(value) {
    return value ? value.toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") : null;
}

export function buildGraphFromPlan(plan = []) {
    if (!plan.length) return { nodes: [], edges: [] };
    const nodes = plan.map((agent, index) => ({
        id: agent.nodeId,
        label: agent.agentName,
        index,
        phase: agent.phase,
        phaseLabel: agent.phaseLabel
    }));

    const aliasMap = new Map();
    nodes.forEach(node => {
        const agent = plan[node.index];
        [node.id, node.label, agent.phaseLabel, agent.branchKey, `step ${node.index + 1}`, `${node.index + 1}`]
            .forEach(key => key && aliasMap.set(key.toString().toLowerCase(), node));
    });

    const edges = [];
    const seen = new Set();
    const addEdge = (src, tgt) => {
        if (src === tgt) return;
        const key = `${src}->${tgt}`;
        if (!seen.has(key)) { seen.add(key); edges.push({ source: src, target: tgt }); }
    };

    const phases = [...new Set(nodes.map(n => n.phase))].sort((a, b) => a - b);
    const phaseMap = new Map();
    nodes.forEach(n => { if (!phaseMap.has(n.phase)) phaseMap.set(n.phase, []); phaseMap.get(n.phase).push(n); });

    nodes.forEach((node, i) => {
        const agent = plan[i];

        // Incoming
        agent.graphIncoming.forEach(ref => {
            const src = aliasMap.get(ref.toLowerCase());
            if (src) addEdge(src.id, node.id);
        });

        // Outgoing
        let explicit = false;
        agent.graphTargets.forEach(ref => {
            const tgt = aliasMap.get(ref.toLowerCase());
            if (tgt) { addEdge(node.id, tgt.id); explicit = true; }
        });

        if (!explicit) {
            // Auto connect to next phase or next step
            const nextPhase = phases.find(p => p > node.phase);
            if (nextPhase !== undefined) {
                phaseMap.get(nextPhase).forEach(tgt => addEdge(node.id, tgt.id));
            } else if (!agent.graphIncoming.length && i < nodes.length - 1) {
                // If no explicit targets and not end of list, and this node wasn't purely an "incoming" receiver, link to next
                // Logic kept similar to original: if no inbound, link sequential? Original logic was `!inboundRefs.length`.
                if (!agent.graphIncoming.length) addEdge(node.id, nodes[i + 1].id);
            }
        }
    });

    return { nodes, edges };
}
