import { beforeEach, describe, expect, it } from 'vitest';
import { StubStorage } from '../../StubStorage';

describe('StubStorage', () => {
    let storage: StubStorage;

    beforeEach(() => {
        storage = new StubStorage({ defaultBucketName: 'default-test-bucket' });
    });

    it('saves files with metadata', async () => {
        const bucket = storage.bucket();
        await bucket.file('theme/output.css').save('body { color: #000; }', {
            metadata: {
                contentType: 'text/css',
                cacheControl: 'public, max-age=31536000',
                metadata: { tenantId: 'tenant-1' },
            },
        });

        const stored = storage.getFile('default-test-bucket', 'theme/output.css');
        expect(stored).toBeDefined();
        expect(stored?.content.toString('utf8')).toBe('body { color: #000; }');
        expect(stored?.metadata).toEqual({
            contentType: 'text/css',
            cacheControl: 'public, max-age=31536000',
            metadata: { tenantId: 'tenant-1' },
        });
        expect(stored?.public).toBe(false);
        expect(stored?.size).toBeGreaterThan(0);
    });

    it('marks files as public when makePublic is called', async () => {
        const file = storage.bucket().file('artifacts/tokens.json');

        await file.save('{"value": "test"}');
        await file.makePublic();

        const stored = storage.getFile('default-test-bucket', 'artifacts/tokens.json');
        expect(stored?.public).toBe(true);
    });

    it('allows seeding files for tests', () => {
        storage.seedFile('assets/logo.svg', '<svg></svg>', {
            bucket: 'tenant-bucket',
            public: true,
            metadata: {
                contentType: 'image/svg+xml',
            },
        });

        const stored = storage.getFile('tenant-bucket', 'assets/logo.svg');
        expect(stored).toBeDefined();
        expect(stored?.public).toBe(true);
        expect(stored?.metadata?.contentType).toBe('image/svg+xml');
    });

    it('tracks files per bucket', async () => {
        await storage.bucket().file('one.txt').save('default bucket');
        await storage.bucket('secondary').file('one.txt').save('secondary bucket');

        const files = storage.getAllFiles();
        expect(files.size).toBe(2);
        expect(storage.getFile('secondary', 'one.txt')?.content.toString('utf8')).toBe('secondary bucket');
    });

    it('normalizes leading slashes in paths', async () => {
        await storage.bucket().file('/nested/path/file.txt').save('data');

        const stored = storage.getFile('default-test-bucket', 'nested/path/file.txt');
        expect(stored).toBeDefined();
    });

    it('clears stored files', async () => {
        await storage.bucket().file('clear-me.txt').save('data');
        storage.clear();
        expect(storage.getAllFiles().size).toBe(0);
    });

    it('returns clones when reading stored files', async () => {
        await storage.bucket().file('immutable.txt').save('value');

        const snapshotA = storage.getFile('default-test-bucket', 'immutable.txt');
        const snapshotB = storage.getFile('default-test-bucket', 'immutable.txt');

        snapshotA?.content.fill(0);
        expect(snapshotB?.content.toString('utf8')).toBe('value');
    });

    describe('IStorageFile', () => {
        it('exists() returns true for an existing file', async () => {
            const file = storage.bucket().file('exists.txt');
            await file.save('some content');
            const [exists] = await file.exists();
            expect(exists).toBe(true);
        });

        it('exists() returns false for a non-existent file', async () => {
            const file = storage.bucket().file('non-existent.txt');
            const [exists] = await file.exists();
            expect(exists).toBe(false);
        });

        it('exists() returns false for a deleted file', async () => {
            const file = storage.bucket().file('deleted.txt');
            await file.save('some content');
            await file.delete();
            const [exists] = await file.exists();
            expect(exists).toBe(false);
        });

        it('getMetadata() returns metadata for an existing file', async () => {
            const file = storage.bucket().file('metadata.txt');
            await file.save('content', { metadata: { contentType: 'text/plain' } });
            const [metadata] = await file.getMetadata();
            expect(metadata).toEqual({ contentType: 'text/plain', size: 7 });
        });

        it('getMetadata() returns empty object if no metadata', async () => {
            const file = storage.bucket().file('no-metadata.txt');
            await file.save('content');
            const [metadata] = await file.getMetadata();
            expect(metadata).toEqual({ size: 7 });
        });

        it('getMetadata() returns the file size', async () => {
            const file = storage.bucket().file('size.txt');
            const content = '1234567890';
            await file.save(content);
            const [metadata] = await file.getMetadata();
            expect(metadata.size).toBe(content.length);
        });

        it('getMetadata() throws error for non-existent file', async () => {
            const file = storage.bucket().file('non-existent-metadata.txt');
            await expect(file.getMetadata()).rejects.toThrow('File non-existent-metadata.txt does not exist in bucket default-test-bucket');
        });

        it('createReadStream() returns a readable stream with correct content', async () => {
            const file = storage.bucket().file('stream.txt');
            const content = 'stream content';
            await file.save(content);

            const stream = file.createReadStream();
            let receivedContent = '';
            for await (const chunk of stream) {
                receivedContent += chunk.toString();
            }
            expect(receivedContent).toBe(content);
        });

        it('createReadStream() throws error for non-existent file', async () => {
            const file = storage.bucket().file('non-existent-stream.txt');
            expect(() => file.createReadStream()).toThrow('File non-existent-stream.txt does not exist in bucket default-test-bucket');
        });

        it('getSignedUrl() generates a signed URL for an existing file', async () => {
            const file = storage.bucket().file('signed.txt');
            await file.save('content');

            const [signedUrl] = await file.getSignedUrl({
                action: 'read',
                expires: Date.now() + 1000 * 60 * 60, // 1 hour from now
            });

            expect(signedUrl).toBeDefined();
            expect(typeof signedUrl).toBe('string');
            expect(signedUrl).toMatch(/^https:\/\/storage\.googleapis\.com/);
            expect(signedUrl).toContain('default-test-bucket');
            expect(signedUrl).toContain('signed.txt');
        });

        it('getSignedUrl() supports different actions', async () => {
            const file = storage.bucket().file('actions.txt');
            await file.save('content');

            const actions: Array<'read' | 'write' | 'delete' | 'resumable'> = ['read', 'write', 'delete', 'resumable'];
            for (const action of actions) {
                const [signedUrl] = await file.getSignedUrl({
                    action,
                    expires: Date.now() + 1000 * 60 * 60,
                });
                expect(signedUrl).toBeDefined();
                expect(typeof signedUrl).toBe('string');
            }
        });

        it('getSignedUrl() accepts Date object as expires', async () => {
            const file = storage.bucket().file('date-expires.txt');
            await file.save('content');

            const [signedUrl] = await file.getSignedUrl({
                action: 'read',
                expires: new Date(Date.now() + 1000 * 60 * 60),
            });

            expect(signedUrl).toBeDefined();
            expect(typeof signedUrl).toBe('string');
        });

        it('getSignedUrl() accepts string as expires', async () => {
            const file = storage.bucket().file('string-expires.txt');
            await file.save('content');

            const [signedUrl] = await file.getSignedUrl({
                action: 'read',
                expires: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
            });

            expect(signedUrl).toBeDefined();
            expect(typeof signedUrl).toBe('string');
        });

        it('getSignedUrl() throws error for non-existent file', async () => {
            const file = storage.bucket().file('non-existent-signed.txt');
            await expect(file.getSignedUrl({
                action: 'read',
                expires: Date.now() + 1000 * 60 * 60,
            })).rejects.toThrow('File non-existent-signed.txt does not exist in bucket default-test-bucket');
        });
    });

    describe('IStorageBucket', () => {
        it('getFiles() returns all files in the bucket', async () => {
            const bucket = storage.bucket();
            await bucket.file('one.txt').save('one');
            await bucket.file('two.txt').save('two');

            const [files] = await bucket.getFiles();
            expect(files).toHaveLength(2);

            const names = files.map((f) => f.name).sort();
            expect(names).toEqual(['one.txt', 'two.txt']);
        });
    });
});
