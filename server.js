require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const path = require("path");

const app = express();
const db = new Database("gamingking.sqlite");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  price REAL NOT NULL CHECK(price > 0),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  order_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(product_id, code)
);
CREATE INDEX IF NOT EXISTS idx_codes_stock ON codes(product_id, status);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  total REAL NOT NULL,
  email TEXT NOT NULL,
  access_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  invoice_id TEXT,
  invoice_url TEXT,
  codes_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  delivered_at TEXT
);
`);
try { db.exec("ALTER TABLE orders ADD COLUMN access_hash TEXT"); } catch (e) {
  if (!String(e.message).includes("duplicate column")) throw e;
}

const adminSessions = new Map(); // Short-lived process sessions; configure persistent session storage for multi-instance production.
app.use(helmet({ contentSecurityPolicy: false }));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/admin.html", (req, res) => res.sendFile(path.join(__dirname, "admin.html")));
app.get("/style.css", (req, res) => res.sendFile(path.join(__dirname, "style.css")));
app.get("/app.js", (req, res) => res.sendFile(path.join(__dirname, "app.js")));
app.get("/admin.js", (req, res) => res.sendFile(path.join(__dirname, "admin.js")));
app.use(express.json({
  limit: "1mb",
  verify: (req, res, buf) => {
    if (req.originalUrl.startsWith("/api/webhooks/nowpayments")) req.rawBody = Buffer.from(buf);
  }
}));

const limiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
app.use("/api/", limiter);

function adminAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const expires = token && adminSessions.get(token);
  if (!expires || expires < Date.now()) { if (token) adminSessions.delete(token); return res.status(401).json({ error: "Admin login required" }); }
  next();
}
function newId() { return "GK-" + crypto.randomBytes(6).toString("hex").toUpperCase(); }
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function verifyNowPaymentsIPN(body, signature) {
  const secret = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!secret || !signature) return false;
  const sortDeep = value => {
    if (Array.isArray(value)) return value.map(sortDeep);
    if (value && typeof value === "object") {
      return Object.keys(value).sort().reduce((out, key) => { out[key] = sortDeep(value[key]); return out; }, {});
    }
    return value;
  };
  const digest = crypto.createHmac("sha512", secret).update(JSON.stringify(sortDeep(body))).digest("hex");
  return safeEqual(digest.toLowerCase(), String(signature).toLowerCase());
}
async function sendCodesEmail(order, codes) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return false;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE).toLowerCase() === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: order.email,
    subject: `Your GamingKing order ${order.id}`,
    text: `Thank you for your purchase!\n\nProduct: ${order.product_name}\nQuantity: ${order.quantity}\n\nYour redeem codes:\n${codes.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\nOrder: ${order.id}\nGamingKing`
  });
  return true;
}

app.get("/api/products", (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.description, p.price,
      (SELECT COUNT(*) FROM codes c WHERE c.product_id=p.id AND c.status='available') AS stock
    FROM products p WHERE p.active=1 ORDER BY p.id DESC
  `).all();
  res.json(rows);
});

