# Agent Builder

A powerful, local-first web application for architecting and executing multi-agent workflows. Build, visualize, and run complex chains of AI agents directly in your browser. Now supports **saving and sharing agents** via Supabase.

![Agent Builder Demo](https://via.placeholder.com/800x400?text=Agent+Builder+UI)

## 🚀 Features

*   **Architect Mode**: Intelligently breaks down complex user problems into a structured plan of specialist agents.
*   **Parallel Execution**: Runs independent agents concurrently in the same stage for faster results (e.g., parallel data analysis).
*   **Live Flowchart**: Visualizes the agent execution graph dynamically using Cytoscape.js.
*   **Streaming & Real-time**: Watch agent outputs stream in real-time with Markdown support.
*   **Cloud Persistence**: **Sign In** with Google to Save, Load, Edit, and Delete your custom agents (powered by Supabase).
*   **Modular Design**: Clean separation of concerns (Model-View-Controller) for easy extensibility.
*   **Local & Serverless**: Runs entirely in the browser. No backend required other than LLM and Supabase APIs.

## 🛠️ Setup & Usage

### 1. Prerequisites
*   A modern web browser (Chrome, Edge, Firefox).
*   Python (for the simple local server) or any other static file server (e.g., `http-server`).
*   **OpenAI API Key** or compatible endpoint.
*   (Optional) **Supabase Project** for saving agents.

### 2. Installation
```bash
git clone https://github.com/pavankumart18/agent-builder.git
cd agent-builder
```

### 3. Running the App
Start a local server in the project directory:
```bash
# Using Python
python -m http.server 8000

# OR using Node.js
npx http-server .
```
Open [http://localhost:8000](http://localhost:8000) in your browser.

### 4. Configuration

**LLM Configuration**:
Click the **"Configure LLM"** button (magic wand icon) in the top right to set your API Key.

**Supabase (Authentication & Storage)**:
To enable generic saving/loading features:
1.  Create a project at [Supabase.com](https://supabase.com).
2.  Enable **Google Auth** in the Authentication providers.
3.  Create an `agents` table (see `schema.sql` example below or let the app prompt you).
4.  Update `config.json` with your credentials OR enter them when prompted in the app:
    ```json
    "supabase": {
      "url": "https://your-project.supabase.co",
      "key": "your-public-anon-key"
    }
    ```

**⚠️ Security Note**: It is safe to expose your `SUPABASE_URL` and `ANON_KEY` in `config.json` or client-side code, provided you have enabled **Row Level Security (RLS)** in your Supabase database to protect user data. **Never** expose the `SERVICE_ROLE` key.

## 📂 Project Structure

*   **`index.html`**: Main entry point and layout.
*   **`script.js`**: Main Controller. Handles state, events, and app logic.
*   **`view.js`**: UI Rendering (lit-html). Handles DOM updates, Auth UI, and Agent Cards.
*   **`storage.js`**: **New!** Database layer managing Supabase Auth and Data operations.
*   **`utils.js`**: Helper functions, LLM stream parser, and graph algorithms.
*   **`flowchart.js`**: Cytoscape.js wrapper for the interactive graph.
*   **`config.json`**: Global configuration, demo templates, and prompt defaults.

## 🏗️ Schema Example (Supabase)

If setting up your own Supabase project, use this SQL to create the `agents` table:

```sql
create table agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  title text not null,
  problem text,
  plan jsonb,
  inputs jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now())
);

-- Enable RLS
alter table agents enable row level security;

-- Policy: Users can only see/edit their own agents
create policy "Users can crud their own agents"
on agents for all
using (auth.uid() = user_id);
```

## 🤝 Contributing

1.  Fork the repository.
2.  Create a feature branch.
3.  Commit your changes.
4.  Open a Pull Request.

## 📄 License

MIT License.
