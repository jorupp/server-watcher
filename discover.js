#!/usr/bin/env node
const GameDig = require('gamedig');
// Use the installed v4 catalog so discovery follows the watcher's supported games.
const GameResolver = require('gamedig/lib/GameResolver');
const { lookup } = require('node:dns/promises');
const yaml = require('js-yaml');
const factorio = require('./factorio');

const HELP = `Usage: node discover.js <host> [options]

  --ports, --port <ports>  Port, range, or comma-separated mix (repeatable)
                          Example: 27015,27020-27030,34197
  --types, --type <types>  Comma-separated GameDig IDs, steam, or factorio
                          Default: all supported types; repeatable
  --list-types            List supported type IDs without scanning
  --timeout <ms>          Timeout per query (default: 3000)
  --concurrency <n>       Ports queried at once, 1-64 (default: 8)
  --json                  Output matches as JSON; progress goes to stderr
  --verbose               Show failed queries on stderr
  --help, -h              Show this help

Without --ports, try each selected type's default query port.
Explicit ports are queried exactly; no automatic port offsets are applied.
Factorio uses public matchmaking; unlisted/LAN games cannot be discovered.
Exit codes: 0 = matches, 1 = no matches, 2 = invalid arguments/query setup.
`;

function integer(value, name, min, max) {
  if (!/^\d+$/.test(value || '') || Number(value) < min || Number(value) > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return Number(value);
}

function parsePorts(value) {
  const ports = new Set();
  for (const part of value.split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!match) throw new Error(`Invalid port or range: ${part}`);
    const start = integer(match[1], 'Port', 1, 65535);
    const end = match[2] ? integer(match[2], 'Port', 1, 65535) : start;
    if (end < start) throw new Error(`Reversed port range: ${part}`);
    for (let port = start; port <= end; port++) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

function parseArgs(args) {
  const options = { timeout: 3000, concurrency: 8, portSpecs: [], typeSpecs: [] };
  const values = {
    '--ports': 'portSpecs', '--port': 'portSpecs',
    '--types': 'typeSpecs', '--type': 'typeSpecs',
    '--timeout': 'timeout', '--concurrency': 'concurrency',
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--help', '-h'].includes(arg)) options.help = true;
    else if (arg === '--list-types') options.listTypes = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (values[arg]) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      const key = values[arg];
      if (Array.isArray(options[key])) options[key].push(value);
      else options[key] = integer(value, arg, 1, key === 'concurrency' ? 64 : 60000);
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (!options.host) options.host = arg.replace(/^\[(.*)\]$/, '$1');
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!options.help && !options.listTypes && !options.host) throw new Error('An IP address or hostname is required');
  if (options.portSpecs.length) options.ports = parsePorts(options.portSpecs.join(','));
  return options;
}

function loadTypes() {
  const resolver = new GameResolver();
  const types = new Map();
  for (const game of resolver.games) {
    for (const id of game.keys) types.set(id, { name: game.pretty, ...game.options });
  }
  types.set('protocol-valve', { name: 'Generic Valve / Steam A2S', protocol: 'valve', port: 27015 });
  types.set('steam', types.get('protocol-valve'));
  types.set('factorio', { name: 'Factorio (public matchmaking)', protocol: 'factorio', port: factorio.DEFAULT_PORT });
  return types;
}

function planScan(options, catalog) {
  const requested = options.typeSpecs.length ? options.typeSpecs.join(',').split(',').map(s => s.trim()) : ['all'];
  const ids = [...new Set(requested.includes('all') ? [...catalog.keys(), ...requested.filter(id => id !== 'all')] : requested)];
  const byPort = new Map();
  for (const id of ids) {
    const definition = catalog.get(id);
    if (!definition) throw new Error(`Unknown type: ${id}. Use --list-types to see supported IDs.`);
    const { name, port, port_query, port_query_offset, ...protocolOptions } = definition;
    const ports = options.ports || [port_query || (port ? port + (port_query_offset || 0) : 27015)];
    for (const targetPort of ports) {
      if (!byPort.has(targetPort)) byPort.set(targetPort, new Map());
      // Games sharing identical query settings are compatible, not separate detections.
      const key = JSON.stringify(Object.entries(protocolOptions).sort(([a], [b]) => a.localeCompare(b)));
      const probes = byPort.get(targetPort);
      if (!probes.has(key)) probes.set(key, { port: targetPort, protocol: definition.protocol, type: id, types: [] });
      probes.get(key).types.push(id);
    }
  }
  return [...byPort.values()].map(probes => [...probes.values()]);
}

async function queryProbe(probe, options) {
  return probe.type === 'factorio'
    ? factorio.query({ host: options.address, port: probe.port, timeout: options.timeout })
    : GameDig.query({
      host: options.host, address: options.address, port: probe.port, type: probe.type,
      givenPortOnly: true, maxAttempts: 1,
      socketTimeout: options.timeout, attemptTimeout: options.timeout,
    });
}

async function scan(options, groups, query = queryProbe, onMatch = () => {}, onFailure = () => {}) {
  let next = 0;
  const matches = [];
  async function worker() {
    while (next < groups.length) {
      const probes = groups[next++];
      // Keep queries to the same endpoint sequential: GameDig shares a UDP socket.
      for (const probe of probes) {
        let server;
        try { server = await query(probe, options); }
        catch (error) { onFailure(probe, error); continue; }
        const match = {
          host: options.host, port: probe.port,
          type: probe.types.includes('protocol-valve') ? 'protocol-valve' : probe.type,
          compatibleTypes: probe.types, protocol: probe.protocol,
          name: server.name || '', map: server.map || '',
          players: server.players?.length ?? 0, maxPlayers: server.maxplayers ?? 0,
          appid: server.raw?.appId ?? null,
        };
        matches.push(match);
        onMatch(match);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, groups.length) }, worker));
  return matches.sort((a, b) => a.port - b.port || a.type.localeCompare(b.type));
}

async function main(args) {
  const options = parseArgs(args);
  if (options.help) { console.log(HELP); return 0; }
  const catalog = loadTypes();
  if (options.listTypes) {
    for (const [id, type] of [...catalog].sort(([a], [b]) => a.localeCompare(b))) console.log(`${id.padEnd(24)} ${type.name}`);
    return 0;
  }
  const groups = planScan(options, catalog);
  // Resolve once, before starting potentially thousands of queries.
  options.address = (await lookup(options.host)).address;
  const total = groups.reduce((count, probes) => count + probes.length, 0);
  console.error(`Trying ${total} queries on ${groups.length} ports at ${options.host} (${options.address}); timeout ${options.timeout}ms. Ctrl+C to stop.`);
  const progress = setInterval(() => console.error('Discovery still running...'), 10000);
  let matches;
  try {
    matches = await scan(options, groups, queryProbe, match => {
      console.error(`Found ${JSON.stringify(match.name)} on port ${match.port} (${match.protocol}; compatible type: ${match.type})`);
    }, (probe, error) => {
      if (options.verbose) console.error(`${probe.port}/${probe.type}: ${error.message}`);
    });
  } finally { clearInterval(progress); }
  if (options.json) console.log(JSON.stringify(matches, null, 2));
  else if (matches.length) {
    console.log('# Copy entries into servers.yaml. Types identify compatible queries; games may share protocols.');
    console.log(yaml.dump({ servers: matches.map(match => ({
      label: match.name || `${options.host}:${match.port}`,
      host: match.host, port: match.port, type: match.type,
    })) }));
  }
  console.error(matches.length ? `${matches.length} matching queries found.` : 'No matching responses. Servers may be offline, filtered, unlisted, or require a longer timeout.');
  return matches.length ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(`Discovery error: ${error.message}`);
    process.exitCode = 2;
  });
}

module.exports = { parseArgs, parsePorts, loadTypes, planScan, scan };
