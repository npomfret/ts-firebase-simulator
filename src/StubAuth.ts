import type { CreateRequest, GetUsersResult, ListUsersResult, UidIdentifier, UpdateRequest, UserInfo, UserMetadata, UserRecord } from 'firebase-admin/auth';
import { randomInt } from 'node:crypto';
import type { IAuth } from './auth-types';

/**
 * Error thrown by StubAuth, carrying the `code` and `message` the real Admin SDK's
 * `FirebaseAuthError` would (`firebase-admin` does not export that class)
 */
export class StubAuthError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
        this.name = 'StubAuthError';
    }
}

/**
 * A user written straight into the stub: `createUser`'s properties, a required uid,
 * and optionally when the account was created
 */
export interface SeedUser extends CreateRequest {
    uid: string;
    creationTime?: Date;
}

/** The operations `failNext` can make fail */
export type FailableAuthOperation = 'getUser' | 'updateUser';

interface StoredUser {
    uid: string;
    email?: string;
    emailVerified: boolean;
    displayName?: string;
    photoURL?: string;
    phoneNumber?: string;
    disabled: boolean;
    password?: string;
    createdAtMs: number;
    lastRefreshAtMs?: number;
    /** Whole seconds: tokens issued before it are revoked */
    validSinceSeconds?: number;
}

const USER_NOT_FOUND = ['auth/user-not-found', 'There is no user record corresponding to the provided identifier.'] as const;
const EMAIL_ALREADY_EXISTS = ['auth/email-already-exists', 'The email address is already in use by another account.'] as const;
const UID_ALREADY_EXISTS = ['auth/uid-already-exists', 'The user with the provided uid already exists.'] as const;

const MAX_GET_USERS_IDENTIFIERS = 100;
const MAX_LIST_USERS_RESULTS = 1000;
const UID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * In-memory implementation of Firebase Auth for testing, matching the Auth emulator's behaviour
 */
export class StubAuth implements IAuth {
    private readonly users = new Map<string, StoredUser>();
    private readonly failures = new Map<string, { remaining: number; error: Error; }>();

    async createUser(properties: CreateRequest): Promise<UserRecord> {
        const uid = properties.uid ?? generateUid();
        if (this.users.has(uid)) {
            throw new StubAuthError(...UID_ALREADY_EXISTS);
        }
        const user = this.newUser(uid, properties, this.nowMs());
        this.assertEmailAvailable(user.email, uid);
        this.users.set(uid, user);
        return toUserRecord(user);
    }

    async getUser(uid: string): Promise<UserRecord> {
        this.throwIfFailing('getUser', uid);
        return toUserRecord(this.requireUser(uid));
    }

    getUsers(identifiers: UidIdentifier[]): Promise<GetUsersResult> {
        // As the Admin SDK: too many identifiers throws at the call, before any promise
        if (identifiers.length > MAX_GET_USERS_IDENTIFIERS) {
            throw new StubAuthError('auth/maximum-user-count-exceeded', '`identifiers` parameter must have <= 100 entries.');
        }
        return this.lookUpUsers(identifiers);
    }

    private async lookUpUsers(identifiers: UidIdentifier[]): Promise<GetUsersResult> {
        const users = new Map<string, UserRecord>();
        const notFound: UidIdentifier[] = [];
        for (const identifier of identifiers) {
            const user = this.users.get(identifier.uid);
            if (user) {
                users.set(user.uid, toUserRecord(user));
            } else {
                notFound.push({ uid: identifier.uid });
            }
        }
        return { users: [...users.values()], notFound };
    }

    async getUserByEmail(email: string): Promise<UserRecord> {
        const user = this.findByEmail(email);
        if (!user) {
            throw new StubAuthError(...USER_NOT_FOUND);
        }
        return toUserRecord(user);
    }

    async updateUser(uid: string, properties: UpdateRequest): Promise<UserRecord> {
        this.throwIfFailing('updateUser', uid);
        const existing = this.requireUser(uid);
        const email = properties.email === undefined ? existing.email : normalizeEmail(properties.email);
        this.assertEmailAvailable(email, uid);

        const nowMs = this.nowMs();
        const passwordChanged = properties.password !== undefined;
        const emailChanged = email !== existing.email;
        const updated: StoredUser = {
            ...existing,
            email,
            emailVerified: properties.emailVerified ?? existing.emailVerified,
            displayName: properties.displayName === null ? undefined : (properties.displayName ?? existing.displayName),
            photoURL: properties.photoURL === null ? undefined : (properties.photoURL ?? existing.photoURL),
            phoneNumber: properties.phoneNumber === null ? undefined : (properties.phoneNumber ?? existing.phoneNumber),
            disabled: properties.disabled ?? existing.disabled,
            password: properties.password ?? existing.password,
            // As the emulator: a new password refreshes the account, and a new password or email revokes earlier tokens
            lastRefreshAtMs: passwordChanged ? nowMs : existing.lastRefreshAtMs,
            validSinceSeconds: passwordChanged || emailChanged ? toSeconds(nowMs) : existing.validSinceSeconds,
        };
        this.users.set(uid, updated);
        return toUserRecord(updated);
    }