app.post("/api/orders", async (req, res) => {
  let createdOrderId = null;
  try {
    const { productId, quantity, email } = req.body || {};
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) return res.status(400).json({ error: "Quantity must be between 1 and 50" });
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address" });
    const product = db.prepare("SELECT * FROM products WHERE id=? AND active=1").get(Number(productId));
    if (!product) return res.status(404).json({ error: "Product not found" });
    const stock = db.prepare("SELECT COUNT(*) AS n FROM codes WHERE product_id=? AND status='available'").get(product.id).n;
    if (stock < qty) return res.status(409).json({ error: `Only ${stock} codes currently in stock` });
    if (!process.env.NOWPAYMENTS_API_KEY) return res.status(503).json({ error: "Crypto gateway is not configured yet. Admin must add NOWPayments API credentials." });

    const id = newId();
    createdOrderId = id;
    const accessToken = crypto.randomBytes(32).toString("hex");
    const accessHash = crypto.createHash("sha256").update(accessToken).digest("hex");
    const total = Number((product.price * qty).toFixed(2));
    const reserve = db.transaction(() => {
      const available = db.prepare("SELECT id FROM codes WHERE product_id=? AND status='available' ORDER BY id LIMIT ?").all(product.id, qty);
      if (available.length !== qty) throw new Error("STOCK_CHANGED");
      db.prepare(`INSERT INTO orders (id, product_id, product_name, quantity, unit_price, total, email, access_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, product.id, product.name, qty, product.price, total, email, accessHash);
      const claim = db.prepare("UPDATE codes SET status='reserved', order_id=? WHERE id=? AND status='available'");
      for (const row of available) {
        if (claim.run(id, row.id).changes !== 1) throw new Error("STOCK_CHANGED");
      }
    });
    try { reserve(); } catch (e) {
      if (e.message === "STOCK_CHANGED") return res.status(409).json({ error: "Stock just changed. Please refresh and try again." });
      throw e;
    }

    const response = await fetch("https://api.nowpayments.io/v1/invoice", {
      method: "POST",
      headers: { "x-api-key": process.env.NOWPAYMENTS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        price_amount: total,
        price_currency: process.env.NOWPAYMENTS_PRICE_CURRENCY || "usd",
        ipn_callback_url: `${process.env.BASE_URL}/api/webhooks/nowpayments`,
        order_id: id,
        order_description: `${product.name} x ${qty}`,
        success_url: `${process.env.BASE_URL}/?order=${id}&access=${accessToken}`,
        cancel_url: `${process.env.BASE_URL}/?cancelled=${id}`
      })
    });
    const invoice = await response.json();
    if (!response.ok || !invoice.invoice_url) {
      db.prepare("UPDATE orders SET status='payment_error' WHERE id=?").run(id);
      db.prepare("UPDATE codes SET status='available', order_id=NULL WHERE order_id=? AND status='reserved'").run(id);
      return res.status(502).json({ error: "Could not create crypto invoice", detail: invoice.message || invoice });
    }
    db.prepare("UPDATE orders SET invoice_id=?, invoice_url=? WHERE id=?").run(String(invoice.id || ""), invoice.invoice_url, id);
    res.json({ orderId: id, invoiceUrl: invoice.invoice_url });
  } catch (e) {
    console.error(e);
    if (createdOrderId) {
      db.prepare("UPDATE orders SET status='payment_error' WHERE id=? AND status='pending'").run(createdOrderId);
      db.prepare("UPDATE codes SET status='available', order_id=NULL WHERE order_id=? AND status='reserved'").run(createdOrderId);
    }
    res.status(500).json({ error: "Could not create order" });
  }
});

// The provider sends raw JSON. Verify the HMAC signature before trusting payment status.
app.post("/api/webhooks/nowpayments", async (req, res) => {
  try {
    const body = req.body;
    const signature = req.headers["x-nowpayments-sig"];
    if (!verifyNowPaymentsIPN(body, signature)) return res.status(401).send("Invalid signature");
    const orderId = String(body.order_id || "");
    const order = db.prepare("SELECT * FROM orders WHERE id=?").get(orderId);
    if (!order) return res.status(404).send("Unknown order");
    if (order.status === "delivered") return res.status(200).send("Already delivered");

    // Ignore intermediate states. Verify the final status directly with NOWPayments before delivery.
    if (body.payment_status !== "finished") {
      if (["failed", "refunded", "expired"].includes(body.payment_status)) {
        db.prepare("UPDATE orders SET status=? WHERE id=?").run(body.payment_status, orderId);
        db.prepare("UPDATE codes SET status='available', order_id=NULL WHERE order_id=? AND status='reserved'").run(orderId);
      } else {
        db.prepare("UPDATE orders SET status='confirming' WHERE id=? AND status='pending'").run(orderId);
      }
      return res.status(200).send("Status recorded");
    }
    if (!body.payment_id || !process.env.NOWPAYMENTS_API_KEY) {
      db.prepare("UPDATE orders SET status='payment_review' WHERE id=?").run(orderId);
      return res.status(200).send("Payment requires manual review");
    }
    const verifyResponse = await fetch(`https://api.nowpayments.io/v1/payment/${encodeURIComponent(body.payment_id)}`, {
      headers: { "x-api-key": process.env.NOWPAYMENTS_API_KEY }
    });
    const verified = await verifyResponse.json();
    if (!verifyResponse.ok ||
        String(verified.payment_status) !== "finished" ||
        String(verified.order_id) !== orderId ||
        Math.abs(Number(verified.price_amount || 0) - order.total) > 0.02 ||
        String(verified.price_currency || "").toLowerCase() !== (process.env.NOWPAYMENTS_PRICE_CURRENCY || "usd").toLowerCase()) {
      db.prepare("UPDATE orders SET status='payment_review' WHERE id=?").run(orderId);
      return res.status(200).send("Payment requires manual review");
    }

    const deliver = db.transaction(() => {
      const fresh = db.prepare("SELECT * FROM orders WHERE id=?").get(orderId);
      if (fresh.status === "delivered") return null;
      const codes = db.prepare(`SELECT id, code FROM codes WHERE product_id=? AND status='reserved' AND order_id=? ORDER BY id LIMIT ?`)
        .all(fresh.product_id, orderId, fresh.quantity);
      if (codes.length !== fresh.quantity) {
        db.prepare("UPDATE orders SET status='out_of_stock_review' WHERE id=?").run(orderId);
        return null;
      }
      const update = db.prepare("UPDATE codes SET status='sold' WHERE id=? AND status='reserved' AND order_id=?");
      for (const c of codes) {
        const result = update.run(c.id, orderId);
        if (result.changes !== 1) throw new Error("Inventory race detected");
      }
      db.prepare("UPDATE orders SET status='delivered', codes_json=?, delivered_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(JSON.stringify(codes.map(c => c.code)), orderId);
      return codes.map(c => c.code);
    });
    const codes = deliver();
    if (codes) {
      try { await sendCodesEmail(order, codes); }
      catch (mailErr) { console.error("Email delivery failed:", mailErr); }
    }
    res.status(200).send("OK");
  } catch (e) {
    console.error("IPN error:", e);
    res.status(400).send("Bad webhook");
  }
});

app.get("/api/orders/:id", (req, res) => {
  const order = db.prepare("SELECT id, product_name, quantity, total, status, codes_json, created_at, delivered_at, access_hash FROM orders WHERE id=?").get(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });
  const supplied = String(req.query.access || "");
  const suppliedHash = crypto.createHash("sha256").update(supplied).digest("hex");
  if (!order.access_hash || !safeEqual(order.access_hash, suppliedHash)) return res.status(403).json({ error: "Invalid order access link" });
  res.json({ id: order.id, product_name: order.product_name, quantity: order.quantity, total: order.total,
    status: order.status, codes: order.codes_json ? JSON.parse(order.codes_json) : [],
    created_at: order.created_at, delivered_at: order.delivered_at });
});

