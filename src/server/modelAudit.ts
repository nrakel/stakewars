import { query } from "./db.js";

type AuditRow = {
  label: string;
  picks: string;
  wins: string;
  losses: string;
  pushes: string;
  winPct: string | null;
  netUnits: string;
  avgConfidence: string | null;
  avgEdge: string | null;
};

export type ChineModelAuditGroup = {
  label: string;
  picks: number;
  wins: number;
  losses: number;
  pushes: number;
  winPct: number | null;
  netUnits: number;
  avgConfidence: number | null;
  avgEdge: number | null;
};

export type ChineModelAudit = {
  generatedAt: string;
  since: string | null;
  through: string | null;
  summary: ChineModelAuditGroup[];
  confidenceBuckets: ChineModelAuditGroup[];
  markets: ChineModelAuditGroup[];
  reasons: ChineModelAuditGroup[];
  reasonCounts: ChineModelAuditGroup[];
  edgeRanges: ChineModelAuditGroup[];
  favoriteUnderdog: ChineModelAuditGroup[];
  homeRoad: ChineModelAuditGroup[];
  starterEdge: ChineModelAuditGroup[];
  bullpenEdge: ChineModelAuditGroup[];
  marketMovement: ChineModelAuditGroup[];
};

const mapRows = (rows: AuditRow[]): ChineModelAuditGroup[] => rows.map((row) => ({
  label: row.label,
  picks: Number(row.picks),
  wins: Number(row.wins),
  losses: Number(row.losses),
  pushes: Number(row.pushes),
  winPct: row.winPct === null ? null : Number(row.winPct),
  netUnits: Number(row.netUnits),
  avgConfidence: row.avgConfidence === null ? null : Number(row.avgConfidence),
  avgEdge: row.avgEdge === null ? null : Number(row.avgEdge)
}));

const baseSettledPicksSql = `
  WITH settled_picks AS (
    SELECT
      p.id,
      p.published_for,
      p.selected_team,
      p.confidence::numeric AS confidence,
      NULLIF(p.features #>> '{edge}', '')::numeric AS edge,
      p.reasons,
      p.features,
      COALESCE(wl.status::text, w.status::text) AS status,
      gl.market_key,
      gl.odds_american,
      gl.spread,
      gl.home_team,
      gl.away_team,
      CASE
        WHEN p.selected_team = gl.home_team THEN 'Home'
        WHEN p.selected_team = gl.away_team THEN 'Road'
        ELSE 'Other'
      END AS home_road,
      CASE
        WHEN gl.odds_american < 0 THEN 'Favorite'
        WHEN gl.odds_american > 0 THEN 'Underdog'
        ELSE 'Even'
      END AS favorite_underdog,
      CASE
        WHEN gl.odds_american > 0 THEN gl.odds_american::numeric / 100
        ELSE 100::numeric / abs(gl.odds_american)
      END AS win_profit_units
    FROM ai_pick p
    JOIN game_line gl ON gl.id = p.game_line_id
    LEFT JOIN wager w ON w.id = p.wager_id
    LEFT JOIN wager_leg wl ON wl.wager_id = w.id
      AND wl.game_line_id = p.game_line_id
      AND wl.selected_team = p.selected_team
    WHERE p.locked_at IS NOT NULL
      AND COALESCE(wl.status::text, w.status::text) IN ('won', 'lost', 'push', 'void')
      AND ($1::date IS NULL OR p.published_for >= $1::date)
      AND ($2::date IS NULL OR p.published_for <= $2::date)
  ),
  scored AS (
    SELECT
      *,
      CASE
        WHEN status = 'won' THEN win_profit_units
        WHEN status = 'lost' THEN -1::numeric
        ELSE 0::numeric
      END AS profit_units
    FROM settled_picks
  )
`;

const aggregateSql = (labelExpression: string, extraFrom = "") => `
  ${baseSettledPicksSql}
  SELECT
    ${labelExpression} AS label,
    count(*)::text AS picks,
    count(*) FILTER (WHERE status = 'won')::text AS wins,
    count(*) FILTER (WHERE status = 'lost')::text AS losses,
    count(*) FILTER (WHERE status IN ('push', 'void'))::text AS pushes,
    CASE
      WHEN count(*) FILTER (WHERE status IN ('won', 'lost')) = 0 THEN NULL
      ELSE round(
        (count(*) FILTER (WHERE status = 'won'))::numeric
        / nullif(count(*) FILTER (WHERE status IN ('won', 'lost')), 0),
        4
      )::text
    END AS "winPct",
    round(sum(profit_units), 4)::text AS "netUnits",
    round(avg(confidence), 4)::text AS "avgConfidence",
    round(avg(edge), 4)::text AS "avgEdge"
  FROM scored
  ${extraFrom}
  GROUP BY label
  ORDER BY count(*) DESC, label ASC
`;

const orderedAggregateSql = (labelExpression: string, orderExpression: string) => `
  ${baseSettledPicksSql}
  SELECT
    ${labelExpression} AS label,
    count(*)::text AS picks,
    count(*) FILTER (WHERE status = 'won')::text AS wins,
    count(*) FILTER (WHERE status = 'lost')::text AS losses,
    count(*) FILTER (WHERE status IN ('push', 'void'))::text AS pushes,
    CASE
      WHEN count(*) FILTER (WHERE status IN ('won', 'lost')) = 0 THEN NULL
      ELSE round(
        (count(*) FILTER (WHERE status = 'won'))::numeric
        / nullif(count(*) FILTER (WHERE status IN ('won', 'lost')), 0),
        4
      )::text
    END AS "winPct",
    round(sum(profit_units), 4)::text AS "netUnits",
    round(avg(confidence), 4)::text AS "avgConfidence",
    round(avg(edge), 4)::text AS "avgEdge",
    ${orderExpression} AS sort_order
  FROM scored
  GROUP BY label, sort_order
  ORDER BY sort_order ASC
`;

