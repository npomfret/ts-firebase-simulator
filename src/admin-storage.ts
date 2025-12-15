import type { Bucket, File } from '@google-cloud/storage';
import type * as admin from 'firebase-admin';
import type { IStorage, IStorageBucket, IStorageFile, StorageFileContent, StorageFileMetadata, StorageSaveOptions } from './storage-types';
import { Readable } from 'node:stream';

class StorageWrapper implements IStorage {
    constructor(private readonly storage: admin.storage.Storage) {}

    bucket(name?: string): IStorageBucket {
        return new StorageBucketWrapper(this.storage.bucket(name));
    }
}

class StorageBucketWrapper implements IStorageBucket {
    constructor(private readonly bucket: Bucket) {}

    get name(): string {
        return this.bucket.name;
    }

    file(path: string): IStorageFile {
        return new StorageFileWrapper(this.bucket.file(path));
    }
}

class StorageFileWrapper implements IStorageFile {
    constructor(private readonly file: File) {}

    async save(data: StorageFileContent, options: StorageSaveOptions = {}): Promise<void> {
        await this.file.save(data, {
            metadata: options.metadata,
        });
    }

    async makePublic(): Promise<void> {
        await this.file.makePublic();
    }

    async delete(): Promise<void> {
        await this.file.delete();
    }

    async exists(): Promise<[boolean]> {
        return this.file.exists();
    }

    async getMetadata(): Promise<[StorageFileMetadata]> {
        const [metadataResponse] = await this.file.getMetadata();

        const transformedMetadata: StorageFileMetadata = {
            cacheControl: metadataResponse.cacheControl,
            contentType: metadataResponse.contentType,
            metadata: undefined,
        };

        if (metadataResponse.metadata) {
            transformedMetadata.metadata = Object.entries(metadataResponse.metadata).reduce((acc, [key, value]) => {
                acc[key] = String(value);
                return acc;
            }, {} as Record<string, string>);
        }

        return [transformedMetadata];
    }

    createReadStream(): Readable {
        return this.file.createReadStream();
    }
}

export function createStorage(storage: admin.storage.Storage): IStorage {
    return new StorageWrapper(storage);
}
