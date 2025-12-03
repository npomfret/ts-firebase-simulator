/**
 * Querying with in and not-in operators
 */

import { StubFirestoreDatabase } from 'ts-firebase-simulator';

async function main() {
    const db = new StubFirestoreDatabase();
    db.seed('users/u1', { name: 'Alice', status: 'active' });
    db.seed('users/u2', { name: 'Bob', status: 'inactive' });
    db.seed('users/u3', { name: 'Charlie', status: 'pending' });

    // Find users with status in list
    const activeOrPending = await db.collection('users')
        .where('status', 'in', ['active', 'pending'])
        .get();
    console.log('Active or pending:', activeOrPending.docs.map((d) => d.data().name));

    // Find users with status not in list
    const notInactive = await db.collection('users')
        .where('status', 'not-in', ['inactive'])
        .get();
    console.log('Not inactive:', notInactive.docs.map((d) => d.data().name));
}

main().catch(console.error);
