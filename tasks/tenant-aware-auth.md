# Model Identity Platform tenant-aware authentication

Requested 5 November 2026. Implemented and verified against the stub and the Auth
emulator, 6 November 2026; the real-service run is blocked (see Tracking).

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

- [x] Design and implement the tenant-aware Admin and REST surface needed by the
  downstream flow, matching the Firebase SDK and Identity Toolkit contracts.
  Provide tenant-scoped user creation, lookup and lifecycle, including the
  account operations already used by bill splitter. Keep the project-level pool
  working for existing clients. Do not add a production bypass for tests.
- [x] Model separate pools in each simulator instance. The same email can belong
  to two tenants with different passwords; each tenant's registration, lookup,
  sign-in and recovery operate on its own account. Keep instance state isolated:
  two independently constructed simulators must not interfere.
- [x] Model signed tenant-aware ID and custom tokens and session cookies using
  the real SDK's verified claim and verification semantics. Tenant-scoped
  verification must reject a token for a different tenant; test signatures as
  well as tenant identity. Cover session creation/verification and revocation
  for the relevant pool. Establish and test project-level verification semantics
  from the SDK rather than assuming that they equal tenant-scoped verification.
- [x] Support tenant context in the existing REST sign-in and password/action-code
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

## Tracking

### Interface shipped (additive; no breaking change)

- `ITenantAwareAuth extends IAuth { readonly tenantId }` and
  `ITenantManager { authForTenant(tenantId) }`, mirroring `TenantAwareAuth` and
  `TenantManager.authForTenant`. `createTenantManager(getAuth().tenantManager())`
  adapts the real SDK; `IAuth`, `createAuth` and the existing `StubAuth`
  surface are unchanged.
- `IAuthClient` requests gain optional `tenantId` (the Identity Toolkit body
  field) on `signInWithPassword`, `signInWithCustomToken`, `resetPassword` and
  `applyActionCode`. A third-party `IAuthClient` implementation still compiles
  but ignores the field.
- `StubAuth.tenantManager().authForTenant(id)` returns `StubTenantAwareAuth`:
  its own pool, with `seedUser`, `issueIdToken`, `issueActionCode`, `failNext`
  and `remainingFailures`; `advanceClock` and `clear` on `StubAuth` cover every
  pool. Two `StubAuth` instances share nothing.
- `StubAuth` now extends an unexported `StubPoolAuth` base, whose state and
  helpers are ES `#private`, so a downstream subclass cannot clash with or reach
  them. Its class and the internal `AuthAuthority`/`AuthPool` types still appear,
  unnamed, in the bundled `d.ts`. `authForTenant` returns one cached instance
  per tenant, as the SDK does.
- Registration needs no REST `signUp`: bill splitter creates accounts server-side
  with Admin `createUser`, which is now tenant-scoped.

### Semantics and their evidence

From the Admin SDK source (`firebase-admin` 13.5, `lib/auth/tenant-manager.js`,
`base-auth.js`, `token-generator.js`):
- Tenant `verifyIdToken`/`verifySessionCookie`: base verification, then (with
  `checkRevoked`) the user is looked up in the tenant, then `firebase.tenant` is
  compared: `auth/mismatching-tenant-id`. Tenant `createSessionCookie` verifies
  the ID token for the tenant first. `authForTenant('')` is
  `auth/invalid-tenant-id`. Custom tokens carry `tenant_id`.
- Project-level `Auth` compares no tenant: it accepts a tenant's token, and with
  `checkRevoked` looks the uid up in the project pool (`auth/user-not-found` for a
  tenant-only uid).

From the Auth emulator source (`firebase-tools` 15.28, `lib/emulator/auth`) and
the shared contract run:
- Tenant pools are created on first use; users, email uniqueness and oob codes
  are per pool. An action code used in another pool, or the root pool, is
  `INVALID_OOB_CODE`. A tenant's action links carry `tenantId`.
- `signInWithCustomToken` with a `tenantId` refuses a token whose `tenant_id`
  differs (including a project token) with `TENANT_ID_MISMATCH`, before format checks.
- Project-level `createSessionCookie` with a tenant's ID token is routed to that
  tenant's pool. Encoded in the stub, not covered by a shared test.

Not verified against real Firebase (no multi-tenant project available):
custom-token sign-in without `tenantId` for a tenant's token (the emulator signs
it in to the project pool, and so does the stub), project-level session-cookie
routing, link format, and whether real Identity Platform rejects an unknown tenant.

### Verification run, 6 November 2026

- `npx vitest run src/__tests__/unit/StubAuth.test.ts`: 27 passed (8 new tenant tests).
- `npx firebase emulators:exec --only auth --project demo-test-project 'npx vitest run src/__tests__/integration/auth-compatibility.test.ts'`:
  55 passed, modes stub and emulator (7 new tenant contracts; the 48 existing
  root-pool contracts unchanged).
- `npm run build`, `npm run format:check`, `npm run test:unit` (129 passed).
- `examples/auth-tenants.ts` runs. No timeout changed.
- Signature checks (tampered tenant claims, another simulator's tokens) and the
  SDK's no-`checkRevoked` path are stub-only: the emulator neither signs tokens
  nor lets the SDK skip the user lookup.

### Open

- Real-service run, blocked: project `fir-simulator-test` answers
  `listTenants` with `auth/invalid-project-id … didn't enable multi-tenancy`.
  It needs Identity Platform with multi-tenancy (billing), a web API key, two
  tenants with Email/Password, and a decision to let auth tests create real
  accounts (today's suite deliberately has no real mode).
- Release by the user, then the handoff of the published version to bill splitter.
