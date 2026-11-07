// ACP harness: init -> session/new (models) -> set_model -> one real turn. Prints everything.
// Usage: node test/acp-harness.mjs [adapter.mjs] [turn-cwd]
//   Defaults: the packaged adapter, and test/.tmp as the turn folder (must exist).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const adapterPath = process.argv[2] ?? fileURLToPath(new URL('../zcode-acp.mjs', import.meta.url));
const turnCwd = process.argv[3] ?? fileURLToPath(new URL('./.tmp', import.meta.url));
const child = spawn(process.execPath, [adapterPath], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (d) => process.stderr.write('[adapter] ' + d));

let buf = '';
const pending = new Map();
let nextId = 1;
let updates = [];
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method === 'session/update') updates.push(msg.params.update);
  }
});
const request = (method, params, timeoutMs = 240000) => {
  const id = nextId++;
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + method)), timeoutMs);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
};
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`); return ok; };

await request('initialize', { protocolVersion: 1 });
const sn = await request('session/new', { cwd: turnCwd });
const models = sn.result?.models;
let ok = true;
ok &= check('models present', !!models?.currentModelId && models.availableModels?.length >= 1,
  models?.availableModels?.map((m) => m.modelId).join(' | '));
ok &= check('set_model current accepted', (await request('session/set_model', { sessionId: sn.result.sessionId, modelId: models.currentModelId })).result !== undefined);
const turn = await request('session/prompt', { sessionId: sn.result.sessionId, prompt: [{ type: 'text', text: 'Reply with exactly one word: ALIVE' }] });
ok &= check('turn end_turn', turn.result?.stopReason === 'end_turn');
const thoughts = updates.filter((u) => u.sessionUpdate === 'agent_thought_chunk').map((u) => u.content?.text ?? '');
ok &= check('exactly one informative opening note (no counters)', thoughts.length === 1 && thoughts[0].includes('mengerjakan') && !thoughts[0].includes('sedang bekerja...'), JSON.stringify(thoughts));
ok &= check('answer chunk received', updates.some((u) => u.sessionUpdate === 'agent_message_chunk' && u.content?.text?.includes('ALIVE')));
console.log(ok ? 'HARNESS PASS' : 'HARNESS FAIL');
process.exit(ok ? 0 : 1);
