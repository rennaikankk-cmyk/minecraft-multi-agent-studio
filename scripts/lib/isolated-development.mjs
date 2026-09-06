import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

const exec = promisify(execFile);
export const requireFact = (value, code) => { if (!value) throw new Error(code); };
export async function waitForFact(predicate, code, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(code);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Explicit development entry only. All server mutations target this run's owned fixture. */
export async function withIsolatedDevelopment(name, work) {
  requireFact(/^[a-z0-9-]{1,40}$/.test(name), 'INVALID_SCENARIO_NAME');
  const runId = `${name}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const container = `studio-e2e-${runId}`, volume = `studio-e2e-world-${runId}`;
  const dir = path.resolve('runtime-data/development-v2', runId);
  mkdirSync(dir, { recursive: true });
  const report = { runId, mode: 'E2E', minecraftVersion: '1.21.11', source: 'real SingleBotRuntime and server-owned disposable world',
    candidate: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
    workingTreeDiff: (await exec('git', ['diff', '--stat'])).stdout.trim(),
    injected: [], operations: [], checks: [], events: {}, diagnostics: [], passed: false, cleanup: false };
  process.env.STUDIO_MODE = 'E2E';
  process.env.STUDIO_GAMEPLAY_PROFILE = 'standard';
  process.env.STUDIO_SPAWN_ESCAPE = '0';
  process.env.STUDIO_NO_HUNGER = '0';
  process.env.STUDIO_WORLD_QUERY_PROVIDER = '1';
  process.env.STUDIO_WORLD_QUERY_SHADOW = '0';
  process.env.STUDIO_SHARED_STATE_URL = 'http://127.0.0.1:1';
  delete process.env.STUDIO_SHARED_STATE_TOKEN;
  delete process.env.STUDIO_INCIDENT_ENDPOINT;
  delete process.env.STUDIO_INCIDENT_TOKEN;
  process.env.STUDIO_INCIDENT_SPOOL_PATH = path.join(dir, 'incidents.jsonl');
  const { SingleBotRuntime } = await import('../../apps/bot-runtime/dist/runtime.js');
  const { MineflayerBotClient, createMineflayerOptions } = await import('../../apps/bot-runtime/dist/mineflayer-client.js');
  const { serverProfileSchema } = await import('../../apps/bot-runtime/dist/server-profile.js');
  const { terminatePathfinderWorker } = await import('../../apps/bot-runtime/dist/rust-pathfinder.js');
  const { WorldAssetAuthority, InMemoryWorkstationRegistry, builtinSkills } = await import('../../packages/skills/dist/index.js');
  const { BotRegistry } = await import('../../apps/coordinator/dist/bot-registry.js');
  const require = createRequire(path.resolve('apps/bot-runtime/package.json'));
  const { createBot } = require('mineflayer');
  const { pathfinder } = require('mineflayer-pathfinder');
  const { plugin: collectBlock } = require('mineflayer-collectblock');
  const assets = new WorldAssetAuthority(), workstations = new InMemoryWorkstationRegistry();
  const registry = new BotRegistry({ staleAfterMs: 15_000 });
  const runtimes = [];
  let ownsContainer = false, ownsVolume = false;
  const docker = async (args, timeout = 30_000) => (await exec('docker', args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  const command = async (text, injection = true) => {
    const response = await docker(['exec', container, 'rcon-cli', text]);
    requireFact(!/Unknown|Incorrect|not loaded|outside of the world|No entity was found/i.test(response), `FIXTURE_COMMAND_REJECTED:${response.slice(0, 200)}`);
    if (injection) report.injected.push({ command: text, response });
    return response;
  };
  try {
    await docker(['image', 'inspect', 'studio-e2e-mc-cached:1.21.11']);
    await docker(['volume', 'create', '--label', `studio.runId=${runId}`, volume]); ownsVolume = true;
    await docker(['run', '-d', '--pull=never', '--name', container, '--label', 'studio.serverKind=e2e_fixture', '--label', `studio.runId=${runId}`,
      '-p', '127.0.0.1::25565', '-v', `${volume}:/data`, '-e', 'EULA=TRUE', '-e', 'ONLINE_MODE=FALSE', '-e', 'TYPE=CUSTOM',
      '-e', 'CUSTOM_SERVER=/opt/server.jar', '-e', 'MEMORY=2G', '-e', 'MODE=survival', '-e', 'DIFFICULTY=peaceful', '-e', 'VIEW_DISTANCE=4',
      '-e', 'SIMULATION_DISTANCE=3', '-e', 'SPAWN_PROTECTION=0', '-e', 'LEVEL_TYPE=minecraft:flat', 'studio-e2e-mc-cached:1.21.11']); ownsContainer = true;
    await waitForFact(async () => /Done \(/.test(await docker(['logs', '--tail', '30', container])), 'SERVER_START_TIMEOUT', 180_000);
    const port = Number((await docker(['port', container, '25565/tcp'])).split(':').at(-1));
    await command('forceload add -16 -16 48 48');
    await waitForFact(async () => (await command('execute if loaded 32 80 32', false)).includes('Test passed'), 'FIXTURE_NOT_LOADED');
    for (const text of ['gamerule minecraft:advance_time false', 'time set noon', 'gamerule minecraft:random_tick_speed 0',
      'fill -16 80 -16 48 80 48 minecraft:stone', 'setworldspawn 8 81 8']) await command(text);
    const startBot = async (id) => {
      requireFact(/^[A-Za-z0-9_]{1,16}$/.test(id), 'INVALID_TEST_BOT_ID');
      const profile = serverProfileSchema.parse({ schemaVersion: '1.0', id: 'isolated-development-v2', botId: id, purpose: 'isolated-test',
        networkScope: 'loopback', host: '127.0.0.1', port, minecraftVersion: '1.21.11', username: id, auth: 'offline',
        statusIntervalMs: 250, heartbeatIntervalMs: 1000, stopGracePeriodMs: 3000,
        reconnect: { enabled: false, maxAttempts: 0, baseDelayMs: 500, maxDelayMs: 500 } });
      let client;
      const logger = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (event, detail) => {
        report.events[event] = (report.events[event] ?? 0) + 1;
        if (/fault|invalid|safety_decision/.test(event) && report.diagnostics.length < 100) report.diagnostics.push({ event, detail });
      }]));
      const runtime = new SingleBotRuntime(profile, { logger, messageSink: (message) => registry.ingest(message),
        createClient: (config, worldState) => {
          const bot = createBot(createMineflayerOptions(config));
          const originalWrite = bot._client.write.bind(bot._client);
          bot._client.write = (packet, data) => {
            if (['player_loaded', 'block_place', 'use_entity', 'window_click', 'close_window', 'teleport_confirm', 'client_command'].includes(packet) && report.diagnostics.length < 100) report.diagnostics.push({ botId: id, direction: 'out', packet, data, at: Date.now() });
            return originalWrite(packet, data);
          };
          bot._client.on('packet', (data, meta) => {
            if (['open_window', 'window_items', 'block_changed_ack', 'kick_disconnect'].includes(meta.name) && report.diagnostics.length < 100) report.diagnostics.push({ botId: id, direction: 'in', packet: meta.name, data });
          });
          bot.loadPlugin(pathfinder); bot.loadPlugin(collectBlock);
          client = new MineflayerBotClient(bot, config.minecraftVersion, config.id, false, worldState, 'safe',
            { host: config.host, port: config.port }, config.noHunger, workstations, { assets, workAreas: assets.workAreas });
          return client;
        } });
      runtimes.push(runtime); runtime.start();
      await waitForFact(() => registry.get(id)?.connectionState === 'online' && registry.get(id)?.skillCatalog, 'BOT_READY_TIMEOUT', 60_000);
      const count = (name) => client.bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0);
      await command(`give ${id} minecraft:bread 16`);
      await waitForFact(() => count('bread') === 16, 'FOOD_FIXTURE_UNCONFIRMED');
      const invoke = async (skillId, input, options = {}) => {
        const skill = builtinSkills.find((s) => s.id === skillId);
        requireFact(skill, 'SKILL_NOT_REGISTERED');
        const now = new Date().toISOString(), expiresAt = new Date(Date.now() + skill.timeoutMs + 5000).toISOString();
        const invocation = options.invocation ?? { schemaVersion: '1.0', messageId: randomUUID(), traceId: `${runId}-${id}`, timestamp: now,
          source: { service: 'coordinator', instanceId: 'isolated-development-coordinator' }, botId: id, taskId: options.taskId ?? `dev-${randomUUID()}`,
          type: 'skill.invoke.v1', payload: { invocationId: randomUUID(), skillId, skillVersion: skill.version, expiresAt, input,
            authorization: { decisionId: randomUUID(), actorId: 'isolated-development-operator', issuedAt: now, expiresAt } } };
        const result = await runtime.handleCoordinatorSkillInvocation(invocation, 'isolated-development-coordinator', options.signal);
        report.operations.push({ goalId: options.goalId ?? name, botId: id, traceId: invocation.traceId, taskId: invocation.taskId, invocation, result,
          positionAfter: client.bot.entity?.position, controlsAfter: client.bot.controlState, heldItem: client.bot.heldItem?.name,
          worldAfter: client.worldStateSnapshot() });
        return { invocation, result, output: result.payload.output };
      };
      return { id, profile, runtime, client, bot: client.bot, count, invoke };
    };
    await work({ runId, dir, report, command, startBot, registry, assets, workstations });
    report.passed = true;
  } catch (error) { report.error = { message: error.message, code: error.code ?? null, stack: error.stack }; process.exitCode = 1; }
  finally {
    const errors = [];
    for (const runtime of runtimes) await runtime.stop('isolated development complete').catch(() => errors.push('runtime-stop'));
    await terminatePathfinderWorker().catch(() => errors.push('worker-stop'));
    if (ownsContainer) await docker(['rm', '-f', container], 60_000).catch(() => errors.push('container-remove'));
    if (ownsVolume) await docker(['volume', 'rm', volume]).catch(() => errors.push('volume-remove'));
    report.cleanup = errors.length === 0; report.cleanupErrors = errors;
    if (errors.length) process.exitCode = 1;
    writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
    console.log(JSON.stringify({ runId, dir, passed: report.passed, error: report.error, checks: report.checks, cleanup: report.cleanup }));
  }
  return report;
}
