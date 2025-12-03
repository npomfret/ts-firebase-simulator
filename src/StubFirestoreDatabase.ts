/**
 * Stub Firestore Database Implementation
 *
 * Provides an in-memory implementation of IFirestoreDatabase for unit testing.
 * This stub allows tests to run without Firebase emulator and provides full control
 * over data and behavior.
 */

import { Timestamp } from 'firebase-admin/firestore';
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

export type FirestoreTriggerEventType = 'create' | 'update' | 'delete';

export interface FirestoreTriggerChange {
    before: IDocumentSnapshot;
    after: IDocumentSnapshot;
    params: Record<string, string>;
    path: string;
    type: FirestoreTriggerEventType;
}

export type FirestoreTriggerChangeHandler = (change: FirestoreTriggerChange) => void | Promise<void>;

export interface FirestoreTriggerHandlers {
    onCreate?: FirestoreTriggerChangeHandler;
    onUpdate?: FirestoreTriggerChangeHandler;
    onDelete?: FirestoreTriggerChangeHandler;
}

interface TriggerRegistration {
    pattern: string;
    regex: RegExp;
    paramNames: string[];
    handlers: FirestoreTriggerHandlers;
}

interface TriggerEventRecord {
    type: FirestoreTriggerEventType;
    path: string;
    before: IDocumentSnapshot;
    after: IDocumentSnapshot;
}

interface DocumentWatcher {
    callback: (snapshot: IDocumentSnapshot) => void;
    error?: (error: Error) => void;
}

interface QueryWatcher {
    query: StubQuery;
    callback: (snapshot: IQuerySnapshot) => void;
    error?: (error: Error) => void;
}

const PATH_PARAM_REGEX = /^\{(.+)\}$/;

