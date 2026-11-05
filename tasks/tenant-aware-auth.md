# Model Identity Platform tenant-aware authentication

Requested 5 November 2026. Open; no implementation or verification yet.

## Purpose

The bill splitter is moving to separate Identity Platform authentication pools
for its application tenants. It needs to exercise the same email in two pools,
with independent credentials, and reject authentication presented to the wrong
tenant. This package's current auth simulation cannot establish that contract.
The downstream work is described in the bill splitter's
`tasks/cross-tenant-group-invite-existing-account.md`.

## Current surface

- [`IAuth`](../src/auth-types.ts) and its [Admin adapter](../src/admin-auth.ts)
  expose project-level operations; [`IAuthClient`](../src/auth-client-types.ts)
  and its [REST adapter](../src/admin-auth-client.ts) do not carry a tenant ID.
- [`StubAuth`](../src/StubAuth.ts) owns one user map, checks email uniqueness
  across it, issues signed tokens from that instance and returns an undefined
  user-record tenant ID. Its Admin and REST operations share that state.
- Existing coverage lives in [`StubAuth.test.ts`](../src/__tests__/unit/StubAuth.test.ts)
  and [`auth-compatibility.test.ts`](../src/__tests__/integration/auth-compatibility.test.ts).
  Preserve the existing project-level pool and existing callers as a public
  library contract; report any unavoidable breaking surface explicitly.

## Work

- [ ] Design and implement the tenant-aware Admin and REST surface needed by the
  downstream flow, matching the Firebase SDK and Identity Toolkit contracts.
  Provide tenant-scoped user creation, lookup and lifecycle, including the
  account operations already used by bill splitter. Keep the project-level pool
  working for existing clients. Do not add a production bypass for tests.
- [ ] Model separate pools in each simulator instance. The same email can belong
  to two tenants with different passwords; each tenant's registration, lookup,
  sign-in and recovery operate on its own account. Keep instance state isolated:
  two independently constructed simulators must not interfere.
- [ ] Model signed tenant-aware ID and custom tokens and session cookies using
  the real SDK's verified claim and verification semantics. Tenant-scoped
  verification must reject a token for a different tenant; test signatures as
  well as tenant identity. Cover session creation/verification and revocation
  for the relevant pool. Establish and test project-level verification semantics
  from the SDK rather than assuming that they equal tenant-scoped verification.
- [ ] Support tenant context in the existing REST sign-in and password/action-code
  paths and any registration operation needed by the downstream integration.
  Cover password reset, email verification and email-change action codes used by
  the current auth surface, including whether a code can be used under another
  tenant. Verify exact request fields, error codes and behaviour against Firebase
  before encoding them; do not guess missing semantics.
- [ ] Add focused unit and compatibility tests covering same-email accounts with
  different passwords, wrong-pool authentication and verification, independent
  reset/action-code effects, revocation, session cookies, root-pool regression,
  and two independent simulator instances. Run applicable shared contracts
  against the stub and the real service, and the emulator where it supports the
  operation; document any emulator or real-service limitation rather than
  treating a stub-only pass as Firebase compatibility.
- [ ] Update exported types, adapters, examples and documentation as required by
  the final public interface. Explain compatibility and hand off the actual
  package version and supported operations to bill splitter after the user
  handles release. Do not publish as part of this task.

## Contract references and open verification

Google documents tenant-aware Admin authentication and verification in
[Managing Identity Platform tenants](https://docs.cloud.google.com/identity-platform/docs/multi-tenancy-managing-tenants),
and tenant-specific sign-in and custom tokens in
[Authenticating with multi-tenancy](https://docs.cloud.google.com/identity-platform/docs/multi-tenancy-authentication).
The [Identity Toolkit REST guide](https://docs.cloud.google.com/identity-platform/docs/use-rest-api)
documents tenant context for password reset, and the
[password sign-in method](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/accounts/signInWithPassword)
includes `tenantId`. Confirm the remaining operation-specific behaviour, including
action-code and session-cookie mismatch errors, using official references and
compatibility evidence before making it a simulator contract.

## Acceptance and downstream handoff

The package's targeted unit and compatibility checks, build/typecheck and format
checks pass under its current project instructions, with no increased timeouts.
Report exactly which implementations were exercised and any limitations. The
handoff must allow bill splitter to construct two tenant pools plus the existing
root pool, exercise its Admin and REST flows against the same simulator instance,
and verify cross-tenant refusals without changing production code for tests.
Bill splitter will separately wire its host-to-pool mapping, data ownership and
invite journey; this task does not implement or deploy those changes.
