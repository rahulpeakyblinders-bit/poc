import { useState, useEffect, useRef, useCallback } from 'react';

const COMMANDS = [
  { trigger: '@SRE Agent <query>', icon: '🛡️', desc: 'Route to the SRE Agent for incident triage and runbook execution' },
  { trigger: '@Detection <query>', icon: '🔍', desc: 'Detection Agent — find anomalies and alerts in Elasticsearch' },
  { trigger: '@RootCause <query>', icon: '🧠', desc: 'Root Cause Agent — deep-dive analysis with ES|QL' },
  { trigger: '@FixProposal <query>', icon: '🔧', desc: 'Fix Proposal Agent — generate remediation steps' },
  { trigger: '@ElasticAnalyst <query>', icon: '📊', desc: 'Elastic Analyst — data exploration and dashboards' },
  { trigger: '@AgentSwarm <query>', icon: '🐝', desc: 'Run the full pipeline: Detection → Root Cause → Fix Proposal in sequence' },
];

const SETUP_STEPS = [
  {
    num: '1', title: 'Create an Azure Bot',
    desc: 'Go to portal.azure.com → Create a resource → Azure Bot. Fill in the bot handle and choose "Multi Tenant" for type.',
    link: 'https://portal.azure.com/#create/Microsoft.AzureBot', linkText: 'Open Azure Portal →',
  },
  {
    num: '2', title: 'Register a Microsoft Entra App',
    desc: 'In the Azure Bot resource, go to Configuration → Manage. Note your App ID and create a new Client Secret. Add both to your .env file.',
    code: 'MICROSOFT_APP_ID=your-app-id\nMICROSOFT_APP_PASSWORD=your-client-secret',
  },
  {
    num: '3', title: 'Set the Messaging Endpoint',
    desc: 'Back in your Azure Bot → Configuration, set the Messaging endpoint to your server URL:',
    code: 'https://your-domain.railway.app/api/teams/messages',
  },
  {
    num: '4', title: 'Enable the Teams Channel',
    desc: 'In the Azure Bot → Channels, click "Microsoft Teams" and enable it.',
    link: 'https://learn.microsoft.com/en-us/azure/bot-service/channel-connect-teams', linkText: 'Teams Channel docs →',
  },
  {
    num: '5', title: 'Install the Bot in Teams',
    desc: 'Go to Teams Developer Portal → Apps → New App. Under Bots, add your bot ID. Download the app package and sideload it into your Teams channel.',
    link: 'https://dev.teams.microsoft.com', linkText: 'Teams Developer Portal →',
  },
];

// ─── Recall.ai Live Panel ────────────────────────────────────────────────────

