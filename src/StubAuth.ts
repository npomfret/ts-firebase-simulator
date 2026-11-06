import type { CreateRequest, DecodedIdToken, GetUsersResult, ListUsersResult, SessionCookieOptions, UidIdentifier, UpdateRequest, UserInfo, UserMetadata, UserRecord } from 'firebase-admin/auth';
import { Buffer } from 'node:buffer';
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import {
    type ActionCodeRequestType,
    type IAuthClient,
    IdentityToolkitError,
    type ResetPasswordResponse,
    type SignInWithCustomTokenResponse,
    type SignInWithPasswordResponse,
    type UpdateAccountResponse,
} from './auth-client-types';
import type { IAuth, ITenantAwareAuth, ITenantManager } from './auth-types';

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

/** An action code (oobCode), held by the email it was issued for, as the emulator holds it */
interface ActionCode {
    requestType: ActionCodeRequestType;
    email: string;
    newEmail?: string;
}

const USER_NOT_FOUND = ['auth/user-not-found', 'There is no user record corresponding to the provided identifier.'] as const;
const EMAIL_ALREADY_EXISTS = ['auth/email-already-exists', 'The email address is already in use by another account.'] as const;
const UID_ALREADY_EXISTS = ['auth/uid-already-exists', 'The user with the provided uid already exists.'] as const;
const USER_DISABLED = ['auth/user-disabled', 'The user record is disabled.'] as const;
const INVALID_SESSION_COOKIE_DURATION = ['auth/invalid-session-cookie-duration', 'The session cookie duration must be a valid number in milliseconds between 5 minutes and 2 weeks.'] as const;
const INVALID_ID_TOKEN = ['auth/invalid-id-token', 'The provided ID token is not a valid Firebase ID token.'] as const;
const ID_TOKEN_EXPIRED = ['auth/id-token-expired', 'The provided Firebase ID token is expired.'] as const;
const EMAIL_NOT_FOUND = ['auth/email-not-found', 'There is no user record corresponding to the provided email.'] as const;
const INVALID_TENANT_ID = ['auth/invalid-tenant-id', 'The tenant ID must be a valid non-empty string.'] as const;
const MISMATCHING_TENANT_ID = ['auth/mismatching-tenant-id', 'User tenant ID does not match with the current TenantAwareAuth tenant ID.'] as const;

const INVALID_CUSTOM_TOKEN_FORMAT = 'INVALID_CUSTOM_TOKEN : Invalid assertion format';
const MIN_PASSWORD_LENGTH = 6;

/** The `mode` an action link carries for each kind of code */
const ACTION_LINK_MODES: Record<ActionCodeRequestType, string> = {
    PASSWORD_RESET: 'resetPassword',
    VERIFY_EMAIL: 'verifyEmail',
    VERIFY_AND_CHANGE_EMAIL: 'verifyAndChangeEmail',
};

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
type TokenClaims = Record<string, unknown> & { aud: string; iss: string; sub: string; auth_time: number; iat: number; exp: number; firebase?: { tenant?: unknown; [claim: string]: unknown; }; };

/**
 * One pool of accounts: the project's own, or one Identity Platform tenant's. Users, their
 * emails, action codes and pending failures belong to a pool and are never seen by another.
 */
/** Not exported from the package */
export class AuthPool {
    readonly users = new Map<string, StoredUser>();
    readonly actionCodes = new Map<string, ActionCode>();
    readonly failures = new Map<string, { remaining: number; error: Error; }>();

    /** `undefined` for the project's own pool */
    constructor(readonly tenantId: string | undefined) {}

    requireUser(uid: string): StoredUser {
        const user = this.users.get(uid);
        if (!user) {
            throw new StubAuthError(...USER_NOT_FOUND);
        }
        return user;
    }

    findByEmail(email: string): StoredUser | undefined {
        const normalized = normalizeEmail(email);
        return [...this.users.values()].find((user) => user.email === normalized);
    }

