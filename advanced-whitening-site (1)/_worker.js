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

// DSers/AliExpress expect "UK" (not "GB") and a UK nation as the province.
const SCOT = ["AB","DD","DG","EH","FK","G","HS","IV","KA","KW","KY","ML","PA","PH","TD","ZE"];
const WALES = ["CF","LD","LL","NP","SA"];
function ukNation(postcode) {
  const area = (String(postcode || "").toUpperCase().match(/^[A-Z]+/) || [""])[0];
  if (area === "BT") return "Northern Ireland";
  if (SCOT.includes(area)) return "Scotland";
  if (WALES.includes(area)) return "Wales";
  return "England";
}

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
        const isUK = !a.country || a.country === "GB";
        rows.push([orderNo, date, isUK ? "UK" : a.country, DSERS_PRODUCT_ID, DSERS_SKU[id], qty || "1", "",
          ship.name || cust.name || "", cust.phone || "", cust.email || "",
          a.line1 || "", a.line2 || "", isUK ? ukNation(a.postal_code) : (a.state || a.city || ""), a.city || "", a.postal_code || ""]);
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

// ---------------------------------------------------------------------------
// POST /api/stripe-webhook  —  Stripe "checkout.session.completed" -> order confirmation email
// Secrets: STRIPE_WEBHOOK_SECRET (whsec_...), ZEPTOMAIL_TOKEN (Send Mail token),
//          ZEPTOMAIL_URL optional (defaults to the AU endpoint https://cpaas.zoho.com.au/v1.1/email)
const SHOP_FROM = {address: "hello@advancedteethwhitening.co.uk", name: "Advanced Whitening"};
const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const gbpFmt = pence => "£" + (pence / 100).toFixed(2);

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function verifyStripe(body, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map(p => p.split("=")).filter(p => p.length === 2 && p[0] === "t").map(p => [p[0], p[1]]));
  const sigs = header.split(",").filter(p => p.startsWith("v1=")).map(p => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = await hmacHex(secret, `${t}.${body}`);
  return sigs.some(s => s.length === expected.length && s === expected);
}

function confirmationEmail(s) {
  const orderNo = "AW-" + s.id.slice(-10).toUpperCase();
  const ship = (s.collected_information && s.collected_information.shipping_details) || s.shipping_details || {};
  const cust = s.customer_details || {};
  const a = ship.address || cust.address || {};
  const name = ship.name || cust.name || "";
  const first = name.split(" ")[0] || "there";
  // line prices, worked out exactly as the checkout charges them
  const parsed = (s.metadata.packs || "").split(",").map(part => { const [id, q] = part.split("x"); return [id, Number(q) || 1]; }).filter(([id]) => PACKS[id]);
  const fullId = parsed.reduce((m, [id]) => (m === null || PACKS[id].pence > PACKS[m].pence ? id : m), null);
  const multi = parsed.reduce((a, [, q]) => a + q, 0) >= 2;
  const lines = parsed.map(([id, qty]) => {
    const p = PACKS[id];
    const disc = Math.round(p.pence * (1 - DISCOUNT));
    const fullUnits = id === fullId ? 1 : 0;
    const linePence = multi ? fullUnits * p.pence + (qty - fullUnits) * disc : p.pence * qty;
    const td = 'style="padding:8px 0;border-bottom:1px solid #e3e7f0';
    return `<tr><td ${td}">Crest 3D White Whitestrips LUXE · ${p.pouches} pouches (${esc(p.name)})<br><span style="color:#59617f;font-size:13px">${gbpFmt(p.pence)} each</span></td><td ${td};text-align:center">${qty}</td><td ${td};text-align:right">${gbpFmt(linePence)}</td></tr>`;
  }).join("");
  const addr = [name, a.line1, a.line2, a.city, a.state, a.postal_code, a.country === "GB" ? "United Kingdom" : a.country].filter(Boolean).map(esc).join("<br>");
  const html = `<!doctype html><html><body style="margin:0;background:#f4f6fb;font-family:Arial,Helvetica,sans-serif;color:#131838">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden">
<tr><td style="background:#4c2fd0;color:#ffffff;padding:22px 28px;font-size:20px;font-weight:bold">Advanced Whitening</td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 8px;font-size:24px">Thanks for your order, ${esc(first)}!</h1>
<p style="margin:0 0 20px;color:#59617f">Order <b>${orderNo}</b> is confirmed and your payment has been received.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px">
<tr><th align="left" style="padding-bottom:6px">Item</th><th style="padding-bottom:6px">Qty</th><th align="right" style="padding-bottom:6px">Price</th></tr>${lines}
<tr><td style="padding:8px 0;color:#59617f">Delivery (tracked)</td><td></td><td style="padding:8px 0;text-align:right;color:#59617f">Free</td></tr>
<tr><td style="padding:12px 0;font-weight:bold">Total paid</td><td></td><td style="padding:12px 0;text-align:right;font-weight:bold">${gbpFmt(s.amount_total || 0)}</td></tr></table>
<h2 style="font-size:17px;margin:24px 0 8px">Delivering to</h2><p style="margin:0;line-height:1.5">${addr}</p>
<h2 style="font-size:17px;margin:24px 0 8px">What happens next</h2>
<ol style="margin:0;padding-left:20px;line-height:1.6"><li>We prepare your order. It ships within 3 working days.</li><li>We email you a tracking number as soon as it's on its way.</li><li>Delivery usually takes 5–10 working days.</li></ol>
<h2 style="font-size:17px;margin:24px 0 8px">Getting the best results</h2>
<ul style="margin:0;padding-left:20px;line-height:1.6"><li>Use one pouch (upper and lower strip) once a day for 30 minutes.</li><li>Don't brush immediately before applying; wait about 30 minutes.</li><li>Avoid coffee, tea, red wine and other staining food and drink for 1–2 hours after.</li></ul>
<p style="margin:24px 0 0;line-height:1.6">Questions, or need to change your address? Reply to this email or contact <a href="mailto:hello@advancedteethwhitening.co.uk" style="color:#4c2fd0">hello@advancedteethwhitening.co.uk</a>. Our <a href="https://advancedteethwhitening.co.uk/returns/" style="color:#4c2fd0">returns policy</a> is on our website.</p>
</td></tr>
<tr><td style="padding:18px 28px;background:#f4f6fb;color:#59617f;font-size:12px">Advanced Whitening · advancedteethwhitening.co.uk</td></tr>
</table></td></tr></table></body></html>`;
  return {orderNo, to: cust.email, toName: name, subject: `Order confirmed – ${orderNo}`, html};
}

