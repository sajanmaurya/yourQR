# Cashfree billing setup for YourQR

The project uses Cashfree **Subscriptions**, not Razorpay. Checkout is **disabled by default**. No real customer can be charged until merchant onboarding is complete and the owner deliberately enables it.

## What has been implemented

- Free and Pro plan UI under **Billing**; a 10-digit Indian phone number is collected only for Cashfree mandate authorisation.
- Merchant-defined INR recurring plan fetched from Cashfree: price and interval are never taken from browser input.
- Server creates subscription and sends the Cashfree `subscription_session_id` to the official hosted checkout SDK.
- Verify status using Cashfree's backend API, not return-url parameters or browser callbacks.
- Verify webhook signatures with HMAC-SHA256 over timestamp + **raw request body** (base64 signature). Event deduplication and fresh status fetch prevent replay/out-of-order status issues.
- Cancel mandates using Cashfree's Manage Subscription API.
- Optional free-plan QR limit (default 10); **disabled until explicitly enabled**. Existing QR redirects do not stop working when billing is activated.
- Additive tables on SQLite and Neon PostgreSQL, retaining all existing data.

## Merchant onboarding

1. Create a Cashfree merchant account, complete merchant KYC, and activate **Subscriptions** (UPI AutoPay and any other methods you intend to accept). Ensure hosted checkout is enabled for your verified domain.
2. Create a **PERIODIC**, **ACTIVE**, INR Pro plan in Cashfree and record its `plan_id`; its actual recurring amount is shown on the YourQR Billing page.
3. Add Cashfree **sandbox** credentials as server environment variables in a protected preview deployment (not in Git, frontend code, or screenshots).
4. Configure a **Subscriptions webhook** in Cashfree pointing at `https://YOUR_PREVIEW_OR_DOMAIN/api/billing/webhook`, using the current version and webhook signing secret. Subscribe to subscription lifecycle and payment status events. Verify signature before trusting requests.
5. With sandbox credentials, test approval, failure, cancellation, repeated webhook delivery, status refresh, two-account isolation, and already-printed QR links.
6. Establish pricing, invoices/GST handling, refunds/cancellation terms, account verification, backups and support contacts before accepting real payments.
7. Only after those tests, configure **production** credentials, production plan and verified domain. Switch the environment to production and enable payment creation. Enable enforced QR limits separately after checking existing users.

## Environment variables

```env
CASHFREE_SUBSCRIPTIONS_ENABLED=false
CASHFREE_ENFORCE_LIMITS=false
CASHFREE_ENVIRONMENT=sandbox
CASHFREE_CLIENT_ID=
CASHFREE_SECRET_KEY=
CASHFREE_WEBHOOK_SECRET=
CASHFREE_PLAN_ID=
FREE_QR_LIMIT=10
```

For sandbox checkout set `CASHFREE_SUBSCRIPTIONS_ENABLED=true` only on the isolated preview after setting other variables. Choose `CASHFREE_ENVIRONMENT=production` only when approved for real charges. Set `CASHFREE_ENFORCE_LIMITS=true` only when ready to restrict new free-plan QR creation. Never configure live keys on untrusted branch previews.

**Important:** A Cashfree promotional 0% platform-fee offer is not guaranteed for your merchant account, and e-mandate/recurring charges and applicable taxes may still apply. Confirm current contracted rates in Cashfree Dashboard before pricing your subscriptions.

## Current scope and safeguards

- Does not provide refunds, invoice generation, GST compliance, a customer support console, chargeback handling, email verification or proration. Those need separate implementation before general commercial launch.
- Cashfree subscription status **ACTIVE**, with successful authorisation verified by a Cashfree API fetch, is the current Pro entitlement rule. Validate your first-payment/mandate timing in Cashfree sandbox before activating real billing.
- Cancellation calls the Cashfree API immediately. The site does **not** promise Pro access for the remainder of a prepaid period, pending an explicit grace-period policy.
- A stuck subscription after a network failure must be reconciled with Cashfree support; do not generate a second mandate without checking the existing subscription ID.
- The feature is safe to merge behind disabled defaults, but it is **not yet a production-tested payment service**.

Official docs:
- https://www.cashfree.com/docs/payments/subscription/hosted-checkout
- https://www.cashfree.com/docs/api-reference/payments/latest/subscription/create-subscription
- https://www.cashfree.com/docs/api-reference/payments/latest/subscription/fetch-subscription
- https://www.cashfree.com/docs/api-reference/payments/latest/subscription/manage-subscription
- https://www.cashfree.com/docs/api-reference/payments/latest/subscription/webhooks
