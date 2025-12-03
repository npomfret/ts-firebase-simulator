export type {
    IAggregateQuery,
    IAggregateQuerySnapshot,
    ICollectionReference,
    IDocumentReference,
    IDocumentSnapshot,
    IFirestoreDatabase,
    IQuery,
    IQuerySnapshot,
    ITransaction,
    IWriteBatch,
    OrderByDirection,
    SetOptions,
    WhereFilterOp,
} from './firestore-types';

export { FieldPath, FieldValue, Filter, Timestamp } from 'firebase-admin/firestore';
export { createCloudTasksClient } from './admin-cloudtasks';
export { createFirestoreDatabase } from './admin-firestore';
export { createStorage } from './admin-storage';
export type { ICloudTasksClient } from './cloudtasks-types';
export type { IStorage, IStorageBucket, IStorageFile, StorageFileContent, StorageFileMetadata, StorageSaveOptions } from './storage-types';
export { type EnqueuedTask, StubCloudTasksClient } from './StubCloudTasksClient';
export { type FirestoreTriggerChange, type FirestoreTriggerChangeHandler, type FirestoreTriggerEventType, type FirestoreTriggerHandlers, StubFirestoreDatabase } from './StubFirestoreDatabase';
export { type SeedFileOptions, type StoredFileSnapshot, StubStorage, StubStorageBucket, StubStorageFile, type StubStorageOptions } from './StubStorage';
export {
    attachTriggersToStub,
    type FirestoreProdTrigger,
    type FirestoreTriggerDocumentSnapshot,
    type FirestoreTriggerEvent,
    type FirestoreTriggerHandler,
    registerTriggerWithStub,
    toProdTrigger,
    type TriggerDefinition,
    type TriggerOperation,
} from './triggers';
