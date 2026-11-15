CREATE TABLE podcast_script (
  id uuid PRIMARY KEY,
  episode_date date NOT NULL UNIQUE,
  title text NOT NULL,
  transcript text NOT NULL,
  speech_text text NOT NULL,
  word_count integer NOT NULL CHECK (word_count > 0),
  pick_ids uuid[] NOT NULL DEFAULT '{}',
  model_id text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'published')),
  generated_at timestamptz NOT NULL DEFAULT now(),
  generated_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX podcast_script_episode_date_idx ON podcast_script (episode_date DESC);
