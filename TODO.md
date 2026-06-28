# TODO

## 2026-06-24

- Test Parlay live MLB game data during active games:
  - Poll `/v1/sports/baseball_mlb/live/points` and inspect snapshot shape.
  - If Starter is active, test `/v1/sports/baseball_mlb/live/sse`.
  - Compare `initial_state` vs `pbp_event` payloads.
  - Estimate credit usage from response headers/dashboard.
  - Decide whether gamecast should start with polling or SSE.

## 2026-06-25

- Add daily Reddit post automation:
  - Create a reusable post template with dynamic StakeWars content.
  - Include AI Bot locked picks, leaderboard snapshot, and site link.
  - Add Reddit API config to production env without committing secrets.
  - Add a `reddit_post_log` table to prevent duplicate daily posts.
  - Start with dry-run/manual approval before enabling scheduled publishing.

- Configure push notifications and their verbiage:
  - Define notification categories users can opt into or out of.
  - Draft final copy for daily game reminders, locked AI picks, settled wagers, and reward eligibility.
  - Keep notification frequency conservative so users leave notifications enabled.

- Tighten security:
  - Review auth/session handling, password rules, rate limits, and JWT lifetime.
  - Audit account/profile fields for validation, privacy, and exposure in public APIs.
  - Review CSRF/CORS/Helmet/CSP behavior for the deployed domain.
  - Add stronger protections around admin/system-only actions and scheduled jobs.
  - Review secret storage, service environment files, and logging for accidental sensitive data exposure.
  - Add security-focused tests for registration, login, profile updates, wagers, and push subscriptions.
