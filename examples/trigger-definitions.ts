/**
 * Defining triggers that work in both production and tests
 */

import {
    type FirestoreTriggerEvent,
    registerTriggerWithStub,
    StubFirestoreDatabase,
    toProdTrigger,
} from 'ts-firebase-simulator';

// Define a trigger
const userTrigger = toProdTrigger({
    name: 'onUserWrite',
    document: 'users/{userId}',
    operations: ['create', 'update'] as const,
    region: 'us-central1',
});

// Handler that works with both production and stub
async function handleUserWrite(event: FirestoreTriggerEvent) {
    const { userId } = event.params;
    const userData = event.data.after?.data();

    console.log(`User ${userId} was ${event.changeType}d`);
    console.log('Data:', userData);

    // Your business logic here...
}

async function main() {
    const db = new StubFirestoreDatabase();

    // Register for testing
    const unregister = registerTriggerWithStub(db, userTrigger, handleUserWrite);

    // Trigger fires automatically
    await db.doc('users/alice').set({ name: 'Alice', role: 'admin' });
    await db.doc('users/alice').update({ role: 'superadmin' });

    unregister();

    // In production, export the Cloud Function:
    // export const onUserWrite = userTrigger.createProdTrigger(handleUserWrite);
}

main().catch(console.error);