function RecallLivePanel() {
  const [recallStatus, setRecallStatus] = useState(null);
  const [meetingUrl, setMeetingUrl] = useState('');
  const [botName, setBotName] = useState('Elastic AI Agent');
  const [activeBots, setActiveBots] = useState([]);
  const [events, setEvents] = useState([]);
  const [joining, setJoining] = useState(false);
  const sseRef = useRef(null);
  const feedRef = useRef(null);

  useEffect(() => {
    fetch('/api/recall/status').then(r => r.json()).then(setRecallStatus).catch(() => {});
    fetch('/api/recall/bots').then(r => r.json()).then(d => setActiveBots(d.bots || [])).catch(() => {});
  }, []);

  // Connect SSE for live events
  useEffect(() => {
    const es = new EventSource('/api/recall/live');
    sseRef.current = es;
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.event === 'connected') return;
        setEvents(prev => [{ id: Date.now(), ts: new Date().toLocaleTimeString(), ...data }, ...prev].slice(0, 200));
        if (data.event === 'bot_joined') setActiveBots(prev => [...prev, { id: data.botId, meetingUrl: data.meetingUrl, botName: data.botName }]);
        if (data.event === 'bot_left') setActiveBots(prev => prev.filter(b => b.id !== data.botId));
      } catch {}
    };
    return () => es.close();
  }, []);

  // Auto-scroll feed
  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = 0;
  }, [events]);

  const joinMeeting = useCallback(async () => {
    if (!meetingUrl.trim() || joining) return;
    setJoining(true);
    try {
      const resp = await fetch('/api/recall/bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetingUrl, botName }),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      setMeetingUrl('');
    } catch (err) {
      setEvents(prev => [{ id: Date.now(), ts: new Date().toLocaleTimeString(), event: 'error', error: err.message }, ...prev]);
    }
    setJoining(false);
  }, [meetingUrl, botName, joining]);

  const leaveBot = useCallback(async (botId) => {
    try {
      await fetch(`/api/recall/bot/${botId}`, { method: 'DELETE' });
    } catch {}
  }, []);

  function eventBubble(ev) {
    switch (ev.event) {
      case 'transcript':
        return (
          <div key={ev.id} className="recall-event transcript">
            <span className="recall-speaker">{ev.speaker}</span>
            <span className="recall-text">{ev.text}</span>
            <span className="recall-ts">{ev.ts}</span>
          </div>
        );
      case 'partial':
        return (
          <div key={ev.id} className="recall-event partial">
            <span className="recall-speaker">{ev.speaker}</span>
            <span className="recall-text dim">{ev.text}</span>
          </div>
        );
      case 'agent_thinking':
        return (
          <div key={ev.id} className="recall-event agent-thinking">
            <span>⚡ {ev.agentLabel} is responding…</span>
            <span className="recall-ts">{ev.ts}</span>
          </div>
        );
      case 'agent_response':
        return (
          <div key={ev.id} className="recall-event agent-response">
            <div className="recall-agent-label">{ev.agentLabel}</div>
            <div className="recall-agent-text">{ev.text}</div>
            <span className="recall-ts">{ev.ts}</span>
          </div>
        );
      case 'participant_join':
        return <div key={ev.id} className="recall-event system">👋 {ev.name} joined <span className="recall-ts">{ev.ts}</span></div>;
      case 'participant_leave':
        return <div key={ev.id} className="recall-event system">👋 {ev.name} left <span className="recall-ts">{ev.ts}</span></div>;
      case 'bot_joined':
        return <div key={ev.id} className="recall-event system">🤖 Bot joined the meeting <span className="recall-ts">{ev.ts}</span></div>;
      case 'bot_left':
        return <div key={ev.id} className="recall-event system">🤖 Bot left the meeting <span className="recall-ts">{ev.ts}</span></div>;
      case 'error':
        return <div key={ev.id} className="recall-event error">❌ {ev.error} <span className="recall-ts">{ev.ts}</span></div>;
      default:
        return null;
    }
  }

  return (
    <div className="teams-section recall-section">
      {/* Header */}
      <div className="recall-header">
        <div>
          <h3>🎙️ Live Meeting Bot <span className="recall-badge">via Recall.ai</span></h3>
          <p>
            Send an AI bot into any Teams call. It listens in real-time — when someone says
            <em> "SRE", "Detection", "Root Cause", "Agent Swarm"</em> etc., the agent responds
            instantly in the meeting chat.
          </p>
        </div>
        <div className={`teams-status-card ${recallStatus?.configured ? 'configured' : 'unconfigured'}`} style={{ minWidth: 200 }}>
          <div className="teams-status-icon">{recallStatus?.configured ? '✅' : '⚙️'}</div>
          <div>
            <strong>{recallStatus?.configured ? 'Recall.ai Ready' : 'Not Configured'}</strong>
            <p>{recallStatus?.configured ? recallStatus.baseUrl : 'Add RECALL_API_KEY to .env'}</p>
          </div>
        </div>
      </div>

      {/* Join meeting */}
      <div className="recall-join-row">
        <input
          className="teams-input"
          placeholder="Teams meeting URL (https://teams.microsoft.com/l/meetup-join/...)"
          value={meetingUrl}
          onChange={e => setMeetingUrl(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && joinMeeting()}
        />
        <input
          className="teams-input"
          style={{ maxWidth: 200 }}
          placeholder="Bot name"
          value={botName}
          onChange={e => setBotName(e.target.value)}
        />
        <button className="primary" onClick={joinMeeting} disabled={joining || !meetingUrl.trim()}>
          {joining ? 'Joining…' : '🤖 Join Meeting'}
        </button>
      </div>

      {/* Active bots */}
      {activeBots.length > 0 && (
        <div className="recall-bots">
          {activeBots.map(bot => (
            <div key={bot.id} className="recall-bot-chip">
              <span>🟢 {bot.botName || 'Bot'} — {bot.meetingUrl?.slice(0, 50)}…</span>
              <button className="recall-leave-btn" onClick={() => leaveBot(bot.id)}>Leave</button>
            </div>
          ))}
        </div>
      )}

      {/* Trigger keywords */}
      <div className="recall-keywords">
        <strong>Trigger keywords (spoken aloud):</strong>
        <div className="recall-keyword-chips">
          {['sre', 'detection', 'root cause', 'fix proposal', 'elastic analyst', 'agent swarm'].map(k => (
            <span key={k} className="recall-chip">"{k}"</span>
          ))}
        </div>
      </div>

      {/* Live feed */}
      <div className="recall-feed" ref={feedRef}>
        {events.length === 0 ? (
          <div className="recall-empty">
            Live transcript and agent responses will appear here once a bot joins a meeting.
          </div>
        ) : (
          events.map(ev => eventBubble(ev))
        )}
      </div>

      {/* Env var */}
      <div className="teams-code-row" style={{ marginTop: 4 }}>
        <code>RECALL_API_KEY=your-recall-api-key</code>
        <a href="https://us-east-1.recall.ai/dashboard/developers/api-keys" target="_blank" rel="noreferrer" className="copy-btn" style={{ textDecoration: 'none' }}>
          Get API Key →
        </a>
      </div>
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function TeamsIntegration() {
  const [status, setStatus] = useState(null);
  const [testQuery, setTestQuery] = useState('');
  const [testResult, setTestResult] = useState('');
  const [testAgent, setTestAgent] = useState('sre');
  const [isTesting, setIsTesting] = useState(false);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    fetch('/api/teams/status').then(r => r.json()).then(setStatus).catch(() => setStatus({ configured: false }));
  }, []);

  async function runTest() {
    if (!testQuery.trim() || isTesting) return;
    setIsTesting(true);
    setTestResult('');
    try {
      const resp = await fetch(`/api/a2a/${testAgent}/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: testQuery }),
      });
      const data = await resp.json();
      setTestResult(data.message || data.error || JSON.stringify(data));
    } catch (err) {
      setTestResult(`Error: ${err.message}`);
    }
    setIsTesting(false);
  }

  function copyToClipboard(text, key) {
    navigator.clipboard.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(''), 2000); });
  }

  const webhookUrl = `${window.location.origin}/api/teams/messages`;

  return (
    <div className="teams-page">
      {/* Header */}
      <div className="teams-header">
        <div>
          <span className="badge">Microsoft Teams</span>
          <h2>Teams Bot Integration</h2>
          <p>
            Two ways to bring your SRE agents into Teams: <strong>channel bot</strong> (reply to @mentions)
            and <strong>live meeting bot</strong> via Recall.ai (listens to voice in real-time).
          </p>
        </div>
        <div className={`teams-status-card ${status?.configured ? 'configured' : 'unconfigured'}`}>
          <div className="teams-status-icon">{status?.configured ? '✅' : '⚙️'}</div>
          <div>
            <strong>{status?.configured ? 'Channel Bot Connected' : 'Channel Bot Not Configured'}</strong>
            <p>{status?.configured ? `App ID: ${status.appId}` : 'Set MICROSOFT_APP_ID + APP_PASSWORD'}</p>
          </div>
        </div>
      </div>

      {/* ── Recall.ai Live Panel ── */}
      <RecallLivePanel />

      {/* Webhook URL */}
      <div className="teams-section">
        <h3>Channel Bot Webhook URL</h3>
        <p>Paste this into Azure Bot → Configuration → Messaging endpoint:</p>
        <div className="teams-code-row">
          <code>{webhookUrl}</code>
          <button className="copy-btn" onClick={() => copyToClipboard(webhookUrl, 'webhook')}>
            {copied === 'webhook' ? '✓ Copied' : 'Copy'}
          </button>
        </div>
      </div>

      {/* Commands */}
      <div className="teams-section">
        <h3>Channel Bot Commands</h3>
        <p>In any Teams channel or meeting chat, @mention the bot then use:</p>
        <div className="teams-commands">
          {COMMANDS.map((cmd) => (
            <div key={cmd.trigger} className="teams-command-card">
              <span className="teams-cmd-icon">{cmd.icon}</span>
              <div>
                <code>{cmd.trigger}</code>
                <p>{cmd.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Live Test */}
      <div className="teams-section">
        <h3>🧪 Test an Agent</h3>
        <p>Test Kibana agents directly without Teams:</p>
        <div className="teams-test-row">
          <select value={testAgent} onChange={e => setTestAgent(e.target.value)} className="teams-select">
            <option value="sre">SRE Agent</option>
            <option value="detection_agent">Detection Agent</option>
            <option value="root_cause_agent">Root Cause Agent</option>
            <option value="solution_agent">Fix Proposal Agent</option>
            <option value="analyst">Elastic Analyst</option>
          </select>
          <input
            className="teams-input"
            placeholder="e.g. Check for high error rates in the last hour"
            value={testQuery}
            onChange={e => setTestQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && runTest()}
          />
          <button className="primary" onClick={runTest} disabled={isTesting || !testQuery.trim()}>
            {isTesting ? 'Running…' : 'Test →'}
          </button>
        </div>
        {testResult && <div className="teams-test-result"><pre>{testResult}</pre></div>}
      </div>

      {/* Setup Steps */}
      <div className="teams-section">
        <h3>Channel Bot Setup Guide</h3>
        <p>Follow these steps to connect the channel bot to Microsoft Teams:</p>
        <div className="teams-steps">
          {SETUP_STEPS.map((step) => (
            <div key={step.num} className="teams-step">
              <div className="teams-step-num">{step.num}</div>
              <div className="teams-step-body">
                <strong>{step.title}</strong>
                <p>{step.desc}</p>
                {step.code && (
                  <div className="teams-code-row">
                    <code>{step.code}</code>
                    <button className="copy-btn" onClick={() => copyToClipboard(step.code, step.num)}>
                      {copied === step.num ? '✓' : 'Copy'}
                    </button>
                  </div>
                )}
                {step.link && <a href={step.link} target="_blank" rel="noreferrer" className="teams-link">{step.linkText}</a>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Env vars */}
      <div className="teams-section">
        <h3>All Environment Variables</h3>
        <div className="teams-code-row">
          <code style={{ whiteSpace: 'pre' }}>
{`# Channel Bot (Azure)
MICROSOFT_APP_ID=your-azure-bot-app-id
MICROSOFT_APP_PASSWORD=your-azure-bot-client-secret

# Live Meeting Bot (Recall.ai)
RECALL_API_KEY=your-recall-api-key
RECALL_API_BASE=https://us-east-1.recall.ai/api/v1`}
          </code>
          <button className="copy-btn" onClick={() => copyToClipboard(`MICROSOFT_APP_ID=\nMICROSOFT_APP_PASSWORD=\nRECALL_API_KEY=\nRECALL_API_BASE=https://us-east-1.recall.ai/api/v1`, 'env')}>
            {copied === 'env' ? '✓ Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}