function escapeRegex(segment: string): string {
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePathPattern(pattern: string): { regex: RegExp; paramNames: string[]; } {
    const segments = pattern.split('/').filter((segment) => segment.length > 0);
    const paramNames: string[] = [];

    const regexSegments = segments.map((segment) => {
        if (segment === '**') {
            return '(.*)';
        }

        const paramMatch = segment.match(PATH_PARAM_REGEX);
        if (paramMatch) {
            paramNames.push(paramMatch[1]);
            return '([^/]+)';
        }

        if (segment === '*') {
            return '([^/]+)';
        }

        return escapeRegex(segment);
    });

    const regex = new RegExp(`^${regexSegments.join('/')}$`);
    return { regex, paramNames };
}

function cloneValue<T>(value: T): T {
    if (value instanceof Timestamp) {
        return new Timestamp(value.seconds, value.nanoseconds) as T;
    }

    if (value instanceof Date) {
        return new Date(value.getTime()) as T;
    }

    if (Array.isArray(value)) {
        return value.map((item) => cloneValue(item)) as T;
    }

    if (value && typeof value === 'object') {
        const cloned: Record<string, any> = {};
        for (const [key, val] of Object.entries(value)) {
            cloned[key] = cloneValue(val);
        }
        return cloned as T;
    }

    return value;
}

function cloneStoredDocument(doc: StoredDocument | null): StoredDocument | null {
    if (!doc) {
        return null;
    }

    return {
        id: doc.id,
        path: doc.path,
        exists: doc.exists,
        data: cloneValue(doc.data),
    };
}

/**
 * In-memory document storage
 */
interface StoredDocument {
    id: string;
    path: string;
    data: any;
    exists: boolean;
}

/**
 * Stub DocumentSnapshot implementation
 */
class StubDocumentSnapshot implements IDocumentSnapshot {
    constructor(
        private readonly document: StoredDocument | null,
        private readonly docRef: IDocumentReference,
    ) {}

    get exists(): boolean {
        return this.document?.exists ?? false;
    }

    get id(): string {
        return this.docRef.id;
    }

    get ref(): IDocumentReference {
        return this.docRef;
    }

    data(): any | undefined {
        return this.document?.exists ? this.document.data : undefined;
    }
}

class StaticDocumentSnapshot implements IDocumentSnapshot {
    constructor(
        private readonly docRef: IDocumentReference,
        private readonly existsValue: boolean,
        private readonly dataValue: any | undefined,
    ) {}

    get exists(): boolean {
        return this.existsValue;
    }

    get id(): string {
        return this.docRef.id;
    }

    get ref(): IDocumentReference {
        return this.docRef;
    }

    data(): any | undefined {
        if (!this.existsValue) {
            return undefined;
        }
        return cloneValue(this.dataValue);
    }
}

/**
 * Stub QuerySnapshot implementation
 */
class StubQuerySnapshot implements IQuerySnapshot {
    constructor(private readonly documents: StubDocumentSnapshot[]) {}

    get docs(): IDocumentSnapshot[] {
        return this.documents;
    }

    get empty(): boolean {
        return this.documents.length === 0;
    }

    get size(): number {
        return this.documents.length;
    }

    forEach(callback: (result: IDocumentSnapshot) => void): void {
        this.documents.forEach(callback);
    }
}

/**
 * Stub AggregateQuerySnapshot implementation
 */
class StubAggregateQuerySnapshot implements IAggregateQuerySnapshot {
    constructor(private readonly countValue: number) {}

    data(): { count: number; } {
        return { count: this.countValue };
    }
}

/**
 * Stub AggregateQuery implementation
 */
class StubAggregateQuery implements IAggregateQuery {
    constructor(private readonly countFn: () => Promise<number>) {}

    async get(): Promise<IAggregateQuerySnapshot> {
        const count = await this.countFn();
        return new StubAggregateQuerySnapshot(count);
    }
}

/**
 * Stub DocumentReference implementation
 */
class StubDocumentReference implements IDocumentReference {
    constructor(
        private readonly storage: Map<string, StoredDocument>,
        private readonly documentPath: string,
        private readonly db: StubFirestoreDatabase,
    ) {}

    get id(): string {
        const parts = this.documentPath.split('/');
        return parts[parts.length - 1];
    }

    get path(): string {
        return this.documentPath;
    }

    get parent(): ICollectionReference | null {
        const parts = this.documentPath.split('/');
        if (parts.length <= 1) return null;

        const collectionPath = parts.slice(0, -1).join('/');
        return new StubCollectionReference(this.storage, collectionPath, this.db);
    }

    collection(collectionPath: string): ICollectionReference {
        const fullPath = `${this.documentPath}/${collectionPath}`;
        return new StubCollectionReference(this.storage, fullPath, this.db);
    }

    onSnapshot(onNext: (snapshot: IDocumentSnapshot) => void, onError?: (error: Error) => void): () => void {
        const listener: DocumentWatcher = {
            callback: onNext,
            error: onError,
        };
        return this.db.addDocumentWatcher(this.documentPath, listener);
    }

    async get(): Promise<IDocumentSnapshot> {
        const doc = this.storage.get(this.documentPath);
        return new StubDocumentSnapshot(doc ?? null, this);
    }

    /**
     * Process FieldValue operations (increment, arrayUnion, etc.) by applying them to existing data
     * @param data - The data containing potential FieldValue sentinels
     * @param existingData - The existing document data to apply operations against
     * @returns Processed data with FieldValue operations resolved
     */
    private processFieldValues(data: any, existingData: any = {}): any {
        if (!data || typeof data !== 'object') {
            return data;
        }

        const result: any = Array.isArray(data) ? [...data] : { ...data };

        for (const key in result) {
            const value = result[key];

            // Check if this is a FieldValue.serverTimestamp() sentinel
            if (value && typeof value === 'object' && value.constructor.name === 'ServerTimestampTransform') {
                result[key] = Timestamp.now();
            } // Check if this is a FieldValue.increment() sentinel
            else if (value && typeof value === 'object' && value.constructor.name === 'NumericIncrementTransform') {
                // Extract the increment operand from the FieldValue.increment() sentinel
                const incrementBy = (value as any).operand || 0;
                const currentValue = existingData[key] || 0;
                result[key] = currentValue + incrementBy;
            } // Recursively process nested objects that might contain FieldValue operations
            // Note: In Firestore, nested objects replace the entire field, so we process
            // FieldValues within them but don't merge with existing nested data
            // Skip any FieldValue sentinels (constructor names ending with "Transform")
            else if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Timestamp) && !(value instanceof Date) && !value.constructor.name.endsWith('Transform')) {
                // Process the nested object for FieldValues, but without merging with existing data
                // because Firestore replaces the entire nested object in an update
                result[key] = this.processFieldValuesInNestedObject(value, existingData[key]);
            }
        }

        return result;
    }

    /**
     * Process FieldValue operations in a nested object
     * This handles nested FieldValue.increment() operations differently:
     * - We process increments against the existing nested structure
     * - But the entire nested object replaces what was there before
     */
    private processFieldValuesInNestedObject(nestedData: any, existingNestedData: any = {}): any {
        if (!nestedData || typeof nestedData !== 'object') {
            return nestedData;
        }

        const result: any = Array.isArray(nestedData) ? [...nestedData] : { ...nestedData };

        for (const key in result) {
            const value = result[key];

            // Check if this is a FieldValue.serverTimestamp() sentinel
            if (value && typeof value === 'object' && value.constructor.name === 'ServerTimestampTransform') {
                result[key] = Timestamp.now();
            } // Check if this is a FieldValue.increment() sentinel
            else if (value && typeof value === 'object' && value.constructor.name === 'NumericIncrementTransform') {
                const incrementBy = (value as any).operand || 0;
                const currentValue = existingNestedData?.[key] || 0;
                result[key] = currentValue + incrementBy;
            } // Recursively process deeper nesting, but skip FieldValue sentinels
            else if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Timestamp) && !(value instanceof Date) && !value.constructor.name.endsWith('Transform')) {
                // Recursively process deeper nesting
                result[key] = this.processFieldValuesInNestedObject(value, existingNestedData?.[key]);
            }
        }

        return result;
    }

    /**
     * Deep merge two objects, matching Firestore's merge behavior:
     * - Recursively merges nested objects
     * - Arrays replace rather than merge
     * - null overwrites existing values
     * - Primitives replace existing values
     * - FieldValue operations must be already processed before calling this
     *
     * @param existing - The existing data
     * @param updates - The new data to merge in (with FieldValue operations already processed)
     * @returns Deep merged result
     */
    private deepMerge(existing: any, updates: any): any {
        // If updates is not an object or is null, it replaces existing entirely
        if (!updates || typeof updates !== 'object' || Array.isArray(updates) || updates instanceof Timestamp || updates instanceof Date) {
            return updates;
        }

        // If existing is not an object, updates replaces it
        if (!existing || typeof existing !== 'object' || Array.isArray(existing) || existing instanceof Timestamp || existing instanceof Date) {
            return updates;
        }

        // Both are objects - deep merge them
        const result: any = { ...existing };

        for (const key in updates) {
            const updateValue = updates[key];
            const existingValue = result[key];

            // If update value is an object (not array, not Timestamp, not Date), deep merge
            if (
                updateValue
                && typeof updateValue === 'object'
                && !Array.isArray(updateValue)
                && !(updateValue instanceof Timestamp)
                && !(updateValue instanceof Date)
                && existingValue
                && typeof existingValue === 'object'
                && !Array.isArray(existingValue)
                && !(existingValue instanceof Timestamp)
                && !(existingValue instanceof Date)
            ) {
                // Both are objects - recursively deep merge
                result[key] = this.deepMerge(existingValue, updateValue);
            } else {
                // Primitive, array, Timestamp, Date, or null - replace
                result[key] = updateValue;
            }
        }

        return result;
    }

    async set(data: any, options?: SetOptions): Promise<void> {
        const existingDoc = this.storage.get(this.documentPath);
        const beforeClone = cloneStoredDocument(existingDoc ?? null);

        if (options?.merge && existingDoc) {
            // Process FieldValue operations with existing data
            const processedData = this.processFieldValues(data, existingDoc.data);
            const mergedData = this.deepMerge(existingDoc.data, processedData);
            this.storage.set(this.documentPath, {
                id: this.id,
                path: this.documentPath,
                data: mergedData,
                exists: true,
            });
        } else if (options?.mergeFields && existingDoc) {
            const mergedData = { ...existingDoc.data };
            for (const field of options.mergeFields) {
                if (field in data) {
                    // Process FieldValue operations for this field
                    const fieldData = { [field]: data[field] };
                    const processed = this.processFieldValues(fieldData, existingDoc.data);
                    mergedData[field] = processed[field];
                }
            }
            this.storage.set(this.documentPath, {
                id: this.id,
                path: this.documentPath,
                data: mergedData,
                exists: true,
            });
        } else {
            // No existing data, so just copy (FieldValue.increment would start from 0)
            const processedData = this.processFieldValues(data, {});
            this.storage.set(this.documentPath, {
                id: this.id,
                path: this.documentPath,
                data: { ...processedData },
                exists: true,
            });
        }

        const storedDoc = this.storage.get(this.documentPath);
        const afterClone = cloneStoredDocument(storedDoc ?? null);
        const eventType: FirestoreTriggerEventType = beforeClone?.exists ? 'update' : 'create';
        await this.db.recordTrigger(eventType, this.documentPath, beforeClone, afterClone);
        this.db.emitDocumentChange(this.documentPath);
    }

    /**
     * Apply updates with dot notation support (e.g., 'stats.views')
     * @param existingData - The existing document data
     * @param updates - The updates to apply (may contain dot notation keys)
     * @returns Updated data
     */
    private applyDotNotationUpdates(existingData: any, updates: any): any {
        const result = { ...existingData };

        for (const [key, value] of Object.entries(updates)) {
            if (key.includes('.')) {
                // Handle dot notation path
                const parts = key.split('.');
                let current = result;

                // Check if this is a delete operation on a non-existent path
                const isDeleteOperation = value && typeof value === 'object' && value.constructor.name === 'DeleteTransform';

                // If deleting, check if the path exists before creating intermediate objects
                if (isDeleteOperation) {
                    let pathExists = true;
                    let temp = result;
                    for (let i = 0; i < parts.length - 1; i++) {
                        if (!(parts[i] in temp) || typeof temp[parts[i]] !== 'object') {
                            pathExists = false;
                            break;
                        }
                        temp = temp[parts[i]];
                    }

                    // If path doesn't exist, skip this delete operation entirely
                    if (!pathExists) {
                        continue;
                    }
                }

                // Navigate to the parent of the target field
                for (let i = 0; i < parts.length - 1; i++) {
                    if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
                        current[parts[i]] = {};
                    } else {
                        // Create a copy to avoid mutating existing nested objects
                        current[parts[i]] = { ...current[parts[i]] };
                    }
                    current = current[parts[i]];
                }

                // Apply the value at the target field
                const lastPart = parts[parts.length - 1];
                if (value && typeof value === 'object' && value.constructor.name === 'ServerTimestampTransform') {
                    current[lastPart] = Timestamp.now();
                } else if (value && typeof value === 'object' && value.constructor.name === 'NumericIncrementTransform') {
                    const incrementBy = (value as any).operand || 0;
                    const currentValue = current[lastPart] || 0;
                    current[lastPart] = currentValue + incrementBy;
                } else if (isDeleteOperation) {
                    // Delete the field
                    delete current[lastPart];
                } else {
                    current[lastPart] = value;
                }
            } else {
                // No dot notation - check for FieldValue operations
                if (value && typeof value === 'object' && value.constructor.name === 'DeleteTransform') {
                    // Delete the field
                    delete result[key];
                } else {
                    // Apply directly
                    result[key] = value;
                }
            }
        }

        return result;
    }

    async update(data: any): Promise<void> {
        const existingDoc = this.storage.get(this.documentPath);
        if (!existingDoc || !existingDoc.exists) {
            throw new Error(`Document ${this.documentPath} does not exist`);
        }

        const beforeClone = cloneStoredDocument(existingDoc);

        // Apply dot notation updates and process FieldValue operations
        const updatedData = this.applyDotNotationUpdates(existingDoc.data, data);

        // For non-dot-notation fields, process FieldValue operations
        const processedData = this.processFieldValues(updatedData, existingDoc.data);

        this.storage.set(this.documentPath, {
            id: this.id,
            path: this.documentPath,
            data: processedData,
            exists: true,
        });

        const storedDoc = this.storage.get(this.documentPath);
        const afterClone = cloneStoredDocument(storedDoc ?? null);
        await this.db.recordTrigger('update', this.documentPath, beforeClone, afterClone);
        this.db.emitDocumentChange(this.documentPath);
    }

    async delete(): Promise<void> {
        const existingDoc = this.storage.get(this.documentPath);
        if (!existingDoc || !existingDoc.exists) {
            this.storage.delete(this.documentPath);
            return;
        }

        const beforeClone = cloneStoredDocument(existingDoc);

        this.storage.delete(this.documentPath);

        await this.db.recordTrigger('delete', this.documentPath, beforeClone, null);
        this.db.emitDocumentChange(this.documentPath);
    }
}

