import {
  virtualColumnExpression,
  virtualColumnFunction,
  type ConfigurationInput,
} from "@graphoria/server/config";

import { tasklyRepositoryMSSQL, tasklyRepositoryMySQL, tasklyRepositoryPG } from "./repository";
import { dashboard } from "./operations/dashboard";
import { tasks } from "./operations/tasks";

export default {
  name: "taskly",
  version: "1.0.0",

  // Swap to "paseto_local" / "paseto_public" (or set AUTH_STRATEGY) for the other strategies.
  tokenStrategy: "jwt",

  databases: [
    {
      name: "pg",
      type: "pg",
      enabled: true,
      // All three engines expose the same table names, so every database keys
      // its GraphQL fields on the config name rather than the schema: pg_tasks
      // / mysql_tasks / mssql_tasks, three obviously disjoint sets. NOTE: this
      // changes resolverName (permission keys) but NOT schemaName, which the
      // `schema.database` block below is keyed on.
      fieldNaming: "{database}_{name}",
      connection: {
        host: "localhost",
        port: 5432,
        user: "postgres",
        password: "postgrespassword",
        database: "my_app",
      },

      onConnect: async (sql) => {
        const seed = await Bun.file("seed.pg.sql").text();

        await sql.begin(async (sql) => {
          await sql.unsafe(seed);
        });
      },

      // Raw-SQL repository → typed access from operation handlers (options.repository.pg).
      repository: tasklyRepositoryPG,

      schema: {
        // Keyed by schemaName ({schema}_{name}), which ignores fieldNaming —
        // hence public_ here while the permission keys below use pg_.
        database: {
          public_tasks: {
            description: "Work items belonging to a project",
            columnDescriptions: {
              assignee: "Username (auth.user.username) the task is assigned to",
            },
            columns: [
              virtualColumnExpression(
                "is_overdue",
                "boolean",
                false,
                "CASE WHEN due_date < NOW() AND status <> 'done' THEN true ELSE false END",
              ),
              virtualColumnFunction("age_days", "int", false, "task_age_days", ["created_at"]),
            ],
            // projects, comments and org_id are real FKs in seed.pg.sql now, so
            // Graphoria introspects them. Only task_tags (FK-free) stays here.
            relationships: [
              {
                schema: "public",
                name: "task_tags",
                columns: [{ source: "id", target: "task_id" }],
              },
            ],
          },
          public_task_tags: {
            relationships: [
              { schema: "public", name: "tags", columns: [{ source: "tag_id", target: "id" }] },
            ],
          },
        },
      },
    },
    {
      name: "mysql",
      type: "mysql",
      enabled: true,
      // Same reasoning as the pg block above.
      fieldNaming: "{database}_{name}",
      connection: {
        host: "localhost",
        port: 3306,
        user: "root",
        password: "mysqlpassword",
        database: "my_app",
      },

      onConnect: async (sql) => {
        const seed = await Bun.file("seed.mysql.sql").text();

        // No sql.begin() here, unlike PostgreSQL: MySQL implicitly commits on
        // every DDL statement, so a transaction around CREATE TABLE buys nothing
        // and would only make a partial failure look atomic.
        await sql.unsafe(seed);
      },

      // Raw-SQL repository → typed access from operation handlers (options.repository.mysql).
      repository: tasklyRepositoryMySQL,

      schema: {
        // Keyed by schemaName ({schema}_{name}), which ignores fieldNaming —
        // MySQL's schema is the database, hence the my_app_ prefix here while the
        // permission keys below use mysql_.
        database: {
          my_app_tasks: {
            description: "Work items belonging to a project",
            columnDescriptions: {
              assignee: "Username (auth.user.username) the task is assigned to",
            },
            columns: [
              virtualColumnExpression(
                "is_overdue",
                "boolean",
                false,
                "CASE WHEN due_date < NOW() AND status <> 'done' THEN true ELSE false END",
              ),
              virtualColumnFunction("age_days", "int", false, "task_age_days", ["created_at"]),
            ],
            relationships: [
              {
                schema: "my_app",
                name: "task_tags",
                columns: [{ source: "id", target: "task_id" }],
              },
            ],
          },
          my_app_task_tags: {
            relationships: [
              { schema: "my_app", name: "tags", columns: [{ source: "tag_id", target: "id" }] },
            ],
          },
        },
      },
    },
    {
      name: "mssql",
      type: "mssql",
      enabled: true,
      fieldNaming: "{database}_{name}",
      connection: {
        host: "localhost",
        port: 1433,
        user: "sa",
        // Matches MSSQL_SA_PASSWORD in examples/docker-compose.yml.
        password: "Str0ng!Passw0rd",
        database: "my_app",
      },

      onConnect: async (sql) => {
        const seed = await Bun.file("seed.mssql.sql").text();

        const transaction = sql.transaction();

        await transaction.begin();

        try {
          const request = transaction.request();

          await request.query(seed);

          await transaction.commit();
        } catch (error) {
          await transaction.rollback();
          // Rethrow: swallowing this boots the server against an empty database,
          // and the failure only resurfaces later as "table not found".
          throw error;
        }
      },

      // Raw-SQL repository → typed access from operation handlers (options.repository.mssql).
      repository: tasklyRepositoryMSSQL,

      schema: {
        // Keyed by schemaName ({schema}_{name}) → dbo_ prefix, while the
        // permission keys below use mssql_ (resolverName, via fieldNaming).
        database: {
          dbo_tasks: {
            description: "Work items belonging to a project",
            columnDescriptions: {
              assignee: "Username (auth.user.username) the task is assigned to",
            },
            columns: [
              // T-SQL has no NOW() and no boolean literals — SYSDATETIMEOFFSET()
              // matches the datetimeoffset columns, and bit wants 1/0.
              virtualColumnExpression(
                "is_overdue",
                "boolean",
                false,
                "CASE WHEN due_date < SYSDATETIMEOFFSET() AND status <> 'done' THEN 1 ELSE 0 END",
              ),
              // Scalar UDFs must be schema-qualified in T-SQL.
              virtualColumnFunction("age_days", "int", false, "dbo.task_age_days", ["created_at"]),
            ],
            relationships: [
              {
                schema: "dbo",
                name: "task_tags",
                columns: [{ source: "id", target: "task_id" }],
              },
            ],
          },
          dbo_task_tags: {
            relationships: [
              { schema: "dbo", name: "tags", columns: [{ source: "tag_id", target: "id" }] },
            ],
          },
        },
      },
    },
  ],

  auth: {
    enabled: true,
    database: "pg",
    schema: "auth",
    autoCreateTables: true,
    permissions: {
      // No token → anonymous. Public projects only, safe column subset.
      // Table keys are resolverNames, so they carry each database's fieldNaming
      // ({database}_{name} everywhere here): pg_, mysql_ and mssql_.
      anonymous: {
        tables: {
          pg_projects: {
            columns: ["id", "name", "description", "status", "created_at"],
            filter: { visibility: { eq: "public" } },
          },
          mysql_projects: {
            columns: ["id", "name", "description", "status", "created_at"],
            filter: { visibility: { eq: "public" } },
          },
          mssql_projects: {
            columns: ["id", "name", "description", "status", "created_at"],
            filter: { visibility: { eq: "public" } },
          },
        },
      },

      // Org-scoped via the hoisted claim $session.org_id.
      member: {
        tables: {
          pg_projects: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          pg_tasks: {
            columns: "ALL",
            filter: { org_id: { eq: "$session.claims.org_id" } },
            orderBy: [{ column: "priority", direction: "DESC" }],
          },
          pg_comments: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          pg_tags: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          pg_task_tags: "ALL",

          mysql_projects: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          mysql_tasks: {
            columns: "ALL",
            filter: { org_id: { eq: "$session.claims.org_id" } },
            orderBy: [{ column: "priority", direction: "DESC" }],
          },
          mysql_comments: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          mysql_tags: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          mysql_task_tags: "ALL",

          mssql_projects: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          mssql_tasks: {
            columns: "ALL",
            filter: { org_id: { eq: "$session.claims.org_id" } },
            orderBy: [{ column: "priority", direction: "DESC" }],
          },
          mssql_comments: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          mssql_tags: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          mssql_task_tags: "ALL",
        },
        operations: ["dashboard", "createTaskWithComment"],
        queues: ["events"],
      },

      manager: {
        tables: {
          pg_projects: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          pg_tasks: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          pg_comments: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          pg_tags: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          pg_task_tags: "ALL",

          mysql_projects: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          mysql_tasks: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          mysql_comments: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          mysql_tags: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          mysql_task_tags: "ALL",

          mssql_projects: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          mssql_tasks: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          mssql_comments: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          mssql_tags: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          mssql_task_tags: "ALL",
        },
        // Matched on the raw procedure name, so this one key covers project_stats
        // in all three databases.
        storedProcedures: ["project_stats"],
        operations: "ALL",
        queues: "ALL",
      },

      admin: {
        tables: {
          pg_organizations: { columns: "ALL", filter: { id: { eq: "$session.claims.org_id" } } },
          pg_projects: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          pg_tasks: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          pg_comments: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          pg_tags: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          pg_task_tags: "ALL",
          pg_audit_log: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },

          mysql_organizations: { columns: "ALL", filter: { id: { eq: "$session.claims.org_id" } } },
          mysql_projects: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          mysql_tasks: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          mysql_comments: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          mysql_tags: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          mysql_task_tags: "ALL",
          mysql_audit_log: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },

          mssql_organizations: { columns: "ALL", filter: { id: { eq: "$session.claims.org_id" } } },
          mssql_projects: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          mssql_tasks: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          mssql_comments: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          mssql_tags: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          mssql_task_tags: "ALL",
          mssql_audit_log: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
        },
        storedProcedures: "ALL",
        operations: "ALL",
        queues: "ALL",
      },
    },
  },

  operations: {
    ...dashboard,
    ...tasks,
  },

  queues: [
    {
      type: "rabbitmq",
      name: "events",
      enabled: true,
      autoSetup: true,
      connection: {
        hostname: "localhost",
        port: 5672,
        username: "guest",
        password: "guest",
        vhost: "/",
      },
      topics: {
        tasks: { type: "topic", durable: true },
      },
      // Publisher → GraphQL mutation `events_taskAssigned`; also callable from handlers.
      publishers: {
        taskAssigned: { topic: "tasks", routingKey: "task.assigned", persistent: true },
      },
      // Subscriber → GraphQL subscription `events_taskFeed`; handler busts the dashboard cache.
      subscribers: {
        taskFeed: {
          topic: "tasks",
          pattern: "task.*",
          queue: "task-feed",
          durable: true,
          handler: async (_message: { assignee: string }, { cache }) => {
            await cache.invalidate("dashboard", {
              assignee: _message.assignee,
            });
          },
        },
      },
    },
  ],

  cron: [
    {
      name: "overdueSweep",
      pattern: "0 9 * * *", // daily 09:00
      timezone: "UTC",
      protect: true,
      query: `query { pg_tasks(where: { status: { neq: "done" } }) { id title due_date is_overdue } }`,
      onTick: async (_options, _context, response) => {
        const tasks = (response?.data as { pg_tasks?: { is_overdue: boolean }[] })?.pg_tasks ?? [];
        const overdue = tasks.filter((t) => t.is_overdue).length;
        console.log(`[overdueSweep] ${overdue} overdue task(s)`);
      },
    },
  ],

  ai: {
    enabled: true, // POST /ai + GraphQL `ask` (admin-secret only)
    mcp: { enabled: true }, // POST /mcp
  },
} as ConfigurationInput;
