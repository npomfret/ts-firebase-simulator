import type { Buffer } from 'node:buffer';

export type StorageFileContent = string | Buffer | Uint8Array;

export interface StorageFileMetadata {
    cacheControl?: string;
    contentType?: string;
    metadata?: Record<string, string>;
}

export interface StorageSaveOptions {
    metadata?: StorageFileMetadata;
}

export interface IStorage {
    bucket(name?: string): IStorageBucket;
}

export interface IStorageBucket {
    readonly name: string;
    file(path: string): IStorageFile;
}

export interface IStorageFile {
    save(data: StorageFileContent, options?: StorageSaveOptions): Promise<void>;
    makePublic(): Promise<void>;
    delete(): Promise<void>;
}
