process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

import { describe, expect, it } from "bun:test";

import type { RemoteRESTResolved } from "../../remoteREST/types";
import type { Env } from "../../types/env";

import { fragmentFanOut } from "../../__test/fragmentFanOut";

const { getSchema } = await import("../getSchemas");
const { StoreMSSQL } = await import("../../__test/dataset/store");
const { generateOpenAPI } = await import("./generateOpenAPI");
const { OperationsZod } = await import("../../config");

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
});
