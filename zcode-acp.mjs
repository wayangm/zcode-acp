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

const VERSION = '1.4.4';

// The ZCode CLI entry ships inside the ZCode Desktop install. Best effort across
// platforms; set ZCODE_CLI_PATH when the install lives somewhere else.
function findZcodeCli() {
  if (process.env.ZCODE_CLI_PATH) return process.env.ZCODE_CLI_PATH;
  const home = os.homedir();
  const candidates =
    process.platform === 'win32'
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

function readZcodeModels() {
  const fallback = { currentModelId: 'zcode', availableModels: [{ modelId: 'zcode', name: 'ZCode' }] };
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
    // The signed-in Z.AI account (Start Plan) is deliberately NOT listed: the CLI never routes
    // headless turns to the OAuth login while any known provider rule exists - a `zai` entry in
    // the provider order is ignored (verified in the CLI logs), so listing it would promise a
    // model that headless turns cannot reach. The Start Plan stays a Desktop-only route.
    for (const providerId of order) {
      const rule = rules.find((r) => r?.providerId === providerId);
      const cfg = rule?.config ?? {};
      const models = [
        ...new Set([...(cfg.modelOrder ?? []), ...(cfg.personalModelIds ?? [])]),
      ].filter((m) => typeof m === 'string' && m && !disabled.has(`${providerId}/${m}`));
      for (const modelId of models) {
        availableModels.push({
          modelId: `${providerId}/${modelId}`,
          name: `${prettifyModelName(modelId)} · ${rule.providerName ?? providerId}`,
          description: cfg.api?.baseUrl,
        });
      }
    }
    if (availableModels.length === 0) return fallback;
    const current = availableModels.find((m) => m.modelId.startsWith(`${order[0]}/`))?.modelId;
    return { currentModelId: current ?? availableModels[0].modelId, availableModels };
  } catch { /* no readable provider config */ }
  return fallback;
}

// Reads the file fresh, moves the provider to the front, writes atomically. Returns false when
// the config could not be rewritten; the caller then answers without a switch.
function applyProviderOrder(providerId) {
  try {
    const file = path.join(zcodeRoot(), 'v2', 'provider_config.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    const order = config?.config?.providerOrder;
    if (!Array.isArray(order)) return false;
    const index = order.indexOf(providerId);
    if (index === -1) {
      // A provider the order does not know yet (the OAuth `zai` account) joins at the front.
      order.unshift(providerId);
    } else if (index > 0) {
      order.splice(index, 1);
      order.unshift(providerId);
    } else {
      return true;
    }
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
  return { sessionId: id, models: ZCODE_MODELS };
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
  // Switching moves the model's provider to the front of the CLI's provider order. Each turn
  // spawns a fresh CLI that re-reads that order, so the next turn runs on the chosen model —
  // but a RESUMED ZCode session is pinned to the provider it was born on, so every live
  // session drops its ZCode session id here and the next turn opens a fresh one under the
  // chosen provider. The trade-off: ZCode-side conversation memory resets on a model switch.
  if (applyProviderOrder(target.modelId.split('/')[0])) {
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
  const args = [ZCODE_CJS, '-p', promptText, '--json', '--cwd', sess.cwd];
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
  child.stdout.on('data', (d) => { sess.stdout += d; });
  child.stderr.on('data', (d) => { sess.stderr += d; });
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
    if (taskFile) try { unlinkSync(taskFile); } catch { /* best effort */ }
    if (sess.child !== child) return; // cancelled; already answered
    sess.child = null;
    const parsed = extractResultJson(sess.stdout);
    if (code === 0 && parsed && typeof parsed.response === 'string' && parsed.response.length > 0) {
      if (typeof parsed.sessionId === 'string') sess.zcodeSessionId = parsed.sessionId;
      sendChunk(sessionId, parsed.response);
      if (sess.promptReply) reply(sess.promptReply, { stopReason: 'end_turn' });
    } else {
      const tail = ((sess.stderr || '') + '\n' + (sess.stdout || '')).trim().slice(-1500);
      const detail = parsed?.error?.message ?? parsed?.message ?? tail ?? 'unknown error';
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