    assertEmailAvailable(email: string | undefined, uid: string): void {
        const owner = email === undefined ? undefined : this.findByEmail(email);
        if (owner && owner.uid !== uid) {
            throw new StubAuthError(...EMAIL_ALREADY_EXISTS);
        }
    }

    clear(): void {
        this.users.clear();
        this.actionCodes.clear();
        this.failures.clear();
    }
}

/**
 * What one simulator instance shares between its pools: the project, the key that signs its
 * tokens, its clock, and the pools themselves. The Identity Toolkit REST calls run here, since a
 * request names its pool with `tenantId` rather than reaching it through an Admin instance.
 */
/** Not exported from the package */
export class AuthAuthority {
    readonly rootPool = new AuthPool(undefined);
    /** As the emulator: a tenant's pool comes into being the first time the tenant is used */
    private readonly tenantPools = new Map<string, AuthPool>();
    /** Signs the stub's tokens, standing in for Google's keys: only tokens this simulator issued verify */
    private readonly signingKey = randomBytes(32);
    /** How far the clock is ahead of the real one, by what `advanceClock` added */
    private clockOffsetMs = 0;

    constructor(readonly projectId: string) {}

    pool(tenantId: string | undefined): AuthPool {
        // As the emulator: a request without a tenant ID (or with an empty one) reaches the project's own pool
        if (!tenantId) {
            return this.rootPool;
        }
        let pool = this.tenantPools.get(tenantId);
        if (!pool) {
            pool = new AuthPool(tenantId);
            this.tenantPools.set(tenantId, pool);
        }
        return pool;
    }

    advanceClock(ms: number): void {
        this.clockOffsetMs += ms;
    }

    clear(): void {
        this.rootPool.clear();
        for (const pool of this.tenantPools.values()) {
            pool.clear();
        }
    }

    nowMs(): number {
        return Date.now() + this.clockOffsetMs;
    }

    nowSeconds(): number {
        return toSeconds(this.nowMs());
    }

    /** As the emulator: an unknown email, then a disabled user, then a wrong or absent password is refused */
    signInWithPassword(request: { email: string; password: string; tenantId?: string; }): SignInWithPasswordResponse {
        const pool = this.pool(request.tenantId);
        const user = pool.findByEmail(request.email);
        if (!user) {
            throw new IdentityToolkitError(400, 'EMAIL_NOT_FOUND');
        }
        if (user.disabled) {
            throw new IdentityToolkitError(400, 'USER_DISABLED');
        }
        if (user.password === undefined || user.password !== request.password) {
            throw new IdentityToolkitError(400, 'INVALID_PASSWORD');
        }
        // As the emulator: tokens are returned whatever returnSecureToken asks for
        const idToken = this.signIn(pool, user.uid, 'password', {});
        return { localId: user.uid, email: user.email!, idToken, refreshToken: newRefreshToken(), expiresIn: String(ID_TOKEN_LIFETIME_SECONDS) };
    }

    /**
     * As the emulator: a request naming a tenant refuses a token not minted for that tenant
     * before anything else is checked
     */
    signInWithCustomToken(request: { token: string; tenantId?: string; }): SignInWithCustomTokenResponse {
        const pool = this.pool(request.tenantId);
        if (pool.tenantId !== undefined) {
            const parts = request.token.split('.');
            const payload = parts.length === 3 ? decodeJwtPart(parts[1]) : undefined;
            if (payload?.tenant_id !== pool.tenantId) {
                throw new IdentityToolkitError(400, 'TENANT_ID_MISMATCH');
            }
        }
        const { uid, claims } = this.decodeCustomToken(request.token);
        if (pool.users.get(uid)?.disabled) {
            throw new IdentityToolkitError(400, 'USER_DISABLED');
        }
        const idToken = this.signIn(pool, uid, 'custom', claims);
        return { idToken, refreshToken: newRefreshToken(), expiresIn: String(ID_TOKEN_LIFETIME_SECONDS) };
    }

