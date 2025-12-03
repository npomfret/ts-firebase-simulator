/**
 * Querying across subcollections with collectionGroup
 */

import { StubFirestoreDatabase } from 'ts-firebase-simulator';

async function main() {
    const db = new StubFirestoreDatabase();

    // Comments in different post subcollections
    db.seed('posts/post-1/comments/c1', { text: 'Great!', author: 'Alice' });
    db.seed('posts/post-1/comments/c2', { text: 'Thanks', author: 'Bob' });
    db.seed('posts/post-2/comments/c3', { text: 'Nice work', author: 'Alice' });

    // Query all comments across all posts
    const allComments = await db.collectionGroup('comments').get();
    console.log('All comments:', allComments.docs.map((d) => d.data().text));

    // Filter collection group
    const aliceComments = await db.collectionGroup('comments')
        .where('author', '==', 'Alice')
        .get();
    console.log('Alice comments:', aliceComments.docs.map((d) => d.data().text));
}

main().catch(console.error);
