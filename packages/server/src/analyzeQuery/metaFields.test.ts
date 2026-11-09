import { describe, expect, it } from "bun:test";
import { parse } from "graphql";

import type { OperationDefinitionNode } from "graphql";

import { metaDocument } from "./metaFields";

describe("metaDocument", () => {
  it("narrows many root-level fragments in bounded time", () => {
    const count = 20_000;
    const document = parse(
      [
        `{ ${Array.from({ length: count }, (_, i) => `...F${i}`).join(" ")} }`,
        ...Array.from({ length: count }, (_, i) => `fragment F${i} on Query { __typename }`),
      ].join("\n"),
    );

    const started = performance.now();
    const meta = metaDocument(document, document.definitions[0] as OperationDefinitionNode);

    expect(performance.now() - started).toBeLessThan(500);
    expect(meta?.definitions).toHaveLength(count + 1);
  });
});
