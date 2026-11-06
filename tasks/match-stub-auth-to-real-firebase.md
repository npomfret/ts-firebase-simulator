# Match StubAuth to real Firebase

Requested 6 November 2026. Implemented and verified against the stub, real
Firebase and the emulator; awaiting review and commit.

## Issue

`StubAuth` was built to match the Auth emulator. The first real-Firebase run of
`auth-compatibility.test.ts` (project `fir-simulator-test`, its pool and two
Identity Platform tenants) failed 20 of 55 tests where real Firebase differs from
the emulator and the stub. Project rule: where the stub and the real service
disagree, the stub is the defect. The user asked for the stub to be fixed to match
real Firebase. This changes the behaviour of a published package, so each change
is a breaking change to report.

Differences seen in the first run:

- `tokensValidAfterTime` is set on every new account, not only password ones.
- `metadata.lastSignInTime` and `lastRefreshTime` are `null` at creation.
- An anonymous account's ID token has no `email_verified`.
- Email enumeration protection on the project pool: a wrong password and an
  unknown email are both `INVALID_LOGIN_CREDENTIALS`. Tenants answered
  `INVALID_PASSWORD` and `EMAIL_NOT_FOUND`.
- Error detail: `INVALID_CUSTOM_TOKEN` and `TENANT_ID_MISMATCH` messages;
  applying a password-reset code is `INVALID_OOB_CODE` (400), not 501; a reset
  link for an unknown email is `auth/internal-error`; an email change refused
  because the address was taken meanwhile leaves its code usable.
- Two tests exceed the 10 s limit against real Firebase.

## Plan

1. Probe real Firebase for the exact behaviour of each operation the stub models,
   in the project pool and a tenant, and record it below.
2. Change the stub to match. The shared tests assert real Firebase's behaviour.
   Where the emulator differs, the emulator leg says so explicitly.
3. Where a test is slow only because real Firebase is, give the real mode a
   longer limit set from measured time (approved, see Decisions).
4. Run the auth suite against stub + real (`npm run test:integration`) and stub +
   emulator (`npm run test:with-emulator`), then the unit suite, build and format.
5. Update the README's "not simulated" notes and list each breaking change.

## Real Firebase behaviour (probed 6 November 2026)

Probed with a throwaway script against `fir-simulator-test`: its project pool,
which has email enumeration protection (`emailPrivacyConfig.enableImprovedEmailPrivacy`)
on, and tenant `tenant-1`, which has no email privacy config. The same calls in
both pools gave the same answers, except where noted.

Records and tokens:
- Every new account has `tokensValidAfterTime` set to its creation second,
  password or not. That includes one created by a custom-token sign-in.
- `metadata.lastSignInTime` and `lastRefreshTime` are `null` until the first
  sign-in. Both are then set by a password or custom-token sign-in. An account
  created by a custom-token sign-in has both equal to its creation time.
- `updateUser` with a password, or with a new email, moves `tokensValidAfterTime`.
  A password change does not set `lastRefreshTime`. Changing the display name,
  `emailVerified` or `disabled` moves nothing.
- `providerData` lists `phone` before `password`.
- An ID token carries `email_verified` only when the account has an email.

Password sign-in (`accounts:signInWithPassword`):
- Protection on (project pool): an unknown email, an account without a password
  and a wrong password are all `INVALID_LOGIN_CREDENTIALS`. A disabled account is
  `USER_DISABLED` whatever the password.
- Protection off (tenant): `EMAIL_NOT_FOUND`, `INVALID_PASSWORD`,
  `INVALID_PASSWORD` and `USER_DISABLED`.
- With `returnSecureToken: false`, the response has an `idToken` but no
  `refreshToken` or `expiresIn`.

Custom-token sign-in (`accounts:signInWithCustomToken`):
- A garbage token: `INVALID_CUSTOM_TOKEN : Invalid assertion format. 3 dot separated segments required.`
  This is the same in a tenant.
- An ID token in the project pool: `INVALID_CUSTOM_TOKEN`, with no detail.
- In a tenant, a token without `tenant_id` (a project custom token, or an ID
  token): HTTP 500 `Internal error encountered.`
- A token for another tenant, or a tenant's token sent without `tenantId`:
  `TENANT_ID_MISMATCH : Specified tenant ID does not match the custom token.`

Action codes:
- Applying a password-reset code (`accounts:update`) is `INVALID_OOB_CODE` (400),
  and leaves the code usable.
- Applying an email-change code moves `tokensValidAfterTime`, and its response
  includes `newEmail`. Applying an email-verification code moves nothing.
- An email change refused with `EMAIL_EXISTS`, because the address was taken
  after the link was made, leaves its code usable.
- A code whose account no longer has its email: a reset is `USER_NOT_FOUND`;
  applying a verification code is `EMAIL_NOT_FOUND`.
- Links: `https://<project>.firebaseapp.com/__/auth/action?mode=…&oobCode=…&apiKey=…&lang=en`,
  plus `&tenantId=…` for a tenant.
