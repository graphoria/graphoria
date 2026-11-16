import { describe, expect, it } from "bun:test";
import { createTRPCClient, httpBatchLink } from "@trpc/client";

import type { TRPCRouterOf } from ".";
import type { ConfigurationFn, ConfigurationInput } from "../config";

import { operation } from "../config";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const configure = (({ operation, z }) => ({
  name: "trpc-types",
  version: "1.0.0",
  operations: {
    listOrders: operation({
      query: "query { orders { id } }",
      input: z.object({ customerId: z.number(), limit: z.number().default(10) }),
      output: z.array(z.object({ id: z.number() })),
      rest: { path: "/orders" },
    }),
    ping: operation({ query: "query { ping }", rest: { path: "/ping" } }),
    createTask: operation({
      input: z.object({ title: z.string() }),
      output: z.object({ id: z.number() }),
      rest: { path: "/tasks", method: "POST" },
      handler: async () => ({ id: 1 }),
    }),
    bare: { query: "query { ping }", rest: { path: "/bare" } },
  },
})) satisfies ConfigurationFn;

const erased = {
  name: "trpc-types",
  version: "1.0.0",
  operations: {
    ping: operation({ query: "query { ping }", rest: { path: "/ping" } }),
  },
} as ConfigurationInput;

const links = [httpBatchLink({ url: "http://localhost/trpc" })];

// Type-checked, never called: every assertion below is the compiler's.
const typeChecks = async () => {
  const client = createTRPCClient<TRPCRouterOf<typeof configure>>({ links });

  const orders = await client.listOrders.query({ customerId: 1 });
  const ordersTyped: Equal<typeof orders, { id: number }[]> = true;

  const pong = await client.ping.query();
  const pongTyped: Equal<typeof pong, unknown> = true;

  const task = await client.createTask.mutate({ title: "write the docs" });
  const taskTyped: Equal<typeof task, { id: number }> = true;

  // @ts-expect-error a GET operation is a query
  await client.listOrders.mutate({ customerId: 1 });
  // @ts-expect-error any other method is a mutation
  await client.createTask.query({ title: "write the docs" });
  // @ts-expect-error customerId is a number
  await client.listOrders.query({ customerId: "1" });
  // @ts-expect-error customerId is required
  await client.listOrders.query({});
  // @ts-expect-error the input is required
  await client.listOrders.query();
  // @ts-expect-error no such operation
  await client.missing.query();
  // @ts-expect-error a bare object literal is served, but not typed
  await client.bare.query();

  const erasedClient = createTRPCClient<TRPCRouterOf<typeof erased>>({ links });
  // @ts-expect-error a cast to ConfigurationInput erases every procedure
  await erasedClient.ping.query();

  return [ordersTyped, pongTyped, taskTyped];
};

describe("TRPCRouterOf", () => {
  it("types a client from a configuration without code generation", () => {
    expect(typeChecks).toBeTypeOf("function");
  });
});