async function sendMail(env, mail) {
  const auth = env.ZEPTOMAIL_TOKEN.startsWith("Zoho-enczapikey") ? env.ZEPTOMAIL_TOKEN : `Zoho-enczapikey ${env.ZEPTOMAIL_TOKEN}`;
  const r = await fetch(env.ZEPTOMAIL_URL || "https://cpaas.zoho.com.au/v1.1/email", {
    method: "POST",
    headers: {"Content-Type": "application/json", "Accept": "application/json", "Authorization": auth},
    body: JSON.stringify({
      from: SHOP_FROM,
      to: [{email_address: {address: mail.to, name: mail.toName || mail.to}}],
      subject: mail.subject,
      htmlbody: mail.html,
    }),
  });
  const text = await r.text();
  if (!r.ok) console.log("zeptomail error", r.status, text.slice(0, 300));
  return {ok: r.ok, status: r.status, text: text.slice(0, 300)};
}

// GET /admin/test-email?token=...  -> sends a sample confirmation to hello@ only
async function testEmail(url, env) {
  if (!env.ADMIN_TOKEN || url.searchParams.get("token") !== env.ADMIN_TOKEN) return new Response("Not found", {status: 404});
  if (!env.ZEPTOMAIL_TOKEN) return new Response("ZEPTOMAIL_TOKEN missing", {status: 500});
  const sample = {id: "cs_test_SAMPLE00000", payment_status: "paid", amount_total: 11490, metadata: {packs: "p10x1,p20x1"},
    customer_details: {email: SHOP_FROM.address, name: "Sample Customer"},
    collected_information: {shipping_details: {name: "Sample Customer", address: {line1: "1 Sample Street", city: "Bath", postal_code: "BA1 1AA", country: "GB"}}}};
  const mail = confirmationEmail(sample);
  mail.subject = "[TEST] " + mail.subject;
  const res = await sendMail(env, mail);
  return new Response(JSON.stringify(res), {status: res.ok ? 200 : 502, headers: {"Content-Type": "application/json"}});
}

async function stripeWebhook(request, env) {
  const body = await request.text();
  if (!(await verifyStripe(body, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET)))
    return new Response("Invalid signature", {status: 400});
  let event; try { event = JSON.parse(body); } catch { return new Response("Bad JSON", {status: 400}); }
  if (event.type !== "checkout.session.completed") return new Response("Ignored", {status: 200});
  const s = event.data && event.data.object;
  if (!s || s.payment_status !== "paid" || !s.metadata || !s.metadata.packs) return new Response("Not a paid shop order", {status: 200});
  const mail = confirmationEmail(s);
  if (!mail.to) return new Response("No customer email", {status: 200});
  if (!env.ZEPTOMAIL_TOKEN) return new Response("Email not configured", {status: 500});
  const res = await sendMail(env, mail);
  if (!res.ok) return new Response("Email send failed", {status: 502});   // Stripe will retry
  return new Response("Sent " + mail.orderNo, {status: 200});
}