/**
 * Query filter condition
 */
interface QueryFilter {
    field: string;
    operator: WhereFilterOp;
    value: any;
}

/**
 * Query ordering
 */
interface QueryOrder {
    field: string;
    direction: OrderByDirection;
}

/**
 * Stub Query implementation
 */
class StubQuery implements IQuery {
    protected filters: QueryFilter[] = [];
    protected orders: QueryOrder[] = [];
    protected limitCount?: number;
    protected offsetCount: number = 0;
    protected startAfterValues?: any[];
    protected selectedFields?: string[];

    constructor(
        protected readonly storage: Map<string, StoredDocument>,
        protected readonly collectionPath: string,
        protected readonly db: StubFirestoreDatabase,
    ) {}

    where(fieldPath: string | any, opStr?: WhereFilterOp | any, value?: any): IQuery {
        const newQuery = this.clone();

        if (typeof fieldPath === 'string' && opStr !== undefined && value !== undefined) {
            newQuery.filters.push({ field: fieldPath, operator: opStr, value });
        } else if (typeof fieldPath === 'object' && fieldPath !== null) {
            // Handle FieldPath objects (e.g., FieldPath.documentId())
            // FieldPath.documentId() is represented as a special marker
            const fieldPathStr = fieldPath.toString?.() === '__name__' || fieldPath._segments?.[0] === '__name__'
                ? '__name__' // Document ID field
                : fieldPath.toString?.() || String(fieldPath);

            if (opStr !== undefined && value !== undefined) {
                newQuery.filters.push({ field: fieldPathStr, operator: opStr, value });
            }
        }

        return newQuery;
    }

