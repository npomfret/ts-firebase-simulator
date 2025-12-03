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
});
