CREATE TABLE IF NOT EXISTS support_sessions (
  session_id TEXT PRIMARY KEY,
  visitor_id TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  short_label TEXT,
  fingerprint TEXT,
  ip_hash TEXT,
  locale TEXT,
  user_agent TEXT,
  viewport TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_message_at TEXT NOT NULL,
  last_message_preview TEXT,
  unread_operator_count INTEGER NOT NULL DEFAULT 0,
  unread_visitor_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS support_messages (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('visitor', 'support', 'system')),
  author_label TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'web',
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES support_sessions (session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_support_sessions_last_message
  ON support_sessions (last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_messages_session_created
  ON support_messages (session_id, created_at);
