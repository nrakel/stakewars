import { query, transaction } from "./db.js";

const fredSeriesUrl = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=SP500";

export type Sp500Observation = {
  date: string;
  value: number;
};

export const parseFredSp500Csv = (csv: string): Sp500Observation[] => csv
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((line) => {
    const [date, rawValue] = line.split(",");
    return { date: date?.trim() ?? "", value: Number(rawValue) };
  })
  .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.value) && row.value > 0)
  .sort((left, right) => left.date.localeCompare(right.date));

export const selectBenchmarkStart = (observations: Sp500Observation[], inceptionDate: string) => {
  const prior = observations.filter((row) => row.date <= inceptionDate).at(-1);
  return prior ?? observations.find((row) => row.date >= inceptionDate) ?? null;
};

const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const centralDate = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const fetchSp500Observations = async (startDate: string, throughDate: string) => {
  const url = new URL(fredSeriesUrl);
  url.searchParams.set("cosd", startDate);
  url.searchParams.set("coed", throughDate);
  const response = await fetch(url, {
    headers: { accept: "text/csv", "user-agent": "StakeWars/1.0 support@stakewars.ai" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) {
    throw new Error(`FRED S&P 500 refresh failed with ${response.status}`);
  }
  const observations = parseFredSp500Csv(await response.text());
  if (!observations.length) {
    throw new Error("FRED S&P 500 refresh returned no valid observations");
  }
  return observations;
};

export const refreshChineSp500Benchmarks = async () => {
  const inception = await query<{ sport: string; firstWagerDate: string }>(`
    SELECT gl.sport::text AS sport, min(p.published_for)::text AS "firstWagerDate"
    FROM ai_pick p
    JOIN game_line gl ON gl.id = p.game_line_id
    WHERE p.locked_at IS NOT NULL
      AND p.wager_id IS NOT NULL
    GROUP BY gl.sport::text
    ORDER BY sport
  `);
  if (!inception.rows.length) {
    return { refreshed: 0, throughDate: null };
  }

  const overallDate = inception.rows.reduce(
    (earliest, row) => row.firstWagerDate < earliest ? row.firstWagerDate : earliest,
    inception.rows[0].firstWagerDate
  );
  const periods = [{ sport: "OVERALL", firstWagerDate: overallDate }, ...inception.rows];
  const throughDate = centralDate();
  const observations = await fetchSp500Observations(addDays(overallDate, -10), throughDate);
  const latest = observations.at(-1)!;

  await transaction(async (client) => {
    for (const period of periods) {
      const start = selectBenchmarkStart(observations, period.firstWagerDate);
      if (!start) {
        throw new Error(`No S&P 500 observation available for ${period.sport} inception ${period.firstWagerDate}`);
      }
      const roi = (latest.value - start.value) / start.value;
      await client.query(`
        INSERT INTO chine_sp500_benchmark (
          benchmark_key, first_wager_date, benchmark_start_date, benchmark_start_value,
          benchmark_through_date, benchmark_through_value, benchmark_roi, source, refreshed_at
        )
        VALUES ($1, $2::date, $3::date, $4, $5::date, $6, $7, $8, now())
        ON CONFLICT (benchmark_key) DO UPDATE SET
          first_wager_date = EXCLUDED.first_wager_date,
          benchmark_start_date = EXCLUDED.benchmark_start_date,
          benchmark_start_value = EXCLUDED.benchmark_start_value,
          benchmark_through_date = EXCLUDED.benchmark_through_date,
          benchmark_through_value = EXCLUDED.benchmark_through_value,
          benchmark_roi = EXCLUDED.benchmark_roi,
          source = EXCLUDED.source,
          refreshed_at = now()
      `, [
        period.sport, period.firstWagerDate, start.date, start.value,
        latest.date, latest.value, roi, "FRED SP500 daily close"
      ]);
    }
  });

  return {
    refreshed: periods.length,
    throughDate: latest.date,
    benchmarks: periods.map((period) => {
      const start = selectBenchmarkStart(observations, period.firstWagerDate)!;
      return {
        key: period.sport,
        firstWagerDate: period.firstWagerDate,
        startDate: start.date,
        throughDate: latest.date,
        roi: (latest.value - start.value) / start.value
      };
    })
  };
};

