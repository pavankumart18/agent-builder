import cytoscape from "cytoscape";

const NODE_BASE_STYLE = {
  "background-color": "#4A90E2",
  "background-gradient-stop-colors": "#4A90E2 #357ABD",
  "background-gradient-direction": "to-bottom-right",
  "border-width": 3,
  "border-color": "#2C5F8D",
  "border-style": "solid",
  shape: "round-rectangle",
  label: "data(label)",
  "text-valign": "center",
  "text-halign": "center",
  color: "#ffffff",
  "text-outline-width": 1,
  "text-outline-color": "#1a1a1a",
  "text-outline-opacity": 0.3,
  padding: "18px",
  "font-family": "Segoe UI, -apple-system, BlinkMacSystemFont, sans-serif",
  "font-size": "16px",
  "font-weight": "600",
  "text-wrap": "wrap",
  "text-max-width": "260px",
  "text-margin-y": 0,
  width: "label",
  height: "label",
  "min-zoomed-font-size": 10,
  "overlay-opacity": 0,
  "transition-property": "background-color, border-color, shadow-blur",
  "transition-duration": "200ms",
};

const EDGE_BASE_STYLE = {
  width: 3,
  "line-color": "#4A90E2",
  "target-arrow-color": "#2C5F8D",
  "target-arrow-shape": "triangle",
  "target-arrow-fill": "filled",
  "arrow-scale": 1.5,
  "curve-style": "bezier",
  opacity: 1,
  "line-style": "solid",
  "source-endpoint": "outside-to-node",
  "target-endpoint": "outside-to-node",
  "target-distance-from-node": 5,
};

const STATE_STYLES = [
  {
    selector: "node.is-active",
    style: {
      "background-color": "#FFB703",
      "border-color": "#FB8500",
      "text-outline-color": "#7B4F00",
      color: "#2b261f",
    },
  },
  {
    selector: "node.is-complete",
    style: {
      "background-color": "#2D6A4F",
      "border-color": "#1B4332",
    },
  },
  {
    selector: "node.is-selected",
    style: {
      "border-color": "#ffd803",
      "border-width": 5,
      "shadow-blur": 18,
      "shadow-color": "#ffd80366",
      "shadow-opacity": 1,
      "shadow-offset-x": 0,
      "shadow-offset-y": 0,
    },
  },
  {
    selector: "node.is-failed",
    style: {
      "background-color": "#9B2226",
      "border-color": "#AE2012",
      "text-outline-color": "#fff",
    },
  },
];

const DEFAULT_OPTIONS = {
  orientation: "horizontal",
  animate: false,
  columnCount: 2,
  onNodeSelected: () => { },
};

