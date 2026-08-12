import {
  virtualColumnExpression,
  virtualColumnFunction,
  type ConfigurationInput,
} from "@graphoria/server/config";

import { tasklyRepository } from "./repository";
import { dashboard } from "./operations/dashboard";
import { tasks } from "./operations/tasks";

export default {
  name: "taskly",
  version: "1.0.0",

  // Swap to "paseto_local" / "paseto_public" (or set AUTH_STRATEGY) for the other strategies.
  tokenStrategy: "jwt",

  databases: [
    {
      name: "main",
      type: "pg",
      enabled: true,
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

      // Raw-SQL repository → typed access from operation handlers (options.repository.main).
      repository: tasklyRepository,

      schema: {
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
  ],

  auth: {
    enabled: true,
    database: "main",
    schema: "auth",
    autoCreateTables: true,
    permissions: {
      // No token → anonymous. Public projects only, safe column subset.
      anonymous: {
        tables: {
          public_projects: {
            columns: ["id", "name", "description", "status", "created_at"],
            filter: { visibility: { eq: "public" } },
          },
        },
      },

      // Org-scoped via the hoisted claim $session.org_id.
      member: {
        tables: {
          public_projects: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          public_tasks: {
            columns: "ALL",
            filter: { org_id: { eq: "$session.claims.org_id" } },
            orderBy: [{ column: "priority", direction: "DESC" }],
          },
          public_comments: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          public_tags: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          public_task_tags: "ALL",
        },
        operations: ["dashboard", "createTaskWithComment"],
        queues: ["events"],
      },

      manager: {
        tables: {
          public_projects: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          public_tasks: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          public_comments: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          public_tags: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          public_task_tags: "ALL",
        },
        storedProcedures: ["project_stats"],
        operations: "ALL",
        queues: "ALL",
      },

      admin: {
        tables: {
          public_organizations: {
            columns: "ALL",
            filter: { id: { eq: "$session.claims.org_id" } },
          },
          public_projects: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          public_tasks: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          public_comments: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          public_tags: { columns: "ALL", filter: { org_id: { eq: "$session.claims.org_id" } } },
          public_task_tags: "ALL",
          public_audit_log: {
            columns: "ALL",
            filter: { org_id: { eq: "$session.claims.org_id" } },
          },
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
      query: `query { public_tasks(where: { status: { neq: "done" } }) { id title due_date is_overdue } }`,
      onTick: async (_options, _context, response) => {
        const tasks =
          (response?.data as { public_tasks?: { is_overdue: boolean }[] })?.public_tasks ?? [];
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
