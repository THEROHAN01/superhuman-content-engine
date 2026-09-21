-- Runs once, on first initialization of an empty postgres volume.
-- Creates the separate n8n database so n8n's own tables never mix with application tables.
SELECT 'CREATE DATABASE n8n'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'n8n') \gexec

-- Application test database, used by the DB-backed test suite.
SELECT 'CREATE DATABASE sce_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'sce_test') \gexec
