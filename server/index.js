import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { Client as ElasticClient } from '@elastic/elasticsearch';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ─── Clients ────────────────────────────────────────────────────────────────
const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ELASTIC_ENDPOINT = process.env.ELASTIC_ENDPOINT ||
  'https://poc-fbce28.es.northeurope.azure.elastic.cloud';
const ELASTIC_API_KEY = process.env.ELASTIC_API_KEY || '';
// Separate key for Kibana/Agent Builder — falls back to ELASTIC_API_KEY
const KIBANA_API_KEY = process.env.KIBANA_API_KEY || ELASTIC_API_KEY;

// Elastic Inference endpoint (Claude hosted on Elastic)
const ELASTIC_INFERENCE_ID = process.env.ELASTIC_INFERENCE_ID ||
  '.anthropic-claude-4.5-sonnet-completion';

const es = new ElasticClient({
  node: ELASTIC_ENDPOINT,
  auth: ELASTIC_API_KEY ? { apiKey: ELASTIC_API_KEY } : undefined,
  tls: { rejectUnauthorized: false },
});

// ─── Elastic Agent Builder MCP client ────────────────────────────────────────
const MCP_ENDPOINT = process.env.MCP_ENDPOINT ||
  'https://poc-fbce28.kb.northeurope.azure.elastic.cloud/api/agent_builder/mcp';

let mcpClient = null;
let mcpTools = []; // Raw MCP tool list (MCP format)
let mcpToolsForClaude = []; // Converted to Anthropic tool format