- Protection on: a reset link for an unknown email, and an email-change link to
  an email in use (including the account's own), fail in the Admin SDK with
  `auth/internal-error`, `INTERNAL ASSERT FAILED: Unable to create the email action link`.
  Protection off: `auth/email-not-found` and `auth/email-already-exists`.
  Either way, verification and email-change links for an unknown email are
  `auth/user-not-found`.
- Generating several links quickly for one email can fail with
  `TOO_MANY_ATTEMPTS_TRY_LATER`.

Admin verification:
- A tenant's `createSessionCookie('garbage')` is `auth/argument-error`, from
  verifying the ID token first. At project level it is `auth/invalid-id-token`.

The emulator differs on most of the above. Its tenants also take the project's
email privacy setting, where real tenants have their own.

## Decisions

- Email enumeration protection is a per-pool `StubAuth` option (user,
  6 November 2026). It defaults to on for the project pool, Firebase's default
  for new projects, and off for tenants, as a new tenant is.
- Real-mode tests that are slow only because real Firebase is slow may have a
  longer limit (user, 6 November 2026). The limit is set from measured time and
  recorded beside it, for the real mode only.

## Tracking

### Breaking changes to `StubAuth`

Each change makes the stub behave as real Firebase did in the probe and the runs.
Callers that asserted the old behaviour will need updating:

1. Email enumeration protection is on for the project pool by default. An
   unknown email, a wrong password and an account without a password are all
   `INVALID_LOGIN_CREDENTIALS`, where they were `EMAIL_NOT_FOUND` and
   `INVALID_PASSWORD`. A reset link for an unknown email, and an email-change
   link to an email in use, now fail with `auth/internal-error`, and so does the
   test control `issueActionCode()` for the same cases. Callers can pass
   `emailEnumerationProtection: false` to get the old answers. Tenants keep them
   by default.
2. Every new account has `tokensValidAfterTime`; it was only set for password accounts.
3. `metadata.lastSignInTime` is `null` until the first sign-in; it was the
   creation time. That includes `seedUser`.
4. `updateUser` with a password no longer sets `lastRefreshTime`.
5. `providerData` lists `phone` before `password`.
6. An ID token for an account without an email has no `email_verified`.
7. Password sign-in with `returnSecureToken: false` returns no `refreshToken` or `expiresIn`.
8. Custom-token sign-in:
   - The garbage-token message gains `. 3 dot separated segments required.`.
   - An ID token is refused with a bare `INVALID_CUSTOM_TOKEN`.
   - In a tenant, a token without `tenant_id` gets HTTP 500, and a garbage token
     the format error.
   - A tenant's token with no `tenantId` is refused with `TENANT_ID_MISMATCH`;
     before, it signed in to the project pool. `TENANT_ID_MISMATCH` now carries
     Firebase's detail.
9. Action codes:
   - Applying a password-reset code is 400 `INVALID_OOB_CODE` (was 501), and
     leaves the code usable.
   - Applying an email change revokes earlier tokens, and the response carries `newEmail`.
   - An `EMAIL_EXISTS` refusal leaves the code usable.
   - A code whose account no longer has its email is `USER_NOT_FOUND` (reset)
     or `EMAIL_NOT_FOUND` (verify), not `INVALID_OOB_CODE`. Real Firebase was not
     checked for an email-change code in that state, so it keeps the old answer
     (`INVALID_OOB_CODE`, code used up).

Additive: `StubAuthOptions.emailEnumerationProtection` and
`tenantEmailEnumerationProtection`, and `UpdateAccountResponse.newEmail`.

### Tests

- `auth-compatibility.test.ts` now has a real mode. It runs under
  `npm run test:integration` when a service account is present and the auth
  emulator is not. It discovers the tenants by name, reads the web API key with
  the service account, and deletes every account in the three pools before each
  test.
- Its expectations are real Firebase's. Each emulator difference is a
  `mode === 'emulator'` branch with a comment. The emulator's project gets email
  enumeration protection turned on, so its project pool matches.
- Real-mode limit: 20 s, from a worst measured test of 9.1 s, and over 11.7 s in
  an earlier run, against the 10 s default.
- CI runs the real mode too (user, 6 November 2026). TeamCity's Integration build
  has the service account and no auth emulator, so every push and nightly deletes
  the test project's accounts and checks Auth against real Firebase. The 20 s
  limit comes from local timings; the first CI builds' timings are still to be
  measured, and any raise needs approval.

### Verification, 6 November 2026

- `npx vitest run src/__tests__/integration/auth-compatibility.test.ts` (stub + real): 55 passed.
- `npx firebase emulators:exec --only auth --project demo-test-project 'npx vitest run src/__tests__/integration/auth-compatibility.test.ts'`
  (stub + emulator): 55 passed.
- `npm run test:unit`: 131 passed. `npm run build` and `npm run format:check` pass.
  `examples/auth-basic.ts` and `examples/auth-tenants.ts` run.

### Residual risk

- Real Firebase can rate-limit quick action links for one email
  (`TOO_MANY_ATTEMPTS_TRY_LATER`). The probe hit it; the test runs have not yet.
  CI now runs the suite on every push and nightly, so it may show there first.
- A local real run at the same time as a CI run deletes the other's accounts.
- The behaviour is one project's on one day. Firebase can change answers, which
  the real mode would show.
