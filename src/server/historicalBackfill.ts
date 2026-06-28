import { randomUUID, createHash } from "node:crypto";
import type pg from "pg";
import { config } from "./config.js";
import { transaction } from "./db.js";
import { fetchMlbFinals, type FinalGame } from "./settlement.js";
import { upsertMlbResult } from "./training.js";

type HistoricalEndpoint = "matches" | "odds" | "closing-odds";

type BackfillOptions = {
  sport?: "MLB";
  sportKey?: "baseball_mlb";
  startDate: string;
  endDate: string;
  endpoints?: HistoricalEndpoint[];
  dryRun?: boolean;
};

type ParlayOutcome = {
  name?: string;
  price?: number | null;
  point?: number | null;
};

type ParlayMarket = {
  key?: string;
  outcomes?: ParlayOutcome[];
};

type ParlayBookmaker = {
  key?: string;
  title?: string;
  markets?: ParlayMarket[];
};

type ParlayHistoricalEvent = {
  id?: string;
  canonical_event_id?: string;
  sport_key?: string;
  sport_title?: string;
  commence_time?: string;
  game_date?: string;
  home_team?: string;
  away_team?: string;
  source?: string;
  bookmaker?: string;
  home_score?: number | null;
  away_score?: number | null;
  home_odds?: number | null;
  away_odds?: number | null;
  market_key?: string;
  odds?: {
    home_ml?: number | null;
    away_ml?: number | null;
  };
  bookmakers?: ParlayBookmaker[];
};

type NormalizedHistoricalLine = {
  providerEventId: string | null;
  startsAt: string;
  startsOn: string;
  homeTeam: string;
  awayTeam: string;
  bookmakerKey: string;
  marketKey: "h2h" | "spreads";
  selectedTeam: string;
  spread: number;
  oddsAmerican: number;
  rawPayload: unknown;
};

const endpointCredits: Record<HistoricalEndpoint, number> = {
  matches: 2,
  odds: 20,
  "closing-odds": 10
};

const yyyyMmDd = (date: Date) => date.toISOString().slice(0, 10);

const addDays = (date: Date, days: number) => {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
};

export const dateRange = (startDate: string, endDate: string) => {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const dates: string[] = [];

  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    dates.push(yyyyMmDd(cursor));
  }

  return dates;
};

const requestHash = (value: unknown) => {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
};

const responseRows = (body: unknown): ParlayHistoricalEvent[] => {
  if (Array.isArray(body)) {
    return body as ParlayHistoricalEvent[];
  }
  if (body && typeof body === "object") {
    const object = body as Record<string, unknown>;
    for (const key of ["data", "results", "events", "matches"]) {
      if (Array.isArray(object[key])) {
        return object[key] as ParlayHistoricalEvent[];
      }
    }
  }
  return [];
};

const fetchHistorical = async (sportKey: string, endpoint: HistoricalEndpoint, date: string) => {
  if (!config.parlayApiKey) {
    throw new Error("PARLAY_API_KEY is not configured");
  }

  const base = config.parlayApiBaseUrl.replace(/\/$/, "");
  const url = new URL(`${base}/historical/sports/${sportKey}/${endpoint}`);
  url.searchParams.set("date", date);

  if (endpoint === "matches") {
    url.searchParams.set("pricedOnly", "true");
  } else {
    url.searchParams.set("regions", "us");
    url.searchParams.set("markets", "h2h,spreads");
    url.searchParams.set("oddsFormat", "american");
    url.searchParams.set("dateFormat", "iso");
  }

  const params = Object.fromEntries(url.searchParams.entries());
  const response = await fetch(url, {
    headers: { "X-API-Key": config.parlayApiKey }
  });
  const text = await response.text();
  let payload: unknown = text;

  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  return {
    statusCode: response.status,
    ok: response.ok,
    params,
    payload,
    creditsCharged: Number(response.headers.get("x-requests-last") ?? endpointCredits[endpoint]),
    requestsRemaining: response.headers.get("x-requests-remaining"),
    rows: response.ok ? responseRows(payload) : [],
    error: response.ok ? null : text.slice(0, 500)
  };
};

