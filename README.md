# Agent Builder

A powerful, local-first web application for architecting and executing multi-agent workflows. Build, visualize, and run complex chains of AI agents directly in your browser.

**[🌐 Try the Live Demo](https://pavankumart18.github.io/agent-builder/)**

![Agent Builder Demo](https://via.placeholder.com/800x400?text=Agent+Builder+UI)

## 🚀 Features

*   **Architect Mode**: intelligently breaks down complex user problems into a structured plan of specialist agents.
*   **Parallel Execution**: Runs independent agents concurrently in the same stage for faster results (e.g., parallel data analysis).
*   **Live Flowchart**: Visualizes the agent execution graph dynamically using Cytoscape.js.
*   **Streaming & Real-time**: Watch agent outputs stream in real-time with Markdown support.
*   **Modular Design**: Clean separation of concerns (Model-View-Controller) for easy extensibility.
*   **Customizable**: Fully data-driven via `config.json` to add new demos or adjust defaults.
*   **Local First**: No backend required other than an LLM API endpoint. Runs on any static HTTP server.

## 🛠️ Setup & Usage

1.  **Prerequisites**:
    *   A modern web browser (Chrome, Edge, Firefox).
    *   Python (for the simple local server) or any other static file server (e.g., `http-server`).
    *   One of the following LLM providers:
        *   OpenAI API Key
        *   Compatible OpenAI-formatted endpoint (e.g., vLLM, local inference)

2.  **Installation**:
    ```bash
    git clone https://github.com/pavankumart18/agent-builder.git
    cd agent-builder
    ```

3.  **Running the App**:
    Start a local server in the project directory:
    ```bash
    # Using Python
    python -m http.server 8000
    
    # OR using Node.js
    npx http-server .
    ```
    Open [http://localhost:8000](http://localhost:8000) in your browser.

4.  **Configuration**:
    *   Click the **"Configure LLM"** button in the top right to set your API Key and Base URL.
    *   Select a demo card (e.g., "Regulatory Compliance", "Parallel Analysis") to start.

## 📂 Project Structure

The project has been refactored for modularity and performance:

*   **`index.html`**: Main entry point and CSS styles.
*   **`script.js`**: Main Controller. Handles state management and coordinates the app logic.
*   **`view.js`**: Pure UI components using `lit-html`. Handles all DOM rendering.
*   **`utils.js`**: Helper functions, data processing, and graph algorithms.
*   **`flowchart.js`**: Wrapper around `cytoscape.js` for managing the interactive graph visualization.
*   **`config.json`**: Configuration file defining available demos, default settings, and prompt templates.

## 🧩 Adding Custom Demos

You can add your own workflows by editing `config.json`. Add a new entry to the `demos` array:

```json
{
  "title": "My Custom Workflow",
  "icon": "bi bi-star",
  "problem": "Describe what the architect should solve...",
  "inputs": [
    { "title": "Context", "type": "text", "content": "Sample data..." }
  ]
}
```

## 🤝 Contributing

1.  Fork the repository.
2.  Create a feature branch (`git checkout -b feature/amazing-agent`).
3.  Commit your changes.
4.  Open a Pull Request.

## 📄 License

MIT License.
