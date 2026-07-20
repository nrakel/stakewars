# StakeWars

React and Postgres MVP for weekly bankroll contests at `stakewars.phisystems.ai`.

## Local development

1. Copy environment defaults:

```bash
cp .env.example .env
```

2. Start Postgres, or point `DATABASE_URL` at an existing database.

3. Run migrations and seed data:

```bash
npm run migrate
npm run seed
```

4. Start the app:

```bash
npm run dev
```

The API serves on `http://localhost:3000`. For Vite's dev frontend, run:

```bash
npx vite --host 0.0.0.0
```

## Production deployment

Create a production `.env` next to `docker-compose.yml`:

```bash
POSTGRES_PASSWORD=replace-with-a-strong-db-password
JWT_SECRET=replace-with-a-long-random-secret
WEEKLY_BANKROLL_CENTS=100000
PARLAY_API_KEY=your-parlay-api-key
MERCH_STORE_URL=https://shop.stakewars.ai
```

Bring up Postgres and the app once, then apply schema:

```bash
docker compose up -d db
docker compose run --rm app npm run migrate:prod
docker compose run --rm app npm run seed:prod
```

Before the first certificate exists, temporarily comment out the `443` server block in `nginx/stakewars.conf`, then start Nginx:

```bash
docker compose up -d nginx
docker compose run --rm certbot certonly --webroot \
  --webroot-path /var/www/certbot \
  -d stakewars.phisystems.ai \
  --email admin@phisystems.ai \
  --agree-tos \
  --no-eff-email
```

Restore the `443` server block, then start everything:

```bash
docker compose up -d --build
```

Renew certificates:

```bash
docker compose run --rm certbot renew --webroot --webroot-path /var/www/certbot
docker compose exec nginx nginx -s reload
```

## Merchandise store

StakeWars can link authenticated users to an external Shopify merchandise store without adding checkout logic to the StakeWars app.

Configure the destination:

```bash
MERCH_STORE_URL=https://shop.stakewars.ai
```

Current behavior:

- Shopify hosts the storefront, product pages, cart, checkout, payments, taxes, shipping, refunds, and order management.
- Printful fulfillment is handled through Shopify/Printful, not through StakeWars.
- StakeWars does not collect payment-card information.
- StakeWars does not create a Shopify orders database.
- The in-app Gear link is currently visible only to Nate Rakel's account.
- Gear navigation logs a first-party `merch_store_click` event before opening `MERCH_STORE_URL` in the same tab.

Apply the merch click-log migration before deploying this feature:

```bash
npm run migrate
```

Production compiled command:

```bash
npm run migrate:prod
```

## Odds feed

Hourly odds refresh uses Parlay API. Configure:

```bash
PARLAY_API_BASE_URL=https://parlay-api.com/v1
PARLAY_API_KEY=your-parlay-api-key
PARLAY_BOOKMAKERS=bovada
```

Run a manual import:

```bash
npm run refresh:odds
```

The importer pulls spread markets for MLB, NHL, NFL, NBA, NCAA men's basketball, and NCAA football. MLB also pulls moneylines. `PARLAY_BOOKMAKERS` is sent to Parlay API as the bookmaker filter and is also used as the local preference order.

## Current scope

- Username/password registration and login.
- Passwords require at least 10 characters, uppercase, lowercase, number, and symbol.
- Weekly entries are keyed to Monday UTC.
- Straight wagers, parlays, and round robins support up to 5 games.
- Round-robin max way count is 26 for 5 selected games.
- Settlement, AI training, and prize workflows are not scheduled yet.

## Settlement

Settle finalized MLB straight wagers:

```bash
npm run settle:mlb -- 2026-06-24 2026-06-24
```

Production compiled command:

```bash
npm run settle:mlb:prod -- 2026-06-24 2026-06-24
```

The settlement worker uses the public MLB Stats API and only settles pending MLB straight wagers when it can match an exact final game by date, away team, and home team. It credits wins, refunds pushes, records losses, and leaves unmatched or unfinished games pending.

## AI training data

Build labeled MLB AI training examples after games finish:

```bash
npm run ai:training -- 2026-06-24 2026-06-24
```

Production compiled command:

```bash
npm run ai:training:prod -- 2026-06-24 2026-06-24
```

The trainer stores official MLB final scores in `game_result`, grades each stored `ai_pick_candidate` against moneyline or runline rules, and writes normalized outcomes to `ai_training_example` with profit measured per $100 stake.

Evaluate the current AI heuristic against historical MLB lines:

```bash
npm run ai:evaluate -- --start=2026-03-25 --end=2026-05-12 --source=closing-odds --market=h2h --picks-per-day=3
npm run ai:evaluate -- --start=2026-03-25 --end=2026-05-12 --source=closing-odds --market=h2h --bookmaker=draftkings_an --picks-per-day=3
```

The evaluator simulates the current AI scorer against historical lines, selects the top N unique games per date, joins to unambiguous MLB results, and reports win rate, ROI, confidence buckets, side, price, source, bookmaker, and free MLB team-form splits. Team-form splits include selected-team advantage over the opponent in last-7 and last-14 win percentage and run differential per game. Initial 2026 moneyline baselines were slightly negative overall: all closing sources returned `115` evaluated picks at `-3.26%` ROI, and DraftKings-only returned `111` evaluated picks at `-2.07%` ROI. In the first DraftKings-only feature split, favorites were positive (`37` picks, `+9.74%` ROI) while underdogs were negative (`74` picks, `-7.97%` ROI), which is a candidate adjustment to validate before changing live picks.

Compare evaluation variants across major books:

```bash
npm run ai:compare -- --start=2026-03-25 --end=2026-05-12
```

The favorite-leaning variants are currently evaluator-only experiments. Initial cross-book validation did not support promoting them to live picks: `favorite-form-v1` improved DraftKings and FanDuel, but underperformed baseline on Fanatics, BetMGM, and Caesars. Keep live picks on the baseline scorer until a variant is robust across multiple books or a cleaner source policy is selected.

## Nightly automation

The production host runs `stakewars-nightly.timer` daily at `2:30am America/Chicago` with up to a 5-minute randomized delay. The timer launches `stakewars-nightly.service`, which:

- checks Parlay's free historical coverage endpoint and backfills newly available MLB historical dates only
- settles yesterday's MLB straight wagers
- builds AI training examples for yesterday
- publishes the next MLB AI picks

Check schedule and logs:

```bash
systemctl list-timers stakewars-nightly.timer --all
journalctl -u stakewars-nightly.service -n 200 --no-pager
```

Run manually if needed:

```bash
systemctl start stakewars-nightly.service
```

## Historical backfill

Backfill Parlay MLB historical responses and normalized historical lines:

```bash
npm run backfill:parlay -- --start=2026-04-13 --end=2026-05-12
```

Production compiled command:

```bash
npm run backfill:parlay:prod -- --start=2026-04-13 --end=2026-05-12
```

By default this pulls `matches`, `closing-odds`, and `odds`, stores raw responses in `parlay_historical_fetch`, normalizes game lines into `historical_game_line`, and writes completed scores into `game_result` from both Parlay rows that include scores and the MLB Stats API. MLB Stats API results store `gamePk` as `provider_game_id` so doubleheaders remain distinct. The 2026 MLB archive currently extends through `2026-05-12` per Parlay coverage, and the observed credit cost is 32 credits per date: 2 for `matches`, 10 for `closing-odds`, and 20 for `odds`.
