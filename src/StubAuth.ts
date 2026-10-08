import type { CreateRequest, DecodedIdToken, GetUsersResult, ListUsersResult, SessionCookieOptions, UidIdentifier, UpdateRequest, UserInfo, UserMetadata, UserRecord } from 'firebase-admin/auth';
import { Buffer } from 'node:buffer';
import { createHmac, randomBytes, randomInt } from 'node:crypto';
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

export interface StubAuthOptions {
    /** The project tokens are issued for, as their audience and in their issuer. Defaults to 'test-project'. */
    projectId?: string;
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
    lastSignInAtMs: number;
    lastRefreshAtMs?: number;
    /** Whole seconds: tokens issued before it are revoked */
    validSinceSeconds?: number;
}

const USER_NOT_FOUND = ['auth/user-not-found', 'There is no user record corresponding to the provided identifier.'] as const;
const EMAIL_ALREADY_EXISTS = ['auth/email-already-exists', 'The email address is already in use by another account.'] as const;
const UID_ALREADY_EXISTS = ['auth/uid-already-exists', 'The user with the provided uid already exists.'] as const;
const USER_DISABLED = ['auth/user-disabled', 'The user record is disabled.'] as const;
const INVALID_SESSION_COOKIE_DURATION = ['auth/invalid-session-cookie-duration', 'The session cookie duration must be a valid number in milliseconds between 5 minutes and 2 weeks.'] as const;
const INVALID_ID_TOKEN = ['auth/invalid-id-token', 'The provided ID token is not a valid Firebase ID token.'] as const;
const ID_TOKEN_EXPIRED = ['auth/id-token-expired', 'The provided Firebase ID token is expired.'] as const;

const MAX_GET_USERS_IDENTIFIERS = 100;
const MAX_LIST_USERS_RESULTS = 1000;
const UID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ID_TOKEN_LIFETIME_SECONDS = 3600;
const CUSTOM_TOKEN_LIFETIME_SECONDS = 3600;
const MIN_SESSION_COOKIE_SECONDS = 5 * 60;
const MAX_SESSION_COOKIE_SECONDS = 14 * 24 * 60 * 60;
const CUSTOM_TOKEN_AUDIENCE = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';
/** The service account the emulator signs custom tokens as */
const CUSTOM_TOKEN_SIGNER = 'firebase-auth-emulator@example.com';

/** How the Admin SDK names, checks and refuses one kind of token */
interface TokenKind {
    jwtName: string;
    shortName: string;
    article: string;
    docsUrl: string;
    issuerPrefix: string;
    expiredCode: string;
    revoked: readonly [string, string];
}

const ID_TOKEN: TokenKind = {
    jwtName: 'Firebase ID token',
    shortName: 'ID token',
    article: 'an',
    docsUrl: 'https://firebase.google.com/docs/auth/admin/verify-id-tokens',
    issuerPrefix: 'https://securetoken.google.com/',
    expiredCode: 'auth/id-token-expired',
    revoked: ['auth/id-token-revoked', 'The Firebase ID token has been revoked.'],
};

const SESSION_COOKIE: TokenKind = {
    jwtName: 'Firebase session cookie',
    shortName: 'session cookie',
    article: 'a',
    docsUrl: 'https://firebase.google.com/docs/auth/admin/manage-cookies',
    issuerPrefix: 'https://session.firebase.google.com/',
    expiredCode: 'auth/session-cookie-expired',
    revoked: ['auth/session-cookie-revoked', 'The Firebase session cookie has been revoked.'],
};

/** The claims of an ID token or session cookie, as its JWT payload carries them */
type TokenClaims = Record<string, unknown> & { aud: string; iss: string; sub: string; auth_time: number; iat: number; exp: number; };

/**
 * In-memory implementation of Firebase Auth for testing, matching the Auth emulator's behaviour.
 * Its tokens are JWTs signed with a key of its own, so only tokens it issued verify.
 */
export class StubAuth implements IAuth {
    private readonly projectId: string;
    private readonly users = new Map<string, StoredUser>();
    private readonly failures = new Map<string, { remaining: number; error: Error; }>();
    /** Signs the stub's tokens, standing in for Google's keys: only tokens this stub issued verify */
    private readonly signingKey = randomBytes(32);
    /** How far the stub's clock is ahead of the real one, by what `advanceClock` added */
    private clockOffsetMs = 0;

    constructor(options: StubAuthOptions = {}) {
        this.projectId = options.projectId ?? 'test-project';
    }

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

