/**
 * Firestore Wrapper Types
 *
 * This module provides wrapper interfaces that abstract away direct Firestore dependencies.
 * Copied from firebase/functions/src/firestore-wrapper/types.ts for use in test-support.
 */

/**
 * Options for set operations
 */
export interface SetOptions {
    merge?: boolean;
    mergeFields?: string[];
}

/**
 * Where filter operations
 */
export type WhereFilterOp = '<' | '<=' | '==' | '!=' | '>=' | '>' | 'array-contains' | 'in' | 'array-contains-any' | 'not-in';

/**
 * Order direction
 */
export type OrderByDirection = 'asc' | 'desc';

/**
 * Wrapper for Firestore DocumentSnapshot
 * Abstracts the actual Firestore DocumentSnapshot
 */
export interface IDocumentSnapshot {
    /** Whether the document exists */
    readonly exists: boolean;

    /** The document's unique identifier */
    readonly id: string;

    /** Reference to the document */
    readonly ref: IDocumentReference;

    /**
     * Get the document's data
     * @returns Document data or undefined if document doesn't exist
     */
    data(): any | undefined;
}

/**
 * Wrapper for Firestore QuerySnapshot
 * Abstracts the actual Firestore QuerySnapshot
 */
export interface IQuerySnapshot {
    /** Array of document snapshots */
    readonly docs: IDocumentSnapshot[];

    /** True if there are no documents */
    readonly empty: boolean;

    /** Number of documents in the result set */
    readonly size: number;

    /**
     * Iterate over query results
     * @param callback - Function to call for each document
     */
    forEach(callback: (result: IDocumentSnapshot) => void): void;
}

/**
 * Wrapper for Firestore Aggregate Query (for count operations)
 * Abstracts the count query result
 */
export interface IAggregateQuery {
    /**
     * Execute the aggregate query
     * @returns Aggregate query result
     */
    get(): Promise<IAggregateQuerySnapshot>;
}

/**
 * Wrapper for Firestore Aggregate Query Snapshot
 * Contains the result of count queries
 */
export interface IAggregateQuerySnapshot {
    /**
     * Get the aggregate data (e.g., count)
     * @returns Object with count property
     */
    data(): { count: number; };
}

/**
 * Wrapper for Firestore DocumentReference
 * Abstracts the actual Firestore DocumentReference
 */
export interface IDocumentReference {
    /** The document's unique identifier */
    readonly id: string;

    /** The full path to this document */
    readonly path: string;

    /**
     * Get a reference to a subcollection
     * @param collectionPath - The subcollection path
     * @returns Collection reference
     */
    collection(collectionPath: string): ICollectionReference;

    /**
     * Fetch the document
     * @returns Document snapshot
     */
    get(): Promise<IDocumentSnapshot>;

    /**
     * Write to the document
     * @param data - Document data
     * @param options - Set options (merge, mergeFields)
     */
    set(data: any, options?: SetOptions): Promise<void>;

    /**
     * Update the document
     * @param data - Fields to update
     */
    update(data: any): Promise<void>;

    /**
     * Delete the document
     */
    delete(): Promise<void>;

    /**
     * Listen for realtime updates to the document.
     * @param onNext - callback invoked with each snapshot
     * @param onError - optional error handler
     * @returns unsubscribe function
     */
    onSnapshot(onNext: (snapshot: IDocumentSnapshot) => void, onError?: (error: Error) => void): () => void;

    /** Access to the parent property for path traversal */
    readonly parent: ICollectionReference | null;
}

/**
 * Wrapper for Firestore Query
 * Abstracts the actual Firestore Query
 */
export interface IQuery {
    /**
     * Filter query results
     * @param fieldPath - Field to filter on (string, FieldPath, or Filter)
     * @param opStr - Filter operator (optional when using Filter)
     * @param value - Value to compare against (optional when using Filter)
     * @returns New query with filter applied
     */
    where(fieldPath: string | any, opStr?: WhereFilterOp | any, value?: any): IQuery;

    /**
     * Order query results
     * @param fieldPath - Field to order by
     * @param directionStr - Sort direction (asc or desc)
     * @returns New query with ordering applied
     */
    orderBy(fieldPath: string, directionStr?: OrderByDirection): IQuery;

    /**
     * Limit number of results
     * @param limit - Maximum number of documents to return
     * @returns New query with limit applied
     */
    limit(limit: number): IQuery;

    /**
     * Skip a number of results
     * @param offset - Number of documents to skip
     * @returns New query with offset applied
     */
    offset(offset: number): IQuery;

    /**
     * Start query after a document or field values
     * @param fieldValues - Document snapshot or field values to start after
     * @returns New query starting after the specified point
     */
    startAfter(...fieldValues: any[]): IQuery;