    /**
     * As the emulator: a code is used up once it gets past its type and password checks, and
     * then acts on whichever user of its pool has the email it was issued for, if any does. A
     * disabled user is not refused.
     */
    resetPassword(request: { oobCode: string; newPassword?: string; tenantId?: string; }): ResetPasswordResponse {
        const pool = this.pool(request.tenantId);
        const actionCode = requireActionCode(pool, request.oobCode);
        // As the emulator: without a new password (or with an empty one) the code is only read
        if (request.newPassword) {
            if (actionCode.requestType !== 'PASSWORD_RESET') {
                throw new IdentityToolkitError(400, 'INVALID_OOB_CODE');
            }
            if (request.newPassword.length < MIN_PASSWORD_LENGTH) {
                throw new IdentityToolkitError(400, `WEAK_PASSWORD : Password should be at least ${MIN_PASSWORD_LENGTH} characters`);
            }
            const user = useActionCode(pool, request.oobCode, actionCode);
            // As the emulator: a reset verifies the email and revokes earlier tokens, without refreshing the account
            pool.users.set(user.uid, { ...user, password: request.newPassword, emailVerified: true, validSinceSeconds: this.nowSeconds() });
        }
        return { requestType: actionCode.requestType, email: actionCode.email, ...(actionCode.newEmail === undefined ? {} : { newEmail: actionCode.newEmail }) };
    }

    /** As the emulator: an email change neither revokes tokens nor needs the new email to be free until it is applied */
    applyActionCode(request: { oobCode: string; tenantId?: string; }): UpdateAccountResponse {
        const pool = this.pool(request.tenantId);
        const actionCode = requireActionCode(pool, request.oobCode);
        if (actionCode.requestType === 'PASSWORD_RESET') {
            // The emulator's answer: it does not implement this code type here
            throw new IdentityToolkitError(501, actionCode.requestType);
        }
        const user = useActionCode(pool, request.oobCode, actionCode);
        if (actionCode.newEmail !== undefined && pool.findByEmail(actionCode.newEmail)) {
            throw new IdentityToolkitError(400, 'EMAIL_EXISTS');
        }
        const updated: StoredUser = { ...user, email: actionCode.newEmail ?? user.email, emailVerified: true };
        pool.users.set(user.uid, updated);
        return { localId: updated.uid, email: updated.email!, emailVerified: updated.emailVerified };
    }

    /** A custom token's uid and developer claims, refused as the emulator refuses it, or for a signature not this simulator's */
    private decodeCustomToken(token: string): { uid: string; claims: object; } {
        const parts = token.split('.');
        const payload = parts.length === 3 && decodeJwtPart(parts[0]) ? decodeJwtPart(parts[1]) : undefined;
        if (!payload) {
            throw new IdentityToolkitError(400, INVALID_CUSTOM_TOKEN_FORMAT);
        }
        if (payload.aud !== CUSTOM_TOKEN_AUDIENCE) {
            throw new IdentityToolkitError(
                400,
                `INVALID_CUSTOM_TOKEN : ((Invalid aud (audience): ${String(payload.aud)} Note: Firebase ID Tokens / third-party tokens cannot be used with signInWithCustomToken.))`,
            );
        }
        if (parts[2] !== this.sign(`${parts[0]}.${parts[1]}`) || typeof payload.uid !== 'string') {
            throw new IdentityToolkitError(400, 'INVALID_CUSTOM_TOKEN');
        }
        return { uid: payload.uid, claims: (payload.claims as object | undefined) ?? {} };
    }

    /** Signs a user of the pool in, creating it if missing, and returns its ID token */
    signIn(pool: AuthPool, uid: string, signInProvider: string, developerClaims: object): string {
        const nowMs = this.nowMs();
        const existing = pool.users.get(uid) ?? newUser(uid, {}, nowMs);
        if (existing.disabled) {
            throw new StubAuthError(...USER_DISABLED);
        }
        const user: StoredUser = { ...existing, lastSignInAtMs: nowMs, lastRefreshAtMs: nowMs };
        pool.users.set(uid, user);
        return this.mintJwt(this.idTokenClaims(pool, user, signInProvider, developerClaims, toSeconds(nowMs)));
    }

