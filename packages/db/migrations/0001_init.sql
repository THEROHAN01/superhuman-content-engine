-- Milestone 03: core schema.
-- Conventions:
--   * text primary keys with typed prefixes (le_, ca_, it_, ...)
--   * created_at/updated_at on every table, updated_at maintained by trigger
--   * status columns are TEXT + CHECK, mirroring packages/schemas/src/enums.ts
--   * every replayable operation has a UNIQUE constraint behind it

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum    TEXT NOT NULL
);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- learning events
CREATE TABLE IF NOT EXISTS learning_events (
  id              TEXT PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'received'
                    CHECK (status IN ('received','normalized','classified','atomized','duplicate','failed')),
  source          TEXT NOT NULL
                    CHECK (source IN ('http','telegram','notion','github','manual','seed')),
  external_id     TEXT,
  raw_text        TEXT NOT NULL CHECK (length(raw_text) > 0),
  normalized_text TEXT,
  title           TEXT,
  -- sha256 of the canonicalized note: the duplicate-capture guard
  content_hash    CHAR(64) NOT NULL,
  duplicate_of    TEXT REFERENCES learning_events(id) ON DELETE RESTRICT,
  classification  JSONB,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  context         JSONB NOT NULL DEFAULT '{}'::jsonb,
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  correlation_id  TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- a duplicate must point at something, and nothing may point at itself
  CONSTRAINT learning_events_duplicate_shape CHECK (
    (status = 'duplicate' AND duplicate_of IS NOT NULL) OR (status <> 'duplicate')
  ),
  CONSTRAINT learning_events_no_self_duplicate CHECK (duplicate_of IS DISTINCT FROM id)
);

-- Same note captured twice produces one event; the second capture returns the first.
CREATE UNIQUE INDEX IF NOT EXISTS learning_events_content_hash_key
  ON learning_events (content_hash) WHERE duplicate_of IS NULL;
