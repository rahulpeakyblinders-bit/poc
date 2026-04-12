import { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { agents } from '../agents.js';

// SRE Kibana agent used as the Initiator agent in Voice Mode
const SRE_KIBANA_AGENT = {
  name: 'SRE Agent',
  focus: 'Initiator · Kibana',
  kibana: true,
  initiator: true,
  kibanaId: 'sre',
  responsibilities: [
    'First point of contact for any SRE or incident query.',
    'Routes to Detection, Root Cause, and Fix Proposal agents as needed.',
    'Backed by Kibana Agent Builder with live Elastic tools.',
  ],
};

// Kibana-backed Detection Agent replaces the local one
const DETECTION_KIBANA_AGENT = {
  name: 'Detection Agent',
  focus: 'Signals & anomalies · Kibana',
  kibana: true,
  kibanaId: 'detection_agent',
  responsibilities: [
    'Continuously monitors logs, metrics, and traces in Elasticsearch.',
    'Runs anomaly detection and ES|QL queries to surface emerging incidents.',
    'Assigns severity and detects incident clusters.',
  ],
};

// Kibana-backed Root Cause Agent replaces the local one
const ROOT_CAUSE_KIBANA_AGENT = {
  name: 'Root Cause Agent',
  focus: 'Correlation & dependency mapping · Kibana',
  kibana: true,
  kibanaId: 'root_cause_agent',
  responsibilities: [
    'Correlates signals across services and environments.',
    'Builds a dependency graph: service → error → config → deploy.',
    'Highlights the most likely blast radius and root cause.',
  ],
};

// Kibana-backed Fix Proposal Agent replaces the local one
const FIX_PROPOSAL_KIBANA_AGENT = {
  name: 'Fix Proposal Agent',
  focus: 'Remediation intelligence · Kibana',
  kibana: true,
  kibanaId: 'solution_agent',
  responsibilities: [
    'Searches runbooks, Git history, and past incidents.',
    'Ranks remediation options with expected impact and risk.',
    'Packages the top candidates for approval.',
  ],
};

// Kibana-backed Elastic Analyst Agent
const ELASTIC_ANALYST_KIBANA_AGENT = {
  name: 'Elastic Analyst',
  focus: 'Data exploration & insights · Kibana',
  kibana: true,
  kibanaId: 'analyst',
  responsibilities: [
    'Runs deep ES|QL and KQL queries across all Elasticsearch indices.',
    'Surfaces trends, patterns, and statistical insights from raw data.',
    'Answers ad-hoc data questions with live Elastic tooling.',
  ],
};

const AGENT_SYSTEM_PROMPTS = {
  'Detection Agent': `You are the Detection Agent for Elastic SRE. You have access to Elasticsearch tools to query real data.
When asked about incidents or anomalies:
1. First call get_cluster_health to assess the cluster state
2. Use list_indices to discover available log/metric indices
3. Use esql_query or search to find anomalies and error patterns
4. Use get_anomalies to surface ML-detected anomalies
Always cite the actual index names and field values you find. Be precise about severity.`,

  'Root Cause Agent': `You are the Root Cause Agent for Elastic SRE. You correlate signals across services using Elasticsearch tools.
When investigating an issue:
1. Search relevant indices (logs-*, metrics-*, traces-*) for error patterns
2. Use esql_query with GROUP BY to correlate errors across services
3. Use aggregate to find spike patterns in time windows
4. Build a dependency chain from the data you find
Always reference specific service names, error messages, and timestamps from the data.`,

  'Fix Proposal Agent': `You are the Fix Proposal Agent for Elastic SRE. You search past incidents and runbooks using Elasticsearch.
When proposing fixes:
1. Search .kibana* or runbook indices for relevant procedures
2. Use esql_query to find similar past incidents
3. Rank fixes by frequency of success in historical data
Present top 3 remediation options with risk scores based on actual data.`,

  'Action Agent': `You are the Action Agent for Elastic SRE. You verify system state before recommending any action.
Before recommending any action:
1. Use get_cluster_health to confirm cluster stability
2. Search relevant indices to verify current system state
3. Use aggregate to confirm the scope of impact
Always list preconditions, rollback steps, and expected outcomes. Never recommend irreversible actions without verification.`,

  'Narrator Agent': `You are the Narrator Agent for Elastic SRE. You produce human-readable postmortems from raw Elasticsearch data.
When creating a postmortem:
1. Query relevant time windows across log and metric indices
2. Use esql_query to extract timeline of events
3. Use aggregate to calculate impact metrics (error rates, affected users)
Structure output as: Summary → Timeline → Impact → Root Cause → Mitigation → Follow-up.`,
};

const TOOL_ICONS = {
  list_indices: '📋',
  search: '🔍',
  esql_query: '⚡',
  get_mappings: '🗂️',
  get_cluster_health: '💚',
  get_anomalies: '📊',
  aggregate: '📈',
};

const ALL_AGENTS = [
  SRE_KIBANA_AGENT,
  DETECTION_KIBANA_AGENT,
  ROOT_CAUSE_KIBANA_AGENT,
  FIX_PROPOSAL_KIBANA_AGENT,
  ...agents.filter(a => !['Detection Agent', 'Root Cause Agent', 'Fix Proposal Agent', 'Narrator Agent', 'Elastic Analyst'].includes(a.name)),
  ELASTIC_ANALYST_KIBANA_AGENT,
];

const DETECTION_AGENT = DETECTION_KIBANA_AGENT;

export default function VoiceAgent({ autoQuery, onAutoQueryConsumed, launchAgent }) {
  const [selectedAgent, setSelectedAgent] = useState(SRE_KIBANA_AGENT);
  const kibanaConversationIdRef = useRef(null);
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [conversation, setConversation] = useState([]);
  const [isThinking, setIsThinking] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPipelining, setIsPipelining] = useState(false);
  const [pipelineStep, setPipelineStep] = useState(null); // 'detection' | 'root_cause' | 'fix_proposal' | null
  const [lastFixProposal, setLastFixProposal] = useState(null); // text from Fix Proposal Agent
  const [workflowState, setWorkflowState] = useState(null);
  // workflowState: { phase: 'generating'|'ready'|'creating'|'running'|'done'|'error', yaml, workflowId, executionId, error }
  const [serverStatus, setServerStatus] = useState('checking');
  const [elasticStatus, setElasticStatus] = useState(null);
  const [mcpStatus, setMcpStatus] = useState(null); // { connected, tools }

  const recognitionRef = useRef(null);
  const conversationEndRef = useRef(null);
  const messagesRef = useRef([]);
  const sendMessageRef = useRef(null); // always points to latest sendMessage

  // Check server + Elastic health + MCP tools on mount
  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((data) => {
        setServerStatus('online');
        setElasticStatus(data.elastic);
      })
      .catch(() => setServerStatus('offline'));

    fetch('/api/mcp/tools')
      .then((r) => r.json())
      .then((data) => setMcpStatus(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [conversation]);

  // Launch a specific agent by name from the Dashboard
  useEffect(() => {
    if (!launchAgent) return;
    const match = ALL_AGENTS.find(a => a.name === launchAgent);
    if (match) {
      setSelectedAgent(match);
      kibanaConversationIdRef.current = null;
      setConversation([]);
      messagesRef.current = [];
    }
  }, [launchAgent]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-query: switch to Detection Agent and fire the query
  useEffect(() => {
    if (!autoQuery) return;
    setSelectedAgent(DETECTION_AGENT);
    kibanaConversationIdRef.current = null;
    setConversation([]);
    messagesRef.current = [];
    // Delay so React re-renders with new selectedAgent before sendMessage is called
    // Note: onAutoQueryConsumed is called inside the timer to avoid clearing it prematurely
    const t = setTimeout(() => {
      onAutoQueryConsumed?.();
      sendMessageRef.current?.(autoQuery);
    }, 400);
    return () => clearTimeout(t);
  }, [autoQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  const speak = useCallback((text) => {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    // Split into sentences to work around Chrome's ~200-char utterance bug
    const chunks = text.match(/[^.!?\n]+[.!?\n]*/g) ?? [text];
    let index = 0;
    const speakNext = () => {
      if (index >= chunks.length) { setIsSpeaking(false); return; }
      const utterance = new SpeechSynthesisUtterance(chunks[index++].trim());
      utterance.rate = 1.05;
      if (index === 1) utterance.onstart = () => setIsSpeaking(true);
      utterance.onend = speakNext;
      utterance.onerror = () => setIsSpeaking(false);
      window.speechSynthesis.speak(utterance);
    };
    speakNext();
  }, []);

  const sendMessage = useCallback(
    async (text) => {
      if (!text.trim() || isThinking) return;

      const userMsg = { role: 'user', content: text };
      const newMessages = [...messagesRef.current, userMsg];
      messagesRef.current = newMessages;

      // Add user bubble + empty assistant bubble
      setConversation((prev) => [
        ...prev,
        { role: 'user', text },
        { role: 'assistant', text: '', streaming: true, toolCalls: [] },
      ]);
      setTranscript('');
      setIsThinking(true);

      let fullResponse = '';
      let toolCalls = [];

      try {
        if (selectedAgent.kibana) {
          // ── Kibana Agent Builder path ──────────────────────────────────
          const res = await fetch('/api/kibana/converse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agentId: selectedAgent.kibanaId,
              message: text,
              conversationId: kibanaConversationIdRef.current,
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
                  fullResponse = `⚠️ ${event.error}`;
                } else if (event.text) {
                  fullResponse += event.text;
                } else if (event.reasoning) {
                  // skip reasoning in voice mode for conciseness
                } else if (event.toolCall) {
                  toolCalls = [...toolCalls, { name: event.toolCall, status: 'running' }];
                } else if (event.toolProgress) {
                  // update last tool call status
                  if (toolCalls.length > 0) {
                    toolCalls = toolCalls.map((tc, i) =>
                      i === toolCalls.length - 1 ? { ...tc, status: 'running', progress: event.toolProgress } : tc
                    );
                  }
                } else if (event.conversationId) {
                  kibanaConversationIdRef.current = event.conversationId;
                }
                setConversation((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: 'assistant', text: fullResponse, streaming: true, toolCalls: [...toolCalls],
                  };
                  return updated;
                });
              } catch {}
            }
          }
        } else {
          // ── Local Anthropic /api/chat path ─────────────────────────────
          const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messages: newMessages,
              systemPrompt: AGENT_SYSTEM_PROMPTS[selectedAgent.name],
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

                if (event.text) {
                  fullResponse += event.text;
                } else if (event.tool_call) {
                  toolCalls = [...toolCalls, { ...event.tool_call, status: 'running' }];
                } else if (event.tool_result) {
                  toolCalls = toolCalls.map((tc) =>
                    tc.name === event.tool_result.name
                      ? { ...tc, status: 'done', result: event.tool_result.result }
                      : tc
                  );
                } else if (event.error) {
                  fullResponse += `\n\n⚠️ ${event.error}`;
                }

                setConversation((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: 'assistant',
                    text: fullResponse,
                    streaming: true,
                    toolCalls: [...toolCalls],
                  };
                  return updated;
                });
              } catch {}
            }
          }
        }
      } catch (err) {
        fullResponse =
          serverStatus === 'offline'
            ? 'Server is offline. Start it with: npm run server'
            : `Error: ${err.message}`;
      }

      messagesRef.current = [
        ...messagesRef.current,
        { role: 'assistant', content: fullResponse },
      ];

      setConversation((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: 'assistant',
          text: fullResponse,
          streaming: false,
          toolCalls,
        };
        return updated;
      });

      setIsThinking(false);
      if (fullResponse && !fullResponse.startsWith('Error:')) speak(fullResponse);
    },
    [selectedAgent, isThinking, serverStatus, speak]
  );

  // Keep ref in sync so autoQuery effect always calls the latest sendMessage
  useEffect(() => { sendMessageRef.current = sendMessage; }, [sendMessage]);

  const startListening = useCallback(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Speech recognition requires Chrome or Edge.');
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    let capturedText = '';
    recognition.onresult = (event) => {
      let final = '', interim = '';
      for (const result of event.results) {
        if (result.isFinal) final += result[0].transcript;
        else interim += result[0].transcript;
      }
      capturedText = final || interim;
      setTranscript(capturedText);
    };
    // Auto-send as soon as speech ends — no button click needed
    recognition.onend = () => {
      setIsListening(false);
      if (capturedText.trim()) sendMessageRef.current?.(capturedText);
    };
    recognition.onerror = (e) => { if (e.error !== 'no-speech') console.error(e.error); setIsListening(false); };
    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
    setTranscript('');
  }, []);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    // onend will fire automatically and handle the send
  }, []);

  const handleMicClick = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, startListening, stopListening]);

  const clearConversation = () => {
    setConversation([]);
    messagesRef.current = [];
    kibanaConversationIdRef.current = null;
    window.speechSynthesis?.cancel();
    setIsSpeaking(false);
    setLastFixProposal(null);
    setWorkflowState(null);
  };

  // A2A multi-agent pipeline: Detection → Root Cause → Fix Proposal
  const PIPELINE_AGENTS = [
    { id: 'detection_agent',  label: 'Detection Agent',   step: 'detection',   color: '#7c3aed' },
    { id: 'root_cause_agent', label: 'Root Cause Agent',  step: 'root_cause',  color: '#0369a1' },
    { id: 'solution_agent',   label: 'Fix Proposal Agent', step: 'fix_proposal', color: '#065f46' },
  ];

  const runPipeline = useCallback(async (query) => {
    if (!query?.trim() || isPipelining) return;
    setIsPipelining(true);
    setTranscript('');
    setLastFixProposal(null);
    setWorkflowState(null);

    // Add user message once
    setConversation(prev => [...prev, { role: 'user', text: query }]);

    for (const agent of PIPELINE_AGENTS) {
      setPipelineStep(agent.step);
      // Add a "thinking" placeholder for this agent
      setConversation(prev => [...prev, {
        role: 'assistant',
        text: '',
        streaming: true,
        agentName: agent.label,
        agentColor: agent.color,
        agentStep: agent.step,
      }]);

      try {
        const res = await fetch(`/api/a2a/${agent.id}/task`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: query, taskId: `${agent.id}-${Date.now()}` }),
        });
        const data = await res.json();
        const text = data.error ? `⚠️ ${data.error}` : (data.message || '(no response)');

        // Capture Fix Proposal response for workflow deployment
        if (agent.step === 'fix_proposal' && !data.error) {
          setLastFixProposal(text);
        }

        // Replace placeholder with real response
        setConversation(prev => {
          const updated = [...prev];
          const last = updated.findLastIndex(m => m.agentName === agent.label && m.streaming);
          if (last !== -1) updated[last] = {
            role: 'assistant', text, agentName: agent.label, agentColor: agent.color, agentStep: agent.step,
          };
          return updated;
        });
      } catch (err) {
        setConversation(prev => {
          const updated = [...prev];
          const last = updated.findLastIndex(m => m.agentName === agent.label && m.streaming);
          if (last !== -1) updated[last] = {
            role: 'assistant', text: `⚠️ ${err.message}`, agentName: agent.label, agentColor: agent.color, agentStep: agent.step,
          };
          return updated;
        });
      }
    }

    setPipelineStep(null);
    setIsPipelining(false);
  }, [isPipelining]); // eslint-disable-line react-hooks/exhaustive-deps

  // Generate Elastic Workflow YAML from the last fix proposal
  const generateWorkflow = useCallback(async () => {
    if (!lastFixProposal) return;
    setWorkflowState({ phase: 'generating' });
    try {
      const res = await fetch('/api/workflows/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixProposal: lastFixProposal }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setWorkflowState({ phase: 'ready', yaml: data.yaml });
    } catch (err) {
      setWorkflowState({ phase: 'error', error: err.message });
    }
  }, [lastFixProposal]);

  // Create workflow in Kibana and run it
  const deployWorkflow = useCallback(async (yaml) => {
    setWorkflowState(prev => ({ ...prev, phase: 'creating' }));
    try {
      // 1. Create: POST /api/workflows/workflow  → returns { id, name, ... }
      const createRes = await fetch('/api/workflows/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml }),
      });
      const createData = await createRes.json();
      if (createData.error) throw new Error(`Create failed: ${createData.error}`);

      const workflowId = createData.id;
      setWorkflowState(prev => ({ ...prev, phase: 'running', workflowId }));

      if (workflowId) {
        // 2. Run: POST /api/workflows/workflow/{id}/run  → returns { workflowExecutionId }
        const runRes = await fetch(`/api/workflows/${workflowId}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inputs: {} }),
        });
        const runData = await runRes.json();
        if (runData.error) throw new Error(`Run failed: ${runData.error}`);
        // Kibana returns { workflowExecutionId: "exec-..." }
        const executionId = runData.workflowExecutionId || runData.id;
        setWorkflowState(prev => ({ ...prev, phase: 'done', workflowId, executionId }));
      } else {
        setWorkflowState(prev => ({ ...prev, phase: 'done' }));
      }
    } catch (err) {
      setWorkflowState(prev => ({ ...prev, phase: 'error', error: err.message }));
    }
  }, []);

  return (
    <div className="voice-agent-page">
      <div className="voice-agent-header">
        <div>
          <h2>Voice Mode Agent</h2>
          <p>Speak to your Elastic AI agent — it queries your cluster in real-time</p>
        </div>
        <div className="voice-header-actions">
          <span className={`server-badge ${serverStatus}`}>
            <span className="server-dot" />
            {serverStatus === 'online' ? 'Server online' : serverStatus === 'offline' ? 'Server offline' : 'Checking…'}
          </span>
          {elasticStatus && (
            <span className={`server-badge ${elasticStatus.status === 'green' ? 'online' : elasticStatus.status === 'yellow' ? 'yellow' : 'offline'}`}>
              <span className="server-dot" />
              Elastic {elasticStatus.status || 'unreachable'}
              {!elasticStatus.authenticated && ' · no key'}
            </span>
          )}
          {mcpStatus && (
            <span className={`server-badge ${mcpStatus.connected ? 'online' : 'offline'}`} title={mcpStatus.connected ? `${mcpStatus.tools.length} Elastic agents available` : 'MCP not connected'}>
              <span className="server-dot" />
              Agent Builder {mcpStatus.connected ? `· ${mcpStatus.tools.length} agents` : '· offline'}
            </span>
          )}
          {conversation.length > 0 && (
            <button className="ghost clear-btn" onClick={clearConversation}>Clear</button>
          )}
        </div>
      </div>

      {/* Agent selector */}
      <div className="agent-selector">
        {ALL_AGENTS.map((agent) => (
          <button
            key={agent.name}
            className={`agent-chip ${selectedAgent.name === agent.name ? 'active' : ''} ${agent.initiator ? 'kibana-initiator' : ''}`}
            onClick={() => {
              setSelectedAgent(agent);
              clearConversation();
              kibanaConversationIdRef.current = null;
            }}
          >
            {agent.initiator && <span className="kibana-chip-dot" />}
            {agent.name}
            {agent.initiator && <span className="initiator-badge">Initiator</span>}
          </button>
        ))}
      </div>

      {/* Elasticsearch cluster info bar */}
      {elasticStatus && elasticStatus.status && (
        <div className="es-info-bar">
          <span className="es-endpoint">⚡ {new URL('https://poc-fbce28.es.northeurope.azure.elastic.cloud').hostname}</span>
          {elasticStatus.number_of_nodes && <span className="es-stat">{elasticStatus.number_of_nodes} nodes</span>}
          {elasticStatus.indices_count && <span className="es-stat">{elasticStatus.indices_count} indices</span>}
          {elasticStatus.docs_count && <span className="es-stat">{Number(elasticStatus.docs_count).toLocaleString()} docs</span>}
          {!elasticStatus.authenticated && (
            <span className="es-warn">Set ELASTIC_API_KEY to query</span>
          )}
        </div>
      )}

      {/* Conversation */}
      <div className="voice-conversation">
        {conversation.length === 0 && (
          <div className="voice-empty">
            <div className="voice-agent-avatar">
              <span>{selectedAgent.name[0]}</span>
              {isSpeaking && <div className="avatar-ring" />}
            </div>
            <p className="voice-empty-name">{selectedAgent.name}</p>
            <span className="voice-empty-focus">{selectedAgent.focus}</span>
            <p className="voice-empty-hint">Ask about incidents, anomalies, logs — it will query Elasticsearch live</p>
          </div>
        )}

        {conversation.map((msg, i) => (
          <div key={i} className={`voice-bubble ${msg.role} ${msg.agentName ? 'pipeline-bubble' : ''}`}>
            {msg.role === 'assistant' && (
              <div
                className={`voice-bubble-avatar ${isSpeaking && i === conversation.length - 1 ? 'speaking' : ''}`}
                style={msg.agentColor ? { background: msg.agentColor } : undefined}
              >
                {(msg.agentName || selectedAgent.name)[0]}
              </div>
            )}
            <div className="voice-bubble-content">
              {msg.agentName && (
                <span className="pipeline-agent-label" style={{ color: msg.agentColor }}>
                  {msg.agentName}
                </span>
              )}
              <div className="voice-bubble-text">
                {msg.role === 'assistant' ? (
                  msg.text ? (
                    <ReactMarkdown>{msg.text}</ReactMarkdown>
                  ) : ((msg.streaming) && (
                    <span className="thinking-dots"><span /><span /><span /></span>
                  ))
                ) : (
                  msg.text
                )}
                {msg.streaming && msg.text && <span className="cursor-blink" />}
              </div>
            </div>
          </div>
        ))}
        <div ref={conversationEndRef} />
      </div>

      {/* Input area */}
      <div className="voice-input-area">
        <div className="voice-input-row">
          <textarea
            className="voice-text-input"
            placeholder={isListening ? 'Listening…' : 'Ask about your Elasticsearch cluster, incidents, anomalies…'}
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && transcript.trim()) { e.preventDefault(); sendMessage(transcript); } }}
            rows={2}
            disabled={isThinking}
          />
          <button
            className={`mic-btn ${isListening ? 'listening' : ''} ${isThinking ? 'disabled' : ''}`}
            onClick={handleMicClick}
            disabled={isThinking}
            title={isListening ? 'Stop and send' : 'Start voice input'}
          >
            {isListening ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="2" width="6" height="13" rx="3" fill="currentColor" stroke="none" />
                <path d="M5 10a7 7 0 0014 0" />
                <line x1="12" y1="19" x2="12" y2="22" />
                <line x1="8" y1="22" x2="16" y2="22" />
              </svg>
            )}
          </button>
        </div>

        <div className="voice-controls">
          {transcript.trim() && !isListening && (
            <>
              <button className="primary send-btn" onClick={() => sendMessage(transcript)} disabled={isThinking || isPipelining}>
                {isThinking ? 'Querying…' : 'Send →'}
              </button>
              <button className="pipeline-btn" onClick={() => runPipeline(transcript)} disabled={isThinking || isPipelining} title="Run Detection → Root Cause → Fix Proposal via A2A">
                🐝 Agent Swarm
              </button>
            </>
          )}
          {isPipelining && (
            <div className="pipeline-status">
              <span className="pipeline-dot" />
              {pipelineStep === 'detection' && 'Detection Agent analyzing…'}
              {pipelineStep === 'root_cause' && 'Root Cause Agent correlating…'}
              {pipelineStep === 'fix_proposal' && 'Fix Proposal Agent generating…'}
            </div>
          )}
          {/* Deploy Workflow — shown after Agent Swarm produces a Fix Proposal */}
          {lastFixProposal && !isPipelining && !workflowState && (
            <button className="workflow-deploy-btn" onClick={generateWorkflow} title="Generate an Elastic Workflow from the Fix Proposal and deploy it">
              🚀 Deploy Workflow
            </button>
          )}
          {workflowState && (
            <div className="workflow-panel">
              {workflowState.phase === 'generating' && (
                <div className="workflow-status generating">
                  <span className="pipeline-dot" /> Generating Elastic Workflow YAML…
                </div>
              )}
              {workflowState.phase === 'ready' && (
                <>
                  <div className="workflow-yaml-header">
                    <span className="workflow-label">⚡ Generated Workflow</span>
                    <div className="workflow-yaml-actions">
                      <button className="ghost workflow-copy-btn" onClick={() => navigator.clipboard?.writeText(workflowState.yaml)} title="Copy YAML">
                        📋 Copy
                      </button>
                      <button className="workflow-deploy-btn" onClick={() => deployWorkflow(workflowState.yaml)}>
                        ▶ Create &amp; Run in Kibana
                      </button>
                      <button className="ghost" onClick={() => setWorkflowState(null)} title="Dismiss">✕</button>
                    </div>
                  </div>
                  <pre className="workflow-yaml-preview">{workflowState.yaml}</pre>
                </>
              )}
              {workflowState.phase === 'creating' && (
                <div className="workflow-status creating">
                  <span className="pipeline-dot" /> Creating workflow in Kibana…
                </div>
              )}
              {workflowState.phase === 'running' && (
                <div className="workflow-status running">
                  <span className="pipeline-dot" /> Triggering workflow run…
                </div>
              )}
              {workflowState.phase === 'done' && (
                <div className="workflow-status done">
                  ✅ Workflow deployed{workflowState.workflowId ? ` · ID: ${workflowState.workflowId}` : ''}
                  {workflowState.executionId && <span> · Execution: {workflowState.executionId}</span>}
                  <button className="ghost workflow-dismiss" onClick={() => setWorkflowState(null)}>✕</button>
                </div>
              )}
              {workflowState.phase === 'error' && (
                <div className="workflow-status error">
                  ⚠️ {workflowState.error}
                  <button className="ghost workflow-dismiss" onClick={() => setWorkflowState(null)}>✕</button>
                </div>
              )}
            </div>
          )}
          {isSpeaking && (
            <button className="ghost" onClick={() => { window.speechSynthesis?.cancel(); setIsSpeaking(false); }}>
              ⏹ Stop speaking
            </button>
          )}
        </div>

        {isListening && (
          <div className="listening-indicator">
            <div className="wave-bars">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="wave-bar" style={{ animationDelay: `${i * 0.1}s` }} />
              ))}
            </div>
            <span>Listening — press mic to send</span>
          </div>
        )}
      </div>
    </div>
  );
}