const eventDate = (event: ParlayHistoricalEvent) => {
  if (event.commence_time) {
    return yyyyMmDd(new Date(event.commence_time));
  }
  return event.game_date ?? null;
};

const normalizeBookmakerEvents = (event: ParlayHistoricalEvent, sourceEndpoint: HistoricalEndpoint) => {
  const lines: NormalizedHistoricalLine[] = [];
  if (!event.home_team || !event.away_team || !event.commence_time) {
    return lines;
  }

  for (const bookmaker of event.bookmakers ?? []) {
    if (!bookmaker.key) {
      continue;
    }

    for (const market of bookmaker.markets ?? []) {
      if (market.key !== "h2h" && market.key !== "spreads") {
        continue;
      }

      for (const outcome of market.outcomes ?? []) {
        if (
          !outcome.name
          || ![event.home_team, event.away_team].includes(outcome.name)
          || typeof outcome.price !== "number"
        ) {
          continue;
        }

        if (market.key === "spreads" && typeof outcome.point !== "number") {
          continue;
        }

        lines.push({
          providerEventId: event.canonical_event_id ?? event.id ?? null,
          startsAt: event.commence_time,
          startsOn: yyyyMmDd(new Date(event.commence_time)),
          homeTeam: event.home_team,
          awayTeam: event.away_team,
          bookmakerKey: bookmaker.key,
          marketKey: market.key,
          selectedTeam: outcome.name,
          spread: market.key === "spreads" ? outcome.point! : 0,
          oddsAmerican: outcome.price,
          rawPayload: { event, bookmaker, market, outcome, sourceEndpoint }
        });
      }
    }
  }

  return lines;
};

const normalizeMatchRows = (event: ParlayHistoricalEvent) => {
  const lines: NormalizedHistoricalLine[] = [];
  const startsOn = eventDate(event);
  if (!event.home_team || !event.away_team || !startsOn || !event.source || !event.odds) {
    return lines;
  }

  const startsAt = `${startsOn}T00:00:00Z`;
  if (typeof event.odds.home_ml === "number") {
    lines.push({
      providerEventId: null,
      startsAt,
      startsOn,
      homeTeam: event.home_team,
      awayTeam: event.away_team,
      bookmakerKey: event.source,
      marketKey: "h2h",
      selectedTeam: event.home_team,
      spread: 0,
      oddsAmerican: event.odds.home_ml,
      rawPayload: event
    });
  }
  if (typeof event.odds.away_ml === "number") {
    lines.push({
      providerEventId: null,
      startsAt,
      startsOn,
      homeTeam: event.home_team,
      awayTeam: event.away_team,
      bookmakerKey: event.source,
      marketKey: "h2h",
      selectedTeam: event.away_team,
      spread: 0,
      oddsAmerican: event.odds.away_ml,
      rawPayload: event
    });
  }

  return lines;
};

const normalizeClosingRows = (event: ParlayHistoricalEvent) => {
  const lines: NormalizedHistoricalLine[] = [];
  const startsOn = eventDate(event);
  const bookmakerKey = event.bookmaker ?? event.source;
  if (!event.home_team || !event.away_team || !startsOn || !bookmakerKey || event.market_key !== "h2h") {
    return lines;
  }

  const startsAt = event.commence_time ?? `${startsOn}T00:00:00Z`;
  if (typeof event.home_odds === "number") {
    lines.push({
      providerEventId: null,
      startsAt,
      startsOn,
      homeTeam: event.home_team,
      awayTeam: event.away_team,
      bookmakerKey,
      marketKey: "h2h",
      selectedTeam: event.home_team,
      spread: 0,
      oddsAmerican: event.home_odds,
      rawPayload: event
    });
  }
  if (typeof event.away_odds === "number") {
    lines.push({
      providerEventId: null,
      startsAt,
      startsOn,
      homeTeam: event.home_team,
      awayTeam: event.away_team,
      bookmakerKey,
      marketKey: "h2h",
      selectedTeam: event.away_team,
      spread: 0,
      oddsAmerican: event.away_odds,
      rawPayload: event
    });
  }

  return lines;
};