export const getChineModelAudit = async ({
  since = null,
  through = null
}: {
  since?: string | null;
  through?: string | null;
} = {}): Promise<ChineModelAudit> => {
  const params = [since, through];
  const [
    summary,
    confidenceBuckets,
    markets,
    reasons,
    reasonCounts,
    edgeRanges,
    favoriteUnderdog,
    homeRoad,
    starterEdge,
    bullpenEdge,
    marketMovement
  ] = await Promise.all([
    query<AuditRow>(aggregateSql("'All settled locked Chine picks'"), params),
    query<AuditRow>(orderedAggregateSql(
      `CASE
        WHEN confidence >= 0.80 THEN '80%+'
        WHEN confidence >= 0.77 THEN '77-79.9%'
        WHEN confidence >= 0.67 THEN '67-76.9%'
        WHEN confidence >= 0.57 THEN '57-66.9%'
        ELSE '<57%'
      END`,
      `CASE
        WHEN confidence >= 0.80 THEN 1
        WHEN confidence >= 0.77 THEN 2
        WHEN confidence >= 0.67 THEN 3
        WHEN confidence >= 0.57 THEN 4
        ELSE 5
      END`
    ), params),
    query<AuditRow>(aggregateSql(
      `CASE
        WHEN market_key = 'h2h' THEN 'Moneyline'
        WHEN market_key = 'spreads' THEN 'Runline/spread'
        WHEN market_key = 'totals' THEN 'Total'
        ELSE market_key::text
      END`
    ), params),
    query<AuditRow>(aggregateSql("reason", "CROSS JOIN LATERAL unnest(reasons) AS reason"), params),
    query<AuditRow>(orderedAggregateSql(
      `CASE
        WHEN cardinality(reasons) >= 12 THEN '12+ reasons'
        WHEN cardinality(reasons) >= 8 THEN '8-11 reasons'
        WHEN cardinality(reasons) >= 4 THEN '4-7 reasons'
        ELSE '0-3 reasons'
      END`,
      `CASE
        WHEN cardinality(reasons) >= 12 THEN 1
        WHEN cardinality(reasons) >= 8 THEN 2
        WHEN cardinality(reasons) >= 4 THEN 3
        ELSE 4
      END`
    ), params),
    query<AuditRow>(orderedAggregateSql(
      `CASE
        WHEN edge >= 0.08 THEN '8%+ edge'
        WHEN edge >= 0.05 THEN '5-7.9% edge'
        WHEN edge >= 0.025 THEN '2.5-4.9% edge'
        WHEN edge >= 0 THEN '0-2.4% edge'
        ELSE 'Negative edge'
      END`,
      `CASE
        WHEN edge >= 0.08 THEN 1
        WHEN edge >= 0.05 THEN 2
        WHEN edge >= 0.025 THEN 3
        WHEN edge >= 0 THEN 4
        ELSE 5
      END`
    ), params),
    query<AuditRow>(aggregateSql("favorite_underdog"), params),
    query<AuditRow>(aggregateSql("home_road"), params),
    query<AuditRow>(aggregateSql(
      `CASE
        WHEN reasons && ARRAY[
          'Starting pitcher ERA edge',
          'Adjusted starting pitcher ERA edge',
          'Starting pitcher traffic edge',
          'Starting pitcher command edge',
          'Dominant starting pitcher mismatch edge',
          'Recent starting pitcher ERA edge',
          'Recent starting pitcher command edge',
          '30-day starter swFIP edge',
          '30-day starter swxFIP edge',
          '30-day starter swSIERA edge',
          '30-day starter K-BB edge'
        ] THEN 'Starter edge present'
        ELSE 'No starter edge'
      END`
    ), params),
    query<AuditRow>(aggregateSql(
      `CASE
        WHEN reasons && ARRAY[
          'Bullpen freshness edge',
          'Recent bullpen ERA edge',
          'Yesterday bullpen workload edge',
          'Recent bullpen traffic edge',
          '30-day bullpen swFIP edge',
          '30-day bullpen swxFIP edge',
          '30-day bullpen swSIERA edge'
        ] THEN 'Bullpen edge present'
        ELSE 'No bullpen edge'
      END`
    ), params),
    query<AuditRow>(aggregateSql(
      `CASE
        WHEN reasons && ARRAY['Market movement toward pick', 'Market confirmation edge'] THEN 'Market moved with Chine'
        WHEN reasons && ARRAY['Market movement against pick', 'Market sanity cap for adverse line movement', 'Adverse market movement partly offset by model context'] THEN 'Market moved against Chine'
        ELSE 'No meaningful market movement'
      END`
    ), params)
  ]);

  return {
    generatedAt: new Date().toISOString(),
    since,
    through,
    summary: mapRows(summary.rows),
    confidenceBuckets: mapRows(confidenceBuckets.rows),
    markets: mapRows(markets.rows),
    reasons: mapRows(reasons.rows),
    reasonCounts: mapRows(reasonCounts.rows),
    edgeRanges: mapRows(edgeRanges.rows),
    favoriteUnderdog: mapRows(favoriteUnderdog.rows),
    homeRoad: mapRows(homeRoad.rows),
    starterEdge: mapRows(starterEdge.rows),
    bullpenEdge: mapRows(bullpenEdge.rows),
    marketMovement: mapRows(marketMovement.rows)
  };
};
