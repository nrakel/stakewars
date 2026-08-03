UPDATE survivor_pool
SET starts_on = '2026-09-07'::date
WHERE season = 2026
  AND name = 'StakeWars NFL Survivor'
  AND starts_on < '2026-09-07'::date;