const normalizeHistoricalLines = (endpoint: HistoricalEndpoint, rows: ParlayHistoricalEvent[]) => {
  if (endpoint === "matches") {
    return rows.flatMap(normalizeMatchRows);
  }
  if (endpoint === "closing-odds") {
    return rows.flatMap(normalizeClosingRows);
  }
  return rows.flatMap((event) => normalizeBookmakerEvents(event, endpoint));
};

type HistoricalResultRow = {
  startsOn: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
};

const uniqueResultRows = (rows: ParlayHistoricalEvent[]) => {
  const resultMap = new Map<string, HistoricalResultRow>();

  for (const row of rows) {
    const startsOn = eventDate(row);
    if (
      !startsOn
      || !row.home_team
      || !row.away_team
      || typeof row.home_score !== "number"
      || typeof row.away_score !== "number"
    ) {
      continue;
    }

    resultMap.set(`${startsOn}:${row.away_team}:${row.home_team}`, {
      startsOn,
      homeTeam: row.home_team,
      awayTeam: row.away_team,
      homeScore: row.home_score,
      awayScore: row.away_score
    });
  }

  return [...resultMap.values()];
};

const upsertResultRow = async (
  client: pg.PoolClient,
  sport: "MLB",
  resultRow: HistoricalResultRow,
  source: "parlay-api-historical" | "mlb-stats-api"
) => {
  const before = await client.query<{ id: string }>(
    `
      SELECT id
      FROM game_result
      WHERE sport = $1
        AND starts_on = $2
        AND away_team = $3
        AND home_team = $4
        AND source = $5
      LIMIT 1
    `,
    [sport, resultRow.startsOn, resultRow.awayTeam, resultRow.homeTeam, source]
  );
  await upsertMlbResult(client, {
    startsOn: resultRow.startsOn,
    awayTeam: resultRow.awayTeam,
    homeTeam: resultRow.homeTeam,
    awayScore: resultRow.awayScore,
    homeScore: resultRow.homeScore
  }, source);

  return !before.rowCount;
};

const finalToResultRow = (game: FinalGame): HistoricalResultRow => ({
  startsOn: game.startsOn,
  homeTeam: game.homeTeam,
  awayTeam: game.awayTeam,
  homeScore: game.homeScore,
  awayScore: game.awayScore
});

