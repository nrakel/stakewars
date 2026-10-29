CREATE TABLE IF NOT EXISTS nfl_player_projection (
  id uuid PRIMARY KEY,
  pool_id uuid NOT NULL REFERENCES nfl_confidence_pool(id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES nfl_confidence_game(id) ON DELETE CASCADE,
  season integer NOT NULL,
  week integer NOT NULL,
  team text NOT NULL,
  opponent text NOT NULL,
  player_id text NOT NULL,
  player_name text NOT NULL,
  position text NOT NULL,
  role_rank integer NOT NULL,
  projected_stats jsonb NOT NULL,
  model_inputs jsonb NOT NULL,
  model_version text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (position IN ('QB', 'RB', 'WR', 'TE')),
  CHECK (role_rank > 0),
  UNIQUE (game_id, player_id)
);

CREATE INDEX IF NOT EXISTS nfl_player_projection_game_idx
  ON nfl_player_projection (game_id, team, position, role_rank);
