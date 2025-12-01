# Streamline Agents

Client-side multi-agent orchestrator that mirrors Hypoforge’s clean workflow: users bring their own API credentials, craft or pick a problem card, and watch an architect plan, specialists execute, and a conclusion agent wrap up with live streaming output.

## Features

- **Browser-native** – `index.html` + `script.js` talk directly to any OpenAI-compatible endpoint via browser `fetch`.
- **Starter problems** – editable `config.json` seeds the dashboard with curated briefs; pick one to autofill the prompt.
- **Sequential agent flow** – Architect generates 2–5 agents; each agent receives the previous context, streams full output, and auto-scrolls into view.
- **Flow diagram** – Colored nodes visualize progress (blue processing, yellow validation, red loop/issue, green verified) with confidence scores and loop indicators.
- **Concise prompts** – Agents respond in <50 words; conclusion summarizes in <120 words with follow-up recommendations.
- **Local persistence** – API base URL, key, model, and last problem statement persist in localStorage for quick reruns.

## Getting Started

1. **Install dependencies**: none – open `index.html` in any modern browser.
2. **Configure credentials**:
   - API Base URL (e.g., `https://api.openai.com/v1`).
   - API Key (compatible with the selected endpoint).
   - Model (defaults to `gpt-5-mini`).
3. **Choose a problem**: click a card from the hero grid or type your own brief.
4. **Run Agents**: the architect streams the plan, each agent executes in turn, and the conclusion agent provides the final deliverable while the flow diagram updates live.

## Customization

- **Starter cards**: edit `config.json` to add/remove objects in the `problems` array.
- **UI styling**: tweak Tailwind-like utilities in `index.html` or add custom CSS.
- **Agent behavior**: adjust prompts or limits inside `script.js` (e.g., update `ARCHITECT_PROMPT`, change word count constraints, or modify flow-node heuristics).

## Deployment

Because everything is static, deploy via any static host (GitHub Pages, Netlify, Vercel, S3, etc.). Just ensure `config.json` is served alongside `index.html` so the problem cards load.

Enjoy orchestrating agents without any backend glue!