    /** An ID token's claims, as the emulator issues them; a tenant's carry `firebase.tenant` */
    private idTokenClaims(pool: AuthPool, user: StoredUser, signInProvider: string, developerClaims: object, signedInAt: number): TokenClaims {
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
            firebase: { identities, sign_in_provider: signInProvider, ...(pool.tenantId === undefined ? {} : { tenant: pool.tenantId }) },
            iat: signedInAt,
            exp: signedInAt + ID_TOKEN_LIFETIME_SECONDS,
            aud: this.projectId,
            iss: ID_TOKEN.issuerPrefix + this.projectId,
            sub: user.uid,
        };
    }

    mintJwt(payload: object): string {
        const unsigned = `${encodeJwtPart({ alg: 'HS256', typ: 'JWT' })}.${encodeJwtPart(payload)}`;
        return `${unsigned}.${this.sign(unsigned)}`;
    }

    private sign(unsigned: string): string {
        return createHmac('sha256', this.signingKey).update(unsigned).digest('base64url');
    }

    /** As the Admin SDK: decodes, then checks the audience, issuer and signature, refusing with its messages */
    decodeToken(token: string, kind: TokenKind): TokenClaims {
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
}

/**
 * The Admin SDK operations over one pool. The project-level `StubAuth` and each
 * `StubTenantAwareAuth` are this over their own pool, sharing their simulator's tokens and clock.
 */
export abstract class StubPoolAuth implements IAuth {
    readonly #authority: AuthAuthority;
    readonly #pool: AuthPool;

    protected constructor(authority: AuthAuthority, pool: AuthPool) {
        this.#authority = authority;
        this.#pool = pool;
    }

