# Add a Firebase Auth simulator

**Status:** Phases 1 (users) and 2 (tokens) done; phases 3–5 to do.

## The issue

The package simulates Firestore, Cloud Tasks and Storage, but not Firebase Auth.
`wl-bill-splitter` keeps its own 420-line in-memory Auth stub
(`server/src/__tests__/unit/mocks/StubAuthService.ts`) and wants to replace it with
this package (its task: `tasks/extract-firebase-auth-simulator.md`). It will keep a
thin adapter implementing its own `IAuthService`; the Firebase-like state and
behaviour move here.

What that consumer uses today, through `FirebaseAuthService`:

- **Admin SDK** (`firebase-admin/auth` `Auth`): `createUser`, `getUser`, `getUsers`
  (by uid, in batches of 100), `getUserByEmail`, `updateUser`, `listUsers`,
  `deleteUser`, `verifyIdToken(token, true)`, `createCustomToken`,
  `createSessionCookie`, `verifySessionCookie(cookie, true)`, `revokeRefreshTokens`,
  `generatePasswordResetLink`, `generateEmailVerificationLink`,
  `generateVerifyAndChangeEmailLink`.
- **Identity Toolkit REST** (with a web API key): `accounts:signInWithPassword`
  (with and without `returnSecureToken`), `accounts:signInWithCustomToken`,
  `accounts:resetPassword` (to read a code, and to confirm a reset),
  `accounts:update` with an `oobCode` (to apply email verification and change).
  Errors arrive as `{ error: { message: "REASON : detail" } }`; it acts on
  `INVALID_PASSWORD`, `INVALID_LOGIN_CREDENTIALS`, `EMAIL_NOT_FOUND`, `USER_DISABLED`,
  `INVALID_OOB_CODE`, `EXPIRED_OOB_CODE`, `WEAK_PASSWORD`, `EMAIL_EXISTS`,
  `TOO_MANY_ATTEMPTS_TRY_LATER`.
- **Test controls** on its stub, with call counts outside the stub:
  `setUser` (17), `issueActionCode` (16), `issueIdToken` (13), `failNextUpdates` (5),
  `advanceClock` (4), `remainingUpdateFailures` (3), `failNextLookups` (1),
  `remainingLookupFailures` (1), `clear`. `markUserAsDeleted` has no callers.

The Identity Toolkit half has no Admin SDK equivalent, so it cannot be covered by
wrapping `Auth` alone, unlike the existing three services.

## Proposed API

Two interfaces, because real Firebase splits Auth across two surfaces and a stub
has to sit behind both. Both mirror Firebase's own shapes and errors; nothing
application-specific (null-for-missing, app error types, email sending) comes
into the package.

### `IAuth` — the Admin SDK subset (`auth-types.ts`)

Signatures copied from `firebase-admin/auth` `BaseAuth`, limited to what is used.
Types (`UserRecord`, `DecodedIdToken`, `CreateRequest`, `UpdateRequest`,
`GetUsersResult`, `ListUsersResult`, `SessionCookieOptions`, `UidIdentifier`,
`ActionCodeSettings`) come from `firebase-admin/auth`, as the Firestore types
come from `firebase-admin/firestore`.

```ts
export interface IAuth {
    createUser(properties: CreateRequest): Promise<UserRecord>;
    getUser(uid: string): Promise<UserRecord>;
    getUsers(identifiers: UidIdentifier[]): Promise<GetUsersResult>;
    getUserByEmail(email: string): Promise<UserRecord>;
    updateUser(uid: string, properties: UpdateRequest): Promise<UserRecord>;
    listUsers(maxResults?: number, pageToken?: string): Promise<ListUsersResult>;
    deleteUser(uid: string): Promise<void>;

    createCustomToken(uid: string, developerClaims?: object): Promise<string>;
    verifyIdToken(idToken: string, checkRevoked?: boolean): Promise<DecodedIdToken>;
    createSessionCookie(idToken: string, options: SessionCookieOptions): Promise<string>;
    verifySessionCookie(sessionCookie: string, checkRevoked?: boolean): Promise<DecodedIdToken>;
    revokeRefreshTokens(uid: string): Promise<void>;

    generatePasswordResetLink(email: string, actionCodeSettings?: ActionCodeSettings): Promise<string>;
    generateEmailVerificationLink(email: string, actionCodeSettings?: ActionCodeSettings): Promise<string>;
    generateVerifyAndChangeEmailLink(email: string, newEmail: string, actionCodeSettings?: ActionCodeSettings): Promise<string>;
}

export function createAuth(auth: Auth): IAuth; // admin-auth.ts
```

