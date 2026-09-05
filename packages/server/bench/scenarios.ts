import type { IntegrationContext } from "../src/__test/integration/harness";
import type { DatabaseType } from "../src/types/configuration";

import { benchField } from "./config";

/**
 * The seven workloads the benchmark covers, expressed against the bench dataset.
 * Two of them are shaped by what Graphoria actually generates:
 *
 * - there are no generated insert/update/delete resolvers, so the write-path
 *   scenario calls a stored routine, which is what a generated `Mutation` field
 *   really does;
 * - caching is a REST-operation feature, so the cached repeat goes over REST
 *   and runs the same query as `list`, making the two directly comparable.
 */

export type Scenario = {
  name: string;
  description: string;
  run: (context: IntegrationContext) => Promise<void>;
};

/** The operation the cached scenario hits. Registered in the bench server config. */
export const CACHED_OPERATION = "cachedTaskPage";
export const CACHED_OPERATION_PATH = "/cached-task-page";

/**
 * MySQL has no native boolean — `BOOLEAN` is `tinyint(1)` and introspects as an
 * Int carrying 0/1 — so a boolean filter argument is not portable across the
 * three engines. SQL Server's `bit` does map to `Boolean`.
 */
const boolArg = (engine: DatabaseType, value: boolean) =>
  engine === "mysql" ? (value ? "1" : "0") : String(value);

/**
 * PostgreSQL routine parameters introspect as String; MySQL and SQL Server
 * carry their declared Int through to the generated field.
 */
const routineArg = (engine: DatabaseType) => (engine === "pg" ? '"4"' : "4");

export const listQuery = (engine: DatabaseType) =>
  `query { ${benchField(engine, "tasks")}(limit: 100, orderBy: [{ id: ASC }]) { id title priority completed } }`;

const AGGREGATES =
  "count min { estimate_hours } max { estimate_hours } sum { estimate_hours } avg { estimate_hours }";

/** Every task in the table, grouped by priority — the heaviest shape available. */
export const aggregateQuery = (engine: DatabaseType) =>
  `query { ${benchField(engine, "tasks")}_aggregate(groupBy: [priority]) { key { priority } ${AGGREGATES} } }`;

/**
 * The same five functions over a slice reachable through the `project_id`
 * index. The unfiltered aggregate is the worst case and reads as the headline
 * number; this is the shape a filtered dashboard query actually has.
 */
export const filteredAggregateQuery = (engine: DatabaseType) =>
  `query { ${benchField(engine, "tasks")}_aggregate(where: { project_id: { lt: 500 } }, groupBy: [priority]) { key { priority } ${AGGREGATES} } }`;

/**
 * A scenario that quietly returns nothing measures parse and dispatch overhead
 * and nothing else, which looks like a spectacular result. Rows — or, for the
 * stored routine, a success flag — are what makes the timing mean anything.
 */
export const assertProductive = (scenario: string, data: Record<string, unknown>) => {
  const productive = Object.values(data).some((value) =>
    Array.isArray(value) ? value.length > 0 : value === true,
  );

  if (!productive) {
    throw new Error(
      `${scenario} produced no rows — the benchmark would be measuring an empty result`,
    );
  }
};

const gql = async (context: IntegrationContext, scenario: string, query: string) => {
  const response = await context.gql(query);

  // A benchmark that silently measures an error path is worse than no
  // benchmark, so every iteration checks.
  if (response.errors?.length) {
    throw new Error(`${scenario} query failed: ${JSON.stringify(response.errors)}`);
  }
  if (!response.data) throw new Error(`${scenario} query returned no data`);

  assertProductive(scenario, response.data);
};

export const scenarios = (engine: DatabaseType): Scenario[] => {
  const tasks = benchField(engine, "tasks");
  const projects = benchField(engine, "projects");
  const routine = benchField(engine, "tasks_by_priority");

  return [
    {
      name: "list",
      description: "100 tasks by primary key, no filter",
      run: (context) => gql(context, "list", listQuery(engine)),
    },
    {
      name: "filtered-list",
      description: "100 tasks filtered on an indexed (priority, completed) pair",
      run: (context) =>
        gql(
          context,
          "filtered-list",
          `query { ${tasks}(where: { priority: { eq: 5 }, completed: { eq: ${boolArg(engine, false)} } }, limit: 100, orderBy: [{ id: ASC }]) { id title priority } }`,
        ),
    },
    {
      name: "nested",
      description: "100 projects, each with its first 10 tasks — two levels, one statement",
      run: (context) =>
        gql(
          context,
          "nested",
          `query { ${projects}(limit: 100, orderBy: [{ id: ASC }]) { id name ${tasks}(limit: 10, orderBy: [{ id: ASC }]) { id title } } }`,
        ),
    },
    {
      name: "aggregate",
      description: "count/min/max/sum/avg over all 100k tasks, grouped by priority",
      run: (context) => gql(context, "aggregate", aggregateQuery(engine)),
    },
    {
      name: "filtered-aggregate",
      description: "the same five functions over the ~5k tasks of the first 499 projects",
      run: (context) => gql(context, "filtered-aggregate", filteredAggregateQuery(engine)),
    },
    {
      name: "procedure",
      description: "stored routine through a Mutation field — the only generated write path",
      run: (context) =>
        gql(context, "procedure", `mutation { ${routine}(min_priority: ${routineArg(engine)}) }`),
    },
    {
      name: "cached-repeat",
      description: `the \`list\` query as a REST operation with a 60s TTL, served from Redis`,
      run: async (context) => {
        const response = await context.rest(CACHED_OPERATION_PATH);
        if (!response.ok) {
          throw new Error(`cached operation returned ${response.status}: ${await response.text()}`);
        }
        const body = (await response.json()) as { data?: Record<string, unknown> };
        assertProductive("cached-repeat", body.data ?? {});
      },
    },
  ];
};
