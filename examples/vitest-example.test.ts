/**
 * Example Vitest test file
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { StubFirestoreDatabase } from 'ts-firebase-simulator';

describe('UserRepository', () => {
    // In this example, use StubFirestoreDatabase directly (not the interface) to access test helper methods like seed()
    let db: StubFirestoreDatabase;

    beforeEach(() => {
        db = new StubFirestoreDatabase();
    });

    it('should create a user', async () => {
        await db.doc('users/user-1').set({
            name: 'Alice',
            email: 'alice@example.com',
        });

        const doc = await db.doc('users/user-1').get();
        expect(doc.exists).toBe(true);
        expect(doc.data()).toEqual({
            name: 'Alice',
            email: 'alice@example.com',
        });
    });

    it('should query users by role', async () => {
        db.seed('users/u1', { name: 'Alice', role: 'admin' });
        db.seed('users/u2', { name: 'Bob', role: 'user' });
        db.seed('users/u3', { name: 'Charlie', role: 'admin' });

        const admins = await db.collection('users')
            .where('role', '==', 'admin')
            .get();

        expect(admins.size).toBe(2);
        expect(admins.docs.map((d) => d.data().name)).toContain('Alice');
        expect(admins.docs.map((d) => d.data().name)).toContain('Charlie');
    });

    it('should update user atomically', async () => {
        db.seed('users/user-1', { name: 'Alice', loginCount: 5 });

        await db.runTransaction(async (tx) => {
            const ref = db.doc('users/user-1');
            const doc = await tx.get(ref);
            const currentCount = doc.data().loginCount;
            tx.update(ref, { loginCount: currentCount + 1 });
        });

        const doc = await db.doc('users/user-1').get();
        expect(doc.data().loginCount).toBe(6);
    });
});
