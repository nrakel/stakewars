ALTER TABLE podcast_script
  ADD COLUMN audio_path text,
  ADD COLUMN audio_generated_at timestamptz,
  ADD COLUMN audio_character_count integer,
  ADD COLUMN audio_model_id text,
  ADD COLUMN audio_intro_version text;
