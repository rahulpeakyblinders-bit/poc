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
- Uses Elastic A2A server to manage agent identity, permissions, and audit trails.

### Narrator Agent
- Writes a human-readable postmortem.

## Agent orchestration
Every agent is managed with the Elastic A2A server:
https://www.elastic.co/docs/explore-analyze/ai-features/agent-builder/a2a-server

This keeps agent identity, permissions, and action traces centralized for safe execution.

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