    async createCustomToken(uid: string, developerClaims?: object): Promise<string> {
        // As Firebase: minted without looking the user up
        const issuedAt = this.nowSeconds();
        return this.mintJwt({
            aud: CUSTOM_TOKEN_AUDIENCE,
            iat: issuedAt,
            exp: issuedAt + CUSTOM_TOKEN_LIFETIME_SECONDS,
            iss: CUSTOM_TOKEN_SIGNER,
            sub: CUSTOM_TOKEN_SIGNER,
            uid,
            ...(developerClaims === undefined ? {} : { claims: developerClaims }),
        });
    }

    async verifyIdToken(idToken: string, checkRevoked = false): Promise<DecodedIdToken> {
        return this.verifyToken(idToken, ID_TOKEN, checkRevoked);
    }

    async createSessionCookie(idToken: string, sessionCookieOptions: SessionCookieOptions): Promise<string> {
        // As the Admin SDK: the duration is checked in whole seconds, rounded down
        const expiresIn = sessionCookieOptions?.expiresIn;
        const durationSeconds = typeof expiresIn === 'number' ? Math.floor(expiresIn / 1000) : NaN;
        if (!(durationSeconds >= MIN_SESSION_COOKIE_SECONDS && durationSeconds <= MAX_SESSION_COOKIE_SECONDS)) {
            throw new StubAuthError(...INVALID_SESSION_COOKIE_DURATION);
        }
        let claims: TokenClaims;
        try {
            claims = this.decodeToken(idToken, ID_TOKEN);
        } catch {
            throw new StubAuthError(...INVALID_ID_TOKEN);
        }
        const user = this.requireUser(claims.sub);
        if (user.disabled) {
            throw new StubAuthError(...USER_DISABLED);
        }
        // As Firebase: a revoked ID token is refused as expired
        if (this.nowSeconds() >= claims.exp || isRevoked(user, claims)) {
            throw new StubAuthError(...ID_TOKEN_EXPIRED);
        }
        // The cookie keeps the ID token's claims, auth_time included
        const issuedAt = this.nowSeconds();
        return this.mintJwt({ ...claims, iss: SESSION_COOKIE.issuerPrefix + this.projectId, iat: issuedAt, exp: issuedAt + durationSeconds });
    }

    async verifySessionCookie(sessionCookie: string, checkRevoked = false): Promise<DecodedIdToken> {
        return this.verifyToken(sessionCookie, SESSION_COOKIE, checkRevoked);
    }

