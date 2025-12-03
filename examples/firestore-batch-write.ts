/**
 * Batch writes for multiple documents
 */

import { type IFirestoreDatabase, StubFirestoreDatabase } from 'ts-firebase-simulator';

async function main() {
    const db: IFirestoreDatabase = new StubFirestoreDatabase();

    // Create multiple documents atomically
    const batch = db.batch();

    batch.set(db.doc('users/u1'), { name: 'Alice' });
    batch.set(db.doc('users/u2'), { name: 'Bob' });
    batch.set(db.doc('users/u3'), { name: 'Charlie' });

    await batch.commit();

    const users = await db.collection('users').get();
    console.log('Created users:', users.docs.map((d) => d.data().name));

    // Update and delete in a batch
    const batch2 = db.batch();
    batch2.update(db.doc('users/u1'), { name: 'Alice Smith' });
    batch2.delete(db.doc('users/u3'));
    await batch2.commit();

    const remaining = await db.collection('users').get();
    console.log('Remaining:', remaining.docs.map((d) => d.data().name));
}

main().catch(console.error);
