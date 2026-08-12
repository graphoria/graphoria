-- Canonical integration-test schema — SQL Server dialect.
--
-- Statements are separated by a line containing exactly `;;`. Each chunk is sent
-- as its own batch, which also satisfies SQL Server's rule that CREATE SCHEMA,
-- CREATE VIEW and CREATE PROCEDURE must be the first statement in their batch.
--
-- Dialect notes, deliberate and worth knowing when comparing to pg.sql:
--   * BIT stands in for BOOLEAN, DATETIMEOFFSET for TIMESTAMPTZ, NVARCHAR(MAX)
--     for JSON, and UNIQUEIDENTIFIER for UUID.
--   * There is no portable array type, so catalog.pg_only_types has no SQL
--     Server counterpart.

DROP VIEW IF EXISTS app.open_tasks;
DROP PROCEDURE IF EXISTS app.tasks_by_priority;
DROP TABLE IF EXISTS app.task_tags;
DROP TABLE IF EXISTS app.activity_log;
DROP TABLE IF EXISTS app.tags;
DROP TABLE IF EXISTS app.tasks;
DROP TABLE IF EXISTS app.projects;
DROP TABLE IF EXISTS app.users;
DROP TABLE IF EXISTS app.organizations;
DROP TABLE IF EXISTS catalog.type_showcase;
DROP TABLE IF EXISTS catalog.[order];
DROP TABLE IF EXISTS catalog.[MixedCase];
DROP TABLE IF EXISTS catalog.[space name];
DROP TABLE IF EXISTS catalog.[categoría];
;;
DROP SCHEMA IF EXISTS app
;;
DROP SCHEMA IF EXISTS catalog
;;
CREATE SCHEMA app
;;
CREATE SCHEMA catalog
;;

-- ============================================================================
-- app — the multi-tenant, relational half
-- ============================================================================

CREATE TABLE app.organizations (
  id   int PRIMARY KEY,
  name nvarchar(100) NOT NULL,
  slug nvarchar(100) NOT NULL UNIQUE
)
;;

-- manager_id is the self-referential FK.
CREATE TABLE app.users (
  id              int PRIMARY KEY,
  organization_id int NOT NULL REFERENCES app.organizations (id),
  manager_id      int NULL REFERENCES app.users (id),
  email           nvarchar(200) NOT NULL,
  display_name    nvarchar(200) NOT NULL,
  is_active       bit NOT NULL,
  created_at      datetime2 NOT NULL
)
;;

CREATE TABLE app.projects (
  id              int PRIMARY KEY,
  organization_id int NOT NULL REFERENCES app.organizations (id),
  owner_id        int NOT NULL REFERENCES app.users (id),
  name            nvarchar(200) NOT NULL,
  budget          decimal(12, 2) NULL,
  launched_on     date NULL,
  archived        bit NOT NULL
)
;;

CREATE TABLE app.tasks (
  id              int PRIMARY KEY,
  project_id      int NOT NULL REFERENCES app.projects (id),
  organization_id int NOT NULL REFERENCES app.organizations (id),
  user_id         int NULL REFERENCES app.users (id),
  title           nvarchar(200) NOT NULL,
  notes           nvarchar(max) NULL,
  priority        int NOT NULL,
  estimate_hours  decimal(6, 2) NULL,
  due_at          datetime2 NULL,
  completed       bit NOT NULL
)
;;

CREATE TABLE app.tags (
  id   int PRIMARY KEY,
  name nvarchar(100) NOT NULL
)
;;

-- Many-to-many, and the composite primary key.
CREATE TABLE app.task_tags (
  task_id int NOT NULL REFERENCES app.tasks (id),
  tag_id  int NOT NULL REFERENCES app.tags (id),
  PRIMARY KEY (task_id, tag_id)
)
;;

-- Deliberately has no primary key.
CREATE TABLE app.activity_log (
  task_id     int NOT NULL,
  action      nvarchar(50) NOT NULL,
  occurred_at datetime2 NOT NULL
)
;;

CREATE VIEW app.open_tasks AS
  SELECT id, project_id, organization_id, user_id, title, priority
  FROM app.tasks
  WHERE completed = 0
;;

CREATE PROCEDURE app.tasks_by_priority @min_priority int
AS
BEGIN
  SET NOCOUNT ON;
  SELECT t.id, t.title, t.priority
  FROM app.tasks t
  WHERE t.priority >= @min_priority
  ORDER BY t.id;
END
;;

-- ============================================================================
-- catalog — type coverage and hostile identifiers
-- ============================================================================

CREATE TABLE catalog.type_showcase (
  id          int PRIMARY KEY,
  small_int   smallint NULL,
  big_int     bigint NULL,
  decimal_val decimal(10, 3) NULL,
  float_val   float NULL,
  char_val    char(5) NULL,
  varchar_val nvarchar(100) NULL,
  text_val    nvarchar(max) NULL,
  bool_val    bit NULL,
  date_val    date NULL,
  ts_val      datetime2 NULL,
  tstz_val    datetimeoffset NULL,
  json_val    nvarchar(max) NULL,
  uuid_val    uniqueidentifier NULL,
  bytes_val   varbinary(64) NULL
)
;;

-- `order`, `user` and `select` are reserved words.
CREATE TABLE catalog.[order] (
  id       int PRIMARY KEY,
  [user]   nvarchar(100) NOT NULL,
  [select] int NOT NULL
)
;;

