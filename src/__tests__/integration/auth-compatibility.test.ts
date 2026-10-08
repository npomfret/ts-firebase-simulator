/**
 * Integration Test: StubAuth vs Auth Emulator
 *
 * Verifies that StubAuth mirrors Firebase Auth by executing identical operations
 * against both implementations:
 * 1. Stub (in-memory) - always runs
 * 2. Emulator - runs when FIREBASE_AUTH_EMULATOR_HOST is set
 *
 * There is no real-Firebase mode: it would create real accounts and needs a web
 * API key and the Email/Password provider enabled.
 *
 * Configuration:
 * - Stub: No configuration needed
 * - Emulator: Run `firebase emulators:start` or use `npm run test:with-emulator`
 */

import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth, type UserRecord } from 'firebase-admin/auth';
import { createAuth, type IAuth, StubAuth } from 'ts-firebase-simulator';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

type TestMode = 'stub' | 'emulator';

const EMULATOR_PROJECT_ID = 'demo-test-project';
const EMULATOR_APP_NAME = 'auth-emulator-app';

function emulatorHost(): string | undefined {
    return process.env.FIREBASE_AUTH_EMULATOR_HOST;
}

function getEmulatorAuth(): IAuth {
    const app = getApps().find((existing) => existing.name === EMULATOR_APP_NAME) ?? initializeApp({ projectId: EMULATOR_PROJECT_ID }, EMULATOR_APP_NAME);
    return createAuth(getAuth(app));
}

/** Deletes every account in the emulator's project */
async function clearEmulatorAccounts(): Promise<void> {
    const response = await fetch(`http://${emulatorHost()}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/accounts`, { method: 'DELETE' });
    if (!response.ok) {
        throw new Error(`Clearing emulator accounts failed: HTTP ${response.status}`);
    }
}

/** A Firebase metadata time: a UTC string within a few seconds of now */
function expectRecentUtcString(value: string | null | undefined, label: string): void {
    expect(value, label).toBe(new Date(Date.parse(value!)).toUTCString());
    expect(Math.abs(Date.now() - Date.parse(value!)), label).toBeLessThan(5000);
}

