/**
 * Atomic operations with transactions
 */

import { StubFirestoreDatabase } from 'ts-firebase-simulator';

async function main() {
    const db = new StubFirestoreDatabase();
    db.seed('accounts/acc-1', { balance: 100 });
    db.seed('accounts/acc-2', { balance: 50 });

    // Transfer money atomically
    await db.runTransaction(async (transaction) => {
        const fromRef = db.doc('accounts/acc-1');
        const toRef = db.doc('accounts/acc-2');

        const fromDoc = await transaction.get(fromRef);
        const toDoc = await transaction.get(toRef);

        const fromBalance = fromDoc.data().balance;
        const toBalance = toDoc.data().balance;
        const amount = 30;

        if (fromBalance < amount) {
            throw new Error('Insufficient funds');
        }

        transaction.update(fromRef, { balance: fromBalance - amount });
        transaction.update(toRef, { balance: toBalance + amount });
    });

    const acc1 = await db.doc('accounts/acc-1').get();
    const acc2 = await db.doc('accounts/acc-2').get();
    console.log('Account 1:', acc1.data().balance); // 70
    console.log('Account 2:', acc2.data().balance); // 80
}

main().catch(console.error);
