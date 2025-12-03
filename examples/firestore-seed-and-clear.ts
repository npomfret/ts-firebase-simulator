/**
 * Test helpers: seed() and clear()
 */

import { StubFirestoreDatabase } from 'ts-firebase-simulator';

async function main() {
    // In this example, use StubFirestoreDatabase directly (not the interface) to access test helper methods
    const db = new StubFirestoreDatabase();

    // seed() is synchronous - great for test setup
    db.seed('users/u1', { name: 'Alice', role: 'admin' });
    db.seed('users/u2', { name: 'Bob', role: 'user' });
    db.seed('settings/app', { theme: 'dark', version: '1.0' });

    console.log('After seeding:', db.getAllDocuments().size, 'documents');

    // getAllDocuments() returns all data - useful for assertions
    const allDocs = db.getAllDocuments();
    allDocs.forEach((data, path) => {
        console.log(`  ${path}:`, data);
    });

    // clear() removes all data - call in afterEach
    db.clear();
    console.log('After clear:', db.getAllDocuments().size, 'documents');
}

main().catch(console.error);
