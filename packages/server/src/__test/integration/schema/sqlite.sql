-- Canonical integration-test schema — SQLite dialect.
--
-- Statements are separated by a line containing exactly `;;`, as in the other
-- three files. The app tables live in the main file (schema `main`); catalog is
-- a second file the seed and the server attach as `catalog`.
--
-- SQLite keeps a column's declared type as written, and Graphoria types the
-- GraphQL field from it, so the declarations follow pg.sql. A foreign key names
-- its parent unqualified: SQLite resolves it in the child's own file. There is
-- no stored function, as SQLite has none.

DROP VIEW IF EXISTS main.open_tasks
;;
DROP TABLE IF EXISTS main.activity_log
;;
DROP TABLE IF EXISTS main.task_tags
;;
DROP TABLE IF EXISTS main.tags
;;
DROP TABLE IF EXISTS main.tasks
;;
DROP TABLE IF EXISTS main.projects
;;
DROP TABLE IF EXISTS main.users
;;
DROP TABLE IF EXISTS main.organizations
;;
DROP TABLE IF EXISTS catalog.type_showcase
;;
DROP TABLE IF EXISTS catalog."order"
;;
DROP TABLE IF EXISTS catalog."MixedCase"
;;
DROP TABLE IF EXISTS catalog."space name"
;;
DROP TABLE IF EXISTS catalog."categoría"
;;

-- ============================================================================
-- main — the multi-tenant, relational half
-- ============================================================================

CREATE TABLE main.organizations (
  id           integer PRIMARY KEY,
  name         varchar(100) NOT NULL,
  slug         varchar(100) NOT NULL UNIQUE
)
;;

-- manager_id is the self-referential FK.
CREATE TABLE main.users (
  id              integer PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations (id),
  manager_id      integer NULL REFERENCES users (id),
  email           varchar(200) NOT NULL,
  display_name    varchar(200) NOT NULL,
  is_active       boolean NOT NULL,
  created_at      timestamp NOT NULL
)
;;

CREATE TABLE main.projects (
  id              integer PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations (id),
  owner_id        integer NOT NULL REFERENCES users (id),
  name            varchar(200) NOT NULL,
  budget          decimal(12, 2) NULL,
  launched_on     date NULL,
  archived        boolean NOT NULL
)
;;

CREATE TABLE main.tasks (
  id              integer PRIMARY KEY,
  project_id      integer NOT NULL REFERENCES projects (id),
  organization_id integer NOT NULL REFERENCES organizations (id),
  user_id         integer NULL REFERENCES users (id),
  title           varchar(200) NOT NULL,
  notes           text NULL,
  priority        integer NOT NULL,
  estimate_hours  decimal(6, 2) NULL,
  due_at          timestamp NULL,
  completed       boolean NOT NULL
)
;;

CREATE TABLE main.tags (
  id   integer PRIMARY KEY,
  name varchar(100) NOT NULL
)
;;

-- Many-to-many, and the composite primary key.
CREATE TABLE main.task_tags (
  task_id integer NOT NULL REFERENCES tasks (id),
  tag_id  integer NOT NULL REFERENCES tags (id),
  PRIMARY KEY (task_id, tag_id)
)
;;

-- Deliberately has no primary key.
CREATE TABLE main.activity_log (
  task_id     integer NOT NULL,
  action      varchar(50) NOT NULL,
  occurred_at timestamp NOT NULL
)
;;

CREATE VIEW main.open_tasks AS
  SELECT id, project_id, organization_id, user_id, title, priority
  FROM tasks
  WHERE completed = FALSE
;;

-- ============================================================================
-- catalog — type coverage and hostile identifiers
-- ============================================================================

CREATE TABLE catalog.type_showcase (
  id          integer PRIMARY KEY,
  small_int   smallint NULL,
  big_int     bigint NULL,
  decimal_val decimal(10, 3) NULL,
  float_val   double precision NULL,
  char_val    char(5) NULL,
  varchar_val varchar(100) NULL,
  text_val    text NULL,
  bool_val    boolean NULL,
  date_val    date NULL,
  ts_val      timestamp NULL,
  tstz_val    timestamptz NULL,
  json_val    json NULL,
  uuid_val    uuid NULL,
  bytes_val   blob NULL
)
;;

-- `order` and `user` are reserved words in at least one supported engine.
CREATE TABLE catalog."order" (
  id       integer PRIMARY KEY,
  "user"   varchar(100) NOT NULL,
  "select" integer NOT NULL
)
;;

CREATE TABLE catalog."MixedCase" (
  "Id"          integer PRIMARY KEY,
  "MixedColumn" varchar(100) NOT NULL
)
;;

CREATE TABLE catalog."space name" (
  id           integer PRIMARY KEY,
  "space col"  varchar(100) NOT NULL
)
;;

CREATE TABLE catalog."categoría" (
  id       integer PRIMARY KEY,
  "descripción" varchar(100) NOT NULL
)
;;

