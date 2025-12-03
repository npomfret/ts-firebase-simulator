# Firebase Simulator

An in-memory, TypeScript simulator for _some_ firebase services - for use in unit tests.

## The Problem

Firebase doesn't provide TypeScript interfaces for its classes, making it difficult to write unit tests that swap real implementations for test doubles. This package aims to solve that problem.

```typescript
// You can't do this - Firestore is a concrete class, not an interface
class MyService {
    constructor(private db: Firestore) {} // No nice way to inject a stub or mock
}
```

Firebase's SDK exports concrete classes (`Firestore`, `CloudTasksClient`, `Storage`) without corresponding interfaces. This means:
- You can't create mock implementations for unit testing
- You're forced to use the Firebase Emulator for all tests (slow)
- Dependency injection patterns don't work

## The Solution

This package provides:
1. **Interfaces** (`IFirestoreDatabase`, `ICloudTasksClient`, `IStorage`) that mirror Firebase's API
2. **Stub implementations** (`StubFirestoreDatabase`, `StubCloudTasksClient`, `StubStorage`) for fast, in-memory unit tests
3. **Wrapper factories** (`createFirestoreDatabase`, `createCloudTasksClient`, `createStorage`) that adapt real Firebase instances to the interfaces

```typescript
import { IFirestoreDatabase, StubFirestoreDatabase, createFirestoreDatabase } from '@billsplit-wl/firebase-simulator';

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
npm install @billsplit-wl/firebase-simulator
```

## Quick Start

```typescript
import {
    IFirestoreDatabase,
    StubFirestoreDatabase,
    createFirestoreDatabase,
    Timestamp,
} from '@billsplit-wl/firebase-simulator';

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
}

interface IStorageFile {
    save(data: StorageFileContent, options?: StorageSaveOptions): Promise<void>;
    makePublic(): Promise<void>;
    delete(): Promise<void>;
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
- File save/delete
- Metadata support
- File listing for assertions (`getAllFiles()`, `getFile()`)

## Production Wrappers

Wrap real Firebase instances to use the interfaces:

```typescript
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { CloudTasksClient } from '@google-cloud/tasks';
import { createFirestoreDatabase, createCloudTasksClient, createStorage } from '@billsplit-wl/firebase-simulator';

// Firestore
const db: IFirestoreDatabase = createFirestoreDatabase(getFirestore());

// Cloud Tasks
const tasks: ICloudTasksClient = createCloudTasksClient(); // Uses real CloudTasksClient internally

// Storage
const storage: IStorage = createStorage(getStorage());
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
