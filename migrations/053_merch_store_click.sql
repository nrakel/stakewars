CREATE TABLE IF NOT EXISTS merch_store_click (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  clicked_at timestamptz NOT NULL DEFAULT now(),
  destination_url text NOT NULL,
  source text NOT NULL,
  ip_address inet,
  user_agent text
);

CREATE INDEX IF NOT EXISTS merch_store_click_clicked_at_idx
  ON merch_store_click (clicked_at);

CREATE INDEX IF NOT EXISTS merch_store_click_user_idx
  ON merch_store_click (user_id, clicked_at);