    /**
     * Select specific fields to retrieve
     * @param fieldPaths - Fields to retrieve
     * @returns New query with field selection applied
     */
    select(...fieldPaths: string[]): IQuery;

    /**
     * Execute the query
     * @returns Query result snapshot
     */
    get(): Promise<IQuerySnapshot>;

    /**
     * Get count of documents matching the query
     * @returns Aggregate query for counting
     */
    count(): IAggregateQuery;

    /**
     * Listen for realtime updates to the query results.
     * @param onNext - callback invoked with each snapshot
     * @param onError - optional error handler
     * @returns unsubscribe function
     */
    onSnapshot(onNext: (snapshot: IQuerySnapshot) => void, onError?: (error: Error) => void): () => void;
}

/**
 * Wrapper for Firestore CollectionReference
 * Abstracts the actual Firestore CollectionReference
 */
export interface ICollectionReference extends IQuery {
    /**
     * Get a reference to a document
     * @param documentId - Optional document ID (auto-generated if omitted)
     * @returns Document reference
     */
    doc(documentId?: string): IDocumentReference;

    /** The parent document reference (null for root collections) */
    readonly parent: IDocumentReference | null;
}

/**
 * Wrapper for Firestore Transaction
 * Abstracts the actual Firestore Transaction for atomic operations
 */
export interface ITransaction {
    /**
     * Read a document within the transaction
     * @param documentRef - Document reference to read
     * @returns Document snapshot
     */
    get(documentRef: IDocumentReference): Promise<IDocumentSnapshot>;

    /**
     * Read query results within the transaction
     * @param query - Query to execute
     * @returns Query snapshot
     */
    get(query: IQuery): Promise<IQuerySnapshot>;

    /**
     * Write to a document within the transaction
     * @param documentRef - Document reference to write to
     * @param data - Document data
     * @param options - Set options
     * @returns This transaction for chaining
     */
    set(documentRef: IDocumentReference, data: any, options?: SetOptions): ITransaction;

    /**
     * Update a document within the transaction
     * @param documentRef - Document reference to update
     * @param data - Fields to update
     * @returns This transaction for chaining
     */
    update(documentRef: IDocumentReference, data: any): ITransaction;

    /**
     * Delete a document within the transaction
     * @param documentRef - Document reference to delete
     * @returns This transaction for chaining
     */
    delete(documentRef: IDocumentReference): ITransaction;

    /**
     * Create a new document within the transaction (fails if exists)
     * @param documentRef - Document reference to create
     * @param data - Document data
     * @returns This transaction for chaining
     */
    create(documentRef: IDocumentReference, data: any): ITransaction;
}

/**
 * Wrapper for Firestore WriteBatch
 * Abstracts the actual Firestore WriteBatch for batch operations
 */
export interface IWriteBatch {
    /**
     * Write to a document in the batch
     * @param documentRef - Document reference to write to
     * @param data - Document data
     * @param options - Set options
     * @returns This batch for chaining
     */
    set(documentRef: IDocumentReference, data: any, options?: SetOptions): IWriteBatch;

    /**
     * Update a document in the batch
     * @param documentRef - Document reference to update
     * @param data - Fields to update
     * @returns This batch for chaining
     */
    update(documentRef: IDocumentReference, data: any): IWriteBatch;

    /**
     * Delete a document in the batch
     * @param documentRef - Document reference to delete
     * @returns This batch for chaining
     */
    delete(documentRef: IDocumentReference): IWriteBatch;

    /**
     * Commit the batch
     */
    commit(): Promise<void>;
}

/**
 * Wrapper for Firestore Database
 * This is the main entry point for all Firestore operations
 */
export interface IFirestoreDatabase {
    /**
     * Get a reference to a collection
     * @param collectionPath - Path to the collection
     * @returns Collection reference
     */
    collection(collectionPath: string): ICollectionReference;

    /**
     * Get a reference to a document
     * @param documentPath - Full path to the document (collection/doc/subcollection/doc/...)
     * @returns Document reference
     */
    doc(documentPath: string): IDocumentReference;

    /**
     * Query across all collections with the same ID
     * @param collectionId - Collection ID to query
     * @returns Query for collection group
     */
    collectionGroup(collectionId: string): IQuery;

    /**
     * List all root-level collections
     * @returns Array of collection references
     */
    listCollections(): Promise<ICollectionReference[]>;

    /**
     * Run an atomic transaction
     * @param updateFunction - Function that performs transactional operations
     * @returns Result of the transaction
     */
    runTransaction<T>(updateFunction: (transaction: ITransaction) => Promise<T>): Promise<T>;

    /**
     * Create a batch for multiple operations
     * @returns Write batch
     */
    batch(): IWriteBatch;
}
