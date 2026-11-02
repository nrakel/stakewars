import type pg from "pg";

type TeamMetric = {
  team: string;
  opponent: string;
  isHome: boolean;
  possessions: number;
  offensiveRating: number;
  defensiveRating: number;
  pace: number;
  playerMinutes: Record<string, number>;
};

const numberFromPair = (value: string | undefined, index: number) => {
  const parts = String(value ?? "").split("-");
  const parsed = Number(parts[index]);
  return Number.isFinite(parsed) ? parsed : 0;
};

const statValue = (team: any, name: string) =>
  String(team?.statistics?.find((stat: any) => stat.name === name)?.displayValue ?? "0");

const playerMinutes = (boxscore: any, teamName: string) => {
  const team = boxscore?.players?.find((entry: any) => entry.team?.displayName === teamName);
  const group = team?.statistics?.[0];
  const minuteIndex = group?.labels?.indexOf("MIN") ?? -1;
  if (minuteIndex < 0) return {};
  return Object.fromEntries((group.athletes ?? []).map((entry: any) => [
    entry.athlete?.displayName,
    Number.parseFloat(entry.stats?.[minuteIndex] ?? "0") || 0
  ]).filter(([name]: [string | undefined, number]) => Boolean(name)));
};

export const parseNbaSummaryMetrics = (summary: any): TeamMetric[] => {
  const competitors = summary?.header?.competitions?.[0]?.competitors ?? [];
  const scores = new Map(competitors.map((entry: any) => [entry.team?.displayName, Number(entry.score) || 0]));
  const teams = summary?.boxscore?.teams ?? [];
  if (teams.length !== 2) return [];
  const parsed: Array<{ name: string; possessions: number }> = teams.map((entry: any) => {
    const name = entry.team?.displayName as string;
    const fga = numberFromPair(statValue(entry, "fieldGoalsMade-fieldGoalsAttempted"), 1);
    const fta = numberFromPair(statValue(entry, "freeThrowsMade-freeThrowsAttempted"), 1);
    const orb = Number(statValue(entry, "offensiveRebounds")) || 0;
    const turnovers = Number(statValue(entry, "totalTurnovers")) || 0;
    return { name, possessions: fga - orb + turnovers + 0.44 * fta };
  });
  const sharedPace = parsed.reduce((sum: number, entry: { possessions: number }) => sum + entry.possessions, 0) / 2;
  return parsed.map((entry) => {
    const competitor = competitors.find((item: any) => item.team?.displayName === entry.name);
    const opponent = parsed.find((item) => item.name !== entry.name)?.name ?? "";
    const pointsFor = Number(scores.get(entry.name)) || 0;
    const pointsAgainst = Number(scores.get(opponent)) || 0;
    return {
      team: entry.name,
      opponent,
      isHome: competitor?.homeAway === "home",
      possessions: entry.possessions,
      offensiveRating: sharedPace > 0 ? pointsFor * 100 / sharedPace : 0,
      defensiveRating: sharedPace > 0 ? pointsAgainst * 100 / sharedPace : 0,
      pace: sharedPace,
      playerMinutes: playerMinutes(summary.boxscore, entry.name)
    };
  });
};