    orderBy(fieldPath: string, directionStr: OrderByDirection = 'asc'): IQuery {
        const newQuery = this.clone();
        newQuery.orders.push({ field: fieldPath, direction: directionStr });
        return newQuery;
    }

    limit(limit: number): IQuery {
        const newQuery = this.clone();
        newQuery.limitCount = limit;
        return newQuery;
    }

    offset(offset: number): IQuery {
        const newQuery = this.clone();
        newQuery.offsetCount = offset;
        return newQuery;
    }

    startAfter(...fieldValues: any[]): IQuery {
        const newQuery = this.clone();
        newQuery.startAfterValues = fieldValues;
        return newQuery;
    }

    select(...fieldPaths: string[]): IQuery {
        const newQuery = this.clone();
        newQuery.selectedFields = fieldPaths;
        return newQuery;
    }

    onSnapshot(onNext: (snapshot: IQuerySnapshot) => void, onError?: (error: Error) => void): () => void {
        const watcher: QueryWatcher = {
            query: this.clone(),
            callback: onNext,
            error: onError,
        };
        return this.db.addQueryWatcher(watcher);
    }

    count(): IAggregateQuery {
        return new StubAggregateQuery(async () => {
            let documents: StoredDocument[] = [];

            for (const [path, doc] of this.storage.entries()) {
                if (this.isInCollection(path) && doc.exists) {
                    documents.push(doc);
                }
            }

            documents = documents.filter((doc) => this.matchesFilters(doc));

            if (this.orders.length > 0) {
                documents.sort((a, b) => this.compareDocuments(a, b));
            }

            if (this.startAfterValues && this.startAfterValues.length > 0) {
                const startAfterIndex = this.findStartAfterIndex(documents);
                if (startAfterIndex >= 0) {
                    documents = documents.slice(startAfterIndex + 1);
                }
            }

            if (this.offsetCount > 0) {
                documents = documents.slice(this.offsetCount);
            }

            if (this.limitCount !== undefined) {
                documents = documents.slice(0, this.limitCount);
            }

            return documents.length;
        });
    }