export const backfillParlayMlbHistory = async ({
  sport = "MLB",
  sportKey = "baseball_mlb",
  startDate,
  endDate,
  endpoints = ["matches", "closing-odds", "odds"],
  dryRun = false
}: BackfillOptions) => {
  const dates = dateRange(startDate, endDate);
  const summary = {
    sport,
    sportKey,
    dateRange: { startDate, endDate },
    dryRun,
    estimatedCredits: dates.length * endpoints.reduce((total, endpoint) => total + endpointCredits[endpoint], 0),
    actualCredits: 0,
    statsApiFinals: 0,
    fetches: [] as Array<{
      date: string;
      endpoint: HistoricalEndpoint;
      statusCode: number;
      rowCount: number;
      normalizedLines: number;
      creditsCharged: number;
      requestsRemaining: string | null;
      error: string | null;
    }>,
    linesInserted: 0,
    linesUpdated: 0,
    resultsInserted: 0,
    resultsUpdated: 0
  };

  const statsApiFinals = await fetchMlbFinals(startDate, endDate);
  summary.statsApiFinals = statsApiFinals.length;

  if (!dryRun) {
    await transaction(async (client) => {
      for (const final of statsApiFinals) {
        const before = final.providerGameId
          ? await client.query("SELECT 1 FROM game_result WHERE source = 'mlb-stats-api' AND provider_game_id = $1 LIMIT 1", [final.providerGameId])
          : await client.query(
            "SELECT 1 FROM game_result WHERE sport = $1 AND starts_on = $2 AND away_team = $3 AND home_team = $4 AND source = 'mlb-stats-api' LIMIT 1",
            [sport, final.startsOn, final.awayTeam, final.homeTeam]
          );
        await upsertMlbResult(client, final);
        if (!before.rowCount) {
          summary.resultsInserted += 1;
        } else {
          summary.resultsUpdated += 1;
        }
      }
    });
  }

  for (const targetDate of dates) {
    for (const endpoint of endpoints) {
      const fetched = await fetchHistorical(sportKey, endpoint, targetDate);
      const normalizedLines = fetched.ok ? normalizeHistoricalLines(endpoint, fetched.rows) : [];
      summary.actualCredits += fetched.creditsCharged;
      summary.fetches.push({
        date: targetDate,
        endpoint,
        statusCode: fetched.statusCode,
        rowCount: fetched.rows.length,
        normalizedLines: normalizedLines.length,
        creditsCharged: fetched.creditsCharged,
        requestsRemaining: fetched.requestsRemaining,
        error: fetched.error
      });

      if (dryRun) {
        continue;
      }

      await transaction(async (client) => {
        const requestIdentity = {
          sportKey,
          endpoint,
          targetDate,
          params: fetched.params
        };
        const requestKey = requestHash(requestIdentity);

        await client.query(
          `
            INSERT INTO parlay_historical_fetch (
              id, sport, sport_key, endpoint, target_date, request_key, request_params,
              status_code, row_count, credits_estimated, payload, error, fetched_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
            ON CONFLICT (request_key)
            DO UPDATE SET
              status_code = EXCLUDED.status_code,
              row_count = EXCLUDED.row_count,
              credits_estimated = EXCLUDED.credits_estimated,
              payload = EXCLUDED.payload,
              error = EXCLUDED.error,
              fetched_at = now()
          `,
          [
            randomUUID(),
            sport,
            sportKey,
            endpoint,
            targetDate,
            requestKey,
            JSON.stringify(fetched.params),
            fetched.statusCode,
            fetched.rows.length,
            endpointCredits[endpoint],
            JSON.stringify(fetched.payload),
            fetched.error
          ]
        );

        for (const resultRow of uniqueResultRows(fetched.rows)) {
          const inserted = await upsertResultRow(client, sport, resultRow, "parlay-api-historical");
          if (inserted) {
            summary.resultsInserted += 1;
          } else {
            summary.resultsUpdated += 1;
          }
        }

        for (const line of normalizedLines) {
          const result = await client.query<{ inserted: boolean }>(
            `
              INSERT INTO historical_game_line (
                id, sport, sport_key, provider_event_id, starts_at, starts_on,
                home_team, away_team, bookmaker_key, market_key, selected_team,
                spread, odds_american, source_endpoint, raw_payload, fetched_at
              )
              VALUES (
                $1, $2, $3, $4, $5, $6,
                $7, $8, $9, $10, $11,
                $12, $13, $14, $15, now()
              )
              ON CONFLICT (
                sport_key, COALESCE(provider_event_id, ''), starts_at, bookmaker_key,
                market_key, selected_team, spread, source_endpoint
              )
              DO UPDATE SET
                odds_american = EXCLUDED.odds_american,
                raw_payload = EXCLUDED.raw_payload,
                fetched_at = now()
              RETURNING (xmax = 0) AS inserted
            `,
            [
              randomUUID(),
              sport,
              sportKey,
              line.providerEventId,
              line.startsAt,
              line.startsOn,
              line.homeTeam,
              line.awayTeam,
              line.bookmakerKey,
              line.marketKey,
              line.selectedTeam,
              line.spread,
              line.oddsAmerican,
              endpoint,
              JSON.stringify(line.rawPayload)
            ]
          );

          if (result.rows[0]?.inserted) {
            summary.linesInserted += 1;
          } else {
            summary.linesUpdated += 1;
          }
        }
      });
    }
  }

  return summary;
};
