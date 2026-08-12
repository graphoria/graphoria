import { describe, expect, it } from "bun:test";
import { buildSchema, parse, specifiedRules, validate } from "graphql";

import { depthLimitRule } from "./depthLimit";

const schema = buildSchema(`
  type Query {
    users: [User!]!
    viewer: Viewer!
  }

  type User {
    id: ID!
    name: String!
    posts: [Post!]!
    friends: [User!]!
  }

  type Post {
    id: ID!
    title: String!
    comments: [Comment!]!
    author: User!
  }

  type Comment {
    id: ID!
    body: String!
    author: User!
  }

  type Viewer {
    user: User!
  }
`);

const validateWithDepth = (query: string, maxDepth: number) =>
  validate(schema, parse(query), [...specifiedRules, depthLimitRule(maxDepth)]);

describe("depthLimitRule", () => {
  it("should allow queries within the depth limit", () => {
    const query = `
      {
        users {
          id
          name
        }
      }
    `;
    // depth = 2: users -> id/name
    const errors = validateWithDepth(query, 3);
    expect(errors).toHaveLength(0);
  });

  it("should allow queries at exactly the depth limit", () => {
    const query = `
      {
        users {
          id
          name
        }
      }
    `;
    // depth = 2
    const errors = validateWithDepth(query, 2);
    expect(errors).toHaveLength(0);
  });

  it("should reject queries exceeding the depth limit", () => {
    const query = `
      {
        users {
          posts {
            comments {
              body
            }
          }
        }
      }
    `;
    // depth = 4: users -> posts -> comments -> body
    const errors = validateWithDepth(query, 3);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("exceeds the maximum allowed depth");
    expect(errors[0].message).toContain("depth of 4");
    expect(errors[0].message).toContain("maximum allowed depth of 3");
  });

  it("should count depth correctly for deeply nested queries", () => {
    const query = `
      {
        users {
          posts {
            author {
              friends {
                posts {
                  title
                }
              }
            }
          }
        }
      }
    `;
    // depth = 6: users -> posts -> author -> friends -> posts -> title
    const errors = validateWithDepth(query, 5);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("depth of 6");
  });

  it("should allow depth-1 queries (top-level scalar)", () => {
    // This schema doesn't have a top-level scalar, but let's test depth 1
    const query = `
      {
        users {
          id
        }
      }
    `;
    // depth = 2
    const errors = validateWithDepth(query, 2);
    expect(errors).toHaveLength(0);
  });

  it("should ignore introspection fields (__typename, __schema, __type)", () => {
    const query = `
      {
        users {
          __typename
          id
          posts {
            __typename
            title
          }
        }
      }
    `;
    // depth = 3: users -> posts -> title (ignoring __typename)
    const errors = validateWithDepth(query, 3);
    expect(errors).toHaveLength(0);
  });

  it("should handle inline fragments correctly", () => {
    const query = `
      {
        users {
          ... on User {
            posts {
              title
            }
          }
        }
      }
    `;
    // depth = 3: users -> (inline fragment) posts -> title
    const errors = validateWithDepth(query, 3);
    expect(errors).toHaveLength(0);

    const errors2 = validateWithDepth(query, 2);
    expect(errors2).toHaveLength(1);
  });

  it("should handle fragment spreads correctly", () => {
    const query = `
      fragment PostFields on User {
        posts {
          title
          comments {
            body
          }
        }
      }

      {
        users {
          ...PostFields
        }
      }
    `;
    // depth = 4: users -> posts -> comments -> body (via fragment)
    const errors = validateWithDepth(query, 4);
    expect(errors).toHaveLength(0);

    const errors2 = validateWithDepth(query, 3);
    expect(errors2).toHaveLength(1);
  });

  it("should handle multiple operations", () => {
    const query = `
      query Shallow {
        users {
          id
        }
      }

      query Deep {
        users {
          posts {
            comments {
              body
            }
          }
        }
      }
    `;
    // Shallow depth = 2, Deep depth = 4
    const errors = validateWithDepth(query, 3);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('operation: "Deep"');
  });

  it("should include operation name in error message", () => {
    const query = `
      query GetUsers {
        users {
          posts {
            comments {
              body
            }
          }
        }
      }
    `;
    const errors = validateWithDepth(query, 2);
    expect(errors[0].message).toContain('operation: "GetUsers"');
  });

  it("should use 'anonymous' for unnamed operations", () => {
    const query = `
      {
        users {
          posts {
            comments {
              body
            }
          }
        }
      }
    `;
    const errors = validateWithDepth(query, 2);
    expect(errors[0].message).toContain('operation: "anonymous"');
  });

  it("should handle aliases without double-counting", () => {
    const query = `
      {
        allUsers: users {
          id
          name
        }
      }
    `;
    // depth = 2: users -> id/name
    const errors = validateWithDepth(query, 2);
    expect(errors).toHaveLength(0);
  });

  it("should take the maximum branch depth", () => {
    const query = `
      {
        users {
          id
          posts {
            comments {
              body
            }
          }
        }
      }
    `;
    // shallow branch: users -> id (depth 2)
    // deep branch: users -> posts -> comments -> body (depth 4)
    // max = 4
    const errors = validateWithDepth(query, 3);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("depth of 4");
  });

  it("should handle maxDepth of 1 (only top-level fields)", () => {
    const query = `
      {
        users {
          id
        }
      }
    `;
    // depth = 2
    const errors = validateWithDepth(query, 1);
    expect(errors).toHaveLength(1);
  });
});