// ---------------------------------------------------------------------------
// POST /admin/tracking?token=...   body: {"orders":[{"order":"AW-XXXXXXXXXX","tracking":"LP0000..."}]}
// Emails each customer their tracking number once. "Sent" is recorded on the Stripe
// PaymentIntent metadata (tracking_number, tracking_emailed) so repeat calls never re-send.
// Add &dry=1 to see what would happen without sending. GET /admin/tracking?token=...&test=1 sends a sample to hello@.
// Royal Mail tracking page; AliExpress/Cainiao-only numbers (LP..., ...CN) fall back to 17TRACK.
const trackUrl = n => /^LP|CN$/i.test(n)
  ? "https://t.17track.net/en#nums=" + encodeURIComponent(n)
  : "https://www.royalmail.com/track-your-item#/tracking-results/" + encodeURIComponent(n);

function trackingEmail(s, tracking) {
  const orderNo = "AW-" + s.id.slice(-10).toUpperCase();
  const ship = (s.collected_information && s.collected_information.shipping_details) || s.shipping_details || {};
  const cust = s.customer_details || {};
  const name = ship.name || cust.name || "";
  const first = name.split(" ")[0] || "there";
  const html = `<!doctype html><html><body style="margin:0;background:#f4f6fb;font-family:Arial,Helvetica,sans-serif;color:#131838">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden">
<tr><td style="background:#4c2fd0;color:#ffffff;padding:22px 28px;font-size:20px;font-weight:bold">Advanced Whitening</td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 8px;font-size:24px">Your order is on its way, ${esc(first)}!</h1>
<p style="margin:0 0 20px;color:#59617f">Order <b>${orderNo}</b> has been dispatched.</p>
<p style="margin:0 0 6px">Tracking number:</p>
<p style="margin:0 0 20px;font-size:18px;font-weight:bold;letter-spacing:.5px">${esc(tracking)}</p>
<p style="margin:0 0 24px"><a href="${trackUrl(tracking)}" style="display:inline-block;background:#4c2fd0;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:bold">Track your parcel</a></p>
<p style="margin:0;line-height:1.6;color:#59617f">Tracking can take 1–2 working days to show the first update. Delivery usually takes 5–10 working days from dispatch.</p>
<p style="margin:24px 0 0;line-height:1.6">Questions? Reply to this email or contact <a href="mailto:hello@advancedteethwhitening.co.uk" style="color:#4c2fd0">hello@advancedteethwhitening.co.uk</a>.</p>
</td></tr>
<tr><td style="padding:18px 28px;background:#f4f6fb;color:#59617f;font-size:12px">Advanced Whitening · advancedteethwhitening.co.uk</td></tr>
</table></td></tr></table></body></html>`;
  return {orderNo, to: cust.email, toName: name, subject: `Your order ${orderNo} has shipped`, html};
}

async function stripeApi(env, path, form) {
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    method: form ? "POST" : "GET",
    headers: {"Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`, ...(form ? {"Content-Type": "application/x-www-form-urlencoded"} : {})},
    body: form ? new URLSearchParams(form) : undefined,
  });
  const d = await r.json();
  if (!r.ok) throw new Error("Stripe: " + (d.error && d.error.message));
  return d;
}

