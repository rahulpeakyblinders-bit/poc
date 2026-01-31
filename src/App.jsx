import { agents, timeline, integrations } from './agents.js';

function App() {
  return (
    <div className="page">
      <header className="hero">
        <div>
          <span className="badge">AI SRE Team</span>
          <h1>Autonomous Incident Commander</h1>
          <p>
            Multi-agent swarm powered by Elasticsearch. Each agent is orchestrated
            via the Elastic A2A server to detect, diagnose, and resolve incidents
            with confidence.
          </p>
          <div className="hero-actions">
            <button type="button" className="primary">
              View Live Incidents
            </button>
            <button type="button" className="ghost">
              Review Agent Playbooks
            </button>
          </div>
        </div>
        <div className="hero-panel">
          <h3>Managed via Elastic A2A</h3>
          <p>
            Every agent lifecycle is governed by the Elastic A2A server for
            identity, permissions, and audit-ready action traces.
          </p>
          <div className="hero-metrics">
            <div>
              <span>5</span>
              <p>Specialized agents</p>
            </div>
            <div>
              <span>24/7</span>
              <p>Elastic monitoring</p>
            </div>
            <div>
              <span>92%</span>
              <p>Confidence before action</p>
            </div>
          </div>
        </div>
      </header>

      <section className="section">
        <div className="section-header">
          <div>
            <h2>Agent Overview</h2>
            <p>
              Specialized agents collaborate across the incident lifecycle with
              shared context and real-time Elasticsearch signals.
            </p>
          </div>
          <button type="button" className="secondary">
            Add Agent
          </button>
        </div>
        <div className="agent-grid">
          {agents.map((agent) => (
            <article key={agent.name} className="agent-card">
              <div className="agent-header">
                <h3>{agent.name}</h3>
                <span>{agent.focus}</span>
              </div>
              <ul>
                {agent.responsibilities.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <button type="button" className="link">
                View details →
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="section workflow">
        <div>
          <h2>Incident Workflow</h2>
          <p>
            A coordinated flow from detection to resolution keeps operations
            resilient while maintaining human oversight.
          </p>
          <ol>
            {timeline.map((step) => (
              <li key={step.label}>
                <strong>{step.label}</strong>
                <span>{step.detail}</span>
              </li>
            ))}
          </ol>
        </div>
        <aside className="insights">
          <h3>Integrated Controls</h3>
          <p>
            Every action is routed through the A2A server, ensuring secure
            execution and full auditability.
          </p>
          <ul>
            {integrations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </aside>
      </section>

      <section className="section summary">
        <h2>Enterprise-ready by design</h2>
        <div className="summary-grid">
          <div>
            <h4>Elastic strengths on display</h4>
            <p>Observability, correlation, and ES|QL intelligence in one place.</p>
          </div>
          <div>
            <h4>Multi-agent coordination</h4>
            <p>Agents share context to reduce MTTR and avoid redundant efforts.</p>
          </div>
          <div>
            <h4>Human-in-the-loop safety</h4>
            <p>Confidence scoring and approvals keep teams in control.</p>
          </div>
        </div>
      </section>
    </div>
  );
}

export default App;
