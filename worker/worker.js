// Cloudflare Worker for how_big_is_it.
//
// Scores
//   GET  /top                    -> { date, best }          best is null if nobody has played today
//   POST /score {score}          -> { date, best }          records the score if it beats today's best
//
// Community objects (photo cut-outs)
//   POST /submit  {name, height_m, fact, image}   image = data:image/png;base64,...  (<= 5 MB)
//                                -> { id, status: "pending" }
//   GET  /objects                -> [{ id, name, height_m, fact, image: "/img/<id>" }]   approved only
//   GET  /img/<id>               -> PNG
//   GET  /pending                -> [{...}]                 admin
//   POST /approve {id} | /reject {id}                        admin
//
// Admin routes need header  Authorization: Bearer <ADMIN_KEY>  (a Worker secret).
// Needs a KV namespace bound as SCORES.

const ALLOWED_ORIGINS = [
  'https://traceysun.github.io',
  'http://localhost:8765',
];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const path = url.pathname;
    const date = new Date().toISOString().slice(0, 10);
    const scoreKey = `best-${date}`;

    try {
      // ---- scores ----
      if (request.method === 'GET' && path === '/top') {
        const best = await env.SCORES.get(scoreKey);
        return json({ date, best: best === null ? null : Number(best) }, cors);
      }
      if (request.method === 'POST' && path === '/score') {
        let score;
        try { score = Number((await request.json()).score); } catch { score = NaN; }
        if (!Number.isInteger(score) || score < 0 || score > 100) {
          return json({ error: 'score must be an integer 0-100' }, cors, 400);
        }
        const prev = Number((await env.SCORES.get(scoreKey)) ?? -1);
        const best = Math.max(prev, score);
        if (best > prev) await env.SCORES.put(scoreKey, String(best), { expirationTtl: 3 * 24 * 3600 });
        return json({ date, best }, cors);
      }

      // ---- community objects ----
      if (request.method === 'POST' && path === '/submit') {
        const body = await request.json();
        const name = String(body.name || '').trim().slice(0, 60);
        const height_m = Number(body.height_m);
        const fact = String(body.fact || '').trim().slice(0, 200);
        const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image || ''));
        if (!name) return json({ error: 'name required' }, cors, 400);
        if (!(height_m > 0 && height_m < 1000)) return json({ error: 'height must be between 0 and 1000 m' }, cors, 400);
        if (!m) return json({ error: 'image must be a PNG data URL' }, cors, 400);
        const bytes = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
        if (bytes.length > MAX_IMAGE_BYTES) return json({ error: 'image too large' }, cors, 413);

        const id = crypto.randomUUID().slice(0, 8);
        const meta = { id, name, height_m, fact, status: 'pending', created: new Date().toISOString() };
        await env.SCORES.put(`img:${id}`, bytes);
        await env.SCORES.put(`obj:${id}`, JSON.stringify(meta));
        await pushList(env, 'list:pending', id);
        return json({ id, status: 'pending' }, cors);
      }
      if (request.method === 'GET' && path === '/objects') {
        return json(await readObjects(env, 'list:approved'), cors);
      }
      if (request.method === 'GET' && path.startsWith('/img/')) {
        const id = path.slice(5).replace(/[^a-z0-9]/g, '');
        const bytes = await env.SCORES.get(`img:${id}`, 'arrayBuffer');
        if (!bytes) return json({ error: 'not found' }, cors, 404);
        return new Response(bytes, {
          headers: { ...cors, 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
        });
      }

      // ---- admin ----
      const isAdmin = env.ADMIN_KEY && request.headers.get('Authorization') === `Bearer ${env.ADMIN_KEY}`;
      if (path === '/pending' || path === '/approve' || path === '/reject') {
        if (!isAdmin) return json({ error: 'unauthorised' }, cors, 401);
        if (request.method === 'GET' && path === '/pending') {
          return json(await readObjects(env, 'list:pending'), cors);
        }
        if (request.method === 'POST') {
          const { id } = await request.json();
          const raw = await env.SCORES.get(`obj:${id}`);
          if (!raw) return json({ error: 'not found' }, cors, 404);
          const meta = JSON.parse(raw);
          await removeFromList(env, 'list:pending', id);
          await removeFromList(env, 'list:approved', id);
          if (path === '/approve') {
            meta.status = 'approved';
            await env.SCORES.put(`obj:${id}`, JSON.stringify(meta));
            await pushList(env, 'list:approved', id);
          } else {
            await env.SCORES.delete(`obj:${id}`);
            await env.SCORES.delete(`img:${id}`);
          }
          return json({ ok: true }, cors);
        }
      }

      return json({ error: 'not found' }, cors, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, cors, 500);
    }
  },
};

async function readObjects(env, listKey) {
  const ids = JSON.parse((await env.SCORES.get(listKey)) || '[]');
  const out = [];
  for (const id of ids) {
    const raw = await env.SCORES.get(`obj:${id}`);
    if (!raw) continue;
    const { name, height_m, fact, created } = JSON.parse(raw);
    out.push({ id, name, height_m, fact, created, image: `/img/${id}` });
  }
  return out;
}
async function pushList(env, key, id) {
  const ids = JSON.parse((await env.SCORES.get(key)) || '[]');
  if (!ids.includes(id)) ids.push(id);
  await env.SCORES.put(key, JSON.stringify(ids));
}
async function removeFromList(env, key, id) {
  const ids = JSON.parse((await env.SCORES.get(key)) || '[]');
  await env.SCORES.put(key, JSON.stringify(ids.filter((x) => x !== id)));
}
function json(body, headers, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
