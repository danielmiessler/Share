-- One row per share. The file itself lives in R2 under the key `<slug>`; the name lives only here.
CREATE TABLE IF NOT EXISTS shares (
  slug       TEXT PRIMARY KEY,
  filename   TEXT NOT NULL,
  size       INTEGER NOT NULL,
  mime       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_shares_created_at ON shares (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shares_expires_at ON shares (expires_at) WHERE expires_at IS NOT NULL;
