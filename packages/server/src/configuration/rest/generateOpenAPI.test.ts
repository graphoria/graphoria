process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

import { describe, expect, it } from "bun:test";
import { buildSchema } from "graphql";
import { z } from "zod";

import type { RemoteRESTResolved } from "../../remoteREST/types";
import type { Env } from "../../types/env";

import { fragmentFanOut } from "../../__test/fragmentFanOut";

const { getSchema } = await import("../getSchemas");
const { StoreMSSQL } = await import("../../__test/dataset/store");
const { generateOpenAPI, operationDataSchema } = await import("./generateOpenAPI");
const { OperationsZod } = await import("../../config");
const { createMockMSSQL, createMockMySQL, createMockPG, createMockSQLite } =
  await import("../../__test/common");
const { DatabaseStructureZod } = await import("../../types/db");
const { ConfigurationZod } = await import("../../types/zod/configuration");
const { transformRemoteSchema } = await import("../../remoteSchemas/transform");

const options = {
  prefix: "",
  restApiPrefix: "/rest",
  admin: { header: "x-admin-secret" },
} as Env;

const dataSchemaFor = (query: string) => {
  const role = getSchema({
    tables: StoreMSSQL.tables,
    storedProcedures: [],
    queues: [],
    operations: OperationsZod.parse({
      probe: { query, rest: { path: "/probe", method: "GET" } },
    }),
    remoteSchemas: [],
    remoteREST: [],
  });

  const spec = generateOpenAPI({ role, options });

  // oxlint-disable-next-line typescript/no-explicit-any
  return (spec.paths!["/probe"] as any).get.responses[200].content["application/json"].schema
    .properties.data;
};

const specFor = (query: string) => dataSchemaFor(query).properties;

