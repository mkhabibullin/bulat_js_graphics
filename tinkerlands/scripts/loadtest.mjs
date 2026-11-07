// Load test: connects simulated players to a running server and reports the
// server's tick times from /metrics. Each bot sends 30 inputs a second, chats
// now and then, and builds now and then (in worlds that allow it).
//
//   METRICS_TOKEN=secret RATE_GUESTS_PER_HOUR=100000 MAX_CONNECTIONS_PER_IP=100000 npm start
//   METRICS_TOKEN=secret node scripts/loadtest.mjs [players=150] [rooms=5] [seconds=30] [url=http://127.0.0.1:8080]

import { WebSocket } from 'ws';

const players = Number(process.argv[2] ?? 150);
const roomCount = Number(process.argv[3] ?? 5);
const seconds = Number(process.argv[4] ?? 30);
const base = process.argv[5] ?? 'http://127.0.0.1:8080';
const metricsToken = process.env.METRICS_TOKEN;
const PROTOCOL_VERSION = 3;

const worlds = ['open-plots', 'skyline-sprint', 'sunny-isle', 'cinder-spiral', 'bounce-basin'].slice(0, roomCount);
const wsUrl = base.replace(/^http/, 'ws') + '/ws';

async function readMetrics() {
  if (!metricsToken) return null;
  const res = await fetch(`${base}/metrics`, { headers: { Authorization: `Bearer ${metricsToken}` } });
  const text = await res.text();
  const value = (name) => Number(new RegExp(`^${name.replace(/[{}"+.]/g, '\\$&')} (.*)$`, 'm').exec(text)?.[1] ?? NaN);
  const buckets = [...text.matchAll(/^tinkerlands_tick_duration_ms_bucket\{le="([^"]+)"\} (\d+)$/gm)].map((m) => [m[1], Number(m[2])]);
  return {
    buckets,
    sum: value('tinkerlands_tick_duration_ms_sum'),
    count: value('tinkerlands_tick_duration_ms_count'),
    skipped: value('tinkerlands_ticks_skipped_total') || 0,
    online: value('tinkerlands_players_online'),
    rss: value('process_resident_memory_bytes'),
  };
}

let received = 0;
let bytes = 0;
let closed = 0;
const rtts = [];
const sockets = [];

async function startBot(i) {
  const res = await fetch(`${base}/api/auth/guest`, { method: 'POST' });
  if (!res.ok) throw new Error(`guest signup failed: ${res.status}. Raise RATE_GUESTS_PER_HOUR on the server.`);
  const { token } = await res.json();
  const ws = new WebSocket(wsUrl);
  sockets.push(ws);
  let seq = 0;
  let timer;
  ws.on('open', () => {
    ws.send(JSON.stringify({ t: 'join', token, worldId: worlds[i % worlds.length], v: PROTOCOL_VERSION }));
    let tick = 0;
    let yaw = Math.random() * 6;
    timer = setInterval(() => {
      tick++;
      if (tick % 45 === 0) yaw = Math.random() * 6;
      ws.send(JSON.stringify({ t: 'i', s: ++seq, f: 1, r: 0, y: yaw, j: tick % 40 === 0 ? 1 : 0 }));
      if (tick % 30 === 0) ws.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
      if (tick % 300 === i % 300) ws.send(JSON.stringify({ t: 'c', m: `hello from bot ${i}` }));
    }, 1000 / 30);
  });
  ws.on('message', (data) => {
    received++;
    bytes += data.length;
    const text = data.toString();
    if (text.startsWith('{"t":"pong"')) rtts.push(Date.now() - JSON.parse(text).ts);
  });
  ws.on('close', () => {
    closed++;
    clearInterval(timer);
  });
  ws.on('error', () => {});
}

console.log(`Connecting ${players} players across ${worlds.length} rooms…`);
for (let i = 0; i < players; i++) {
  await startBot(i);
  if (i % 20 === 19) await new Promise((r) => setTimeout(r, 50));
}
await new Promise((r) => setTimeout(r, 2000));

const before = await readMetrics();
received = 0;
bytes = 0;
rtts.length = 0;
const started = Date.now();
await new Promise((r) => setTimeout(r, seconds * 1000));
const elapsed = (Date.now() - started) / 1000;
const after = await readMetrics();

rtts.sort((a, b) => a - b);
const pct = (list, p) => (list.length ? list[Math.min(list.length - 1, Math.floor(list.length * p))] : NaN);

console.log(`\nDuration          ${elapsed.toFixed(0)} s`);
console.log(`Sockets closed    ${closed}`);
console.log(`Down, per player  ${((bytes / elapsed / players) / 1024).toFixed(1)} KB/s`);
console.log(`Round trip        p50 ${pct(rtts, 0.5)} ms, p99 ${pct(rtts, 0.99)} ms`);
if (before && after) {
  const ticks = after.count - before.count;
  console.log(`Players online    ${after.online}`);
  console.log(`Ticks             ${ticks} (${(ticks / elapsed).toFixed(1)} per second, target 30)`);
  console.log(`Ticks skipped     ${after.skipped - before.skipped}`);
  console.log(`Tick time, mean   ${((after.sum - before.sum) / ticks).toFixed(2)} ms (budget 33.3 ms)`);
  const lines = after.buckets.map(([le, n], i) => `<=${le}ms: ${n - (before.buckets[i]?.[1] ?? 0)}`);
  console.log(`Tick histogram    ${lines.join('  ')}`);
  console.log(`Server memory     ${(after.rss / 1048576).toFixed(0)} MB`);
} else {
  console.log('Set METRICS_TOKEN on both sides for server tick numbers.');
}
process.exit(0);
