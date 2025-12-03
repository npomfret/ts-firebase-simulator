#!/usr/bin/env npx tsx

/**
 * Deploy Firestore indexes to a Firebase project using the Firebase CLI.
 *
 * Usage:
 *   npm run indexes:deploy
 *
 * Requires:
 *   - service-account-key.json in package root (or GOOGLE_APPLICATION_CREDENTIALS env var)
 *   - firestore.indexes.json in package root
 *   - firebase.json in package root
 *   - Firebase CLI installed globally (npm install -g firebase-tools)
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ServiceAccount {
    project_id: string;
}

interface IndexField {
    fieldPath: string;
    order?: 'ASCENDING' | 'DESCENDING';
    arrayConfig?: 'CONTAINS';
}

interface IndexDefinition {
    collectionGroup: string;
    queryScope: 'COLLECTION' | 'COLLECTION_GROUP';
    fields: IndexField[];
}

interface IndexesFile {
    indexes: IndexDefinition[];
    fieldOverrides: unknown[];
}

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

function getIndexesPath(): string {
    const indexesPath = path.resolve(__dirname, '..', 'firestore.indexes.json');
    if (!fs.existsSync(indexesPath)) {
        throw new Error(`Indexes file not found: ${indexesPath}`);
    }
    return indexesPath;
}

async function deployIndexes(): Promise<void> {
    const serviceAccountPath = getServiceAccountPath();
    const serviceAccount: ServiceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    const projectId = serviceAccount.project_id;

    console.log(`Project: ${projectId}`);
    console.log(`Service account: ${serviceAccountPath}`);

    // Read and display indexes to deploy
    const indexesPath = getIndexesPath();
    const indexesFile: IndexesFile = JSON.parse(fs.readFileSync(indexesPath, 'utf8'));

    console.log(`\nIndexes to deploy (${indexesFile.indexes.length}):`);
    for (const index of indexesFile.indexes) {
        const fields = index.fields.map(f => `${f.fieldPath} ${f.order || f.arrayConfig || ''}`).join(', ');
        console.log(`  - ${index.collectionGroup} (${index.queryScope}): ${fields}`);
    }

    console.log('\nDeploying indexes via Firebase CLI...\n');

    // Deploy using Firebase CLI with service account authentication
    const packageRoot = path.resolve(__dirname, '..');
    const command = `firebase deploy --only firestore:indexes --project ${projectId}`;

    try {
        execSync(command, {
            cwd: packageRoot,
            stdio: 'inherit',
            env: {
                ...process.env,
                GOOGLE_APPLICATION_CREDENTIALS: serviceAccountPath,
            },
        });
        console.log('\n✅ Indexes deployed successfully!');
        console.log('Note: Index creation is asynchronous and may take a few minutes to complete.');
    } catch (error) {
        console.error('\n❌ Failed to deploy indexes.');
        console.error('Make sure Firebase CLI is installed: npm install -g firebase-tools');
        process.exit(1);
    }
}

deployIndexes().catch((error) => {
    console.error('Failed to deploy indexes:', error);
    process.exit(1);
});
