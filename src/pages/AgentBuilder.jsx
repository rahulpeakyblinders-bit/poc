import { useState, useEffect } from 'react';

const MODELS = [
  { id: 'claude-opus-4-6', label: 'Opus 4.6', desc: 'Most powerful · Adaptive thinking', source: 'anthropic' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', desc: 'Balanced · Fast', source: 'anthropic' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', desc: 'Fastest · Cost efficient', source: 'anthropic' },
  { id: '.anthropic-claude-4.5-sonnet-completion', label: 'Claude 4.5 Sonnet', desc: '⚡ Elastic Inference · On-cluster', source: 'elastic' },
];

const TOOL_OPTIONS = [
  { id: 'elasticsearch', label: 'Elasticsearch Query', icon: '🔍' },
  { id: 'anomaly_detection', label: 'Anomaly Detection', icon: '📊' },
  { id: 'runbook_search', label: 'Runbook Search', icon: '📋' },
  { id: 'git_history', label: 'Git History', icon: '🔀' },
  { id: 'a2a_server', label: 'A2A Server', icon: '🔗' },
  { id: 'alert_manager', label: 'Alert Manager', icon: '🔔' },
  { id: 'web_search', label: 'Web Search', icon: '🌐' },
  { id: 'code_execution', label: 'Code Execution', icon: '💻' },
];

const EMPTY_FORM = {
  name: '',
  description: '',
  systemPrompt: '',
  model: 'claude-opus-4-6',
  tools: [],
};

const PROMPT_TEMPLATES = [
  {
    label: 'Security Analyst',
    name: 'Security Analyst Agent',
    description: 'Monitors SIEM alerts and threat signals',
    systemPrompt:
      'You are an expert Elastic Security analyst. You monitor SIEM alerts, correlate threat signals across logs and network events, triage incidents by severity, and provide actionable incident response guidance. Be precise and structured. Always reference specific alert IDs or log patterns when available.',
  },
  {
    label: 'APM Expert',
    name: 'APM Performance Agent',
    description: 'Analyzes application performance and traces',
    systemPrompt:
      'You are an Elastic APM expert. You analyze distributed traces, identify latency bottlenecks, detect memory leaks and CPU spikes, and correlate application performance with infrastructure metrics. Provide root cause analysis with specific service names, span durations, and error rates.',
  },
  {
    label: 'Log Analyst',
    name: 'Log Analysis Agent',
    description: 'Deep log parsing and pattern detection',
    systemPrompt:
      'You are an Elastic log analysis expert. You parse structured and unstructured logs, identify error patterns, build ES|QL queries for investigation, and surface anomalies across log streams. Always suggest actionable queries and filters.',
  },
];

