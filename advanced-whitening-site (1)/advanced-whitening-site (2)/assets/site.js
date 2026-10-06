// Advanced Whitening storefront script.
// Prices here are for display only; the checkout function (functions/api/checkout.js) holds the
// prices that are actually charged. Change both together.
const PACKS = [
  {id:"p5", label:"5", pouches:5, price:31.00, was:59.00, name:"10 strips"},
  {id:"p7", label:"7", pouches:7, price:37.95, was:71.95, name:"14 strips"},
  {id:"p10",label:"10",pouches:10,price:44.95, was:81.00, name:"20 strips", flag:"Most popular"},
  {id:"p14",label:"14",pouches:14,price:54.95, was:105.00,name:"28 strips"},
  {id:"p16",label:"16",pouches:16,price:59.95, was:116.00,name:"32 strips"},
  {id:"p20",label:"20",pouches:20,price:69.95, was:141.00,name:"Full box, 40 strips", flag:"Best value"}
];
// Offer (same as the old store): the most expensive pack in the basket is full price;
// every additional pack is 30% off. Rounded per pack, exactly as the checkout function does.
const DISCOUNT = 0.30;
const MAX_QTY = 10;
const $ = id => document.getElementById(id);
const gbp = n => "£" + n.toFixed(2);
const pennies = n => Math.round(n * 100);
const packById = id => PACKS.find(p => p.id === id);
const discPence = p => Math.round(pennies(p.price) * (1 - DISCOUNT));

// ---------- basket (stored in this browser) ----------
const KEY = "aw_basket_v1";
function load(){ try { return (JSON.parse(localStorage.getItem(KEY)) || []).filter(l => packById(l.id) && l.qty > 0); } catch(e){ return []; } }
let basket = load();
function save(){ try { localStorage.setItem(KEY, JSON.stringify(basket)); } catch(e){} renderBasket(); }
const count = () => basket.reduce((s, l) => s + l.qty, 0);
function add(id, qty){
  const l = basket.find(x => x.id === id);
  if (l) l.qty = Math.min(MAX_QTY, l.qty + qty); else basket.push({id, qty: Math.min(MAX_QTY, qty)});
  save();
}
// returns per-line totals: the single full-price pack goes to the most expensive line
function totals(){
  let fullId = null;
  basket.forEach(l => { const p = packById(l.id); if (!fullId || p.price > packById(fullId).price) fullId = l.id; });
  let full = 0, total = 0; const lines = {};
  basket.forEach(l => {
    const p = packById(l.id);
    const fullUnits = l.id === fullId ? 1 : 0;
    const pence = fullUnits * pennies(p.price) + (l.qty - fullUnits) * discPence(p);
    lines[l.id] = pence / 100; full += pennies(p.price) * l.qty; total += pence;
  });
  return {disc: count() >= 2, full: full / 100, total: total / 100, lines};
}
function renderBasket(){
  const c = $("cartCount"); if (c) c.textContent = count();
  const box = $("drawerLines"); if (!box) return;
  const t = totals();
  box.innerHTML = basket.length ? basket.map(l => {
    const p = packById(l.id);
    const line = t.lines[l.id];
    return `<div class="line"><img src="/img/product-box.webp" alt="">
      <div><b>Crest 3D White LUXE · ${p.label} pouches</b><small>${p.name}</small>
        <div class="q"><button type="button" data-dec="${p.id}" aria-label="One fewer">−</button><span>${l.qty}</span><button type="button" data-inc="${p.id}" aria-label="One more">+</button><button type="button" class="rm" data-rm="${p.id}">Remove</button></div></div>
      <div class="lp">${line < p.price * l.qty - 0.001 ? `<s>${gbp(p.price * l.qty)}</s>` : ""}${gbp(line)}</div></div>`;
  }).join("") : `<p class="empty">Your basket is empty.</p>`;
  $("drawerTotal").textContent = gbp(t.total);
  $("drawerNote").textContent = !basket.length ? "" : t.disc ? `30% off 2nd pack applied: you save ${gbp(t.full - t.total)}` : "Add a 2nd pack and get 30% off it";
  $("checkoutBtn").disabled = !basket.length;
}
function openDrawer(){ $("drawer").classList.add("open"); $("drawer").setAttribute("aria-hidden","false"); $("drawerBg").hidden = false; }
function closeDrawer(){ $("drawer").classList.remove("open"); $("drawer").setAttribute("aria-hidden","true"); $("drawerBg").hidden = true; }

