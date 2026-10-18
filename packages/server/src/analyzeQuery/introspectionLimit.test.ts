import { describe, expect, it } from "bun:test";
import {
  buildSchema,
  getIntrospectionQuery,
  MaxIntrospectionDepthRule,
  parse,
  validate,
} from "graphql";

import { fragmentFanOut } from "../__test/fragmentFanOut";
import { introspectionLimitRule } from "./introspectionLimit";

const schema = buildSchema(`
  interface Node {
    id: ID!
  }
  type Item implements Node {
    id: ID!
    tags: [String!]
  }
  type Query {
    items: [Item!]!
  }
`);

const errorsOf = (query: string) =>
  validate(schema, parse(query), [introspectionLimitRule]).map((error) => error.message);

describe("introspectionLimitRule", () => {
  it.each([
    ["GraphiQL's", { inputValueDeprecation: true, schemaDescription: true }],
    [
      "the fullest",
      {
        descriptions: true,
        specifiedByUrl: true,
        directiveIsRepeatable: true,
        schemaDescription: true,
        inputValueDeprecation: true,
        oneOf: true,
      },
    ],
  ])("accepts %s introspection query", (_label, options) => {
    expect(errorsOf(getIntrospectionQuery(options))).toEqual([]);
  });

  it("lets ofType nest as deep as a wrapped type needs", () => {
    expect(
      errorsOf(
        `{ __type(name: "Item") { fields { type { ofType { ofType { ofType { name } } } } } } }`,
      ),
    ).toEqual([]);
  });

  it("accepts one list field on sibling paths", () => {
    expect(errorsOf(`{ __schema { a: types { name } b: types { fields { name } } } }`)).toEqual([]);
  });

  it.each([
    ["fields", `{ __type(name: "Item") { fields { type { fields { name } } } } }`],
    ["args", `{ __schema { directives { args { type { fields { args { name } } } } } } }`],
    ["inputFields", `{ __type(name: "Item") { inputFields { type { inputFields { name } } } } }`],
    ["interfaces", `{ __type(name: "Item") { interfaces { interfaces { name } } } }`],
    ["possibleTypes", `{ __type(name: "Node") { possibleTypes { possibleTypes { name } } } }`],
  ])("refuses %s twice on one path", (field, query) => {
    expect(errorsOf(query)).toEqual([expect.stringContaining(`"${field}" twice`)]);
  });

  it("accepts two of fields, interfaces, possibleTypes and inputFields on one path", () => {
    expect(
      errorsOf(`{ __type(name: "Item") { fields { type { interfaces { name } } } } }`),
    ).toEqual([]);
  });

  it("refuses three of fields, interfaces, possibleTypes and inputFields on one path", () => {
    expect(
      errorsOf(
        `{ __type(name: "Item") { fields { type { interfaces { possibleTypes { name } } } } } }`,
      ),
    ).toEqual([expect.stringContaining('nests "fields", "interfaces" and "possibleTypes"')]);
  });

  it.each([
    `{ __type(name: "Item") { fields { type { fields { type { fields { name } } } } } } }`,
    `{ __type(name: "Item") { interfaces { fields { type { possibleTypes { name } } } } } }`,
    `{ __type(name: "Item") { ...A } }
      fragment A on __Type { inputFields { type { ...B } } }
      fragment B on __Type { fields { type { interfaces { name } } } }`,
  ])("refuses what graphql-js's MaxIntrospectionDepthRule refuses: %s", (query) => {
    expect(validate(schema, parse(query), [MaxIntrospectionDepthRule])).not.toEqual([]);
    expect(errorsOf(query)).not.toEqual([]);
  });

  it("follows fragment spreads and inline fragments", () => {
    expect(
      errorsOf(`
        { __type(name: "Item") { ...Fields } }
        fragment Fields on __Type { fields { type { ... on __Type { fields { name } } } } }
      `),
    ).toEqual([expect.stringContaining('"fields" twice')]);
  });

  it("judges a fragment by the path it is spread on", () => {
    expect(
      errorsOf(
        `{ __type(name: "Item") { ...Named } } fragment Named on __Type { fields { name } }`,
      ),
    ).toEqual([]);
    expect(
      errorsOf(`
        { __type(name: "Item") { ...Named fields { type { ...Named } } } }
        fragment Named on __Type { fields { name } }
      `),
    ).toEqual([expect.stringContaining('"fields" twice')]);
  });

  it("reports a meta root once, however many lists it repeats", () => {
    expect(
      errorsOf(`
        { __type(name: "Item") { fields { type { fields { name } } } interfaces { interfaces { name } } } }
      `),
    ).toHaveLength(1);
  });

  it("terminates on a fragment cycle", () => {
    expect(
      errorsOf(`
        { __type(name: "Item") { ...A } }
        fragment A on __Type { ofType { ...B } }
        fragment B on __Type { ofType { ...A } }
      `),
    ).toEqual([]);
  });

  // Without one walk per fragment and path, each level doubles the work: 2^26 here.
  it("walks a fragment once per path, however often it is spread", () => {
    const started = performance.now();

    errorsOf(fragmentFanOut(26, "Item"));

    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("leaves a query without introspection alone", () => {
    expect(errorsOf("{ items { id tags } }")).toEqual([]);
  });
});
