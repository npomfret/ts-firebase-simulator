#!/usr/bin/env npx tsx

/**
 * Wipe all test data from Firestore to allow re-seeding.
 *
 * Usage:
 *   npx tsx scripts/wipe-test-data.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ServiceAccount {
    project_id: string;
}

const TEST_COLLECTIONS = [
    'firebase-simulator-test',
    'firebase-simulator-test-pagination',
    'firebase-simulator-test-parents',
    'firebase-simulator-test-listener-queries',
];

function getServiceAccountPath(): string {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        return process.env.GOOGLE_APPLICATION_CREDENTIALS;
    }
    const localPath = path.resolve(__dirname, '..', 'service-account-key.json');
    if (fs.existsSync(localPath)) {
        return localPath;
    }
    throw new Error(
        'No service account found. Either:\n' +
        '  1. Place service-account-key.json in packages/firebase-simulator/\n' +
        '  2. Set GOOGLE_APPLICATION_CREDENTIALS environment variable',
    );
}

async function deleteCollection(db: FirebaseFirestore.Firestore, collectionPath: string): Promise<number> {
    const collectionRef = db.collection(collectionPath);
    const snapshot = await collectionRef.get();

    if (snapshot.empty) {
        return 0;
    }

    let deleted = 0;

    // Delete subcollections first
    for (const doc of snapshot.docs) {
        // Check for known subcollections
        for (const subcollection of ['items', 'members', 'children']) {
            const subSnapshot = await doc.ref.collection(subcollection).get();
            if (!subSnapshot.empty) {
                const batch = db.batch();
                subSnapshot.docs.forEach((subDoc) => batch.delete(subDoc.ref));
                await batch.commit();
                deleted += subSnapshot.size;
            }
        }
    }

    // Delete main documents in batches of 500
    const batchSize = 500;
    for (let i = 0; i < snapshot.docs.length; i += batchSize) {
        const batch = db.batch();
        const chunk = snapshot.docs.slice(i, i + batchSize);
        chunk.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
        deleted += chunk.length;
    }

    return deleted;
}

async function wipeTestData(): Promise<void> {
    const serviceAccountPath = getServiceAccountPath();
    const serviceAccount: ServiceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    const projectId = serviceAccount.project_id;

    console.log(`Project: ${projectId}`);

    if (getApps().length === 0) {
        initializeApp({
            credential: cert(serviceAccount as any),
            projectId,
        });
    }

    const db = getFirestore();
    console.log('Connected to Firestore\n');

    let totalDeleted = 0;

    for (const collection of TEST_COLLECTIONS) {
        process.stdout.write(`Deleting ${collection}... `);
        const count = await deleteCollection(db, collection);
        console.log(`${count} documents`);
        totalDeleted += count;
    }

    // Also delete any dynamic test collections (those with timestamps in the name)
    // This is a best-effort cleanup - we can't enumerate all collections easily
    console.log('\nNote: Dynamic test collections (with timestamps) are not automatically cleaned.');
    console.log('They will be cleaned by test afterEach hooks on next run.\n');

    console.log(`Total deleted: ${totalDeleted} documents`);
}

wipeTestData().catch((error) => {
    console.error('Failed to wipe test data:', error);
    process.exit(1);
});
