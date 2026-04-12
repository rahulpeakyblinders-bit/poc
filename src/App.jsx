import { useState, useCallback, useRef } from 'react';
import { agents, timeline, integrations } from './agents.js';
import VoiceAgent from './pages/VoiceAgent.jsx';
import AgentBuilder from './pages/AgentBuilder.jsx';
import TeamsIntegration from './pages/TeamsIntegration.jsx';

const LIVE_INCIDENT_QUERY = 'Check for any incidents or issues in the last 7 days. Look for anomalies, errors, and service degradations across all indices.';

const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'voice', label: 'Voice Agent' },
  { id: 'builder', label: 'Agent Builder' },
  { id: 'teams', label: '💬 Teams' },
];

function Dashboard({ onViewLiveIncidents, onLaunchAgent }) {
  return (
    <>
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
            <button type="button" className="primary" onClick={onViewLiveIncidents}>
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
          {agents.filter(a => a.name !== 'Narrator Agent').map((agent) => (
            <article key={agent.name} className="agent-card">
              <div className="agent-header">
                <h3>{agent.name}</h3>
                <span>{agent.focus}</span>
              </div>
              <p className="agent-summary">{agent.responsibilities[0]}</p>
              <button type="button" className="launch-btn" onClick={() => onLaunchAgent(agent.name)}>
                Launch →
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
    </>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [voiceAutoQuery, setVoiceAutoQuery] = useState(null);
  const [voiceLaunchAgent, setVoiceLaunchAgent] = useState(null);
  const launchConsumedRef = useRef(false);

  const handleViewLiveIncidents = useCallback(() => {
    setVoiceAutoQuery(LIVE_INCIDENT_QUERY);
    setActiveTab('voice');
  }, []);

  const handleLaunchAgent = useCallback((agentName) => {
    launchConsumedRef.current = false;
    setVoiceLaunchAgent(agentName);
    setActiveTab('voice');
  }, []);

  return (
    <div className="page">
      <nav className="app-nav">
        <div className="nav-brand">
          <span className="badge">⚡ Elastic AI</span>
        </div>
        <div className="nav-tabs">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`nav-tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </nav>

      {activeTab === 'dashboard' && (
        <Dashboard
          onViewLiveIncidents={handleViewLiveIncidents}
          onLaunchAgent={handleLaunchAgent}
        />
      )}
      {activeTab === 'voice' && (
        <VoiceAgent
          autoQuery={voiceAutoQuery}
          onAutoQueryConsumed={() => setVoiceAutoQuery(null)}
          launchAgent={voiceLaunchAgent}
        />
      )}
      {activeTab === 'builder' && <AgentBuilder />}
      {activeTab === 'teams' && <TeamsIntegration />}
    </div>
  );
}