    async createUser(properties: CreateRequest): Promise<UserRecord> {
        const uid = properties.uid ?? generateUid();
        if (this.#pool.users.has(uid)) {
            throw new StubAuthError(...UID_ALREADY_EXISTS);
        }
        const user = newUser(uid, properties, this.#authority.nowMs());
        this.#pool.assertEmailAvailable(user.email, uid);
        this.#pool.users.set(uid, user);
        return this.#toRecord(user);
    }

    async getUser(uid: string): Promise<UserRecord> {
        this.#throwIfFailing('getUser', uid);
        return this.#toRecord(this.#pool.requireUser(uid));
    }

    getUsers(identifiers: UidIdentifier[]): Promise<GetUsersResult> {
        // As the Admin SDK: too many identifiers throws at the call, before any promise
        if (identifiers.length > MAX_GET_USERS_IDENTIFIERS) {
            throw new StubAuthError('auth/maximum-user-count-exceeded', '`identifiers` parameter must have <= 100 entries.');
        }
        return this.#lookUpUsers(identifiers);
    }

    async #lookUpUsers(identifiers: UidIdentifier[]): Promise<GetUsersResult> {
        const users = new Map<string, UserRecord>();
        const notFound: UidIdentifier[] = [];
        for (const identifier of identifiers) {
            const user = this.#pool.users.get(identifier.uid);
            if (user) {
                users.set(user.uid, this.#toRecord(user));
            } else {
                notFound.push({ uid: identifier.uid });
            }
        }
        return { users: [...users.values()], notFound };
    }

    async getUserByEmail(email: string): Promise<UserRecord> {
        const user = this.#pool.findByEmail(email);
        if (!user) {
            throw new StubAuthError(...USER_NOT_FOUND);
        }
        return this.#toRecord(user);
    }

    async updateUser(uid: string, properties: UpdateRequest): Promise<UserRecord> {
        this.#throwIfFailing('updateUser', uid);
        const existing = this.#pool.requireUser(uid);
        const email = properties.email === undefined ? existing.email : normalizeEmail(properties.email);
        this.#pool.assertEmailAvailable(email, uid);

        const nowMs = this.#authority.nowMs();
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
        this.#pool.users.set(uid, updated);
        return this.#toRecord(updated);
    }

    async listUsers(maxResults: number = MAX_LIST_USERS_RESULTS, pageToken?: string): Promise<ListUsersResult> {
        if (!Number.isInteger(maxResults) || maxResults <= 0 || maxResults > MAX_LIST_USERS_RESULTS) {
            throw new StubAuthError('auth/argument-error', 'Required "maxResults" must be a positive integer that does not exceed 1000.');
        }
        // As the emulator: users in uid order, and the page token is the uid the next page starts after
        const page = [...this.#pool.users.values()]
            .sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))
            .filter((user) => pageToken === undefined || user.uid > pageToken)
            .slice(0, maxResults);
        const result: ListUsersResult = { users: page.map((user) => this.#toRecord(user)) };
        if (page.length === maxResults) {
            result.pageToken = page[page.length - 1].uid;
        }
        return result;
    }

    async deleteUser(uid: string): Promise<void> {
        this.#pool.requireUser(uid);
        this.#pool.users.delete(uid);
    }

    /** As the Admin SDK: a tenant's custom token carries its `tenant_id` */
    async createCustomToken(uid: string, developerClaims?: object): Promise<string> {
        // As Firebase: minted without looking the user up
        const issuedAt = this.#authority.nowSeconds();
        return this.#authority.mintJwt({
            aud: CUSTOM_TOKEN_AUDIENCE,
            iat: issuedAt,
            exp: issuedAt + CUSTOM_TOKEN_LIFETIME_SECONDS,
            iss: CUSTOM_TOKEN_SIGNER,
            sub: CUSTOM_TOKEN_SIGNER,
            uid,
            ...(this.#pool.tenantId === undefined ? {} : { tenant_id: this.#pool.tenantId }),
            ...(developerClaims === undefined ? {} : { claims: developerClaims }),
        });
    }

    async verifyIdToken(idToken: string, checkRevoked = false): Promise<DecodedIdToken> {
        return this.#verifyToken(idToken, ID_TOKEN, checkRevoked);
    }

    /**
     * As Firebase's backend: the cookie is made in the pool the ID token belongs to. As the
     * emulator routes it, a tenant's ID token reaches its tenant's pool even through the
     * project-level instance, which does not check tenants.
     */
    async createSessionCookie(idToken: string, sessionCookieOptions: SessionCookieOptions): Promise<string> {
        // As the Admin SDK: the duration is checked in whole seconds, rounded down
        const expiresIn = sessionCookieOptions?.expiresIn;
        const durationSeconds = typeof expiresIn === 'number' ? Math.floor(expiresIn / 1000) : NaN;
        if (!(durationSeconds >= MIN_SESSION_COOKIE_SECONDS && durationSeconds <= MAX_SESSION_COOKIE_SECONDS)) {
            throw new StubAuthError(...INVALID_SESSION_COOKIE_DURATION);
        }
        let claims: TokenClaims;
        try {
            claims = this.#authority.decodeToken(idToken, ID_TOKEN);
        } catch {
            throw new StubAuthError(...INVALID_ID_TOKEN);
        }
        const tokenTenant = claims.firebase?.tenant;
        const pool = typeof tokenTenant === 'string' ? this.#authority.pool(tokenTenant) : this.#pool;
        const user = pool.requireUser(claims.sub);
        if (user.disabled) {
            throw new StubAuthError(...USER_DISABLED);
        }
        // As Firebase: a revoked ID token is refused as expired
        if (this.#authority.nowSeconds() >= claims.exp || isRevoked(user, claims)) {
            throw new StubAuthError(...ID_TOKEN_EXPIRED);
        }
        // The cookie keeps the ID token's claims, auth_time and tenant included
        const issuedAt = this.#authority.nowSeconds();
        return this.#authority.mintJwt({ ...claims, iss: SESSION_COOKIE.issuerPrefix + this.#authority.projectId, iat: issuedAt, exp: issuedAt + durationSeconds });
    }

    async verifySessionCookie(sessionCookie: string, checkRevoked = false): Promise<DecodedIdToken> {
        return this.#verifyToken(sessionCookie, SESSION_COOKIE, checkRevoked);
    }

    /**
     * As Firebase: tokens become valid from this second, so ID tokens and session cookies
     * signed in before it are revoked, and any signed in during it survive
     */
    async revokeRefreshTokens(uid: string): Promise<void> {
        const user = this.#pool.requireUser(uid);
        this.#pool.users.set(uid, { ...user, validSinceSeconds: this.#authority.nowSeconds() });
    }

    async generatePasswordResetLink(email: string): Promise<string> {
        return this.#actionLink(this.issueActionCode(email, 'PASSWORD_RESET'), 'PASSWORD_RESET');
    }

    async generateEmailVerificationLink(email: string): Promise<string> {
        return this.#actionLink(this.issueActionCode(email, 'VERIFY_EMAIL'), 'VERIFY_EMAIL');
    }

    async generateVerifyAndChangeEmailLink(email: string, newEmail: string): Promise<string> {
        return this.#actionLink(this.issueActionCode(email, 'VERIFY_AND_CHANGE_EMAIL', newEmail), 'VERIFY_AND_CHANGE_EMAIL');
    }

    // Test controls

    /**
     * Writes a user straight into this pool, replacing any user with the same uid.
     * An email that belongs to another user of the pool is refused, as `createUser` refuses it.
     */
    seedUser(user: SeedUser): UserRecord {
        const stored = newUser(user.uid, user, user.creationTime?.getTime() ?? this.#authority.nowMs());
        this.#pool.assertEmailAvailable(stored.email, user.uid);
        this.#pool.users.set(user.uid, stored);
        return this.#toRecord(stored);
    }

    /** Makes the next `count` calls of `operation` for a user of this pool throw `error`, leaving the user unchanged. */
    failNext(operation: FailableAuthOperation, uid: string, count: number, error: Error): void {
        this.#pool.failures.set(failureKey(operation, uid), { remaining: count, error });
    }

    /** How many of the failures `failNext` set up for an operation and user are still to come. */
    remainingFailures(operation: FailableAuthOperation, uid: string): number {
        return this.#pool.failures.get(failureKey(operation, uid))?.remaining ?? 0;
    }

    /**
     * Signs a user of this pool in as a custom-token sign-in would, and returns its ID token: a
     * missing user is created, a disabled one refused, and the sign-in recorded in the user's metadata.
     */
    issueIdToken(uid: string): string {
        return this.#authority.signIn(this.#pool, uid, 'custom', {});
    }

    /**
     * The oobCode the matching `generate*Link` would put in its link, refused as it refuses:
     * an unknown email, and a new email that another user of the pool has.
     */
    issueActionCode(email: string, requestType: 'PASSWORD_RESET' | 'VERIFY_EMAIL'): string;
    issueActionCode(email: string, requestType: 'VERIFY_AND_CHANGE_EMAIL', newEmail: string): string;
    issueActionCode(email: string, requestType: ActionCodeRequestType, newEmail?: string): string {
        const user = this.#pool.findByEmail(email);
        if (!user) {
            // As the Admin SDK: a password reset names the email, the other links the user
            const [code, message] = requestType === 'PASSWORD_RESET' ? EMAIL_NOT_FOUND : USER_NOT_FOUND;
            throw new StubAuthError(code, message);
        }
        const actionCode: ActionCode = { requestType, email: user.email! };
        if (requestType === 'VERIFY_AND_CHANGE_EMAIL') {
            if (this.#pool.findByEmail(newEmail!)) {
                throw new StubAuthError(...EMAIL_ALREADY_EXISTS);
            }
            actionCode.newEmail = normalizeEmail(newEmail!);
        }
        const oobCode = randomBytes(40).toString('base64url');
        this.#pool.actionCodes.set(oobCode, actionCode);
        return oobCode;
    }

    /** A link of the form Firebase sends, carrying the code, and for a tenant the tenant ID as the emulator's links do */
    #actionLink(oobCode: string, requestType: ActionCodeRequestType): string {
        const query = new URLSearchParams({ mode: ACTION_LINK_MODES[requestType], oobCode, lang: 'en' });
        if (this.#pool.tenantId !== undefined) {
            query.set('tenantId', this.#pool.tenantId);
        }
        return `https://${this.#authority.projectId}.firebaseapp.com/__/auth/action?${query}`;
    }

    /**
     * As the Admin SDK: decoded and checked for expiry; with checkRevoked, the user is looked up in
     * this pool (against the emulator, always); and only then is the token's tenant compared
     */
    #verifyToken(token: string, kind: TokenKind, checkRevoked: boolean): DecodedIdToken {
        const claims = this.#authority.decodeToken(token, kind);
        if (this.#authority.nowSeconds() >= claims.exp) {
            throw new StubAuthError(
                kind.expiredCode,
                `${kind.jwtName} has expired. Get a fresh ${kind.shortName} from your client app and try again (${kind.expiredCode}).${docsMessage(kind)}`,
            );
        }
        if (checkRevoked) {
            const user = this.#pool.requireUser(claims.sub);
            if (user.disabled) {
                throw new StubAuthError(...USER_DISABLED);
            }
            if (isRevoked(user, claims)) {
                throw new StubAuthError(...kind.revoked);
            }
        }
        // As the Admin SDK: a tenant-aware instance refuses another pool's token; the project-level instance compares no tenant
        if (this.#pool.tenantId !== undefined && claims.firebase?.tenant !== this.#pool.tenantId) {
            throw new StubAuthError(...MISMATCHING_TENANT_ID);
        }
        return { ...claims, uid: claims.sub } as unknown as DecodedIdToken;
    }

    #toRecord(user: StoredUser): UserRecord {
        return toUserRecord(user, this.#pool.tenantId);
    }

    #throwIfFailing(operation: FailableAuthOperation, uid: string): void {
        const failure = this.#pool.failures.get(failureKey(operation, uid));
        if (failure && failure.remaining > 0) {
            failure.remaining--;
            throw failure.error;
        }
    }
}

