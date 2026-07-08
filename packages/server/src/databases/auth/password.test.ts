import { describe, expect, it } from "bun:test";

import { hashPassword, verifyPassword } from "./password";

describe("database auth password hashing", () => {
  it("hashes with argon2id format", async () => {
    const hash = await hashPassword("super-secure-pa$$word");

    expect(hash.startsWith("$argon2id$")).toBe(true);
  });

  it("uses a random salt per hash", async () => {
    const password = "same-password";

    const hashA = await hashPassword(password);
    const hashB = await hashPassword(password);

    expect(hashA).not.toBe(hashB);
  });

  it("verifies matching password", async () => {
    const password = "my-password";
    const hash = await hashPassword(password);

    const valid = await verifyPassword(password, hash);

    expect(valid).toBe(true);
  });

  it("rejects non-matching password", async () => {
    const hash = await hashPassword("correct-password");

    const valid = await verifyPassword("wrong-password", hash);

    expect(valid).toBe(false);
  });
});
