/**
 * Integration Test: StubFirestoreDatabase vs Emulator vs Real Firestore
 *
 * Verifies that StubFirestoreDatabase mirrors real Firestore behaviour by
 * executing identical operations against all three implementations:
 * 1. Stub (in-memory) - always runs
 * 2. Emulator - runs when FIRESTORE_EMULATOR_HOST is set
 * 3. Real Firebase - runs when service account is available
 *
 * Configuration:
 * - Stub: No configuration needed
 * - Emulator: Run `firebase emulators:start` or use `npm run test:with-emulator`
 * - Real: Place service-account-key.json in project root or set GOOGLE_APPLICATION_CREDENTIALS
 */

import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import * as fs from 'fs';
import * as path from 'path';
import {
    attachTriggersToStub,
    createFirestoreDatabase,
    type FirestoreTriggerChange,
    type IFirestoreDatabase,
    registerTriggerWithStub,
    StubFirestoreDatabase,
    Timestamp,
    type TriggerDefinition,
} from 'ts-firebase-simulator';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type TestMode = 'stub' | 'emulator' | 'real';

function isEmulatorAvailable(): boolean {
    return !!process.env.FIRESTORE_EMULATOR_HOST;
}

function getServiceAccountPath(): string | null {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        return process.env.GOOGLE_APPLICATION_CREDENTIALS;
    }
    // __dirname is src/__tests__/integration, go up 3 levels to package root
    const localPath = path.resolve(__dirname, '../../..', 'service-account-key.json');
    if (fs.existsSync(localPath)) {
        return localPath;
    }
    return null;
}

function isRealFirebaseAvailable(): boolean {
    return getServiceAccountPath() !== null;
}

function initializeFirebaseApp(appName: string, useEmulator: boolean): void {
    const existingApp = getApps().find((app) => app.name === appName);
    if (existingApp) return;

    if (useEmulator) {
        // For emulator, we just need a project ID - no credentials required
        initializeApp({ projectId: 'demo-test-project' }, appName);
    } else {
        const serviceAccountPath = getServiceAccountPath();
        if (!serviceAccountPath) {
            throw new Error('No service account found for real Firebase');
        }
        const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
        initializeApp({
            credential: cert(serviceAccount),
            projectId: serviceAccount.project_id,
        }, appName);
    }
}

function getFirestoreForMode(mode: 'emulator' | 'real'): ReturnType<typeof getAdminFirestore> {
    const appName = mode === 'emulator' ? 'emulator-app' : 'real-app';
    initializeFirebaseApp(appName, mode === 'emulator');
    const app = getApps().find((a) => a.name === appName)!;
    return getAdminFirestore(app);
}

// Fixed test data - seeded once, reused across tests
const TEST_COLLECTION = 'firebase-simulator-test';
const TEST_PAGINATION_COLLECTION = `${TEST_COLLECTION}-pagination`;
const TEST_COLLECTION_GROUP_PARENTS = `${TEST_COLLECTION}-parents`;
const TEST_LISTENER_QUERIES_COLLECTION = `${TEST_COLLECTION}-listener-queries`;

const BASE_COLLECTION_DATA = [
    { id: 'user-1', name: 'Alice', age: 25, city: 'NYC' },
    { id: 'user-2', name: 'Bob', age: 30, city: 'LA' },
    { id: 'user-3', name: 'Charlie', age: 35, city: 'NYC' },
    { id: 'user-4', name: 'David', age: 28, city: 'SF' },
];

const PAGINATION_DATA = Array.from({ length: 6 }, (_, index) => ({
    id: `page-item-${index + 1}`,
    index,
    label: `Item ${index + 1}`,
}));

const COLLECTION_GROUP_DATA = [
    {
        parentId: 'parent-1',
        items: [
            { id: 'item-1', value: 'a', category: 'cat-1' },
            { id: 'item-2', value: 'b', category: 'cat-1' },
        ],
    },
    {
        parentId: 'parent-2',
        items: [
            { id: 'item-3', value: 'c', category: 'cat-2' },
            { id: 'item-4', value: 'd', category: 'cat-3' },
        ],
    },
];

