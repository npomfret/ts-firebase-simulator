/**
 * Reading a single document from Firestore
 */

import { StubFirestoreDatabase } from 'ts-firebase-simulator';

async function main() {
    const db = new StubFirestoreDatabase();
    db.seed('users/user-1', { name: 'Alice', email: 'alice@example.com' });

    const doc = await db.doc('users/user-1').get();

    if (doc.exists) {
        console.log('ID:', doc.id);
        console.log('Path:', doc.ref.path);
        console.log('Data:', doc.data());
    } else {
        console.log('Document not found');
    }
}

main().catch(console.error);
