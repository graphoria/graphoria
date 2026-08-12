-- Canonical integration-test schema — MySQL dialect.
--
-- Statements are separated by a line containing exactly `;;`; the stored
-- procedure body contains semicolons of its own.
--
-- MySQL has no schema-inside-a-database concept, so the two logical schemas are
-- two databases: graphoria_app and graphoria_catalog. Graphoria's MySQL
-- introspection enumerates every non-system schema, so both are picked up from
-- a single connection.
--
-- Dialect notes, deliberate and worth knowing when comparing to pg.sql:
--   * BOOLEAN is an alias for TINYINT(1), so boolean columns categorise as
--     integers rather than booleans here.
--   * There is no portable array type, so catalog.pg_only_types has no MySQL
--     counterpart.

DROP DATABASE IF EXISTS graphoria_app
;;
DROP DATABASE IF EXISTS graphoria_catalog
;;
CREATE DATABASE graphoria_app CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci
;;
CREATE DATABASE graphoria_catalog CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci
;;

-- ============================================================================
-- graphoria_app — the multi-tenant, relational half
-- ============================================================================

CREATE TABLE graphoria_app.organizations (
  id   int PRIMARY KEY,
  name varchar(100) NOT NULL,
  slug varchar(100) NOT NULL UNIQUE
)
;;

-- manager_id is the self-referential FK.
CREATE TABLE graphoria_app.users (
  id              int PRIMARY KEY,
  organization_id int NOT NULL,
  manager_id      int NULL,
  email           varchar(200) NOT NULL,
  display_name    varchar(200) NOT NULL,
  is_active       boolean NOT NULL,
  created_at      datetime NOT NULL,
  CONSTRAINT fk_users_org FOREIGN KEY (organization_id) REFERENCES graphoria_app.organizations (id),
  CONSTRAINT fk_users_manager FOREIGN KEY (manager_id) REFERENCES graphoria_app.users (id)
)
;;

CREATE TABLE graphoria_app.projects (
  id              int PRIMARY KEY,
  organization_id int NOT NULL,
  owner_id        int NOT NULL,
  name            varchar(200) NOT NULL,
  budget          decimal(12, 2) NULL,
  launched_on     date NULL,
  archived        boolean NOT NULL,
  CONSTRAINT fk_projects_org FOREIGN KEY (organization_id) REFERENCES graphoria_app.organizations (id),
  CONSTRAINT fk_projects_owner FOREIGN KEY (owner_id) REFERENCES graphoria_app.users (id)
)
;;

CREATE TABLE graphoria_app.tasks (
  id              int PRIMARY KEY,
  project_id      int NOT NULL,
  organization_id int NOT NULL,
  user_id         int NULL,
  title           varchar(200) NOT NULL,
  notes           text NULL,
  priority        int NOT NULL,
  estimate_hours  decimal(6, 2) NULL,
  due_at          datetime NULL,
  completed       boolean NOT NULL,
  CONSTRAINT fk_tasks_project FOREIGN KEY (project_id) REFERENCES graphoria_app.projects (id),
  CONSTRAINT fk_tasks_org FOREIGN KEY (organization_id) REFERENCES graphoria_app.organizations (id),
  CONSTRAINT fk_tasks_user FOREIGN KEY (user_id) REFERENCES graphoria_app.users (id)
)
;;

CREATE TABLE graphoria_app.tags (
  id   int PRIMARY KEY,
  name varchar(100) NOT NULL
)
;;

-- Many-to-many, and the composite primary key.
CREATE TABLE graphoria_app.task_tags (
  task_id int NOT NULL,
  tag_id  int NOT NULL,
  PRIMARY KEY (task_id, tag_id),
  CONSTRAINT fk_task_tags_task FOREIGN KEY (task_id) REFERENCES graphoria_app.tasks (id),
  CONSTRAINT fk_task_tags_tag FOREIGN KEY (tag_id) REFERENCES graphoria_app.tags (id)
)
;;

-- Deliberately has no primary key.
CREATE TABLE graphoria_app.activity_log (
  task_id     int NOT NULL,
  action      varchar(50) NOT NULL,
  occurred_at datetime NOT NULL
)
;;

CREATE VIEW graphoria_app.open_tasks AS
  SELECT id, project_id, organization_id, user_id, title, priority
  FROM graphoria_app.tasks
  WHERE completed = false
;;

CREATE PROCEDURE graphoria_app.tasks_by_priority(IN min_priority int)
BEGIN
  SELECT t.id, t.title, t.priority
  FROM graphoria_app.tasks t
  WHERE t.priority >= min_priority
  ORDER BY t.id;
END
;;

-- ============================================================================
-- graphoria_catalog — type coverage and hostile identifiers
-- ============================================================================

CREATE TABLE graphoria_catalog.type_showcase (
  id          int PRIMARY KEY,
  small_int   smallint NULL,
  big_int     bigint NULL,
  decimal_val decimal(10, 3) NULL,
  float_val   double NULL,
  char_val    char(5) NULL,
  varchar_val varchar(100) NULL,
  text_val    text NULL,
  bool_val    boolean NULL,
  date_val    date NULL,
  ts_val      datetime NULL,
  tstz_val    timestamp NULL,
  json_val    json NULL,
  uuid_val    char(36) NULL,
  bytes_val   varbinary(64) NULL
)
;;

-- `order`, `user` and `select` are reserved words.
CREATE TABLE graphoria_catalog.`order` (
  id       int PRIMARY KEY,
  `user`   varchar(100) NOT NULL,
  `select` int NOT NULL
)
;;

