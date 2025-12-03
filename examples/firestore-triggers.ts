/**
 * Firestore triggers for testing Cloud Functions
 */

import { StubFirestoreDatabase } from 'ts-firebase-simulator';

async function main() {
    const db = new StubFirestoreDatabase();

    // Register a trigger on the users collection
    const unregister = db.registerTrigger('users/{userId}', {
        onCreate: async (change) => {
            console.log('Created:', change.path);
            console.log('Params:', change.params); // { userId: 'user-1' }
            console.log('Data:', change.after.data());
        },
        onUpdate: async (change) => {
            console.log('Updated:', change.path);
            console.log('Before:', change.before.data());
            console.log('After:', change.after.data());
        },
        onDelete: async (change) => {
            console.log('Deleted:', change.path);
            console.log('Was:', change.before.data());
        },
    });

    // These operations will fire the triggers
    await db.doc('users/user-1').set({ name: 'Alice' });
    await db.doc('users/user-1').update({ name: 'Alice Smith' });
    await db.doc('users/user-1').delete();

    // Cleanup
    unregister();
}

main().catch(console.error);
