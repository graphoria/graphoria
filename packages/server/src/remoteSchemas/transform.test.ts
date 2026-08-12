import { describe, expect, it } from "bun:test";
import { buildSchema } from "graphql";

import { transformRemoteSchema } from "./transform";

// Helper: build a minimal remote schema to transform
const buildTestSchema = (sdl: string) => buildSchema(sdl);

describe("Remote Schema Transform", () => {
  it("should prefix object types", () => {
    const schema = buildTestSchema(`
      type Query {
        user(id: ID!): User
      }
      type User {
        id: ID!
        name: String!
        email: String
      }
    `);

    const result = transformRemoteSchema(schema, {
      name: "stripe",
      url: "http://localhost:4000/graphql",
    });

    expect(result.prefix).toBe("stripe_");
    expect(result.typeDefsSDL).toContain("type stripe_User");
    expect(result.typeDefsSDL).toContain("id: ID!");
    expect(result.typeDefsSDL).toContain("name: String!");
    expect(result.typeDefsSDL).toContain("email: String");
  });

  it("should prefix query fields", () => {
    const schema = buildTestSchema(`
      type Query {
        users: [User!]!
        user(id: ID!): User
      }
      type User {
        id: ID!
        name: String!
      }
    `);

    const result = transformRemoteSchema(schema, {
      name: "remote",
      url: "http://localhost:4000/graphql",
    });

    expect(result.queryFields).toHaveLength(2);

    const usersField = result.queryFields.find((f) => f.originalName === "users");
    expect(usersField).toBeDefined();
    expect(usersField!.prefixedName).toBe("remote_users");
    expect(usersField!.sdl).toContain("remote_users");
    expect(usersField!.sdl).toContain("[remote_User!]!");

    const userField = result.queryFields.find((f) => f.originalName === "user");
    expect(userField).toBeDefined();
    expect(userField!.prefixedName).toBe("remote_user");
    expect(userField!.sdl).toContain("(id: ID!)");
  });

  it("should prefix mutation fields", () => {
    const schema = buildTestSchema(`
      type Query {
        _placeholder: String
      }
      type Mutation {
        createUser(name: String!): User!
      }
      type User {
        id: ID!
        name: String!
      }
    `);

    const result = transformRemoteSchema(schema, {
      name: "api",
      url: "http://localhost:4000/graphql",
    });

    expect(result.mutationFields).toHaveLength(1);
    expect(result.mutationFields[0].originalName).toBe("createUser");
    expect(result.mutationFields[0].prefixedName).toBe("api_createUser");
    expect(result.mutationFields[0].sdl).toContain("api_User!");
  });

  it("should prefix input types", () => {
    const schema = buildTestSchema(`
      type Query {
        users(filter: UserFilter): [User!]!
      }
      input UserFilter {
        name: String
        active: Boolean
      }
      type User {
        id: ID!
        name: String!
      }
    `);

    const result = transformRemoteSchema(schema, {
      name: "svc",
      url: "http://localhost:4000/graphql",
    });

    expect(result.typeDefsSDL).toContain("input svc_UserFilter");
    expect(result.queryFields[0].sdl).toContain("svc_UserFilter");
  });

  it("should prefix enum types", () => {
    const schema = buildTestSchema(`
      type Query {
        users(sort: SortOrder): [User!]!
      }
      enum SortOrder {
        ASC
        DESC
      }
      type User {
        id: ID!
      }
    `);

    const result = transformRemoteSchema(schema, {
      name: "ext",
      url: "http://localhost:4000/graphql",
    });

    expect(result.typeDefsSDL).toContain("enum ext_SortOrder");
    expect(result.typeDefsSDL).toContain("ASC");
    expect(result.typeDefsSDL).toContain("DESC");
  });

  it("should not prefix built-in scalar types", () => {
    const schema = buildTestSchema(`
      type Query {
        value: String
      }
    `);

    const result = transformRemoteSchema(schema, {
      name: "test",
      url: "http://localhost:4000/graphql",
    });

    // Built-in scalars should not have any type definition generated
    expect(result.typeDefsSDL).not.toContain("scalar test_String");
    expect(result.typeDefsSDL).not.toContain("scalar test_Int");
    expect(result.typeDefsSDL).not.toContain("scalar test_Boolean");
  });

  it("should use custom prefix when provided", () => {
    const schema = buildTestSchema(`
      type Query {
        user: User
      }
      type User {
        id: ID!
      }
    `);

    const result = transformRemoteSchema(schema, {
      name: "stripe",
      url: "http://localhost:4000/graphql",
      prefix: "st_",
    });

    expect(result.prefix).toBe("st_");
    expect(result.typeDefsSDL).toContain("type st_User");
    expect(result.queryFields[0].prefixedName).toBe("st_user");
  });

  it("should build correct prefix map", () => {
    const schema = buildTestSchema(`
      type Query {
        user: User
      }
      type User {
        id: ID!
      }
    `);

    const result = transformRemoteSchema(schema, {
      name: "svc",
      url: "http://localhost:4000/graphql",
    });

    expect(result.prefixMap.toPrefixed["User"]).toBe("svc_User");
    expect(result.prefixMap.toOriginal["svc_User"]).toBe("User");
  });

  it("should handle nested types with relationships", () => {
    const schema = buildTestSchema(`
      type Query {
        order(id: ID!): Order
      }
      type Order {
        id: ID!
        items: [OrderItem!]!
      }
      type OrderItem {
        id: ID!
        product: String!
        quantity: Int!
      }
    `);

    const result = transformRemoteSchema(schema, {
      name: "shop",
      url: "http://localhost:4000/graphql",
    });

    expect(result.typeDefsSDL).toContain("type shop_Order");
    expect(result.typeDefsSDL).toContain("type shop_OrderItem");
    expect(result.typeDefsSDL).toContain("items: [shop_OrderItem!]!");
  });

  it("should handle schema with no mutations", () => {
    const schema = buildTestSchema(`
      type Query {
        hello: String
      }
    `);

    const result = transformRemoteSchema(schema, {
      name: "simple",
      url: "http://localhost:4000/graphql",
    });

    expect(result.mutationFields).toHaveLength(0);
    expect(result.queryFields).toHaveLength(1);
  });
});
