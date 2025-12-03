/**
 * Querying with where() clauses
 */

import { StubFirestoreDatabase } from 'ts-firebase-simulator';

async function main() {
    const db = new StubFirestoreDatabase();
    db.seed('products/p1', { name: 'Widget', price: 10, category: 'tools' });
    db.seed('products/p2', { name: 'Gadget', price: 25, category: 'electronics' });
    db.seed('products/p3', { name: 'Gizmo', price: 15, category: 'tools' });

    // Equality
    const tools = await db.collection('products').where('category', '==', 'tools').get();
    console.log('Tools:', tools.docs.map((d) => d.data().name));

    // Comparison
    const expensive = await db.collection('products').where('price', '>', 12).get();
    console.log('Price > 12:', expensive.docs.map((d) => d.data().name));

    // Chained where clauses
    const cheapTools = await db.collection('products')
        .where('category', '==', 'tools')
        .where('price', '<', 12)
        .get();
    console.log('Cheap tools:', cheapTools.docs.map((d) => d.data().name));
}

main().catch(console.error);