/**
 * One Identity Platform tenant's Admin operations, as `TenantAwareAuth` performs them: users,
 * emails and action codes of its own pool, tokens carrying its tenant ID, and verification that
 * refuses a token or cookie of another pool with `auth/mismatching-tenant-id`. Obtained from
 * `StubAuth.tenantManager().authForTenant()`; it shares its `StubAuth`'s tokens and clock.
 */
export class StubTenantAwareAuth extends StubPoolAuth implements ITenantAwareAuth {
    readonly tenantId: string;

    /** Made by `StubAuth`; not exported for construction */
    constructor(authority: AuthAuthority, tenantId: string) {
        super(authority, authority.pool(tenantId));
        this.tenantId = tenantId;
    }

    /** As the Admin SDK: the ID token is verified for this tenant before the cookie is asked for */
    override async createSessionCookie(idToken: string, sessionCookieOptions: SessionCookieOptions): Promise<string> {
        if (typeof idToken !== 'string' || idToken === '') {
            throw new StubAuthError(...INVALID_ID_TOKEN);
        }
        if (typeof sessionCookieOptions?.expiresIn !== 'number') {
            throw new StubAuthError(...INVALID_SESSION_COOKIE_DURATION);
        }
        await this.verifyIdToken(idToken);
        return super.createSessionCookie(idToken, sessionCookieOptions);
    }
}