async function connectMCP() {
  if (!KIBANA_API_KEY) {
    console.log('   MCP:       Skipped (no KIBANA_API_KEY)');
    return;
  }
  try {
    const transport = new StreamableHTTPClientTransport(
      new URL(MCP_ENDPOINT),
      {
        requestInit: {
          headers: {
            'Authorization': `ApiKey ${KIBANA_API_KEY}`,
            'kbn-xsrf': 'true',
          },
        },
      }
    );

    mcpClient = new McpClient(
      { name: 'elastic-ai-voice-agent', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    await mcpClient.connect(transport);

    const { tools } = await mcpClient.listTools();
    mcpTools = tools;

    // Convert MCP tool schema → Anthropic tool format
    mcpToolsForClaude = tools.map(t => ({
      name: `mcp__${t.name.replace(/[^a-zA-Z0-9_]/g, '_')}`,
      description: `[Elastic Agent Builder] ${t.description || t.name}`,
      input_schema: t.inputSchema || { type: 'object', properties: {}, required: [] },
      _mcpName: t.name, // stash original name for routing
    }));

    console.log(`   MCP:       ✓ Connected — ${tools.length} agent${tools.length !== 1 ? 's' : ''} available`);
    tools.forEach(t => console.log(`              · ${t.name}`));
  } catch (err) {
    console.warn(`   MCP:       ✗ Could not connect (${err.message})`);
    mcpClient = null;
  }
}

// Call an Elastic Agent Builder MCP tool by its original name
async function callMcpTool(mcpName, args) {
  if (!mcpClient) return { error: 'MCP client not connected' };
  try {
    const result = await mcpClient.callTool({ name: mcpName, arguments: args });
    // MCP result content is array of { type, text } blocks
    const text = result.content?.map(c => c.text || JSON.stringify(c)).join('\n') || JSON.stringify(result);
    return { result: text, isError: result.isError };
  } catch (err) {
    return { error: err.message };
  }
}

// ─── Elastic Inference helper ────────────────────────────────────────────────
// Calls the Elastic Inference API using the Claude endpoint hosted on your cluster.
// Falls back to direct Anthropic API if Elastic key is not set.
async function callElasticInference({ messages, systemPrompt, stream = false }) {
  if (!ELASTIC_API_KEY) {
    // Fallback: use Anthropic directly
    return null;
  }

  // Build the chat_completion input for Elastic Inference API
  const chatMessages = [];
  if (systemPrompt) {
    chatMessages.push({ role: 'system', content: systemPrompt });
  }
  for (const m of messages) {
    chatMessages.push({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
  }

  const resp = await es.transport.request({
    method: 'POST',
    path: `/_inference/chat_completion/${ELASTIC_INFERENCE_ID}/_stream`,
    body: {
      messages: chatMessages,
    },
  });

  return resp;
}

app.use(cors({ origin: ['http://localhost:4173', 'http://127.0.0.1:4173'] }));
app.use(express.json());

// ─── Elasticsearch helpers ───────────────────────────────────────────────────
async function esQuery(toolName, input) {
  try {
    switch (toolName) {
      case 'list_indices': {
        // Serverless-compatible: use _resolve/index instead of _cat/indices
        try {
          const resp = await es.transport.request({ method: 'GET', path: '/_resolve/index/*' });
          const indices = (resp.indices || []).map(i => ({ index: i.name, aliases: i.aliases }));
          return { indices: indices.slice(0, 50) };
        } catch {
          // Fallback to cat indices
          const resp = await es.cat.indices({ format: 'json', h: 'index,health,status,docs.count,store.size' });
          return { indices: resp.map(i => ({ index: i.index, health: i.health, docs: i['docs.count'], size: i['store.size'] })) };
        }
      }

      case 'search': {
        const { index, query, size = 10, sort } = input;
        const resp = await es.search({
          index,
          size,
          query: query || { match_all: {} },
          ...(sort ? { sort } : {}),
        });
        return {
          total: resp.hits.total,
          hits: resp.hits.hits.map(h => ({ _index: h._index, _id: h._id, _score: h._score, ...h._source })),
        };
      }

      case 'esql_query': {
        const { query } = input;
        const resp = await es.transport.request({
          method: 'POST',
          path: '/_query',
          body: { query },
        });
        return resp;
      }

      case 'get_mappings': {
        const { index } = input;
        const resp = await es.indices.getMapping({ index });
        const fields = {};
        const mappings = Object.values(resp)[0]?.mappings?.properties || {};
        for (const [field, def] of Object.entries(mappings)) {
          fields[field] = def.type || 'object';
        }
        return { index, fields };
      }

      case 'get_cluster_health': {
        // Serverless-compatible: use root info endpoint
        try {
          const info = await es.transport.request({ method: 'GET', path: '/' });
          return {
            status: 'green',
            cluster_name: info.cluster_name || 'serverless',
            version: info.version?.number,
            tagline: info.tagline,
          };
        } catch (err) {
          return { status: 'unknown', error: err.message };
        }
      }

      case 'get_anomalies': {
        const { job_id, threshold = 75, size = 20 } = input;
        const resp = await es.search({
          index: '.ml-anomalies-*',
          size,
          query: {
            bool: {
              must: [
                { range: { record_score: { gte: threshold } } },
                ...(job_id ? [{ term: { job_id } }] : []),
              ],
            },
          },
          sort: [{ record_score: 'desc' }],
        });
        return {
          total: resp.hits.total,
          anomalies: resp.hits.hits.map(h => ({
            job_id: h._source.job_id,
            score: h._source.record_score,
            time: h._source.timestamp,
            detector: h._source.detector_description,
            actual: h._source.actual,
            typical: h._source.typical,
          })),
        };
      }

      case 'aggregate': {
        const { index, field, agg_type = 'terms', size = 10, date_histogram } = input;
        let aggs = {};
        if (agg_type === 'terms') {
          aggs = { result: { terms: { field, size } } };
        } else if (agg_type === 'date_histogram') {
          aggs = { result: { date_histogram: { field, calendar_interval: date_histogram || '1h' } } };
        } else if (agg_type === 'avg' || agg_type === 'sum' || agg_type === 'max' || agg_type === 'min') {
          aggs = { result: { [agg_type]: { field } } };
        }
        const resp = await es.search({ index, size: 0, aggs });
        return { aggs: resp.aggregations };
      }

      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    return { error: err.message, details: err.meta?.body?.error };
  }
}

// ─── Claude tool definitions ─────────────────────────────────────────────────
const ES_TOOLS = [
  {
    name: 'list_indices',
    description: 'List all Elasticsearch indices with health, document count, and size.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'search',
    description: 'Search documents in an Elasticsearch index using a DSL query.',
    input_schema: {
      type: 'object',
      properties: {
        index: { type: 'string', description: 'Index name or pattern (e.g. logs-*, metrics-*)' },
        query: { type: 'object', description: 'Elasticsearch query DSL object. Omit for match_all.' },
        size: { type: 'number', description: 'Max results to return (default 10)' },
        sort: { type: 'array', description: 'Sort specification array' },
      },
      required: ['index'],
    },
  },
  {
    name: 'esql_query',
    description: 'Run an ES|QL query against Elasticsearch for analytics and aggregations.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'ES|QL query string, e.g. FROM logs-* | STATS count() BY service.name' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_mappings',
    description: 'Get field mappings and types for an Elasticsearch index.',
    input_schema: {
      type: 'object',
      properties: {
        index: { type: 'string', description: 'Index name' },
      },
      required: ['index'],
    },
  },
  {
    name: 'get_cluster_health',
    description: 'Get Elasticsearch cluster health status, node count, and shard info.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_anomalies',
    description: 'Fetch ML anomaly detection results above a score threshold.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'ML job ID filter (optional)' },
        threshold: { type: 'number', description: 'Minimum anomaly score 0-100 (default 75)' },
        size: { type: 'number', description: 'Max results (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'aggregate',
    description: 'Run aggregations on Elasticsearch data: terms, date_histogram, avg, sum, max, min.',
    input_schema: {
      type: 'object',
      properties: {
        index: { type: 'string', description: 'Index name or pattern' },
        field: { type: 'string', description: 'Field to aggregate on' },
        agg_type: { type: 'string', enum: ['terms', 'date_histogram', 'avg', 'sum', 'max', 'min'], description: 'Aggregation type' },
        size: { type: 'number', description: 'Bucket count for terms agg (default 10)' },
        date_histogram: { type: 'string', description: 'Calendar interval for date_histogram (e.g. 1h, 1d)' },
      },
      required: ['index', 'field'],
    },
  },
];

// ─── Agentic loop with tool use + SSE streaming ──────────────────────────────
async function runAgentLoop(res, { messages, systemPrompt, model = 'claude-opus-4-6', useEsTools = true }) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Combine ES tools + Elastic Agent Builder MCP tools
  const tools = [
    ...(useEsTools ? ES_TOOLS : []),
    ...mcpToolsForClaude,
  ];
  const currentMessages = [...messages];

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  try {
    // Agentic loop — continues until Claude stops calling tools
    for (let turn = 0; turn < 10; turn++) {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 4096,
        thinking: { type: 'adaptive' },
        system: systemPrompt || 'You are a helpful Elastic AI assistant. Use the provided Elasticsearch tools to fetch real data when answering questions.',
        tools,
        messages: currentMessages,
      });

      // Stream text blocks as they appear in this response
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          send({ text: block.text });
        }
      }

      // If Claude is done, stop
      if (response.stop_reason === 'end_turn') break;

      // Handle tool calls
      if (response.stop_reason === 'tool_use') {
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

        // Append assistant turn
        currentMessages.push({ role: 'assistant', content: response.content });

        // Execute all tool calls — route to ES or MCP based on name prefix
        const toolResults = [];
        for (const toolBlock of toolUseBlocks) {
          send({ tool_call: { name: toolBlock.name, input: toolBlock.input } });

          let result;
          if (toolBlock.name.startsWith('mcp__')) {
            // Find original MCP tool name
            const mcpTool = mcpToolsForClaude.find(t => t.name === toolBlock.name);
            const mcpName = mcpTool?._mcpName || toolBlock.name.replace(/^mcp__/, '');
            result = await callMcpTool(mcpName, toolBlock.input);
          } else {
            result = await esQuery(toolBlock.name, toolBlock.input);
          }

          send({ tool_result: { name: toolBlock.name, result } });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: JSON.stringify(result),
          });
        }

        // Append tool results and continue loop
        currentMessages.push({ role: 'user', content: toolResults });
        continue;
      }

      break;
    }
  } catch (err) {
    console.error('Agent loop error:', err.message);
    send({ error: err.message });
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

// ─── Elastic Inference streaming route ───────────────────────────────────────
// Uses the Claude endpoint hosted on your Elastic cluster directly.
// Falls back to Anthropic SDK if ELASTIC_API_KEY is not set.
async function runElasticInferenceStream(res, { messages, systemPrompt }) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  // If no Elastic API key, fall back to Anthropic API
  if (!ELASTIC_API_KEY) {
    send({ text: '⚠️ No ELASTIC_API_KEY set. Falling back to Anthropic API...\n\n' });
    await runAgentLoop(res, { messages, systemPrompt, useEsTools: true });
    return;
  }

  try {
    // Build messages array for Elastic Inference chat_completion
    const chatMessages = [];
    if (systemPrompt) chatMessages.push({ role: 'system', content: systemPrompt });
    for (const m of messages) {
      chatMessages.push({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      });
    }

    // Elastic Inference API — task_type is "completion" so use that path
    // Build a single prompt string from the messages
    const promptText = chatMessages
      .map(m => `${m.role === 'system' ? '[System]' : m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n') + '\nAssistant:';

    const response = await es.transport.request({
      method: 'POST',
      path: `/_inference/completion/${ELASTIC_INFERENCE_ID}`,
      body: { input: promptText },
      asStream: false,
    });

    // Non-streaming completion response
    const completionText = response?.completion?.[0]?.result ||
      response?.results?.[0]?.completions?.[0]?.snippet?.text ||
      JSON.stringify(response);

    send({ text: completionText, source: 'elastic-inference' });
  } catch (err) {
    console.error('Elastic Inference error:', err.message);
    send({ error: `Elastic Inference error: ${err.message}` });
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Voice agent chat (multi-turn, with ES tools via Anthropic)
app.post('/api/chat', async (req, res) => {
  const { messages, systemPrompt, model } = req.body;
  await runAgentLoop(res, { messages, systemPrompt, model, useEsTools: true });
});

// Elastic Inference chat — uses Claude hosted on your Elastic cluster
app.post('/api/elastic-inference', async (req, res) => {
  const { messages, systemPrompt } = req.body;
  await runElasticInferenceStream(res, { messages, systemPrompt });
});

// Agent builder test run — supports both Anthropic and Elastic Inference
app.post('/api/agent/run', async (req, res) => {
  const { prompt, systemPrompt, model, useElasticInference = false } = req.body;
  if (useElasticInference) {
    await runElasticInferenceStream(res, {
      messages: [{ role: 'user', content: prompt }],
      systemPrompt,
    });
  } else {
    await runAgentLoop(res, {
      messages: [{ role: 'user', content: prompt }],
      systemPrompt,
      model,
      useEsTools: true,
    });
  }
});

// Health check — verifies ES + Inference connectivity
app.get('/api/health', async (_req, res) => {
  let elasticStatus = { status: 'unreachable', endpoint: ELASTIC_ENDPOINT, authenticated: !!ELASTIC_API_KEY };
  let inferenceStatus = { endpoint: ELASTIC_INFERENCE_ID, available: false };

  try {
    // Use serverless-compatible root info endpoint
    const info = await es.transport.request({ method: 'GET', path: '/' });
    elasticStatus = {
      status: 'green',
      endpoint: ELASTIC_ENDPOINT,
      authenticated: !!ELASTIC_API_KEY,
      cluster_name: info.cluster_name,
      version: info.version?.number,
    };
  } catch (err) {
    elasticStatus.error = err.message;
  }

  try {
    if (ELASTIC_API_KEY) {
      const inf = await es.transport.request({
        method: 'GET',
        path: `/_inference/${ELASTIC_INFERENCE_ID}`,
      });
      inferenceStatus = { endpoint: ELASTIC_INFERENCE_ID, available: true, info: inf };
    }
  } catch (err) {
    inferenceStatus.error = err.message;
  }

  res.json({
    status: 'ok',
    model: 'claude-opus-4-6',
    elastic: elasticStatus,
    inference: inferenceStatus,
  });
});

// Direct ES proxy routes
app.get('/api/elastic/indices', async (_req, res) => {
  res.json(await esQuery('list_indices', {}));
});

app.get('/api/elastic/health', async (_req, res) => {
  res.json(await esQuery('get_cluster_health', {}));
});

// ─── Kibana Agent Builder REST API proxy ─────────────────────────────────────
const KIBANA_ENDPOINT = process.env.KIBANA_ENDPOINT ||
  'https://poc-fbce28.kb.northeurope.azure.elastic.cloud';

function kibanaHeaders() {
  return {
    'Authorization': `ApiKey ${KIBANA_API_KEY}`,
    'Content-Type': 'application/json',
    'kbn-xsrf': 'true',
  };
}

async function kibanaFetch(path, options = {}) {
  const url = `${KIBANA_ENDPOINT}${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: { ...kibanaHeaders(), ...(options.headers || {}) },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Kibana ${resp.status}: ${body}`);
  }
  return resp.json();
}

// List Kibana agents
app.get('/api/kibana/agents', async (_req, res) => {
  try {
    const data = await kibanaFetch('/api/agent_builder/agents');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get a single Kibana agent
app.get('/api/kibana/agents/:id', async (req, res) => {
  try {
    const data = await kibanaFetch(`/api/agent_builder/agents/${req.params.id}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a Kibana agent
app.post('/api/kibana/agents', async (req, res) => {
  try {
    const data = await kibanaFetch('/api/agent_builder/agents', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a Kibana agent
app.put('/api/kibana/agents/:id', async (req, res) => {
  try {
    const data = await kibanaFetch(`/api/agent_builder/agents/${req.params.id}`, {
      method: 'PUT',
      body: JSON.stringify(req.body),
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a Kibana agent
app.delete('/api/kibana/agents/:id', async (req, res) => {
  try {
    await kibanaFetch(`/api/agent_builder/agents/${req.params.id}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List Kibana tools
app.get('/api/kibana/tools', async (_req, res) => {
  try {
    const data = await kibanaFetch('/api/agent_builder/tools');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Converse with a Kibana agent (SSE streaming via async converse)
app.post('/api/kibana/converse', async (req, res) => {
  const { agentId, message, conversationId } = req.body;
  if (!agentId || !message) {
    return res.status(400).json({ error: 'agentId and message required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  try {
    const body = { input: message };
    if (conversationId) body.conversation_id = conversationId;

    const resp = await fetch(`${KIBANA_ENDPOINT}/api/agent_builder/converse/async`, {
      method: 'POST',
      headers: {
        ...kibanaHeaders(),
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({ agent_id: agentId, ...body }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      send({ error: `Kibana ${resp.status}: ${errText}` });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Stream SSE events from Kibana to client
    // Kibana async SSE event types: message_chunk, message_complete,
    // conversation_id_set, conversation_created, reasoning, tool_call,
    // tool_result, round_complete, error
    let currentEventType = '';
    let buffer = '';
    for await (const chunk of resp.body) {
      const raw = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : Buffer.from(chunk).toString('utf-8');
      buffer += raw;
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') break;
          try {
            // Kibana wraps all payloads as { "data": { ... } }
            const outer = JSON.parse(data);
            const payload = outer.data ?? outer;
            switch (currentEventType) {
              case 'error':
                send({ error: payload.error?.message || payload.message || JSON.stringify(payload) });
                break;
              case 'message_chunk':
                // text field is text_chunk
                if (payload.text_chunk) send({ text: payload.text_chunk });
                break;
              case 'message_complete':
                if (payload.content) send({ text: payload.content, final: true });
                break;
              case 'conversation_id_set':
                send({ conversationId: payload.conversation_id });
                break;
              case 'reasoning':
                if (!payload.transient && payload.reasoning) send({ reasoning: payload.reasoning });
                break;
              case 'tool_call':
                send({ toolCall: payload.tool_id ?? payload.name ?? '' });
                break;
              case 'tool_progress':
                if (payload.message) send({ toolProgress: payload.message });
                break;
              default:
                if (payload.error) send({ error: payload.error?.message || payload.error });
            }
          } catch {}
          currentEventType = '';
        }
      }
    }
  } catch (err) {
    send({ error: err.message });
  }

  res.write('data: [DONE]\n\n');
  res.end();
});

// ─── A2A (Agent-to-Agent) proxy routes ───────────────────────────────────────

// GET agent card — discovery metadata (name, skills, capabilities)
app.get('/api/a2a/:agentId/card', async (req, res) => {
  try {
    const url = `${KIBANA_ENDPOINT}/api/agent_builder/a2a/${req.params.agentId}.json`;
    const resp = await fetch(url, { headers: kibanaHeaders() });
    if (!resp.ok) {
      const body = await resp.text();
      return res.status(resp.status).json({ error: `Kibana ${resp.status}: ${body}` });
    }
    res.json(await resp.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST A2A task — JSON-RPC 2.0 call to an agent (synchronous, no streaming)
app.post('/api/a2a/:agentId/task', async (req, res) => {
  const { message, conversationId, taskId } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const msgId = `msg-${Date.now()}`;
  const rpcBody = {
    id: taskId || `task-${Date.now()}`,
    jsonrpc: '2.0',
    method: 'message/send',
    params: {
      message: {
        messageId: msgId,
        role: 'user',
        parts: [{ kind: 'text', text: message }],
      },
      ...(conversationId ? { contextId: conversationId } : {}),
    },
  };

  try {
    const url = `${KIBANA_ENDPOINT}/api/agent_builder/a2a/${req.params.agentId}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: kibanaHeaders(),
      body: JSON.stringify(rpcBody),
    });

    if (!resp.ok) {
      const body = await resp.text();
      return res.status(resp.status).json({ error: `Kibana ${resp.status}: ${body}` });
    }

    const data = await resp.json();

    // Handle JSON-RPC error
    if (data?.error) {
      return res.status(400).json({ error: data.error.message || JSON.stringify(data.error), raw: data });
    }

    // Normalise A2A message/send response (protocol 0.3.0)
    // result.parts[] contains { kind: 'text', text: '...' }
    const result = data?.result ?? data;
    const parts = result?.parts || [];
    const message_text =
      parts.map(p => p.text || p.content || '').filter(Boolean).join('\n') ||
      (typeof result === 'string' ? result : null) ||
      JSON.stringify(result);

    res.json({
      id: data.id,
      conversationId: result?.contextId,   // use contextId for multi-turn continuity
      taskId: result?.taskId,
      message: message_text,
      raw: data,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MCP tools API route — expose discovered Elastic Agent Builder tools to UI
app.get('/api/mcp/tools', (_req, res) => {
  res.json({
    connected: !!mcpClient,
    endpoint: MCP_ENDPOINT,
    tools: mcpTools.map(t => ({
      name: t.name,
      description: t.description || '',
      claudeName: `mcp__${t.name.replace(/[^a-zA-Z0-9_]/g, '_')}`,
    })),
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`\n⚡ Elastic AI Agent Server`);
  console.log(`   API:       http://localhost:${PORT}`);
  console.log(`   Elastic:   ${ELASTIC_ENDPOINT}`);
  console.log(`   Auth:      ${ELASTIC_API_KEY ? '✓ ELASTIC_API_KEY set' : '✗ No key (set ELASTIC_API_KEY)'}`);
  console.log(`   Inference: ${ELASTIC_INFERENCE_ID}`);
  console.log(`   Anthropic: claude-opus-4-6 (adaptive thinking + ES tool use)`);
  console.log(`   MCP:       Connecting to Elastic Agent Builder...`);

  // Connect to Elastic Agent Builder MCP server at startup
  await connectMCP();

  console.log();
});