`getUsers` takes `UidIdentifier[]` rather than `UserIdentifier[]`: only uid lookup
is used, and a narrower parameter is still satisfied by the real `Auth`.

Errors: the real `Auth` throws `FirebaseAuthError`, which `firebase-admin` does not
export. The stub throws an exported `StubAuthError extends Error` carrying the same
`code` (`auth/user-not-found`, `auth/email-already-exists`, `auth/id-token-revoked`,
`auth/session-cookie-expired`, ...) and message, so code that branches on
`error.code` behaves the same against either.

### `IAuthClient` — the Identity Toolkit REST subset (`auth-client-types.ts`)

Request and response bodies as the REST API defines them, trimmed to the fields
used.

```ts
export interface IAuthClient {
    signInWithPassword(request: { email: string; password: string; returnSecureToken: boolean; }): Promise<SignInResponse>;
    signInWithCustomToken(request: { token: string; returnSecureToken: true; }): Promise<SignInResponse>;
    /** `accounts:resetPassword`: without `newPassword` it reads the code; with it, it uses the code. */
    resetPassword(request: { oobCode: string; newPassword?: string; }): Promise<ResetPasswordResponse>;
    /** `accounts:update` with an `oobCode`: applies a VERIFY_EMAIL or VERIFY_AND_CHANGE_EMAIL code. */
    applyActionCode(request: { oobCode: string; }): Promise<UpdateAccountResponse>;
}

export interface SignInResponse { localId: string; email?: string; idToken?: string; refreshToken?: string; expiresIn?: string; }
export interface ResetPasswordResponse { email: string; requestType: 'PASSWORD_RESET' | 'VERIFY_EMAIL' | 'VERIFY_AND_CHANGE_EMAIL'; newEmail?: string; }
export interface UpdateAccountResponse { localId: string; email: string; emailVerified: boolean; }

/** Thrown by both implementations for a non-2xx response. */
export class IdentityToolkitError extends Error {
    readonly status: number;
    /** The reason before " : ", e.g. `INVALID_OOB_CODE`. */
    readonly reason: string;
}

export interface AuthClientConfig {
    apiKey: string;
    /** e.g. `https://identitytoolkit.googleapis.com`, or the emulator's `http://127.0.0.1:9099/identitytoolkit.googleapis.com` */
    baseUrl: string;
}

export function createAuthClient(config: AuthClientConfig): IAuthClient; // admin-auth-client.ts, uses fetch
```

A network failure is rethrown as is; only an HTTP error response becomes an
`IdentityToolkitError`.

### `StubAuth` and its client (`StubAuth.ts`)

One `StubAuth` holds a project's users, tokens and codes. It implements `IAuth`,
and `client()` returns an `IAuthClient` over the same state, as an app's admin and
REST calls reach the same project.

```ts
export class StubAuth implements IAuth {
    constructor(options?: StubAuthOptions); // { projectId?: string } — defaults to 'test-project'
    client(): IAuthClient;

