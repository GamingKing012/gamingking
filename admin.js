let token = "";
const $ = id => document.getElementById(id);
const auth = () => ({Authorization:"Bearer "+token,"Content-Type":"application/json"});
$("login-form").onsubmit = async e => {
 e.preventDefault(); const r=await fetch("/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:$("username").value,password:$("password").value})});
 const d=await r.json(); if(!r.ok) return alert(d.error); token=d.token; $("login").classList.add("hidden"); $("dashboard").classList.remove("hidden"); refresh();
};
$("product-form").onsubmit = async e => {
 e.preventDefault(); const r=await fetch("/api/admin/products",{method:"POST",headers:auth(),body:JSON.stringify({name:$("pname").value,description:$("pdesc").value,price:Number($("pprice").value)})});
 const d=await r.json(); if(!r.ok) return alert(d.error); $("product-form").reset(); refresh();
};
async function refresh(){
 const r=await fetch("/api/admin/summary",{headers:auth()}); const d=await r.json(); if(!r.ok) return alert(d.error);
 $("admin-products").innerHTML=d.products.map(p=>`<div class="admin-row"><div><b>${esc(p.name)}</b><small>${p.stock} codes available · $${Number(p.price).toFixed(2)}</small></div><button class="quiet" onclick="addCodes(${p.id})">Upload codes</button></div>`).join("") || "No products yet.";
 $("admin-orders").innerHTML=d.orders.map(o=>`<div class="admin-row"><div><b>${esc(o.id)} · ${esc(o.product_name)} × ${o.quantity}</b><small>${esc(o.email)} · ${esc(o.status)} · $${Number(o.total).toFixed(2)}</small></div></div>`).join("") || "No orders yet.";
}
async function addCodes(id){
 const picker=document.createElement("input"); picker.type="file"; picker.accept=".txt,.csv,text/plain,text/csv";
 picker.onchange=async()=>{
  const file=picker.files[0]; if(!file) return;
  const text=await file.text();
  // TXT: one code per line. CSV: first column is treated as the code; header rows are ignored.
  const codes=text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>line.split(",")[0].trim()).filter(code=>code && !/^code$/i.test(code));
  if(!codes.length) return alert("No codes found in that file.");
  const r=await fetch(`/api/admin/products/${id}/codes`,{method:"POST",headers:auth(),body:JSON.stringify({codes:codes.join("\n")})}); const d=await r.json();
  if(!r.ok) alert(d.error); else alert(`Added ${d.added} new codes (${d.submitted} submitted).`); refresh();
 };
 picker.click();
}

function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
