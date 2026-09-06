import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(predicate, code, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error(code); await delay(100); }
}
const requireFact = (fact, code) => { if (!fact) throw new Error(code); };
const quantiles = (values) => {
  values.sort((a, b) => a - b);
  const at = (p) => values.length ? values[Math.min(values.length - 1, Math.floor(values.length * p))] : null;
  return { n: values.length, p50: at(.5), p95: at(.95), p99: at(.99), max: at(1) };
};

async function botProcess() {
  const [portText, botId, mode, durationText] = process.argv.slice(3);
  const port = Number(portText), durationMs = Number(durationText);
  requireFact(Number.isInteger(port) && port > 0 && /^[A-Za-z0-9_]{1,16}$/.test(botId), 'INVALID_LOCAL_BOT_CONFIG');
  process.env.STUDIO_MODE = mode === 'normal' ? 'NORMAL' : 'E2E';
  process.env.STUDIO_WORLD_QUERY_PROVIDER = mode === 'legacy' ? '0' : '1';
  process.env.STUDIO_WORLD_QUERY_SHADOW = mode === 'shadow' ? '1' : '0';
  process.env.STUDIO_GAMEPLAY_PROFILE = 'standard';
  process.env.STUDIO_SPAWN_ESCAPE = '0';
  process.env.STUDIO_NO_HUNGER = '0';
  process.env.STUDIO_WORLD_MIRROR_SYNC = '0';
  process.env.STUDIO_SHARED_STATE_URL = 'http://127.0.0.1:1';
  delete process.env.STUDIO_SHARED_STATE_TOKEN;
  delete process.env.STUDIO_INCIDENT_ENDPOINT;
  delete process.env.STUDIO_INCIDENT_TOKEN;
  const { SingleBotRuntime } = await import('../apps/bot-runtime/dist/runtime.js');
  const { createMineflayerClient } = await import('../apps/bot-runtime/dist/mineflayer-client.js');
  const { terminatePathfinderWorker } = await import('../apps/bot-runtime/dist/rust-pathfinder.js');
  const { serverProfileSchema } = await import('../apps/bot-runtime/dist/server-profile.js');
  const profile = serverProfileSchema.parse({ schemaVersion: '1.0', id: 'isolated-d4', botId, purpose: 'isolated-test', networkScope: 'loopback',
    host: '127.0.0.1', port, minecraftVersion: '1.21.11', username: botId, auth: 'offline', statusIntervalMs: 250,
    heartbeatIntervalMs: 1000, stopGracePeriodMs: 3000, reconnect: { enabled: false, maxAttempts: 0, baseDelayMs: 500, maxDelayMs: 500 } });
  let client, latest, scans = 0, measuring = false;
  const spans = {}, eventCounts = {}, syncEvents = [];
  const record = (name, ms) => { if (measuring) { const entries = spans[name] ??= []; if (entries.length < 20_000) entries.push(ms); } };
  const logger = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (event) => { eventCounts[event] = (eventCounts[event] ?? 0) + 1; }]));
  const runtime = new SingleBotRuntime(profile, { logger, messageSink: (message) => { if (message.type === 'bot.world-state.v1') latest = message.payload; },
    createClient: (config, worldState) => {
      client = createMineflayerClient(config, worldState);
      client.bot.on('log', (event, detail) => {
        if (/world-sync:(warn|error)/.test(event) && syncEvents.length < 30) syncEvents.push({ event, detail });
      });
      client.bot.once('spawn', () => {
        const original = client.bot.findBlocks.bind(client.bot);
        client.bot.findBlocks = (...args) => { if (measuring) scans++; return original(...args); };
      });
      const setRecorder = client.setPerfRecorder.bind(client);
      client.setPerfRecorder = (sink) => setRecorder((name, ms, detail) => { record(name, ms); sink?.(name, ms, detail); });
      const setWrap = client.setPerfSpanWrap.bind(client);
      client.setPerfSpanWrap = (wrap) => setWrap((name, fn) => {
        const started = performance.now(); try { wrap ? wrap(name, fn) : fn(); } finally { record(name, performance.now() - started); }
      });
      return client;
    } });
  let sequence = 0;
  const commands = new Map();
  process.on('message', (message) => { if (message.type === 'rconResult') { const pending = commands.get(message.id); commands.delete(message.id); message.error ? pending?.reject(new Error(message.error)) : pending?.resolve(); } });
  const rcon = (command) => new Promise((resolve, reject) => { const id = ++sequence; commands.set(id, { resolve, reject }); process.send({ type: 'rcon', id, command }); });
  const result = { botId, mode, source: 'real Minecraft 1.21.11 / SingleBotRuntime / process per Bot', input: profile.id, durationMs, evidence: {} };
  const loop = monitorEventLoopDelay({ resolution: 5 });
  try {
    runtime.start();
    await wait(() => latest && client?.bot?.entity, 'BOT_LOGIN_TIMEOUT');
    await rcon(`give ${botId} minecraft:bread 16`);
    await rcon(`tp ${botId} 8.5 81 8.5`);
    await wait(() => mode === 'legacy' ? latest.nearbyUtilityBlocks.length > 0 : latest.worldQuery?.status === 'FRESH', 'WORLD_QUERY_READY_TIMEOUT');
    const capability = (signal = new AbortController().signal) => ({ invocationId: randomUUID(), traceId: `d4-${botId}`, taskId: 'd4-local-consumer', botId,
      skillId: 'world.scan', skillVersion: '1.0.0', capability: 'world.read', operation: 'world.scan-blocks-safe', signal,
      input: { blockName: 'oak_log', maxCount: 4, maxDistance: 32, dimension: 'minecraft:overworld', serverProfileId: profile.id } });
    let scan;
    await wait(async () => { scan = await client.invokeSkillCapability(capability()); return scan.matches.length > 0; }, 'REAL_SCAN_TARGET_MISSING');
    result.evidence.scan = scan;
    const controller = new AbortController(); controller.abort();
    try { await client.invokeSkillCapability(capability(controller.signal)); throw new Error('CANCEL_WAS_ACCEPTED'); }
    catch (error) { requireFact(error.code === 'SKILL_CANCELLED', 'CANCEL_NOT_PROPAGATED'); result.evidence.cancelled = true; }
    if (mode === 'shadow') await wait(() => client.worldQueryDiagnostics().shadow.counts.match > 0, 'SHADOW_NO_STABLE_MATCH');
    measuring = true; loop.enable(); const cpu = process.cpuUsage(), began = performance.now();
    await delay(durationMs);
    const used = process.cpuUsage(cpu); loop.disable(); measuring = false;
    result.cpuMs = (used.user + used.system) / 1000;
    result.cpuPercentOneCore = result.cpuMs / (performance.now() - began) * 100;
    result.rssBytes = process.memoryUsage().rss;
    result.eventLoopMs = { p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 };
    result.spans = Object.fromEntries(Object.entries(spans).map(([name, values]) => [name, quantiles(values)]));
    result.periodicFindBlocks = scans;
    result.query = client.worldQueryDiagnostics();
    result.evidence.telemetry = latest.worldQuery ?? null;
    if (mode === 'normal') {
      requireFact(scans === 0, 'NORMAL_LEGACY_PERIODIC_SCAN');
      requireFact(result.eventLoopMs.p99 <= 25, 'EVENT_LOOP_P99_GATE');
      requireFact(result.spans['world.snapshot.total']?.p99 <= 10, 'SNAPSHOT_P99_GATE');
      requireFact(result.spans['tick.physics.stateChanged']?.p99 <= 15, 'PHYSICS_CALLBACK_P99_GATE');
    }
    if (mode === 'shadow') {
      result.evidence.shadow = client.worldQueryReplayEvidence();
      requireFact(result.query.shadow.counts.mismatch === 0 && result.query.shadow.counts.oracleError === 0, 'SHADOW_MISMATCH');
      const before = client.worldQueryDiagnostics().context.scope.botSessionId;
      await terminatePathfinderWorker(); client.worldQueryProvider.reset();
      await wait(() => { client.worldStateSnapshot(); const d = client.worldQueryDiagnostics(); return d.context?.scope.botSessionId !== before && d.context?.settled; }, 'WORKER_RESTART_FAILED');
      result.evidence.workerRestart = { recovered: true, attempts: client.worldQueryDiagnostics().recoveryAttempts };
      await rcon('setblock 2 81 2 minecraft:air');
      await wait(() => { const s = client.worldStateSnapshot(); return s.worldQuery?.status === 'FRESH' && !s.nearbyBlocks.some((b) => b.position.x === 2 && b.position.y === 81 && b.position.z === 2); }, 'REMOVED_BLOCK_REMAINED');
      result.evidence.serverMutation = 'server removal propagated to consumer snapshot';
    }
    result.passed = true;
  } catch (error) { result.passed = false; result.error = error.message; result.query = client?.worldQueryDiagnostics(); result.events = eventCounts; result.syncEvents = syncEvents; }
  finally { loop.disable(); await runtime.stop('isolated D4 complete').catch(() => {}); await terminatePathfinderWorker(); }
  process.send({ type: 'result', result });
  process.disconnect();
  if (!result.passed) process.exitCode = 1;
}