CREATE TABLE catalog.[MixedCase] (
  [Id]          int PRIMARY KEY,
  [MixedColumn] nvarchar(100) NOT NULL
)
;;

CREATE TABLE catalog.[space name] (
  id          int PRIMARY KEY,
  [space col] nvarchar(100) NOT NULL
)
;;

CREATE TABLE catalog.[categoría] (
  id            int PRIMARY KEY,
  [descripción] nvarchar(100) NOT NULL
)
;;

-- ============================================================================
-- Seed data — keep row counts in step with EXPECTED_COUNTS in seed.ts.
-- ============================================================================

INSERT INTO app.organizations (id, name, slug) VALUES
  (1, N'Acme', N'acme'),
  (2, N'Umbrella', N'umbrella')
;;

INSERT INTO app.users (id, organization_id, manager_id, email, display_name, is_active, created_at) VALUES
  (1, 1, NULL, N'ana@acme.test',      N'Ana Costa',           1, '2026-01-02T09:00:00'),
  (2, 1, 1,    N'brian@acme.test',    N'Brian O''Brien',      1, '2026-01-03T09:00:00'),
  (3, 1, 1,    N'cleo@acme.test',     N'Cleo 100% Ready',     0, '2026-01-04T09:00:00'),
  (4, 2, NULL, N'dan@umbrella.test',  N'Dan under_score',     1, '2026-01-05T09:00:00'),
  (5, 2, 4,    N'eve@umbrella.test',  N'Eve back\slash',      1, '2026-01-06T09:00:00'),
  (6, 2, 4,    N'finn@umbrella.test', N'Finn; DROP TABLE --', 1, '2026-01-07T09:00:00')
;;

INSERT INTO app.projects (id, organization_id, owner_id, name, budget, launched_on, archived) VALUES
  (1, 1, 1, N'Apollo',   15000.50, '2026-02-01', 0),
  (2, 1, 2, N'Borealis', NULL,     NULL,         1),
  (3, 2, 4, N'Cascade',  9000.00,  '2026-03-15', 0)
;;

INSERT INTO app.tasks (id, project_id, organization_id, user_id, title, notes, priority, estimate_hours, due_at, completed) VALUES
  (1,  1, 1, 1,    N'Draft spec',        N'first pass',       5, 4.50,  '2026-04-01T12:00:00', 0),
  (2,  1, 1, 2,    N'Review spec',       NULL,                3, NULL,  '2026-04-02T12:00:00', 0),
  (3,  1, 1, 2,    N'Ship 100% of it',   N'contains 100%',    1, 1.25,  NULL,                  1),
  (4,  1, 1, 3,    N'Fix under_score',   N'contains _',       4, 2.00,  '2026-04-04T12:00:00', 0),
  (5,  2, 1, NULL, N'Unassigned task',   NULL,                2, NULL,  NULL,                  0),
  (6,  2, 1, 1,    N'Archive cleanup',   N'back\slash here',  5, 8.00,  '2026-04-06T12:00:00', 1),
  (7,  3, 2, 4,    N'Umbrella kickoff',  NULL,                5, 3.00,  '2026-04-07T12:00:00', 0),
  (8,  3, 2, 5,    N'Umbrella design',   N'draft',            2, 6.00,  NULL,                  0),
  (9,  3, 2, 5,    N'Umbrella build',    NULL,                4, 12.00, '2026-04-09T12:00:00', 0),
  (10, 3, 2, 6,    N'Umbrella; DROP --', N'hostile title',    1, NULL,  NULL,                  1)
;;

INSERT INTO app.tags (id, name) VALUES
  (1, N'urgent'),
  (2, N'100%'),
  (3, N'under_score'),
  (4, N'back\slash'),
  (5, N'; DROP TABLE --')
;;

INSERT INTO app.task_tags (task_id, tag_id) VALUES
  (1, 1), (1, 2), (2, 1), (3, 2), (4, 3), (6, 4), (7, 1), (10, 5)
;;

INSERT INTO app.activity_log (task_id, action, occurred_at) VALUES
  (1, N'created',   '2026-04-01T08:00:00'),
  (1, N'assigned',  '2026-04-01T08:05:00'),
  (3, N'completed', '2026-04-03T17:00:00')
;;

INSERT INTO catalog.type_showcase
  (id, small_int, big_int, decimal_val, float_val, char_val, varchar_val, text_val,
   bool_val, date_val, ts_val, tstz_val, json_val, uuid_val, bytes_val)
VALUES
  (1, 32000, 9007199254740991, 123.456, 1.5, 'abcde', N'varchar value', N'text value',
   1, '2026-05-01', '2026-05-01T10:30:00', '2026-05-01T10:30:00+00:00',
   N'{"k": "v"}', '11111111-2222-3333-4444-555555555555', 0x0102),
  (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
;;

INSERT INTO catalog.[order] (id, [user], [select]) VALUES
  (1, N'ana', 10),
  (2, N'brian', 20)
;;

INSERT INTO catalog.[MixedCase] ([Id], [MixedColumn]) VALUES
  (1, N'mixed one'),
  (2, N'mixed two')
;;

INSERT INTO catalog.[space name] (id, [space col]) VALUES
  (1, N'spaced value')
;;

INSERT INTO catalog.[categoría] (id, [descripción]) VALUES
  (1, N'acentuação')
;;
