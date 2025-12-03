/**
 * Integration Test: StubStorage vs Real Firebase Storage
 *
 * Verifies that StubStorage mirrors real Firebase Storage behaviour by
 * executing identical operations against both implementations.
 *
 * Configuration:
 * - Place a service account JSON file at: service-account-key.json
 * - Or set GOOGLE_APPLICATION_CREDENTIALS environment variable
 * - The service account file is gitignored
 * - Your Firebase project must have a Storage bucket created
 */

import {
    createStorage,
    type IStorage,
    type IStorageBucket,
    StubStorage,
} from '@billsplit-wl/firebase-simulator';
import * as fs from 'fs';
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

function getServiceAccountPath(): string {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        return process.env.GOOGLE_APPLICATION_CREDENTIALS;
    }
    const localPath = path.resolve(__dirname, '../../..', 'service-account-key.json');
    if (fs.existsSync(localPath)) {
        return localPath;
    }
    throw new Error(
        'No service account found. Either:\n' +
        '  1. Place service-account-key.json in packages/firebase-simulator/\n' +
        '  2. Set GOOGLE_APPLICATION_CREDENTIALS environment variable',
    );
}

function getStorageBucket(projectId: string): string {
    if (process.env.FIREBASE_STORAGE_BUCKET) {
        return process.env.FIREBASE_STORAGE_BUCKET;
    }
    // Default to newer Firebase Storage bucket format
    return `${projectId}.firebasestorage.app`;
}

interface ServiceAccount {
    project_id: string;
}

let firebaseApp: App;
let serviceAccount: ServiceAccount;

function ensureFirebaseApp(): App {
    if (getApps().length === 0) {
        const serviceAccountPath = getServiceAccountPath();
        serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
        firebaseApp = initializeApp({
            credential: cert(serviceAccount as any),
            projectId: serviceAccount.project_id,
            storageBucket: getStorageBucket(serviceAccount.project_id),
        });
    }
    return firebaseApp ?? getApps()[0];
}

