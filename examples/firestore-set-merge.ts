/**
 * Using set() with merge option
 */

import { type IFirestoreDatabase, StubFirestoreDatabase } from 'ts-firebase-simulator';

async function main() {
    const db: IFirestoreDatabase = new StubFirestoreDatabase();

    // Initial document
    await db.doc('users/user-1').set({
        name: 'Alice',
        email: 'alice@example.com',
    });

    // Merge: adds phone without removing existing fields
    await db.doc('users/user-1').set(
        { phone: '+1-555-0123' },
        { merge: true },
    );

    const doc = await db.doc('users/user-1').get();
    console.log('Merged:', doc.data());
    // Output: { name: 'Alice', email: 'alice@example.com', phone: '+1-555-0123' }
}

main().catch(console.error);