    async listUsers(maxResults: number = MAX_LIST_USERS_RESULTS, pageToken?: string): Promise<ListUsersResult> {
        if (!Number.isInteger(maxResults) || maxResults <= 0 || maxResults > MAX_LIST_USERS_RESULTS) {
            throw new StubAuthError('auth/argument-error', 'Required "maxResults" must be a positive integer that does not exceed 1000.');
        }
        // As the emulator: users in uid order, and the page token is the uid the next page starts after
        const page = [...this.users.values()]
            .sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))
            .filter((user) => pageToken === undefined || user.uid > pageToken)
            .slice(0, maxResults);
        const result: ListUsersResult = { users: page.map(toUserRecord) };
        if (page.length === maxResults) {
            result.pageToken = page[page.length - 1].uid;
        }
        return result;
    }

    async deleteUser(uid: string): Promise<void> {
        this.requireUser(uid);
        this.users.delete(uid);
    }

    // Test controls

    /**
     * Writes a user straight into the stub, replacing any user with the same uid.
     * An email that belongs to another user is refused, as `createUser` refuses it.
     */
    seedUser(user: SeedUser): UserRecord {
        const stored = this.newUser(user.uid, user, user.creationTime?.getTime() ?? this.nowMs());
        this.assertEmailAvailable(stored.email, user.uid);
        this.users.set(user.uid, stored);
        return toUserRecord(stored);
    }

    /** Makes the next `count` calls of `operation` for a user throw `error`, leaving the user unchanged. */
    failNext(operation: FailableAuthOperation, uid: string, count: number, error: Error): void {
        this.failures.set(failureKey(operation, uid), { remaining: count, error });
    }

    /** How many of the failures `failNext` set up for an operation and user are still to come. */
    remainingFailures(operation: FailableAuthOperation, uid: string): number {
        return this.failures.get(failureKey(operation, uid))?.remaining ?? 0;
    }

    /** Removes every user and pending failure. */
    clear(): void {
        this.users.clear();
        this.failures.clear();
    }

    private nowMs(): number {
        return Date.now();
    }

    private newUser(uid: string, properties: CreateRequest, createdAtMs: number): StoredUser {
        return {
            uid,
            email: properties.email === undefined ? undefined : normalizeEmail(properties.email),
            emailVerified: properties.emailVerified ?? false,
            displayName: properties.displayName ?? undefined,
            photoURL: properties.photoURL ?? undefined,
            phoneNumber: properties.phoneNumber ?? undefined,
            disabled: properties.disabled ?? false,
            password: properties.password,
            createdAtMs,
            // As the emulator: an account created with a password has its tokens valid from creation
            validSinceSeconds: properties.password === undefined ? undefined : toSeconds(createdAtMs),
        };
    }

    private requireUser(uid: string): StoredUser {
        const user = this.users.get(uid);
        if (!user) {
            throw new StubAuthError(...USER_NOT_FOUND);
        }
        return user;
    }

    private findByEmail(email: string): StoredUser | undefined {
        const normalized = normalizeEmail(email);
        return [...this.users.values()].find((user) => user.email === normalized);
    }

    private assertEmailAvailable(email: string | undefined, uid: string): void {
        const owner = email === undefined ? undefined : this.findByEmail(email);
        if (owner && owner.uid !== uid) {
            throw new StubAuthError(...EMAIL_ALREADY_EXISTS);
        }
    }

    private throwIfFailing(operation: FailableAuthOperation, uid: string): void {
        const failure = this.failures.get(failureKey(operation, uid));
        if (failure && failure.remaining > 0) {
            failure.remaining--;
            throw failure.error;
        }
    }
}

function failureKey(operation: FailableAuthOperation, uid: string): string {
    return `${operation}:${uid}`;
}

/** As Firebase: emails are stored, and matched, in lower case */
function normalizeEmail(email: string): string {
    return email.toLowerCase();
}

function toSeconds(ms: number): number {
    return Math.floor(ms / 1000);
}

/** A 28-character uid, the form Firebase generates */
function generateUid(): string {
    return Array.from({ length: 28 }, () => UID_ALPHABET[randomInt(UID_ALPHABET.length)]).join('');
}

/** Firebase's metadata times: UTC strings, to the second */
function toUtcString(ms: number): string {
    return new Date(toSeconds(ms) * 1000).toUTCString();
}

function toUserRecord(user: StoredUser): UserRecord {
    const createdAt = toUtcString(user.createdAtMs);
    const metadataFields = {
        // As the emulator: creating an account counts as its first sign-in
        lastSignInTime: createdAt,
        creationTime: createdAt,
        lastRefreshTime: user.lastRefreshAtMs === undefined ? null : toUtcString(user.lastRefreshAtMs),
    };
    const metadata: UserMetadata = { ...metadataFields, toJSON: () => ({ ...metadataFields }) };

    const providerData: UserInfo[] = [];
    if (user.email !== undefined && user.password !== undefined) {
        providerData.push(toUserInfo({ uid: user.email, displayName: user.displayName, email: user.email, photoURL: user.photoURL, providerId: 'password' }));
    }
    if (user.phoneNumber !== undefined) {
        providerData.push(toUserInfo({ uid: user.phoneNumber, providerId: 'phone', phoneNumber: user.phoneNumber }));
    }

    const fields = {
        uid: user.uid,
        email: user.email,
        emailVerified: user.emailVerified,
        displayName: user.displayName,
        photoURL: user.photoURL,
        phoneNumber: user.phoneNumber,
        disabled: user.disabled,
        tokensValidAfterTime: user.validSinceSeconds === undefined ? undefined : new Date(user.validSinceSeconds * 1000).toUTCString(),
        tenantId: undefined,
    };
    return {
        ...fields,
        metadata,
        providerData,
        toJSON: () => ({ ...fields, metadata: metadata.toJSON(), providerData: providerData.map((info) => info.toJSON()) }),
    };
}

function toUserInfo(fields: { uid: string; providerId: string; displayName?: string; email?: string; photoURL?: string; phoneNumber?: string; }): UserInfo {
    return { ...fields, toJSON: () => ({ ...fields }) } as UserInfo;
}
