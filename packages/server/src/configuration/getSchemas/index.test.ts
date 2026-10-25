process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

import { describe, expect, it } from "bun:test";

const { getSchema } = await import(".");
const { sourcesForEachRole } = await import("../../databases/high-level-operations");
const { AuthZod } = await import("../../types/zod/auth");
const { QueueConfigZod } = await import("../../types/zod/queue");

const events = QueueConfigZod.parse({
  type: "rabbitmq",
  name: "events",
  connection: { hostname: "x", port: 5672 },
  publishers: {
    bookAdded: { topic: "books", routingKey: "book.added" },
    bookPublished: { topic: "books", routingKey: "book.published" },
  },
  subscribers: {
    onBookAdded: { topic: "books", pattern: "book.added" },
    onBookPublished: { topic: "books", pattern: "book.published" },
  },
  topics: { books: {} },
});

// The schema a `reader` granted `queues` gets, as the server builds it.
const readerSchema = (queues: unknown) => {
  const auth = AuthZod.parse({
    enabled: true,
    database: "main",
    permissions: { reader: { queues } },
  });
  const { reader } = sourcesForEachRole([], [], [events], {}, auth!.permissions);

  return getSchema(reader!);
};

const fieldsOf = (type: { getFields: () => object } | null | undefined) =>
  Object.keys(type?.getFields() ?? {});

describe("queue grants in a role's schema", () => {
  it("compiles only the subscriber a role is granted", () => {
    const { schema } = readerSchema({ events: { subscribers: ["onBookPublished"] } });

    expect(fieldsOf(schema.getSubscriptionType())).toEqual(["events_onBookPublished"]);
    expect(fieldsOf(schema.getMutationType())).toEqual([]);
  });

  it("fails validation for what the grant leaves out", () => {
    const role = readerSchema({ events: { subscribers: ["onBookPublished"] } });
    const errorsOf = (query: string) =>
      role.handlers.gql.hasErrors(query).validationErrors.map((error) => error.message);

    expect(errorsOf("subscription { events_onBookPublished { id message } }")).toEqual([]);
    expect(errorsOf("subscription { events_onBookAdded { id message } }")).toEqual([
      'Cannot query field "events_onBookAdded" on type "Subscription". Did you mean "events_onBookPublished"?',
    ]);
    expect(errorsOf('mutation { events_bookAdded(data: "{}") }')).toEqual([
      "The mutation operation is not supported by the schema.",
    ]);
  });

  it("compiles every publisher and subscriber of a queue granted whole", () => {
    const { schema } = readerSchema({ events: "ALL" });

    expect(fieldsOf(schema.getMutationType())).toEqual([
      "events_bookAdded",
      "events_bookPublished",
    ]);
    expect(fieldsOf(schema.getSubscriptionType())).toEqual([
      "events_onBookAdded",
      "events_onBookPublished",
    ]);
  });

  it("compiles no queue field for a grant that grants nothing", () => {
    const { schema } = readerSchema({ events: {} });

    expect(fieldsOf(schema.getMutationType())).toEqual([]);
    expect(fieldsOf(schema.getSubscriptionType())).toEqual([]);
  });
});
