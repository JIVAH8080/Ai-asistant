/**
 * Sky Dental — Proxy Server
 * Primary:  NVIDIA    → deepseek-ai/deepseek-v3.2    (OpenAI-compatible SSE)
 * Fallback: Anthropic → claude-sonnet-4-20250514     (Anthropic SSE → OpenAI SSE translation)
 *
 * Run:  node server.js
 * Open: http://localhost:3001
 *
 * Zero npm dependencies — Node.js built-in modules only.
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

/* ═══════════════════════════════════════════════════
   CONFIG
═══════════════════════════════════════════════════ */
const PORT = 3001;

const NVIDIA = {
  host:  'integrate.api.nvidia.com',
  path:  '/v1/chat/completions',
  key:   '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',
  model: 'google/gemma-2-2b-it',
};

const ANTHROPIC = {
  host:    'api.anthropic.com',
  path:    '/v1/messages',
  key:     process.env.ANTHROPIC_API_KEY || '',   // set env var or paste key directly
  model:   'claude-sonnet-4-20250514',
  version: '2023-06-01',
};

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const SSE_HEADERS = {
  ...CORS,
  'Content-Type':      'text/event-stream',
  'Cache-Control':     'no-cache',
  'X-Accel-Buffering': 'no',
  'Transfer-Encoding': 'chunked',
};

const ts = () => new Date().toTimeString().slice(0, 8);

/* ═══════════════════════════════════════════════════
   HTTP SERVER
═══════════════════════════════════════════════════ */
http.createServer((req, res) => {

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS); res.end(); return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const file = path.join(__dirname, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404); res.end('index.html not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(file).pipe(res);
    return;
  }

  if (req.method === 'POST' && req.url === '/proxy') {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => handleProxy(raw, res));
    return;
  }

  res.writeHead(404, CORS); res.end('Not found');

}).listen(PORT, () => {
  console.log('\n┌──────────────────────────────────────────────┐');
  console.log(`│  Sky Dental Proxy  →  http://localhost:${PORT}     │`);
  console.log('│  Primary  : NVIDIA  Gemma 2 2B IT            │');
  console.log('│  Fallback : Anthropic  Claude Sonnet 4.5     │');
  if (!ANTHROPIC.key) {
  console.log('│  ⚠  No ANTHROPIC_API_KEY — fallback disabled  │');
  } else {
  console.log('│  ✅  Anthropic fallback ready                  │');
  }
  console.log('└──────────────────────────────────────────────┘\n');
});

/* ═══════════════════════════════════════════════════
   PROXY HANDLER
   1. Try NVIDIA (pipe SSE directly — no transformation)
   2. On failure, translate to Anthropic format and
      translate Anthropic SSE back to OpenAI SSE
═══════════════════════════════════════════════════ */
async function handleProxy(raw, clientRes) {
  let body;
  try { body = JSON.parse(raw); }
  catch { clientRes.writeHead(400, CORS); clientRes.end('Invalid JSON'); return; }

  /* ── Attempt 1: NVIDIA ── */
  try {
    console.log(`[${ts()}] ▶ NVIDIA  ${NVIDIA.model}`);
    await streamNvidia(body, clientRes);
    console.log(`[${ts()}] ✓ NVIDIA  done`);
    return;
  } catch (err) {
    console.warn(`[${ts()}] ✗ NVIDIA  failed — ${err.message}`);
    if (clientRes.headersSent) { clientRes.end(); return; } // stream started, can't recover
  }

  /* ── Attempt 2: Anthropic Claude ── */
  if (!ANTHROPIC.key) {
    clientRes.writeHead(502, CORS);
    clientRes.end(JSON.stringify({ error: 'NVIDIA failed. Set ANTHROPIC_API_KEY to enable Claude fallback.' }));
    return;
  }

  try {
    console.log(`[${ts()}] ▶ Anthropic  ${ANTHROPIC.model}  (fallback)`);
    await streamAnthropic(openaiToAnthropic(body), clientRes);
    console.log(`[${ts()}] ✓ Anthropic  done`);
  } catch (err) {
    console.error(`[${ts()}] ✗ Anthropic  failed — ${err.message}`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, CORS);
      clientRes.end(JSON.stringify({ error: 'Both providers failed. ' + err.message }));
    } else {
      clientRes.end();
    }
  }
}

/* ═══════════════════════════════════════════════════
   NVIDIA STREAM
   OpenAI-compatible — pipe directly to browser.
   Buffers first chunk to detect non-2xx before
   committing response headers (allows fallback).
═══════════════════════════════════════════════════ */
/* Models that do NOT support function calling on NVIDIA's endpoint */
const NO_TOOL_MODELS   = ['google/', 'meta/', 'mistralai/', 'microsoft/phi', 'nvidia/llama'];
const NO_SYSTEM_MODELS = ['google/gemma', 'microsoft/phi'];
const supportsTools    = m => !NO_TOOL_MODELS.some(p => m.toLowerCase().startsWith(p));
const supportsSystem   = m => !NO_SYSTEM_MODELS.some(p => m.toLowerCase().startsWith(p));

