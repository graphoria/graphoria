# Security Policy

Graphoria sits between untrusted clients and a database, and its role-based access control is a
security boundary. Vulnerability reports are taken seriously and handled privately until a fix is
available.

## Supported versions

Graphoria is pre-1.0. Only the most recent published release receives security fixes; there are no
backports to earlier `0.x` releases.

| Version             | Supported          |
| ------------------- | ------------------ |
| Latest `0.1.x`      | :white_check_mark: |
| Any earlier `0.1.x` | :x:                |

Once 1.0 ships, this table will be replaced with a supported-version window and a deprecation policy.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Report privately through either channel:

- GitHub's private vulnerability reporting, via the **Security** tab of
  [graphoria/graphoria](https://github.com/graphoria/graphoria/security/advisories/new) — preferred,
  because it keeps the report, the fix, and the advisory in one place.
- Email [ferreli.ale@gmail.com](mailto:ferreli.ale@gmail.com).

Please include, as far as you can determine them:

- The affected version and the database engine in use.
- A description of the issue and its impact — in particular whether it crosses a role, tenant, or
  authentication boundary.
- Reproduction steps, ideally a minimal `graphoria.ts` configuration and the request that triggers
  the behaviour.
- Any proposed fix or mitigation.

## What to expect

| Stage                             | Target                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------- |
| Acknowledgement                   | Within 3 business days                                                            |
| Initial assessment                | Within 7 days — severity, affected versions, whether it is in scope               |
| Fix for high or critical severity | Within 30 days of confirmation, or a public mitigation if a full fix takes longer |
| Fix for lower severity            | Rolled into the next release                                                      |

Graphoria is maintained by one person; these are honest targets rather than a contractual SLA. If a
report goes unacknowledged past the window above, please follow up by email.

## Disclosure

Coordinated disclosure. A fix is prepared and released first, then a GitHub Security Advisory is
published naming the affected versions and, unless you ask otherwise, crediting the reporter. Please
hold public details until the advisory is out.

## Scope

In scope:

- Bypass of role-based access control, row-level filters, or column restrictions.
- SQL injection through any user-controlled channel, including identifiers.
- Authentication and token handling — forgery, replay, revocation failures, privilege escalation.
- Leakage of one tenant's or role's data to another, including through caches.
- Exposure of secrets in logs, error messages, or client-reachable storage.

Out of scope:

- Vulnerabilities in a configuration that intentionally grants broad access — for example a role
  granted `tables: "ALL"`, or the admin secret exposed to untrusted clients. The admin secret
  bypasses RBAC by design.
- Denial of service through expensive queries. Query depth, cost, and rate limits are not yet on by
  default; this is a known gap being tracked, not a reportable vulnerability.
- Issues in a dependency with no exploitable path through Graphoria — report those upstream.