    // Test controls
    /** Replaces any user with the same uid; refuses an email another user has. */
    seedUser(user: SeedUser): UserRecord;
    /** Signs the user in as a custom-token sign-in would (creating a missing user) and returns its ID token. */
    issueIdToken(uid: string): string;
    /** The oobCode Firebase would put in the emailed link; as the matching generate*Link. */
    issueActionCode(email: string, requestType: 'PASSWORD_RESET' | 'VERIFY_EMAIL'): Promise<string>;
    issueActionCode(email: string, requestType: 'VERIFY_AND_CHANGE_EMAIL', newEmail: string): Promise<string>;
    advanceClock(ms: number): void;
    /** The next `count` calls of `operation` for `uid` throw `error`, leaving state unchanged. */
    failNext(operation: 'getUser' | 'updateUser', uid: string, count: number, error: Error): void;
    remainingFailures(operation: 'getUser' | 'updateUser', uid: string): number;
    clear(): void;
}

/** `createUser`'s properties, a required uid, and optionally when the account was created. */
export interface SeedUser extends CreateRequest { uid: string; creationTime?: Date; }
```

The consumer's controls map onto these as: `setUser` → `seedUser`;
`failNextUpdates`/`failNextLookups` → `failNext('updateUser' | 'getUser', ...)`;
`remainingUpdateFailures`/`remainingLookupFailures` → `remainingFailures`;
`issueIdToken`, `issueActionCode`, `advanceClock`, `clear` keep their names.
`markUserAsDeleted` is dropped (no callers; `deleteUser` covers it).

Differences from the consumer's stub, because the real service behaves otherwise
(each to be confirmed by the parity suite, not assumed):

- `seedUser` sets no default password. The consumer's stub gives every seeded
  user `ValidPass123!`; that becomes its adapter's or fixtures' job.
- `getUser`/`getUserByEmail` throw `auth/user-not-found` for a missing user, as
  Firebase does; the consumer's adapter already maps that to `null`. Its stub
  currently throws for a deleted user but returns `null` for one that never existed.
- `issueActionCode` refuses an unknown email, as the `generate*Link` calls do.
- The 100-identifier limit on `getUsers` and the 1–1000 `maxResults` limit on
  `listUsers` are enforced, as the Admin SDK enforces them before any request.
  The consumer's `reconcile-auth-accounts` test calls `listUsers` with
  `maxResults: 10_000`, which the real SDK refuses; that test changes in its
  migration.
- Custom tokens, ID tokens and session cookies are all JWTs with the emulator's
  claims, signed with a key private to each `StubAuth`, so only its own tokens
  verify. (The consumer's driver inspects token shape.)
- `createCustomToken` does not look the user up, as Firebase does not; the
  consumer's stub refuses a missing user.
- `issueIdToken` creates a user that does not exist, as a custom-token sign-in
  does, and refuses a disabled one with `auth/user-disabled`.
- `verifyIdToken` and `verifySessionCookie` look the user up (deleted, disabled,
  revoked) only with `checkRevoked`, as real Firebase does. Against the emulator
  the Admin SDK always looks it up, so parity tests pass `checkRevoked: true`.

New exports, all additive, so a minor version: `IAuth`, `IAuthClient`,
`createAuth`, `createAuthClient`, `AuthClientConfig`, `SignInResponse`,
`ResetPasswordResponse`, `UpdateAccountResponse`, `IdentityToolkitError`,
`StubAuth`, `StubAuthOptions`, `StubAuthError`, `SeedUser`, `FailableAuthOperation`.

## Decisions

- **The consumer's adapter is its production `FirebaseAuthService`.** It takes
  `IAuth` + `IAuthClient` instead of `Auth` + a fetch config, and its unit tests
  run it over `StubAuth`, so the tests exercise production error mapping. Its
  unit tests then reach the `send*Email` paths and need its email factory
  stubbed; that is the consumer's migration work. Here it means `createAuth` and
  `createAuthClient` are production code, not test helpers.
- **Auth parity runs against the stub and the emulator only.** No real-Firebase
  mode: it would create real users and need a web API key and the Email/Password
  provider enabled. Behaviour the emulator does not reproduce faithfully is
  recorded as a limitation, not checked against real Firebase.

## Plan

Each phase ends with `npm run build`, `npm run test:unit`, `npm run
test:with-emulator` and `npm run format:check` passing.

1. [x] **Users.** `IAuth` user operations, `createAuth`, `StubAuth` with `seedUser`,
   `clear`, `failNext`/`remainingFailures`. Auth emulator added to
   `firebase.json` (port 9099). Parity tests (stub and emulator) in
   `src/__tests__/integration/auth-compatibility.test.ts`: create, duplicate email
   and uid, get/update/delete, missing users, `getUsers` with unknown and repeated
   uids and its 100 limit, `listUsers` paging and its 1–1000 limit.
   Verified: `npm run build`, `npm run test:unit` (111 passed),
   `npm run test:with-emulator` (91 passed, Auth on stub and emulator),
   `npm run format:check`.

   Emulator behaviour the stub mirrors, found by probing it: emails stored and
   matched in lower case; generated uids are 28 alphanumerics; `lastSignInTime`
   equals `creationTime` at creation; `tokensValidAfterTime` is set by creating
   with a password and by changing the password or email; `lastRefreshTime` is
   set by changing the password; the password provider appears only when the user
   has both an email and a password; `listUsers` pages in uid order with the last
   uid as page token, returned whenever a page is full; `getUsers`' limit throws
   synchronously.

   Limitations: no input validation (malformed email, short password, uid
   length, photo URL), which the Admin SDK does before any request; no
   `passwordHash`/`passwordSalt`; no custom claims; `getUsers` by uid only. The
   emulator's admin-created accounts showing a `lastSignInTime` may differ from
   real Firebase, which is not checked.
2. [x] **Tokens.** `createCustomToken`, `verifyIdToken`, `createSessionCookie`,
   `verifySessionCookie`, `revokeRefreshTokens`; `StubAuthOptions` (`projectId`),
   `issueIdToken`, `advanceClock`. Parity: ID token claims, sign-in recorded in
   metadata, a custom-token sign-in creating its user, malformed and
   wrong-kind tokens, cookie claims and duration limits, revocation a second
   later, disabled and deleted users. Stub unit tests cover what the emulator
   cannot: expiry (an hour, five minutes), survival of a token signed in during
   the revocation second, the unchecked path, foreign signatures and projects.
   The emulator scripts now pass `--project demo-test-project`: without it the
   emulator ran as `demo-no-project`, so REST sign-ins and Admin calls reached
   different projects. Verified: `npm run build`, `npm run test:unit`
   (118 passed), `npm run test:with-emulator` (103 passed, Auth on stub and
   emulator), `npm run format:check`.

   Emulator and SDK behaviour the stub mirrors: ID token claims (`name`,
   `picture`, `email`, `email_verified`, `phone_number`, `firebase.identities`,
   `sign_in_provider`), an hour's life; sign-in sets `lastSignInTime` and
   `lastRefreshTime`; revocation compares `auth_time` with `tokensValidAfterTime`
   in whole seconds; a cookie keeps the ID token's claims and `auth_time`, with
   its own issuer, `iat` and `exp`; the cookie duration is checked in whole
   seconds, rounded down; `createSessionCookie` refuses a revoked ID token as
   `auth/id-token-expired`; the SDK's error codes and messages for each refusal.

   Limitations: no validation of custom tokens' uid length or reserved claims;
   which error wins when a token fails more than one check is not verified;
   token signing is not Google's, so stub tokens verify only against their own
   `StubAuth`.
3. **Client sign-in.** `IAuthClient` sign-in methods, `IdentityToolkitError`,
   `createAuthClient`, `StubAuth.client()`. Parity: wrong password, unknown email,
   disabled user, invalid custom token, `returnSecureToken: false`.
4. **Action codes.** `generate*Link`, `issueActionCode`, `resetPassword`,
   `applyActionCode`. Parity: single use, wrong type for the call, reset marks the
   email verified and revokes tokens, email change to an address taken meanwhile.
5. **Docs.** `examples/auth-basic.ts`, README section, CONTRIBUTING (Auth emulator;
   Auth has no real-Firebase mode, as Cloud Tasks has no emulator). Record here
   the coverage reached and any limitation found.

Publishing the new version is the user's step; the consumer's migration then
proceeds under its own task.
