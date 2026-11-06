# Firebase Simulator

An in-memory, TypeScript simulator for _some_ firebase services - for use in unit tests.

## Examples

The easiest way to understand it to look at the [examples](examples/) directory for targeted, single-concept code samples covering:

- Firestore CRUD, queries, transactions, triggers
- Cloud Storage operations
- Auth users, sign-in, tokens and action codes
- Cloud Tasks creation and assertions
- Dependency injection patterns

## The Problem

Firebase doesn't provide TypeScript interfaces for its classes, making it difficult to write unit tests that swap real implementations for test doubles. This package aims to solve that problem.

```typescript
// You can't do this - Firestore is a concrete class, not an interface
class MyService {
    constructor(private db: Firestore) {} // No nice way to inject a stub or mock
}
```

Firebase's SDK exports concrete classes (`Firestore`, `CloudTasksClient`, `Storage`, `Auth`) without corresponding interfaces. This means:
- You can't create mock implementations for unit testing
- You're forced to use the Firebase Emulator for all tests (slow)
- Dependency injection patterns don't work

## The Solution

This package provides:
1. **Interfaces** (`IFirestoreDatabase`, `ICloudTasksClient`, `IStorage`, `IAuth`, `IAuthClient`) that mirror Firebase's API
2. **Stub implementations** (`StubFirestoreDatabase`, `StubCloudTasksClient`, `StubStorage`, `StubAuth`) for fast, in-memory unit tests
3. **Wrapper factories** (`createFirestoreDatabase`, `createCloudTasksClient`, `createStorage`, `createAuth`, `createAuthClient`) that adapt real Firebase instances to the interfaces

```typescript
import { IFirestoreDatabase, StubFirestoreDatabase, createFirestoreDatabase } from 'ts-firebase-simulator';

class MyService {
    constructor(private db: IFirestoreDatabase) {} // Now accepts both real and stub
}

// In production
const realDb = createFirestoreDatabase(getFirestore());
const service = new MyService(realDb);

// In unit tests
const stubDb = new StubFirestoreDatabase();
const service = new MyService(stubDb);
```

## Installation

```bash
npm install ts-firebase-simulator
```

## Quick Start

```typescript
import {
    IFirestoreDatabase,
    StubFirestoreDatabase,
    createFirestoreDatabase,
    Timestamp,
} from 'ts-firebase-simulator';

// In unit tests - fast, in-memory, no Firebase connection
const db = new StubFirestoreDatabase();

await db.collection('users').doc('user-1').set({
    name: 'Alice',
    createdAt: Timestamp.now(),
});

const snapshot = await db.collection('users').doc('user-1').get();
console.log(snapshot.data()); // { name: 'Alice', createdAt: ... }

// Clean up between tests
db.clear();
```

## Interfaces

### IFirestoreDatabase

Use instead of `Firestore` from `firebase-admin/firestore`:

```typescript
interface IFirestoreDatabase {
    collection(path: string): ICollectionReference;
    doc(path: string): IDocumentReference;
    collectionGroup(collectionId: string): IQuery;
    batch(): IWriteBatch;
    runTransaction<T>(fn: (transaction: ITransaction) => Promise<T>): Promise<T>;
}
```

### ICloudTasksClient

Use instead of `CloudTasksClient` from `@google-cloud/tasks`:

```typescript
interface ICloudTasksClient {
    queuePath(project: string, location: string, queue: string): string;
    createTask(request: CreateTaskRequest): Promise<[Task]>;
}
```

### IStorage

Use instead of `Storage` from `firebase-admin/storage`:

```typescript
interface IStorage {
    bucket(name?: string): IStorageBucket;
}

interface IStorageBucket {
    readonly name: string;
    file(path: string): IStorageFile;
    getFiles(options?: { prefix?: string }): Promise<[IStorageFile[]]>;
}

interface IStorageFile {
    readonly name: string;
    save(data: StorageFileContent, options?: StorageSaveOptions): Promise<void>;
    makePublic(): Promise<void>;
    delete(): Promise<void>;
    exists(): Promise<[boolean]>;
    getMetadata(): Promise<[StorageFileMetadata]>;
    createReadStream(): Readable;
    getSignedUrl(config: GetSignedUrlConfig): Promise<[string]>;
}
```

### IAuth

Use instead of `Auth` from `firebase-admin/auth`. The subset supported, with the same signatures and `firebase-admin/auth` types:

