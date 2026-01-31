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

## Why judges love it
- Demonstrates Elastic’s core strengths (logs, observability, correlation).
- True multi-step reasoning across agents.
- Clear enterprise value.
- Easily demo-able with simulated outages.

## Bonus
Add a confidence score before auto-actions to enable **human-in-the-loop** approvals.