const fetchSummary = async (eventId: string) => {
  const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${encodeURIComponent(eventId)}`);
  if (!response.ok) throw new Error(`ESPN NBA summary ${response.status}`);
  return response.json();
};

const averageRecentMinutes = async (client: pg.PoolClient, team: string) => {
  const result = await client.query<{ player_minutes: Record<string, number> }>(`
    SELECT player_minutes FROM nba_team_game_metric
    WHERE team = $1 ORDER BY starts_on DESC LIMIT 10
  `, [team]);
  const totals = new Map<string, { total: number; games: number }>();
  for (const row of result.rows) {
    for (const [name, minutes] of Object.entries(row.player_minutes ?? {})) {
      const value = totals.get(name) ?? { total: 0, games: 0 };
      value.total += Number(minutes) || 0;
      value.games += 1;
      totals.set(name, value);
    }
  }
  return new Map([...totals].map(([name, value]) => [name, value.total / value.games]));
};

const upsertAvailability = async (client: pg.PoolClient, summary: any, eventKey: string, startsOn: string) => {
  for (const entry of summary?.injuries ?? []) {
    const team = entry.team?.displayName;
    if (!team) continue;
    const minutes = await averageRecentMinutes(client, team);
    let unavailableMinutes = 0;
    let questionableMinutes = 0;
    let unavailablePlayers = 0;
    let questionablePlayers = 0;
    const details = (entry.injuries ?? []).map((injury: any) => {
      const status = String(injury.status ?? injury.type?.description ?? "").toLowerCase();
      const name = String(injury.athlete?.displayName ?? "Unknown");
      const estimatedMinutes = minutes.get(name) ?? 0;
      if (/out|injured reserve|suspension/.test(status)) {
        unavailablePlayers += 1;
        unavailableMinutes += estimatedMinutes;
      } else if (/questionable|doubtful|day-to-day/.test(status)) {
        questionablePlayers += 1;
        questionableMinutes += estimatedMinutes;
      }
      return { name, status, estimatedMinutes };
    });
    await client.query(`
      INSERT INTO nba_event_availability (
        event_key, starts_on, team, unavailable_players, questionable_players,
        unavailable_rotation_minutes, questionable_rotation_minutes, details, fetched_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
      ON CONFLICT (event_key, team) DO UPDATE SET
        unavailable_players = EXCLUDED.unavailable_players,
        questionable_players = EXCLUDED.questionable_players,
        unavailable_rotation_minutes = EXCLUDED.unavailable_rotation_minutes,
        questionable_rotation_minutes = EXCLUDED.questionable_rotation_minutes,
        details = EXCLUDED.details,
        fetched_at = now()
    `, [eventKey, startsOn, team, unavailablePlayers, questionablePlayers,
      unavailableMinutes, questionableMinutes, JSON.stringify(details)]);
  }
};

export const refreshNbaContext = async (
  client: pg.PoolClient,
  games: Array<{ providerGameId: string; startsOn: string }>,
  upcomingDates: string[]
) => {
  const stale = await client.query<{ provider_game_id: string; starts_on: string }>(`
    SELECT input.provider_game_id, input.starts_on
    FROM jsonb_to_recordset($1::jsonb) AS input(provider_game_id text, starts_on text)
    LEFT JOIN nba_team_game_metric metric ON metric.provider_game_id = input.provider_game_id
    WHERE metric.provider_game_id IS NULL
    LIMIT 240
  `, [JSON.stringify([...games].reverse().map((game) => ({ provider_game_id: game.providerGameId, starts_on: game.startsOn })))]);

  for (let index = 0; index < stale.rows.length; index += 8) {
    const summaries = await Promise.all(stale.rows.slice(index, index + 8).map(async (game) => {
      try {
        return { game, summary: await fetchSummary(game.provider_game_id) };
      } catch (error) {
        console.warn("NBA context box score refresh failed", game.provider_game_id, error);
        return null;
      }
    }));
    for (const loaded of summaries) {
      if (!loaded) continue;
      const { game, summary } = loaded;
      try {
        for (const metric of parseNbaSummaryMetrics(summary)) {
          await client.query(`
            INSERT INTO nba_team_game_metric (
              provider_game_id, starts_on, team, opponent, is_home, possessions,
              offensive_rating, defensive_rating, pace, player_minutes, fetched_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,now())
            ON CONFLICT (provider_game_id, team) DO UPDATE SET
              possessions=EXCLUDED.possessions, offensive_rating=EXCLUDED.offensive_rating,
              defensive_rating=EXCLUDED.defensive_rating, pace=EXCLUDED.pace,
              player_minutes=EXCLUDED.player_minutes, fetched_at=now()
          `, [game.provider_game_id, game.starts_on, metric.team, metric.opponent, metric.isHome,
            metric.possessions, metric.offensiveRating, metric.defensiveRating, metric.pace,
            JSON.stringify(metric.playerMinutes)]);
        }
      } catch (error) {
        console.warn("NBA context box score persistence failed", game.provider_game_id, error);
      }
    }
  }

  const scoreboardDates = new Set<string>();
  for (const date of upcomingDates) {
    scoreboardDates.add(date);
    const previous = new Date(`${date}T00:00:00Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    scoreboardDates.add(previous.toISOString().slice(0, 10));
  }
  for (const scoreboardDate of scoreboardDates) {
    try {
      const scoreboard: any = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${scoreboardDate.replaceAll("-", "")}`).then((response) => response.json());
      for (const event of scoreboard.events ?? []) {
        const cached = await client.query(`
          SELECT 1 FROM nba_event_availability WHERE event_key=$1 AND fetched_at > now() - interval '30 minutes' LIMIT 1
        `, [event.id]);
        if (cached.rowCount) continue;
        const summary = await fetchSummary(event.id);
        const eventStartsOn = new Date(event.date).toISOString().slice(0, 10);
        await upsertAvailability(client, summary, event.id, eventStartsOn);
      }
    } catch (error) {
      console.warn("NBA context availability refresh failed", scoreboardDate, error);
    }
  }
};
