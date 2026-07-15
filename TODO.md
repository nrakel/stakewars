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
