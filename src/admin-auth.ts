import type { Auth, CreateRequest, GetUsersResult, ListUsersResult, UidIdentifier, UpdateRequest, UserRecord } from 'firebase-admin/auth';
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
}

/**
 * Create a wrapped Firebase Auth client
 */
export function createAuth(auth: Auth): IAuth {
    return new AuthWrapper(auth);
}
