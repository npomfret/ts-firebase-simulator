/**
 * Deleting documents from Firestore
 */

import { StubFirestoreDatabase } from 'ts-firebase-simulator';

async function main() {
    const db = new StubFirestoreDatabase();
    db.seed('users/user-1', { name: 'Alice' });

    // Verify exists
    let doc = await db.doc('users/user-1').get();
    console.log('Before delete:', doc.exists);

    // Delete
    await db.doc('users/user-1').delete();

    // Verify deleted
    doc = await db.doc('users/user-1').get();
    console.log('After delete:', doc.exists);
}

main().catch(console.error);
