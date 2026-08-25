import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import type { GetSignedUrlConfig, IStorage, IStorageBucket, IStorageFile, StorageFileContent, StorageFileMetadata, StorageSaveOptions } from './storage-types';

export interface SeedFileOptions extends StorageSaveOptions {
    bucket?: string;
    public?: boolean;
}

export interface StoredFileSnapshot {
    bucket: string;
    path: string;
    content: Buffer;
    metadata?: StorageFileMetadata;
    public: boolean;
    size: number;
    updatedAtEpochMs: number;
}

interface StoredFileRecord extends StoredFileSnapshot {
    key: string;
}

export interface StubStorageOptions {
    defaultBucketName?: string;
}

export class StubStorage implements IStorage {
    private readonly defaultBucketName: string;
    private readonly buckets = new Map<string, StubStorageBucket>();
    private readonly files = new Map<string, StoredFileRecord>();

    constructor(options: StubStorageOptions = {}) {
        this.defaultBucketName = options.defaultBucketName ?? 'test-storage-bucket';
    }

    bucket(name?: string): StubStorageBucket {
        const bucketName = name ?? this.defaultBucketName;
        let bucket = this.buckets.get(bucketName);
        if (!bucket) {
            bucket = new StubStorageBucket(this, bucketName);
            this.buckets.set(bucketName, bucket);
        }
        return bucket;
    }

    seedFile(path: string, content: StorageFileContent, options: SeedFileOptions = {}): void {
        const bucketName = options.bucket ?? this.defaultBucketName;
        this.writeFile(bucketName, normalizePath(path), content, options.metadata, options.public ?? false);
    }

    clear(): void {
        this.files.clear();
    }

    getAllFiles(): Map<string, StoredFileSnapshot> {
        const result = new Map<string, StoredFileSnapshot>();
        for (const [key, record] of this.files) {
            result.set(key, cloneRecord(record));
        }
        return result;
    }

    getFiles(bucketName: string, options?: { prefix?: string; }): StoredFileSnapshot[] {
        const results: StoredFileSnapshot[] = [];
        for (const record of this.files.values()) {
            if (record.bucket === bucketName) {
                if (options?.prefix && !record.path.startsWith(options.prefix)) {
                    continue;
                }
                results.push(cloneRecord(record));
            }
        }
        return results;
    }

    getFile(bucketName: string, path: string): StoredFileSnapshot | undefined {
        const key = makeKey(bucketName, normalizePath(path));
        const record = this.files.get(key);
        if (!record) {
            return undefined;
        }
        return cloneRecord(record);
    }

    deleteFile(bucketName: string, path: string): void {
        const key = makeKey(bucketName, normalizePath(path));
        this.files.delete(key);
    }

    private writeFile(bucketName: string, path: string, content: StorageFileContent, metadata?: StorageFileMetadata, makePublic?: boolean): void {
        const key = makeKey(bucketName, path);
        const existing = this.files.get(key);
        const publicFlag = makePublic ?? existing?.public ?? false;
        const buffer = cloneBuffer(content);

        this.files.set(key, {
            key,
            bucket: bucketName,
            path,
            content: buffer,
            metadata: cloneMetadata(metadata),
            public: publicFlag,
            size: buffer.length,
            updatedAtEpochMs: Date.now(),
        });
    }

    private markPublic(bucketName: string, path: string): void {
        const key = makeKey(bucketName, path);
        const record = this.files.get(key);
        if (!record) {
            throw new Error(`File ${path} does not exist in bucket ${bucketName}`);
        }
        record.public = true;
        record.updatedAtEpochMs = Date.now();
    }

    // Internal hooks for bucket/file classes
    _writeFile(bucketName: string, path: string, content: StorageFileContent, metadata?: StorageFileMetadata): void {
        this.writeFile(bucketName, path, content, metadata);
    }

    _markPublic(bucketName: string, path: string): void {
        this.markPublic(bucketName, path);
    }
}

export class StubStorageBucket implements IStorageBucket {
    constructor(
        private readonly storage: StubStorage,
        private readonly bucketName: string,
    ) {}

    get name(): string {
        return this.bucketName;
    }

    file(path: string): StubStorageFile {
        return new StubStorageFile(this.storage, this, normalizePath(path));
    }

    async getFiles(options?: { prefix?: string; }): Promise<[StubStorageFile[]]> {
        const files = this.storage.getFiles(this.bucketName, options);
        return [files.map((f) => new StubStorageFile(this.storage, this, f.path))];
    }
}

