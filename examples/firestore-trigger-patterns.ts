/**
 * Trigger path patterns with wildcards
 */

import { StubFirestoreDatabase } from 'ts-firebase-simulator';

async function main() {
    const db = new StubFirestoreDatabase();

    // Pattern with multiple wildcards
    db.registerTrigger('users/{userId}/posts/{postId}', {
        onCreate: async (change) => {
            const { userId, postId } = change.params;
            console.log(`User ${userId} created post ${postId}`);
        },
    });

    // Nested subcollection pattern
    db.registerTrigger('organizations/{orgId}/teams/{teamId}/members/{memberId}', {
        onCreate: async (change) => {
            const { orgId, teamId, memberId } = change.params;
            console.log(`Member ${memberId} joined team ${teamId} in org ${orgId}`);
        },
    });

    // Trigger the handlers
    await db.doc('users/alice/posts/post-1').set({ title: 'Hello World' });
    await db.doc('organizations/acme/teams/engineering/members/bob').set({ role: 'developer' });
}

main().catch(console.error);
