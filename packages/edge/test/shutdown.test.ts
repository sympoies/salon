import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { get } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

async function start(db: string, upstreamPort?: number) {
  const script = `import { startEdge } from './packages/edge/src/start.ts';
import { SessionStore } from './packages/edge/src/auth.ts';
const server = startEdge({ AGENT_CONSOLE_TOKEN: 'fixture', AGENT_CONSOLE_STATE_DB: process.argv[1], AGENT_CONSOLE_BOARD_DB: process.argv[1] + '.board', AGENT_CONSOLE_EDGE_PORT: '0', AGENT_CONSOLE_MACHINES: process.argv[2] ? JSON.stringify([{name:'fixture', url:'http://127.0.0.1:' + process.argv[2], token:'upstream'}]) : '[]' });
const store = new SessionStore(process.argv[1]); store.create('fixture', 'fixture'); store.close();
server.once('listening', () => console.log('READY ' + server.address().port));`;
  const child = spawn(process.execPath, ['--conditions=source', '--input-type=module', '-e', script, db, ...(upstreamPort ? [String(upstreamPort)] : [])], { cwd: join(import.meta.dirname, '../../..'), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout.on('data', chunk => { output += chunk; const match = /READY (\d+)/.exec(output); if (match) resolve(Number(match[1])); });
    child.once('exit', () => reject(new Error('edge exited before readiness')));
  });
  return { child, port };
}

test('SIGTERM checkpoints edge state and exits successfully', { timeout: 12_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edge-shutdown-')); const db = join(dir, 'state.sqlite');
  const { child } = await start(db);
  try {
    const exited = once(child, 'exit'); const started = Date.now(); child.kill('SIGTERM');
    const [code, signal] = await exited;
    assert.ok(Date.now() - started < 10_000);
    assert.equal(signal, null); assert.equal(code, 0);
    assert.equal(existsSync(db + '-wal'), false);
    assert.equal(existsSync(db + '.board-wal'), false);
    const board = new DatabaseSync(db + '.board', { readOnly: true });
    try { assert.ok(board.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().length > 0); } finally { board.close(); }
    const read = new DatabaseSync(db, { readOnly: true });
    try { assert.equal((read.prepare('SELECT count(*) AS n FROM auth_sessions').get() as { n: number }).n, 1); } finally { read.close(); }
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

test('SIGTERM sends a going-away close frame to an attached WebSocket', { timeout: 12_000 }, async () => {
  const upstream = createServer(socket => {
    socket.once('data', () => socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const dir = mkdtempSync(join(tmpdir(), 'edge-shutdown-'));
  const { child, port } = await start(join(dir, 'state.sqlite'), (upstream.address() as { port: number }).port);
  const socket = connect(port, '127.0.0.1'); socket.on('error', () => {}); await once(socket, 'connect');
  try {
    socket.write('GET /api/sessions/fixture/session/attach HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer fixture\r\n\r\n');
    const [handshake] = await once(socket, 'data'); assert.match(handshake.toString(), /^HTTP\/1\.1 101/);
    const frame = once(socket, 'data'); const exited = once(child, 'exit'); child.kill('SIGTERM');
    const [data] = await frame; assert.deepEqual(data, Buffer.from([0x88, 0x02, 0x03, 0xe9]));
    assert.equal((await exited)[0], 0);
  } finally { socket.destroy(); child.kill('SIGKILL'); upstream.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a second signal interrupts a slow shutdown', { timeout: 12_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edge-shutdown-')); const { child, port } = await start(join(dir, 'state.sqlite'));
  const socket = connect(port, '127.0.0.1'); await once(socket, 'connect');
  socket.on('error', () => {});
  socket.write('POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nx');
  try {
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
    const started = Date.now(); child.kill('SIGTERM'); await exited;
    assert.ok(Date.now() - started < 2000);
  } finally { socket.destroy(); child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

for (const path of ['/api/resources/events?resources=sessions', '/api/activity/events']) {
  test(`SIGTERM ends ${path} and exits successfully`, { timeout: 12_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'edge-shutdown-'));
    const { child, port } = await start(join(dir, 'state.sqlite'));
    const request = get({ host: '127.0.0.1', port, path, headers: { authorization: 'Bearer fixture' } });
    try {
      const [response] = await once(request, 'response');
      assert.equal(response.statusCode, 200);
      await once(response, 'data');
      const ended = once(response, 'end'); const exited = once(child, 'exit');
      const started = Date.now(); child.kill('SIGTERM');
      await ended;
      const [code, signal] = await exited;
      assert.equal(signal, null); assert.equal(code, 0); assert.ok(Date.now() - started < 10_000);
    } finally { request.destroy(); child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
  });
}
