import { useState, useRef, useEffect, useCallback } from 'react';
import { agents } from '../agents.js';

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

export default function VoiceAgent() {
  const [selectedAgent, setSelectedAgent] = useState(agents[0]);
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [conversation, setConversation] = useState([]);
  const [isThinking, setIsThinking] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [serverStatus, setServerStatus] = useState('checking');
  const [elasticStatus, setElasticStatus] = useState(null);
  const [mcpStatus, setMcpStatus] = useState(null); // { connected, tools }

  const recognitionRef = useRef(null);
  const conversationEndRef = useRef(null);
  const messagesRef = useRef([]);

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

  const speak = useCallback((text) => {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text.slice(0, 600));
    utterance.rate = 1.05;
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.speak(utterance);
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
    recognition.onresult = (event) => {
      let final = '', interim = '';
      for (const result of event.results) {
        if (result.isFinal) final += result[0].transcript;
        else interim += result[0].transcript;
      }
      setTranscript(final || interim);
    };
    recognition.onend = () => setIsListening(false);
    recognition.onerror = (e) => { if (e.error !== 'no-speech') console.error(e.error); setIsListening(false); };
    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
    setTranscript('');
  }, []);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setIsListening(false);
  }, []);

  const handleMicClick = useCallback(() => {
    if (isListening) {
      stopListening();
      setTimeout(() => {
        setTranscript((t) => { if (t.trim()) sendMessage(t); return t; });
      }, 400);
    } else {
      startListening();
    }
  }, [isListening, startListening, stopListening, sendMessage]);

  const clearConversation = () => {
    setConversation([]);
    messagesRef.current = [];
    window.speechSynthesis?.cancel();
    setIsSpeaking(false);
  };

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
        {agents.map((agent) => (
          <button
            key={agent.name}
            className={`agent-chip ${selectedAgent.name === agent.name ? 'active' : ''}`}
            onClick={() => { setSelectedAgent(agent); clearConversation(); }}
          >
            {agent.name}
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
          <div key={i} className={`voice-bubble ${msg.role}`}>
            {msg.role === 'assistant' && (
              <div className={`voice-bubble-avatar ${isSpeaking && i === conversation.length - 1 ? 'speaking' : ''}`}>
                {selectedAgent.name[0]}
              </div>
            )}
            <div className="voice-bubble-content">
              {/* Tool calls indicator */}
              {msg.role === 'assistant' && msg.toolCalls?.length > 0 && (
                <div className="tool-calls-strip">
                  {msg.toolCalls.map((tc, ti) => (
                    <span key={ti} className={`tool-call-pill ${tc.status} ${tc.name.startsWith('mcp__') ? 'mcp-tool' : ''}`}>
                      <span>{tc.name.startsWith('mcp__') ? '🤖' : (TOOL_ICONS[tc.name] || '🔧')}</span>
                      {tc.name.startsWith('mcp__') ? tc.name.replace(/^mcp__/, '').replace(/_/g, ' ') : tc.name.replace(/_/g, ' ')}
                      {tc.status === 'running' && <span className="tool-spinner" />}
                      {tc.status === 'done' && <span className="tool-check">✓</span>}
                    </span>
                  ))}
                </div>
              )}
              <div className="voice-bubble-text">
                {msg.text || (msg.streaming && isThinking && !msg.text && (
                  <span className="thinking-dots"><span /><span /><span /></span>
                ))}
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
            <button className="primary send-btn" onClick={() => sendMessage(transcript)} disabled={isThinking}>
              {isThinking ? 'Querying…' : 'Send →'}
            </button>
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
