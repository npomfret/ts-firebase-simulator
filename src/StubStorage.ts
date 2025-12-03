import { Buffer } from 'node:buffer';
import type { IStorage, IStorageBucket, IStorageFile, StorageFileContent, StorageFileMetadata, StorageSaveOptions } from './storage-types';

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