    async get(): Promise<IQuerySnapshot> {
        let documents: StoredDocument[] = [];

        for (const [path, doc] of this.storage.entries()) {
            if (this.isInCollection(path) && doc.exists) {
                documents.push(doc);
            }
        }

        documents = documents.filter((doc) => this.matchesFilters(doc));

        if (this.orders.length > 0) {
            documents.sort((a, b) => this.compareDocuments(a, b));
        }

        if (this.startAfterValues && this.startAfterValues.length > 0) {
            const startAfterIndex = this.findStartAfterIndex(documents);
            if (startAfterIndex >= 0) {
                documents = documents.slice(startAfterIndex + 1);
            }
        }

        if (this.offsetCount > 0) {
            documents = documents.slice(this.offsetCount);
        }

        if (this.limitCount !== undefined) {
            documents = documents.slice(0, this.limitCount);
        }

        const snapshots = documents.map((doc) => {
            const docRef = new StubDocumentReference(this.storage, doc.path, this.db);
            return new StubDocumentSnapshot(doc, docRef);
        });

        return new StubQuerySnapshot(snapshots);
    }

    protected clone(): StubQuery {
        const cloned = new StubQuery(this.storage, this.collectionPath, this.db);
        cloned.filters = [...this.filters];
        cloned.orders = [...this.orders];
        cloned.limitCount = this.limitCount;
        cloned.offsetCount = this.offsetCount;
        cloned.startAfterValues = this.startAfterValues ? [...this.startAfterValues] : undefined;
        cloned.selectedFields = this.selectedFields ? [...this.selectedFields] : undefined;
        return cloned;
    }

    protected isInCollection(docPath: string): boolean {
        const pathParts = docPath.split('/');
        const collectionParts = this.collectionPath.split('/');

        // For collection group queries (single segment like 'shareLinks'),
        // check if the document's parent collection matches
        if (collectionParts.length === 1) {
            // Document path must have at least 2 segments (collection/doc)
            if (pathParts.length < 2) {
                return false;
            }
            // Check if the parent collection (second-to-last segment) matches
            const parentCollectionIndex = pathParts.length - 2;
            return pathParts[parentCollectionIndex] === collectionParts[0];
        }

        // For regular collection queries, check exact path match
        if (pathParts.length !== collectionParts.length + 1) {
            return false;
        }

        for (let i = 0; i < collectionParts.length; i++) {
            if (pathParts[i] !== collectionParts[i]) {
                return false;
            }
        }

        return true;
    }

    protected matchesFilters(doc: StoredDocument): boolean {
        return this.filters.every((filter) => {
            const fieldValue = this.getFieldValue(doc, filter.field);
            return this.matchesFilter(fieldValue, filter.operator, filter.value);
        });
    }

    protected getFieldValue(doc: StoredDocument | any, field: string): any {
        // Handle special FieldPath.documentId() case
        if (field === '__name__') {
            // If doc is a StoredDocument, return its id
            if (doc && typeof doc === 'object' && 'id' in doc) {
                return doc.id;
            }
            return doc;
        }

        // For regular fields, access doc.data
        const data = doc && typeof doc === 'object' && 'data' in doc ? doc.data : doc;
        const parts = field.split('.');
        let value = data;
        for (const part of parts) {
            value = value?.[part];
        }
        return value;
    }

    protected matchesFilter(fieldValue: any, operator: WhereFilterOp, filterValue: any): boolean {
        switch (operator) {
            case '==':
                return fieldValue === filterValue;
            case '!=':
                return fieldValue !== filterValue;
            case '<':
                return fieldValue < filterValue;
            case '<=':
                return fieldValue <= filterValue;
            case '>':
                return fieldValue > filterValue;
            case '>=':
                return fieldValue >= filterValue;
            case 'array-contains':
                return Array.isArray(fieldValue) && fieldValue.includes(filterValue);
            case 'in':
                return Array.isArray(filterValue) && filterValue.includes(fieldValue);
            case 'array-contains-any':
                return Array.isArray(fieldValue) && Array.isArray(filterValue) && fieldValue.some((v) => filterValue.includes(v));
            case 'not-in':
                return Array.isArray(filterValue) && !filterValue.includes(fieldValue);
            default:
                return false;
        }
    }

    protected compareDocuments(a: StoredDocument, b: StoredDocument): number {
        for (const order of this.orders) {
            const aValue = this.getFieldValue(a, order.field);
            const bValue = this.getFieldValue(b, order.field);

            let comparison = 0;
            if (aValue < bValue) comparison = -1;
            else if (aValue > bValue) comparison = 1;

            if (comparison !== 0) {
                return order.direction === 'asc' ? comparison : -comparison;
            }
        }
        return 0;
    }