/*
 * sanitizeForGemma()
 * Gemma on NVIDIA enforces strict user/assistant alternation starting with user.
 * The UI greeting is stored as assistant in history before any user turn — strip it.
 * Also handles: no system role, no tool roles, no consecutive same-role messages.
 */
function sanitizeForGemma(messages) {
  // 1. Extract system prompt
  let systemText = '';
  const noSystem = messages.filter(m => {
    if (m.role === 'system') { systemText = m.content; return false; }
    return true;
  });

  // 2. Drop tool/tool_result — Gemma can't use them
  const noTools = noSystem.filter(m => m.role === 'user' || m.role === 'assistant');

  // 3. Drop leading assistant messages (UI greeting) — must start with user
  let start = 0;
  while (start < noTools.length && noTools[start].role === 'assistant') start++;
  const trimmed = noTools.slice(start);

  if (trimmed.length === 0) {
    const content = systemText ? `[Instructions]\n${systemText}\n\nHello.` : 'Hello.';
    return [{ role: 'user', content }];
  }

  // 4. Collapse consecutive same-role messages (join with newline)
  const collapsed = [];
  for (const msg of trimmed) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content += '\n' + msg.content;
    } else {
      collapsed.push({ role: msg.role, content: msg.content });
    }
  }

  // 5. Prepend system prompt into first user message
  if (systemText) {
    const fi = collapsed.findIndex(m => m.role === 'user');
    if (fi !== -1) {
      collapsed[fi].content = `[Instructions]\n${systemText}\n\n${collapsed[fi].content}`;
    }
  }

  return collapsed;
}

function streamNvidia(body, clientRes) {
  return new Promise((resolve, reject) => {
    const outBody = { ...body, model: NVIDIA.model, stream: true };

    if (!supportsTools(NVIDIA.model)) {
      delete outBody.tools;
      delete outBody.tool_choice;
      console.log(`[${ts()}]   ↳ tools stripped (${NVIDIA.model} is not a function-calling model)`);
    }

    if (!supportsSystem(NVIDIA.model)) {
      outBody.messages = sanitizeForGemma(outBody.messages || []);
      console.log(`[${ts()}]   ↳ system merged + conversation sanitized for strict alternation`);
    }

    const payload = Buffer.from(JSON.stringify(outBody));

    const req = https.request({
      hostname: NVIDIA.host,
      path:     NVIDIA.path,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': payload.length,
        'Authorization':  `Bearer ${NVIDIA.key}`,
        'Accept':         'text/event-stream',
      }
    }, apiRes => {
      const errorChunks = [];
      let committed = false;

      apiRes.on('data', chunk => {
        if (committed) { clientRes.write(chunk); return; }

        if (apiRes.statusCode >= 200 && apiRes.statusCode < 300) {
          clientRes.writeHead(apiRes.statusCode, SSE_HEADERS);
          committed = true;
          clientRes.write(chunk);
        } else {
          // Buffer error body so we can reject with the message
          errorChunks.push(chunk);
        }
      });

      apiRes.on('end', () => {
        if (!committed) {
          reject(new Error(`HTTP ${apiRes.statusCode}: ${Buffer.concat(errorChunks).toString().slice(0, 200)}`));
        } else {
          clientRes.end();
          resolve();
        }
      });
    });

    req.on('error', err => reject(new Error('Network: ' + err.message)));
    req.write(payload);
    req.end();
  });
}

/* ═══════════════════════════════════════════════════
   FORMAT TRANSLATION  —  OpenAI → Anthropic request
═══════════════════════════════════════════════════ */
function openaiToAnthropic(openaiBody) {
  const messages  = openaiBody.messages  || [];
  const tools     = openaiBody.tools     || [];
  const maxTokens = openaiBody.max_tokens || 4096;

  /* Extract system message */
  let system = '';
  const rest = messages.filter(m => {
    if (m.role === 'system') { system = m.content; return false; }
    return true;
  });

  /* Build Anthropic message list */
  const converted = [];
  let i = 0;

  while (i < rest.length) {
    const m = rest[i];

    /* Group consecutive tool results into one user message */
    if (m.role === 'tool') {
      const results = [];
      while (i < rest.length && rest[i].role === 'tool') {
        results.push({
          type:        'tool_result',
          tool_use_id: rest[i].tool_call_id,
          content:     rest[i].content,
        });
        i++;
      }
      converted.push({ role: 'user', content: results });
      continue;
    }

    /* Assistant message with tool_calls → Anthropic tool_use blocks */
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /**/ }
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      converted.push({ role: 'assistant', content });
      i++; continue;
    }

    /* Plain text message */
    converted.push({ role: m.role, content: m.content || '' });
    i++;
  }

  /* Translate OpenAI tool definitions → Anthropic input_schema */
  const anthropicTools = tools.map(t => ({
    name:         t.function.name,
    description:  t.function.description || '',
    input_schema: t.function.parameters,
  }));

  const result = {
    model:      ANTHROPIC.model,
    max_tokens: maxTokens,
    messages:   converted,
    stream:     true,
  };
  if (system)                      result.system = system;
  if (anthropicTools.length > 0)   result.tools  = anthropicTools;

  return result;
}

