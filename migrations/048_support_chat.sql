CREATE TABLE IF NOT EXISTS support_conversation (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN (
    'account_email',
    'rewards_eligibility',
    'picks_scoring',
    'technical_problem',
    'other'
  )),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE INDEX IF NOT EXISTS support_conversation_user_status_idx
  ON support_conversation (user_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS support_conversation_status_updated_idx
  ON support_conversation (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS support_message (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES support_conversation(id) ON DELETE CASCADE,
  sender_user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  sender_role text NOT NULL CHECK (sender_role IN ('user', 'admin')),
  body text NOT NULL CHECK (char_length(trim(body)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_message_conversation_created_idx
  ON support_message (conversation_id, created_at ASC);
