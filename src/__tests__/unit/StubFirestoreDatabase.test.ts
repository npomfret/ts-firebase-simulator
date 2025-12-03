/**
 * Example tests demonstrating StubFirestoreDatabase usage
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import { StubFirestoreDatabase } from '../../StubFirestoreDatabase';

describe('StubFirestoreDatabase - Example Usage', () => {
    let db: StubFirestoreDatabase;
    const waitForUpdates = () => new Promise((resolve) => setTimeout(resolve, 0));

    beforeEach(() => {
        db = new StubFirestoreDatabase();
    });

    describe('Basic document operations', () => {
        it('should create and read a document', async () => {
            const docRef = db.collection('users').doc('user-123');

            await docRef.set({
                name: 'John Doe',
                email: 'john@example.com',
                age: 30,
            });

            const snapshot = await docRef.get();

            expect(snapshot.exists).toBe(true);
            expect(snapshot.id).toBe('user-123');
            expect(snapshot.data()).toEqual({
                name: 'John Doe',
                email: 'john@example.com',
                age: 30,
            });
        });

        it('should update a document', async () => {
            const docRef = db.collection('users').doc('user-123');

            await docRef.set({ name: 'John Doe', age: 30 });
            await docRef.update({ age: 31 });

            const snapshot = await docRef.get();
            expect(snapshot.data()).toEqual({ name: 'John Doe', age: 31 });
        });

        it('should delete a document', async () => {
            const docRef = db.collection('users').doc('user-123');

            await docRef.set({ name: 'John Doe' });
            await docRef.delete();

            const snapshot = await docRef.get();
            expect(snapshot.exists).toBe(false);
        });

        it('should merge data with set merge option', async () => {
            const docRef = db.collection('users').doc('user-123');

            await docRef.set({ name: 'John Doe', age: 30 });
            await docRef.set({ age: 31, city: 'NYC' }, { merge: true });

            const snapshot = await docRef.get();
            expect(snapshot.data()).toEqual({
                name: 'John Doe',
                age: 31,
                city: 'NYC',
            });
        });
    });

    describe('Query operations', () => {
        beforeEach(async () => {
            await db.collection('users').doc('user-1').set({ name: 'Alice', age: 25, city: 'NYC' });
            await db.collection('users').doc('user-2').set({ name: 'Bob', age: 30, city: 'LA' });
            await db.collection('users').doc('user-3').set({ name: 'Charlie', age: 35, city: 'NYC' });
        });

        it('should query with where clause', async () => {
            const querySnapshot = await db.collection('users').where('city', '==', 'NYC').get();

            expect(querySnapshot.size).toBe(2);
            expect(querySnapshot.docs.map((d) => d.data().name)).toEqual(['Alice', 'Charlie']);
        });

        it('should query with orderBy', async () => {
            const querySnapshot = await db.collection('users').orderBy('age', 'desc').get();

            expect(querySnapshot.size).toBe(3);
            expect(querySnapshot.docs.map((d) => d.data().name)).toEqual(['Charlie', 'Bob', 'Alice']);
        });

        it('should query with limit', async () => {
            const querySnapshot = await db.collection('users').orderBy('age').limit(2).get();

            expect(querySnapshot.size).toBe(2);
            expect(querySnapshot.docs.map((d) => d.data().name)).toEqual(['Alice', 'Bob']);
        });

        it('should query with offset', async () => {
            const querySnapshot = await db.collection('users').orderBy('age').offset(1).limit(2).get();

            expect(querySnapshot.size).toBe(2);
            expect(querySnapshot.docs.map((d) => d.data().name)).toEqual(['Bob', 'Charlie']);
        });

        it('should combine multiple query conditions', async () => {
            const querySnapshot = await db.collection('users').where('city', '==', 'NYC').where('age', '>', 25).orderBy('age').get();

            expect(querySnapshot.size).toBe(1);
            expect(querySnapshot.docs[0].data().name).toBe('Charlie');
        });
    });

    describe('Transaction operations', () => {
        it('should perform transactional reads and writes', async () => {
            const docRef = db.collection('counters').doc('counter-1');
            await docRef.set({ count: 0 });

            await db.runTransaction(async (transaction) => {
                const snapshot = await transaction.get(docRef);
                const currentCount = snapshot.data()?.count || 0;

                transaction.update(docRef, { count: currentCount + 1 });
            });

            const snapshot = await docRef.get();
            expect(snapshot.data()).toEqual({ count: 1 });
        });

        it('should rollback on transaction error', async () => {
            const docRef = db.collection('users').doc('user-1');
            await docRef.set({ name: 'Alice', balance: 100 });

            try {
                await db.runTransaction(async (transaction) => {
                    transaction.update(docRef, { balance: 150 });
                    throw new Error('Transaction failed');
                });
            } catch (error) {
                //
            }

            const snapshot = await docRef.get();
            expect(snapshot.data()?.balance).toBe(100);
        });

        it('should handle query in transaction', async () => {
            await db.collection('users').doc('user-1').set({ name: 'Alice', age: 25 });
            await db.collection('users').doc('user-2').set({ name: 'Bob', age: 30 });

            const result = await db.runTransaction(async (transaction) => {
                const query = db.collection('users').where('age', '>', 20);
                const querySnapshot = await transaction.get(query);

                return querySnapshot.size;
            });

            expect(result).toBe(2);
        });
    });

    describe('Batch operations', () => {
        it('should batch multiple writes', async () => {
            const batch = db.batch();

            const doc1 = db.collection('users').doc('user-1');
            const doc2 = db.collection('users').doc('user-2');
            const doc3 = db.collection('users').doc('user-3');

            batch.set(doc1, { name: 'Alice' });
            batch.set(doc2, { name: 'Bob' });
            batch.update(doc3, { name: 'Charlie' });

            try {
                await batch.commit();
            } catch (error) {
                //
            }

            const snapshot1 = await doc1.get();
            const snapshot2 = await doc2.get();

            expect(snapshot1.exists).toBe(true);
            expect(snapshot2.exists).toBe(true);
        });
    });

    describe('Test helpers', () => {
        it('should seed data using helper', () => {
            db.seed('users/user-123', { name: 'Test User', age: 25 });

            const allDocs = db.getAllDocuments();
            expect(allDocs.get('users/user-123')).toEqual({
                name: 'Test User',
                age: 25,
            });
        });

        it('should clear all data', async () => {
            await db.collection('users').doc('user-1').set({ name: 'Alice' });
            await db.collection('users').doc('user-2').set({ name: 'Bob' });

            db.clear();

            const querySnapshot = await db.collection('users').get();
            expect(querySnapshot.empty).toBe(true);
        });
    });

    describe('Subcollections', () => {
        it('should handle subcollections', async () => {
            const groupRef = db.collection('groups').doc('group-1');
            await groupRef.set({ name: 'Test Group' });

            const membersRef = groupRef.collection('members');
            await membersRef.doc('member-1').set({ name: 'Alice', role: 'admin' });
            await membersRef.doc('member-2').set({ name: 'Bob', role: 'member' });

            const membersSnapshot = await membersRef.get();
            expect(membersSnapshot.size).toBe(2);
        });
    });

    describe('Collection group queries', () => {
        beforeEach(async () => {
            // Set up share links in multiple groups
            await db.collection('groups').doc('group-1').collection('shareLinks').doc('link-1').set({
                token: 'token-1',
                createdBy: 'user-1',
            });

            await db.collection('groups').doc('group-1').collection('shareLinks').doc('link-2').set({
                token: 'token-2',
                createdBy: 'user-1',
            });

            await db.collection('groups').doc('group-2').collection('shareLinks').doc('link-3').set({
                token: 'token-3',
                createdBy: 'user-2',
            });

            await db.collection('groups').doc('group-3').collection('shareLinks').doc('link-4').set({
                token: 'token-4',
                createdBy: 'user-3',
            });
        });

        it('should query across all subcollections with the same name', async () => {
            const querySnapshot = await db.collectionGroup('shareLinks').get();

            expect(querySnapshot.size).toBe(4);
            expect(querySnapshot.docs.map((d) => d.id)).toEqual(['link-1', 'link-2', 'link-3', 'link-4']);
        });

        it('should filter collection group queries', async () => {
            const querySnapshot = await db.collectionGroup('shareLinks').where('createdBy', '==', 'user-1').get();

            expect(querySnapshot.size).toBe(2);
            expect(querySnapshot.docs.map((d) => d.id)).toEqual(['link-1', 'link-2']);
        });

        it('should find specific document in collection group by token', async () => {
            const querySnapshot = await db.collectionGroup('shareLinks').where('token', '==', 'token-3').limit(1).get();

            expect(querySnapshot.size).toBe(1);
            expect(querySnapshot.docs[0].id).toBe('link-3');
            expect(querySnapshot.docs[0].data().createdBy).toBe('user-2');
        });

        it('should combine where clauses in collection group query', async () => {
            const querySnapshot = await db.collectionGroup('shareLinks').where('createdBy', '==', 'user-1').where('token', '==', 'token-1').get();

            expect(querySnapshot.size).toBe(1);
            expect(querySnapshot.docs[0].id).toBe('link-1');
        });

        it('should return empty result when no documents match in collection group', async () => {
            const querySnapshot = await db.collectionGroup('shareLinks').where('token', '==', 'nonexistent-token').get();

            expect(querySnapshot.empty).toBe(true);
            expect(querySnapshot.size).toBe(0);
        });

        it('should handle collection group with ordering and limit', async () => {
            const querySnapshot = await db.collectionGroup('shareLinks').orderBy('createdBy').limit(2).get();

            expect(querySnapshot.size).toBe(2);
            expect(querySnapshot.docs.map((d) => d.data().createdBy)).toEqual(['user-1', 'user-1']);
        });
    });

    describe('FieldValue operations', () => {
        it('should handle FieldValue.increment() with update', async () => {
            const docRef = db.collection('counters').doc('counter-1');

            await docRef.set({ count: 5, name: 'Test Counter' });

            await docRef.update({ count: FieldValue.increment(3) });

            const snapshot = await docRef.get();
            expect(snapshot.data()).toEqual({
                count: 8,
                name: 'Test Counter',
            });
        });

        it('should handle FieldValue.increment() with set merge', async () => {
            const docRef = db.collection('counters').doc('counter-1');

            await docRef.set({ count: 10, name: 'Test' });

            await docRef.set({ count: FieldValue.increment(5) }, { merge: true });

            const snapshot = await docRef.get();
            expect(snapshot.data()).toEqual({
                count: 15,
                name: 'Test',
            });
        });

        it('should handle FieldValue.increment() on non-existent field', async () => {
            const docRef = db.collection('counters').doc('counter-1');

            await docRef.set({ name: 'Test' });

            await docRef.update({ count: FieldValue.increment(7) });

            const snapshot = await docRef.get();
            expect(snapshot.data()).toEqual({
                name: 'Test',
                count: 7,
            });
        });

        it('should handle FieldValue.increment() with negative values', async () => {
            const docRef = db.collection('counters').doc('counter-1');

            await docRef.set({ count: 20 });

            await docRef.update({ count: FieldValue.increment(-5) });

            const snapshot = await docRef.get();
            expect(snapshot.data()?.count).toBe(15);
        });

        it('should handle FieldValue.increment() with dot notation', async () => {
            const docRef = db.collection('analytics').doc('stats-1');

            await docRef.set({ stats: { views: 10, likes: 5 } });

            await docRef.update({ 'stats.views': FieldValue.increment(3) });

            const snapshot = await docRef.get();
            expect(snapshot.data()).toEqual({
                stats: {
                    views: 13,
                    likes: 5,
                },
            });
        });

        it('should handle multiple FieldValue.increment() in single operation', async () => {
            const docRef = db.collection('counters').doc('counter-1');

            await docRef.set({ count1: 5, count2: 10, count3: 15 });

            await docRef.update({
                count1: FieldValue.increment(2),
                count2: FieldValue.increment(-3),
                count3: FieldValue.increment(5),
            });

            const snapshot = await docRef.get();
            expect(snapshot.data()).toEqual({
                count1: 7,
                count2: 7,
                count3: 20,
            });
        });

        it('should handle FieldValue.increment() in batch operations', async () => {
            const batch = db.batch();

            const doc1 = db.collection('counters').doc('counter-1');
            const doc2 = db.collection('counters').doc('counter-2');

            await doc1.set({ count: 5 });
            await doc2.set({ count: 10 });

            batch.update(doc1, { count: FieldValue.increment(3) });
            batch.update(doc2, { count: FieldValue.increment(-2) });

            await batch.commit();

            const snapshot1 = await doc1.get();
            const snapshot2 = await doc2.get();

            expect(snapshot1.data()?.count).toBe(8);
            expect(snapshot2.data()?.count).toBe(8);
        });

        it('should handle FieldValue.increment() in transactions', async () => {
            const docRef = db.collection('counters').doc('counter-1');

            await docRef.set({ count: 100 });

            await db.runTransaction(async (transaction) => {
                const snapshot = await transaction.get(docRef);
                const data = snapshot.data();

                if (data) {
                    transaction.update(docRef, { count: FieldValue.increment(50) });
                }
            });

            const snapshot = await docRef.get();
            expect(snapshot.data()?.count).toBe(150);
        });

        it('should handle FieldValue.serverTimestamp() with update', async () => {
            const docRef = db.collection('documents').doc('doc-1');

            await docRef.set({ title: 'Test Document', createdAt: Timestamp.now() });

            await docRef.update({ updatedAt: FieldValue.serverTimestamp() });

            const snapshot = await docRef.get();
            const data = snapshot.data();

            expect(data?.title).toBe('Test Document');
            expect(data?.createdAt).toBeInstanceOf(Timestamp);
            expect(data?.updatedAt).toBeInstanceOf(Timestamp);
        });

        it('should handle FieldValue.serverTimestamp() with set merge', async () => {
            const docRef = db.collection('documents').doc('doc-1');

            await docRef.set({ title: 'Test Document' });

            await docRef.set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });

            const snapshot = await docRef.get();
            const data = snapshot.data();

            expect(data?.title).toBe('Test Document');
            expect(data?.updatedAt).toBeInstanceOf(Timestamp);
        });

        it('should handle FieldValue.serverTimestamp() in initial set', async () => {
            const docRef = db.collection('documents').doc('doc-1');

            await docRef.set({
                title: 'Test Document',
                createdAt: FieldValue.serverTimestamp(),
            });

            const snapshot = await docRef.get();
            const data = snapshot.data();

            expect(data?.title).toBe('Test Document');
            expect(data?.createdAt).toBeInstanceOf(Timestamp);
        });

        it('should handle FieldValue.serverTimestamp() with dot notation', async () => {
            const docRef = db.collection('documents').doc('doc-1');

            await docRef.set({ metadata: { title: 'Test' } });

            await docRef.update({ 'metadata.lastModified': FieldValue.serverTimestamp() });

            const snapshot = await docRef.get();
            const data = snapshot.data();

            expect(data?.metadata?.title).toBe('Test');
            expect(data?.metadata?.lastModified).toBeInstanceOf(Timestamp);
        });

        it('should handle mixed FieldValue operations (increment + serverTimestamp)', async () => {
            const docRef = db.collection('documents').doc('doc-1');

            await docRef.set({ title: 'Test', viewCount: 10 });

            await docRef.update({
                viewCount: FieldValue.increment(5),
                lastViewed: FieldValue.serverTimestamp(),
            });

            const snapshot = await docRef.get();
            const data = snapshot.data();

            expect(data?.title).toBe('Test');
            expect(data?.viewCount).toBe(15);
            expect(data?.lastViewed).toBeInstanceOf(Timestamp);
        });

        it('should handle FieldValue.serverTimestamp() in batch operations', async () => {
            const batch = db.batch();

            const doc1 = db.collection('documents').doc('doc-1');
            const doc2 = db.collection('documents').doc('doc-2');

            await doc1.set({ title: 'Doc 1' });
            await doc2.set({ title: 'Doc 2' });

            batch.update(doc1, { updatedAt: FieldValue.serverTimestamp() });
            batch.update(doc2, { updatedAt: FieldValue.serverTimestamp() });

            await batch.commit();

            const snapshot1 = await doc1.get();
            const snapshot2 = await doc2.get();

            expect(snapshot1.data()?.updatedAt).toBeInstanceOf(Timestamp);
            expect(snapshot2.data()?.updatedAt).toBeInstanceOf(Timestamp);
        });

        it('should handle FieldValue.serverTimestamp() in transactions', async () => {
            const docRef = db.collection('documents').doc('doc-1');

            await docRef.set({ title: 'Test Document' });

            await db.runTransaction(async (transaction) => {
                const snapshot = await transaction.get(docRef);
                const data = snapshot.data();

                if (data) {
                    transaction.update(docRef, { updatedAt: FieldValue.serverTimestamp() });
                }
            });

            const snapshot = await docRef.get();
            const data = snapshot.data();

            expect(data?.updatedAt).toBeInstanceOf(Timestamp);
        });

        it('should handle multiple serverTimestamp fields in single operation', async () => {
            const docRef = db.collection('documents').doc('doc-1');

            await docRef.set({
                title: 'Test',
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
            });

            const snapshot = await docRef.get();
            const data = snapshot.data();

            expect(data?.title).toBe('Test');
            expect(data?.createdAt).toBeInstanceOf(Timestamp);
            expect(data?.updatedAt).toBeInstanceOf(Timestamp);
        });

        it('should handle complex mixed FieldValue operations', async () => {
            const docRef = db.collection('analytics').doc('stats-1');

            await docRef.set({
                pageViews: 100,
                uniqueVisitors: 50,
                metadata: {
                    title: 'Analytics Dashboard',
                },
            });

            await docRef.update({
                pageViews: FieldValue.increment(10),
                uniqueVisitors: FieldValue.increment(3),
                'metadata.lastUpdated': FieldValue.serverTimestamp(),
                lastModified: FieldValue.serverTimestamp(),
            });

            const snapshot = await docRef.get();
            const data = snapshot.data();

            expect(data?.pageViews).toBe(110);
            expect(data?.uniqueVisitors).toBe(53);
            expect(data?.metadata?.title).toBe('Analytics Dashboard');
            expect(data?.metadata?.lastUpdated).toBeInstanceOf(Timestamp);
            expect(data?.lastModified).toBeInstanceOf(Timestamp);
        });
    });

    describe('Deep merge operations', () => {
        it('should deep merge nested objects with set merge', async () => {
            const docRef = db.collection('settings').doc('user-settings');

            // Initial data with nested structure
            await docRef.set({
                preferences: {
                    theme: 'dark',
                    notifications: {
                        email: true,
                        push: false,
                    },
                },
                profile: {
                    name: 'John',
                },
            });

            // Merge update that only changes one nested field
            await docRef.set(
                {
                    preferences: {
                        notifications: {
                            push: true,
                        },
                    },
                },
                { merge: true },
            );

            const snapshot = await docRef.get();
            const data = snapshot.data();

            // Deep merge should preserve theme and email, only update push
            expect(data?.preferences?.theme).toBe('dark');
            expect(data?.preferences?.notifications?.email).toBe(true);
            expect(data?.preferences?.notifications?.push).toBe(true);
            expect(data?.profile?.name).toBe('John');
        });

        it('should deep merge preserving sibling nested objects', async () => {
            const docRef = db.collection('notifications').doc('user-1');

            // Initial data with multiple groups
            await docRef.set({
                changeVersion: 0,
                groups: {
                    'group-1': {
                        lastTransactionChange: '2024-01-01T00:00:00.000Z',
                        transactionChangeCount: 5,
                    },
                    'group-2': {
                        lastBalanceChange: '2024-01-02T00:00:00.000Z',
                        balanceChangeCount: 10,
                    },
                },
            });

            // Merge update for only group-1
            await docRef.set(
                {
                    groups: {
                        'group-1': {
                            lastTransactionChange: '2024-01-03T00:00:00.000Z',
                            transactionChangeCount: 6,
                        },
                    },
                },
                { merge: true },
            );

            const snapshot = await docRef.get();
            const data = snapshot.data();

            // group-2 should be completely preserved
            expect(data?.groups?.['group-2']?.lastBalanceChange).toBe('2024-01-02T00:00:00.000Z');
            expect(data?.groups?.['group-2']?.balanceChangeCount).toBe(10);

            // group-1 should be updated
            expect(data?.groups?.['group-1']?.lastTransactionChange).toBe('2024-01-03T00:00:00.000Z');
            expect(data?.groups?.['group-1']?.transactionChangeCount).toBe(6);
        });

        it('should deep merge with FieldValue.increment() in nested objects', async () => {
            const docRef = db.collection('notifications').doc('user-1');

            await docRef.set({
                changeVersion: 0,
                groups: {
                    'group-1': {
                        lastTransactionChange: '2024-01-01T00:00:00.000Z',
                        transactionChangeCount: 5,
                        balanceChangeCount: 3,
                    },
                },
            });

            // Merge update with increment
            await docRef.set(
                {
                    changeVersion: FieldValue.increment(1),
                    groups: {
                        'group-1': {
                            lastTransactionChange: '2024-01-03T00:00:00.000Z',
                            transactionChangeCount: FieldValue.increment(1),
                        },
                    },
                },
                { merge: true },
            );

            const snapshot = await docRef.get();
            const data = snapshot.data();

            expect(data?.changeVersion).toBe(1);
            expect(data?.groups?.['group-1']?.transactionChangeCount).toBe(6);
            expect(data?.groups?.['group-1']?.balanceChangeCount).toBe(3); // Preserved
            expect(data?.groups?.['group-1']?.lastTransactionChange).toBe('2024-01-03T00:00:00.000Z');
        });

        it('should deep merge new nested keys without removing existing ones', async () => {
            const docRef = db.collection('settings').doc('app-config');

            await docRef.set({
                features: {
                    darkMode: true,
                    notifications: true,
                },
            });

            // Add new feature without removing existing ones
            await docRef.set(
                {
                    features: {
                        analytics: false,
                    },
                },
                { merge: true },
            );

            const snapshot = await docRef.get();
            const data = snapshot.data();

            expect(data?.features?.darkMode).toBe(true);
            expect(data?.features?.notifications).toBe(true);
            expect(data?.features?.analytics).toBe(false);
        });

        it('should handle three levels of nesting with deep merge', async () => {
            const docRef = db.collection('config').doc('settings');

            await docRef.set({
                level1: {
                    level2: {
                        level3: {
                            value1: 'original',
                            value2: 'original',
                        },
                        otherValue: 'preserved',
                    },
                },
            });

            await docRef.set(
                {
                    level1: {
                        level2: {
                            level3: {
                                value1: 'updated',
                            },
                        },
                    },
                },
                { merge: true },
            );

            const snapshot = await docRef.get();
            const data = snapshot.data();

            expect(data?.level1?.level2?.level3?.value1).toBe('updated');
            expect(data?.level1?.level2?.level3?.value2).toBe('original');
            expect(data?.level1?.level2?.otherValue).toBe('preserved');
        });

        it('should handle arrays as replacement not merge', async () => {
            const docRef = db.collection('data').doc('arrays');

            await docRef.set({
                items: [1, 2, 3],
                metadata: {
                    tags: ['tag1', 'tag2'],
                },
            });

            await docRef.set(
                {
                    metadata: {
                        tags: ['tag3', 'tag4', 'tag5'],
                    },
                },
                { merge: true },
            );

            const snapshot = await docRef.get();
            const data = snapshot.data();

            // Arrays should replace, not merge
            expect(data?.items).toEqual([1, 2, 3]);
            expect(data?.metadata?.tags).toEqual(['tag3', 'tag4', 'tag5']);
        });

        it('should handle null values in deep merge', async () => {
            const docRef = db.collection('data').doc('nulls');

            await docRef.set({
                obj: {
                    field1: 'value1',
                    field2: 'value2',
                },
            });

            await docRef.set(
                {
                    obj: {
                        field1: null,
                    },
                },
                { merge: true },
            );

            const snapshot = await docRef.get();
            const data = snapshot.data();

            expect(data?.obj?.field1).toBeNull();
            expect(data?.obj?.field2).toBe('value2');
        });
    });

    describe('FieldValue.delete() operations', () => {
        it('should delete field using FieldValue.delete() with dot notation', async () => {
            const docRef = db.collection('notifications').doc('user-1');

            await docRef.set({
                changeVersion: 5,
                groups: {
                    'group-1': {
                        transactionChangeCount: 10,
                    },
                    'group-2': {
                        balanceChangeCount: 5,
                    },
                },
            });

            // Delete group-1 using dot notation
            await docRef.update({
                'groups.group-1': FieldValue.delete(),
            });

            const snapshot = await docRef.get();
            const data = snapshot.data();

            expect(data?.groups?.['group-1']).toBeUndefined();
            expect(data?.groups?.['group-2']?.balanceChangeCount).toBe(5); // Preserved
            expect(data?.changeVersion).toBe(5); // Preserved
        });

        it('should delete multiple fields with FieldValue.delete()', async () => {
            const docRef = db.collection('data').doc('doc-1');

            await docRef.set({
                field1: 'value1',
                field2: 'value2',
                field3: 'value3',
                field4: 'value4',
            });

            await docRef.update({
                field2: FieldValue.delete(),
                field4: FieldValue.delete(),
            });

            const snapshot = await docRef.get();
            const data = snapshot.data();

            expect(data?.field1).toBe('value1');
            expect(data?.field2).toBeUndefined();
            expect(data?.field3).toBe('value3');
            expect(data?.field4).toBeUndefined();
        });

        it('should handle delete with increment in same update', async () => {
            const docRef = db.collection('notifications').doc('user-1');

            await docRef.set({
                changeVersion: 5,
                groups: {
                    'group-1': {
                        transactionChangeCount: 10,
                    },
                    'group-2': {
                        balanceChangeCount: 5,
                    },
                },
            });

            // Delete group-1 and increment changeVersion
            await docRef.update({
                'groups.group-1': FieldValue.delete(),
                changeVersion: FieldValue.increment(1),
            });

            const snapshot = await docRef.get();
            const data = snapshot.data();

            expect(data?.groups?.['group-1']).toBeUndefined();
            expect(data?.groups?.['group-2']).toBeDefined();
            expect(data?.changeVersion).toBe(6);
        });

        it('should delete nested field preserving siblings', async () => {
            const docRef = db.collection('settings').doc('user-1');

            await docRef.set({
                preferences: {
                    theme: 'dark',
                    notifications: {
                        email: true,
                        push: true,
                    },
                },
            });

            await docRef.update({
                'preferences.notifications.push': FieldValue.delete(),
            });

            const snapshot = await docRef.get();
            const data = snapshot.data();

            expect(data?.preferences?.theme).toBe('dark');
            expect(data?.preferences?.notifications?.email).toBe(true);
            expect(data?.preferences?.notifications?.push).toBeUndefined();
        });

        it('should handle delete on non-existent field gracefully', async () => {
            const docRef = db.collection('data').doc('doc-1');

            await docRef.set({
                field1: 'value1',
            });

            await docRef.update({
                'nonexistent.field': FieldValue.delete(),
            });

            const snapshot = await docRef.get();
            const data = snapshot.data();

            expect(data?.field1).toBe('value1');
            expect(data?.nonexistent).toBeUndefined();
        });

        it('should handle delete in batch operations', async () => {
            const batch = db.batch();

            const doc1 = db.collection('notifications').doc('user-1');
            const doc2 = db.collection('notifications').doc('user-2');

            await doc1.set({
                groups: {
                    'group-1': { count: 5 },
                    'group-2': { count: 10 },
                },
            });

            await doc2.set({
                groups: {
                    'group-1': { count: 3 },
                    'group-3': { count: 7 },
                },
            });

            batch.update(doc1, { 'groups.group-1': FieldValue.delete() });
            batch.update(doc2, { 'groups.group-3': FieldValue.delete() });

            await batch.commit();

            const snapshot1 = await doc1.get();
            const snapshot2 = await doc2.get();

            expect(snapshot1.data()?.groups?.['group-1']).toBeUndefined();
            expect(snapshot1.data()?.groups?.['group-2']).toBeDefined();

            expect(snapshot2.data()?.groups?.['group-1']).toBeDefined();
            expect(snapshot2.data()?.groups?.['group-3']).toBeUndefined();
        });

        it('should handle delete with serverTimestamp in same update', async () => {
            const docRef = db.collection('documents').doc('doc-1');

            await docRef.set({
                oldField: 'old value',
                content: 'document content',
            });

            await docRef.update({
                oldField: FieldValue.delete(),
                lastModified: FieldValue.serverTimestamp(),
            });

            const snapshot = await docRef.get();
            const data = snapshot.data();

            expect(data?.oldField).toBeUndefined();
            expect(data?.content).toBe('document content');
            expect(data?.lastModified).toBeInstanceOf(Timestamp);
        });
    });

    describe('Trigger simulation', () => {
        it('should invoke registered handlers for create, update, and delete', async () => {
            const events: Array<{ type: string; before?: any; after?: any; params: Record<string, string>; }> = [];

            db.registerTrigger('users/{userId}', {
                onCreate: (change) => {
                    events.push({
                        type: change.type,
                        after: change.after.data(),
                        params: change.params,
                    });
                },
                onUpdate: (change) => {
                    events.push({
                        type: change.type,
                        before: change.before.data(),
                        after: change.after.data(),
                        params: change.params,
                    });
                },
                onDelete: (change) => {
                    events.push({
                        type: change.type,
                        before: change.before.data(),
                        params: change.params,
                    });
                },
            });

            const docRef = db.collection('users').doc('user-42');

            await docRef.set({ name: 'Alice' });
            await docRef.update({ name: 'Alice Updated' });
            await docRef.delete();

            expect(events.map((event) => event.type)).toEqual(['create', 'update', 'delete']);
            expect(events[0].after).toEqual({ name: 'Alice' });
            expect(events[1].before).toEqual({ name: 'Alice' });
            expect(events[1].after).toEqual({ name: 'Alice Updated' });
            expect(events[2].before).toEqual({ name: 'Alice Updated' });
            expect(events[0].params).toEqual({ userId: 'user-42' });
        });

        it('should defer triggers until transaction commit', async () => {
            const updates: number[] = [];
            const docRef = db.collection('counters').doc('counter-1');

            await docRef.set({ count: 0 });

            db.registerTrigger('counters/{counterId}', {
                onUpdate: (change) => {
                    updates.push(change.after.data()?.count);
                },
            });

            await db.runTransaction(async (transaction) => {
                const snapshot = await transaction.get(docRef);
                const current = snapshot.data()?.count ?? 0;
                transaction.update(docRef, { count: current + 1 });

                expect(updates).toEqual([]);
            });

            expect(updates).toEqual([1]);

            await expect(
                db.runTransaction(async (transaction) => {
                    transaction.update(docRef, { count: 999 });
                    throw new Error('abort');
                }),
            )
                .rejects
                .toThrow('abort');

            expect(updates).toEqual([1]);

            const snapshot = await docRef.get();
            expect(snapshot.data()).toEqual({ count: 1 });
        });
    });

    describe('Realtime listeners', () => {
        it('should emit document snapshots on lifecycle changes', async () => {
            const docRef = db.collection('users').doc('user-1');
            const snapshots: Array<{ exists: boolean; data: any | undefined; }> = [];

            const unsubscribe = docRef.onSnapshot((snapshot) => {
                snapshots.push({ exists: snapshot.exists, data: snapshot.data() });
            });

            await waitForUpdates();

            await docRef.set({ name: 'Alice' });
            await waitForUpdates();

            await docRef.update({ age: 30 });
            await waitForUpdates();

            await docRef.delete();
            await waitForUpdates();

            unsubscribe();

            expect(snapshots).toHaveLength(4);
            expect(snapshots[0].exists).toBe(false);
            expect(snapshots[1].data).toEqual({ name: 'Alice' });
            expect(snapshots[2].data).toEqual({ name: 'Alice', age: 30 });
            expect(snapshots[3].exists).toBe(false);
        });

        it('should only notify document listeners after successful transaction commit', async () => {
            const docRef = db.collection('items').doc('item-1');
            await docRef.set({ value: 1 });

            const values: number[] = [];
            const unsubscribe = docRef.onSnapshot((snapshot) => {
                if (snapshot.exists) {
                    values.push(snapshot.data()?.value ?? 0);
                }
            });

            await waitForUpdates();

            await db.runTransaction(async (transaction) => {
                const snap = await transaction.get(docRef);
                const current = snap.data()?.value ?? 0;
                transaction.update(docRef, { value: current + 1 });
            });

            await waitForUpdates();

            expect(values).toEqual([1, 2]);

            unsubscribe();
        });

        it('should not notify document listeners when transaction rolls back', async () => {
            const docRef = db.collection('items').doc('item-2');
            await docRef.set({ value: 5 });

            const values: number[] = [];
            const unsubscribe = docRef.onSnapshot((snapshot) => {
                if (snapshot.exists) {
                    values.push(snapshot.data()?.value ?? 0);
                }
            });

            await waitForUpdates();

            await expect(db.runTransaction(async (transaction) => {
                const snap = await transaction.get(docRef);
                const current = snap.data()?.value ?? 0;
                transaction.update(docRef, { value: current + 10 });
                throw new Error('rollback');
            }))
                .rejects
                .toThrow('rollback');

            await waitForUpdates();

            expect(values).toEqual([5]);

            unsubscribe();
        });

        it('should emit query snapshots when matching documents change', async () => {
            const users = db.collection('users');
            await users.doc('user-1').set({ name: 'Alice', city: 'NYC' });
            await users.doc('user-2').set({ name: 'Bob', city: 'LA' });

            const snapshots: string[][] = [];
            const unsubscribe = users
                .where('city', '==', 'NYC')
                .onSnapshot((snapshot) => {
                    snapshots.push(snapshot.docs.map((doc) => doc.data().name));
                });

            await waitForUpdates();

            await users.doc('user-3').set({ name: 'Charlie', city: 'NYC' });
            await waitForUpdates();

            await users.doc('user-1').update({ city: 'LA' });
            await waitForUpdates();

            unsubscribe();

            expect(snapshots).toEqual([
                ['Alice'],
                ['Alice', 'Charlie'],
                ['Charlie'],
            ]);
        });
    });
});