describe('Auth Stub Compatibility - Integration Test', () => {
    let stubAuth: StubAuth;
    let emulatorAuth: IAuth | null = null;
    const emulatorAvailable = !!emulatorHost();

    beforeAll(() => {
        console.log(`Auth test modes: stub=yes, emulator=${emulatorAvailable ? 'yes' : 'no'}`);
        if (emulatorAvailable) {
            emulatorAuth = getEmulatorAuth();
        }
    });

    beforeEach(async () => {
        stubAuth = new StubAuth();
        if (emulatorAvailable) {
            await clearEmulatorAccounts();
        }
    });

    async function testAllImplementations(testFn: (auth: IAuth, mode: TestMode) => Promise<void>) {
        await testFn(stubAuth, 'stub');
        if (emulatorAuth) {
            await testFn(emulatorAuth, 'emulator');
        }
    }

    describe('createUser', () => {
        it('creates a password user with a generated uid', async () => {
            await testAllImplementations(async (auth, mode) => {
                const user = await auth.createUser({ email: 'Alice@Example.com', password: 'secret1', displayName: 'Alice' });

                expect(user.uid, `uid (${mode})`).toMatch(/^[A-Za-z0-9]{28}$/);
                expect(user.email, `email is lower-cased (${mode})`).toBe('alice@example.com');
                expect(user.displayName, `displayName (${mode})`).toBe('Alice');
                expect(user.emailVerified, `emailVerified (${mode})`).toBe(false);
                expect(user.disabled, `disabled (${mode})`).toBe(false);
                expect(user.photoURL, `photoURL (${mode})`).toBeUndefined();
                expect(user.phoneNumber, `phoneNumber (${mode})`).toBeUndefined();
                expect(user.customClaims, `customClaims (${mode})`).toBeUndefined();
                expect(user.providerData.map((info) => info.toJSON()), `providerData (${mode})`).toEqual([
                    { uid: 'alice@example.com', displayName: 'Alice', email: 'alice@example.com', providerId: 'password' },
                ]);
                expectRecentUtcString(user.metadata.creationTime, `creationTime (${mode})`);
                expect(user.metadata.lastSignInTime, `lastSignInTime (${mode})`).toBe(user.metadata.creationTime);
                expect(user.metadata.lastRefreshTime, `lastRefreshTime (${mode})`).toBeNull();
                expectRecentUtcString(user.tokensValidAfterTime, `tokensValidAfterTime (${mode})`);
            });
        });

        it('creates a user with a given uid and every supported property', async () => {
            await testAllImplementations(async (auth, mode) => {
                const user = await auth.createUser({
                    uid: 'full-user',
                    email: 'full@example.com',
                    password: 'secret1',
                    displayName: 'Full',
                    photoURL: 'https://example.com/full.png',
                    phoneNumber: '+15555550100',
                    emailVerified: true,
                    disabled: true,
                });

                const { metadata, tokensValidAfterTime, ...json } = user.toJSON() as Record<string, unknown>;
                expect(json, `toJSON (${mode})`).toEqual({
                    uid: 'full-user',
                    email: 'full@example.com',
                    emailVerified: true,
                    displayName: 'Full',
                    photoURL: 'https://example.com/full.png',
                    phoneNumber: '+15555550100',
                    disabled: true,
                    providerData: [
                        { uid: 'full@example.com', displayName: 'Full', email: 'full@example.com', photoURL: 'https://example.com/full.png', providerId: 'password' },
                        { uid: '+15555550100', providerId: 'phone', phoneNumber: '+15555550100' },
                    ],
                    // The emulator's fake hash; the stub keeps no hash
                    ...(mode === 'emulator' ? { passwordHash: expect.any(String), passwordSalt: expect.any(String) } : {}),
                });
                expect(Object.keys(metadata as object), `metadata (${mode})`).toEqual(['lastSignInTime', 'creationTime', 'lastRefreshTime']);
                expect(tokensValidAfterTime, `tokensValidAfterTime (${mode})`).toEqual(expect.any(String));
            });
        });

        it('gives a user without a password no provider and no tokensValidAfterTime', async () => {
            await testAllImplementations(async (auth, mode) => {
                const withEmail = await auth.createUser({ uid: 'email-only', email: 'email-only@example.com' });
                const withPassword = await auth.createUser({ uid: 'password-only', password: 'secret1' });

                expect(withEmail.providerData, `email only: providerData (${mode})`).toEqual([]);
                expect(withEmail.tokensValidAfterTime, `email only: tokensValidAfterTime (${mode})`).toBeUndefined();
                expect(withPassword.providerData, `password only: providerData (${mode})`).toEqual([]);
                expect(withPassword.tokensValidAfterTime, `password only: tokensValidAfterTime (${mode})`).toEqual(expect.any(String));
            });
        });

        it('refuses an email already in use, in any case', async () => {
            await testAllImplementations(async (auth, mode) => {
                await auth.createUser({ email: 'taken@example.com' });

                await expect(auth.createUser({ email: 'TAKEN@example.com' }), `duplicate email (${mode})`).rejects.toMatchObject({
                    code: 'auth/email-already-exists',
                    message: 'The email address is already in use by another account.',
                });
            });
        });

        it('refuses a uid already in use', async () => {
            await testAllImplementations(async (auth, mode) => {
                await auth.createUser({ uid: 'taken-uid' });

                await expect(auth.createUser({ uid: 'taken-uid' }), `duplicate uid (${mode})`).rejects.toMatchObject({
                    code: 'auth/uid-already-exists',
                    message: 'The user with the provided uid already exists.',
                });
            });
        });
    });

    describe('getUser, getUserByEmail and getUsers', () => {
        it('reads a user by uid and by email in any case', async () => {
            await testAllImplementations(async (auth, mode) => {
                const created = await auth.createUser({ uid: 'reader', email: 'reader@example.com', password: 'secret1' });

                expect((await auth.getUser('reader')).toJSON(), `getUser (${mode})`).toEqual(created.toJSON());
                expect((await auth.getUserByEmail('READER@Example.com')).toJSON(), `getUserByEmail (${mode})`).toEqual(created.toJSON());
            });
        });

        it('refuses a missing user', async () => {
            await testAllImplementations(async (auth, mode) => {
                const notFound = { code: 'auth/user-not-found', message: 'There is no user record corresponding to the provided identifier.' };

                await expect(auth.getUser('missing'), `getUser (${mode})`).rejects.toMatchObject(notFound);
                await expect(auth.getUserByEmail('missing@example.com'), `getUserByEmail (${mode})`).rejects.toMatchObject(notFound);
            });
        });

        it('returns found users once each and lists the uids not found', async () => {
            await testAllImplementations(async (auth, mode) => {
                await auth.createUser({ uid: 'found-1' });
                await auth.createUser({ uid: 'found-2' });

                const result = await auth.getUsers([{ uid: 'found-1' }, { uid: 'missing' }, { uid: 'found-2' }, { uid: 'found-1' }]);

                expect(result.users.map((user) => user.uid).sort(), `users (${mode})`).toEqual(['found-1', 'found-2']);
                expect(result.notFound, `notFound (${mode})`).toEqual([{ uid: 'missing' }]);
            });
        });

        it('refuses more than 100 identifiers at the call, before any promise', async () => {
            await testAllImplementations(async (auth, mode) => {
                const identifiers = Array.from({ length: 101 }, (_, index) => ({ uid: `user-${index}` }));

                let thrown: unknown;
                try {
                    void auth.getUsers(identifiers);
                } catch (error) {
                    thrown = error;
                }
                expect(thrown, `101 identifiers (${mode})`).toMatchObject({
                    code: 'auth/maximum-user-count-exceeded',
                    message: '`identifiers` parameter must have <= 100 entries.',
                });
                await expect(auth.getUsers(identifiers.slice(0, 100)), `100 identifiers (${mode})`).resolves.toMatchObject({ users: [] });
            });
        });
    });

    describe('updateUser', () => {
        it('changes the given properties and leaves the rest', async () => {
            await testAllImplementations(async (auth, mode) => {
                await auth.createUser({ uid: 'updated', email: 'updated@example.com', displayName: 'Before', photoURL: 'https://example.com/before.png' });

                const user = await auth.updateUser('updated', { displayName: 'After', emailVerified: true, disabled: true });

                expect(user.displayName, `displayName (${mode})`).toBe('After');
                expect(user.emailVerified, `emailVerified (${mode})`).toBe(true);
                expect(user.disabled, `disabled (${mode})`).toBe(true);
                expect(user.email, `email (${mode})`).toBe('updated@example.com');
                expect(user.photoURL, `photoURL (${mode})`).toBe('https://example.com/before.png');
                expect(user.tokensValidAfterTime, `tokensValidAfterTime (${mode})`).toBeUndefined();
                expect(user.metadata.lastRefreshTime, `lastRefreshTime (${mode})`).toBeNull();
                expect((await auth.getUser('updated')).toJSON(), `stored (${mode})`).toEqual(user.toJSON());
            });
        });

        it('deletes a display name and photo set to null', async () => {
            await testAllImplementations(async (auth, mode) => {
                await auth.createUser({ uid: 'nulled', email: 'nulled@example.com', password: 'secret1', displayName: 'Name', photoURL: 'https://example.com/p.png' });

                const user = await auth.updateUser('nulled', { displayName: null, photoURL: null });

                expect(user.displayName, `displayName (${mode})`).toBeUndefined();
                expect(user.photoURL, `photoURL (${mode})`).toBeUndefined();
                expect(user.providerData.map((info) => info.toJSON()), `providerData (${mode})`).toEqual([
                    { uid: 'nulled@example.com', email: 'nulled@example.com', providerId: 'password' },
                ]);
            });
        });

        it('lower-cases a new email and revalidates tokens from the change', async () => {
            await testAllImplementations(async (auth, mode) => {
                await auth.createUser({ uid: 'mover', email: 'before@example.com' });

                const user = await auth.updateUser('mover', { email: 'After@Example.com' });

                expect(user.email, `email (${mode})`).toBe('after@example.com');
                expectRecentUtcString(user.tokensValidAfterTime, `tokensValidAfterTime (${mode})`);
                expect(user.metadata.lastRefreshTime, `lastRefreshTime (${mode})`).toBeNull();
                await expect(auth.getUserByEmail('before@example.com'), `old email (${mode})`).rejects.toMatchObject({ code: 'auth/user-not-found' });
            });
        });

        it('adds the password provider and refreshes the account when a password is set', async () => {
            await testAllImplementations(async (auth, mode) => {
                await auth.createUser({ uid: 'new-password', email: 'new-password@example.com' });

                const user = await auth.updateUser('new-password', { password: 'secret2' });

                expect(user.providerData.map((info) => info.toJSON()), `providerData (${mode})`).toEqual([
                    { uid: 'new-password@example.com', email: 'new-password@example.com', providerId: 'password' },
                ]);
                expectRecentUtcString(user.tokensValidAfterTime, `tokensValidAfterTime (${mode})`);
                expectRecentUtcString(user.metadata.lastRefreshTime, `lastRefreshTime (${mode})`);
            });
        });

        it('refuses an email that belongs to another user, and allows its own', async () => {
            await testAllImplementations(async (auth, mode) => {
                await auth.createUser({ uid: 'owner', email: 'owner@example.com' });
                await auth.createUser({ uid: 'other', email: 'other@example.com' });

                await expect(auth.updateUser('other', { email: 'OWNER@example.com' }), `taken (${mode})`).rejects.toMatchObject({ code: 'auth/email-already-exists' });
                await expect(auth.updateUser('owner', { email: 'owner@example.com' }), `own (${mode})`).resolves.toMatchObject({ email: 'owner@example.com' });
                expect((await auth.getUser('other')).email, `unchanged (${mode})`).toBe('other@example.com');
            });
        });

        it('refuses a missing user', async () => {
            await testAllImplementations(async (auth, mode) => {
                await expect(auth.updateUser('missing', { displayName: 'x' }), `missing (${mode})`).rejects.toMatchObject({ code: 'auth/user-not-found' });
            });
        });
    });

    describe('listUsers', () => {
        it('pages through users in uid order', async () => {
            await testAllImplementations(async (auth, mode) => {
                for (const uid of ['list-c', 'list-a', 'List-B', 'list-d']) {
                    await auth.createUser({ uid });
                }

                const first = await auth.listUsers(2);
                const second = await auth.listUsers(2, first.pageToken);
                const third = await auth.listUsers(2, second.pageToken);

                expect(first.users.map((user) => user.uid), `first page (${mode})`).toEqual(['List-B', 'list-a']);
                expect(first.pageToken, `first token (${mode})`).toBe('list-a');
                expect(second.users.map((user) => user.uid), `second page (${mode})`).toEqual(['list-c', 'list-d']);
                expect(second.pageToken, `full last page still has a token (${mode})`).toBe('list-d');
                expect(third.users, `after the last page (${mode})`).toEqual([]);
                expect(third.pageToken, `no token after the last page (${mode})`).toBeUndefined();
            });
        });

        it('omits the page token from a page that is not full', async () => {
            await testAllImplementations(async (auth, mode) => {
                await auth.createUser({ uid: 'only-user' });

                const page = await auth.listUsers();

                expect(page.users.map((user: UserRecord) => user.uid), `users (${mode})`).toEqual(['only-user']);
                expect(page.pageToken, `pageToken (${mode})`).toBeUndefined();
            });
        });

        it('refuses a page size outside 1 to 1000', async () => {
            await testAllImplementations(async (auth, mode) => {
                const argumentError = { code: 'auth/argument-error', message: 'Required "maxResults" must be a positive integer that does not exceed 1000.' };

                await expect(auth.listUsers(1001), `1001 (${mode})`).rejects.toMatchObject(argumentError);
                await expect(auth.listUsers(0), `0 (${mode})`).rejects.toMatchObject(argumentError);
                await expect(auth.listUsers(1000), `1000 (${mode})`).resolves.toMatchObject({ users: [] });
            });
        });
    });

    describe('deleteUser', () => {
        it('removes the user and frees its email', async () => {
            await testAllImplementations(async (auth, mode) => {
                await auth.createUser({ uid: 'doomed', email: 'doomed@example.com' });

                await auth.deleteUser('doomed');

                await expect(auth.getUser('doomed'), `deleted (${mode})`).rejects.toMatchObject({ code: 'auth/user-not-found' });
                await expect(auth.createUser({ email: 'doomed@example.com' }), `email reusable (${mode})`).resolves.toMatchObject({ email: 'doomed@example.com' });
            });
        });

        it('refuses a missing user', async () => {
            await testAllImplementations(async (auth, mode) => {
                await expect(auth.deleteUser('missing'), `missing (${mode})`).rejects.toMatchObject({ code: 'auth/user-not-found' });
            });
        });
    });
});
