-- Taskly example schema + seed data (MySQL port of seed.pg.sql — same tables, same rows).
-- Relationships are real foreign keys here — Graphoria introspects them into the
-- API graph automatically. The exception is task_tags, which carries no FKs; its
-- relationships (from tasks, and to tags) stay declared in graphoria.ts to
-- demonstrate the config-declared relationships feature.
--
-- Dialect notes vs the PostgreSQL file:
--   * AUTO_INCREMENT replaces IDENTITY and self-advances past the explicit seed
--     ids, so there is no setval() block.
--   * TIMESTAMP replaces timestamptz (both are timezone-aware, stored as UTC).
--   * INSERT IGNORE replaces ON CONFLICT DO NOTHING.
--   * FKs use table-level syntax: MySQL silently ignores column-level REFERENCES.
--   * project_stats is a PROCEDURE, not a function — Graphoria's MySQL engine
--     invokes stored procedures with CALL.
--   * task_age_days is declared DETERMINISTIC (it isn't, but MySQL's binary log
--     refuses non-deterministic functions from unprivileged creators; PG's
--     STABLE has no exact equivalent).
--   * No routine has a BEGIN...END body, so the file also works when executed
--     one statement at a time (split on ';') — no DELIMITER games needed.

CREATE TABLE IF NOT EXISTS organizations (
  id         int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name       varchar(255) NOT NULL,
  slug       varchar(255) NOT NULL,
  plan       varchar(32)  NOT NULL DEFAULT 'free',   -- free | pro | enterprise
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
  id          int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id      int NOT NULL,
  owner       varchar(255) NOT NULL,                 -- auth.user.username
  name        varchar(255) NOT NULL,
  description text,
  visibility  varchar(16) NOT NULL DEFAULT 'org',    -- private | org | public
  status      varchar(32) NOT NULL DEFAULT 'active',
  created_at  timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT projects_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations (id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id          int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id      int NOT NULL,                          -- denormalized → one-liner RBAC row filters
  project_id  int NOT NULL,
  assignee    varchar(255),                          -- auth.user.username
  created_by  varchar(255) NOT NULL,
  title       varchar(255) NOT NULL,
  description text,
  status      varchar(32) NOT NULL DEFAULT 'todo',   -- todo | in_progress | done
  priority    int NOT NULL DEFAULT 3,                -- 1..5
  due_date    timestamp NULL DEFAULT NULL,
  created_at  timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT tasks_org_id_fkey     FOREIGN KEY (org_id)     REFERENCES organizations (id),
  CONSTRAINT tasks_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects (id)
);

CREATE TABLE IF NOT EXISTS comments (
  id         int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id     int NOT NULL,
  task_id    int NOT NULL,
  author     varchar(255) NOT NULL,
  body       text NOT NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT comments_org_id_fkey  FOREIGN KEY (org_id)  REFERENCES organizations (id),
  CONSTRAINT comments_task_id_fkey FOREIGN KEY (task_id) REFERENCES tasks (id)
);

CREATE TABLE IF NOT EXISTS tags (
  id     int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id int NOT NULL,
  name   varchar(255) NOT NULL,
  color  varchar(16)  NOT NULL DEFAULT '#888888',
  CONSTRAINT tags_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations (id)
);

-- Intentionally FK-free: task_tags' relationships (from tasks, to tags) are
-- declared in graphoria.ts to demonstrate config-declared relationships.
CREATE TABLE IF NOT EXISTS task_tags (
  task_id int NOT NULL,
  tag_id  int NOT NULL,
  PRIMARY KEY (task_id, tag_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id     int NOT NULL,
  actor      varchar(255) NOT NULL,
  action     varchar(255) NOT NULL,
  entity     varchar(255) NOT NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT audit_log_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations (id)
);

-- Function backing the `age_days` virtual column. DROP + CREATE because MySQL
-- has no CREATE OR REPLACE FUNCTION.
DROP FUNCTION IF EXISTS task_age_days;
CREATE FUNCTION task_age_days(ts timestamp)
RETURNS int DETERMINISTIC
RETURN GREATEST(0, DATEDIFF(NOW(), ts));

-- Stored procedure exposed via the `storedProcedures` permission key. A
-- PROCEDURE (not a FUNCTION): Graphoria's MySQL engine invokes these with CALL.
DROP PROCEDURE IF EXISTS project_stats;
CREATE PROCEDURE project_stats(IN p_project_id int)
SELECT
  COUNT(CASE WHEN status = 'todo'        THEN 1 END) AS open_count,
  COUNT(CASE WHEN status = 'in_progress' THEN 1 END) AS in_progress_count,
  COUNT(CASE WHEN status = 'done'        THEN 1 END) AS done_count
FROM tasks WHERE project_id = p_project_id;

-- ---- Seed data -------------------------------------------------------------

-- onConnect re-runs this file on every boot, so the explicit-id inserts must be
-- idempotent — INSERT IGNORE keeps a restart from crashing on PK clashes.
INSERT IGNORE INTO organizations (id, name, slug, plan) VALUES
  (1, 'Acme',   'acme',   'pro'),
  (2, 'Globex', 'globex', 'free');

INSERT IGNORE INTO projects (id, org_id, owner, name, description, visibility, status) VALUES
  (1, 1, 'alice', 'Website Redesign', 'Marketing site refresh',  'org',     'active'),
  (2, 1, 'molly', 'Public Roadmap',   'Customer-facing roadmap', 'public',  'active'),
  (3, 2, 'gina',  'Internal Tools',   'Ops tooling',             'private', 'active');

-- Relative to 2026-06-28: tasks 1 and 4 are overdue (due in the past, not done).
INSERT IGNORE INTO tasks (id, org_id, project_id, assignee, created_by, title, description, status, priority, due_date) VALUES
  (1, 1, 1, 'evan',  'alice', 'Design homepage',  'Hero + nav',     'in_progress', 4, '2026-06-01'),
  (2, 1, 1, 'molly', 'alice', 'Set up CI',        'GitHub Actions', 'todo',        3, '2026-12-01'),
  (3, 1, 2, 'evan',  'molly', 'Write changelog',  'v1 notes',       'done',        2, '2026-06-10'),
  (4, 2, 3, 'max',   'gina',  'Migrate database', 'Move to PG 18',  'todo',        5, '2026-06-15');

INSERT IGNORE INTO comments (id, org_id, task_id, author, body) VALUES
  (1, 1, 1, 'molly', 'Looks good — ship it'),
  (2, 1, 1, 'evan',  'Working on the nav now'),
  (3, 2, 4, 'gina',  'Bumping priority to 5');

INSERT IGNORE INTO tags (id, org_id, name, color) VALUES
  (1, 1, 'frontend', '#3b82f6'),
  (2, 1, 'backend',  '#ef4444'),
  (3, 2, 'infra',    '#10b981');

INSERT IGNORE INTO task_tags (task_id, tag_id) VALUES
  (1, 1), (2, 2), (4, 3);

INSERT IGNORE INTO audit_log (id, org_id, actor, action, entity) VALUES
  (1, 1, 'alice', 'project.created', 'project:1');