export function createFlowchart(containerOrSelector, elements = [], options = {}) {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };
  const container =
    typeof containerOrSelector === "string" ? document.querySelector(containerOrSelector) : containerOrSelector;
  if (!container) throw new Error("Flowchart container not found.");

  const layoutOptions = createLayoutOptions(mergedOptions.orientation, mergedOptions.columnCount);

  const cy = cytoscape({
    container,
    elements: [],
    layout: layoutOptions,
    style: [
      { selector: "node", style: NODE_BASE_STYLE },
      { selector: "edge", style: EDGE_BASE_STYLE },
      ...STATE_STYLES,
    ],
    userZoomingEnabled: true,
    userPanningEnabled: true,
  });

  let nodeState = { activeIds: [], completedIds: [], failedIds: [], selectedId: null };
  let docClickHandler = null;

  function attachDocumentHandler() {
    if (docClickHandler) return;
    docClickHandler = (event) => {
      if (!container.contains(event.target)) {
        mergedOptions.onNodeSelected?.(null);
      }
    };
    document.addEventListener("click", docClickHandler);
  }

  function detachDocumentHandler() {
    if (!docClickHandler) return;
    document.removeEventListener("click", docClickHandler);
    docClickHandler = null;
  }

  attachDocumentHandler();

  cy.on("tap", "node", (event) => {
    mergedOptions.onNodeSelected?.(event.target.id());
  });

  cy.on("tap", (event) => {
    if (event.target === cy) {
      mergedOptions.onNodeSelected?.(null);
    }
  });

  const controller = {
    container,
    cy,
    orientation: mergedOptions.orientation === "vertical" ? "vertical" : "horizontal",
    columnCount: sanitizeColumnCount(mergedOptions.columnCount),
    setElements(nextElements = []) {
      cy.startBatch();
      cy.elements().remove();
      if (Array.isArray(nextElements) && nextElements.length) {
        cy.add(nextElements);
      }
      cy.endBatch();
      controller.runLayout();
      controller.applyNodeState();
    },
    setOrientation(nextOrientation = "horizontal") {
      const clean = nextOrientation === "vertical" ? "vertical" : "horizontal";
      if (clean === controller.orientation) return;
      controller.orientation = clean;
      controller.runLayout();
    },
    setColumns(nextColumns = 2) {
      const clean = sanitizeColumnCount(nextColumns);
      if (clean === controller.columnCount) return;
      controller.columnCount = clean;
      controller.runLayout();
    },
    runLayout() {
      const layoutOpts = createLayoutOptions(controller.orientation, controller.columnCount);
      // Disable internal layout animation to ensure we can calculate bounds immediately and resize container
      layoutOpts.animate = false;

      const layout = cy.layout(layoutOpts);
      layout.one("layoutstop", () => {
        const elements = cy.elements();
        if (elements.length === 0) return;

        // Calculate bounds with labels
        const bb = elements.boundingBox({ includeLabels: true, includeOverlays: true });

        // Determine optimal height
        const PADDING_Y = 80;
        const MIN_HEIGHT = 300;
        const desiredHeight = bb.h + PADDING_Y;
        const newHeight = Math.max(MIN_HEIGHT, desiredHeight);

        // Apply height if it changed significantly
        if (Math.abs(container.offsetHeight - newHeight) > 5) {
          container.style.height = `${newHeight}px`;
          cy.resize();
        }
        controller.fit();
      });
      layout.run();
    },
    fit() {
      if (!cy.elements().length) return;
      cy.fit(cy.elements(), 30); // 30px padding around fit
      if (cy.zoom() > 1.2) cy.zoom(1.2); // Don't zoom in too much if few nodes
      cy.center(cy.elements());
    },
    setNodeState(nextState = {}) {
      nodeState = {
        activeIds: Array.isArray(nextState.activeIds)
          ? nextState.activeIds.filter(Boolean)
          : nextState.activeId
            ? [nextState.activeId]
            : [],
        completedIds: Array.isArray(nextState.completedIds) ? nextState.completedIds.filter(Boolean) : [],
        failedIds: Array.isArray(nextState.failedIds) ? nextState.failedIds.filter(Boolean) : [],
        selectedId: nextState.selectedId ?? null,
      };
      controller.applyNodeState();
    },
    applyNodeState() {
      cy.startBatch();
      cy.nodes().forEach((node) => node.removeClass("is-active is-complete is-selected is-failed"));
      cy.nodes().forEach((node) => {
        const id = node.id();
        if (nodeState.activeIds.includes(id)) node.addClass("is-active");
        if (nodeState.selectedId === id) node.addClass("is-selected");
        if (nodeState.completedIds.includes(id)) node.addClass("is-complete");
        if (nodeState.failedIds.includes(id)) node.addClass("is-failed");
      });
      cy.endBatch();
    },
    resize() {
      cy.resize();
      controller.fit();
    },
    destroy() {
      detachDocumentHandler();
      cy.destroy();
    },
  };

  controller.setElements(elements);
  return controller;
}

function createLayoutOptions(orientation = "horizontal", columnCount = 2) {
  const horizontal = orientation !== "vertical";
  const columns = sanitizeColumnCount(columnCount);
  const spacingFactor = 1 + columns * 0.2;
  const padding = 24 + columns * 6;
  return {
    name: "breadthfirst",
    directed: true,
    padding,
    spacingFactor,
    avoidOverlap: true,
    nodeDimensionsIncludeLabels: true,
    animate: true,
    animationDuration: 550,
    transform: (_node, position) => (horizontal ? { x: position.y, y: position.x } : position),
  };
}

function sanitizeColumnCount(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 2;
  return Math.min(8, Math.max(1, Math.round(num)));
}
