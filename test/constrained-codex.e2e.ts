import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIsolatedCodex, isolatedInvocationEnv } from '../src/services/constrained-invocation/codex-runtime.js';
import { CONSTRAINED_CODEX_CONFIG } from '../src/services/constrained-invocation/codex-profile.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import type { InvocationRequest } from '../src/services/constrained-invocation/contract.js';

// Opt-in real Codex, fake provider, synthetic input, no auth and no IM traffic.
const executable = process.env.BOTMUX_CONSTRAINED_CODEX;
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const schema = {
  type: 'object', properties: {
    content: { type: 'string' },
    tool_calls: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'string' } }, required: ['name', 'arguments'], additionalProperties: false } },
  }, required: ['content', 'tool_calls'], additionalProperties: false,
};
async function harness(reply: (body: any, index: number) => any) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-native-fixture-')); roots.push(root);
  for (const name of ['home', 'codex', 'work']) mkdirSync(join(root, name), { mode: 0o700 });
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const buffers: Buffer[] = [];
    for await (const chunk of req) buffers.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(buffers).toString()); requests.push(body);
    const item = reply(body, requests.length);
    if (item === null) return; // intentional hang for deadline/cancel
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const response = { id: `response-${requests.length}`, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 3 } } };
    for (const event of [
      { type: 'response.created', response: { id: response.id } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  writeFileSync(join(root, 'codex', 'config.toml'), `${CONSTRAINED_CODEX_CONFIG}\n[model_providers.fixture]\nname="fixture"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n` .replace('model="gpt-5.5"', 'model="gpt-5.5"\nmodel_provider="fixture"'));
  const run = (prompt: string, signal = AbortSignal.timeout(15_000)) => runIsolatedCodex({ requestId: 'fixture', prompt, model: 'gpt-5.5', deadlineMs: 15_000, outputSchema: schema } as InvocationRequest, {
    executable: executable!, cwd: join(root, 'work'), env: isolatedInvocationEnv(join(root, 'home'), join(root, 'codex'), { PATH: process.env.PATH, NO_PROXY: '127.0.0.1' }),
  }, signal);
  return { run, requests, root };
}
const assistant = (value: unknown) => ({ type: 'message', role: 'assistant', id: 'fixture-final', content: [{ type: 'output_text', text: JSON.stringify(value) }] });

it.skipIf(!executable)('real native runtime has no host tools and rejects a forced shell call', async () => {
  let marker = '';
  const h = await harness((_body, index) => index === 1
    ? { type: 'function_call', call_id: 'hostile-call', name: 'exec_command', arguments: JSON.stringify({ cmd: `touch ${marker}` }) }
    : assistant({ content: 'done', tool_calls: [] }));
  marker = join(h.root, 'must-not-exist');
  const result = await h.run('Perform the supplied reasoning.');
  expect(h.requests.length).toBe(2);
  expect(h.requests.every(request => request.tools.length === 0)).toBe(true);
  expect(existsSync(marker)).toBe(false);
  expect(JSON.stringify(h.requests[1])).toMatch(/unknown|unsupported|unrecognized|not found/i);
  expect(result.usage?.inputTokens).toBe(20);
  expect(result.usage?.outputTokens).toBe(10);
  expect(result.actualModel).toBeNull();
});

it.skipIf(!executable)('external tool proposal roundtrip is schema valid and context isolated', async () => {
  const h = await harness(body => JSON.stringify(body.input).includes('TOOL_RESULT=42')
    ? assistant({ content: '42', tool_calls: [] })
    : assistant({ content: '', tool_calls: [{ name: 'add', arguments: '{"left":19,"right":23}' }] }));
  const first = await h.run('Request a proposal for add(19,23).');
  const proposal = (first.output as any).tool_calls[0];
  const args = JSON.parse(proposal.arguments);
  const toolResult = args.left + args.right; // executed by this external fixture
  const second = await h.run(`Prior proposal: ${JSON.stringify(first.output)}\nTOOL_RESULT=${toolResult}`);
  expect(second.output).toEqual({ content: '42', tool_calls: [] });
  expect(second.usage?.inputTokens).toBe(10); // fresh native thread, no prior total
  expect(h.requests.every(request => request.tools.length === 0)).toBe(true);
});

it.skipIf(!executable)('rejects schema-invalid native output', async () => {
  const h = await harness(() => assistant({ content: 42, tool_calls: [] }));
  await expect(h.run('Return JSON')).rejects.toThrow('output_schema_mismatch');
});

it.skipIf(!executable)('cancels a hung native model request and returns only after process exit', async () => {
  const h = await harness(() => null);
  await expect(h.run('Wait forever', AbortSignal.timeout(700))).rejects.toThrow('invocation_aborted');
});

it.skipIf(!executable)('native worker exits on owner process death instead of becoming an orphan', async () => {
  const h = await harness(() => null);
  const params = { executable, cwd: join(h.root, 'work'), env: isolatedInvocationEnv(join(h.root, 'home'), join(h.root, 'codex'), { PATH: process.env.PATH, NO_PROXY: '127.0.0.1' }) };
  const request = { requestId: 'parent-death', prompt: 'Wait', model: 'gpt-5.5', deadlineMs: 15000, outputSchema: schema };
  const parent = spawnTsEvalWithRepoImports(`
    import { runIsolatedCodex } from './src/services/constrained-invocation/codex-runtime.js';
    await runIsolatedCodex(${JSON.stringify(request)}, { ...${JSON.stringify(params)}, onSpawn: pid => console.log(pid) }, AbortSignal.timeout(15000));
  `, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  const nativePid = await new Promise<number>((resolve, reject) => {
    parent.stdout!.once('data', data => resolve(Number(String(data).trim())));
    parent.once('error', reject);
  });
  try {
    await viWait(() => h.requests.length > 0);
    parent.kill('SIGKILL');
    await viWait(() => { try { process.kill(nativePid, 0); return false; } catch { return true; } });
  } finally {
    parent.kill('SIGKILL');
    try { process.kill(-nativePid, 'SIGKILL'); } catch { /* gone */ }
  }
});
async function viWait(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('process_lifecycle_timeout');
}
