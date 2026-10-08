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

### IAuthClient

The Firebase Auth REST API (Identity Toolkit) calls a server makes with a web API key, which the Admin SDK does not cover. An error response throws an `IdentityToolkitError` with Firebase's `status`, `message` and `reason` (e.g. `INVALID_PASSWORD`):

```typescript
interface IAuthClient {
    signInWithPassword(request: { email: string; password: string; returnSecureToken: boolean }): Promise<SignInWithPasswordResponse>;
    signInWithCustomToken(request: { token: string; returnSecureToken: true }): Promise<SignInWithCustomTokenResponse>;
    resetPassword(request: { oobCode: string; newPassword?: string }): Promise<ResetPasswordResponse>; // reads a code without newPassword
    applyActionCode(request: { oobCode: string }): Promise<UpdateAccountResponse>; // accounts:update with an oobCode
}
```

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

In-memory Firebase Auth for one project, behaving as the Auth emulator does:
- User management, with Firebase's errors (`auth/user-not-found`, `auth/email-already-exists`, ...) and limits
- ID tokens, custom tokens and session cookies as signed JWTs that only the same `StubAuth` verifies; expiry and revocation
- `client()`: an `IAuthClient` over the same users, for password and custom-token sign-in and action codes
- Action codes (password reset, email verification, email change), each usable once
- Test utilities (`seedUser()`, `issueIdToken()`, `issueActionCode()`, `advanceClock()`, `failNext()`, `remainingFailures()`, `clear()`)

Not simulated: input validation (malformed email, short password at creation), custom claims, action code expiry, `actionCodeSettings`, rate limiting, and email enumeration protection (real projects answer both a wrong password and an unknown email with `INVALID_LOGIN_CREDENTIALS`; the emulator and the stub do not).

## Production Wrappers

Wrap real Firebase instances to use the interfaces:

```typescript
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getAuth } from 'firebase-admin/auth';
import { CloudTasksClient } from '@google-cloud/tasks';
import { createFirestoreDatabase, createCloudTasksClient, createStorage, createAuth, createAuthClient } from 'ts-firebase-simulator';

// Firestore
const db: IFirestoreDatabase = createFirestoreDatabase(getFirestore());

// Cloud Tasks
const tasks: ICloudTasksClient = createCloudTasksClient(); // Uses real CloudTasksClient internally

// Storage
const storage: IStorage = createStorage(getStorage());

// Auth
const auth: IAuth = createAuth(getAuth());
const authClient: IAuthClient = createAuthClient({ apiKey: process.env.FIREBASE_API_KEY!, baseUrl: 'https://identitytoolkit.googleapis.com' });
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
