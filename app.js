let products = [];
const $ = id => document.getElementById(id);
const money = n => "$" + Number(n).toFixed(2);
async function loadProducts() {
  const r = await fetch("/api/products"); products = await r.json();
  $("products").innerHTML = products.length ? products.map(p => `
    <article class="product">
      <div class="product-icon">🎮</div><div class="product-info"><h3>${esc(p.name)}</h3><p>${esc(p.description || "Digital redeem code")}</p><small>${p.stock} available</small></div>
      <div class="buy-area"><strong>${money(p.price)}</strong><button class="primary small" ${p.stock < 1 ? "disabled" : ""} onclick="choose(${p.id})">${p.stock < 1 ? "Sold out" : "Buy now"}</button></div>
    </article>`).join("") : `<div class="empty">No products listed yet. Check back soon.</div>`;
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function choose(id) {
  const p = products.find(x => x.id === id); if (!p) return;
  $("product-id").value = id; $("selected-name").textContent = p.name;
  $("quantity").max = Math.min(50, p.stock); $("quantity").value = 1;
  $("order-panel").classList.remove("hidden"); $("order-result").classList.add("hidden");
  updateTotal(); $("order-panel").scrollIntoView({behavior:"smooth"});
}
function updateTotal() {
  const p = products.find(x => x.id === Number($("product-id").value));
  const q = Math.max(1, Number($("quantity").value || 1));
  $("total").textContent = p ? money(p.price*q) : "$0.00";
}
$("quantity").addEventListener("input", updateTotal);
$("close-order").onclick = () => $("order-panel").classList.add("hidden");
$("order-form").onsubmit = async e => {
  e.preventDefault();
  const btn = e.submitter; btn.disabled = true; btn.textContent = "Creating secure invoice…";
  try {
    const r = await fetch("/api/orders", {method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({productId:Number($("product-id").value),quantity:Number($("quantity").value),email:$("email").value})});
    const data = await r.json(); if (!r.ok) throw new Error(data.error || "Unable to create order");
    location.href = data.invoiceUrl;
  } catch(err) { alert(err.message); btn.disabled=false; btn.textContent="Continue to crypto payment ↗"; }
};
async function showOrder(id, access) {
  const box = $("order-result"); box.classList.remove("hidden");
  try {
    const r = await fetch("/api/orders/"+encodeURIComponent(id)+"?access="+encodeURIComponent(access || "")); const o = await r.json();
    if (!r.ok) throw new Error(o.error);
    box.innerHTML = `<div class="section-head"><h2>Order ${esc(o.id)}</h2><span class="status">${esc(o.status)}</span></div>
      <p>${esc(o.product_name)} × ${o.quantity}</p>
      ${o.status === "delivered" ? `<h3>Your redeem codes</h3><div class="codes">${o.codes.map((c,i)=>`<div><span>${i+1}. ${esc(c)}</span><button class="quiet" onclick="navigator.clipboard.writeText(${JSON.stringify(c)})">Copy</button></div>`).join("")}</div><p class="tiny">Codes are also sent by email when email delivery is configured.</p>` : `<p class="muted">Payment status: ${esc(o.status)}. This page can be refreshed after confirmation.</p>`}`;
  } catch(e) { box.textContent=e.message; }
}
$("year").textContent = new Date().getFullYear();
loadProducts();
const params = new URLSearchParams(location.search);
if (params.has("order")) showOrder(params.get("order"), params.get("access"));
