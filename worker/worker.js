// Cloudflare Worker: holds the best how_big_is_it score of the day.
//
//   GET  /top            -> { "date": "2026-09-17", "best": 87 }   (best is null if nobody has played)
//   POST /score {score}  -> same shape, after recording the score if it beats today's best
//
// Needs a KV namespace bound as SCORES. Keys are one per UTC day and expire after 3 days.

const ALLOWED_ORIGINS = [
  'https://traceysun.github.io',
  'http://localhost:8765',
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const date = new Date().toISOString().slice(0, 10);
    const key = `best-${date}`;

    if (request.method === 'GET' && url.pathname === '/top') {
      const best = await env.SCORES.get(key);
      return json({ date, best: best === null ? null : Number(best) }, cors);
    }

    if (request.method === 'POST' && url.pathname === '/score') {
      let score;
      try { score = Number((await request.json()).score); } catch { score = NaN; }
      if (!Number.isInteger(score) || score < 0 || score > 100) {
        return json({ error: 'score must be an integer 0-100' }, cors, 400);
      }
      const prev = Number((await env.SCORES.get(key)) ?? -1);
      const best = Math.max(prev, score);
      if (best > prev) await env.SCORES.put(key, String(best), { expirationTtl: 3 * 24 * 3600 });
      return json({ date, best }, cors);
    }

    return json({ error: 'not found' }, cors, 404);
  },
};

function json(body, headers, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}