async function trackingUpdate(request, url, env) {
  const jsonRes = (b, st = 200) => new Response(JSON.stringify(b), {status: st, headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}});
  if (!env.ADMIN_TOKEN || url.searchParams.get("token") !== env.ADMIN_TOKEN) return new Response("Not found", {status: 404});
  if (!env.STRIPE_SECRET_KEY || !env.ZEPTOMAIL_TOKEN) return jsonRes({error: "Stripe or email not configured"}, 503);
  if (request.method === "GET" && url.searchParams.get("test") === "1") {
    const sample = {id: "cs_test_SAMPLE00000", customer_details: {email: SHOP_FROM.address, name: "Sample Customer"}};
    const mail = trackingEmail(sample, "LP00123456789012");
    mail.subject = "[TEST] " + mail.subject;
    return jsonRes(await sendMail(env, mail));
  }
  if (request.method !== "POST") return new Response("Method not allowed", {status: 405});
  let body; try { body = await request.json(); } catch { return jsonRes({error: "Bad JSON"}, 400); }
  const wanted = new Map();
  for (const o of (body.orders || [])) {
    const order = String(o.order || "").trim().toUpperCase(), tracking = String(o.tracking || "").trim();
    if (/^AW-[A-Z0-9]{10}$/.test(order) && /^[A-Za-z0-9-]{6,40}$/.test(tracking)) wanted.set(order, tracking);
  }
  if (!wanted.size) return jsonRes({results: []});
  const dry = url.searchParams.get("dry") === "1";
  const results = [];
  try {
    // find the Checkout Sessions for these order numbers (last 90 days)
    const since = Math.floor(Date.now() / 1000) - 90 * 86400;
    const found = new Map();
    let after = null;
    for (let page = 0; page < 20 && found.size < wanted.size; page++) {
      const q = new URLSearchParams({limit: "100", "created[gte]": String(since)});
      if (after) q.set("starting_after", after);
      const d = await stripeApi(env, "checkout/sessions?" + q);
      for (const s of d.data) {
        const no = "AW-" + s.id.slice(-10).toUpperCase();
        if (wanted.has(no) && s.payment_status === "paid") found.set(no, s);
      }
      if (!d.has_more || !d.data.length) break;
      after = d.data[d.data.length - 1].id;
    }
    for (const [order, tracking] of wanted) {
      const s = found.get(order);
      if (!s) { results.push({order, result: "order not found"}); continue; }
      if (!s.payment_intent) { results.push({order, result: "no payment record"}); continue; }
      const pi = await stripeApi(env, "payment_intents/" + s.payment_intent);
      const md = pi.metadata || {};
      if (md.tracking_emailed && md.tracking_number === tracking) { results.push({order, result: "already emailed"}); continue; }
      const mail = trackingEmail(s, tracking);
      if (!mail.to) { results.push({order, result: "no customer email"}); continue; }
      if (dry) { results.push({order, result: md.tracking_emailed ? "would email (new tracking number)" : "would email"}); continue; }
      const res = await sendMail(env, mail);
      if (!res.ok) { results.push({order, result: "email failed " + res.status}); continue; }
      await stripeApi(env, "payment_intents/" + s.payment_intent, {"metadata[tracking_number]": tracking, "metadata[tracking_emailed]": new Date().toISOString()});
      results.push({order, result: "emailed"});
    }
  } catch (e) {
    return jsonRes({error: String(e.message || e), results}, 502);
  }
  return jsonRes({results});
}

// GET /api/order?session_id=cs_...  -> {paid, order, value, currency}; used by the thank-you page for Google Ads conversion value
async function orderSummary(url, env) {
  const id = url.searchParams.get("session_id") || "";
  const h = {"Content-Type": "application/json", "Cache-Control": "no-store"};
  if (!/^cs_(live|test)_[A-Za-z0-9]{10,}$/.test(id) || !env.STRIPE_SECRET_KEY) return new Response('{"paid":false}', {status: 400, headers: h});
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions/" + id, {headers: {"Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`}});
  if (!r.ok) return new Response('{"paid":false}', {status: 404, headers: h});
  const s = await r.json();
  return new Response(JSON.stringify({paid: s.payment_status === "paid", order: "AW-" + s.id.slice(-10).toUpperCase(),
    value: (s.amount_total || 0) / 100, currency: String(s.currency || "gbp").toUpperCase()}), {headers: h});
}

// Google Ads tag, injected into every HTML page served (so page files don't need re-uploading).
const GADS_ID = "AW-18549328237";
const GADS_PURCHASE = "AW-18549328237/Z5vYCOql768dEO2SgY1F";
const GTAG_HEAD = `<script async src="https://www.googletagmanager.com/gtag/js?id=${GADS_ID}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GADS_ID}');</script>
`;
const CONVERSION_JS = `<script>(function(){var id=new URLSearchParams(location.search).get("session_id");if(!id)return;var k="aw_conv_"+id;try{if(localStorage.getItem(k))return;}catch(e){}
fetch("/api/order?session_id="+encodeURIComponent(id)).then(function(r){return r.ok?r.json():null;}).then(function(d){if(!d||!d.paid)return;
gtag("event","conversion",{send_to:"${GADS_PURCHASE}",value:d.value,currency:d.currency,transaction_id:d.order});try{localStorage.setItem(k,"1");}catch(e){}}).catch(function(){});})();</script>
`;
async function withTags(res, url) {
  if (!(res.headers.get("content-type") || "").includes("text/html")) return res;
  let rw = new HTMLRewriter().on("head", {element(e) { e.append(GTAG_HEAD, {html: true}); }});
  if (url.pathname.startsWith("/thank-you")) rw = rw.on("body", {element(e) { e.append(CONVERSION_JS, {html: true}); }});
  return rw.transform(res);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/checkout") {
      if (request.method !== "POST") return json({error: "Method not allowed."}, 405);
      return checkout(request, env);
    }
    if (url.pathname === "/admin/dsers-orders.csv") return dsersExport(url, env);
    if (url.pathname === "/admin/test-email") return testEmail(url, env);
    if (url.pathname === "/api/order") return orderSummary(url, env);
    if (url.pathname === "/admin/tracking") return trackingUpdate(request, url, env);
    if (url.pathname === "/api/stripe-webhook") {
      if (request.method !== "POST") return new Response("Method not allowed", {status: 405});
      return stripeWebhook(request, env);
    }
    return withTags(await env.ASSETS.fetch(request), url);
  },
};
