/**
 * Integration Test: StubStorage vs Emulator vs Real Firebase Storage
 *
 * Verifies that StubStorage mirrors real Firebase Storage behaviour by
 * executing identical operations against all three implementations:
 * 1. Stub (in-memory) - always runs
 * 2. Emulator - runs when FIREBASE_STORAGE_EMULATOR_HOST is set
 * 3. Real Firebase - runs when service account is available
 *
 * Configuration:
 * - Stub: No configuration needed
 * - Emulator: Run `firebase emulators:start` or use `npm run test:with-emulator`
 * - Real: Place service-account-key.json in project root, and ensure Storage bucket exists
 */

import { type App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import * as fs from 'fs';
import * as path from 'path';
import { createStorage, type IStorage, type IStorageBucket, StubStorage } from 'ts-firebase-simulator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

type TestMode = 'stub' | 'emulator' | 'real';

function isEmulatorAvailable(): boolean {
    return !!process.env.FIREBASE_STORAGE_EMULATOR_HOST;
}

function getServiceAccountPath(): string | null {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        return process.env.GOOGLE_APPLICATION_CREDENTIALS;
    }
    const localPath = path.resolve(__dirname, '../../..', 'service-account-key.json');
    if (fs.existsSync(localPath)) {
        return localPath;
    }
    return null;
}