/** The tenants of one `StubAuth`, as `TenantManager.authForTenant` reaches them */
export class StubTenantManager implements ITenantManager {
    readonly #authority: AuthAuthority;
    /** As the Admin SDK: one instance per tenant, made on first request and kept for the manager's life */
    readonly #tenants = new Map<string, StubTenantAwareAuth>();

    /** Made by `StubAuth`; not exported for construction */
    constructor(authority: AuthAuthority) {
        this.#authority = authority;
    }

    /** As the emulator: an unknown tenant is not refused; its pool begins empty */
    authForTenant(tenantId: string): StubTenantAwareAuth {
        if (typeof tenantId !== 'string' || tenantId === '') {
            throw new StubAuthError(...INVALID_TENANT_ID);
        }
        let tenantAuth = this.#tenants.get(tenantId);
        if (!tenantAuth) {
            tenantAuth = new StubTenantAwareAuth(this.#authority, tenantId);
            this.#tenants.set(tenantId, tenantAuth);
        }
        return tenantAuth;
    }
}

/**
 * In-memory implementation of Firebase Auth for testing, matching the Auth emulator's behaviour.
 * Its tokens are JWTs signed with a key of its own, so only tokens it issued verify. It holds the
 * project's own pool of accounts, and through `tenantManager()` one pool per Identity Platform tenant.
 */
export class StubAuth extends StubPoolAuth {
    readonly #authority: AuthAuthority;
    readonly #authClient: IAuthClient;
    readonly #tenants: StubTenantManager;