```typescript
interface IAuth {
    createUser(properties: CreateRequest): Promise<UserRecord>;
    getUser(uid: string): Promise<UserRecord>;
    getUsers(identifiers: UidIdentifier[]): Promise<GetUsersResult>; // by uid only
    getUserByEmail(email: string): Promise<UserRecord>;
    updateUser(uid: string, properties: UpdateRequest): Promise<UserRecord>;
    listUsers(maxResults?: number, pageToken?: string): Promise<ListUsersResult>;
    deleteUser(uid: string): Promise<void>;

    createCustomToken(uid: string, developerClaims?: object): Promise<string>;
    verifyIdToken(idToken: string, checkRevoked?: boolean): Promise<DecodedIdToken>;
    createSessionCookie(idToken: string, sessionCookieOptions: SessionCookieOptions): Promise<string>;
    verifySessionCookie(sessionCookie: string, checkRevoked?: boolean): Promise<DecodedIdToken>;
    revokeRefreshTokens(uid: string): Promise<void>;

    generatePasswordResetLink(email: string): Promise<string>; // no actionCodeSettings
    generateEmailVerificationLink(email: string): Promise<string>;
    generateVerifyAndChangeEmailLink(email: string, newEmail: string): Promise<string>;
}
```

### ITenantAwareAuth and ITenantManager

Use instead of `TenantAwareAuth` and `TenantManager` for Identity Platform multi-tenancy. Each tenant is its own pool of accounts: the same email can be registered in several tenants, with separate passwords, action codes and revocation.

```typescript
interface ITenantAwareAuth extends IAuth {
    readonly tenantId: string;
}

interface ITenantManager {
    authForTenant(tenantId: string): ITenantAwareAuth; // auth/invalid-tenant-id for ''
}
```

As in the Admin SDK:
- A tenant's ID tokens and session cookies carry `firebase.tenant`, and its custom tokens `tenant_id`; its user records have `tenantId`.
- A tenant's `verifyIdToken`, `verifySessionCookie` and `createSessionCookie` refuse a token of another tenant, or of the project itself, with `auth/mismatching-tenant-id`. With `checkRevoked` the user is looked up in the tenant first, so a uid it does not have fails with `auth/user-not-found` instead. Against the emulator the Admin SDK always looks the user up; the stub, like real Firebase, only with `checkRevoked`.
- The project-level `IAuth` checks no tenant: it accepts a tenant's token, and with `checkRevoked` looks its uid up among the project's own users. Verify with the tenant's instance to enforce the tenant.

### IAuthClient

The Firebase Auth REST API (Identity Toolkit) calls a server makes with a web API key, which the Admin SDK does not cover. An error response throws an `IdentityToolkitError` with Firebase's `status`, `message` and `reason` (e.g. `INVALID_PASSWORD`). Each request's optional `tenantId` selects the tenant it acts in; without it, it acts on the project's own users:

```typescript
interface IAuthClient {
    signInWithPassword(request: { email: string; password: string; returnSecureToken: boolean; tenantId?: string }): Promise<SignInWithPasswordResponse>;
    signInWithCustomToken(request: { token: string; returnSecureToken: true; tenantId?: string }): Promise<SignInWithCustomTokenResponse>;
    resetPassword(request: { oobCode: string; newPassword?: string; tenantId?: string }): Promise<ResetPasswordResponse>; // reads a code without newPassword
    applyActionCode(request: { oobCode: string; tenantId?: string }): Promise<UpdateAccountResponse>; // accounts:update with an oobCode
}
```

A custom token minted for one tenant is refused in another tenant's sign-in, or in a sign-in naming no tenant, with `TENANT_ID_MISMATCH`. A project's custom token is refused in a tenant's sign-in with HTTP 500 `Internal error encountered.`, as Firebase answers it. An action code works only in the pool it was issued in: elsewhere it is `INVALID_OOB_CODE`.

## Stub Features

### StubFirestoreDatabase

Full in-memory Firestore implementation:
- Document CRUD (`set`, `get`, `update`, `delete`)
- Collections and subcollections
- Queries (`where`, `orderBy`, `limit`, `offset`, `startAfter`)
- Collection group queries
- Transactions and batch writes
- Real-time listeners (`onSnapshot`)
- Firestore triggers for testing Cloud Functions

### StubCloudTasksClient

In-memory Cloud Tasks:
- Task creation with HTTP request details
- Queue path generation
- Task tracking for assertions (`getEnqueuedTasks()`, `getLastEnqueuedTask()`)

### StubStorage