async function driver() {
  const runId = `d4-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const container = `studio-e2e-${runId}`, volume = `studio-e2e-world-${runId}`;
  const dir = path.resolve('runtime-data/world-query', runId); mkdirSync(dir, { recursive: true });
  const docker = async (args, timeout = 30_000) => (await exec('docker', args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  const report = { runId, mode: 'LOCAL_TEST/E2E owned loopback fixture', injected: 'flat platform, daylight, materials, frozen random growth; no external server',
    candidate: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(), workingTreeDiff: (await exec('git', ['diff', '--stat'])).stdout.trim(), results: [], cleanup: false };
  let ownsContainer = false, ownsVolume = false;
  const children = new Set();
  try {
    await docker(['image', 'inspect', 'studio-e2e-mc-cached:1.21.11']);
    await docker(['volume', 'create', '--label', `studio.runId=${runId}`, volume]); ownsVolume = true;
    await docker(['run', '-d', '--pull=never', '--name', container, '--label', 'studio.serverKind=e2e_fixture', '--label', `studio.runId=${runId}`,
      '-p', '127.0.0.1::25565', '-v', `${volume}:/data`, '-e', 'EULA=TRUE', '-e', 'ONLINE_MODE=FALSE', '-e', 'TYPE=CUSTOM',
      '-e', 'CUSTOM_SERVER=/opt/server.jar', '-e', 'MEMORY=2G', '-e', 'MODE=survival', '-e', 'DIFFICULTY=peaceful', '-e', 'VIEW_DISTANCE=4',
      '-e', 'SIMULATION_DISTANCE=3', '-e', 'SPAWN_PROTECTION=0', '-e', 'LEVEL_TYPE=minecraft:flat', 'studio-e2e-mc-cached:1.21.11']); ownsContainer = true;
    await wait(async () => /Done \(/.test(await docker(['logs', '--tail', '30', container])), 'SERVER_START_TIMEOUT', 180_000);
    const port = Number((await docker(['port', container, '25565/tcp'])).split(':').at(-1));
    const command = async (text) => {
      const response = await docker(['exec', container, 'rcon-cli', text]);
      requireFact(!/Unknown|Incorrect|not loaded|outside of the world|No entity was found/i.test(response), `LOCAL_COMMAND_REJECTED:${response.slice(0, 200)}`);
      return response;
    };
    await command('forceload add -16 -16 40 40');
    await wait(async () => (await command('execute if loaded 32 80 32')).includes('Test passed'), 'FIXTURE_CHUNKS_NOT_LOADED');
    for (const cmd of ['gamerule minecraft:advance_time false', 'time set noon', 'gamerule minecraft:random_tick_speed 0',
      'fill -16 80 -16 40 80 40 minecraft:stone', 'setworldspawn 8 81 8']) await command(cmd);
    const names = ['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'chest', 'barrel', 'red_bed', 'blue_shulker_box', 'water', 'lava',
      'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'coal_ore', 'iron_ore', 'diamond_ore', 'wheat', 'carrots', 'potatoes'];
    for (let i = 0; i < names.length; i++) {
      const x = 2 + (i % 8) * 3, z = 2 + Math.floor(i / 8) * 5;
      if (['water', 'lava'].includes(names[i])) await command(`fill ${x - 1} 81 ${z - 1} ${x + 1} 81 ${z + 1} minecraft:glass`);
      if (['wheat', 'carrots', 'potatoes'].includes(names[i])) await command(`setblock ${x} 80 ${z} minecraft:farmland[moisture=7]`);
      await command(`setblock ${x} 81 ${z} minecraft:${names[i]}`);
    }
    report.fixtureConfirmed = (await command('execute if block 2 81 2 minecraft:crafting_table')).includes('Test passed');
    requireFact(report.fixtureConfirmed, 'FIXTURE_SERVER_READBACK_FAILED');
    console.log(JSON.stringify({ runId, phase: 'fixture-confirmed' }));
    const runBot = (id, mode) => new Promise((resolve, reject) => {
      const child = fork(fileURLToPath(import.meta.url), ['--bot', String(port), id, mode, '20000'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.add(child); let result; let diagnostic = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error(`BOT_PROCESS_TIMEOUT:${id}`)); }, 150_000);
      child.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-8000); });
      child.stdout.on('data', () => {});
      child.on('message', (message) => {
        if (message.type === 'result') result = message.result;
        if (message.type === 'rcon') void command(message.command).then(() => child.connected && child.send({ type: 'rconResult', id: message.id }))
          .catch(() => child.connected && child.send({ type: 'rconResult', id: message.id, error: 'LOCAL_RCON_FAILED' }));
      });
      child.once('exit', (code) => { clearTimeout(timer); children.delete(child); resolve(result ?? { botId: id, passed: false, error: `PROCESS_EXIT_${code}`, diagnostic }); });
      child.once('error', reject);
    });
    for (const mode of ['legacy', 'shadow']) {
      const result = await runBot(`D4_${mode}`, mode); report.results.push(result); requireFact(result.passed, result.error ?? 'BOT_VALIDATION_FAILED');
      console.log(JSON.stringify({ runId, phase: mode, passed: result.passed }));
    }
    const group = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => runBot(`D4_load_${index}`, 'normal')));
    for (const result of group) { if (result.status === 'fulfilled') report.results.push(result.value); else report.results.push({ passed: false, error: result.reason.message }); }
    requireFact(report.results.every((result) => result.passed), 'MULTI_BOT_VALIDATION_FAILED');
    report.passed = true;
  } catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
  finally {
    for (const child of children) child.kill();
    const errors = [];
    if (ownsContainer) await docker(['rm', '-f', container], 60_000).catch(() => errors.push('container-remove'));
    if (ownsVolume) await docker(['volume', 'rm', volume]).catch(() => errors.push('volume-remove'));
    report.cleanup = errors.length === 0; report.cleanupErrors = errors;
    if (errors.length) process.exitCode = 1;
    writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ dir, passed: report.passed, error: report.error, cleanup: report.cleanup,
      results: report.results.map(({ botId, passed, error, periodicFindBlocks, eventLoopMs, rssBytes }) => ({ botId, passed, error, periodicFindBlocks, eventLoopMs, rssBytes })) }));
  }
}

if (process.argv[2] === '--bot') await botProcess(); else await driver();
