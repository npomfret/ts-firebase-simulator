/**
 * Updating documents in Firestore
 */

import { FieldValue, StubFirestoreDatabase } from 'ts-firebase-simulator';

async function main() {
    const db = new StubFirestoreDatabase();
    db.seed('users/user-1', { name: 'Alice', score: 10 });

    // Partial update - only changes specified fields
    await db.doc('users/user-1').update({
        name: 'Alice Smith',
    });

    // Atomic increment
    await db.doc('users/user-1').update({
        score: FieldValue.increment(5),
    });

    // Server timestamp
    await db.doc('users/user-1').update({
        lastLogin: FieldValue.serverTimestamp(),
    });

    const doc = await db.doc('users/user-1').get();
    console.log('Updated:', doc.data());
}

main().catch(console.error);