export class StubStorageFile implements IStorageFile {
    constructor(
        private readonly storage: StubStorage,
        private readonly bucket: StubStorageBucket,
        private readonly path: string,
    ) {}

    get name(): string {
        return this.path;
    }

    async save(data: StorageFileContent, options: StorageSaveOptions = {}): Promise<void> {
        this.storage._writeFile(this.bucket.name, this.path, data, options.metadata);
    }

    async makePublic(): Promise<void> {
        this.storage._markPublic(this.bucket.name, this.path);
    }

    async delete(): Promise<void> {
        this.storage.deleteFile(this.bucket.name, this.path);
    }

    async exists(): Promise<[boolean]> {
        const record = this.storage.getFile(this.bucket.name, this.path);
        return [!!record];
    }

    async getMetadata(): Promise<[StorageFileMetadata]> {
        const record = this.storage.getFile(this.bucket.name, this.path);
        if (!record) {
            throw new Error(`File ${this.path} does not exist in bucket ${this.bucket.name}`);
        }
        return [
            {
                ...record.metadata,
                size: record.size,
            },
        ];
    }

    createReadStream(): Readable {
        const record = this.storage.getFile(this.bucket.name, this.path);
        if (!record) {
            throw new Error(`File ${this.path} does not exist in bucket ${this.bucket.name}`);
        }
        const stream = new Readable();
        stream.push(record.content);
        stream.push(null); // No more data
        return stream;
    }

    async getSignedUrl(config: GetSignedUrlConfig): Promise<[string]> {
        const record = this.storage.getFile(this.bucket.name, this.path);
        if (!record) {
            throw new Error(`File ${this.path} does not exist in bucket ${this.bucket.name}`);
        }

        // Generate a mock signed URL that looks realistic but doesn't require signing
        const bucket = this.bucket.name;
        const filePath = this.name;

        // Use config.expires to create a deterministic expiry timestamp
        const expiryMs = typeof config.expires === 'number'
            ? config.expires
            : typeof config.expires === 'string'
            ? new Date(config.expires).getTime()
            : config.expires.getTime();

        const now = Date.now();
        const expiresSeconds = Math.max(0, Math.floor((expiryMs - now) / 1000));

        // Create a mock signature (deterministic based on path + expiry + action)
        const signatureInput = `${bucket}/${filePath}/${expiryMs}/${config.action}`;
        const mockSignature = Buffer
            .from(signatureInput)
            .toString('base64')
            .replace(/[+/=]/g, ''); // URL-safe

        // Format the date for X-Goog-Date (current time in ISO 8601 basic format)
        const googDate = new Date(now).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

        // Return a mock URL that matches Google Cloud Storage signed URL format
        const mockUrl = [
            `https://storage.googleapis.com/${bucket}/${encodeURIComponent(filePath)}`,
            `?X-Goog-Algorithm=GOOG4-RSA-SHA256`,
            `&X-Goog-Credential=emulator-stub@test.iam.gserviceaccount.com/${googDate.slice(0, 8)}/auto/storage/goog4_request`,
            `&X-Goog-Date=${googDate}`,
            `&X-Goog-Expires=${expiresSeconds}`,
            `&X-Goog-SignedHeaders=host`,
            `&X-Goog-Signature=${mockSignature}`,
        ]
            .join('');

        return [mockUrl];
    }
}

function makeKey(bucketName: string, path: string): string {
    return `${bucketName}:${path}`;
}

function normalizePath(path: string): string {
    return path.replace(/^\/+/, '');
}

function cloneMetadata(metadata?: StorageFileMetadata): StorageFileMetadata | undefined {
    if (!metadata) {
        return undefined;
    }

    return {
        cacheControl: metadata.cacheControl,
        contentType: metadata.contentType,
        metadata: metadata.metadata ? { ...metadata.metadata } : undefined,
        size: metadata.size,
    };
}

function cloneRecord(record: StoredFileRecord): StoredFileSnapshot {
    return {
        bucket: record.bucket,
        path: record.path,
        content: Buffer.from(record.content),
        metadata: cloneMetadata(record.metadata),
        public: record.public,
        size: record.size,
        updatedAtEpochMs: record.updatedAtEpochMs,
    };
}

function cloneBuffer(data: StorageFileContent): Buffer {
    if (typeof data === 'string') {
        return Buffer.from(data, 'utf8');
    }

    if (Buffer.isBuffer(data)) {
        return Buffer.from(data);
    }

    if (data instanceof Uint8Array) {
        return Buffer.from(data);
    }

    throw new Error('Unsupported file content type');
}