describe("generateOpenAPI", () => {
  it("names the admin-secret header the server reads", () => {
    const role = getSchema({
      tables: StoreMSSQL.tables,
      storedProcedures: [],
      queues: [],
      operations: OperationsZod.parse({}),
      remoteSchemas: [],
      remoteREST: [],
    });

    const spec = generateOpenAPI({
      role,
      options: { ...options, admin: { ...options.admin, header: "x-graphoria-key" } },
    });

    expect(spec.components?.securitySchemes?.["Admin Secret"]).toEqual({
      description: "API key authentication via custom header",
      type: "apiKey",
      in: "header",
      name: "x-graphoria-key",
    });
  });

  it("types columns selected under an aggregate's key from the grouped table", () => {
    const data = specFor(`
      query {
        dbo_order_items_aggregate(groupBy: [product_id]) {
          key {
            product_id
          }
        }
      }
    `);

    expect(data.dbo_order_items_aggregate.items.properties.key.properties.product_id.type).toBe(
      "number",
    );
  });

  it("types the aggregate's count, numeric aggregates and items", () => {
    const data = specFor(`
      query {
        dbo_order_items_aggregate(groupBy: [product_id]) {
          count
          avg {
            unit_price
          }
          sum {
            quantity
          }
          items {
            quantity
          }
        }
      }
    `);

    const agg = data.dbo_order_items_aggregate.items.properties;

    expect(agg.count.type).toBe("number");
    expect(agg.avg.properties.unit_price.type).toBe("number");
    expect(agg.sum.properties.quantity.type).toBe("number");
    expect(agg.items.type).toBe("array");
    expect(agg.items.items.properties.quantity.type).toBe("number");
  });

  it("keeps resolving plain table selections and their relationships", () => {
    const data = specFor(`
      query {
        dbo_addresses {
          address_id
          line1
          is_default
          dbo_customers {
            email
            created_at
          }
        }
      }
    `);

    const address = data.dbo_addresses.items.properties;

    expect(address.address_id.type).toBe("number");
    expect(address.line1.type).toBe("string");
    expect(address.is_default.type).toBe("boolean");
    expect(address.dbo_customers.properties.email.type).toBe("string");
    expect(address.dbo_customers.properties.created_at.type).toBe("string");
  });

  it("marks a field nullable unless the schema declares it non-null", () => {
    const data = specFor(`
      query {
        dbo_addresses {
          address_id
          line1
        }
      }
    `);

    const address = data.dbo_addresses.items.properties;

    expect(address.address_id.nullable).toBe(false);
    expect(address.line1.nullable).toBe(true);
  });

  it("lists the root __typename beside the data fields", () => {
    const data = dataSchemaFor(`
      query {
        __typename
        dbo_addresses {
          address_id
        }
      }
    `);

    expect(data.properties.__typename).toEqual({ type: "string", nullable: false });
    expect(data.properties.dbo_addresses.type).toBe("array");
    expect(data.required).toContain("__typename");
  });

  it("lists a __typename below the root, required unless a directive may skip it", () => {
    const address = specFor(`
      query {
        dbo_addresses {
          __typename
          dbo_customers {
            __typename @skip(if: true)
          }
        }
      }
    `).dbo_addresses.items;

    expect(address.properties.__typename).toEqual({ type: "string", nullable: false });
    expect(address.required).toContain("__typename");
    expect(address.properties.dbo_customers.properties.__typename).toEqual({
      type: "string",
      nullable: true,
    });
    expect(address.properties.dbo_customers.required).not.toContain("__typename");
  });

  it("types a root __type's selection from the introspection types", () => {
    const product = specFor(`
      query {
        product: __type(name: "dbo_products") {
          name
          kind
          fields {
            isDeprecated
          }
        }
      }
    `).product;

    expect(product.type).toBe("object");
    expect(product.nullable).toBe(true);
    expect(product.properties.name).toEqual({ type: "string", nullable: true });
    expect(product.properties.kind).toEqual({ type: "string", nullable: false });
    expect(product.required).toEqual(["kind"]);
    expect(product.properties.fields.type).toBe("array");
    expect(product.properties.fields.nullable).toBe(true);
    expect(product.properties.fields.items.properties.isDeprecated).toEqual({
      type: "boolean",
      nullable: false,
    });
  });

  it("follows fragments and lists of leaves under __schema", () => {
    const schema = specFor(`
      query {
        __schema {
          directives {
            locations
          }
          types {
            ...Named
          }
        }
      }
      fragment Named on __Type {
        name
      }
    `).__schema.properties;

    expect(schema.directives.items.properties.locations).toEqual({
      type: "array",
      items: { type: "string", nullable: false },
      nullable: false,
    });
    expect(schema.types.items.properties.name).toEqual({ type: "string", nullable: true });
  });

  it("leaves a conditionally included meta field out of required", () => {
    const data = dataSchemaFor(`
      query ($bare: Boolean!) {
        __typename @skip(if: $bare)
      }
    `);

    expect(data.properties.__typename).toEqual({ type: "string", nullable: true });
    expect(data.required).toEqual([]);
  });

  it("merges a meta field selected twice, as execution does", () => {
    const product = specFor(`
      query {
        product: __type(name: "dbo_products") {
          kind
          fields {
            name
          }
          ...More
        }
      }
      fragment More on __Type {
        kind
        fields {
          isDeprecated
        }
      }
    `).product;

    expect(product.required).toEqual(["kind"]);
    expect(Object.keys(product.properties.fields.items.properties)).toEqual([
      "name",
      "isDeprecated",
    ]);
  });

  it("requires a meta field only where some selection of it cannot be skipped", () => {
    const field = specFor(`
      query ($full: Boolean!) {
        product: __type(name: "dbo_products") {
          fields {
            ... @include(if: $full) {
              name
              isDeprecated
            }
            isDeprecated
          }
        }
      }
    `).product.properties.fields.items;

    expect(field.required).toEqual(["isDeprecated"]);
  });

  it("collects a fragment once per selection, however often it is spread", () => {
    const started = performance.now();

    expect(specFor(fragmentFanOut(26, "dbo_products")).__type.properties.name.type).toBe("string");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("describes no meta field of a query that fails validation", () => {
    expect(
      specFor(`
        query {
          __type(name: "dbo_products") {
            ...A
          }
        }
        fragment A on __Type {
          ofType {
            ...B
          }
        }
        fragment B on __Type {
          ofType {
            ...A
          }
        }
      `),
    ).toEqual({});
  });

  describe("a query's fragments", () => {
    const productOf = (query: string) => specFor(query).dbo_products.items;

    it.each([
      ["a named fragment", "...P"],
      ["an inline fragment", "... on dbo_products { name }"],
      ["an untyped inline fragment", "... { name }"],
    ])("describes the fields %s selects", (_case, selection) => {
      const { properties } = productOf(
        `query { dbo_products { ${selection} } } ${
          selection === "...P" ? "fragment P on dbo_products { name }" : ""
        }`,
      );

      expect(Object.keys(properties)).toEqual(["name"]);
    });

    it("describes a field selected in and out of a fragment once", () => {
      const { properties } = productOf(
        "query { dbo_products { name ...P } } fragment P on dbo_products { name product_id }",
      );

      expect(Object.keys(properties)).toEqual(["name", "product_id"]);
    });

    it("describes the fields of a root-level fragment", () => {
      const data = dataSchemaFor("query { ...R } fragment R on Query { dbo_products { name } }");

      expect(Object.keys(data.properties)).toEqual(["dbo_products"]);
      expect(Object.keys(data.properties.dbo_products.items.properties)).toEqual(["name"]);
    });

    it("describes a root-level fragment's __typename as a meta field", () => {
      const data = dataSchemaFor(
        "query { ...R } fragment R on Query { __typename dbo_products { name } }",
      );

      expect(Object.keys(data.properties).sort()).toEqual(["__typename", "dbo_products"]);
      expect(data.properties.__typename.type).toBe("string");
    });

    it("requires a field a plain fragment selects", () => {
      expect(
        productOf("query { dbo_products { ...P } } fragment P on dbo_products { name }").required,
      ).toEqual(["name"]);
    });

    it.each([
      ["named", "...P @include(if: $x)", "fragment P on dbo_products { name }"],
      ["inline", "... @include(if: $x) { name }", ""],
      [
        "nested inside a conditional one",
        "...P @skip(if: $x)",
        "fragment P on dbo_products { ... { name } }",
      ],
    ])(
      "does not require a field under a %s fragment a directive can exclude",
      (_case, spread, rest) => {
        const product = productOf(`query Q($x: Boolean!) { dbo_products { ${spread} } } ${rest}`);

        expect(Object.keys(product.properties)).toEqual(["name"]);
        expect(product.required).toEqual([]);
      },
    );

    it("requires a field also selected outside the conditional fragment", () => {
      expect(
        productOf("query Q($x: Boolean!) { dbo_products { name ... @skip(if: $x) { name } } }")
          .required,
      ).toEqual(["name"]);
    });

    it("leaves a query that fails validation unexpanded", () => {
      expect(() =>
        specFor(`
          query { dbo_products { ...A } }
          fragment A on dbo_products { dbo_product_categories { dbo_products { ...A } } }
        `),
      ).not.toThrow();
    });
  });

  // A handler's REST answer is the JSON of what it returns, while a query's
  // sits inside `data`: /openapi.json used to wrap both.
  it("describes a handler's answer without the data envelope a query's has", () => {
    const book = z.object({ id: z.number().int(), title: z.string() });
    const role = getSchema({
      tables: StoreMSSQL.tables,
      storedProcedures: [],
      queues: [],
      operations: OperationsZod.parse({
        publishBook: {
          input: z.object({ id: z.number().int() }),
          output: book.nullable(),
          rest: { path: "/publish-book", method: "POST", body: z.object({ id: z.number().int() }) },
          handler: () => null,
        },
        addresses: {
          query: "query { dbo_addresses { address_id } }",
          output: z.object({ dbo_addresses: z.array(z.object({ address_id: z.number() })) }),
          rest: { path: "/addresses", method: "GET" },
        },
      }),
      remoteSchemas: [],
      remoteREST: [],
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    const paths = generateOpenAPI({ role, options }).paths as any;
    const handlerSchema =
      paths["/publish-book"].post.responses[200].content["application/json"].schema;
    const querySchema = paths["/addresses"].get.responses[200].content["application/json"].schema;

    expect(handlerSchema.properties).toBeUndefined();
    // oxlint-disable-next-line typescript/no-explicit-any
    expect(handlerSchema.anyOf.map((branch: any) => branch.type)).toEqual(["object", "null"]);
    expect(Object.keys(querySchema.properties)).toEqual(["data"]);
    expect(querySchema.properties.data.properties.dbo_addresses.type).toBe("array");
  });

  it("adds the paths of the role's remote REST APIs", () => {
    const payments: RemoteRESTResolved = {
      config: { name: "payments" },
      prefix: "payments",
      baseUrl: "http://payments.test",
      routes: [],
      openApiPaths: { "/payments/charges": { get: { responses: {} } } },
      openApiSchemas: {},
    };

    const role = getSchema({
      tables: StoreMSSQL.tables,
      storedProcedures: [],
      queues: [],
      operations: OperationsZod.parse({}),
      remoteSchemas: [],
      remoteREST: [payments],
    });

    const spec = generateOpenAPI({ role, options });

    expect(spec.paths?.["/payments/charges"]).toEqual({ get: { responses: {} } });
  });

  it("opens the agent's route to bearer tokens as well as the admin secret", () => {
    const role = getSchema({
      tables: StoreMSSQL.tables,
      storedProcedures: [],
      queues: [],
      operations: OperationsZod.parse({}),
      remoteSchemas: [],
      remoteREST: [],
    });

    const spec = generateOpenAPI({ role, options, ai: { path: "/ai" } });

    // oxlint-disable-next-line typescript/no-explicit-any
    const post = (spec.paths!["/ai"] as any).post;
    expect(post.security).toEqual([{ "HTTP Bearer Token": [] }, { "Admin Secret": [] }]);
    expect(post.responses["404"].description).toBe(
      "Not found (the caller's role is not granted `ai`)",
    );
  });

  it("describes the agent's answer and the queries it ran", () => {
    const role = getSchema({
      tables: StoreMSSQL.tables,
      storedProcedures: [],
      queues: [],
      operations: OperationsZod.parse({}),
      remoteSchemas: [],
      remoteREST: [],
    });

    const spec = generateOpenAPI({ role, options, ai: { path: "/ai" } });

    // oxlint-disable-next-line typescript/no-explicit-any
    const post = (spec.paths!["/ai"] as any).post;
    expect(post.responses["200"].content["application/json"].schema).toEqual({
      type: "object",
      properties: {
        answer: { type: "string" },
        queries: {
          type: "array",
          items: { type: "string" },
          description: "Each GraphQL query the agent ran that returned, in run order",
        },
      },
      required: ["answer", "queries"],
    });
  });
});

describe("operationDataSchema", () => {
  it("is the schema the document gives the answer's data", () => {
    const role = getSchema({
      tables: StoreMSSQL.tables,
      storedProcedures: [],
      queues: [],
      operations: OperationsZod.parse({
        probe: {
          query: "query { dbo_categories { name slug } }",
          rest: { path: "/probe", method: "GET" },
        },
      }),
      remoteSchemas: [],
      remoteREST: [],
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    const documented = (generateOpenAPI({ role, options }).paths!["/probe"] as any).get
      .responses[200].content["application/json"].schema.properties.data;

    expect(operationDataSchema(role.handlers.rest.operationsEnhanced["probe"]!, role)).toEqual(
      documented,
    );
  });
});

describe("data schema of what the server answers", () => {
  type EntitiesOfRole = Parameters<typeof getSchema>[0];
  const roleWith = (
    operations: Record<string, unknown>,
    entities: Partial<Omit<EntitiesOfRole, "operations">> = {},
  ) =>
    getSchema({
      tables: StoreMSSQL.tables,
      storedProcedures: [],
      queues: [],
      remoteSchemas: [],
      remoteREST: [],
      ...entities,
      operations: OperationsZod.parse(operations),
    });
  const probe = (query: string, method: "GET" | "POST" = "GET") => ({
    probe: { query, rest: { path: "/probe", method } },
  });
  // oxlint-disable-next-line typescript/no-explicit-any
  const dataOf = (role: ReturnType<typeof roleWith>, method = "get"): any =>
    // oxlint-disable-next-line typescript/no-explicit-any
    (generateOpenAPI({ role, options }).paths!["/probe"] as any)[method].responses[200].content[
      "application/json"
    ].schema.properties.data;

  it("types a column by its last transform directive", () => {
    const data = dataOf(
      roleWith(
        probe(`query {
          dbo_categories {
            name @uppercase
            category_id @multiply(by: 2)
            slug @uppercase @round
            parent_category_id @default(value: "0")
          }
          dbo_addresses { line1 @default(value: "-") }
        }`),
      ),
    );

    expect(data.properties.dbo_categories.items.properties).toEqual({
      name: { type: "string", nullable: false },
      category_id: { type: "number", nullable: false },
      slug: { type: "number", nullable: false },
      parent_category_id: {},
    });
    expect(data.properties.dbo_addresses.items.properties.line1).toEqual({
      type: "string",
      nullable: true,
    });
  });

  it("types a groupBy key and its items by their directives, an aggregate value by its GraphQL type", () => {
    const data = dataOf(
      roleWith(
        probe(`query {
          dbo_categories_aggregate(groupBy: [name]) {
            key { name @multiply(by: 1) }
            items { name @round }
            min { category_id @uppercase }
          }
        }`),
      ),
    );
    const group = data.properties.dbo_categories_aggregate.items.properties;

    expect(group.key.properties.name).toEqual({ type: "number", nullable: false });
    expect(group.items.items.properties.name).toEqual({ type: "number", nullable: false });
    expect(group.min.properties.category_id).toEqual({ type: "number", nullable: true });
  });

  it("types a transform on a virtual column", () => {
    const tables = StoreMSSQL.tables.map((table) =>
      table.resolverName === "dbo_categories"
        ? {
            ...table,
            columns: [
              ...table.columns,
              {
                name: "label",
                fieldName: "label",
                dataType: "nvarchar",
                isNullable: false,
                description: null,
                virtual: true,
                expression: "name + slug",
              },
            ],
          }
        : table,
    ) as unknown as typeof StoreMSSQL.tables;

    const data = dataOf(roleWith(probe("query { dbo_categories { label @round } }"), { tables }));

    expect(data.properties.dbo_categories.items.properties.label).toEqual({
      type: "number",
      nullable: false,
    });
  });

  const docsOn = (create: typeof createMockPG, extra: Record<string, unknown>[] = []) =>
    create(
      DatabaseStructureZod.parse({
        tables: [
          {
            schema: "public",
            name: "docs",
            entityType: "table",
            tableDescription: null,
            foreignKeys: [],
            columns: [
              { name: "id", dataType: "integer", isNullable: false },
              { name: "body", dataType: "json", isNullable: true },
              { name: "meta", dataType: "jsonb", isNullable: true },
              { name: "tags", dataType: "ARRAY", isNullable: true },
              ...extra,
            ],
          },
        ],
        storedProcedures: [],
      }),
    );
  const text = { type: "string", nullable: true };

  const flagBit = { name: "flag", dataType: "bit", isNullable: true };
  const flag = { type: "string", nullable: true };

  it.each([
    [
      "pg",
      createMockPG,
      {
        body: {},
        meta: {},
        tags: {},
        price: { type: "string", nullable: false },
        flag,
      },
      [{ name: "price", dataType: "money", isNullable: false }, flagBit],
    ],
    [
      "mysql",
      createMockMySQL,
      { body: {}, meta: text, tags: text, flag, built: { type: "number", nullable: false } },
      [flagBit, { name: "built", dataType: "year", isNullable: false }],
    ],
    ["sqlite", createMockSQLite, { body: text, meta: text, tags: text }, []],
    ["mssql", createMockMSSQL, { body: text, meta: text, tags: text }, []],
  ])("types JSON and array columns as %s answers them", (_engine, create, expected, extra) => {
    const data = dataOf(
      roleWith(probe(`query { public_docs { ${Object.keys(expected).join(" ")} } }`), {
        tables: docsOn(create, extra).tables,
      }),
    );

    expect(data.properties.public_docs.items.properties).toEqual(expected);
  });

  it("types a stored procedure's answer, a root with no selection set", () => {
    const { storedProcedures } = createMockPG(
      DatabaseStructureZod.parse({
        tables: [],
        storedProcedures: [{ schema: "public", name: "refresh_stats", parameters: [] }],
      }),
    );
    const name = Object.keys(
      roleWith({}, { tables: [], storedProcedures }).schema.getMutationType()!.getFields(),
    ).find((field) => field.includes("refresh_stats"))!;

    const data = dataOf(
      roleWith(probe(`mutation { ${name} }`, "POST"), { tables: [], storedProcedures }),
      "post",
    );

    expect(data).toEqual({
      type: "object",
      properties: { [name]: { type: "boolean", nullable: false } },
      required: [name],
    });
  });

  it("types a queue publisher's answer", () => {
    const { queues } = ConfigurationZod.parse({
      name: "publisher-test",
      version: "1.0.0",
      queues: [
        {
          type: "rabbitmq",
          name: "events",
          enabled: true,
          connection: {
            hostname: "localhost",
            port: 5672,
            username: "u",
            password: "p",
            vhost: "/",
          },
          publishers: { bookAdded: { topic: "books", routingKey: "book.added" } },
          topics: { books: { type: "topic" } },
        },
      ],
    });

    const data = dataOf(
      roleWith(probe('mutation { events_bookAdded(data: "{}") }', "POST"), { queues }),
      "post",
    );

    expect(data.properties.events_bookAdded).toEqual({ type: "boolean", nullable: false });
  });

  // The output type declares the lists `[String]!` and `[Int]!`.
  it("types an operation output's scalar lists, their items nullable as GraphQL's", () => {
    const data = dataOf(
      roleWith({
        makeTags: {
          handler: async () => ({ tags: ["a"], counts: [1] }),
          output: z.object({ tags: z.array(z.string()), counts: z.array(z.number().int()) }),
          rest: { path: "/make-tags", method: "POST" },
        },
        ...probe("mutation { makeTags { tags counts } }", "POST"),
      }),
      "post",
    );

    expect(data.properties.makeTags.properties).toEqual({
      tags: { type: "array", items: { type: "string", nullable: true }, nullable: false },
      counts: { type: "array", items: { type: "number", nullable: true }, nullable: false },
    });
  });

  it("types a remote's scalars and lists, and leaves its custom scalars and unions untyped", () => {
    const remote = transformRemoteSchema(
      buildSchema(`
        scalar JSON
        type Cat { id: ID! name: String }
        type Dog { id: ID! barks: Boolean }
        union Pet = Cat | Dog
        type Query { count: Int! tags: [String!] info: JSON pets: [Pet] }
      `),
      { name: "ext", url: "http://127.0.0.1:1/graphql" },
    );

    const data = dataOf(
      roleWith(
        probe("query { ext_count ext_tags ext_info ext_pets { ... on ext_Dog { barks } } }"),
        {
          remoteSchemas: [remote],
        },
      ),
    );

    expect(data.properties).toEqual({
      ext_count: { type: "number", nullable: false },
      ext_tags: { type: "array", items: { type: "string", nullable: false }, nullable: true },
      ext_info: {},
      ext_pets: { type: "array", items: {} },
    });
  });

  it("leaves a field under @when out of required, and a root meta field under it in", () => {
    const data = dataOf(
      roleWith(
        probe(`query ($on: Boolean!) {
          __typename @when(and: [$on])
          dbo_categories { name @when(and: [$on]) slug ...Rest }
        }
        fragment Rest on dbo_categories { category_id @when(or: [$on]) }`),
      ),
    );

    expect(data.required).toContain("__typename");
    expect(data.properties.dbo_categories.items.required).toEqual(["slug"]);
  });
});