-- ============================================================================
-- Seed data — row counts are asserted by the smoke test, keep them in step
-- with EXPECTED_COUNTS in seed.ts.
-- ============================================================================

INSERT INTO main.organizations (id, name, slug) VALUES
  (1, 'Acme', 'acme'),
  (2, 'Umbrella', 'umbrella')
;;

INSERT INTO main.users (id, organization_id, manager_id, email, display_name, is_active, created_at) VALUES
  (1, 1, NULL, 'ana@acme.test',      'Ana Costa',        TRUE,  '2026-01-02 09:00:00'),
  (2, 1, 1,    'brian@acme.test',    'Brian O''Brien',   TRUE,  '2026-01-03 09:00:00'),
  (3, 1, 1,    'cleo@acme.test',     'Cleo 100% Ready',  FALSE, '2026-01-04 09:00:00'),
  (4, 2, NULL, 'dan@umbrella.test',  'Dan under_score',  TRUE,  '2026-01-05 09:00:00'),
  (5, 2, 4,    'eve@umbrella.test',  'Eve back\slash',   TRUE,  '2026-01-06 09:00:00'),
  (6, 2, 4,    'finn@umbrella.test', 'Finn; DROP TABLE --', TRUE, '2026-01-07 09:00:00')
;;

INSERT INTO main.projects (id, organization_id, owner_id, name, budget, launched_on, archived) VALUES
  (1, 1, 1, 'Apollo',   15000.50, '2026-02-01', FALSE),
  (2, 1, 2, 'Borealis', NULL,     NULL,         TRUE),
  (3, 2, 4, 'Cascade',  9000.00,  '2026-03-15', FALSE)
;;

INSERT INTO main.tasks (id, project_id, organization_id, user_id, title, notes, priority, estimate_hours, due_at, completed) VALUES
  (1,  1, 1, 1,    'Draft spec',        'first pass',       5, 4.50,  '2026-04-01 12:00:00', FALSE),
  (2,  1, 1, 2,    'Review spec',       NULL,               3, NULL,  '2026-04-02 12:00:00', FALSE),
  (3,  1, 1, 2,    'Ship 100% of it',   'contains 100%',    1, 1.25,  NULL,                  TRUE),
  (4,  1, 1, 3,    'Fix under_score',   'contains _',       4, 2.00,  '2026-04-04 12:00:00', FALSE),
  (5,  2, 1, NULL, 'Unassigned task',   NULL,               2, NULL,  NULL,                  FALSE),
  (6,  2, 1, 1,    'Archive cleanup',   'back\slash here',  5, 8.00,  '2026-04-06 12:00:00', TRUE),
  (7,  3, 2, 4,    'Umbrella kickoff',  NULL,               5, 3.00,  '2026-04-07 12:00:00', FALSE),
  (8,  3, 2, 5,    'Umbrella design',   'draft',            2, 6.00,  NULL,                  FALSE),
  (9,  3, 2, 5,    'Umbrella build',    NULL,               4, 12.00, '2026-04-09 12:00:00', FALSE),
  (10, 3, 2, 6,    'Umbrella; DROP --', 'hostile title',    1, NULL,  NULL,                  TRUE)
;;

INSERT INTO main.tags (id, name) VALUES
  (1, 'urgent'),
  (2, '100%'),
  (3, 'under_score'),
  (4, 'back\slash'),
  (5, '; DROP TABLE --')
;;

INSERT INTO main.task_tags (task_id, tag_id) VALUES
  (1, 1), (1, 2), (2, 1), (3, 2), (4, 3), (6, 4), (7, 1), (10, 5)
;;

INSERT INTO main.activity_log (task_id, action, occurred_at) VALUES
  (1, 'created', '2026-04-01 08:00:00'),
  (1, 'assigned', '2026-04-01 08:05:00'),
  (3, 'completed', '2026-04-03 17:00:00')
;;

INSERT INTO catalog.type_showcase
  (id, small_int, big_int, decimal_val, float_val, char_val, varchar_val, text_val,
   bool_val, date_val, ts_val, tstz_val, json_val, uuid_val, bytes_val)
VALUES
  (1, 32000, 9007199254740991, 123.456, 1.5, 'abcde', 'varchar value', 'text value',
   TRUE, '2026-05-01', '2026-05-01 10:30:00', '2026-05-01 10:30:00+00:00',
   '{"k": "v"}', '11111111-2222-3333-4444-555555555555', x'0102'),
  (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
;;

INSERT INTO catalog."order" (id, "user", "select") VALUES
  (1, 'ana', 10),
  (2, 'brian', 20)
;;

INSERT INTO catalog."MixedCase" ("Id", "MixedColumn") VALUES
  (1, 'mixed one'),
  (2, 'mixed two')
;;

INSERT INTO catalog."space name" (id, "space col") VALUES
  (1, 'spaced value')
;;

INSERT INTO catalog."categoría" (id, "descripción") VALUES
  (1, 'acentuação')
;;