    /**
     * As Firebase: tokens become valid from this second, so ID tokens and session cookies
     * signed in before it are revoked, and any signed in during it survive
     */
    async revokeRefreshTokens(uid: string): Promise<void> {
        const user = this.requireUser(uid);
        this.users.set(uid, { ...user, validSinceSeconds: this.nowSeconds() });
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

    /**
     * Signs a user in as a custom-token sign-in would, and returns its ID token: a missing
     * user is created, a disabled one refused, and the sign-in recorded in the user's metadata.
     */
    issueIdToken(uid: string): string {
        return this.signIn(uid, 'custom', {});
    }

    /**
     * Moves the stub's clock forward, for token expiry and revocation. Firebase compares a
     * token's sign-in second with the second its user's tokens were revoked, so a test that
     * revokes a token it has just issued advances the clock a second first.
     */
    advanceClock(ms: number): void {
        this.clockOffsetMs += ms;
    }

    /** Removes every user and pending failure. */
    clear(): void {
        this.users.clear();
        this.failures.clear();
    }

    private nowMs(): number {
        return Date.now() + this.clockOffsetMs;
    }

    private nowSeconds(): number {
        return toSeconds(this.nowMs());
    }

    private signIn(uid: string, signInProvider: string, developerClaims: object): string {
        const nowMs = this.nowMs();
        const existing = this.users.get(uid) ?? this.newUser(uid, {}, nowMs);
        if (existing.disabled) {
            throw new StubAuthError(...USER_DISABLED);
        }
        const user: StoredUser = { ...existing, lastSignInAtMs: nowMs, lastRefreshAtMs: nowMs };
        this.users.set(uid, user);
        return this.mintJwt(this.idTokenClaims(user, signInProvider, developerClaims, toSeconds(nowMs)));
    }

    /** An ID token's claims, as the emulator issues them */
    private idTokenClaims(user: StoredUser, signInProvider: string, developerClaims: object, signedInAt: number): TokenClaims {
        const identities: Record<string, string[]> = {};
        if (user.email !== undefined) {
            identities.email = [user.email];
        }
        if (user.phoneNumber !== undefined) {
            identities.phone = [user.phoneNumber];
        }
        return {
            ...(user.displayName === undefined ? {} : { name: user.displayName }),
            ...(user.photoURL === undefined ? {} : { picture: user.photoURL }),
            ...developerClaims,
            ...(user.email === undefined ? {} : { email: user.email }),
            email_verified: user.emailVerified,
            ...(user.phoneNumber === undefined ? {} : { phone_number: user.phoneNumber }),
            auth_time: signedInAt,
            user_id: user.uid,
            firebase: { identities, sign_in_provider: signInProvider },
            iat: signedInAt,
            exp: signedInAt + ID_TOKEN_LIFETIME_SECONDS,
            aud: this.projectId,
            iss: ID_TOKEN.issuerPrefix + this.projectId,
            sub: user.uid,
        };
    }

    private mintJwt(payload: object): string {
        const unsigned = `${encodeJwtPart({ alg: 'HS256', typ: 'JWT' })}.${encodeJwtPart(payload)}`;
        return `${unsigned}.${this.sign(unsigned)}`;
    }

    private sign(unsigned: string): string {
        return createHmac('sha256', this.signingKey).update(unsigned).digest('base64url');
    }

    /** As the Admin SDK: decodes, then checks the audience, issuer and signature, refusing with its messages */
    private decodeToken(token: string, kind: TokenKind): TokenClaims {
        const parts = typeof token === 'string' ? token.split('.') : [];
        const header = parts.length === 3 ? decodeJwtPart(parts[0]) : undefined;
        const claims = parts.length === 3 ? decodeJwtPart(parts[1]) : undefined;
        if (!header || !claims) {
            throw new StubAuthError(
                'auth/argument-error',
                `Decoding ${kind.jwtName} failed. Make sure you passed the entire string JWT which represents ${kind.article} ${kind.shortName}.${docsMessage(kind)}`,
            );
        }
        const projectMessage = ` Make sure the ${kind.shortName} comes from the same Firebase project as the service account used to authenticate this SDK.`;
        if (claims.aud !== this.projectId) {
            throw new StubAuthError(
                'auth/argument-error',
                `${kind.jwtName} has incorrect "aud" (audience) claim. Expected "${this.projectId}" but got "${claims.aud}".${projectMessage}${docsMessage(kind)}`,
            );
        }
        const issuer = kind.issuerPrefix + this.projectId;
        if (claims.iss !== issuer) {
            throw new StubAuthError('auth/argument-error', `${kind.jwtName} has incorrect "iss" (issuer) claim. Expected "${issuer}" but got "${claims.iss}".${projectMessage}${docsMessage(kind)}`);
        }
        if (parts[2] !== this.sign(`${parts[0]}.${parts[1]}`)) {
            throw new StubAuthError('auth/argument-error', `${kind.jwtName} has invalid signature.${docsMessage(kind)}`);
        }
        return claims as TokenClaims;
    }

    private verifyToken(token: string, kind: TokenKind, checkRevoked: boolean): DecodedIdToken {
        const claims = this.decodeToken(token, kind);
        if (this.nowSeconds() >= claims.exp) {
            throw new StubAuthError(
                kind.expiredCode,
                `${kind.jwtName} has expired. Get a fresh ${kind.shortName} from your client app and try again (${kind.expiredCode}).${docsMessage(kind)}`,
            );
        }
        // As the Admin SDK: the user is looked up only when checkRevoked is set (against the emulator, always)
        if (checkRevoked) {
            const user = this.requireUser(claims.sub);
            if (user.disabled) {
                throw new StubAuthError(...USER_DISABLED);
            }
            if (isRevoked(user, claims)) {
                throw new StubAuthError(...kind.revoked);
            }
        }
        return { ...claims, uid: claims.sub } as unknown as DecodedIdToken;
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
            // As the emulator: creating an account counts as its first sign-in
            lastSignInAtMs: createdAtMs,
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

function isRevoked(user: StoredUser, claims: TokenClaims): boolean {
    return user.validSinceSeconds !== undefined && claims.auth_time < user.validSinceSeconds;
}

function docsMessage(kind: TokenKind): string {
    return ` See ${kind.docsUrl} for details on how to retrieve ${kind.article} ${kind.shortName}.`;
}

function encodeJwtPart(value: object): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeJwtPart(part: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
        return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
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
    const metadataFields = {
        lastSignInTime: toUtcString(user.lastSignInAtMs),
        creationTime: toUtcString(user.createdAtMs),
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
