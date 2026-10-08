import type { CreateRequest, DecodedIdToken, GetUsersResult, ListUsersResult, SessionCookieOptions, UidIdentifier, UpdateRequest, UserRecord } from 'firebase-admin/auth';

/**
 * Interface for Firebase Auth (Admin SDK) operations
 * Mirrors the subset of `firebase-admin/auth` `Auth` that is supported, with the same signatures
 */
export interface IAuth {
    createUser(properties: CreateRequest): Promise<UserRecord>;
    getUser(uid: string): Promise<UserRecord>;
    /** Looks up by uid only; the real `Auth` also accepts email, phone and provider identifiers. */
    getUsers(identifiers: UidIdentifier[]): Promise<GetUsersResult>;
    getUserByEmail(email: string): Promise<UserRecord>;
    updateUser(uid: string, properties: UpdateRequest): Promise<UserRecord>;
    listUsers(maxResults?: number, pageToken?: string): Promise<ListUsersResult>;
    deleteUser(uid: string): Promise<void>;

    createCustomToken(uid: string, developerClaims?: object): Promise<string>;
    verifyIdToken(idToken: string, checkRevoked?: boolean): Promise<DecodedIdToken>;
    createSessionCookie(idToken: string, sessionCookieOptions: SessionCookieOptions): Promise<string>;
    verifySessionCookie(sessionCookie: string, checkRevoked?: boolean): Promise<DecodedIdToken>;
    revokeRefreshTokens(uid: string): Promise<void>;
}
