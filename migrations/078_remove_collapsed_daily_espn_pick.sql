DELETE FROM chine_daily_pick duplicate
USING chine_daily_pick canonical
WHERE duplicate.id <> canonical.id
  AND duplicate.game_key = 'espn'
  AND canonical.game_key LIKE 'espn:%'
  AND duplicate.pick_date = canonical.pick_date
  AND duplicate.sport = canonical.sport
  AND duplicate.away_team = canonical.away_team
  AND duplicate.home_team = canonical.home_team;
