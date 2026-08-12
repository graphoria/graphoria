import { describe, expect, test } from "bun:test";

import type { SessionContext } from "./sessionVariables";

import { hasSessionVariables, replaceSessionVariables } from "./sessionVariables";

describe("Session Variable Replacement", () => {
  describe("replaceSessionVariables", () => {
    test("should handle operator-based filter with session variables", () => {
      const filter = {
        userId: { eq: "$session.sub" },
        status: { eq: "active" },
      };
      const session: SessionContext = { sub: "user-123", role: "user" };

      const result = replaceSessionVariables(filter, session);

      expect(result).toEqual({
        userId: { eq: "user-123" },
        status: { eq: "active" },
      });
    });

    test("should handle multiple operators with session variables", () => {
      const filter = {
        organizationId: { eq: "$session.organizationId" },
        salary: { gte: "$session.minSalary", lte: "$session.maxSalary" },
        status: { neq: "inactive" },
      };
      const session: SessionContext = {
        sub: "user-123",
        organizationId: "org-456",
        minSalary: 50000,
        maxSalary: 150000,
      };

      const result = replaceSessionVariables(filter, session);

      expect(result).toEqual({
        organizationId: { eq: "org-456" },
        salary: { gte: 50000, lte: 150000 },
        status: { neq: "inactive" },
      });
    });

    test("should handle gt, gte, lt, lte operators", () => {
      const filter = {
        age: { gt: "$session.minAge", lte: 100 },
        score: { gte: 0, lt: "$session.maxScore" },
      };
      const session: SessionContext = {
        sub: "user-123",
        minAge: 18,
        maxScore: 100,
      };

      const result = replaceSessionVariables(filter, session);

      expect(result).toEqual({
        age: { gt: 18, lte: 100 },
        score: { gte: 0, lt: 100 },
      });
    });

    test("should handle like operator with session variables", () => {
      const filter = {
        email: { like: "$session.emailPattern" },
      };
      const session: SessionContext = {
        sub: "user-123",
        emailPattern: "%@company.com",
      };

      const result = replaceSessionVariables(filter, session);

      expect(result).toEqual({
        email: { like: "%@company.com" },
      });
    });

    test("should handle in operator with session variables", () => {
      const filter = {
        departmentId: { in: "$session.allowedDepartments" },
      };
      const session: SessionContext = {
        sub: "user-123",
        allowedDepartments: ["dept-1", "dept-2", "dept-3"],
      };

      const result = replaceSessionVariables(filter, session);

      expect(result).toEqual({
        departmentId: { in: ["dept-1", "dept-2", "dept-3"] },
      });
    });

    test("should handle is_null operator", () => {
      const filter = {
        deletedAt: { is_null: true },
        archivedAt: { is_null: false },
      };
      const session: SessionContext = { sub: "user-123" };

      const result = replaceSessionVariables(filter, session);

      expect(result).toEqual({
        deletedAt: { is_null: true },
        archivedAt: { is_null: false },
      });
    });

    test("should replace $session.role with actual role", () => {
      const filter = { role: { eq: "$session.role" } };
      const session: SessionContext = { sub: "user-123", role: "admin" };

      const result = replaceSessionVariables(filter, session);

      expect(result).toEqual({ role: { eq: "admin" } });
    });

    test("should replace custom JWT claims", () => {
      const filter = {
        organizationId: { eq: "$session.organizationId" },
        departmentId: { eq: "$session.departmentId" },
      };
      const session: SessionContext = {
        sub: "user-123",
        role: "user",
        organizationId: "org-456",
        departmentId: "dept-789",
      };

      const result = replaceSessionVariables(filter, session);

      expect(result).toEqual({
        organizationId: { eq: "org-456" },
        departmentId: { eq: "dept-789" },
      });
    });

    test("should throw error if session variable not found", () => {
      const filter = { userId: { eq: "$session.unknownClaim" } };
      const session: SessionContext = { sub: "user-123", role: "user" };

      expect(() => replaceSessionVariables(filter, session)).toThrow(
        "Session variable $session.unknownClaim not found in JWT claims",
      );
    });

    test("should return original filter if session is null", () => {
      const filter = { userId: { eq: "$session.sub" } };

      const result = replaceSessionVariables(filter, null);

      expect(result).toEqual({ userId: { eq: "$session.sub" } });
    });

    test("should handle mixed session variables and literal values", () => {
      const filter = {
        userId: { eq: "$session.sub" },
        status: { eq: "active" },
        role: { eq: "$session.role" },
        isPublished: { eq: true },
        minPrice: { gte: 10 },
      };
      const session: SessionContext = { sub: "user-123", role: "admin" };

      const result = replaceSessionVariables(filter, session);

      expect(result).toEqual({
        userId: { eq: "user-123" },
        status: { eq: "active" },
        role: { eq: "admin" },
        isPublished: { eq: true },
        minPrice: { gte: 10 },
      });
    });

    test("should handle numeric session values", () => {
      const filter = { orgId: { eq: "$session.organizationId" } };
      const session: SessionContext = {
        sub: "user-123",
        organizationId: 42,
      };

      const result = replaceSessionVariables(filter, session);

      expect(result).toEqual({ orgId: { eq: 42 } });
    });

    test("should handle boolean session values", () => {
      const filter = { isVerified: { eq: "$session.verified" } };
      const session: SessionContext = {
        sub: "user-123",
        verified: true,
      };

      const result = replaceSessionVariables(filter, session);

      expect(result).toEqual({ isVerified: { eq: true } });
    });

    test("should handle empty filter object", () => {
      const filter = {};
      const session: SessionContext = { sub: "user-123", role: "user" };

      const result = replaceSessionVariables(filter, session);

      expect(result).toEqual({});
    });
  });

  describe("hasSessionVariables", () => {
    test("should return true if filter contains session variables", () => {
      const filter = {
        userId: { eq: "$session.sub" },
        status: { eq: "active" },
      };

      expect(hasSessionVariables(filter)).toBe(true);
    });

    test("should return false if filter has no session variables", () => {
      const filter = {
        status: { eq: "active" },
        isPublished: { eq: true },
      };

      expect(hasSessionVariables(filter)).toBe(false);
    });

    test("should return false for empty filter", () => {
      const filter = {};

      expect(hasSessionVariables(filter)).toBe(false);
    });

    test("should detect multiple session variables", () => {
      const filter = {
        userId: { eq: "$session.sub" },
        orgId: { eq: "$session.organizationId" },
        role: { eq: "$session.role" },
      };

      expect(hasSessionVariables(filter)).toBe(true);
    });
  });

  describe("Nested claims (dot-path)", () => {
    test("should resolve nested claims path", () => {
      const filter = {
        orgId: { eq: "$session.claims.organizationId" },
      };
      const session: SessionContext = {
        sub: "user-123",
        role: "user",
        claims: { organizationId: "org-456", tenantId: "t-1" },
      };

      const result = replaceSessionVariables(filter, session);

      expect(result).toEqual({ orgId: { eq: "org-456" } });
    });

    test("should resolve deeply nested claims path", () => {
      const filter = {
        region: { eq: "$session.claims.location.region" },
      };
      const session: SessionContext = {
        sub: "user-123",
        claims: { location: { region: "us-east-1" } },
      };

      const result = replaceSessionVariables(filter, session);

      expect(result).toEqual({ region: { eq: "us-east-1" } });
    });

    test("should throw for missing nested path", () => {
      const filter = { x: { eq: "$session.claims.nonexistent" } };
      const session: SessionContext = { sub: "u", claims: {} };

      expect(() => replaceSessionVariables(filter, session)).toThrow(
        "Session variable $session.claims.nonexistent not found in JWT claims",
      );
    });

    test("should still work with flat paths (backward compat)", () => {
      const filter = { userId: { eq: "$session.sub" } };
      const session: SessionContext = { sub: "user-123" };

      const result = replaceSessionVariables(filter, session);

      expect(result).toEqual({ userId: { eq: "user-123" } });
    });

    test("should handle mixed flat and nested paths", () => {
      const filter = {
        userId: { eq: "$session.sub" },
        orgId: { eq: "$session.claims.organizationId" },
        status: { eq: "active" },
      };
      const session: SessionContext = {
        sub: "user-123",
        role: "user",
        claims: { organizationId: "org-456" },
      };

      const result = replaceSessionVariables(filter, session);

      expect(result).toEqual({
        userId: { eq: "user-123" },
        orgId: { eq: "org-456" },
        status: { eq: "active" },
      });
    });
  });

  describe("Real-world scenarios", () => {
    test("should filter user's own orders", () => {
      const filter = {
        userId: { eq: "$session.sub" },
        status: { eq: "pending" },
      };
      const session: SessionContext = {
        sub: "user-456",
        role: "user",
        email: "user@example.com",
      };

      const result = replaceSessionVariables(filter, session);

      expect(result).toEqual({
        userId: { eq: "user-456" },
        status: { eq: "pending" },
      });
    });

    test("should filter organization-scoped data", () => {
      const filter = {
        organizationId: { eq: "$session.organizationId" },
        isActive: { eq: true },
      };
      const session: SessionContext = {
        sub: "user-123",
        role: "manager",
        organizationId: "org-789",
      };

      const result = replaceSessionVariables(filter, session);

      expect(result).toEqual({
        organizationId: { eq: "org-789" },
        isActive: { eq: true },
      });
    });

    test("should handle multi-tenant filtering", () => {
      const filter = {
        tenantId: { eq: "$session.tenantId" },
        departmentId: { eq: "$session.departmentId" },
        status: { eq: "approved" },
      };
      const session: SessionContext = {
        sub: "user-999",
        role: "employee",
        tenantId: "tenant-001",
        departmentId: "dept-hr",
      };

      const result = replaceSessionVariables(filter, session);

      expect(result).toEqual({
        tenantId: { eq: "tenant-001" },
        departmentId: { eq: "dept-hr" },
        status: { eq: "approved" },
      });
    });
  });
});
