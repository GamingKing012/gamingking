# GamingKing — automatic redeem-code store

A starter web app for selling digital redeem codes with crypto checkout, automatic stock reservation at delivery time, admin inventory tools and optional email delivery.

## Included
- Product catalogue with live available-code counts
- Quantity checkout and customer email
- NOWPayments invoice checkout (customer can choose from the coins/networks enabled in your NOWPayments merchant account)
- Signed IPN webhook validation (HMAC-SHA512)
- Delivery only after signed `finished` IPN plus direct NOWPayments payment-status verification and amount/currency/order checks\n- Private order-access token required to view purchased codes
- Atomic SQLite stock reservation at checkout and inventory deduction on successful payment to avoid issuing the same code twice
- Admin login, product creation, bulk upload TXT/CSV codes (one code per line / first CSV column), order list
- Optional SMTP email delivery; codes also appear on the order status page

## Run locally
1. Install Node.js 20+.
2. Copy `.env.example` to `.env`.
3. Set a strong `ADMIN_PASSWORD`, `SESSION_SECRET`, `BASE_URL`, NOWPayments API key and IPN secret.
4. Run:
   ```bash
   npm install
   npm start
   ```
5. Open `http://localhost:3000`; admin is at `/admin.html`.

## NOWPayments setup
1. Create/verify your merchant account and configure the payout wallet(s).
2. Enable the currencies/chains you want customers to pay with in the merchant dashboard.
3. Create an API key and an IPN secret.
4. Deploy this app on a public HTTPS domain, then set `BASE_URL` to that exact domain.
5. Configure the provider webhook/IPN callback to `https://YOUR_DOMAIN/api/webhooks/nowpayments` (the app also supplies this callback URL when creating each invoice).
6. Make a small test purchase before accepting live orders.

Official references:
- API endpoints and invoice creation: https://nowpayments.zendesk.com/hc/en-us/articles/21345824322717-API-and-endpoint-description
- IPN signature verification: https://nowpayments.zendesk.com/hc/en-us/articles/21395546303389-IPN-and-how-to-setup
- Integration guide: https://nowpayments.zendesk.com/hc/en-us/articles/21341613323421-NOWPayments-Integration-Guide

## Important production work before launch
This is a starter project, not yet a hardened production store:
- Replace the short-lived in-memory admin token map with persistent, secure sessions (Redis/database), add login rate limiting and CSRF protection.
- Customer order pages use an unguessable access token in the success URL; keep order URLs private.
- Add explicit handling and reconciliation for under/overpayments, late payments and webhook retries; current implementation verifies final payment status, order ID, price and price currency against the provider.
- Add idempotent webhook event handling, inventory reservation/expiry, refund/manual-review workflows and admin audit logs.
- Configure SMTP and verify email delivery. If SMTP is absent, codes remain accessible on the success page.
- Use HTTPS, backups, monitoring, and keep `.env` private. Never commit API keys or IPN secrets.
- Confirm the payment provider accepts your business, products, and country before going live. Crypto provider availability, supported assets/chains, fees and compliance checks can vary by account and jurisdiction.

## Data
SQLite database `gamingking.sqlite` is created automatically. Back it up regularly. Do not delete it if you want to retain your products, stock and orders.
