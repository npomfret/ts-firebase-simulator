/**
 * Seeding files for tests
 */

import { StubStorage } from 'ts-firebase-simulator';

async function main() {
    const storage = new StubStorage();

    // Seed files synchronously for test setup
    storage.seedFile('documents/report.pdf', Buffer.from('PDF content'), {
        metadata: { contentType: 'application/pdf' },
    });

    storage.seedFile('images/logo.png', Buffer.from('PNG data'), {
        metadata: { contentType: 'image/png' },
        public: true,
    });

    // Seed to a specific bucket
    storage.seedFile('data/backup.json', '{"key": "value"}', {
        bucket: 'backups-bucket',
        metadata: { contentType: 'application/json' },
    });

    // List all files
    const allFiles = storage.getAllFiles();
    allFiles.forEach((file, key) => {
        console.log(`${key}: ${file.size} bytes, public=${file.public}`);
    });

    // Clear all files
    storage.clear();
    console.log('After clear:', storage.getAllFiles().size, 'files');
}

main().catch(console.error);