In-memory Firebase Storage:
- File save/delete operations
- Metadata support (`getMetadata()`)
- File existence checks (`exists()`)
- Read streams (`createReadStream()`)
- Signed URL generation (`getSignedUrl()`) - generates mock URLs without requiring credentials
- File listing (`getFiles()`, `getAllFiles()`, `getFile()`)
- Test utilities (`seedFile()`, `clear()`)

### StubAuth

In-memory Firebase Auth for one project, behaving as real Firebase does. Its behaviour is checked against a real project, and where the Auth emulator differs, the stub follows Firebase:
- User management, with Firebase's errors (`auth/user-not-found`, `auth/email-already-exists`, ...) and limits
- ID tokens, custom tokens and session cookies as signed JWTs that only the same `StubAuth` verifies; expiry and revocation
- `client()`: an `IAuthClient` over the same users and tenants, for password and custom-token sign-in and action codes
- Action codes (password reset, email verification, email change), each usable once
- Email enumeration protection, per pool: on for the project's pool unless `emailEnumerationProtection: false`, and off for a tenant unless its entry in `tenants` sets `emailEnumerationProtection: true`. With it on, an unknown email, a wrong password and an account without one are all `INVALID_LOGIN_CREDENTIALS`, and a link that would reveal whether an email has an account is withheld (`auth/internal-error`), as Firebase does
- Tenants, declared when the stub is made, as a real project's are created: `new StubAuth({ tenants: { 'tenant-a': {}, 'tenant-b': { emailEnumerationProtection: true } } })`. `tenantManager().authForTenant(id)` gives a `StubTenantAwareAuth` over that tenant's own pool, sharing the `StubAuth`'s tokens and clock. As in Firebase, a tenant not declared is refused: its Admin operations that reach Firebase fail with `auth/internal-error` carrying `INVALID_TENANT_ID`. `createCustomToken` succeeds, as the SDK signs it locally. `verifyIdToken` and `verifySessionCookie` without `checkRevoked`, and `createSessionCookie`, refuse the token first (`auth/mismatching-tenant-id`). REST requests naming it fail with `INVALID_TENANT_ID`. The emulator differs: it creates a tenant on first use
- Test utilities (`seedUser()`, `issueIdToken()`, `issueActionCode()`, `failNext()`, `remainingFailures()`, on `StubAuth` for the project's pool and on each `StubTenantAwareAuth` for its own; `advanceClock()` and `clear()` on `StubAuth`, for every pool)

Two `StubAuth` instances share nothing: neither accounts nor signing keys.

Not simulated: input validation (malformed email, short password at creation), custom claims, action code expiry, `actionCodeSettings`, the `apiKey` in action links, and rate limiting (real Firebase may refuse several quick links for one email with `TOO_MANY_ATTEMPTS_TRY_LATER`). Tenants are not managed after the stub is made (no `createTenant`, `getTenant` or `listTenants`).

## Production Wrappers

Wrap real Firebase instances to use the interfaces:

```typescript
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getAuth } from 'firebase-admin/auth';
import { CloudTasksClient } from '@google-cloud/tasks';
import { createFirestoreDatabase, createCloudTasksClient, createStorage, createAuth, createAuthClient, createTenantManager } from 'ts-firebase-simulator';

// Firestore
const db: IFirestoreDatabase = createFirestoreDatabase(getFirestore());

// Cloud Tasks
const tasks: ICloudTasksClient = createCloudTasksClient(); // Uses real CloudTasksClient internally

// Storage
const storage: IStorage = createStorage(getStorage());

// Auth
const auth: IAuth = createAuth(getAuth());
const authClient: IAuthClient = createAuthClient({ apiKey: process.env.FIREBASE_API_KEY!, baseUrl: 'https://identitytoolkit.googleapis.com' });
const tenantAuth: ITenantAwareAuth = createTenantManager(getAuth().tenantManager()).authForTenant(tenantId);
```

## Testing Firestore Triggers

Register triggers to test Cloud Functions behavior:

```typescript
const db = new StubFirestoreDatabase();

const unregister = db.registerTrigger('users/{userId}', {
    onCreate: (change) => console.log('Created:', change.after.data()),
    onUpdate: (change) => console.log('Updated:', change.before.data(), '->', change.after.data()),
    onDelete: (change) => console.log('Deleted:', change.before.data()),
});

await db.collection('users').doc('user-1').set({ name: 'Alice' });
// Logs: Created: { name: 'Alice' }

unregister();
```

## Contributing

This package includes [integration tests](src/__tests__/integration) that verify stub behavior matches real Firebase. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions.

## License

MIT