/* ═══════════════════════════════════════════════════
   ANTHROPIC STREAM  →  translate to OpenAI SSE
   
   Anthropic SSE event types handled:
     content_block_start  (type: text | tool_use)
     content_block_delta  (type: text_delta | input_json_delta)
     message_delta        (stop_reason: end_turn | tool_use)
     message_stop         (emits final [DONE])
═══════════════════════════════════════════════════ */
function streamAnthropic(body, clientRes) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));

    const req = https.request({
      hostname: ANTHROPIC.host,
      path:     ANTHROPIC.path,
      method:   'POST',
      headers: {
        'Content-Type':       'application/json',
        'Content-Length':     payload.length,
        'x-api-key':          ANTHROPIC.key,
        'anthropic-version':  ANTHROPIC.version,
        'Accept':             'text/event-stream',
      }
    }, apiRes => {

      if (apiRes.statusCode < 200 || apiRes.statusCode >= 300) {
        let e = '';
        apiRes.on('data', c => e += c);
        apiRes.on('end', () => reject(new Error(`Anthropic HTTP ${apiRes.statusCode}: ${e.slice(0, 200)}`)));
        return;
      }

      clientRes.writeHead(200, SSE_HEADERS);

      let buf = '';
      // contentBlockIndex → toolCallIndex (0-based, counting only tool_use blocks)
      const toolBlockMap = {};
      let toolCallCounter = 0;
      let doneSent = false;

      /* Write one OpenAI-format SSE event to client */
      const emit = obj => clientRes.write(`data: ${JSON.stringify(obj)}\n\n`);
      const done = () => { if (!doneSent) { clientRes.write('data: [DONE]\n\n'); doneSent = true; } };

      apiRes.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop(); // retain incomplete trailing line

        for (const line of lines) {
          const t = line.trim();

          // Skip event: lines (we handle everything via data: + evt.type)
          if (t.startsWith('event: ')) continue;
          if (!t.startsWith('data: ')) continue;

          const raw = t.slice(6).trim();
          if (!raw || raw === '[DONE]') { done(); continue; }

          let evt;
          try { evt = JSON.parse(raw); } catch { continue; }

          /* ── content_block_start ── */
          if (evt.type === 'content_block_start') {
            const cb = evt.content_block;
            if (cb && cb.type === 'tool_use') {
              const tcIdx = toolCallCounter++;
              toolBlockMap[evt.index] = tcIdx;
              // Emit tool_call open with id + name, empty arguments
              emit({ choices: [{ delta: {
                tool_calls: [{ index: tcIdx, id: cb.id, type: 'function', function: { name: cb.name, arguments: '' } }]
              }, finish_reason: null }] });
            }
            continue;
          }

          /* ── content_block_delta ── */
          if (evt.type === 'content_block_delta') {
            const d = evt.delta;
            if (!d) continue;

            if (d.type === 'text_delta' && d.text) {
              emit({ choices: [{ delta: { content: d.text }, finish_reason: null }] });
            }

            if (d.type === 'input_json_delta' && d.partial_json !== undefined) {
              const tcIdx = toolBlockMap[evt.index];
              if (tcIdx !== undefined) {
                emit({ choices: [{ delta: {
                  tool_calls: [{ index: tcIdx, function: { arguments: d.partial_json } }]
                }, finish_reason: null }] });
              }
            }
            continue;
          }

          /* ── message_delta (stop_reason) ── */
          if (evt.type === 'message_delta' && evt.delta) {
            const stop = evt.delta.stop_reason;
            if (stop) {
              // Map Anthropic stop reasons to OpenAI equivalents
              const reason = stop === 'tool_use' ? 'tool_calls'
                           : stop === 'end_turn' ? 'stop'
                           : stop;
              emit({ choices: [{ delta: {}, finish_reason: reason }] });
              done();
            }
            continue;
          }

          /* ── message_stop ── */
          if (evt.type === 'message_stop') {
            done();
            continue;
          }
        }
      });

      apiRes.on('end', () => { done(); clientRes.end(); resolve(); });
    });

    req.on('error', err => reject(new Error('Network: ' + err.message)));
    req.write(payload);
    req.end();
  });
}