    protected findStartAfterIndex(documents: StoredDocument[]): number {
        const startAfterValue = this.startAfterValues![0];

        if (typeof startAfterValue === 'object' && 'id' in startAfterValue) {
            return documents.findIndex((doc) => doc.id === startAfterValue.id);
        }

        return documents.findIndex((doc) => {
            if (this.orders.length > 0) {
                const fieldValue = this.getFieldValue(doc, this.orders[0].field);

                // Handle Timestamp comparisons
                if (fieldValue instanceof Timestamp && startAfterValue instanceof Timestamp) {
                    return fieldValue.seconds === startAfterValue.seconds && fieldValue.nanoseconds === startAfterValue.nanoseconds;
                }

                // Handle Date comparisons
                if (fieldValue instanceof Date && startAfterValue instanceof Date) {
                    return fieldValue.getTime() === startAfterValue.getTime();
                }

                // Handle Timestamp vs Date comparisons
                if (fieldValue instanceof Timestamp && startAfterValue instanceof Date) {
                    return fieldValue.toDate().getTime() === startAfterValue.getTime();
                }
                if (fieldValue instanceof Date && startAfterValue instanceof Timestamp) {
                    return fieldValue.getTime() === startAfterValue.toDate().getTime();
                }

                // Fallback to equality comparison for primitives
                return fieldValue === startAfterValue;
            }
            return doc.id === startAfterValue;
        });
    }
}

/**
 * Stub CollectionReference implementation
 */
class StubCollectionReference extends StubQuery implements ICollectionReference {
    constructor(storage: Map<string, StoredDocument>, collectionPath: string, db: StubFirestoreDatabase) {
        super(storage, collectionPath, db);
    }

    get parent(): IDocumentReference | null {
        const parts = this.collectionPath.split('/');
        if (parts.length <= 1) return null;

        const docPath = parts.slice(0, -1).join('/');
        return new StubDocumentReference(this.storage, docPath, this.db);
    }

    doc(documentId?: string): IDocumentReference {
        const id = documentId ?? this.generateId();
        const docPath = `${this.collectionPath}/${id}`;
        return new StubDocumentReference(this.storage, docPath, this.db);
    }

    protected clone(): StubCollectionReference {
        const cloned = new StubCollectionReference(this.storage, this.collectionPath, this.db);
        cloned.filters = [...this.filters];
        cloned.orders = [...this.orders];
        cloned.limitCount = this.limitCount;
        cloned.offsetCount = this.offsetCount;
        cloned.startAfterValues = this.startAfterValues ? [...this.startAfterValues] : undefined;
        cloned.selectedFields = this.selectedFields ? [...this.selectedFields] : undefined;
        return cloned;
    }

