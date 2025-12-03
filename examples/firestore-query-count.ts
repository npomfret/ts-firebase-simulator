/**
 * Counting documents with aggregation query
 */

import { StubFirestoreDatabase } from 'ts-firebase-simulator';

async function main() {
    const db = new StubFirestoreDatabase();
    db.seed('products/p1', { name: 'Widget', category: 'tools' });
    db.seed('products/p2', { name: 'Gadget', category: 'electronics' });
    db.seed('products/p3', { name: 'Gizmo', category: 'tools' });

    // Count all products
    const allCount = await db.collection('products').count().get();
    console.log('Total products:', allCount.data().count);

    // Count with filter
    const toolsCount = await db.collection('products')
        .where('category', '==', 'tools')
        .count()
        .get();
    console.log('Tools count:', toolsCount.data().count);
}

main().catch(console.error);
