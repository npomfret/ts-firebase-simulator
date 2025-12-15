import type { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';

export type StorageFileContent = string | Buffer | Uint8Array;

export interface StorageFileMetadata {
    cacheControl?: string;
    contentType?: string;
    metadata?: Record<string, string>;
    size?: number;
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
    getFiles(options?: { prefix?: string }): Promise<[IStorageFile[]]>;
}

export interface IStorageFile {
    readonly name: string;
    save(data: StorageFileContent, options?: StorageSaveOptions): Promise<void>;
    makePublic(): Promise<void>;
    delete(): Promise<void>;
    exists(): Promise<[boolean]>;
    getMetadata(): Promise<[StorageFileMetadata]>;
    createReadStream(): Readable;
}
