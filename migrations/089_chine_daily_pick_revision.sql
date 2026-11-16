CREATE TABLE IF NOT EXISTS chine_daily_pick_revision (
  id bigserial PRIMARY KEY,
  daily_pick_id uuid NOT NULL REFERENCES chine_daily_pick(id) ON DELETE CASCADE,
  changed_at timestamptz NOT NULL DEFAULT now(),
  previous_pick jsonb NOT NULL,
  replacement_pick jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS chine_daily_pick_revision_pick_idx
  ON chine_daily_pick_revision (daily_pick_id, changed_at DESC);

CREATE OR REPLACE FUNCTION audit_chine_daily_pick_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    OLD.game_line_id, OLD.away_team, OLD.home_team, OLD.starts_at,
    OLD.selected_team, OLD.market_key, OLD.spread, OLD.odds_american,
    OLD.confidence, OLD.model_version
  ) IS DISTINCT FROM ROW(
    NEW.game_line_id, NEW.away_team, NEW.home_team, NEW.starts_at,
    NEW.selected_team, NEW.market_key, NEW.spread, NEW.odds_american,
    NEW.confidence, NEW.model_version
  ) THEN
    INSERT INTO chine_daily_pick_revision (daily_pick_id, previous_pick, replacement_pick)
    VALUES (
      OLD.id,
      jsonb_build_object(
        'gameLineId', OLD.game_line_id,
        'awayTeam', OLD.away_team,
        'homeTeam', OLD.home_team,
        'startsAt', OLD.starts_at,
        'selectedTeam', OLD.selected_team,
        'marketKey', OLD.market_key,
        'spread', OLD.spread,
        'oddsAmerican', OLD.odds_american,
        'confidence', OLD.confidence,
        'modelVersion', OLD.model_version,
        'recordedAt', OLD.recorded_at
      ),
      jsonb_build_object(
        'gameLineId', NEW.game_line_id,
        'awayTeam', NEW.away_team,
        'homeTeam', NEW.home_team,
        'startsAt', NEW.starts_at,
        'selectedTeam', NEW.selected_team,
        'marketKey', NEW.market_key,
        'spread', NEW.spread,
        'oddsAmerican', NEW.odds_american,
        'confidence', NEW.confidence,
        'modelVersion', NEW.model_version,
        'recordedAt', NEW.recorded_at
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chine_daily_pick_revision_trigger ON chine_daily_pick;
CREATE TRIGGER chine_daily_pick_revision_trigger
AFTER UPDATE ON chine_daily_pick
FOR EACH ROW
EXECUTE FUNCTION audit_chine_daily_pick_revision();