describe('Firestore Stub Compatibility - Integration Test', () => {
    let stubDb: StubFirestoreDatabase;
    let emulatorDb: IFirestoreDatabase | null = null;
    let realDb: IFirestoreDatabase | null = null;
    // Unique prefix for tests that create/modify docs (to avoid conflicts)
    const testCollectionPrefix = `${TEST_COLLECTION}-${Date.now()}`;

    // Track which modes are available
    const emulatorAvailable = isEmulatorAvailable();
    const realFirebaseAvailable = isRealFirebaseAvailable();

    beforeAll(async () => {
        console.log(`Test modes: stub=yes, emulator=${emulatorAvailable ? 'yes' : 'no'}, real=${realFirebaseAvailable ? 'yes' : 'no'}`);

        // Initialize emulator database if available
        if (emulatorAvailable) {
            emulatorDb = createFirestoreDatabase(getFirestoreForMode('emulator'));
            // Seed emulator with test data
            const existingDoc = await emulatorDb.collection(TEST_COLLECTION).doc('user-1').get();
            if (!existingDoc.exists) {
                await seedDatabase(emulatorDb);
            }
        }

        // Initialize real database if available
        if (realFirebaseAvailable) {
            realDb = createFirestoreDatabase(getFirestoreForMode('real'));
            // Seed real Firebase with test data (check if already exists)
            const existingDoc = await realDb.collection(TEST_COLLECTION).doc('user-1').get();
            if (!existingDoc.exists) {
                await seedDatabase(realDb);
            }
        }
    });

    async function seedDatabase(db: IFirestoreDatabase) {
        // Seed base collection data
        for (const data of BASE_COLLECTION_DATA) {
            await db.collection(TEST_COLLECTION).doc(data.id).set(data);
        }

        // Seed pagination data
        for (const data of PAGINATION_DATA) {
            await db.collection(TEST_PAGINATION_COLLECTION).doc(data.id).set(data);
        }

        // Seed collection group data (in separate collection to not interfere with base queries)
        for (const parent of COLLECTION_GROUP_DATA) {
            await db.collection(TEST_COLLECTION_GROUP_PARENTS).doc(parent.parentId).set({ name: `Parent ${parent.parentId}` });
            for (const item of parent.items) {
                await db.collection(TEST_COLLECTION_GROUP_PARENTS).doc(parent.parentId).collection('items').doc(item.id).set(item);
            }
        }
    }

    beforeEach(() => {
        stubDb = new StubFirestoreDatabase();

        // Seed stub with same data (in-memory, always fast)
        for (const data of BASE_COLLECTION_DATA) {
            stubDb.collection(TEST_COLLECTION).doc(data.id).set(data);
        }
        for (const data of PAGINATION_DATA) {
            stubDb.collection(TEST_PAGINATION_COLLECTION).doc(data.id).set(data);
        }
        for (const parent of COLLECTION_GROUP_DATA) {
            stubDb.collection(TEST_COLLECTION_GROUP_PARENTS).doc(parent.parentId).set({ name: `Parent ${parent.parentId}` });
            for (const item of parent.items) {
                stubDb.collection(TEST_COLLECTION_GROUP_PARENTS).doc(parent.parentId).collection('items').doc(item.id).set(item);
            }
        }
    });

    afterEach(async () => {
        // Clean up docs created by individual tests
        const collectionsToClean = [testCollectionPrefix, TEST_LISTENER_QUERIES_COLLECTION];

        // Clean up from all available databases
        const databasesToClean = [emulatorDb, realDb].filter((db): db is IFirestoreDatabase => db !== null);

        for (const db of databasesToClean) {
            for (const collectionName of collectionsToClean) {
                const snapshot = await db.collection(collectionName).get();
                if (snapshot.docs.length > 0) {
                    // Clean subcollections
                    for (const doc of snapshot.docs) {
                        for (const subcollection of ['items', 'members', 'children']) {
                            const subSnapshot = await doc.ref.collection(subcollection).get();
                            if (subSnapshot.docs.length > 0) {
                                const subBatch = db.batch();
                                subSnapshot.docs.forEach((subDoc) => subBatch.delete(subDoc.ref));
                                await subBatch.commit();
                            }
                        }
                    }
                    // Clean main docs
                    const batch = db.batch();
                    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
                    await batch.commit();
                }
            }
        }

        stubDb.clear();
    });

    async function testAllImplementations(
        testName: string,
        testFn: (db: IFirestoreDatabase, mode: TestMode) => Promise<void>,
    ) {
        // 1. Stub (always runs)
        await testFn(stubDb, 'stub');

        // 2. Emulator (if available)
        if (emulatorDb) {
            await testFn(emulatorDb, 'emulator');
        }

        // 3. Real Firebase (if available)
        if (realDb) {
            await testFn(realDb, 'real');
        }
    }

    function waitForListenerFlush(mode: TestMode, delayMs: number = 60): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, mode === 'stub' ? 0 : delayMs));
    }

    describe('Basic Document Operations', () => {
        it('should create and read documents identically', async () => {
            await testAllImplementations('create and read', async (db, mode) => {
                const docRef = db.collection(testCollectionPrefix).doc('test-doc-1');

                const testData = {
                    name: 'Test User',
                    age: 30,
                    city: 'NYC',
                    createdAt: Timestamp.now(),
                };

                await docRef.set(testData);

                const snapshot = await docRef.get();

                expect(snapshot.exists, `Document should exist (${mode})`).toBe(true);
                expect(snapshot.id).toBe('test-doc-1');

                const data = snapshot.data();
                expect(data?.name).toBe('Test User');
                expect(data?.age).toBe(30);
                expect(data?.city).toBe('NYC');
                expect(data?.createdAt).toBeInstanceOf(Timestamp);
            });
        });

        it('should update documents identically', async () => {
            await testAllImplementations('update', async (db, mode) => {
                const docRef = db.collection(testCollectionPrefix).doc('test-doc-2');

                await docRef.set({ name: 'Original', age: 25 });
                await docRef.update({ age: 26 });

                const snapshot = await docRef.get();
                const data = snapshot.data();

                expect(data?.name, `Name unchanged (${mode})`).toBe('Original');
                expect(data?.age, `Age updated (${mode})`).toBe(26);
            });
        });

        it('should delete documents identically', async () => {
            await testAllImplementations('delete', async (db, mode) => {
                const docRef = db.collection(testCollectionPrefix).doc('test-doc-3');

                await docRef.set({ name: 'To Delete' });
                await docRef.delete();

                const snapshot = await docRef.get();
                expect(snapshot.exists, `Document deleted (${mode})`).toBe(false);
            });
        });

        it('should handle merge operations identically', async () => {
            await testAllImplementations('merge', async (db, mode) => {
                const docRef = db.collection(testCollectionPrefix).doc('test-doc-4');

                await docRef.set({ name: 'Original', age: 30 });
                await docRef.set({ age: 31, city: 'LA' }, { merge: true });

                const snapshot = await docRef.get();
                const data = snapshot.data();

                expect(data?.name, `Original fields preserved (${mode})`).toBe('Original');
                expect(data?.age, `Merged field updated (${mode})`).toBe(31);
                expect(data?.city, `New merged field added (${mode})`).toBe('LA');
            });
        });
    });

    describe('Query Operations', () => {
        // Uses pre-seeded TEST_COLLECTION and TEST_PAGINATION_COLLECTION data

        it('should handle where queries identically', async () => {
            await testAllImplementations('where query', async (db, mode) => {
                const snapshot = await db.collection(TEST_COLLECTION).where('city', '==', 'NYC').get();

                expect(snapshot.size, `Query result count (${mode})`).toBe(2);

                const names = snapshot.docs.map((doc) => doc.data().name).sort();
                expect(names, `Query results match (${mode})`).toEqual(['Alice', 'Charlie']);
            });
        });

        it('should handle range queries identically', async () => {
            await testAllImplementations('range query', async (db, mode) => {
                const snapshot = await db.collection(TEST_COLLECTION).where('age', '>', 28).get();

                expect(snapshot.size, `Range query count (${mode})`).toBe(2);

                const ages = snapshot.docs.map((doc) => doc.data().age).sort();
                expect(ages, `Range query results (${mode})`).toEqual([30, 35]);
            });
        });

        it('should handle orderBy queries identically', async () => {
            await testAllImplementations('orderBy query', async (db, mode) => {
                const snapshot = await db.collection(TEST_COLLECTION).orderBy('age', 'desc').get();

                expect(snapshot.size, `OrderBy result count (${mode})`).toBe(4);

                const names = snapshot.docs.map((doc) => doc.data().name);
                expect(names, `OrderBy results (${mode})`).toEqual(['Charlie', 'Bob', 'David', 'Alice']);
            });
        });

        it('should handle limit queries identically', async () => {
            await testAllImplementations('limit query', async (db, mode) => {
                const snapshot = await db.collection(TEST_COLLECTION).orderBy('age').limit(2).get();

                expect(snapshot.size, `Limit result count (${mode})`).toBe(2);

                const names = snapshot.docs.map((doc) => doc.data().name);
                expect(names, `Limit results (${mode})`).toEqual(['Alice', 'David']);
            });
        });

        it('should handle offset queries identically', async () => {
            await testAllImplementations('offset query', async (db, mode) => {
                const snapshot = await db.collection(TEST_COLLECTION).orderBy('age').offset(2).limit(2).get();

                expect(snapshot.size, `Offset result count (${mode})`).toBe(2);

                const names = snapshot.docs.map((doc) => doc.data().name);
                expect(names, `Offset results (${mode})`).toEqual(['Bob', 'Charlie']);
            });
        });

        it('should handle combined queries identically', async () => {
            await testAllImplementations('combined query', async (db, mode) => {
                const snapshot = await db.collection(TEST_COLLECTION).where('city', '==', 'NYC').where('age', '>', 25).orderBy('age').get();

                expect(snapshot.size, `Combined query count (${mode})`).toBe(1);

                const data = snapshot.docs[0].data();
                expect(data?.name, `Combined query result (${mode})`).toBe('Charlie');
            });
        });

        it('should return identical results for paginated queries', async () => {
            await testAllImplementations('paginated query', async (db, mode) => {
                const baseQuery = db.collection(TEST_PAGINATION_COLLECTION).orderBy('index');

                const limit = 3;
                const firstPage = await baseQuery.limit(limit).get();

                expect(firstPage.size, `First page size (${mode})`).toBe(limit);

                const lastDoc = firstPage.docs[firstPage.docs.length - 1];
                const secondPage = await baseQuery.startAfter(lastDoc).limit(limit).get();

                expect(secondPage.size, `Second page size (${mode})`).toBe(limit);

                const combined = [...firstPage.docs, ...secondPage.docs];
                const indexes = combined.map((doc) => doc.data().index);

                expect(new Set(indexes).size).toBe(limit * 2);
                expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
            });
        });
    });

    describe('Transaction Operations', () => {
        it('should handle transactional reads and writes identically', async () => {
            await testAllImplementations('transaction', async (db, mode) => {
                const docRef = db.collection(testCollectionPrefix).doc('counter');
                await docRef.set({ count: 0 });

                await db.runTransaction(async (transaction) => {
                    const snapshot = await transaction.get(docRef);
                    const currentCount = snapshot.data()?.count || 0;
                    transaction.update(docRef, { count: currentCount + 1 });
                });

                const snapshot = await docRef.get();
                expect(snapshot.data()?.count, `Transaction result (${mode})`).toBe(1);
            });
        });

        it('should rollback transactions on error identically', async () => {
            await testAllImplementations('transaction rollback', async (db, mode) => {
                const docRef = db.collection(testCollectionPrefix).doc('rollback-test');
                await docRef.set({ value: 100 });

                try {
                    await db.runTransaction(async (transaction) => {
                        transaction.update(docRef, { value: 200 });
                        throw new Error('Forced rollback');
                    });
                } catch {
                    // expected
                }

                const snapshot = await docRef.get();
                expect(snapshot.data()?.value, `Rollback preserves original (${mode})`).toBe(100);
            });
        });
    });

    describe('Batch Operations', () => {
        it('should handle batch writes identically', async () => {
            await testAllImplementations('batch writes', async (db, mode) => {
                const batch = db.batch();

                const doc1 = db.collection(testCollectionPrefix).doc('batch-1');
                const doc2 = db.collection(testCollectionPrefix).doc('batch-2');

                batch.set(doc1, { name: 'Batch User 1' });
                batch.set(doc2, { name: 'Batch User 2' });

                await batch.commit();

                const snapshot1 = await doc1.get();
                const snapshot2 = await doc2.get();

                expect(snapshot1.exists, `Batch doc 1 exists (${mode})`).toBe(true);
                expect(snapshot2.exists, `Batch doc 2 exists (${mode})`).toBe(true);
            });
        });
    });

    describe('Subcollections', () => {
        it('should handle subcollections identically', async () => {
            await testAllImplementations('subcollections', async (db, mode) => {
                const groupRef = db.collection(testCollectionPrefix).doc('group-1');
                await groupRef.set({ name: 'Test Group' });

                const membersRef = groupRef.collection('members');
                await membersRef.doc('member-1').set({ name: 'Alice', role: 'admin' });
                await membersRef.doc('member-2').set({ name: 'Bob', role: 'member' });

                const snapshot = await membersRef.get();
                expect(snapshot.size, `Subcollection size (${mode})`).toBe(2);

                const names = snapshot.docs.map((doc) => doc.data().name).sort();
                expect(names, `Subcollection data (${mode})`).toEqual(['Alice', 'Bob']);
            });
        });

        it('should navigate parent/child relationships identically', async () => {
            await testAllImplementations('parent navigation', async (db, mode) => {
                const groupRef = db.collection(testCollectionPrefix).doc('group-2');
                await groupRef.set({ name: 'Parent Group' });

                const memberRef = groupRef.collection('members').doc('member-1');
                await memberRef.set({ name: 'Child Member' });

                const parentRef = memberRef.parent?.parent;
                expect(parentRef, `Parent reference exists (${mode})`).toBeDefined();

                if (parentRef) {
                    const parentSnapshot = await parentRef.get();
                    expect(parentSnapshot.data()?.name, `Parent data accessible (${mode})`).toBe('Parent Group');
                }
            });
        });
    });

    describe('Collection Group Queries', () => {
        // Uses pre-seeded COLLECTION_GROUP_DATA under TEST_COLLECTION

        it('should query collection groups identically', async () => {
            await testAllImplementations('collection group', async (db, mode) => {
                const snapshot = await db.collectionGroup('items').get();

                expect(snapshot.size, `Collection group size (${mode})`).toBe(4);
            });
        });

        it('should filter collection group queries identically', async () => {
            await testAllImplementations('collection group filter', async (db, mode) => {
                const snapshot = await db.collectionGroup('items').where('category', '==', 'cat-1').get();

                expect(snapshot.size, `Filtered items (${mode})`).toBe(2);
            });
        });

        it('should limit collection group queries identically', async () => {
            await testAllImplementations('collection group limit', async (db, mode) => {
                const snapshot = await db
                    .collectionGroup('items')
                    .where('category', '==', 'cat-1')
                    .limit(1)
                    .get();

                expect(snapshot.size, `Limited filtered items (${mode})`).toBe(1);
                expect(snapshot.docs[0].id, `Limited item ID (${mode})`).toBe('item-1');
            });
        });
    });

    describe('Edge Cases', () => {
        it('should handle non-existent documents identically', async () => {
            await testAllImplementations('non-existent doc', async (db, mode) => {
                const docRef = db.collection(testCollectionPrefix).doc('does-not-exist');
                const snapshot = await docRef.get();

                expect(snapshot.exists, `Non-existent doc (${mode})`).toBe(false);
                expect(snapshot.data(), `Non-existent doc data (${mode})`).toBeUndefined();
            });
        });

        it('should handle update on non-existent document identically', async () => {
            await testAllImplementations('update non-existent', async (db, mode) => {
                const docRef = db.collection(testCollectionPrefix).doc('does-not-exist-update');

                try {
                    await docRef.update({ field: 'value' });
                    expect.fail(`Should have thrown error (${mode})`);
                } catch (error: any) {
                    const message = String(error?.message ?? error ?? '');
                    const errorCode = error?.code;
                    const matches = message.includes('No document to update')
                        || message.includes('does not exist')
                        || message.includes('NOT_FOUND')
                        || errorCode === 5
                        || errorCode === 'not-found';
                    expect(matches, `Error message matches (${mode})`).toBe(true);
                }
            });
        });
    });

    describe('Trigger registration via simulator', () => {
        it('should capture trigger operations on stub and no-op on real', async () => {
            const triggerHandler = vi.fn();

            const unregister = stubDb.registerTrigger(`${testCollectionPrefix}/{docId}`, {
                onCreate: triggerHandler,
                onUpdate: triggerHandler,
                onDelete: triggerHandler,
            });

            const docRef = stubDb.collection(testCollectionPrefix).doc('trigger-doc');
            await docRef.set({ value: 1 });
            await docRef.update({ value: 2 });
            await docRef.delete();

            const capturedEvents = triggerHandler.mock.calls.map(([change]) => (change as FirestoreTriggerChange).type);
            expect(capturedEvents).toEqual(['create', 'update', 'delete']);

            unregister();
        });

        it('should adapt events with params and snapshots consistently', async () => {
            const events: Array<{
                changeType: string;
                params: Record<string, string>;
                before?: { data: () => any; exists: boolean; };
                after?: { data: () => any; exists: boolean; };
            }> = [];

            const definition: TriggerDefinition<'testTrigger'> = {
                name: 'testTrigger',
                document: `${testCollectionPrefix}/{docId}`,
                operations: ['create', 'update', 'delete'],
                createProdTrigger: vi.fn(),
            };

            const unregister = registerTriggerWithStub(stubDb, definition, async (event) => {
                events.push({
                    changeType: event.changeType,
                    params: event.params,
                    before: event.data.before,
                    after: event.data.after,
                });
            });

            const docRef = stubDb.collection(testCollectionPrefix).doc('abc');
            await docRef.set({ foo: 1 });
            await docRef.update({ foo: 2 });
            await docRef.delete();

            unregister();

            expect(events.map((event) => event.changeType)).toEqual(['create', 'update', 'delete']);

            const [createEvent, updateEvent, deleteEvent] = events;

            expect(createEvent.params).toEqual({ docId: 'abc' });
            expect(createEvent.before?.exists).toBe(false);
            expect(createEvent.before?.data()).toBeUndefined();
            expect(createEvent.after?.exists).toBe(true);
            expect(createEvent.after?.data()).toEqual({ foo: 1 });

            expect(updateEvent.before?.exists).toBe(true);
            expect(updateEvent.before?.data()).toEqual({ foo: 1 });
            expect(updateEvent.after?.data()).toEqual({ foo: 2 });

            expect(deleteEvent.before?.exists).toBe(true);
            expect(deleteEvent.before?.data()).toEqual({ foo: 2 });
            expect(deleteEvent.after?.exists).toBe(false);
            expect(deleteEvent.after?.data()).toBeUndefined();
        });

        it('should respect operation filters when registering triggers', async () => {
            const handler = vi.fn();

            const unregister = registerTriggerWithStub(
                stubDb,
                {
                    name: 'updateOnly',
                    document: `${testCollectionPrefix}/{docId}`,
                    operations: ['update'],
                    createProdTrigger: vi.fn(),
                },
                async (event) => handler(event.changeType),
            );

            const docRef = stubDb.collection(testCollectionPrefix).doc('filter-test');

            await docRef.set({ value: 1 });
            await docRef.update({ value: 2 });
            await docRef.delete();

            unregister();

            expect(handler).toHaveBeenCalledTimes(1);
            expect(handler).toHaveBeenCalledWith('update');
        });

        it('should attach multiple definitions and unregister cleanly', async () => {
            const events: Array<{ name: string; type: string; params: Record<string, string>; }> = [];

            const definitions: TriggerDefinition<string>[] = [
                {
                    name: 'parentCreate',
                    document: `${testCollectionPrefix}/{docId}`,
                    operations: ['create'],
                    createProdTrigger: vi.fn(),
                    mapParams: ({ docId }) => ({ docId }),
                },
                {
                    name: 'childLifecycle',
                    document: `${testCollectionPrefix}/{docId}/children/{childId}`,
                    operations: ['create', 'delete'],
                    createProdTrigger: vi.fn(),
                    mapParams: ({ docId, childId }) => ({ parent: docId, child: childId }),
                },
            ];

            const detach = attachTriggersToStub(
                stubDb,
                definitions,
                (definition) => async (event) => {
                    events.push({
                        name: definition.name,
                        type: event.changeType,
                        params: event.params,
                    });
                },
            );

            const parentRef = stubDb.collection(testCollectionPrefix).doc('parent-1');
            await parentRef.set({ foo: 'bar' });

            const childRef = parentRef.collection('children').doc('child-1');
            await childRef.set({ value: 1 });
            await childRef.delete();

            expect(events).toEqual([
                { name: 'parentCreate', type: 'create', params: { docId: 'parent-1' } },
                { name: 'childLifecycle', type: 'create', params: { parent: 'parent-1', child: 'child-1' } },
                { name: 'childLifecycle', type: 'delete', params: { parent: 'parent-1', child: 'child-1' } },
            ]);

            events.length = 0;
            detach();

            await parentRef.set({ foo: 'baz' });
            await childRef.set({ value: 2 });

            expect(events).toHaveLength(0);
        });

        describe('Realtime listeners', () => {
            it('should stream document snapshots identically', async () => {
                await testAllImplementations('document listener', async (db, mode) => {
                    const docRef = db.collection(`${testCollectionPrefix}-listeners`).doc('doc-stream');
                    const snapshots: Array<{ exists: boolean; data: any | undefined; }> = [];
                    const errors: Error[] = [];

                    const unsubscribe = docRef.onSnapshot(
                        (snapshot) => snapshots.push({ exists: snapshot.exists, data: snapshot.data() }),
                        (error) => errors.push(error),
                    );

                    await waitForListenerFlush(mode);

                    await docRef.set({ stage: 'created', value: 1 });
                    await waitForListenerFlush(mode);

                    await docRef.update({ stage: 'updated', value: 2 });
                    await waitForListenerFlush(mode);

                    await docRef.delete();
                    await waitForListenerFlush(mode);

                    unsubscribe();

                    expect(errors, `Listener errors (${mode})`).toHaveLength(0);
                    expect(snapshots.length, `Snapshot count (${mode})`).toBe(4);
                    expect(snapshots[0].exists).toBe(false);
                    expect(snapshots[1].data).toEqual({ stage: 'created', value: 1 });
                    expect(snapshots[2].data).toEqual({ stage: 'updated', value: 2 });
                    expect(snapshots[3].exists).toBe(false);
                });
            });

            it('should stream filtered query snapshots identically', async () => {
                await testAllImplementations('query listener', async (db, mode) => {
                    const collection = db.collection(TEST_LISTENER_QUERIES_COLLECTION);

                    // Clean up any existing docs first (from previous runs)
                    const existing = await collection.get();
                    if (existing.docs.length > 0) {
                        const batch = db.batch();
                        existing.docs.forEach((doc) => batch.delete(doc.ref));
                        await batch.commit();
                    }

                    await collection.doc('user-1').set({ name: 'Alice', city: 'NYC' });
                    await collection.doc('user-2').set({ name: 'Bob', city: 'LA' });

                    const results: string[][] = [];
                    const errors: Error[] = [];

                    // Wait for the initial snapshot before subscribing to avoid race conditions
                    // between document setup and listener registration
                    await new Promise<void>((resolve) => {
                        let resolved = false;
                        const unsubscribeInit = collection
                            .where('city', '==', 'NYC')
                            .orderBy('name')
                            .onSnapshot(
                                () => {
                                    if (!resolved) {
                                        resolved = true;
                                        unsubscribeInit();
                                        resolve();
                                    }
                                },
                                (error) => errors.push(error),
                            );
                    });

                    const unsubscribe = collection
                        .where('city', '==', 'NYC')
                        .orderBy('name')
                        .onSnapshot(
                            (snapshot) => results.push(snapshot.docs.map((doc) => doc.data().name)),
                            (error) => errors.push(error),
                        );

                    await waitForListenerFlush(mode);

                    await collection.doc('user-3').set({ name: 'Charlie', city: 'NYC' });
                    await waitForListenerFlush(mode);

                    await collection.doc('user-1').update({ city: 'SF' });
                    await waitForListenerFlush(mode);

                    await collection.doc('user-2').set({ name: 'Bob', city: 'NYC' });
                    await waitForListenerFlush(mode);

                    unsubscribe();

                    expect(errors, `Query listener errors (${mode})`).toHaveLength(0);
                    expect(results, `Query snapshot evolution (${mode})`).toEqual([
                        ['Alice'],
                        ['Alice', 'Charlie'],
                        ['Charlie'],
                        ['Bob', 'Charlie'],
                    ]);
                });
            });
        });
    });
});