    constructor(options: StubAuthOptions = {}) {
        const authority = new AuthAuthority(options.projectId ?? 'test-project');
        super(authority, authority.rootPool);
        this.#authority = authority;
        this.#tenants = new StubTenantManager(authority);
        this.#authClient = {
            signInWithPassword: async (request) => authority.signInWithPassword(request),
            signInWithCustomToken: async (request) => authority.signInWithCustomToken(request),
            resetPassword: async (request) => authority.resetPassword(request),
            applyActionCode: async (request) => authority.applyActionCode(request),
        };
    }

    /**
     * The REST API client over this simulator's pools and tokens, as an app's admin and REST calls
     * reach the same project. A request's `tenantId` selects a tenant's pool; without one it reaches the project's.
     */
    client(): IAuthClient {
        return this.#authClient;
    }

    /** The tenants of this simulator, each with its own pool */
    tenantManager(): StubTenantManager {
        return this.#tenants;
    }

    /**
     * Moves the simulator's clock forward, for every pool's token expiry and revocation. Firebase
     * compares a token's sign-in second with the second its user's tokens were revoked, so a test
     * that revokes a token it has just issued advances the clock a second first.
     */
    advanceClock(ms: number): void {
        this.#authority.advanceClock(ms);
    }

    /** Removes every user, action code and pending failure, in the project's pool and every tenant's. */
    clear(): void {
        this.#authority.clear();
    }
}

function requireActionCode(pool: AuthPool, oobCode: string): ActionCode {
    const actionCode = pool.actionCodes.get(oobCode);
    if (!actionCode) {
        throw new IdentityToolkitError(400, 'INVALID_OOB_CODE');
    }
    return actionCode;
}

/** Uses the code up, and returns the user of the pool that has its email */
function useActionCode(pool: AuthPool, oobCode: string, actionCode: ActionCode): StoredUser {
    pool.actionCodes.delete(oobCode);
    const user = pool.findByEmail(actionCode.email);
    if (!user) {
        throw new IdentityToolkitError(400, 'INVALID_OOB_CODE');
    }
    return user;
}

function newUser(uid: string, properties: CreateRequest, createdAtMs: number): StoredUser {
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

/** An opaque refresh token; the stub does not exchange refresh tokens */
function newRefreshToken(): string {
    return randomBytes(32).toString('base64url');
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

function toUserRecord(user: StoredUser, tenantId: string | undefined): UserRecord {
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
        tenantId,
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