app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 16 ||
      !safeEqual(username, process.env.ADMIN_USERNAME || "admin") ||
      !safeEqual(password, process.env.ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  const token = crypto.randomBytes(32).toString("hex");
  adminSessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
  res.json({ token });
});
app.get("/api/admin/summary", adminAuth, (req, res) => {
  const products = db.prepare(`SELECT p.*,
    (SELECT COUNT(*) FROM codes c WHERE c.product_id=p.id AND c.status='available') AS stock
    FROM products p ORDER BY p.id DESC`).all();
  const orders = db.prepare("SELECT id, product_name, quantity, total, email, status, created_at FROM orders ORDER BY created_at DESC LIMIT 100").all();
  res.json({ products, orders });
});
app.post("/api/admin/products", adminAuth, (req, res) => {
  const { name, description = "", price } = req.body || {};
  const p = Number(price);
  if (!String(name || "").trim() || !Number.isFinite(p) || p <= 0) return res.status(400).json({ error: "Valid name and price required" });
  const result = db.prepare("INSERT INTO products (name, description, price) VALUES (?, ?, ?)").run(String(name).trim(), String(description), p);
  res.json({ id: result.lastInsertRowid });
});
app.post("/api/admin/products/:id/codes", adminAuth, (req, res) => {
  const productId = Number(req.params.id);
  const product = db.prepare("SELECT id FROM products WHERE id=?").get(productId);
  if (!product) return res.status(404).json({ error: "Product not found" });
  const lines = String(req.body.codes || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length || lines.length > 10000) return res.status(400).json({ error: "Paste 1 to 10,000 codes, one per line" });
  const insert = db.prepare("INSERT OR IGNORE INTO codes (product_id, code) VALUES (?, ?)");
  const add = db.transaction(() => {
    let count = 0;
    for (const code of lines) count += insert.run(productId, code).changes;
    return count;
  });
  res.json({ added: add(), submitted: lines.length });
});
app.post("/api/admin/products/:id/toggle", adminAuth, (req, res) => {
  const active = req.body.active ? 1 : 0;
  db.prepare("UPDATE products SET active=? WHERE id=?").run(active, Number(req.params.id));
  res.json({ ok: true });
});
app.get("/api/admin/orders/:id", adminAuth, (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });
  res.json({ ...order, codes: order.codes_json ? JSON.parse(order.codes_json) : [] });
});

app.get("/health", (req, res) => res.json({ ok: true }));
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`GamingKing running on http://localhost:${port}`));
