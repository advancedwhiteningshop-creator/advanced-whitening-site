// Cloudflare Pages advanced-mode worker: handles POST /api/checkout, serves static files otherwise.
// POST /api/checkout  —  creates a Stripe Checkout Session and returns its URL.
// Prices are defined here (in pence) so the browser cannot change what is charged.
// Requires the STRIPE_SECRET_KEY environment variable in Cloudflare Pages settings.
const PACKS = {
  p5:  {pouches: 5,  pence: 3100, name: "10 strips"},
  p7:  {pouches: 7,  pence: 3795, name: "14 strips"},
  p10: {pouches: 10, pence: 4495, name: "20 strips"},
  p14: {pouches: 14, pence: 5495, name: "28 strips"},
  p16: {pouches: 16, pence: 5995, name: "32 strips"},
  p20: {pouches: 20, pence: 6995, name: "Full box, 40 strips"},
};
const DISCOUNT = 0.30;   // most expensive pack full price; every additional pack 30% off
const MAX_QTY = 10;
const PRODUCT = "Crest 3D White Whitestrips LUXE";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json"}});

async function checkout(request, env) {
  if (!env.STRIPE_SECRET_KEY) return json({error: "Checkout is not connected yet."}, 503);

  let items;
  try { ({items} = await request.json()); } catch { return json({error: "Invalid request."}, 400); }
  if (!Array.isArray(items) || !items.length || items.length > Object.keys(PACKS).length)
    return json({error: "Your basket is empty."}, 400);

  const merged = {};
  for (const it of items) {
    const qty = Number(it && it.qty);
    if (!PACKS[it && it.id] || !Number.isInteger(qty) || qty < 1) return json({error: "Invalid basket item."}, 400);
    merged[it.id] = Math.min(MAX_QTY, (merged[it.id] || 0) + qty);
  }
  const ids = Object.keys(merged);
  const fullId = ids.reduce((m, id) => (m === null || PACKS[id].pence > PACKS[m].pence ? id : m), null);
  const discounted = ids.reduce((a, id) => a + merged[id], 0) >= 2;
  const lines = [];   // [id, qty, unitPence, discounted?]
  for (const id of ids) {
    const p = PACKS[id];
    let q = merged[id];
    if (id === fullId) { lines.push([id, 1, p.pence, false]); q -= 1; }
    if (q > 0) lines.push([id, q, Math.round(p.pence * (1 - DISCOUNT)), true]);
  }

  const origin = new URL(request.url).origin;
  const f = new URLSearchParams();
  f.append("mode", "payment");
  f.append("success_url", `${origin}/thank-you/?session_id={CHECKOUT_SESSION_ID}`);
  f.append("cancel_url", `${origin}/#shop`);
  f.append("shipping_address_collection[allowed_countries][0]", "GB");
  f.append("phone_number_collection[enabled]", "true");
  f.append("metadata[packs]", Object.entries(merged).map(([id, q]) => `${id}x${q}`).join(","));
  f.append("metadata[discount]", discounted ? "extra_packs_30pct" : "none");

  lines.forEach(([id, qty, unit, isDisc], i) => {
    const p = PACKS[id];
    f.append(`line_items[${i}][quantity]`, String(qty));
    f.append(`line_items[${i}][price_data][currency]`, "gbp");
    f.append(`line_items[${i}][price_data][unit_amount]`, String(unit));
    f.append(`line_items[${i}][price_data][product_data][name]`, `${PRODUCT} · ${p.pouches} pouches`);
    f.append(`line_items[${i}][price_data][product_data][description]`, p.name + (isDisc ? " · 30% off 2nd pack" : ""));
    f.append(`line_items[${i}][price_data][product_data][metadata][pack]`, id);
  });

  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: f,
  });
  const d = await r.json();
  if (!r.ok || !d.url) {
    console.log("stripe error", r.status, d && d.error && d.error.message);
    return json({error: "Checkout is unavailable right now. Please try again shortly."}, 502);
  }
  return json({url: d.url});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/checkout") {
      if (request.method !== "POST") return json({error: "Method not allowed."}, 405);
      return checkout(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
