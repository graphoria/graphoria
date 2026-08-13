import { describe, expect, it } from "bun:test";

import type { EntitiesOfRole } from "../../../databases/high-level-operations";

import { EntitySource } from "../../../types/resolver";
import { mergeEntities } from ".";

const buildEntitiesOfRole = (): EntitiesOfRole =>
  ({
    tables: [],
    storedProcedures: [],
    queues: [
      {
        name: "events",
        exchanges: [
          {
            name: "orders",
            publishers: [
              {
                name: "orderCreated",
                resolverName: "events_orderCreated",
                routingKey: "order.created",
              },
            ],
          },
        ],
        queues: [
          {
            name: "orderUpdates",
            bindings: [{ exchange: "orders", pattern: "order.*" }],
          },
        ],
      },
    ],
    operations: {},
  }) as unknown as EntitiesOfRole;

describe("mergeEntities queue registration", () => {
  it("registers publishers as QUEUE_PUBLISHER", () => {
    const merged = mergeEntities(buildEntitiesOfRole());
    expect(merged.getResolverSource("events_orderCreated")).toBe(EntitySource.QUEUE_PUBLISHER);
  });

  it("registers subscribers as QUEUE_SUBSCRIBER", () => {
    const merged = mergeEntities(buildEntitiesOfRole());
    expect(merged.getResolverSource("events_orderUpdates")).toBe(EntitySource.QUEUE_SUBSCRIBER);
  });

  it("keeps queuesMap publisher-only", () => {
    const merged = mergeEntities(buildEntitiesOfRole());
    expect(merged.queuesMap["events_orderCreated"]).toBeDefined();
    expect(merged.queuesMap["events_orderUpdates"]).toBeUndefined();
  });

  it("exposes the subscriber object on its resolver entry", () => {
    const merged = mergeEntities(buildEntitiesOfRole());
    const entry = merged.getResolverEntry("events_orderUpdates");
    expect(entry?.source).toBe(EntitySource.QUEUE_SUBSCRIBER);
    expect((entry?.resolver as { name: string } | undefined)?.name).toBe("orderUpdates");
  });
});

describe("mergeEntities resolver name collisions", () => {
  const tablesOfRole = (tables: unknown[]): EntitiesOfRole =>
    ({
      tables,
      storedProcedures: [],
      queues: [],
      operations: {},
    }) as unknown as EntitiesOfRole;

  const table = (schema: string, name: string, resolverName: string) => ({
    schema,
    name,
    resolverName,
    internalName: resolverName,
    columns: [],
    relationships: [],
    relationshipsReversed: [],
  });

  // Sanitisation is not injective: `categoría` and `categor_a` both land on
  // `catalog_categoria`. Registering both would silently serve one table's rows
  // under the other's name.
  it("fails naming both tables when two of them sanitise to one resolver name", () => {
    expect(() =>
      mergeEntities(
        tablesOfRole([
          table("catalog", "categoría", "catalog_categoria"),
          table("catalog", "categor_a", "catalog_categoria"),
        ]),
      ),
    ).toThrow(/catalog_categoria.*catalog\.categoría.*catalog\.categor_a/s);
  });

  it("accepts tables whose resolver names differ", () => {
    expect(() =>
      mergeEntities(
        tablesOfRole([
          table("catalog", "categoría", "catalog_categoria"),
          table("catalog", "products", "catalog_products"),
        ]),
      ),
    ).not.toThrow();
  });
});
