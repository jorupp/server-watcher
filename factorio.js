const { lookup } = require('node:dns/promises');
const { createConnection } = require('node:net');

const DEFAULT_PORT = 34197;

async function query({ host, port, timeout, rconPort, rconPassword }) {
  if (rconPort != null || rconPassword != null) {
    const tcpPort = Number(rconPort);
    if (!Number.isInteger(tcpPort) || tcpPort < 1 || tcpPort > 65535 ||
        typeof rconPassword !== 'string' || !rconPassword || rconPassword.includes('\0')) {
      throw new Error('Factorio RCON requires a valid rcon_port and rcon_password');
    }
    const output = await readOnlinePlayers(host, tcpPort, rconPassword, timeout);
    const players = Array.from(output.matchAll(/^\s*([^\r\n]+?) \(online\)\s*$/gm), match => ({ name: match[1] }));
    const count = /^Online players \((\d+)\):?\s*$/m.exec(output);
    if (!count || Number(count[1]) !== players.length) {
      throw new Error('Unexpected Factorio RCON player list');
    }
    return { players };
  }

  // Matchmaking indexes public games by their resolved game address.
  const { address, family } = await lookup(host.replace(/^\[(.*)\]$/, '$1'));
  const endpoint = `${family === 6 ? `[${address}]` : address}:${port}`;
  const response = await fetch(`https://multiplayer.factorio.com/get-game-details/${endpoint}`, {
    signal: AbortSignal.timeout(timeout),
  });
  if (response.status === 404) throw new Error('Factorio server is absent from public matchmaking');
  if (!response.ok) throw new Error(`Factorio matchmaking returned HTTP ${response.status}`);

  const game = await response.json();
  const players = game?.players ?? [];
  if (typeof game?.name !== 'string' || !Array.isArray(players) ||
      players.some(name => typeof name !== 'string' || !name.trim())) {
    throw new Error('Unexpected Factorio matchmaking response');
  }
  return {
    name: game.name,
    players: players.map(name => ({ name })),
    maxplayers: Number(game.max_players) || 0,
    raw: { version: game.application_version?.game_version },
  };
}

function rconPacket(id, type, text) {
  const body = Buffer.from(text, 'utf8');
  const packet = Buffer.alloc(body.length + 14);
  packet.writeInt32LE(packet.length - 4, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  body.copy(packet, 12);
  return packet;
}

function readOnlinePlayers(host, port, password, timeout) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: host.replace(/^\[(.*)\]$/, '$1'), port });
    const timer = setTimeout(() => socket.destroy(new Error('Factorio RCON timed out')), timeout);
    const authId = 1;
    const commandId = 2;
    let pending = Buffer.alloc(0);
    let authenticated = false;

    socket.once('connect', () => socket.write(rconPacket(authId, 3, password)));
    socket.once('error', reject);
    socket.once('close', () => {
      clearTimeout(timer);
      reject(new Error('Factorio RCON connection closed before receiving the player list'));
    });
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const size = pending.readInt32LE(0);
        if (size < 10 || size > 1024 * 1024) {
          return socket.destroy(new Error('Invalid Factorio RCON packet size'));
        }
        if (pending.length < size + 4) return;
        const packet = pending.subarray(0, size + 4);
        pending = pending.subarray(size + 4);
        const id = packet.readInt32LE(4);
        const type = packet.readInt32LE(8);

        if (!authenticated && type === 2) {
          if (id !== authId) return socket.destroy(new Error('Factorio RCON authentication failed'));
          authenticated = true;
          socket.write(rconPacket(commandId, 2, '/players online'));
        } else if (authenticated && id === commandId && type === 0) {
          resolve(packet.toString('utf8', 12, packet.length - 2));
          return socket.destroy();
        }
      }
    });
  });
}

module.exports = { DEFAULT_PORT, query };
