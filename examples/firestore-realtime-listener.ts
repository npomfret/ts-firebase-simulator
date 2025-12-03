/**
 * Real-time listeners with onSnapshot
 */

import { type IFirestoreDatabase, StubFirestoreDatabase } from 'ts-firebase-simulator';

async function main() {
    const db: IFirestoreDatabase = new StubFirestoreDatabase();

    // Listen to a single document
    const unsubscribeDoc = db.doc('users/user-1').onSnapshot((snapshot) => {
        if (snapshot.exists) {
            console.log('Document changed:', snapshot.data());
        } else {
            console.log('Document does not exist');
        }
    });

    // Listen to a query
    const unsubscribeQuery = db.collection('users')
        .where('status', '==', 'active')
        .onSnapshot((snapshot) => {
            console.log('Active users:', snapshot.docs.map((d) => d.data().name));
        });

    // Trigger updates
    await db.doc('users/user-1').set({ name: 'Alice', status: 'active' });
    await db.doc('users/user-2').set({ name: 'Bob', status: 'active' });
    await db.doc('users/user-1').update({ name: 'Alice Smith' });

    // Cleanup
    unsubscribeDoc();
    unsubscribeQuery();
}

main().catch(console.error);
