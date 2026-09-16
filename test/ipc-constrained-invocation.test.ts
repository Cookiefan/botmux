import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../src/services/constrained-invocation/codex-runtime.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/constrained-invocation/codex-runtime.js')>(),
  runCodexInvocation: vi.fn(async (request: any) => ({ output: { content: request.prompt }, configuredModel: request.model, actualModel: null, reasoningEffort: null, usage: null, usageSource: null, startupMs: 1 })),
}));
import { startIpcServer, setLarkAppId, setIpcAuthSecret, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { registerBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';
import { closeConstrainedInvocations } from '../src/services/constrained-invocation/daemon.js';
import { runCodexInvocation } from '../src/services/constrained-invocation/codex-runtime.js';

let server: IpcServerHandle | undefined;
const secret = 'constrained-invocation-test-secret';
afterEach(async () => { await closeConstrainedInvocations(); await server?.close(); server = undefined; __testOnly_resetBotRegistry(); setIpcAuthSecret(null); vi.clearAllMocks(); });
async function start(cliId = 'codex') {
  registerBot({ larkAppId: 'local_fixture', larkAppSecret: '', apiOnly: true, cliId, codexAuthSync: 'isolated' } as any);
  setLarkAppId('local_fixture'); setIpcAuthSecret(secret);
  server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true, coreOnlyPublicRoutes: true });
  return server;
}
const request = { requestId: 'ipc-round', prompt: 'Synthetic fixture', model: 'fixture-reasoner', deadlineMs: 1000, outputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false } };
it('requires host authentication even with core-only public routes enabled', async () => {
  const s = await start();
  for (const [method, path] of [['GET', '/capabilities'], ['POST', ''], ['GET', '/ipc-round'], ['POST', '/ipc-round/cancel']]) {
    const response = await fetch(`http://127.0.0.1:${s.port}/api/headless/invocations${path}`, { method });
    expect(response.status).toBe(401);
  }
  expect(runCodexInvocation).not.toHaveBeenCalled();
});
it('accepts, retrieves and deduplicates using the authenticated daemon bot scope', async () => {
  const s = await start(); const path = '/api/headless/invocations';
  const call = (method: string, target: string, body?: unknown) => fetchDaemonIpc(s.port, target, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) }, secret);
  expect((await call('POST', path, request)).status).toBe(202);
  const duplicate = await call('POST', path, request); expect([200, 202]).toContain(duplicate.status);
  expect((await call('POST', path, { ...request, prompt: 'different round' })).status).toBe(409);
  const result = await (await call('GET', `${path}/ipc-round`)).json() as any;
  expect(result.result.output).toEqual({ content: request.prompt });
  expect(result.result.configuredModel).toBe(request.model);
  expect(runCodexInvocation).toHaveBeenCalledTimes(1);
  expect(vi.mocked(runCodexInvocation).mock.calls[0][1]).toMatchObject({ ownerOpenId: undefined });
  expect((await call('POST', path, { ...request, requestId: 'forged-owner', ownerOpenId: 'ou_forged' })).status).toBe(400);
});
it('rejects an unsupported CLI without launching a worker', async () => {
  const s = await start('claude-code');
  const response = await fetchDaemonIpc(s.port, '/api/headless/invocations', { method: 'POST', body: JSON.stringify(request), headers: { 'content-type': 'application/json' } }, secret);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: 'constrained_capability_unsupported' });
  expect(runCodexInvocation).not.toHaveBeenCalled();
});

it.each([
  { backendType: 'tmux', codexInstancePool: { enabled: true, scope: 'ordinary-feishu', strategy: 'random', defaultInstanceId: 'fixture', instances: [{ id: 'fixture', codexHome: `${process.env.HOME}/native-fixture` }] } }, { existingAppServer: { endpoint: 'ws://localhost' } },
  { sandbox: true }, { readIsolation: true }, { backendType: 'tmux' },
  { triggerUserAuth: { enabled: true } }, { maxLiveWorkers: 1 },
])('does not bypass a configured execution or identity policy: %j', async policy => {
  const s = await start();
  registerBot({ larkAppId: 'local_fixture', larkAppSecret: '', apiOnly: true, cliId: 'codex', codexAuthSync: 'isolated', ...policy } as any);
  const response = await fetchDaemonIpc(s.port, '/api/headless/invocations', { method: 'POST', body: JSON.stringify(request), headers: { 'content-type': 'application/json' } }, secret);
  expect(response.status).toBe(400);
  expect(runCodexInvocation).not.toHaveBeenCalled();
});
