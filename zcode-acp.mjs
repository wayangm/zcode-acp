#!/usr/bin/env node
// zcode-acp.mjs - Agent Client Protocol (ACP) stdio adapter for the ZCode CLI.
//
// Speaks newline-delimited JSON-RPC 2.0 on stdio (ACP), runs ZCode headlessly
// (`zcode -p "<turn text>" --json`) for each prompt turn, and resumes the same
// ZCode session across turns so the agent keeps its conversation context.
//
// Supported ACP methods: initialize, session/new, session/prompt,
// session/cancel (notification), authenticate. loadSession is not supported.
//
// Environment: ZCODE_CLI_PATH overrides the ZCode CLI entry path.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { existsSync, appendFileSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const VERSION = '1.6.0';

// The ZCode CLI entry ships inside the ZCode Desktop install. Best effort across
// platforms; set ZCODE_CLI_PATH when the install lives somewhere else.
function findZcodeCli() {
  if (process.env.ZCODE_CLI_PATH) return process.env.ZCODE_CLI_PATH;
  const home = os.homedir();
  // Preferred: the locally patched CLI build (Start Plan support for headless turns).
  const patched = 'D:/DEV/Z/zcode-src/apps/zcode-cli/packages/cli/dist/zcode.cjs';
  const candidates =
    [
      patched,
      ...(process.platform === 'win32'
        ? [
            path.join(home, 'AppData', 'Local', 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
            path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
          ]
        : process.platform === 'darwin'
          ? [
              path.join('/', 'Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs'),
              path.join(home, 'Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs'),
            ]
          : [
              path.join('/', 'opt', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
              path.join(home, '.local', 'share', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
            ]),
    ];
  return candidates.find((c) => existsSync(c)) ?? candidates[0];
}

const ZCODE_CJS = findZcodeCli();

// --version / --help must answer and exit before the stdio loop starts, so that
// version probes (like OpenBot's CLI detection) do not hang.
if (process.argv.includes('--version')) {
  console.log(`zcode-acp v${VERSION}`);
  process.exit(0);
}
if (process.argv.includes('--help')) {
  console.log(`zcode-acp v${VERSION} - Agent Client Protocol adapter for the ZCode CLI.`);
  console.log('Runs an ACP server on stdio. Point an ACP client (such as OpenBot) at this command.');
  console.log('Environment: ZCODE_CLI_PATH, ZCODE_HOME. Log: ' + path.join(os.tmpdir(), 'zcode-acp.log'));
  process.exit(0);
}

const sessions = new Map(); // acp session id -> { cwd, zcodeSessionId, child, stdout, stderr, promptReply }

const logFile = path.join(os.tmpdir(), 'zcode-acp.log');
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  process.stderr.write(`[zcode-acp] ${line}\n`);
  try { appendFileSync(logFile, line + '\n'); } catch { /* best effort */ }
}

// The ZCode CLI needs both provider-config env vars set together (its own loader
// errors when only one is present). The ZCode Desktop app sets them for its own
// children; other launchers (like OpenBot) do not, so resolve them here:
// personal config lives at a stable path, the built-in one inside the newest
// runtime cache under ~/.zcode/v2/runtime/provider/<platform>/<ver>/endpoint-*/.
function resolveProviderEnv() {
  const env = { ...process.env };
  if (env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE && env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) {
    return env; // inherited from ZCode Desktop; keep as-is
  }
  const home = os.homedir();
  let builtin = null;
  try {
    const runtimeRoot = path.join(home, '.zcode', 'v2', 'runtime', 'provider');
    for (const platform of readdirSync(runtimeRoot).sort().reverse()) {
      const platDir = path.join(runtimeRoot, platform);
      for (const version of readdirSync(platDir).sort().reverse()) {
        const verDir = path.join(platDir, version);
        for (const ep of readdirSync(verDir).filter((d) => d.startsWith('endpoint-')).sort().reverse()) {
          const cand = path.join(verDir, ep, 'zcode-builtin.json');
          if (existsSync(cand)) { builtin = cand; break; }
        }
        if (builtin) break;
      }
      if (builtin) break;
    }
  } catch { /* no runtime cache */ }
  builtin ??= path.resolve(path.dirname(ZCODE_CJS), '../config/provider/zcode-builtin.json');
  env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = path.join(home, '.zcode', 'v2', 'provider_config.json');
  env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtin;
  return env;
}

const SPAWN_ENV = resolveProviderEnv();

// The models ZCode can run, read from the same provider config the CLI reads. The ZCode CLI has
// no headless model switch (no flag, no env), but every turn spawns a fresh CLI that re-reads
// `providerOrder` - so switching a model means moving its provider to the front of that order.
// The change is global: it also becomes the default of new ZCode Desktop sessions.
function zcodeRoot() {
  return process.env.ZCODE_HOME?.trim() || path.join(os.homedir(), '.zcode');
}

// Display names follow the ZCode Desktop convention: `glm-5.3-flash` reads as `GLM 5.3 Flash`.
function prettifyModelName(modelId) {
  const upper = { glm: 'GLM', ai: 'AI', vl: 'VL', llm: 'LLM', deepseek: 'DeepSeek' };
  return modelId
    .replace(/^meta\//, '')
    .split(/[-_ ]+/)
    .map((part) => upper[part.toLowerCase()] ?? (/\d/.test(part) || part.length <= 1
      ? part
      : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

// The Start Plan models, available through the patched local CLI build. They live in the
// built-in catalog (not provider_config.json), so they are listed explicitly when the shared
// zcode JWT exists - i.e. when a Z.AI login state is present for the headless CLI to use.
const START_PLAN_MODELS = ['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo'];

function readZcodeModels() {
  const fallback = {
    currentModelId: 'zcode',
    availableModels: [{ modelId: 'zcode', name: 'ZCode', description: '' }],
    index: { zcode: { providerId: '', rawModelId: '', startPlan: false } },
  };
  try {
    const config = JSON.parse(readFileSync(path.join(zcodeRoot(), 'v2', 'provider_config.json'), 'utf8'));
    const cfgRoot = config?.config;
    const order = cfgRoot?.providerOrder;
    const rules = cfgRoot?.providerConfigRules?.providerRules;
    if (!Array.isArray(order) || !Array.isArray(rules)) return fallback;
    // Models disabled in the model rules are left out; rules that say nothing leave models enabled.
    const disabled = new Set();
    for (const rule of cfgRoot?.modelConfigRules?.providerModelRules ?? []) {
      if (rule?.config?.enabled === false) disabled.add(`${rule.providerId}/${rule.modelId}`);
    }
    const availableModels = [];
    const index = {};
    let hasZaiJwt = false;
    try {
      const credentials = JSON.parse(readFileSync(path.join(zcodeRoot(), 'v2', 'credentials.json'), 'utf8'));
      hasZaiJwt = Boolean(credentials['zcodejwttoken']?.trim?.());
    } catch { /* no credentials file */ }
    if (hasZaiJwt) {
      for (const modelId of START_PLAN_MODELS) {
        const modelIdFull = `account:zai-start-plan/${modelId}`;
        availableModels.push({
          modelId: modelIdFull,
          name: `${prettifyModelName(modelId)} · Start Plan (Free)`,
          description: 'Z.AI account',
        });
        index[modelIdFull] = { providerId: 'account:zai-start-plan', rawModelId: modelId, startPlan: true };
      }
    }
    for (const providerId of order) {
      const rule = rules.find((r) => r?.providerId === providerId);
      const cfg = rule?.config ?? {};
      const models = [
        ...new Set([...(cfg.modelOrder ?? []), ...(cfg.personalModelIds ?? [])]),
      ].filter((m) => typeof m === 'string' && m && !disabled.has(`${providerId}/${m}`));
      for (const modelId of models) {
        const modelIdFull = `${providerId}/${modelId}`;
        availableModels.push({
          modelId: modelIdFull,
          name: `${prettifyModelName(modelId)} · ${rule.providerName ?? providerId}`,
          description: cfg.api?.baseUrl,
        });
        index[modelIdFull] = { providerId, rawModelId: modelId, startPlan: false };
      }
    }
    if (availableModels.length === 0) return fallback;
    // current = defaultModelSelection when it matches a listed model; otherwise the first entry.
    const selection = cfgRoot?.defaultModelSelection;
    const selectedId = selection ? `${selection.providerId}/${selection.modelId}` : null;
    const current = availableModels.find((m) => m.modelId === selectedId)?.modelId
      ?? availableModels[0].modelId;
    return { currentModelId: current, availableModels, index };
  } catch { /* no readable provider config */ }
  return fallback;
}

// Reads the file fresh, moves the chosen provider to the front of providerOrder AND writes
// defaultModelSelection (the headless CLI's primary steering field), then writes atomically.
// Returns false when the config could not be rewritten; the caller answers without a switch.
function applyModelSelection(providerId, rawModelId, options) {
  try {
    const file = path.join(zcodeRoot(), 'v2', 'provider_config.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    const cfgRoot = config?.config;
    const order = cfgRoot?.providerOrder;
    if (!Array.isArray(order)) return false;
    const index = order.indexOf(providerId);
    if (index === -1) order.unshift(providerId);
    else if (index > 0) {
      order.splice(index, 1);
      order.unshift(providerId);
    }
    const selection = { providerId, modelId: rawModelId };
    if (options) selection.options = options;
    cfgRoot.defaultModelSelection = selection;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(config, null, 2));
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

const ZCODE_MODELS = readZcodeModels();

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

function notifyUpdate(sessionId, update) {
  write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
}

function sendChunk(sessionId, text) {
  notifyUpdate(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
  });
}

function sendThought(sessionId, text) {
  notifyUpdate(sessionId, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text },
  });
}

const TOOL_KIND_BY_NAME = {
  bash: 'execute', shell: 'execute', terminal: 'execute', command: 'execute',
  read: 'read', view: 'read', cat: 'read',
  write: 'edit', edit: 'edit', apply: 'edit', patch: 'edit',
  search: 'search', grep: 'search', glob: 'search', find: 'search',
  fetch: 'fetch', web: 'fetch', browser: 'fetch',
};

function toolKind(toolName) {
  const lower = String(toolName ?? '').toLowerCase();
  for (const [needle, kind] of Object.entries(TOOL_KIND_BY_NAME)) {
    if (lower.includes(needle)) return kind;
  }
  return 'other';
}

function sendToolCall(sessionId, toolCallId, title, kind) {
  notifyUpdate(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId,
    title,
    kind: toolKind(title),
  });
}

function sendToolCallUpdate(sessionId, toolCallId, status, title, output) {
  const update = {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status,
  };
  if (title) update.title = title;
  if (output) update.content = [{ type: 'content', content: { type: 'text', text: String(output).slice(0, 2000) } }];
  notifyUpdate(sessionId, update);
}

function initialize(params) {
  const version = typeof params?.protocolVersion === 'number' ? params.protocolVersion : 1;
  return {
    protocolVersion: version,
    agentCapabilities: {
      loadSession: false,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
    },
    authMethods: [],
  };
}

function newSession(params) {
  const id = `acp-zcode-${randomUUID()}`;
  const cwd = params?.cwd || process.cwd();
  sessions.set(id, { cwd, zcodeSessionId: null, child: null, stdout: '', stderr: '', promptReply: null });
  log('session created', id, 'cwd:', cwd, 'model:', ZCODE_MODELS.currentModelId);
  // Wire response carries only the picker fields; the internal index stays local.
  return {
    sessionId: id,
    models: { currentModelId: ZCODE_MODELS.currentModelId, availableModels: ZCODE_MODELS.availableModels },
  };
}

function setModel(params, id) {
  // Clients may send a namespaced id (an OpenBot custom agent prefixes its own id, e.g.
  // `zcode/new-provider/glm-5.3-flash`), so match by suffix. A refused set_model fails the
  // whole turn in OpenBot, so unknown ids are answered with success and logged instead.
  const modelId = params?.modelId;
  const target = ZCODE_MODELS.availableModels.find(
    (m) => modelId === m.modelId || (typeof modelId === 'string' && modelId.endsWith(`/${m.modelId}`)),
  );
  if (!target) {
    log('set_model no-op (unknown id):', modelId);
    reply(id, {});
    return;
  }
  if (target.modelId === ZCODE_MODELS.currentModelId) {
    reply(id, {});
    return;
  }
  // Switching moves the model's provider to the front of the CLI's provider order AND writes
  // defaultModelSelection (the headless CLI's primary steering field). Each turn spawns a fresh
  // CLI that re-reads both, so the next turn runs on the chosen model — but a RESUMED ZCode
  // session is pinned to the provider it was born on, so every live session drops its ZCode
  // session id here and the next turn opens a fresh one. Trade-off: ZCode-side memory resets.
  const meta = ZCODE_MODELS.index[target.modelId] ?? {};
  const options = meta.startPlan ? { reasoningLevel: 'max' } : undefined;
  if (applyModelSelection(meta.providerId, meta.rawModelId, options)) {
    ZCODE_MODELS.currentModelId = target.modelId;
    for (const s of sessions.values()) s.zcodeSessionId = null;
    log('set_model applied:', target.modelId, '(asked:', modelId + ') - zcode sessions reset');
    reply(id, {});
  } else {
    // Never fail the turn over a config write; the previously first provider keeps running.
    log('set_model stored without switch (config write failed):', modelId);
    reply(id, {});
  }
}

function promptToText(promptBlocks) {
  const text = [];
  const attach = [];
  for (const block of Array.isArray(promptBlocks) ? promptBlocks : []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      text.push(block.text);
    } else if (block?.type === 'resource_link' && typeof block.uri === 'string' && block.uri.startsWith('file://')) {
      const p = block.uri.replace(/^file:\/\/\/?/, '/');
      if (existsSync(p)) attach.push(path.normalize(p));
      else text.push(`[unavailable file: ${block.uri}]`);
    } else if (block?.type === 'resource' && typeof block.text === 'string') {
      text.push(block.text);
    } else {
      text.push(`[unsupported content block: ${block?.type ?? 'unknown'}]`);
    }
  }
  return { text: text.join('\n'), attach };
}

function extractResultJson(stdout) {
  // The CLI prints (pretty-printed) JSON objects to stdout, possibly followed by
  // non-JSON error lines. Scan for balanced top-level {...} spans, string-aware.
  const objects = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < stdout.length; i++) {
    const ch = stdout[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { if (depth > 0) inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try { objects.push(JSON.parse(stdout.slice(start, i + 1))); } catch { /* skip */ }
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return objects.findLast((j) => 'response' in j) ?? objects.at(-1) ?? null;
}

// Windows refuses a command line past 32,767 characters, and OpenBot wraps every prompt in
// sizeable instructions. Past this limit the task travels as an attached file instead of argv.
const MAX_ARGV_TASK_CHARS = 6_000;
// The ZCode CLI streams nothing in headless mode. OpenBot ends a turn that sends no session
// update for 5 minutes (ACP_TURN_STALL_MS), and every session/update - a thought included -
// resets that timer, so the heartbeat must fire strictly inside that window.
const HEARTBEAT_EVERY_MS = 240_000;

function startTurn(sessionId, params, id) {
  const sess = sessions.get(sessionId);
  if (!sess) return replyError(id, -32602, `unknown session: ${sessionId}`);
  if (sess.child) return replyError(id, -32603, 'a turn is already running for this session');

  const { text, attach } = promptToText(params?.prompt);
  let taskFile = null;
  let promptText = text;
  if (text.length > MAX_ARGV_TASK_CHARS) {
    taskFile = path.join(os.tmpdir(), `zcode-acp-task-${randomUUID()}.txt`);
    writeFileSync(taskFile, text, 'utf8');
    promptText = 'The attached file is the complete task. Carry it out exactly, including the final instruction it ends with.';
    log('long task via attach:', taskFile, `(${text.length} chars)`);
  }
  const args = [ZCODE_CJS, '-p', promptText, '--output-format', 'stream-json', '--cwd', sess.cwd];
  for (const f of attach) args.push('--attach', f);
  if (taskFile) args.push('--attach', taskFile);
  if (sess.zcodeSessionId) args.push('--resume', sess.zcodeSessionId);

  if (!existsSync(ZCODE_CJS)) {
    if (taskFile) try { unlinkSync(taskFile); } catch { /* best effort */ }
    sendChunk(sessionId, `ZCode CLI not found at ${ZCODE_CJS}. Install ZCode Desktop or set ZCODE_CLI_PATH.`);
    return reply(id, { stopReason: 'refusal' });
  }

  sess.stdout = '';
  sess.stderr = '';
  sess.promptReply = id;
  log('turn start', sessionId, 'resume:', sess.zcodeSessionId ?? '(new)',
    'builtin:', SPAWN_ENV.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE);
  const startedAt = Date.now();
  const fmtElapsed = () => {
    const s = Math.round((Date.now() - startedAt) / 1000);
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  };
  const taskSummary = text.replace(/\s+/gu, ' ').trim().slice(0, 120) + (text.length > 120 ? '…' : '');
  sendThought(sessionId,
    `🔧 ${ZCODE_MODELS.currentModelId} mengerjakan: "${taskSummary}" — CLI ZCode tidak men-stream progres; jawaban lengkap menyusul saat turn selesai.`);
  const heartbeatTimers = [];
  const stopHeartbeat = () => {
    for (const t of heartbeatTimers) { clearInterval(t); }
  };
  heartbeatTimers.push(setInterval(() => {
    sendThought(sessionId, `⏳ ZCode masih bekerja (${fmtElapsed()}) — jawaban lengkap datang saat turn selesai.`);
  }, HEARTBEAT_EVERY_MS));

  let child;
  try {
    child = spawn(process.execPath, args, { cwd: sess.cwd, windowsHide: true, env: SPAWN_ENV });
  } catch (e) {
    // spawn can throw synchronously (for example ENAMETOOLONG); answer instead of hanging.
    stopHeartbeat();
    if (taskFile) try { unlinkSync(taskFile); } catch { /* best effort */ }
    sendChunk(sessionId, `zcode-acp: failed to start ZCode CLI: ${e?.message ?? e}`);
    if (sess.promptReply) reply(sess.promptReply, { stopReason: 'refusal' });
    sess.promptReply = null;
    return;
  }
  sess.child = child;
  sess.streamedText = false;
  sess.result = null;
  child.stderr.on('data', (d) => { sess.stderr += d; });
  // stream-json: one NDJSON event per line, as it happens. Forward the meaningful ones live.
  const outLines = createInterface({ input: child.stdout, terminal: false });
  outLines.on('line', (line) => {
    const t = line.trim();
    if (!t || !t.startsWith('{')) { sess.stdout += line + '\n'; return; }
    let event;
    try { event = JSON.parse(t); } catch { sess.stdout += line + '\n'; return; }
    if (event.type === 'result') { sess.result = event.payload ?? event; return; }
    // Event data lives in `payload`; fall back to top-level for older emitters.
    const p = event.payload ?? event;
    if (event.type === 'model.streaming') {
      if (p.kind === 'text_delta' && typeof p.delta === 'string' && p.delta) {
        sess.streamedText = true;
        sendChunk(sessionId, p.delta);
      }
      return;
    }
    if (event.type === 'tool.updated') {
      const callId = p.toolCallId ?? `tool-${p.partId ?? p.seq ?? 'x'}`;
      const title = [p.toolName, typeof p.input === 'string' ? p.input.slice(0, 80) : '']
        .filter(Boolean).join(' ').trim() || 'tool';
      if (p.kind === 'scheduled') sendToolCall(sessionId, callId, title);
      else if (p.kind === 'started') sendToolCallUpdate(sessionId, callId, 'in_progress', title);
      else if (p.kind === 'progress') sendToolCallUpdate(sessionId, callId, 'in_progress', title, p.outputPreview ?? p.stderrTail);
      else if (p.kind === 'result') sendToolCallUpdate(sessionId, callId, 'completed', title, p.outputPreview ?? p.stdoutTail);
      else if (p.kind === 'error') sendToolCallUpdate(sessionId, callId, 'failed', title, p.outputPreview);
    }
  });
  child.on('error', (e) => {
    stopHeartbeat();
    if (taskFile) try { unlinkSync(taskFile); } catch { /* best effort */ }
    if (sess.child !== child) return;
    sess.child = null;
    sendChunk(sessionId, `zcode-acp: failed to start ZCode CLI: ${e.message}`);
    if (sess.promptReply) reply(sess.promptReply, { stopReason: 'refusal' });
    sess.promptReply = null;
  });
  child.on('close', (code) => {
    stopHeartbeat();
    outLines.close();
    if (taskFile) try { unlinkSync(taskFile); } catch { /* best effort */ }
    if (sess.child !== child) return; // cancelled; already answered
    sess.child = null;
    const result = sess.result;
    if (code === 0 && result && typeof result.response === 'string') {
      if (typeof result.sessionId === 'string') sess.zcodeSessionId = result.sessionId;
      // The answer text was already streamed as deltas; only send it when nothing streamed.
      if (!sess.streamedText && result.response.length > 0) sendChunk(sessionId, result.response);
      if (sess.promptReply) reply(sess.promptReply, { stopReason: 'end_turn' });
    } else {
      const tail = ((sess.stderr || '') + '\n' + (sess.stdout || '')).trim().slice(-1500);
      let detail = result?.error ?? tail ?? 'unknown error';
      detail = typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 800);
      if (detail.includes('Select a model')) {
        detail = 'ZCode headless has no enabled provider. Only the Z.AI Start Plan is active, and that route is Desktop-only. Enable an API provider (with balance) in ZCode Desktop settings, then pick its model in OpenBot.';
      }
      sendChunk(sessionId, `ZCode turn failed (exit ${code}): ${detail}`);
      if (sess.promptReply) reply(sess.promptReply, { stopReason: 'refusal' });
    }
    sess.promptReply = null;
    log('turn end', sessionId, 'exit:', code);
  });
}

function cancelTurn(sessionId) {
  const sess = sessions.get(sessionId);
  if (!sess?.child) return;
  log('cancel', sessionId);
  const child = sess.child;
  sess.child = null;
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  if (sess.promptReply) {
    reply(sess.promptReply, { stopReason: 'cancelled' });
    sess.promptReply = null;
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
log('adapter started, node', process.version, 'argv:', process.argv.slice(1).join(' '));
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { log('unparseable line ignored'); return; }
  const { id, method, params } = msg;
  if (id !== undefined && id !== null) {
    switch (method) {
      case 'initialize': reply(id, initialize(params)); break;
      case 'session/new': reply(id, newSession(params)); break;
      case 'session/prompt': startTurn(params?.sessionId, params, id); break;
      case 'session/load': replyError(id, -32601, 'loadSession not supported'); break;
      case 'authenticate': reply(id, {}); break;
      case 'session/set_mode': reply(id, {}); break;
      case 'session/set_model': setModel(params, id); break;
      default: replyError(id, -32601, `method not supported: ${method}`);
    }
  } else if (method === 'session/cancel') {
    cancelTurn(params?.sessionId);
  } else {
    log('notification ignored:', method);
  }
});

rl.on('close', () => process.exit(0));
process.on('uncaughtException', (e) => log('uncaught:', e?.message ?? String(e)));
