CREATE UNIQUE INDEX IF NOT EXISTS game_line_provider_source_idx
  ON game_line (provider_event_id, source)
  WHERE provider_event_id IS NOT NULL;
