/**
 * Firestore Wrapper Implementations
 *
 * Provides concrete implementations of the shared Firestore interfaces that
 * delegate to firebase-admin's Firestore. This gives consumers a consistent
 * abstraction regardless of whether they run against the real database or the stub.
 */

import type * as FirebaseAdmin from 'firebase-admin/firestore';
import type {
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

class DocumentSnapshotWrapper implements IDocumentSnapshot {
    constructor(private readonly snapshot: FirebaseAdmin.DocumentSnapshot) {}

    get exists(): boolean {
        return this.snapshot.exists;
    }

    get id(): string {
        return this.snapshot.id;
    }

    get ref(): IDocumentReference {
        return new DocumentReferenceWrapper(this.snapshot.ref);
    }

    data(): any | undefined {
        return this.snapshot.data();
    }
}

class QuerySnapshotWrapper implements IQuerySnapshot {
    constructor(private readonly snapshot: FirebaseAdmin.QuerySnapshot) {}

    get docs(): IDocumentSnapshot[] {
        return this.snapshot.docs.map((doc) => new DocumentSnapshotWrapper(doc));
    }

    get empty(): boolean {
        return this.snapshot.empty;
    }

    get size(): number {
        return this.snapshot.size;
    }

    forEach(callback: (result: IDocumentSnapshot) => void): void {
        this.snapshot.forEach((doc) => callback(new DocumentSnapshotWrapper(doc)));
    }
}

class AggregateQuerySnapshotWrapper implements IAggregateQuerySnapshot {
    constructor(private readonly snapshot: FirebaseAdmin.AggregateQuerySnapshot<{ count: FirebaseAdmin.AggregateField<number>; }>) {}

    data(): { count: number; } {
        return { count: this.snapshot.data().count };
    }
}

class AggregateQueryWrapper implements IAggregateQuery {
    constructor(private readonly aggregateQuery: FirebaseAdmin.AggregateQuery<{ count: FirebaseAdmin.AggregateField<number>; }>) {}

    async get(): Promise<IAggregateQuerySnapshot> {
        const snapshot = await this.aggregateQuery.get();
        return new AggregateQuerySnapshotWrapper(snapshot);
    }
}

class QueryWrapper implements IQuery {
    constructor(protected readonly query: FirebaseAdmin.Query) {}

    where(fieldPath: string | any, opStr?: WhereFilterOp | any, value?: any): IQuery {
        if (opStr !== undefined && value !== undefined) {
            return new QueryWrapper(this.query.where(fieldPath, opStr, value));
        }
        return new QueryWrapper(this.query.where(fieldPath));
    }

    orderBy(fieldPath: string, directionStr?: OrderByDirection): IQuery {
        return new QueryWrapper(this.query.orderBy(fieldPath, directionStr));
    }

    limit(limit: number): IQuery {
        return new QueryWrapper(this.query.limit(limit));
    }

    offset(offset: number): IQuery {
        return new QueryWrapper(this.query.offset(offset));
    }

    startAfter(...fieldValues: any[]): IQuery {
        const unwrappedValues = fieldValues.map((value) => {
            if (value && typeof value === 'object' && 'snapshot' in value) {
                return (value as DocumentSnapshotWrapper)['snapshot'];
            }
            return value;
        });
        return new QueryWrapper(this.query.startAfter(...unwrappedValues));
    }

    select(...fieldPaths: string[]): IQuery {
        return new QueryWrapper(this.query.select(...fieldPaths));
    }

    onSnapshot(onNext: (snapshot: IQuerySnapshot) => void, onError?: (error: Error) => void): () => void {
        const unsubscribe = this.query.onSnapshot(
            (snapshot) => onNext(new QuerySnapshotWrapper(snapshot)),
            onError,
        );
        return unsubscribe;
    }

    async get(): Promise<IQuerySnapshot> {
        const snapshot = await this.query.get();
        return new QuerySnapshotWrapper(snapshot);
    }

    count(): IAggregateQuery {
        return new AggregateQueryWrapper(this.query.count());
    }
}

class CollectionReferenceWrapper extends QueryWrapper implements ICollectionReference {
    constructor(private readonly collectionRef: FirebaseAdmin.CollectionReference) {
        super(collectionRef);
    }

    get parent(): IDocumentReference | null {
        return this.collectionRef.parent ? new DocumentReferenceWrapper(this.collectionRef.parent) : null;
    }

    doc(documentId?: string): IDocumentReference {
        return new DocumentReferenceWrapper(documentId ? this.collectionRef.doc(documentId) : this.collectionRef.doc());
    }
}

class DocumentReferenceWrapper implements IDocumentReference {
    constructor(private readonly docRef: FirebaseAdmin.DocumentReference) {}

    get id(): string {
        return this.docRef.id;
    }

    get path(): string {
        return this.docRef.path;
    }

    get parent(): ICollectionReference | null {
        return this.docRef.parent ? new CollectionReferenceWrapper(this.docRef.parent) : null;
    }

    collection(collectionPath: string): ICollectionReference {
        return new CollectionReferenceWrapper(this.docRef.collection(collectionPath));
    }

    onSnapshot(onNext: (snapshot: IDocumentSnapshot) => void, onError?: (error: Error) => void): () => void {
        const unsubscribe = this.docRef.onSnapshot(
            (snapshot) => onNext(new DocumentSnapshotWrapper(snapshot)),
            onError,
        );
        return unsubscribe;
    }

    async get(): Promise<IDocumentSnapshot> {
        const snapshot = await this.docRef.get();
        return new DocumentSnapshotWrapper(snapshot);
    }

    async set(data: any, options?: SetOptions): Promise<void> {
        if (options) {
            await this.docRef.set(data, options as FirebaseAdmin.SetOptions);
        } else {
            await this.docRef.set(data);
        }
    }

    async update(data: any): Promise<void> {
        await this.docRef.update(data);
    }

    async delete(): Promise<void> {
        await this.docRef.delete();
    }
}

class WriteBatchWrapper implements IWriteBatch {
    constructor(private readonly batch: FirebaseAdmin.WriteBatch) {}

    set(documentRef: IDocumentReference, data: any, options?: SetOptions): IWriteBatch {
        const ref = (documentRef as DocumentReferenceWrapper)['docRef'];
        if (options) {
            this.batch.set(ref, data, options as FirebaseAdmin.SetOptions);
        } else {
            this.batch.set(ref, data);
        }
        return this;
    }

    update(documentRef: IDocumentReference, data: any): IWriteBatch {
        const ref = (documentRef as DocumentReferenceWrapper)['docRef'];
        this.batch.update(ref, data);
        return this;
    }

    delete(documentRef: IDocumentReference): IWriteBatch {
        const ref = (documentRef as DocumentReferenceWrapper)['docRef'];
        this.batch.delete(ref);
        return this;
    }

    async commit(): Promise<void> {
        await this.batch.commit();
    }
}

class TransactionWrapper implements ITransaction {
    constructor(private readonly transaction: FirebaseAdmin.Transaction) {}

    async get(documentRef: IDocumentReference): Promise<IDocumentSnapshot>;
    async get(query: IQuery): Promise<IQuerySnapshot>;
    async get(refOrQuery: IDocumentReference | IQuery): Promise<IDocumentSnapshot | IQuerySnapshot> {
        if (refOrQuery instanceof DocumentReferenceWrapper) {
            const snapshot = await this.transaction.get(refOrQuery['docRef']);
            return new DocumentSnapshotWrapper(snapshot);
        }

        if (refOrQuery instanceof QueryWrapper) {
            const snapshot = await this.transaction.get(refOrQuery['query']);
            return new QuerySnapshotWrapper(snapshot);
        }

        throw new Error('Unsupported reference type for transaction.get');
    }

    set(documentRef: IDocumentReference, data: any, options?: SetOptions): ITransaction {
        if (!(documentRef instanceof DocumentReferenceWrapper)) {
            throw new Error('Unsupported document reference for transaction.set');
        }
        if (options) {
            this.transaction.set(documentRef['docRef'], data, options as FirebaseAdmin.SetOptions);
        } else {
            this.transaction.set(documentRef['docRef'], data);
        }
        return this;
    }

    update(documentRef: IDocumentReference, data: any): ITransaction {
        if (!(documentRef instanceof DocumentReferenceWrapper)) {
            throw new Error('Unsupported document reference for transaction.update');
        }
        this.transaction.update(documentRef['docRef'], data);
        return this;
    }

    delete(documentRef: IDocumentReference): ITransaction {
        if (!(documentRef instanceof DocumentReferenceWrapper)) {
            throw new Error('Unsupported document reference for transaction.delete');
        }
        this.transaction.delete(documentRef['docRef']);
        return this;
    }

    create(documentRef: IDocumentReference, data: any): ITransaction {
        if (!(documentRef instanceof DocumentReferenceWrapper)) {
            throw new Error('Unsupported document reference for transaction.create');
        }
        this.transaction.create(documentRef['docRef'], data);
        return this;
    }
}

class FirestoreDatabaseWrapper implements IFirestoreDatabase {
    constructor(private readonly firestore: FirebaseAdmin.Firestore) {}

    collection(collectionPath: string): ICollectionReference {
        return new CollectionReferenceWrapper(this.firestore.collection(collectionPath));
    }

    doc(documentPath: string): IDocumentReference {
        return new DocumentReferenceWrapper(this.firestore.doc(documentPath));
    }

    collectionGroup(collectionId: string): IQuery {
        return new QueryWrapper(this.firestore.collectionGroup(collectionId));
    }

    batch(): IWriteBatch {
        return new WriteBatchWrapper(this.firestore.batch());
    }

    async runTransaction<T>(updateFunction: (transaction: ITransaction) => Promise<T>): Promise<T> {
        return this.firestore.runTransaction(async (transaction) => {
            const wrapper = new TransactionWrapper(transaction);
            return updateFunction(wrapper);
        });
    }

    async listCollections(): Promise<ICollectionReference[]> {
        const collections = await this.firestore.listCollections();
        return collections.map((collection) => new CollectionReferenceWrapper(collection));
    }

    seed(): void {
        throw new Error('seed is only available on StubFirestoreDatabase');
    }

    clear(): void {
        throw new Error('clear is only available on StubFirestoreDatabase');
    }
}

export function createFirestoreDatabase(firestore: FirebaseAdmin.Firestore): IFirestoreDatabase {
    return new FirestoreDatabaseWrapper(firestore);
}
