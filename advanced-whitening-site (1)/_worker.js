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
const DISCOUNT = 0;   // multi-pack offer switched off for now; 0.30 = 30% off every additional pack
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
  f.append("metadata[discount]", discounted && DISCOUNT ? `extra_packs_${DISCOUNT*100}pct` : "none");

  lines.forEach(([id, qty, unit, isDisc], i) => {
    const p = PACKS[id];
    f.append(`line_items[${i}][quantity]`, String(qty));
    f.append(`line_items[${i}][price_data][currency]`, "gbp");
    f.append(`line_items[${i}][price_data][unit_amount]`, String(unit));
    f.append(`line_items[${i}][price_data][product_data][name]`, `${PRODUCT} · ${p.pouches} pouches`);
    f.append(`line_items[${i}][price_data][product_data][description]`, p.name + (isDisc && DISCOUNT ? ` · ${DISCOUNT*100}% off 2nd pack` : ""));
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

// ---------------------------------------------------------------------------
// GET /admin/dsers-orders.csv?token=...&since=YYYY-MM-DD   (or &hours=24 for the last 24 hours)
// Paid Stripe orders in DSers' order-import column layout. Protected by the
// ADMIN_TOKEN secret. "since" defaults to 3 days ago (UTC).
const DSERS_PRODUCT_ID = "LUXE";
const DSERS_SKU = {p5: "LUXE-05", p7: "LUXE-07", p10: "LUXE-10", p14: "LUXE-14", p16: "LUXE-16", p20: "LUXE-20"};
const DSERS_HEADERS = ["Order_number", "Date", "Country(Short Name of Country)", "Product_id", "Sku", "Product_count",
  "Order_memo", "Contact_person", "Mobile_no", "Email(Optional)", "Address", "Address2", "Province", "City", "ZIP",
  "RUT(Chile; Optional)", "Personal Clearance ID(Korea, Oman; Optional)",
  "Passport/Alien registration Card Number(Korea, Oman; Optional)", "CPF(Brazil; Optional)",
  "Turkish ID Number(Turkey; Optional)", "Passport Number(Turkey; Optional)", "RUC(Peru; Optional)",
  "RFC/CURP(Mexico; Optional)", "Birthday(Brazil; Optional)example:DDMMYYYY"];

const csvCell = v => {
  const t = v == null ? "" : String(v);
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

async function dsersExport(url, env) {
  if (!env.ADMIN_TOKEN || url.searchParams.get("token") !== env.ADMIN_TOKEN) return new Response("Not found", {status: 404});
  if (!env.STRIPE_SECRET_KEY) return new Response("Stripe not connected", {status: 503});
  const sinceParam = url.searchParams.get("since");
  const hoursParam = Number(url.searchParams.get("hours"));
  const since = sinceParam ? Date.parse(sinceParam + "T00:00:00Z")
    : hoursParam > 0 ? Date.now() - Math.min(hoursParam, 24 * 31) * 3600000
    : Date.now() - 3 * 86400000;
  if (isNaN(since)) return new Response("Bad 'since' date, use YYYY-MM-DD", {status: 400});

  const rows = [DSERS_HEADERS];
  let startingAfter = null;
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({limit: "100", "created[gte]": String(Math.floor(since / 1000))});
    if (startingAfter) q.set("starting_after", startingAfter);
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions?" + q, {
      headers: {"Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`},
    });
    const d = await r.json();
    if (!r.ok) return new Response("Stripe error: " + (d.error && d.error.message), {status: 502});
    for (const s of d.data) {
      if (s.payment_status !== "paid" || !s.metadata || !s.metadata.packs) continue;
      const ship = (s.collected_information && s.collected_information.shipping_details) || s.shipping_details || {};
      const cust = s.customer_details || {};
      const a = ship.address || cust.address || {};
      const orderNo = "AW-" + s.id.slice(-10).toUpperCase();
      const date = new Date(s.created * 1000).toISOString().slice(0, 10);
      for (const part of s.metadata.packs.split(",")) {
        const [id, qty] = part.split("x");
        if (!DSERS_SKU[id]) continue;
        rows.push([orderNo, date, a.country || "GB", DSERS_PRODUCT_ID, DSERS_SKU[id], qty || "1", "",
          ship.name || cust.name || "", cust.phone || "", cust.email || "",
          a.line1 || "", a.line2 || "", a.state || a.city || "", a.city || "", a.postal_code || ""]);
      }
    }
    if (!d.has_more || !d.data.length) break;
    startingAfter = d.data[d.data.length - 1].id;
  }
  const body = "﻿" + rows.map(r => {
    const full = r.concat(Array(DSERS_HEADERS.length - r.length).fill(""));
    return full.map(csvCell).join(",");
  }).join("\r\n") + "\r\n";
  return new Response(body, {headers: {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="dsers-orders-${new Date().toISOString().slice(0, 10)}.csv"`,
    "Cache-Control": "no-store",
  }});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/checkout") {
      if (request.method !== "POST") return json({error: "Method not allowed."}, 405);
      return checkout(request, env);
    }
    if (url.pathname === "/admin/dsers-orders.csv") return dsersExport(url, env);
    return env.ASSETS.fetch(request);
  },
};
