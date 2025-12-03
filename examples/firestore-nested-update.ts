/**
 * Updating nested fields with dot notation
 */

import { StubFirestoreDatabase } from 'ts-firebase-simulator';

async function main() {
    const db = new StubFirestoreDatabase();
    db.seed('users/user-1', {
        name: 'Alice',
        profile: {
            bio: 'Developer',
            location: 'NYC',
        },
    });

    // Update nested field without affecting siblings
    await db.doc('users/user-1').update({
        'profile.location': 'San Francisco',
    });

    const doc = await db.doc('users/user-1').get();
    console.log('Updated:', doc.data());
    // profile.bio is preserved, only location changed
}

main().catch(console.error);
