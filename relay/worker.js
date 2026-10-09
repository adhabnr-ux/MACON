// Cloudflare Worker entry. One Durable Object holds all relay state, which gives strongly consistent
// reads/writes (KV is eventually consistent and would drop wake requests).
import { DurableObject } from 'cloudflare:workers';
import { createRelay, SECURITY_HEADERS } from './core.js';

export class MaconState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.relay = createRelay(env, { get: (k) => ctx.storage.get(k), put: (k, v) => ctx.storage.put(k, v) });
  }
  fetch(request) {
    return this.relay.handle(request);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      // Overwrite any client-supplied value; CF-Connecting-IP is set by Cloudflare's edge.
      const headers = new Headers(request.headers);
      headers.set('x-client-ip', request.headers.get('cf-connecting-ip') || 'unknown');
      return env.STATE.get(env.STATE.idFromName('main')).fetch(new Request(request, { headers }));
    }
    if (url.pathname === '/healthz') return Response.json({ ok: true });
    const res = await env.ASSETS.fetch(request);
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
    if (url.pathname === '/sw.js' || url.pathname === '/') h.set('Cache-Control', 'no-cache');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  },
};