export default function AgentBuilder() {
  const [form, setForm] = useState(EMPTY_FORM);
  const [builtAgents, setBuiltAgents] = useState([]);
  const [kibanaAgents, setKibanaAgents] = useState([]);
  const [kibanaLoading, setKibanaLoading] = useState(false);
  const [kibanaError, setKibanaError] = useState(null);
  const [activeTab, setActiveTab] = useState('build');
  const [testState, setTestState] = useState({}); // { [agentId]: { prompt, response, loading } }
  const [deployState, setDeployState] = useState({}); // { [agentId]: 'idle'|'deploying'|'done'|'error' }
  const [kibanaChat, setKibanaChat] = useState({}); // { [agentId]: { prompt, messages, loading, conversationId } }

  const toggleTool = (toolId) => {
    setForm((f) => ({
      ...f,
      tools: f.tools.includes(toolId) ? f.tools.filter((t) => t !== toolId) : [...f.tools, toolId],
    }));
  };

  const applyTemplate = (template) => {
    setForm((f) => ({
      ...f,
      name: template.name,
      description: template.description,
      systemPrompt: template.systemPrompt,
    }));
  };

  const handleBuild = () => {
    if (!form.name.trim() || !form.systemPrompt.trim()) return;
    const agent = { ...form, id: Date.now(), createdAt: new Date().toISOString() };
    setBuiltAgents((prev) => [agent, ...prev]);
    setForm(EMPTY_FORM);
    setActiveTab('agents');
  };

  const deleteAgent = (id) => {
    setBuiltAgents((prev) => prev.filter((a) => a.id !== id));
    setTestState((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const handleTest = async (agent) => {
    const prompt = testState[agent.id]?.prompt || '';
    if (!prompt.trim()) return;

    setTestState((prev) => ({ ...prev, [agent.id]: { ...prev[agent.id], response: '', loading: true } }));

    const isElasticInference = agent.model === '.anthropic-claude-4.5-sonnet-completion';
    let full = '';

    try {
      const res = await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          systemPrompt: agent.systemPrompt,
          model: agent.model,
          useElasticInference: isElasticInference,
        }),
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        for (const line of decoder.decode(value).split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6);
          if (raw === '[DONE]') break;
          try {
            const { text, error } = JSON.parse(raw);
            if (error) throw new Error(error);
            if (text) {
              full += text;
              setTestState((prev) => ({
                ...prev,
                [agent.id]: { ...prev[agent.id], response: full, loading: true },
              }));
            }
          } catch {}
        }
      }
    } catch (err) {
      full = `Error: ${err.message}`;
    }

    setTestState((prev) => ({
      ...prev,
      [agent.id]: { ...prev[agent.id], response: full, loading: false },
    }));
  };

  // Deploy a locally-built agent to Kibana Agent Builder
  const deployToKibana = async (agent) => {
    setDeployState((prev) => ({ ...prev, [agent.id]: 'deploying' }));
    try {
      const resp = await fetch('/api/kibana/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: agent.name,
          description: agent.description || '',
          instructions: agent.systemPrompt,
          model: agent.model === '.anthropic-claude-4.5-sonnet-completion'
            ? ELASTIC_INFERENCE_MODEL
            : agent.model,
        }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      setDeployState((prev) => ({ ...prev, [agent.id]: 'done' }));
      // Refresh Kibana agents list if on that tab
      if (activeTab === 'kibana') fetchKibanaAgents();
    } catch (err) {
      setDeployState((prev) => ({ ...prev, [agent.id]: 'error:' + err.message }));
    }
  };

  // Fetch Kibana agents
  const fetchKibanaAgents = async () => {
    setKibanaLoading(true);
    setKibanaError(null);
    try {
      const resp = await fetch('/api/kibana/agents');
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      setKibanaAgents(data.results || data.agents || data.data || (Array.isArray(data) ? data : []));
    } catch (err) {
      setKibanaError(err.message);
    } finally {
      setKibanaLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'kibana') fetchKibanaAgents();
  }, [activeTab]);

  // Chat with a Kibana agent via the converse API
  const chatWithKibanaAgent = async (agent) => {
    const prompt = kibanaChat[agent.id]?.prompt || '';
    if (!prompt.trim()) return;

    const userMsg = { role: 'user', text: prompt };
    setKibanaChat((prev) => ({
      ...prev,
      [agent.id]: {
        ...prev[agent.id],
        prompt: '',
        loading: true,
        messages: [...(prev[agent.id]?.messages || []), userMsg, { role: 'assistant', text: '', streaming: true }],
      },
    }));

    let full = '';
    let newConversationId = kibanaChat[agent.id]?.conversationId;

    try {
      const res = await fetch('/api/kibana/converse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: agent.id,
          message: prompt,
          conversationId: newConversationId,
        }),
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value).split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6);
          if (raw === '[DONE]') break;
          try {
            const event = JSON.parse(raw);
            if (event.error) {
              full = `⚠️ ${event.error}`;
            } else if (event.final) {
              if (!full && event.text) full = event.text;
            } else if (event.text) {
              full += event.text;
            } else if (event.reasoning) {
              full += `_${event.reasoning}_\n\n`;
            } else if (event.toolCall) {
              full += `\`[${event.toolCall}]\` `;
            } else if (event.toolProgress) {
              full += `_${event.toolProgress}…_ `;
            } else if (event.conversationId) {
              newConversationId = event.conversationId;
            }
            setKibanaChat((prev) => {
              const msgs = [...(prev[agent.id]?.messages || [])];
              msgs[msgs.length - 1] = { role: 'assistant', text: full, streaming: true };
              return { ...prev, [agent.id]: { ...prev[agent.id], messages: msgs, conversationId: newConversationId } };
            });
          } catch {}
        }
      }
    } catch (err) {
      full = `Error: ${err.message}`;
    }

    setKibanaChat((prev) => {
      const msgs = [...(prev[agent.id]?.messages || [])];
      msgs[msgs.length - 1] = { role: 'assistant', text: full, streaming: false };
      return { ...prev, [agent.id]: { ...prev[agent.id], messages: msgs, loading: false, conversationId: newConversationId } };
    });
  };

  const modelLabel = (modelId) => MODELS.find((m) => m.id === modelId)?.label || modelId;

  const ELASTIC_INFERENCE_MODEL = '.anthropic-claude-4.5-sonnet-completion';

  return (
    <div className="agent-builder-page">
      <div className="builder-header">
        <div>
          <h2>Elastic Agent Builder</h2>
          <p>Create, configure, and test custom AI agents powered by Claude</p>
        </div>
      </div>

      <div className="builder-tab-bar">
        <button
          className={`tab-btn ${activeTab === 'build' ? 'active' : ''}`}
          onClick={() => setActiveTab('build')}
        >
          Build Agent
        </button>
        <button
          className={`tab-btn ${activeTab === 'agents' ? 'active' : ''}`}
          onClick={() => setActiveTab('agents')}
        >
          My Agents
          {builtAgents.length > 0 && (
            <span className="tab-count">{builtAgents.length}</span>
          )}
        </button>
        <button
          className={`tab-btn ${activeTab === 'kibana' ? 'active' : ''}`}
          onClick={() => setActiveTab('kibana')}
        >
          Kibana Agents
          {kibanaAgents.length > 0 && (
            <span className="tab-count kibana-count">{kibanaAgents.length}</span>
          )}
        </button>
      </div>

      {/* ── BUILD TAB ── */}
      {activeTab === 'build' && (
        <div className="builder-form">
          {/* Quick templates */}
          <div className="form-group">
            <label>Quick Templates</label>
            <div className="template-row">
              {PROMPT_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.label}
                  className="template-chip"
                  onClick={() => applyTemplate(tpl)}
                >
                  {tpl.label}
                </button>
              ))}
            </div>
          </div>

          <div className="form-grid-2">
            <div className="form-group">
              <label>Agent Name <span className="required">*</span></label>
              <input
                type="text"
                placeholder="e.g. Security Analyst Agent"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="form-group">
              <label>Description</label>
              <input
                type="text"
                placeholder="What does this agent do?"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
          </div>

          <div className="form-group">
            <label>
              System Prompt <span className="required">*</span>
            </label>
            <textarea
              rows={7}
              placeholder="You are an expert Elastic observability engineer. You analyze signals from Elasticsearch, correlate metrics, and provide clear remediation steps..."
              value={form.systemPrompt}
              onChange={(e) => setForm((f) => ({ ...f, systemPrompt: e.target.value }))}
            />
            <span className="char-count">{form.systemPrompt.length} chars</span>
          </div>

          <div className="form-group">
            <label>Model</label>
            <div className="model-selector">
              {MODELS.map((m) => (
                <button
                  key={m.id}
                  className={`model-chip ${form.model === m.id ? 'active' : ''} ${m.source === 'elastic' ? 'elastic-model' : ''}`}
                  onClick={() => setForm((f) => ({ ...f, model: m.id }))
                  }
                >
                  <strong>{m.label}</strong>
                  <span>{m.desc}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="form-group">
            <label>Elastic Tools & Integrations</label>
            <div className="tools-grid">
              {TOOL_OPTIONS.map((tool) => (
                <button
                  key={tool.id}
                  className={`tool-chip ${form.tools.includes(tool.id) ? 'active' : ''}`}
                  onClick={() => toggleTool(tool.id)}
                >
                  <span className="tool-icon">{tool.icon}</span>
                  {tool.label}
                </button>
              ))}
            </div>
          </div>

          <div className="builder-actions">
            <button
              className="primary build-btn"
              onClick={handleBuild}
              disabled={!form.name.trim() || !form.systemPrompt.trim()}
            >
              Build Agent →
            </button>
            <button className="ghost" onClick={() => setForm(EMPTY_FORM)}>
              Reset
            </button>
          </div>
        </div>
      )}

      {/* ── MY AGENTS TAB ── */}
      {activeTab === 'agents' && (
        <div className="agents-list-section">
          {builtAgents.length === 0 ? (
            <div className="empty-agents">
              <p>No agents built yet.</p>
              <button className="secondary" onClick={() => setActiveTab('build')}>
                Build your first agent →
              </button>
            </div>
          ) : (
            <div className="built-agents-grid">
              {builtAgents.map((agent) => {
                const ts = testState[agent.id] || {};
                const ds = deployState[agent.id] || 'idle';
                return (
                  <div key={agent.id} className="built-agent-card">
                    <div className="built-agent-header">
                      <div className="built-agent-title">
                        <div className="built-agent-avatar">{agent.name[0]}</div>
                        <div>
                          <h3>{agent.name}</h3>
                          {agent.description && <span>{agent.description}</span>}
                        </div>
                      </div>
                      <button className="delete-btn" onClick={() => deleteAgent(agent.id)} title="Delete agent">
                        ✕
                      </button>
                    </div>

                    <div className="agent-meta-row">
                      <span className="meta-tag model-tag">{modelLabel(agent.model)}</span>
                      {agent.tools.length > 0 && (
                        <span className="meta-tag">{agent.tools.length} tool{agent.tools.length !== 1 ? 's' : ''}</span>
                      )}
                    </div>

                    <div className="system-prompt-preview">
                      {agent.systemPrompt.slice(0, 140)}
                      {agent.systemPrompt.length > 140 ? '…' : ''}
                    </div>

                    {agent.tools.length > 0 && (
                      <div className="agent-tools-preview">
                        {agent.tools.map((t) => {
                          const tool = TOOL_OPTIONS.find((o) => o.id === t);
                          return tool ? (
                            <span key={t} className="tool-mini-tag">{tool.icon} {tool.label}</span>
                          ) : null;
                        })}
                      </div>
                    )}

                    {/* Deploy to Kibana button */}
                    <div className="deploy-row">
                      <button
                        className={`deploy-kibana-btn ${ds === 'done' ? 'done' : ds === 'deploying' ? 'deploying' : ds.startsWith('error') ? 'error' : ''}`}
                        onClick={() => deployToKibana(agent)}
                        disabled={ds === 'deploying' || ds === 'done'}
                        title="Save this agent to Kibana Agent Builder"
                      >
                        {ds === 'deploying' ? '⏳ Deploying…' : ds === 'done' ? '✓ Deployed to Kibana' : ds.startsWith('error') ? '⚠ Deploy failed' : '⚡ Deploy to Kibana'}
                      </button>
                      {ds.startsWith('error') && (
                        <span className="deploy-error-msg">{ds.replace('error:', '')}</span>
                      )}
                    </div>

                    {/* Test panel */}
                    <div className="test-panel">
                      <div className="test-input-row">
                        <input
                          type="text"
                          className="test-input"
                          placeholder="Test with a prompt…"
                          value={ts.prompt || ''}
                          onChange={(e) =>
                            setTestState((prev) => ({
                              ...prev,
                              [agent.id]: { ...prev[agent.id], prompt: e.target.value },
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && ts.prompt?.trim()) handleTest(agent);
                          }}
                          disabled={ts.loading}
                        />
                        <button
                          className="primary"
                          onClick={() => handleTest(agent)}
                          disabled={ts.loading || !ts.prompt?.trim()}
                        >
                          {ts.loading ? '…' : 'Run'}
                        </button>
                      </div>

                      {ts.response && (
                        <div className="test-response">
                          <div className="test-response-label">Response</div>
                          <p>{ts.response}</p>
                          {ts.loading && <span className="cursor-blink" />}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── KIBANA AGENTS TAB ── */}
      {activeTab === 'kibana' && (
        <div className="agents-list-section">
          <div className="kibana-agents-header">
            <span className="kibana-source-label">⚡ Elastic Agent Builder · Kibana</span>
            <button className="ghost refresh-btn" onClick={fetchKibanaAgents} disabled={kibanaLoading}>
              {kibanaLoading ? 'Loading…' : '↻ Refresh'}
            </button>
          </div>

          {kibanaError && (
            <div className="kibana-error">
              <strong>Could not load Kibana agents:</strong> {kibanaError}
              <p>Make sure KIBANA_ENDPOINT and ELASTIC_API_KEY are set in your .env file.</p>
            </div>
          )}

          {!kibanaError && !kibanaLoading && kibanaAgents.length === 0 && (
            <div className="empty-agents">
              <p>No agents found in Kibana Agent Builder.</p>
              <button className="secondary" onClick={() => setActiveTab('build')}>
                Build and deploy an agent →
              </button>
            </div>
          )}

          {kibanaAgents.length > 0 && (
            <div className="built-agents-grid">
              {kibanaAgents.map((agent) => (
                <div key={agent.id} className="built-agent-card kibana-agent-card">
                  <div className="built-agent-header">
                    <div className="built-agent-title">
                      <div className="built-agent-avatar kibana-avatar">{(agent.name || 'K')[0]}</div>
                      <div>
                        <h3>{agent.name || agent.title || 'Unnamed Agent'}</h3>
                        {agent.description && <span>{agent.description}</span>}
                      </div>
                    </div>
                    <span className="kibana-badge">Kibana</span>
                  </div>

                  {(agent.instructions || agent.system_prompt) && (
                    <div className="system-prompt-preview">
                      {(agent.instructions || agent.system_prompt || '').slice(0, 140)}
                      {(agent.instructions || agent.system_prompt || '').length > 140 ? '…' : ''}
                    </div>
                  )}

                  {agent.tools && agent.tools.length > 0 && (
                    <div className="agent-tools-preview">
                      {agent.tools.map((t, i) => (
                        <span key={i} className="tool-mini-tag">🔧 {t.name || t}</span>
                      ))}
                    </div>
                  )}

                  <div className="agent-meta-row">
                    {agent.model && <span className="meta-tag model-tag">{agent.model}</span>}
                    <span className="meta-tag kibana-tag">ID: {agent.id}</span>
                  </div>

                  {/* Chat panel — converse directly with this Kibana agent */}
                  {(() => {
                    const kc = kibanaChat[agent.id] || {};
                    return (
                      <div className="test-panel kibana-chat-panel">
                        {kc.messages && kc.messages.length > 0 && (
                          <div className="kibana-chat-messages">
                            {kc.messages.map((msg, mi) => (
                              <div key={mi} className={`kibana-chat-msg ${msg.role}`}>
                                <span className="kibana-chat-role">{msg.role === 'user' ? 'You' : agent.name?.split(' ')[0] || 'Agent'}</span>
                                <span className="kibana-chat-text">
                                  {msg.text || (msg.streaming && <span className="thinking-dots"><span /><span /><span /></span>)}
                                  {msg.streaming && msg.text && <span className="cursor-blink" />}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="test-input-row">
                          <input
                            type="text"
                            className="test-input"
                            placeholder={`Ask ${agent.name || 'this agent'}…`}
                            value={kc.prompt || ''}
                            onChange={(e) =>
                              setKibanaChat((prev) => ({ ...prev, [agent.id]: { ...prev[agent.id], prompt: e.target.value } }))
                            }
                            onKeyDown={(e) => { if (e.key === 'Enter' && kc.prompt?.trim()) chatWithKibanaAgent(agent); }}
                            disabled={kc.loading}
                          />
                          <button
                            className="primary"
                            onClick={() => chatWithKibanaAgent(agent)}
                            disabled={kc.loading || !kc.prompt?.trim()}
                          >
                            {kc.loading ? '…' : 'Chat'}
                          </button>
                        </div>
                        {kc.conversationId && (
                          <div className="kibana-conv-id">
                            <span>Conv: {kc.conversationId.slice(0, 8)}…</span>
                            <button className="ghost" style={{fontSize:'0.7rem', padding:'1px 6px'}}
                              onClick={() => setKibanaChat((prev) => ({ ...prev, [agent.id]: {} }))}>
                              New chat
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
