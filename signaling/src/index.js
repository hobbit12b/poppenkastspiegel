import { DurableObject } from 'cloudflare:workers';

const ALLOWED_ORIGIN = 'https://hobbit12b.github.io';
const FIVE_MIN = 5 * 60 * 1000;
const THIRTY_MIN = 30 * 60 * 1000;

function jsonError(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
    if (!url.pathname.startsWith('/ws/')) return jsonError('Not found', 404);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return jsonError('WebSocket required', 426);
    if (request.headers.get('Origin') !== ALLOWED_ORIGIN) return jsonError('Origin not allowed', 403);

    const session = decodeURIComponent(url.pathname.slice(4));
    if (!/^[A-Za-z0-9_-]{10,40}$/.test(session)) return jsonError('Invalid session');
    const role = url.searchParams.get('role');
    if (role !== 'camera' && role !== 'viewer') return jsonError('Invalid role');

    const id = env.SESSIONS.idFromName(session);
    return env.SESSIONS.get(id).fetch(request);
  }
};

export class SessionRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.peers = { camera: null, viewer: null };
    this.authenticated = new WeakSet();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    if (role !== 'camera' && role !== 'viewer') return jsonError('Invalid role');
    if (this.peers[role]) return jsonError(role === 'viewer' ? 'Deze sessie heeft al een kijker.' : 'Camera is al verbonden.', 409);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.peers[role] = server;

    server.addEventListener('message', event => this.onMessage(server, role, event));
    server.addEventListener('close', () => this.onClose(server, role));
    server.addEventListener('error', () => this.onClose(server, role));

    return new Response(null, { status: 101, webSocket: client });
  }

  async onMessage(socket, role, event) {
    if (typeof event.data !== 'string' || event.data.length > 100000) {
      socket.close(1009, 'Message too large');
      return;
    }

    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (!this.authenticated.has(socket)) {
      if (msg.type !== 'hello' || typeof msg.key !== 'string' || msg.key.length < 24 || msg.key.length > 100) {
        socket.close(1008, 'Authentication required');
        return;
      }

      const presented = await sha256(msg.key);
      let expected = await this.ctx.storage.get('secretHash');

      if (role === 'camera') {
        if (!expected) {
          await this.ctx.storage.put('secretHash', presented);
          expected = presented;
        }
        if (presented !== expected) {
          socket.close(1008, 'Wrong session key');
          return;
        }
        this.authenticated.add(socket);
        await this.ctx.storage.setAlarm(Date.now() + FIVE_MIN);
        return;
      }

      if (!expected || presented !== expected || !this.peers.camera || !this.authenticated.has(this.peers.camera)) {
        socket.close(1008, 'Session not available');
        return;
      }

      this.authenticated.add(socket);
      await this.ctx.storage.setAlarm(Date.now() + THIRTY_MIN);
      this.safeSend(this.peers.camera, { type: 'viewer-ready' });
      return;
    }

    if (msg.type === 'bye') {
      socket.close(1000, 'Ended');
      return;
    }

    const allowed = new Set(['offer', 'answer', 'ice']);
    if (!allowed.has(msg.type)) return;
    const other = role === 'camera' ? this.peers.viewer : this.peers.camera;
    if (!other || !this.authenticated.has(other)) return;

    if (msg.type === 'offer' && role !== 'camera') return;
    if (msg.type === 'answer' && role !== 'viewer') return;
    this.safeSend(other, msg);
  }

  safeSend(socket, data) {
    try { if (socket && socket.readyState === 1) socket.send(JSON.stringify(data)); } catch {}
  }

  onClose(socket, role) {
    if (this.peers[role] === socket) this.peers[role] = null;
    const otherRole = role === 'camera' ? 'viewer' : 'camera';
    const other = this.peers[otherRole];
    if (other) {
      try { other.close(1000, 'Other device disconnected'); } catch {}
      this.peers[otherRole] = null;
    }
  }

  async alarm() {
    for (const role of ['camera', 'viewer']) {
      try { this.peers[role]?.close(1000, 'Session expired'); } catch {}
      this.peers[role] = null;
    }
    await this.ctx.storage.deleteAll();
  }
}
