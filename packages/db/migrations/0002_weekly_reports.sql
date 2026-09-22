-- Milestone 16: weekly content intelligence.
--
-- A report is a stored artifact, not a view: the numbers it quotes must stay exactly as they were
-- when it was sent, even as later collection changes the underlying analytics.

CREATE TABLE IF NOT EXISTS weekly_reports (
  id             TEXT PRIMARY KEY,
  -- The reporting window, in the configured timezone, stored as UTC instants.
  period_start   TIMESTAMPTZ NOT NULL,
  period_end     TIMESTAMPTZ NOT NULL,
  timezone       TEXT NOT NULL,
  -- ISO week key (e.g. 2026-W39): the idempotency key for "this week's report".
  period_key     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'generated'
                   CHECK (status IN ('generated', 'delivered', 'failed')),
  generator_version TEXT NOT NULL,
  -- Counts, groupings, signals and suggestions: the whole report body, reproducible from the data.
  body           JSONB NOT NULL,
  delivered_at   TIMESTAMPTZ,
  delivery_error TEXT,
  correlation_id TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT weekly_reports_period_order CHECK (period_end > period_start)
);

-- One report per week per generator version: regenerating replaces the body rather than
-- accumulating near-identical reports, and a version bump produces a genuinely new report.
CREATE UNIQUE INDEX IF NOT EXISTS weekly_reports_period_key
  ON weekly_reports (period_key, generator_version);
CREATE INDEX IF NOT EXISTS weekly_reports_period_idx ON weekly_reports (period_start DESC);

DROP TRIGGER IF EXISTS weekly_reports_set_updated_at ON weekly_reports;
CREATE TRIGGER weekly_reports_set_updated_at
  BEFORE UPDATE ON weekly_reports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
