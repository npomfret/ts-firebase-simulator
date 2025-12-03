/**
 * Creating documents in Firestore
 */

import { type IFirestoreDatabase, StubFirestoreDatabase, Timestamp } from 'ts-firebase-simulator';

async function main() {
    const db: IFirestoreDatabase = new StubFirestoreDatabase();

    // Create with specific ID
    await db.doc('users/user-1').set({
        name: 'Alice',
        createdAt: Timestamp.now(),
    });

    // Create with auto-generated ID
    const ref = db.collection('users').doc();
    await ref.set({ name: 'Bob' });
    console.log('Generated ID:', ref.id);
}

main().catch(console.error);
