/**
 * Querying arrays with array-contains
 */

import { StubFirestoreDatabase } from 'ts-firebase-simulator';

async function main() {
    const db = new StubFirestoreDatabase();
    db.seed('posts/p1', { title: 'Hello', tags: ['intro', 'welcome'] });
    db.seed('posts/p2', { title: 'Tutorial', tags: ['guide', 'intro'] });
    db.seed('posts/p3', { title: 'Advanced', tags: ['guide', 'expert'] });

    // Find posts with 'intro' tag
    const introPosts = await db.collection('posts')
        .where('tags', 'array-contains', 'intro')
        .get();
    console.log('Intro posts:', introPosts.docs.map((d) => d.data().title));

    // Find posts with any of these tags
    const guidesOrIntros = await db.collection('posts')
        .where('tags', 'array-contains-any', ['intro', 'expert'])
        .get();
    console.log('Guides or intros:', guidesOrIntros.docs.map((d) => d.data().title));
}

main().catch(console.error);
