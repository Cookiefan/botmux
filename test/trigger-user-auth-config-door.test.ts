/**
 * The dashboard's trigger-user-auth save door — does what it stores survive a
 * reload?
 *
 * This is a regression test for a real outage, and the shape of that outage is
 * why the test goes all the way to `loadBotConfigs()` instead of stopping at
 * "the PUT returned ok".
 *
 * The dashboard handler built the policy as JSON **text** and handed the text to
 * `applyConfigField`. For a `kind: 'json'` field that call stores its argument
 * verbatim (`entry[key] = value`) — it does not parse — so `bots.json` ended up
 * holding a string where every reader expects an object. Nothing failed at save
 * time: the PUT answered `ok`, the toggle stayed on, the policy looked applied.
 *
 * The damage landed on the next load. `parseTriggerUserAuthConfig` throws on a
 * non-object, and it runs while parsing one shared `bots.json` array, so a
 * single bad entry meant **no bot loaded at all** and the dashboard crash-looped.
 * A test asserting only "the save succeeded" would have passed throughout.
 *
 * Hence the two halves below: the value must be stored as an object, and a
 * fleet holding one of these entries must still load.
 *
 * Run:  npx vitest run --project unit test/trigger-user-auth-config-door.test.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient {
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) { this.opts = opts; }
  }
  return { Client: FakeClient };
});

vi.mock('../src/im/lark/client.js', () => ({
  resolveAllowedUsersWithMap: async (_appId: string, raw: string[]) => ({
    resolved: raw.filter(v => v.startsWith('ou_')),
    map: new Map<string, string>(),
    entryStatus: new Map<string, 'resolved' | 'transient' | 'definitive'>(),
  }),
}));

async function freshModules() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const store = await import('../src/services/bot-config-store.js');
  return { registry, store };
}

/** The policy exactly as the dashboard panel sends it. */
const PANEL_BODY = { enabled: true, tools: ['lark-cli', 'bytedcli'], fallback: 'bot-identity' };

describe('dashboard trigger-user-auth save door', () => {
  let configPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-tua-door-'));
    configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
    process.env.SESSION_DATA_DIR = dir;
  });
  afterEach(() => { delete process.env.BOTS_CONFIG; delete process.env.SESSION_DATA_DIR; });

  function writeConfig(entries: Array<Record<string, unknown>>) {
    writeFileSync(configPath, JSON.stringify(entries.map((e, i) => ({
      larkAppId: `app_${i}`,
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      ...e,
    })), null, 2), 'utf-8');
  }

  async function loaded(entries: Array<Record<string, unknown>> = [{}]) {
    writeConfig(entries);
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach((c: any) => registry.registerBot(c));
    return { registry, store };
  }

  function onDisk(appId = 'app_0'): unknown {
    const arr = JSON.parse(readFileSync(configPath, 'utf-8'));
    return arr.find((e: any) => e.larkAppId === appId).triggerUserAuth;
  }

  /**
   * Reproduces the save the dashboard performs: coerce the panel's JSON, then
   * apply it. This mirrors `ipcRoute('PUT', '/api/bot-trigger-user-auth')` — the
   * handler is bound to a live IPC server, so the two shared calls it makes are
   * driven directly rather than booting one.
   */
  async function saveLikeDashboard(store: any, body: unknown) {
    const spec = store.findConfigField('triggerUserAuth');
    expect(spec).toBeDefined();
    let value: unknown = null;
    if (body !== null && body !== undefined) {
      const coerced = store.coerceConfigValue(spec, JSON.stringify(body));
      expect(coerced.ok, `coerce must accept ${JSON.stringify(body)}`).toBe(true);
      value = coerced.ok ? coerced.value : null;
    }
    const r = await store.applyConfigField('app_0', spec, value);
    expect(r.ok).toBe(true);
    return value;
  }

  it('stores the policy as an object, never as JSON text', async () => {
    const { store } = await loaded();
    await saveLikeDashboard(store, PANEL_BODY);

    const stored = onDisk();
    // The assertion that actually catches the bug. `toEqual(PANEL_BODY)` alone
    // would NOT: a JSON string of the same policy fails it for the right reason
    // only by accident, so pin the type explicitly.
    expect(typeof stored).toBe('object');
    expect(stored).toEqual(PANEL_BODY);
    expect(typeof stored).not.toBe('string');
  });

  it('leaves a fleet loadable after a dashboard save', async () => {
    // The outage was fleet-wide, so the fixture is a fleet: the saved bot sits
    // first, and the bots after it are the ones that vanished.
    const { store } = await loaded([{}, {}, {}]);
    await saveLikeDashboard(store, PANEL_BODY);

    const { registry } = await freshModules();
    const configs = registry.loadBotConfigs();
    expect(configs).toHaveLength(3);
    expect(configs[0].triggerUserAuth).toEqual(PANEL_BODY);
    // The bots that are not the edited one must come back untouched — under the
    // bug these were collateral damage, and counting them is what distinguishes
    // "the policy round-trips" from "the fleet still boots".
    expect(configs.map((c: any) => c.larkAppId)).toEqual(['app_0', 'app_1', 'app_2']);
  });

  it('turning it off clears the key rather than storing a husk', async () => {
    const { store } = await loaded();
    await saveLikeDashboard(store, PANEL_BODY);
    await saveLikeDashboard(store, null);

    expect(onDisk()).toBeUndefined();
    const { registry } = await freshModules();
    expect(registry.loadBotConfigs()[0].triggerUserAuth).toBeUndefined();
  });

  it('refuses a policy the chat door would also refuse', async () => {
    // Same validation on both doors: the dashboard must not be a way to install
    // a policy `/botconfig set` rejects.
    const { store } = await loaded();
    const spec = store.findConfigField('triggerUserAuth');
    for (const bad of [
      { enabled: true, fallback: 'device' },
      { enabled: true, tools: ['lark-cli', 'nope'] },
      { enabled: 'yes' },
    ]) {
      const coerced = store.coerceConfigValue(spec, JSON.stringify(bad));
      expect(coerced.ok, `must reject ${JSON.stringify(bad)}`).toBe(false);
    }
    // And nothing was written while being refused.
    expect(onDisk()).toBeUndefined();
  });

  it('still loads a fleet whose config already holds the legacy string', async () => {
    // Configs written by the buggy build exist on disk. Upgrading must not
    // require hand-editing them: the entry is read, and its neighbours load.
    await loaded([
      { triggerUserAuth: JSON.stringify(PANEL_BODY) },
      {},
    ]);
    const { registry } = await freshModules();
    const configs = registry.loadBotConfigs();
    expect(configs).toHaveLength(2);
    expect(configs[0].triggerUserAuth).toEqual(PANEL_BODY);
  });
});