CREATE TABLE graphoria_catalog.`MixedCase` (
  `Id`          int PRIMARY KEY,
  `MixedColumn` varchar(100) NOT NULL
)
;;

CREATE TABLE graphoria_catalog.`space name` (
  id          int PRIMARY KEY,
  `space col` varchar(100) NOT NULL
)
;;

CREATE TABLE graphoria_catalog.`categoría` (
  id            int PRIMARY KEY,
  `descripción` varchar(100) NOT NULL
)
;;

-- ============================================================================
-- Seed data — keep row counts in step with EXPECTED_COUNTS in seed.ts.
-- ============================================================================

INSERT INTO graphoria_app.organizations (id, name, slug) VALUES
  (1, 'Acme', 'acme'),
  (2, 'Umbrella', 'umbrella')
;;

INSERT INTO graphoria_app.users (id, organization_id, manager_id, email, display_name, is_active, created_at) VALUES
  (1, 1, NULL, 'ana@acme.test',      'Ana Costa',           true,  '2026-01-02 09:00:00'),
  (2, 1, 1,    'brian@acme.test',    'Brian O''Brien',      true,  '2026-01-03 09:00:00'),
  (3, 1, 1,    'cleo@acme.test',     'Cleo 100% Ready',     false, '2026-01-04 09:00:00'),
  (4, 2, NULL, 'dan@umbrella.test',  'Dan under_score',     true,  '2026-01-05 09:00:00'),
  (5, 2, 4,    'eve@umbrella.test',  'Eve back\\slash',     true,  '2026-01-06 09:00:00'),
  (6, 2, 4,    'finn@umbrella.test', 'Finn; DROP TABLE --', true,  '2026-01-07 09:00:00')
;;

INSERT INTO graphoria_app.projects (id, organization_id, owner_id, name, budget, launched_on, archived) VALUES
  (1, 1, 1, 'Apollo',   15000.50, '2026-02-01', false),
  (2, 1, 2, 'Borealis', NULL,     NULL,         true),
  (3, 2, 4, 'Cascade',  9000.00,  '2026-03-15', false)
;;

INSERT INTO graphoria_app.tasks (id, project_id, organization_id, user_id, title, notes, priority, estimate_hours, due_at, completed) VALUES
  (1,  1, 1, 1,    'Draft spec',        'first pass',        5, 4.50,  '2026-04-01 12:00:00', false),
  (2,  1, 1, 2,    'Review spec',       NULL,                3, NULL,  '2026-04-02 12:00:00', false),
  (3,  1, 1, 2,    'Ship 100% of it',   'contains 100%',     1, 1.25,  NULL,                  true),
  (4,  1, 1, 3,    'Fix under_score',   'contains _',        4, 2.00,  '2026-04-04 12:00:00', false),
  (5,  2, 1, NULL, 'Unassigned task',   NULL,                2, NULL,  NULL,                  false),
  (6,  2, 1, 1,    'Archive cleanup',   'back\\slash here',  5, 8.00,  '2026-04-06 12:00:00', true),
  (7,  3, 2, 4,    'Umbrella kickoff',  NULL,                5, 3.00,  '2026-04-07 12:00:00', false),
  (8,  3, 2, 5,    'Umbrella design',   'draft',             2, 6.00,  NULL,                  false),
  (9,  3, 2, 5,    'Umbrella build',    NULL,                4, 12.00, '2026-04-09 12:00:00', false),
  (10, 3, 2, 6,    'Umbrella; DROP --', 'hostile title',     1, NULL,  NULL,                  true)
;;

INSERT INTO graphoria_app.tags (id, name) VALUES
  (1, 'urgent'),
  (2, '100%'),
  (3, 'under_score'),
  (4, 'back\\slash'),
  (5, '; DROP TABLE --')
;;

INSERT INTO graphoria_app.task_tags (task_id, tag_id) VALUES
  (1, 1), (1, 2), (2, 1), (3, 2), (4, 3), (6, 4), (7, 1), (10, 5)
;;

INSERT INTO graphoria_app.activity_log (task_id, action, occurred_at) VALUES
  (1, 'created',   '2026-04-01 08:00:00'),
  (1, 'assigned',  '2026-04-01 08:05:00'),
  (3, 'completed', '2026-04-03 17:00:00')
;;

INSERT INTO graphoria_catalog.type_showcase
  (id, small_int, big_int, decimal_val, float_val, char_val, varchar_val, text_val,
   bool_val, date_val, ts_val, tstz_val, json_val, uuid_val, bytes_val)
VALUES
  (1, 32000, 9007199254740991, 123.456, 1.5, 'abcde', 'varchar value', 'text value',
   true, '2026-05-01', '2026-05-01 10:30:00', '2026-05-01 10:30:00',
   '{"k": "v"}', '11111111-2222-3333-4444-555555555555', 0x0102),
  (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
;;

INSERT INTO graphoria_catalog.`order` (id, `user`, `select`) VALUES
  (1, 'ana', 10),
  (2, 'brian', 20)
;;

INSERT INTO graphoria_catalog.`MixedCase` (`Id`, `MixedColumn`) VALUES
  (1, 'mixed one'),
  (2, 'mixed two')
;;

INSERT INTO graphoria_catalog.`space name` (id, `space col`) VALUES
  (1, 'spaced value')
;;

INSERT INTO graphoria_catalog.`categoría` (id, `descripción`) VALUES
  (1, 'acentuação')
;;