-- Provider-side ids (telegram message, notion page) must also deduplicate.
CREATE UNIQUE INDEX IF NOT EXISTS learning_events_source_external_key
  ON learning_events (source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS learning_events_status_idx ON learning_events (status, captured_at DESC);
CREATE INDEX IF NOT EXISTS learning_events_correlation_idx ON learning_events (correlation_id);
CREATE INDEX IF NOT EXISTS learning_events_captured_at_idx ON learning_events (captured_at DESC);

-- ---------------------------------------------------------------- content atoms
CREATE TABLE IF NOT EXISTS content_atoms (
  id                TEXT PRIMARY KEY,
  schema_version    INTEGER NOT NULL DEFAULT 1,
  learning_event_id TEXT NOT NULL REFERENCES learning_events(id) ON DELETE RESTRICT,
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','enriched','ready','failed')),
  title             TEXT NOT NULL,
  kind              TEXT NOT NULL
                      CHECK (kind IN ('dsa','core_engineering','project_work','book_research','other')),
  primary_topic     TEXT NOT NULL
                      CHECK (primary_topic IN ('algorithms','system_design','backend','databases','distributed_systems','networking','security','performance','devops','observability','ai_ml','frontend','testing','career','product','other')),
  secondary_topics  TEXT[] NOT NULL DEFAULT '{}',
  entities          TEXT[] NOT NULL DEFAULT '{}',
  body              JSONB NOT NULL,
  evidence_status   TEXT NOT NULL DEFAULT 'pending'
                      CHECK (evidence_status IN ('not_required','pending','supported','partially_supported','unsupported','needs_review','research_failed')),
  confidence        REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  error             TEXT,
  generator_version TEXT NOT NULL,
  atomized_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One learning event yields exactly one canonical atom.
CREATE UNIQUE INDEX IF NOT EXISTS content_atoms_learning_event_key
  ON content_atoms (learning_event_id);
CREATE INDEX IF NOT EXISTS content_atoms_status_idx ON content_atoms (status, created_at DESC);
CREATE INDEX IF NOT EXISTS content_atoms_topic_idx ON content_atoms (primary_topic);

-- ---------------------------------------------------------------- evidence
CREATE TABLE IF NOT EXISTS source_documents (
  id                TEXT PRIMARY KEY,
  learning_event_id TEXT REFERENCES learning_events(id) ON DELETE RESTRICT,
  content_atom_id   TEXT REFERENCES content_atoms(id) ON DELETE RESTRICT,
  title             TEXT NOT NULL,
  url               TEXT NOT NULL,
  canonical_url     TEXT NOT NULL,
  source_type       TEXT NOT NULL
                      CHECK (source_type IN ('official_docs','rfc','paper','source_code','engineering_blog','book','video','other')),
  excerpt           TEXT,
  summary           TEXT,
  retrieved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider          TEXT NOT NULL,
  relevance         REAL CHECK (relevance IS NULL OR (relevance >= 0 AND relevance <= 1)),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT source_documents_owner CHECK (learning_event_id IS NOT NULL OR content_atom_id IS NOT NULL)
);

-- The same URL is attached to an atom once, however many searches return it.
CREATE UNIQUE INDEX IF NOT EXISTS source_documents_atom_url_key
  ON source_documents (content_atom_id, canonical_url) WHERE content_atom_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS source_documents_learning_event_idx ON source_documents (learning_event_id);

-- ---------------------------------------------------------------- ideas
CREATE TABLE IF NOT EXISTS content_ideas (
  id                TEXT PRIMARY KEY,
  content_atom_id   TEXT NOT NULL REFERENCES content_atoms(id) ON DELETE RESTRICT,
  learning_event_id TEXT NOT NULL REFERENCES learning_events(id) ON DELETE RESTRICT,
  status            TEXT NOT NULL DEFAULT 'proposed'
                      CHECK (status IN ('proposed','queued','rejected','used')),
  angle             TEXT NOT NULL
                      CHECK (angle IN ('insight','misconception','mental_model','implementation_lesson','failure_mode','project_story','checklist','comparison')),
  title             TEXT NOT NULL,
  rationale         TEXT NOT NULL,
  audience          TEXT NOT NULL,
  platforms         TEXT[] NOT NULL,
  formats           TEXT[] NOT NULL,
  hook              TEXT NOT NULL,
  evidence_required BOOLEAN NOT NULL DEFAULT false,
  -- canonicalized title+hook hash: re-running ideation cannot grow ideas without bound
  dedupe_hash       CHAR(64) NOT NULL,
  rejection_reason  TEXT,
  score             REAL CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
  prompt_version    TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS content_ideas_atom_dedupe_key
  ON content_ideas (content_atom_id, dedupe_hash);
CREATE INDEX IF NOT EXISTS content_ideas_status_idx ON content_ideas (status, created_at DESC);

-- ---------------------------------------------------------------- drafts
CREATE TABLE IF NOT EXISTS content_items (
  id                TEXT PRIMARY KEY,
  content_idea_id   TEXT NOT NULL REFERENCES content_ideas(id) ON DELETE RESTRICT,
  content_atom_id   TEXT NOT NULL REFERENCES content_atoms(id) ON DELETE RESTRICT,
  learning_event_id TEXT NOT NULL REFERENCES learning_events(id) ON DELETE RESTRICT,
  version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','gated','pending_approval','approved','rejected','scheduled','published','superseded','failed')),
  platform          TEXT NOT NULL CHECK (platform IN ('x','linkedin','instagram')),
  format            TEXT NOT NULL
                      CHECK (format IN ('x_post','x_thread','linkedin_post','reel_script','carousel')),
  draft             JSONB NOT NULL,
  quality_gate      JSONB,
  prompt_id         TEXT NOT NULL,
  prompt_version    TEXT NOT NULL,
  model             TEXT NOT NULL,
  superseded_by     TEXT REFERENCES content_items(id) ON DELETE SET NULL,
  error             TEXT,
  correlation_id    TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_items_no_self_supersede CHECK (superseded_by IS DISTINCT FROM id)
);

-- Regeneration creates version N+1; the same version is never generated twice.
CREATE UNIQUE INDEX IF NOT EXISTS content_items_idea_format_version_key
  ON content_items (content_idea_id, format, version);
CREATE INDEX IF NOT EXISTS content_items_status_idx ON content_items (status, created_at DESC);
CREATE INDEX IF NOT EXISTS content_items_atom_idx ON content_items (content_atom_id);
CREATE INDEX IF NOT EXISTS content_items_learning_event_idx ON content_items (learning_event_id);

-- ---------------------------------------------------------------- approvals
CREATE TABLE IF NOT EXISTS approvals (
  id                    TEXT PRIMARY KEY,
  content_item_id       TEXT NOT NULL REFERENCES content_items(id) ON DELETE RESTRICT,
  content_item_version  INTEGER NOT NULL,
  action                TEXT NOT NULL
                          CHECK (action IN ('approve','reject','regenerate','request_change','schedule_review')),
  -- stable id embedded in the approval button: a double-tap resolves to one decision
  action_id             TEXT NOT NULL,
  decided_by            TEXT NOT NULL,
  channel               TEXT NOT NULL DEFAULT 'telegram',
  note                  TEXT,
  external_callback_id  TEXT,
  decided_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  correlation_id        TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS approvals_action_id_key ON approvals (action_id);
CREATE UNIQUE INDEX IF NOT EXISTS approvals_external_callback_key
  ON approvals (channel, external_callback_id) WHERE external_callback_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS approvals_item_idx ON approvals (content_item_id, decided_at DESC);

-- ---------------------------------------------------------------- publications
CREATE TABLE IF NOT EXISTS publications (
  id                TEXT PRIMARY KEY,
  content_item_id   TEXT NOT NULL REFERENCES content_items(id) ON DELETE RESTRICT,
  learning_event_id TEXT NOT NULL REFERENCES learning_events(id) ON DELETE RESTRICT,
  platform          TEXT NOT NULL CHECK (platform IN ('x','linkedin','instagram')),
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','scheduled','published','failed','retry_pending','cancelled')),
  -- deterministic from (item, platform, scheduled_at): the duplicate-publication guard
  idempotency_key   CHAR(64) NOT NULL,
  provider          TEXT NOT NULL,
  external_id       TEXT,
  external_url      TEXT,
  scheduled_at      TIMESTAMPTZ NOT NULL,
  published_at      TIMESTAMPTZ,
  dry_run           BOOLEAN NOT NULL DEFAULT true,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  provider_metadata JSONB,
  correlation_id    TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT publications_published_needs_external_id CHECK (
    status <> 'published' OR dry_run OR external_id IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS publications_idempotency_key ON publications (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS publications_provider_external_key
  ON publications (provider, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS publications_status_schedule_idx ON publications (status, scheduled_at);
CREATE INDEX IF NOT EXISTS publications_item_idx ON publications (content_item_id);

-- ---------------------------------------------------------------- analytics
CREATE TABLE IF NOT EXISTS analytics_events (
  id                TEXT PRIMARY KEY,
  publication_id    TEXT NOT NULL REFERENCES publications(id) ON DELETE RESTRICT,
  content_item_id   TEXT NOT NULL REFERENCES content_items(id) ON DELETE RESTRICT,
  learning_event_id TEXT NOT NULL REFERENCES learning_events(id) ON DELETE RESTRICT,
  platform          TEXT NOT NULL CHECK (platform IN ('x','linkedin','instagram')),
  metric_window     TEXT NOT NULL CHECK (metric_window IN ('24h','7d','30d','lifetime')),
  collected_for     DATE NOT NULL,
  collected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider          TEXT NOT NULL,
  -- unknown metrics stay NULL inside this document; they are never coerced to 0
  metrics           JSONB NOT NULL,
  raw_payload       JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS analytics_events_collection_key
  ON analytics_events (publication_id, metric_window, collected_for);
CREATE INDEX IF NOT EXISTS analytics_events_item_idx ON analytics_events (content_item_id);
CREATE INDEX IF NOT EXISTS analytics_events_collected_idx ON analytics_events (collected_at DESC);

-- ---------------------------------------------------------------- operations
CREATE TABLE IF NOT EXISTS workflow_runs (
  id             TEXT PRIMARY KEY,
  workflow       TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('started','succeeded','failed')),
  correlation_id TEXT NOT NULL,
  subject_id     TEXT,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  duration_ms    INTEGER,
  input_summary  JSONB,
  output_summary JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflow_runs_correlation_idx ON workflow_runs (correlation_id);
CREATE INDEX IF NOT EXISTS workflow_runs_workflow_idx ON workflow_runs (workflow, started_at DESC);

CREATE TABLE IF NOT EXISTS error_events (
  id             TEXT PRIMARY KEY,
  workflow       TEXT NOT NULL,
  step           TEXT,
  kind           TEXT NOT NULL CHECK (kind IN ('transient','permanent')),
  code           TEXT NOT NULL,
  message        TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  subject_id     TEXT,
  details        JSONB,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS error_events_correlation_idx ON error_events (correlation_id);
CREATE INDEX IF NOT EXISTS error_events_occurred_idx ON error_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS error_events_workflow_idx ON error_events (workflow, occurred_at DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT PRIMARY KEY,
  job_type       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','succeeded','failed','dead')),
  dedupe_key     TEXT NOT NULL,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  run_after      TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 5,
  last_error     TEXT,
  locked_at      TIMESTAMPTZ,
  locked_by      TEXT,
  correlation_id TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enqueuing the same work twice while it is still outstanding is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_dedupe_key
  ON jobs (job_type, dedupe_key) WHERE status IN ('pending','running');
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs (status, run_after) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  delivery_id    TEXT NOT NULL,
  event_type     TEXT,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ,
  result         TEXT,
  correlation_id TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Providers redeliver webhooks; the second delivery must be recognised, not reprocessed.
CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_provider_delivery_key
  ON webhook_deliveries (provider, delivery_id);

-- ---------------------------------------------------------------- updated_at triggers
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'learning_events','content_atoms','source_documents','content_ideas','content_items',
    'approvals','publications','analytics_events','workflow_runs','error_events','jobs',
    'webhook_deliveries'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_set_updated_at ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t, t);
  END LOOP;
END $$;