function isRealFirebaseAvailable(): boolean {
    return getServiceAccountPath() !== null;
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

function initializeFirebaseApp(appName: string, useEmulator: boolean): App {
    const existingApp = getApps().find((app) => app.name === appName);
    if (existingApp) return existingApp;

    if (useEmulator) {
        // For emulator, we just need a project ID - no credentials required
        return initializeApp({
            projectId: 'demo-test-project',
            storageBucket: 'demo-test-project.appspot.com',
        }, appName);
    } else {
        const serviceAccountPath = getServiceAccountPath();
        if (!serviceAccountPath) {
            throw new Error('No service account found for real Firebase');
        }
        const serviceAccount: ServiceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
        return initializeApp({
            credential: cert(serviceAccount as any),
            projectId: serviceAccount.project_id,
            storageBucket: getStorageBucket(serviceAccount.project_id),
        }, appName);
    }
}

function getStorageForMode(mode: 'emulator' | 'real'): ReturnType<typeof getStorage> {
    const appName = mode === 'emulator' ? 'storage-emulator-app' : 'storage-real-app';
    const app = initializeFirebaseApp(appName, mode === 'emulator');
    return getStorage(app);
}

describe('Storage Stub Compatibility - Integration Test', () => {
    let stubStorage: StubStorage;
    let stubBucket: IStorageBucket;
    let emulatorStorage: IStorage | null = null;
    let emulatorBucket: IStorageBucket | null = null;
    let realStorage: IStorage | null = null;
    let realBucket: IStorageBucket | null = null;
    const testPathPrefix = `compatibility-test-${Date.now()}`;

    // Track which modes are available
    const emulatorAvailable = isEmulatorAvailable();
    const realFirebaseAvailable = isRealFirebaseAvailable();

    beforeAll(() => {
        console.log(`Storage test modes: stub=yes, emulator=${emulatorAvailable ? 'yes' : 'no'}, real=${realFirebaseAvailable ? 'yes' : 'no'}`);

        if (emulatorAvailable) {
            emulatorStorage = createStorage(getStorageForMode('emulator'));
            emulatorBucket = emulatorStorage.bucket();
        }

        if (realFirebaseAvailable) {
            realStorage = createStorage(getStorageForMode('real'));
            realBucket = realStorage.bucket();
        }
    });

    beforeEach(() => {
        stubStorage = new StubStorage();
        stubBucket = stubStorage.bucket();
    });

    afterEach(async () => {
        stubStorage.clear();
    });

    afterAll(async () => {
        // Clean up test files from emulator and real storage
        const cleanups: Array<{ storage: ReturnType<typeof getStorage>; mode: string }> = [];

        if (emulatorAvailable) {
            cleanups.push({ storage: getStorageForMode('emulator'), mode: 'emulator' });
        }
        if (realFirebaseAvailable) {
            cleanups.push({ storage: getStorageForMode('real'), mode: 'real' });
        }

        for (const { storage } of cleanups) {
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
        }
    });

    async function testAllImplementations(
        testName: string,
        testFn: (bucket: IStorageBucket, mode: TestMode, storage: StubStorage | null) => Promise<void>,
    ) {
        // 1. Stub (always runs)
        await testFn(stubBucket, 'stub', stubStorage);

        // 2. Emulator (if available)
        if (emulatorBucket) {
            await testFn(emulatorBucket, 'emulator', null);
        }

        // 3. Real Firebase (if available)
        if (realBucket) {
            await testFn(realBucket, 'real', null);
        }
    }

    describe('Basic File Operations', () => {
        it('should save and retrieve files identically', async () => {
            await testAllImplementations('save file', async (bucket, mode, storage) => {
                const filePath = `${testPathPrefix}/test-file-${mode}.txt`;
                const content = 'Hello, World!';

                const file = bucket.file(filePath);
                await file.save(content);

                // For stub, use internal API; for emulator/real, use Firebase API
                if (mode === 'stub' && storage) {
                    const snapshot = storage.getFile(bucket.name, filePath);
                    expect(snapshot, `File exists (${mode})`).toBeDefined();
                    expect(snapshot?.content.toString(), `File content (${mode})`).toBe(content);
                } else {
                    const firebaseStorage = getStorageForMode(mode as 'emulator' | 'real');
                    const realFile = firebaseStorage.bucket().file(filePath);
                    const [downloaded] = await realFile.download();
                    expect(downloaded.toString(), `File content (${mode})`).toBe(content);
                }
            });
        });

        it('should save files with metadata identically', async () => {
            await testAllImplementations('save with metadata', async (bucket, mode, storage) => {
                const filePath = `${testPathPrefix}/metadata-file-${mode}.json`;
                const content = JSON.stringify({ test: 'data' });
                const metadata = {
                    contentType: 'application/json',
                    cacheControl: 'public, max-age=3600',
                };

                const file = bucket.file(filePath);
                await file.save(content, { metadata });

                if (mode === 'stub' && storage) {
                    const snapshot = storage.getFile(bucket.name, filePath);
                    expect(snapshot?.metadata?.contentType, `Content type (${mode})`).toBe('application/json');
                    expect(snapshot?.metadata?.cacheControl, `Cache control (${mode})`).toBe('public, max-age=3600');
                } else {
                    const firebaseStorage = getStorageForMode(mode as 'emulator' | 'real');
                    const realFile = firebaseStorage.bucket().file(filePath);
                    const [fileMetadata] = await realFile.getMetadata();
                    expect(fileMetadata.contentType, `Content type (${mode})`).toBe('application/json');
                    expect(fileMetadata.cacheControl, `Cache control (${mode})`).toBe('public, max-age=3600');
                }
            });
        });

        it('should delete files identically', async () => {
            await testAllImplementations('delete file', async (bucket, mode, storage) => {
                const filePath = `${testPathPrefix}/delete-file-${mode}.txt`;
                const content = 'To be deleted';

                const file = bucket.file(filePath);
                await file.save(content);
                await file.delete();

                if (mode === 'stub' && storage) {
                    const snapshot = storage.getFile(bucket.name, filePath);
                    expect(snapshot, `File deleted (${mode})`).toBeUndefined();
                } else {
                    const firebaseStorage = getStorageForMode(mode as 'emulator' | 'real');
                    const realFile = firebaseStorage.bucket().file(filePath);
                    const [exists] = await realFile.exists();
                    expect(exists, `File deleted (${mode})`).toBe(false);
                }
            });
        });

        it('should handle binary content identically', async () => {
            await testAllImplementations('binary content', async (bucket, mode, storage) => {
                const filePath = `${testPathPrefix}/binary-file-${mode}.bin`;
                const content = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);

                const file = bucket.file(filePath);
                await file.save(content);

                if (mode === 'stub' && storage) {
                    const snapshot = storage.getFile(bucket.name, filePath);
                    expect(Buffer.compare(snapshot!.content, content), `Binary content matches (${mode})`).toBe(0);
                } else {
                    const firebaseStorage = getStorageForMode(mode as 'emulator' | 'real');
                    const realFile = firebaseStorage.bucket().file(filePath);
                    const [downloaded] = await realFile.download();
                    expect(Buffer.compare(downloaded, content), `Binary content matches (${mode})`).toBe(0);
                }
            });
        });

        it('should overwrite existing files identically', async () => {
            await testAllImplementations('overwrite file', async (bucket, mode, storage) => {
                const filePath = `${testPathPrefix}/overwrite-file-${mode}.txt`;
                const originalContent = 'Original content';
                const newContent = 'New content';

                const file = bucket.file(filePath);
                await file.save(originalContent);
                await file.save(newContent);

                if (mode === 'stub' && storage) {
                    const snapshot = storage.getFile(bucket.name, filePath);
                    expect(snapshot?.content.toString(), `Overwritten content (${mode})`).toBe(newContent);
                } else {
                    const firebaseStorage = getStorageForMode(mode as 'emulator' | 'real');
                    const realFile = firebaseStorage.bucket().file(filePath);
                    const [downloaded] = await realFile.download();
                    expect(downloaded.toString(), `Overwritten content (${mode})`).toBe(newContent);
                }
            });
        });
    });

    describe('Path Handling', () => {
        it('should handle nested paths identically', async () => {
            await testAllImplementations('nested paths', async (bucket, mode, storage) => {
                const filePath = `${testPathPrefix}/nested/deep/path/file-${mode}.txt`;
                const content = 'Nested file content';

                const file = bucket.file(filePath);
                await file.save(content);

                if (mode === 'stub' && storage) {
                    const snapshot = storage.getFile(bucket.name, filePath);
                    expect(snapshot?.content.toString(), `Nested file content (${mode})`).toBe(content);
                } else {
                    const firebaseStorage = getStorageForMode(mode as 'emulator' | 'real');
                    const realFile = firebaseStorage.bucket().file(filePath);
                    const [downloaded] = await realFile.download();
                    expect(downloaded.toString(), `Nested file content (${mode})`).toBe(content);
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
            await testAllImplementations('bucket name', async (bucket, mode) => {
                expect(bucket.name, `Bucket name (${mode})`).toBeDefined();
                expect(typeof bucket.name, `Bucket name type (${mode})`).toBe('string');
                expect(bucket.name.length, `Bucket name not empty (${mode})`).toBeGreaterThan(0);
            });
        });

        it('should handle multiple files in same bucket', async () => {
            await testAllImplementations('multiple files', async (bucket, mode, storage) => {
                const files = [
                    { path: `${testPathPrefix}/multi-1-${mode}.txt`, content: 'File 1' },
                    { path: `${testPathPrefix}/multi-2-${mode}.txt`, content: 'File 2' },
                    { path: `${testPathPrefix}/multi-3-${mode}.txt`, content: 'File 3' },
                ];

                for (const { path: filePath, content } of files) {
                    await bucket.file(filePath).save(content);
                }

                // Verify all files exist
                for (const { path: filePath, content } of files) {
                    if (mode === 'stub' && storage) {
                        const snapshot = storage.getFile(bucket.name, filePath);
                        expect(snapshot?.content.toString(), `File ${filePath} content (${mode})`).toBe(content);
                    } else {
                        const firebaseStorage = getStorageForMode(mode as 'emulator' | 'real');
                        const realFile = firebaseStorage.bucket().file(filePath);
                        const [downloaded] = await realFile.download();
                        expect(downloaded.toString(), `File ${filePath} content (${mode})`).toBe(content);
                    }
                }
            });
        });
    });

    describe('Make Public', () => {
        it('should make files public without error', async () => {
            await testAllImplementations('make public', async (bucket, mode, storage) => {
                const filePath = `${testPathPrefix}/public-file-${mode}.txt`;
                const content = 'Public content';

                const file = bucket.file(filePath);
                await file.save(content);

                // makePublic should not throw
                await expect(file.makePublic()).resolves.not.toThrow();

                if (mode === 'stub' && storage) {
                    const snapshot = storage.getFile(bucket.name, filePath);
                    expect(snapshot?.public, `File marked public (${mode})`).toBe(true);
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
