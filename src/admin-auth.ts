import type { Auth, CreateRequest, DecodedIdToken, GetUsersResult, ListUsersResult, SessionCookieOptions, UidIdentifier, UpdateRequest, UserRecord } from 'firebase-admin/auth';
import type { IAuth } from './auth-types';

/**
 * Wraps the real Firebase Admin Auth client to match our interface
 */
class AuthWrapper implements IAuth {
    constructor(private readonly auth: Auth) {}

    createUser(properties: CreateRequest): Promise<UserRecord> {
        return this.auth.createUser(properties);
    }

    getUser(uid: string): Promise<UserRecord> {
        return this.auth.getUser(uid);
    }

    getUsers(identifiers: UidIdentifier[]): Promise<GetUsersResult> {
        return this.auth.getUsers(identifiers);
    }

    getUserByEmail(email: string): Promise<UserRecord> {
        return this.auth.getUserByEmail(email);
    }

    updateUser(uid: string, properties: UpdateRequest): Promise<UserRecord> {
        return this.auth.updateUser(uid, properties);
    }

    listUsers(maxResults?: number, pageToken?: string): Promise<ListUsersResult> {
        return this.auth.listUsers(maxResults, pageToken);
    }

    deleteUser(uid: string): Promise<void> {
        return this.auth.deleteUser(uid);
    }

    createCustomToken(uid: string, developerClaims?: object): Promise<string> {
        return this.auth.createCustomToken(uid, developerClaims);
    }

    verifyIdToken(idToken: string, checkRevoked?: boolean): Promise<DecodedIdToken> {
        return this.auth.verifyIdToken(idToken, checkRevoked);
    }

    createSessionCookie(idToken: string, sessionCookieOptions: SessionCookieOptions): Promise<string> {
        return this.auth.createSessionCookie(idToken, sessionCookieOptions);
    }

    verifySessionCookie(sessionCookie: string, checkRevoked?: boolean): Promise<DecodedIdToken> {
        return this.auth.verifySessionCookie(sessionCookie, checkRevoked);
    }

    revokeRefreshTokens(uid: string): Promise<void> {
        return this.auth.revokeRefreshTokens(uid);
    }

    generatePasswordResetLink(email: string): Promise<string> {
        return this.auth.generatePasswordResetLink(email);
    }

    generateEmailVerificationLink(email: string): Promise<string> {
        return this.auth.generateEmailVerificationLink(email);
    }

    generateVerifyAndChangeEmailLink(email: string, newEmail: string): Promise<string> {
        return this.auth.generateVerifyAndChangeEmailLink(email, newEmail);
    }
}

/**
 * Create a wrapped Firebase Auth client
 */
export function createAuth(auth: Auth): IAuth {
    return new AuthWrapper(auth);
}