describe('Storage Stub Compatibility - Integration Test', () => {
    let realStorage: IStorage;
    let stubStorage: StubStorage;
    let realBucket: IStorageBucket;
    let stubBucket: IStorageBucket;
    const testPathPrefix = `compatibility-test-${Date.now()}`;

    beforeAll(() => {
        ensureFirebaseApp();
    });

    beforeEach(() => {
        const app = ensureFirebaseApp();
        realStorage = createStorage(getStorage(app));
        stubStorage = new StubStorage();

        realBucket = realStorage.bucket();
        stubBucket = stubStorage.bucket();
    });

    afterEach(async () => {
        stubStorage.clear();
    });

    afterAll(async () => {
        // Clean up test files from real storage
        const app = ensureFirebaseApp();
        const storage = getStorage(app);
        const bucket = storage.bucket();

        try {
            const [files] = await bucket.getFiles({ prefix: testPathPrefix });
            for (const file of files) {
                await file.delete().catch(() => {
                    // Ignore errors for files that don't exist
                });
            }
        } catch {
            // Ignore cleanup errors
        }
    });

    async function testBothImplementations(
        testName: string,
        testFn: (bucket: IStorageBucket, isStub: boolean) => Promise<void>,
    ) {
        await testFn(realBucket, false);
        await testFn(stubBucket, true);
    }

    describe('Basic File Operations', () => {
        it('should save and retrieve files identically', async () => {
            await testBothImplementations('save file', async (bucket, isStub) => {
                const filePath = `${testPathPrefix}/test-file-${isStub ? 'stub' : 'real'}.txt`;
                const content = 'Hello, World!';

                const file = bucket.file(filePath);
                await file.save(content);

                // For real storage, verify by downloading
                if (!isStub) {
                    const app = ensureFirebaseApp();
                    const storage = getStorage(app);
                    const realFile = storage.bucket().file(filePath);
                    const [downloaded] = await realFile.download();
                    expect(downloaded.toString(), `File content (real)`).toBe(content);
                } else {
                    // For stub, use internal API
                    const snapshot = stubStorage.getFile(stubBucket.name, filePath);
                    expect(snapshot, `File exists (stub)`).toBeDefined();
                    expect(snapshot?.content.toString(), `File content (stub)`).toBe(content);
                }
            });
        });

        it('should save files with metadata identically', async () => {
            await testBothImplementations('save with metadata', async (bucket, isStub) => {
                const filePath = `${testPathPrefix}/metadata-file-${isStub ? 'stub' : 'real'}.json`;
                const content = JSON.stringify({ test: 'data' });
                const metadata = {
                    contentType: 'application/json',
                    cacheControl: 'public, max-age=3600',
                };

                const file = bucket.file(filePath);
                await file.save(content, { metadata });

                if (!isStub) {
                    const app = ensureFirebaseApp();
                    const storage = getStorage(app);
                    const realFile = storage.bucket().file(filePath);
                    const [fileMetadata] = await realFile.getMetadata();
                    expect(fileMetadata.contentType, `Content type (real)`).toBe('application/json');
                    expect(fileMetadata.cacheControl, `Cache control (real)`).toBe('public, max-age=3600');
                } else {
                    const snapshot = stubStorage.getFile(stubBucket.name, filePath);
                    expect(snapshot?.metadata?.contentType, `Content type (stub)`).toBe('application/json');
                    expect(snapshot?.metadata?.cacheControl, `Cache control (stub)`).toBe('public, max-age=3600');
                }
            });
        });

        it('should delete files identically', async () => {
            await testBothImplementations('delete file', async (bucket, isStub) => {
                const filePath = `${testPathPrefix}/delete-file-${isStub ? 'stub' : 'real'}.txt`;
                const content = 'To be deleted';

                const file = bucket.file(filePath);
                await file.save(content);
                await file.delete();

                if (!isStub) {
                    const app = ensureFirebaseApp();
                    const storage = getStorage(app);
                    const realFile = storage.bucket().file(filePath);
                    const [exists] = await realFile.exists();
                    expect(exists, `File deleted (real)`).toBe(false);
                } else {
                    const snapshot = stubStorage.getFile(stubBucket.name, filePath);
                    expect(snapshot, `File deleted (stub)`).toBeUndefined();
                }
            });
        });

        it('should handle binary content identically', async () => {
            await testBothImplementations('binary content', async (bucket, isStub) => {
                const filePath = `${testPathPrefix}/binary-file-${isStub ? 'stub' : 'real'}.bin`;
                const content = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);

                const file = bucket.file(filePath);
                await file.save(content);

                if (!isStub) {
                    const app = ensureFirebaseApp();
                    const storage = getStorage(app);
                    const realFile = storage.bucket().file(filePath);
                    const [downloaded] = await realFile.download();
                    expect(Buffer.compare(downloaded, content), `Binary content matches (real)`).toBe(0);
                } else {
                    const snapshot = stubStorage.getFile(stubBucket.name, filePath);
                    expect(Buffer.compare(snapshot!.content, content), `Binary content matches (stub)`).toBe(0);
                }
            });
        });

        it('should overwrite existing files identically', async () => {
            await testBothImplementations('overwrite file', async (bucket, isStub) => {
                const filePath = `${testPathPrefix}/overwrite-file-${isStub ? 'stub' : 'real'}.txt`;
                const originalContent = 'Original content';
                const newContent = 'New content';

                const file = bucket.file(filePath);
                await file.save(originalContent);
                await file.save(newContent);

                if (!isStub) {
                    const app = ensureFirebaseApp();
                    const storage = getStorage(app);
                    const realFile = storage.bucket().file(filePath);
                    const [downloaded] = await realFile.download();
                    expect(downloaded.toString(), `Overwritten content (real)`).toBe(newContent);
                } else {
                    const snapshot = stubStorage.getFile(stubBucket.name, filePath);
                    expect(snapshot?.content.toString(), `Overwritten content (stub)`).toBe(newContent);
                }
            });
        });
    });

    describe('Path Handling', () => {
        it('should handle nested paths identically', async () => {
            await testBothImplementations('nested paths', async (bucket, isStub) => {
                const filePath = `${testPathPrefix}/nested/deep/path/file-${isStub ? 'stub' : 'real'}.txt`;
                const content = 'Nested file content';

                const file = bucket.file(filePath);
                await file.save(content);

                if (!isStub) {
                    const app = ensureFirebaseApp();
                    const storage = getStorage(app);
                    const realFile = storage.bucket().file(filePath);
                    const [downloaded] = await realFile.download();
                    expect(downloaded.toString(), `Nested file content (real)`).toBe(content);
                } else {
                    const snapshot = stubStorage.getFile(stubBucket.name, filePath);
                    expect(snapshot?.content.toString(), `Nested file content (stub)`).toBe(content);
                }
            });
        });

        it('should normalize leading slashes in stub', async () => {
            // Note: Real Firebase Storage does NOT normalize leading slashes - it treats them as different paths
            // The stub normalizes them for convenience. This test only verifies stub behavior.
            const pathWithSlash = `/${testPathPrefix}/slash-file-stub.txt`;
            const pathWithoutSlash = `${testPathPrefix}/slash-file-stub.txt`;
            const content = 'Slash test content';

            // Save with leading slash
            await stubBucket.file(pathWithSlash).save(content);

            // Stub normalizes leading slashes - both paths should resolve to same file
            const snapshot = stubStorage.getFile(stubBucket.name, pathWithoutSlash);
            expect(snapshot, `File exists after normalization (stub)`).toBeDefined();
            expect(snapshot?.content.toString()).toBe(content);
        });
    });

    describe('Bucket Operations', () => {
        it('should return correct bucket name', async () => {
            await testBothImplementations('bucket name', async (bucket, isStub) => {
                expect(bucket.name, `Bucket name (${isStub ? 'stub' : 'real'})`).toBeDefined();
                expect(typeof bucket.name, `Bucket name type (${isStub ? 'stub' : 'real'})`).toBe('string');
                expect(bucket.name.length, `Bucket name not empty (${isStub ? 'stub' : 'real'})`).toBeGreaterThan(0);
            });
        });

        it('should handle multiple files in same bucket', async () => {
            await testBothImplementations('multiple files', async (bucket, isStub) => {
                const files = [
                    { path: `${testPathPrefix}/multi-1-${isStub ? 'stub' : 'real'}.txt`, content: 'File 1' },
                    { path: `${testPathPrefix}/multi-2-${isStub ? 'stub' : 'real'}.txt`, content: 'File 2' },
                    { path: `${testPathPrefix}/multi-3-${isStub ? 'stub' : 'real'}.txt`, content: 'File 3' },
                ];

                for (const { path: filePath, content } of files) {
                    await bucket.file(filePath).save(content);
                }

                // Verify all files exist
                for (const { path: filePath, content } of files) {
                    if (!isStub) {
                        const app = ensureFirebaseApp();
                        const storage = getStorage(app);
                        const realFile = storage.bucket().file(filePath);
                        const [downloaded] = await realFile.download();
                        expect(downloaded.toString(), `File ${filePath} content (real)`).toBe(content);
                    } else {
                        const snapshot = stubStorage.getFile(stubBucket.name, filePath);
                        expect(snapshot?.content.toString(), `File ${filePath} content (stub)`).toBe(content);
                    }
                }
            });
        });
    });

    describe('Make Public', () => {
        it('should make files public without error', async () => {
            await testBothImplementations('make public', async (bucket, isStub) => {
                const filePath = `${testPathPrefix}/public-file-${isStub ? 'stub' : 'real'}.txt`;
                const content = 'Public content';

                const file = bucket.file(filePath);
                await file.save(content);

                // makePublic should not throw
                await expect(file.makePublic()).resolves.not.toThrow();

                if (isStub) {
                    const snapshot = stubStorage.getFile(stubBucket.name, filePath);
                    expect(snapshot?.public, `File marked public (stub)`).toBe(true);
                }
            });
        });
    });

    describe('Stub-Specific Features', () => {
        it('should track file size correctly', async () => {
            const filePath = `${testPathPrefix}/size-test.txt`;
            const content = 'Hello, World!'; // 13 bytes

            await stubBucket.file(filePath).save(content);

            const snapshot = stubStorage.getFile(stubBucket.name, filePath);
            expect(snapshot?.size).toBe(13);
        });

        it('should track update timestamp', async () => {
            const filePath = `${testPathPrefix}/timestamp-test.txt`;
            const beforeSave = Date.now();

            await stubBucket.file(filePath).save('content');

            const snapshot = stubStorage.getFile(stubBucket.name, filePath);
            expect(snapshot?.updatedAtEpochMs).toBeGreaterThanOrEqual(beforeSave);
            expect(snapshot?.updatedAtEpochMs).toBeLessThanOrEqual(Date.now());
        });

        it('should list all files via getAllFiles()', async () => {
            const files = [
                { path: `${testPathPrefix}/list-1.txt`, content: 'File 1' },
                { path: `${testPathPrefix}/list-2.txt`, content: 'File 2' },
            ];

            for (const { path: filePath, content } of files) {
                await stubBucket.file(filePath).save(content);
            }

            const allFiles = stubStorage.getAllFiles();
            expect(allFiles.size).toBe(2);
        });

        it('should clear all files', async () => {
            await stubBucket.file(`${testPathPrefix}/clear-1.txt`).save('content 1');
            await stubBucket.file(`${testPathPrefix}/clear-2.txt`).save('content 2');

            expect(stubStorage.getAllFiles().size).toBe(2);

            stubStorage.clear();

            expect(stubStorage.getAllFiles().size).toBe(0);
        });

        it('should seed files via seedFile()', () => {
            const filePath = `${testPathPrefix}/seeded.txt`;
            const content = 'Seeded content';

            stubStorage.seedFile(filePath, content, {
                metadata: { contentType: 'text/plain' },
                public: true,
            });

            const snapshot = stubStorage.getFile(stubStorage.bucket().name, filePath);
            expect(snapshot?.content.toString()).toBe(content);
            expect(snapshot?.metadata?.contentType).toBe('text/plain');
            expect(snapshot?.public).toBe(true);
        });
    });
});
