# Autonomous Incident Commander (Multi-Agent Swarm)

**AI SRE team powered by Elasticsearch**

## What it does
Instead of one agent, this system spins up multiple specialized agents that collaborate to handle production incidents end-to-end.

## Architecture
### Detection Agent
- Watches logs, metrics, and traces in Elasticsearch.
- Uses anomaly detection + ES|QL to identify emerging incidents.

### Root Cause Agent
- Correlates logs across services.
- Builds a dependency graph (service → error → config → deploy).

### Fix Proposal Agent
- Searches runbooks, Git commits, and past incidents for likely remediations.

### Action Agent
- Executes safe actions (restart pod, rollback deploy, scale infra).

### Narrator Agent
- Writes a human-readable postmortem.

## Agent orchestration
Every agent is managed with the Elastic A2A server:
https://www.elastic.co/docs/explore-analyze/ai-features/agent-builder/a2a-server

This keeps agent identity, permissions, and action traces centralized for safe execution.

## MCP server configuration (Elastic A2A)
Use the Elastic A2A MCP endpoint to manage tools and create agents. Keep credentials out of source control by exporting environment variables locally.

```bash
export ELASTIC_MCP_URL="https://your-mcp-endpoint.example.com/api/agent_builder/mcp"
export ELASTIC_URL="https://your-elasticsearch-endpoint.example.com:443"
export ELASTIC_API_KEY="YOUR_API_KEY"
```

From there, connect your MCP client to `${ELASTIC_MCP_URL}` and register tools/agents with the A2A server using your MCP client of choice. Store API keys in your secret manager or local `.env` file (do not commit secrets).

## Web UI
A React-based web UI highlights each agent, their responsibilities, and the incident workflow. It is designed for demos and stakeholder reviews.

### Run locally
```bash
python -m http.server 4173
```
Then open `http://localhost:4173`.

## Why judges love it
- Demonstrates Elastic’s core strengths (logs, observability, correlation).
- True multi-step reasoning across agents.
- Clear enterprise value.
- Easily demo-able with simulated outages.

## Bonus
Add a confidence score before auto-actions to enable **human-in-the-loop** approvals.
