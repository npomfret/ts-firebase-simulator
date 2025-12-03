/**
 * Ordering and limiting query results
 */

import { StubFirestoreDatabase } from 'ts-firebase-simulator';

async function main() {
    const db = new StubFirestoreDatabase();
    db.seed('products/p1', { name: 'Widget', price: 10 });
    db.seed('products/p2', { name: 'Gadget', price: 25 });
    db.seed('products/p3', { name: 'Gizmo', price: 15 });

    // Order by price ascending
    const byPriceAsc = await db.collection('products').orderBy('price', 'asc').get();
    console.log('By price (asc):', byPriceAsc.docs.map((d) => d.data().name));

    // Order by price descending
    const byPriceDesc = await db.collection('products').orderBy('price', 'desc').get();
    console.log('By price (desc):', byPriceDesc.docs.map((d) => d.data().name));

    // Top 2 most expensive
    const top2 = await db.collection('products').orderBy('price', 'desc').limit(2).get();
    console.log('Top 2:', top2.docs.map((d) => d.data().name));
}

main().catch(console.error);
