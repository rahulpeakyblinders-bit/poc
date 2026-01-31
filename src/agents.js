export const agents = [
  {
    name: 'Detection Agent',
    focus: 'Signals & anomalies',
    responsibilities: [
      'Continuously monitors logs, metrics, and traces in Elasticsearch.',
      'Runs anomaly detection and ES|QL queries to surface emerging incidents.',
      'Assigns severity and detects incident clusters.'
    ]
  },
  {
    name: 'Root Cause Agent',
    focus: 'Correlation & dependency mapping',
    responsibilities: [
      'Correlates signals across services and environments.',
      'Builds a dependency graph: service → error → config → deploy.',
      'Highlights the most likely blast radius and root cause.'
    ]
  },
  {
    name: 'Fix Proposal Agent',
    focus: 'Remediation intelligence',
    responsibilities: [
      'Searches runbooks, Git history, and past incidents.',
      'Ranks remediation options with expected impact and risk.',
      'Packages the top candidates for approval.'
    ]
  },
  {
    name: 'Action Agent',
    focus: 'Safe execution',
    responsibilities: [
      'Executes only approved actions (restart, rollback, scale).',
      'Runs changes through the A2A server for control and audit.',
      'Reports real-time status back to the swarm.'
    ]
  },
  {
    name: 'Narrator Agent',
    focus: 'Human-facing storytelling',
    responsibilities: [
      'Produces a human-readable postmortem.',
      'Summarizes impact, detection time, and mitigation steps.',
      'Captures follow-up tasks for continuous improvement.'
    ]
  }
];

export const timeline = [
  {
    label: 'Detect',
    detail: 'Anomaly detection and ES|QL alerts stream in.'
  },
  {
    label: 'Diagnose',
    detail: 'Cross-service correlation maps the blast radius.'
  },
  {
    label: 'Recommend',
    detail: 'Runbooks and prior incidents suggest fixes.'
  },
  {
    label: 'Act',
    detail: 'A2A server gates safe automated actions.'
  },
  {
    label: 'Report',
    detail: 'Postmortem captured and shared with stakeholders.'
  }
];

export const integrations = [
  'Elastic A2A server to manage and audit each agent.',
  'Elastic Observability data sources across logs, metrics, and traces.',
  'Confidence scoring before any auto-action for human-in-the-loop approvals.'
];
