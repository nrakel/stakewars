# TODO

## 2026-06-24

- Test Parlay live MLB game data during active games:
  - Parlay support said the `/live` endpoints are fixed as of 2026-06-30; re-test before changing app behavior.
  - Poll `/v1/sports/baseball_mlb/live/points` and inspect snapshot shape.
  - If Starter is active, test `/v1/sports/baseball_mlb/live/sse`.
  - Compare `initial_state` vs `pbp_event` payloads.
  - Estimate credit usage from response headers/dashboard.
  - Decide whether gamecast should start with polling or SSE.

## 2026-06-25

- Tighten security:
  - Review auth/session handling, password rules, rate limits, and JWT lifetime.
  - Audit account/profile fields for validation, privacy, and exposure in public APIs.
  - Review CSRF/CORS/Helmet/CSP behavior for the deployed domain.
  - Add stronger protections around admin/system-only actions and scheduled jobs.
  - Review secret storage, service environment files, and logging for accidental sensitive data exposure.
  - Add security-focused tests for registration, login, profile updates, wagers, and push subscriptions.

## 2026-07-21

- Set up StakeWars merchandise store:
  - Create/configure Shopify account for the official StakeWars Gear storefront.
  - Create/configure Printly account and connect it to Shopify for print-on-demand fulfillment.
  - Configure Shopify custom domain for `gear.stakewars.ai`.
  - Add the DNS record Shopify requires for `gear.stakewars.ai`; prefer Shopify's instructed record over pointing it at the StakeWars server.
  - Wait for Shopify domain verification and managed SSL certificate issuance.
  - Confirm `https://gear.stakewars.ai` loads without browser security warnings.
  - Update StakeWars production env to `MERCH_STORE_URL=https://gear.stakewars.ai`.
  - Restart StakeWars after the env update and verify the Gear nav opens the new store URL.
  - Keep checkout, payments, taxes, shipping, refunds, inventory, and fulfillment entirely inside Shopify/Printly.