document.addEventListener("click", e => {
  const t = e.target.closest("[data-inc],[data-dec],[data-rm]"); if (!t) return;
  const id = t.dataset.inc || t.dataset.dec || t.dataset.rm;
  const l = basket.find(x => x.id === id); if (!l) return;
  if (t.dataset.inc) l.qty = Math.min(MAX_QTY, l.qty + 1);
  if (t.dataset.dec) l.qty -= 1;
  if (t.dataset.rm) l.qty = 0;
  basket = basket.filter(x => x.qty > 0); save();
});
if ($("cartBtn")) $("cartBtn").onclick = openDrawer;
$("drawerClose").onclick = closeDrawer;
$("drawerBg").onclick = closeDrawer;
document.addEventListener("keydown", e => { if (e.key === "Escape") closeDrawer(); });

$("checkoutBtn").onclick = async () => {
  const btn = $("checkoutBtn"), msg = $("checkoutMsg");
  btn.disabled = true; btn.textContent = "Loading secure checkout…"; msg.hidden = true;
  try {
    const r = await fetch("/api/checkout", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({items: basket})});
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.url) { location.href = d.url; return; }
    msg.textContent = d.error || "Checkout is unavailable right now. Please try again shortly.";
  } catch (err) {
    msg.textContent = "Checkout is unavailable right now. Please try again shortly.";
  }
  msg.hidden = false; btn.disabled = false; btn.textContent = "Checkout";
};

if (location.pathname.startsWith("/thank-you")) { basket = []; save(); }
renderBasket();

// ---------- product buy box (home page) ----------
if ($("sizes")) {
  $("sizes").innerHTML = PACKS.map(p => `<div class="size">${p.flag ? `<span class="flag">${p.flag}</span>` : ""}<input type="radio" name="pack" id="${p.id}" value="${p.id}" ${p.id === "p10" ? "checked" : ""}><label for="${p.id}"><b>${p.label} pouches</b><em>${gbp(p.price)}</em><i>−${Math.round((1 - p.price / p.was) * 100)}%</i></label></div>`).join("");
  let qty = 1;
  const current = () => packById(document.querySelector("input[name=pack]:checked").value);
  const render = () => {
    const p = current();
    $("priceNow").textContent = gbp(p.price);
    $("priceWas").hidden = false; $("priceSave").hidden = false;
    $("priceWas").textContent = gbp(p.was);
    $("priceSave").textContent = "Save " + Math.round((1 - p.price / p.was) * 100) + "%";
    $("perPouch").textContent = gbp(p.price / p.pouches) + " per treatment";
    $("qty").textContent = qty;
    $("addBtn").textContent = "Add to basket · " + gbp((pennies(p.price) + (qty - 1) * discPence(p)) / 100);
    if ($("stPrice")) { $("stPrice").textContent = gbp(p.price); $("stName").textContent = p.name + " · " + p.pouches + " pouches"; }
  };
  $("sizes").addEventListener("change", render);
  $("qMinus").onclick = () => { qty = Math.max(1, qty - 1); render(); };
  $("qPlus").onclick = () => { qty = Math.min(MAX_QTY, qty + 1); render(); };
  $("buyForm").addEventListener("submit", e => {
    e.preventDefault(); add(current().id, qty); qty = 1; render(); openDrawer();
  });
  render();
  const st = $("sticky");
  if (st) new IntersectionObserver(([en]) => { const past = !en.isIntersecting && en.boundingClientRect.top < 0; st.classList.toggle("on", past); st.setAttribute("aria-hidden", String(!past)); }).observe($("addBtn"));
}

// ---------- gallery, before/after slider, rails ----------
document.querySelectorAll(".thumbs button").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll(".thumbs button").forEach(x => x.setAttribute("aria-pressed", "false"));
  b.setAttribute("aria-pressed", "true"); $("mainImg").src = b.dataset.src; $("mainImg").alt = b.dataset.alt;
}));
if ($("cmp")) $("cmp").addEventListener("input", e => { const v = e.target.value; $("afterLayer").style.clipPath = `inset(0 0 0 ${v}%)`; $("handle").style.left = v + "%"; });
function rail(railId, prevId, nextId){
  const r = $(railId); if (!r) return;
  $(prevId).onclick = () => r.scrollBy({left: -r.clientWidth * 0.8, behavior: "smooth"});
  $(nextId).onclick = () => r.scrollBy({left: r.clientWidth * 0.8, behavior: "smooth"});
}
rail("rail", "prev", "next");
rail("blogRail", "bPrev", "bNext");

// ---------- forms not yet connected ----------
if ($("contactForm")) $("contactForm").addEventListener("submit", e => { e.preventDefault(); const s = $("sent"); s.textContent = "The contact form is not connected yet."; s.hidden = false; });
if ($("trackForm")) $("trackForm").addEventListener("submit", e => { e.preventDefault(); const m = $("tMsg"); m.textContent = "Order tracking is not connected yet."; m.hidden = false; });
