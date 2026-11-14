const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const varint = require('varint');
const { parseArgs, parsePorts, loadTypes, planScan, scan } = require('./discover');

test('port ranges are validated, expanded and deduplicated', () => {
  assert.deepEqual(parsePorts('27017,27015-27017,34197'), [27015, 27016, 27017, 34197]);
  for (const value of ['0', '65536', '3-1', 'abc', '1,', '1.5']) assert.throws(() => parsePorts(value));
  assert.throws(() => parseArgs(['localhost', '--timeout', '0']));
  assert.throws(() => parseArgs(['localhost', '--concurrency', '65']));
  assert.throws(() => parseArgs(['localhost', '--ports']));
});

test('scan planning respects exact ports, defaults, aliases and supported types', () => {
  const catalog = loadTypes();
  const options = parseArgs(['localhost', '--port', '30000', '--ports', '30000-30001', '--types', 'steam,csgo', '--type', 'factorio']);
  const groups = planScan(options, catalog);
  assert.deepEqual(groups.map(group => group[0].port), [30000, 30001]);
  assert.equal(groups.flat().length, 4);
  assert.deepEqual(groups[0][0].types, ['steam', 'csgo']);
  const defaults = planScan(parseArgs(['localhost', '--types', 'arma3,factorio']), catalog);
  assert.deepEqual(defaults.map(group => group[0].port), [2303, 34197]);
  assert.throws(() => planScan(parseArgs(['localhost', '--type', 'typo']), catalog), /Unknown type/);
  const all = planScan(parseArgs(['localhost', '--ports', '30000']), catalog).flat();
  assert.ok(all.some(probe => probe.types.includes('minecraft')));
  assert.ok(all.some(probe => probe.types.includes('factorio')));
  assert.ok(all.length < catalog.size);
});

test('workers bound concurrency, continue after failures, and retain multiple matches', async () => {
  const options = { host: 'localhost', concurrency: 2 };
  const groups = [1, 2, 3].map(port => ['steam', 'factorio'].map(type => ({ port, type, types: [type], protocol: type })));
  let active = 0;
  let peak = 0;
  const activePorts = new Set();
  let failures = 0;
  const matches = await scan(options, groups, async probe => {
    assert.ok(!activePorts.has(probe.port));
    activePorts.add(probe.port);
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    activePorts.delete(probe.port);
    if (probe.port === 2) throw new Error('timeout');
    return { name: 'Test server', players: [{ name: 'Player' }], raw: { appId: 730 } };
  }, () => {}, () => failures++);
  assert.equal(peak, 2);
  assert.equal(failures, 2);
  assert.equal(matches.length, 4);
  assert.equal(matches[0].appid, 730);
});

test('CLI finds a real local Minecraft status response and handles no matches', async () => {
  const server = net.createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', () => {
      const json = Buffer.from(JSON.stringify({ description: 'Discovery fixture', players: { online: 2, max: 10 } }));
      const packet = Buffer.concat([Buffer.from([0]), Buffer.from(varint.encode(json.length)), json]);
      socket.end(Buffer.concat([Buffer.from(varint.encode(packet.length)), packet]));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const run = promisify(execFile);
  try {
    const { stdout, stderr } = await run(process.execPath, ['discover.js', '127.0.0.1', '--port', String(port), '--type', 'minecraft', '--timeout', '500', '--json'], { cwd: __dirname });
    const matches = JSON.parse(stdout);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].name, 'Discovery fixture');
    assert.equal(matches[0].port, port);
    assert.equal(matches[0].players, 2);
    assert.match(stderr, /Found/);
  } finally { await new Promise(resolve => server.close(resolve)); }
  await assert.rejects(run(process.execPath, ['discover.js', '127.0.0.1', '--port', String(port), '--type', 'minecraft', '--timeout', '100', '--json'], { cwd: __dirname }), error => {
    assert.equal(error.code, 1);
    assert.deepEqual(JSON.parse(error.stdout), []);
    return true;
  });
});
