import { describe, expect, it } from "bun:test";

import { analyzeQuery } from "../../../../analyzeQuery";
import { StoreSQLite } from "../../../../__test/dataset/store";
import { generateSQL } from ".";

const sql = (query: string, hash = false) => {
  const [operation] = analyzeQuery(query, StoreSQLite).operations;
  return generateSQL(StoreSQLite, operation!, {}, hash, null);
};

describe("SQLite: generateSQL", () => {
  it("builds the result from json_object and json_group_array", () => {
    const text = sql(`{ dbo_products { product_id } }`);

    expect(text).toContain("json_group_array(json_object('product_id', ");
    expect(text).toContain(`AS json_result`);
    expect(text).not.toContain("json_agg");
  });

  it("restores the JSON subtype a paginated page's derived table loses", () => {
    const text = sql(`{ dbo_products(limit: 10, orderBy: [{ product_id: ASC }]) { product_id } }`);

    expect(text).toContain("json_group_array(json(t1_page.obj) ORDER BY t1_page.__ord)");
  });

  it("falls back to JSON values, never to text", () => {
    const text = sql(`{ dbo_products { product_id } }`);

    expect(text).toContain("json('[]')");
    expect(text).not.toContain("'[]'::json");
  });

  it("reads a boolean column as a JSON boolean", () => {
    expect(sql(`{ dbo_products { is_active } }`)).toContain(
      `CASE WHEN t1."is_active" IS NULL THEN NULL WHEN t1."is_active" THEN json('true') ELSE json('false') END`,
    );
  });

  it("guards any other column against a BLOB", () => {
    expect(sql(`{ dbo_products { name } }`)).toContain(
      `CASE WHEN typeof(t1."name") = 'blob' THEN hex(t1."name") ELSE t1."name" END`,
    );
  });

  it("declares the LIKE escape, which SQLite has no default for", () => {
    expect(sql(`{ dbo_products(where: { name: { like: "a%" } }) { name } }`)).toMatch(
      /t1\."name" LIKE \$\d+ ESCAPE '\\'/,
    );
  });

  it("orders nulls natively", () => {
    expect(sql(`{ dbo_products(orderBy: [{ price: DESC_NULLS_LAST }]) { name } }`)).toContain(
      `t1."price" DESC NULLS LAST`,
    );
  });

  it("hashes with the result text itself, SQLite having no md5()", () => {
    const text = sql(`{ dbo_products { product_id } }`, true);

    expect(text.trimStart()).toStartWith("SELECT (");
    expect(text).toContain(`AS "ResultHash"`);
    expect(text).not.toContain("MD5");
  });
});