    private generateId(): string {
        return `stub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
}

/**
 * Stub Transaction implementation
 */
class StubTransaction implements ITransaction {
    private reads = new Map<string, StoredDocument | null>();
    private writes: Array<{ type: 'set' | 'update' | 'delete' | 'create'; ref: IDocumentReference; data?: any; options?: SetOptions; }> = [];

    constructor(
        private readonly storage: Map<string, StoredDocument>,
        private readonly db: StubFirestoreDatabase,
    ) {}

    async get(documentRef: IDocumentReference): Promise<IDocumentSnapshot>;
    async get(query: IQuery): Promise<IQuerySnapshot>;
    async get(documentRefOrQuery: IDocumentReference | IQuery): Promise<IDocumentSnapshot | IQuerySnapshot> {
        if ('getUnderlyingRef' in documentRefOrQuery || 'path' in documentRefOrQuery) {
            const docRef = documentRefOrQuery as StubDocumentReference;
            const doc = this.storage.get(docRef.path);
            this.reads.set(docRef.path, doc ?? null);
            return new StubDocumentSnapshot(doc ?? null, docRef);
        } else {
            const query = documentRefOrQuery as StubQuery;
            return await query.get();
        }
    }

    set(documentRef: IDocumentReference, data: any, options?: SetOptions): ITransaction {
        this.writes.push({ type: 'set', ref: documentRef, data, options });
        return this;
    }

    update(documentRef: IDocumentReference, data: any): ITransaction {
        this.writes.push({ type: 'update', ref: documentRef, data });
        return this;
    }

    delete(documentRef: IDocumentReference): ITransaction {
        this.writes.push({ type: 'delete', ref: documentRef });
        return this;
    }

    create(documentRef: IDocumentReference, data: any): ITransaction {
        this.writes.push({ type: 'create', ref: documentRef, data });
        return this;
    }

    async commit(): Promise<void> {
        this.db.beginAtomicOperation();
        let success = false;
        try {
            for (const [path, readDoc] of this.reads.entries()) {
                const currentDoc = this.storage.get(path);
                if (JSON.stringify(readDoc) !== JSON.stringify(currentDoc ?? null)) {
                    throw new Error(`Transaction failed: document ${path} was modified`);
                }
            }

            for (const write of this.writes) {
                const ref = write.ref as StubDocumentReference;
                switch (write.type) {
                    case 'set':
                        await ref.set(write.data!, write.options);
                        break;
                    case 'update':
                        await ref.update(write.data!);
                        break;
                    case 'delete':
                        await ref.delete();
                        break;
                    case 'create':
                        const existing = this.storage.get(ref.path);
                        if (existing?.exists) {
                            throw new Error(`Document ${ref.path} already exists`);
                        }
                        await ref.set(write.data!);
                        break;
                }
            }
            success = true;
        } finally {
            await this.db.endAtomicOperation(success);
        }
    }
}

/**
 * Stub WriteBatch implementation
 */
class StubWriteBatch implements IWriteBatch {
    private operations: Array<() => Promise<void>> = [];

    constructor(
        private readonly storage: Map<string, StoredDocument>,
        private readonly db: StubFirestoreDatabase,
    ) {}

    set(documentRef: IDocumentReference, data: any, options?: SetOptions): IWriteBatch {
        this.operations.push(async () => {
            await documentRef.set(data, options);
        });
        return this;
    }

    update(documentRef: IDocumentReference, data: any): IWriteBatch {
        this.operations.push(async () => {
            await documentRef.update(data);
        });
        return this;
    }

    delete(documentRef: IDocumentReference): IWriteBatch {
        this.operations.push(async () => {
            await documentRef.delete();
        });
        return this;
    }

    async commit(): Promise<void> {
        this.db.beginAtomicOperation();
        let success = false;
        try {
            for (const operation of this.operations) {
                await operation();
            }
            success = true;
        } finally {
            await this.db.endAtomicOperation(success);
        }
    }
}

/**
 * Stub Firestore Database implementation
 */
export class StubFirestoreDatabase implements IFirestoreDatabase {
    private storage = new Map<string, StoredDocument>();
    private triggerRegistrations: TriggerRegistration[] = [];
    private triggerBuffers: TriggerEventRecord[][] = [];
    private docWatchers = new Map<string, Set<DocumentWatcher>>();
    private docWatchBuffers: Array<Set<string>> = [];
    private queryWatchers = new Set<QueryWatcher>();
    private queryWatchBuffers: boolean[] = [];

    collection(collectionPath: string): ICollectionReference {
        return new StubCollectionReference(this.storage, collectionPath, this);
    }

    doc(documentPath: string): IDocumentReference {
        return new StubDocumentReference(this.storage, documentPath, this);
    }

    collectionGroup(collectionId: string): IQuery {
        return new StubQuery(this.storage, collectionId, this);
    }

    addDocumentWatcher(path: string, listener: DocumentWatcher): () => void {
        let listeners = this.docWatchers.get(path);
        if (!listeners) {
            listeners = new Set();
            this.docWatchers.set(path, listeners);
        }
        listeners.add(listener);

        queueMicrotask(() => {
            try {
                const snapshot = this.createStaticSnapshot(path, this.storage.get(path) ?? null);
                listener.callback(snapshot);
            } catch (error) {
                if (listener.error) {
                    listener.error(error as Error);
                }
            }
        });

        return () => {
            const current = this.docWatchers.get(path);
            if (!current) {
                return;
            }
            current.delete(listener);
            if (current.size === 0) {
                this.docWatchers.delete(path);
            }
        };
    }

    addQueryWatcher(watcher: QueryWatcher): () => void {
        this.queryWatchers.add(watcher);

        Promise.resolve().then(async () => {
            try {
                const snapshot = await watcher.query.get();
                watcher.callback(snapshot);
            } catch (error) {
                if (watcher.error) {
                    watcher.error(error as Error);
                }
            }
        });

        return () => {
            this.queryWatchers.delete(watcher);
        };
    }

    emitDocumentChange(path: string): void {
        this.queueDocumentNotification(path);
        this.markQueryWatchersDirty();
    }

    private queueDocumentNotification(path: string): void {
        if (this.docWatchBuffers.length > 0) {
            this.docWatchBuffers[this.docWatchBuffers.length - 1].add(path);
            return;
        }
        this.deliverDocumentSnapshot(path);
    }

    private deliverDocumentSnapshot(path: string): void {
        const listeners = this.docWatchers.get(path);
        if (!listeners || listeners.size === 0) {
            return;
        }

        const snapshot = this.createStaticSnapshot(path, this.storage.get(path) ?? null);
        for (const listener of Array.from(listeners)) {
            try {
                listener.callback(snapshot);
            } catch (error) {
                if (listener.error) {
                    listener.error(error as Error);
                }
            }
        }
    }

    private markQueryWatchersDirty(): void {
        if (this.queryWatchers.size === 0) {
            return;
        }

        if (this.queryWatchBuffers.length > 0) {
            this.queryWatchBuffers[this.queryWatchBuffers.length - 1] = true;
            return;
        }

        this.runAllQueryWatchers();
    }

    private runAllQueryWatchers(): void {
        if (this.queryWatchers.size === 0) {
            return;
        }

        for (const watcher of Array.from(this.queryWatchers)) {
            void (async () => {
                try {
                    const snapshot = await watcher.query.get();
                    watcher.callback(snapshot);
                } catch (error) {
                    if (watcher.error) {
                        watcher.error(error as Error);
                    }
                }
            })();
        }
    }

    registerTrigger(pattern: string, handlers: FirestoreTriggerHandlers): () => void {
        const { regex, paramNames } = compilePathPattern(pattern);
        const registration: TriggerRegistration = {
            pattern,
            regex,
            paramNames,
            handlers,
        };

        this.triggerRegistrations.push(registration);

        return () => {
            this.triggerRegistrations = this.triggerRegistrations.filter((entry) => entry !== registration);
        };
    }

    clearTriggers(): void {
        this.triggerRegistrations = [];
    }

    beginAtomicOperation(): void {
        this.triggerBuffers.push([]);
        this.docWatchBuffers.push(new Set());
        this.queryWatchBuffers.push(false);
    }

    async endAtomicOperation(success: boolean): Promise<void> {
        const triggerBuffer = this.triggerBuffers.pop() ?? [];
        const docBuffer = this.docWatchBuffers.pop() ?? new Set<string>();
        const queryDirty = this.queryWatchBuffers.pop() ?? false;

        if (!success) {
            return;
        }

        if (this.triggerBuffers.length > 0) {
            this.triggerBuffers[this.triggerBuffers.length - 1].push(...triggerBuffer);
            const parentDocBuffer = this.docWatchBuffers[this.docWatchBuffers.length - 1];
            docBuffer.forEach((path) => parentDocBuffer.add(path));
            if (queryDirty) {
                this.queryWatchBuffers[this.queryWatchBuffers.length - 1] = true;
            }
            return;
        }

        for (const event of triggerBuffer) {
            await this.dispatchTrigger(event);
        }

        docBuffer.forEach((path) => this.deliverDocumentSnapshot(path));

        if (queryDirty) {
            this.runAllQueryWatchers();
        }
    }

    async recordTrigger(type: FirestoreTriggerEventType, path: string, beforeDoc: StoredDocument | null, afterDoc: StoredDocument | null): Promise<void> {
        if (this.triggerRegistrations.length === 0) {
            return;
        }

        const beforeSnapshot = this.createStaticSnapshot(path, beforeDoc);
        const afterSnapshot = this.createStaticSnapshot(path, afterDoc);
        const event: TriggerEventRecord = {
            type,
            path,
            before: beforeSnapshot,
            after: afterSnapshot,
        };

        if (this.triggerBuffers.length > 0) {
            this.triggerBuffers[this.triggerBuffers.length - 1].push(event);
            return;
        }

        await this.dispatchTrigger(event);
    }

    private createStaticSnapshot(path: string, doc: StoredDocument | null): IDocumentSnapshot {
        const reference = new StubDocumentReference(this.storage, path, this);
        if (!doc || !doc.exists) {
            return new StaticDocumentSnapshot(reference, false, undefined);
        }

        return new StaticDocumentSnapshot(reference, true, cloneValue(doc.data));
    }

    private async dispatchTrigger(event: TriggerEventRecord): Promise<void> {
        for (const registration of this.triggerRegistrations) {
            const match = registration.regex.exec(event.path);
            if (!match) {
                continue;
            }

            const params: Record<string, string> = {};
            registration.paramNames.forEach((name, index) => {
                params[name] = match[index + 1];
            });

            const change: FirestoreTriggerChange = {
                before: event.before,
                after: event.after,
                params,
                path: event.path,
                type: event.type,
            };

            let handler: FirestoreTriggerChangeHandler | undefined;
            if (event.type === 'create') {
                handler = registration.handlers.onCreate;
            } else if (event.type === 'update') {
                handler = registration.handlers.onUpdate;
            } else {
                handler = registration.handlers.onDelete;
            }

            if (handler) {
                await handler(change);
            }
        }
    }

    async listCollections(): Promise<ICollectionReference[]> {
        const collections = new Set<string>();

        for (const path of this.storage.keys()) {
            const parts = path.split('/');
            if (parts.length >= 1) {
                collections.add(parts[0]);
            }
        }

        return Array.from(collections).map((collectionPath) => this.collection(collectionPath));
    }

    async runTransaction<T>(updateFunction: (transaction: ITransaction) => Promise<T>): Promise<T> {
        const transaction = new StubTransaction(this.storage, this);
        const result = await updateFunction(transaction);
        await transaction.commit();
        return result;
    }

    batch(): IWriteBatch {
        return new StubWriteBatch(this.storage, this);
    }

    seed(documentPath: string, data: any): void {
        const parts = documentPath.split('/');
        const id = parts[parts.length - 1];

        this.storage.set(documentPath, {
            id,
            path: documentPath,
            data: { ...data },
            exists: true,
        });

        this.emitDocumentChange(documentPath);
    }

    clear(): void {
        this.storage.clear();
    }

    getAllDocuments(): Map<string, any> {
        const result = new Map<string, any>();
        for (const [path, doc] of this.storage.entries()) {
            if (doc.exists) {
                result.set(path, doc.data);
            }
        }
        return result;
    }
}
