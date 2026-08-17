import { DurableObject } from 'cloudflare:workers';

const ALLOWED_ORIGIN = 'https://hobbit12b.github.io';
const FIVE_MIN = 5 * 60 * 1000;
const THIRTY_MIN = 30 * 60 * 1000;
const TURN_TTL_SECONDS = 60 * 60;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store'
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() }
  });
}
function jsonError(message, status = 400) { return json({ error: message }, status); }

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function validSession(session) { return /^[A-Za-z0-9_-]{10,40}$/.test(session || ''); }

async function generateTurnIceServers(env) {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) throw new Error('TURN is nog niet geconfigureerd');
  const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: TURN_TTL_SECONDS })
  });
  if (!response.ok) {
    const text = await response.text();
    console.error('TURN credential error', response.status, text.slice(0, 500));
    throw new Error('TURN-credentials konden niet worden gemaakt');
  }
  const data = await response.json();
  const iceServers = (data.iceServers || []).map(server => {
    const copy = { ...server };
    const urls = Array.isArray(copy.urls) ? copy.urls : [copy.urls];
    copy.urls = urls.filter(Boolean).filter(url => !String(url).includes(':53'));
    return copy;
  }).filter(server => server.urls?.length);
  if (!iceServers.length) throw new Error('Geen TURN-servers ontvangen');
  return iceServers;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    if (url.pathname === '/health') return new Response('ok', { headers: { 'Cache-Control': 'no-store' } });
    if (request.method === 'OPTIONS') {
      if (origin !== ALLOWED_ORIGIN) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (url.pathname === '/turn') {
      if (origin !== ALLOWED_ORIGIN) return jsonError('Origin not allowed', 403);
      if (request.method !== 'POST') return jsonError('Method not allowed', 405);
      let body;
      try { body = await request.json(); } catch { return jsonError('Ongeldige aanvraag'); }
      const { session, key } = body || {};
      if (!validSession(session) || typeof key !== 'string' || key.length < 24 || key.length > 100) return jsonError('Ongeldige sessie');
      const id = env.SESSIONS.idFromName(session);
      const auth = await env.SESSIONS.get(id).fetch('https://internal/turn-auth', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: key });
      if (!auth.ok) return jsonError('Sessie niet beschikbaar', 403);
      try { return json({ iceServers: await generateTurnIceServers(env) }); }
      catch (error) { console.error(error); return jsonError('TURN tijdelijk niet beschikbaar', 503); }
    }
    if (!url.pathname.startsWith('/ws/')) return jsonError('Not found', 404);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return jsonError('WebSocket required', 426);
    if (origin !== ALLOWED_ORIGIN) return jsonError('Origin not allowed', 403);
    const session = decodeURIComponent(url.pathname.slice(4));
    if (!validSession(session)) return jsonError('Invalid session');
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
    if (url.pathname === '/turn-auth') {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const key = await request.text();
      if (key.length < 24 || key.length > 100) return new Response(null, { status: 403 });
      const expected = await this.ctx.storage.get('secretHash');
      if (!expected) return new Response(null, { status: 403 });
      const presented = await sha256(key);
      return new Response(null, { status: presented === expected ? 204 : 403 });
    }
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
    if (typeof event.data !== 'string' || event.data.length > 100000) { socket.close(1009, 'Message too large'); return; }
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (!this.authenticated.has(socket)) {
      if (msg.type !== 'hello' || typeof msg.key !== 'string' || msg.key.length < 24 || msg.key.length > 100) { socket.close(1008, 'Authentication required'); return; }
      const presented = await sha256(msg.key);
      let expected = await this.ctx.storage.get('secretHash');
      if (role === 'camera') {
        if (!expected) { await this.ctx.storage.put('secretHash', presented); expected = presented; }
        if (presented !== expected) { socket.close(1008, 'Wrong session key'); return; }
        this.authenticated.add(socket);
        await this.ctx.storage.setAlarm(Date.now() + FIVE_MIN);
        this.safeSend(socket, { type: 'ready' });
        return;
      }
      if (!expected || presented !== expected || !this.peers.camera || !this.authenticated.has(this.peers.camera)) { socket.close(1008, 'Session not available'); return; }
      this.authenticated.add(socket);
      await this.ctx.storage.setAlarm(Date.now() + THIRTY_MIN);
      this.safeSend(socket, { type: 'ready' });
      this.safeSend(this.peers.camera, { type: 'viewer-ready' });
      return;
    }
    if (msg.type === 'bye') { socket.close(1000, 'Ended'); return; }
    const allowed = new Set(['offer', 'answer', 'ice']);
    if (!allowed.has(msg.type)) return;
    const other = role === 'camera' ? this.peers.viewer : this.peers.camera;
    if (!other || !this.authenticated.has(other)) return;
    if (msg.type === 'offer' && role !== 'camera') return;
    if (msg.type === 'answer' && role !== 'viewer') return;
    this.safeSend(other, msg);
  }

  safeSend(socket, data) { try { if (socket && socket.readyState === 1) socket.send(JSON.stringify(data)); } catch {} }
  onClose(socket, role) {
    if (this.peers[role] === socket) this.peers[role] = null;
    const otherRole = role === 'camera' ? 'viewer' : 'camera';
    const other = this.peers[otherRole];
    if (other) { try { other.close(1000, 'Other device disconnected'); } catch {} this.peers[otherRole] = null; }
  }
  async alarm() {
    for (const role of ['camera', 'viewer']) { try { this.peers[role]?.close(1000, 'Session expired'); } catch {} this.peers[role] = null; }
    await this.ctx.storage.deleteAll();
  }
}
