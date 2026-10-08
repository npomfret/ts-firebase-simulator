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
import { createAuth, createAuthClient, type IAuth, type IAuthClient, IdentityToolkitError, StubAuth } from 'ts-firebase-simulator';
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

function getEmulatorAuthClient(): IAuthClient {
    return createAuthClient({ apiKey: 'fake-api-key', baseUrl: `http://${emulatorHost()}/identitytoolkit.googleapis.com` });
}

/** Deletes every account in the emulator's project */
async function clearEmulatorAccounts(): Promise<void> {
    const response = await fetch(`http://${emulatorHost()}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/accounts`, { method: 'DELETE' });
    if (!response.ok) {
        throw new Error(`Clearing emulator accounts failed: HTTP ${response.status}`);
    }
}

/** Signs a user in with a custom token through the emulator's Identity Toolkit REST API, returning the ID token */
async function emulatorSignIn(auth: IAuth, uid: string): Promise<string> {
    const response = await fetch(`http://${emulatorHost()}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: await auth.createCustomToken(uid), returnSecureToken: true }),
    });
    const body = (await response.json()) as { idToken?: string; };
    if (!response.ok || !body.idToken) {
        throw new Error(`Emulator sign-in failed: HTTP ${response.status} ${JSON.stringify(body)}`);
    }
    return body.idToken;
}

/** A Firebase metadata time: a UTC string within a few seconds of now */
function expectRecentUtcString(value: string | null | undefined, label: string): void {
    expect(value, label).toBe(new Date(Date.parse(value!)).toUTCString());
    expect(Math.abs(Date.now() - Date.parse(value!)), label).toBeLessThan(5000);
}

describe('Auth Stub Compatibility - Integration Test', () => {
    let stubAuth: StubAuth;
    let emulatorAuth: IAuth | null = null;
    let emulatorAuthClient: IAuthClient | null = null;
    const emulatorAvailable = !!emulatorHost();

    beforeAll(() => {
        console.log(`Auth test modes: stub=yes, emulator=${emulatorAvailable ? 'yes' : 'no'}`);
        if (emulatorAvailable) {
            emulatorAuth = getEmulatorAuth();
            emulatorAuthClient = getEmulatorAuthClient();
        }
    });

    beforeEach(async () => {
        stubAuth = new StubAuth({ projectId: EMULATOR_PROJECT_ID });
        if (emulatorAvailable) {
            await clearEmulatorAccounts();
        }
    });

    /** An ID token for the user, from a custom-token sign-in */
    async function signIn(auth: IAuth, mode: TestMode, uid: string): Promise<string> {
        return mode === 'stub' ? stubAuth.issueIdToken(uid) : emulatorSignIn(auth, uid);
    }

    /** Lets the clock pass into a later second, which revocation needs to tell tokens apart */
    async function passOneSecond(mode: TestMode): Promise<void> {
        if (mode === 'stub') {
            stubAuth.advanceClock(1000);
        } else {
            await new Promise((resolve) => setTimeout(resolve, 1100));
        }
    }

    async function testAllImplementations(testFn: (auth: IAuth, mode: TestMode, client: IAuthClient) => Promise<void>) {
        await testFn(stubAuth, 'stub', stubAuth.client());
        if (emulatorAuth && emulatorAuthClient) {
            await testFn(emulatorAuth, 'emulator', emulatorAuthClient);
        }
    }

    /** Expects the call to fail as the REST API fails it: an IdentityToolkitError with HTTP 400 */
    async function expectIdentityToolkitError(call: Promise<unknown>, message: string, label: string): Promise<void> {
        const error = await call.then(() => undefined, (thrown: unknown) => thrown);
        expect(error, label).toBeInstanceOf(IdentityToolkitError);
        expect(error, label).toMatchObject({ status: 400, reason: message.split(' : ')[0], message });
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

    describe('ID tokens', () => {
        it('carries the user in its claims', async () => {
            await testAllImplementations(async (auth, mode) => {
                await auth.createUser({
                    uid: 'claimed',
                    email: 'claimed@example.com',
                    password: 'secret1',
                    displayName: 'Claimed',
                    photoURL: 'https://example.com/c.png',
                    phoneNumber: '+15555550102',
                    emailVerified: true,
                });

                const decoded = await auth.verifyIdToken(await signIn(auth, mode, 'claimed'), true);

                expect(decoded, `claims (${mode})`).toEqual({
                    name: 'Claimed',
                    picture: 'https://example.com/c.png',
                    email: 'claimed@example.com',
                    email_verified: true,
                    phone_number: '+15555550102',
                    auth_time: decoded.iat,
                    user_id: 'claimed',
                    firebase: { identities: { email: ['claimed@example.com'], phone: ['+15555550102'] }, sign_in_provider: 'custom' },
                    iat: expect.any(Number),
                    exp: decoded.iat + 3600,
                    aud: EMULATOR_PROJECT_ID,
                    iss: `https://securetoken.google.com/${EMULATOR_PROJECT_ID}`,
                    sub: 'claimed',
                    uid: 'claimed',
                });
                expect(Math.abs(Date.now() / 1000 - decoded.iat), `iat is now (${mode})`).toBeLessThan(5);
            });
        });

        it('carries no identities for a user without email or phone', async () => {
            await testAllImplementations(async (auth, mode) => {
                await auth.createUser({ uid: 'anonymous' });

                const decoded = await auth.verifyIdToken(await signIn(auth, mode, 'anonymous'), true);

                expect(decoded.email_verified, `email_verified (${mode})`).toBe(false);
                expect(decoded.firebase, `firebase (${mode})`).toEqual({ identities: {}, sign_in_provider: 'custom' });
                expect(decoded.email, `email (${mode})`).toBeUndefined();
            });
        });

        it('records the sign-in in the user metadata', async () => {
            await testAllImplementations(async (auth, mode) => {
                await auth.createUser({ uid: 'signer' });

                await signIn(auth, mode, 'signer');

                const { metadata } = await auth.getUser('signer');
                expectRecentUtcString(metadata.lastSignInTime, `lastSignInTime (${mode})`);
                expect(metadata.lastRefreshTime, `lastRefreshTime (${mode})`).toBe(metadata.lastSignInTime);
            });
        });

        it('creates the user when a custom token signs in a uid that does not exist', async () => {
            await testAllImplementations(async (auth, mode) => {
                await expect(auth.createCustomToken('newcomer'), `custom token without a user (${mode})`).resolves.toEqual(expect.any(String));

                await signIn(auth, mode, 'newcomer');

                const user = await auth.getUser('newcomer');
                expect(user.email, `email (${mode})`).toBeUndefined();
                expect(user.providerData, `providerData (${mode})`).toEqual([]);
                expect(user.tokensValidAfterTime, `tokensValidAfterTime (${mode})`).toBeUndefined();
                expect(user.metadata.lastSignInTime, `lastSignInTime (${mode})`).toBe(user.metadata.creationTime);
            });
        });

        it('refuses a malformed token and a session cookie', async () => {
            await testAllImplementations(async (auth, mode) => {
                await auth.createUser({ uid: 'confused' });
                const cookie = await auth.createSessionCookie(await signIn(auth, mode, 'confused'), { expiresIn: 5 * 60 * 1000 });

                await expect(auth.verifyIdToken('garbage'), `garbage (${mode})`).rejects.toMatchObject({
                    code: 'auth/argument-error',
                    message:
                        'Decoding Firebase ID token failed. Make sure you passed the entire string JWT which represents an ID token. See https://firebase.google.com/docs/auth/admin/verify-id-tokens for details on how to retrieve an ID token.',
                });
                await expect(auth.verifyIdToken(cookie), `session cookie (${mode})`).rejects.toMatchObject({
                    code: 'auth/argument-error',
                    message:
                        `Firebase ID token has incorrect "iss" (issuer) claim. Expected "https://securetoken.google.com/${EMULATOR_PROJECT_ID}" but got "https://session.firebase.google.com/${EMULATOR_PROJECT_ID}". Make sure the ID token comes from the same Firebase project as the service account used to authenticate this SDK. See https://firebase.google.com/docs/auth/admin/verify-id-tokens for details on how to retrieve an ID token.`,
                });
            });
        });
    });

    describe('session cookies', () => {
        it('keeps the ID token claims, with its own issuer and expiry', async () => {
            await testAllImplementations(async (auth, mode) => {
                await auth.createUser({ uid: 'cookie-user', email: 'cookie-user@example.com', displayName: 'Cookie' });
                const idToken = await auth.verifyIdToken(await signIn(auth, mode, 'cookie-user'), true);

                const cookie = await auth.verifySessionCookie(await auth.createSessionCookie(await signIn(auth, mode, 'cookie-user'), { expiresIn: 10 * 60 * 1000 }), true);

                expect(cookie, `claims (${mode})`).toEqual({
                    ...idToken,
                    auth_time: expect.any(Number),
                    iss: `https://session.firebase.google.com/${EMULATOR_PROJECT_ID}`,
                    iat: expect.any(Number),
                    exp: cookie.iat + 600,
                });
            });
        });

        it('refuses a duration outside 5 minutes to 2 weeks', async () => {
            await testAllImplementations(async (auth, mode) => {
                await auth.createUser({ uid: 'impatient' });
                const idToken = await signIn(auth, mode, 'impatient');
                const durationError = {
                    code: 'auth/invalid-session-cookie-duration',
                    message: 'The session cookie duration must be a valid number in milliseconds between 5 minutes and 2 weeks.',
                };

                await expect(auth.createSessionCookie(idToken, { expiresIn: 5 * 60 * 1000 - 1 }), `too short (${mode})`).rejects.toMatchObject(durationError);
                await expect(auth.createSessionCookie(idToken, { expiresIn: 14 * 24 * 60 * 60 * 1000 + 1000 }), `too long (${mode})`).rejects.toMatchObject(durationError);
                // The duration is checked in whole seconds, rounded down
                await expect(auth.createSessionCookie(idToken, { expiresIn: 14 * 24 * 60 * 60 * 1000 + 999 }), `two weeks (${mode})`).resolves.toEqual(expect.any(String));
            });
        });

        it('refuses a malformed ID token, and a malformed cookie', async () => {
            await testAllImplementations(async (auth, mode) => {
                await expect(auth.createSessionCookie('garbage', { expiresIn: 5 * 60 * 1000 }), `create (${mode})`).rejects.toMatchObject({
                    code: 'auth/invalid-id-token',
                    message: 'The provided ID token is not a valid Firebase ID token.',
                });
                await expect(auth.verifySessionCookie('garbage'), `verify (${mode})`).rejects.toMatchObject({
                    code: 'auth/argument-error',
                    message:
                        'Decoding Firebase session cookie failed. Make sure you passed the entire string JWT which represents a session cookie. See https://firebase.google.com/docs/auth/admin/manage-cookies for details on how to retrieve a session cookie.',
                });
            });
        });
    });

    describe('revocation and account state', () => {
        it('refuses tokens and cookies signed in before the second of revocation', async () => {
            await testAllImplementations(async (auth, mode) => {
                await auth.createUser({ uid: 'revoked' });
                const idToken = await signIn(auth, mode, 'revoked');
                const cookie = await auth.createSessionCookie(idToken, { expiresIn: 5 * 60 * 1000 });

                await passOneSecond(mode);
                await auth.revokeRefreshTokens('revoked');

                expectRecentUtcString((await auth.getUser('revoked')).tokensValidAfterTime, `tokensValidAfterTime (${mode})`);
                await expect(auth.verifyIdToken(idToken, true), `ID token (${mode})`).rejects.toMatchObject({
                    code: 'auth/id-token-revoked',
                    message: 'The Firebase ID token has been revoked.',
                });
                await expect(auth.verifySessionCookie(cookie, true), `cookie (${mode})`).rejects.toMatchObject({
                    code: 'auth/session-cookie-revoked',
                    message: 'The Firebase session cookie has been revoked.',
                });
                await expect(auth.createSessionCookie(idToken, { expiresIn: 5 * 60 * 1000 }), `new cookie (${mode})`).rejects.toMatchObject({
                    code: 'auth/id-token-expired',
                    message: 'The provided Firebase ID token is expired.',
                });

                await passOneSecond(mode);
                await expect(auth.verifyIdToken(await signIn(auth, mode, 'revoked'), true), `fresh sign-in (${mode})`).resolves.toMatchObject({ uid: 'revoked' });
            });
        });

        it('refuses a disabled user', async () => {
            await testAllImplementations(async (auth, mode) => {
                await auth.createUser({ uid: 'disabled' });
                const idToken = await signIn(auth, mode, 'disabled');
                const cookie = await auth.createSessionCookie(idToken, { expiresIn: 5 * 60 * 1000 });

                await auth.updateUser('disabled', { disabled: true });

                const userDisabled = { code: 'auth/user-disabled', message: 'The user record is disabled.' };
                await expect(auth.verifyIdToken(idToken, true), `ID token (${mode})`).rejects.toMatchObject(userDisabled);
                await expect(auth.verifySessionCookie(cookie, true), `cookie (${mode})`).rejects.toMatchObject(userDisabled);
                await expect(auth.createSessionCookie(idToken, { expiresIn: 5 * 60 * 1000 }), `new cookie (${mode})`).rejects.toMatchObject(userDisabled);
            });
        });

        it('refuses a deleted user', async () => {
            await testAllImplementations(async (auth, mode) => {
                await auth.createUser({ uid: 'deleted' });
                const idToken = await signIn(auth, mode, 'deleted');
                const cookie = await auth.createSessionCookie(idToken, { expiresIn: 5 * 60 * 1000 });

                await auth.deleteUser('deleted');

                const notFound = { code: 'auth/user-not-found' };
                await expect(auth.verifyIdToken(idToken, true), `ID token (${mode})`).rejects.toMatchObject(notFound);
                await expect(auth.verifySessionCookie(cookie, true), `cookie (${mode})`).rejects.toMatchObject(notFound);
                await expect(auth.createSessionCookie(idToken, { expiresIn: 5 * 60 * 1000 }), `new cookie (${mode})`).rejects.toMatchObject(notFound);
            });
        });

        it('refuses to revoke a missing user', async () => {
            await testAllImplementations(async (auth, mode) => {
                await expect(auth.revokeRefreshTokens('missing'), `missing (${mode})`).rejects.toMatchObject({ code: 'auth/user-not-found' });
            });
        });
    });

    describe('client sign-in', () => {
        it('signs in with a password, in any email case', async () => {
            await testAllImplementations(async (auth, mode, client) => {
                await auth.createUser({ uid: 'walker', email: 'walker@example.com', password: 'secret1' });

                const response = await client.signInWithPassword({ email: 'Walker@Example.com', password: 'secret1', returnSecureToken: true });

                expect(response, `response (${mode})`).toMatchObject({ localId: 'walker', email: 'walker@example.com', refreshToken: expect.any(String), expiresIn: '3600' });
                const decoded = await auth.verifyIdToken(response.idToken!, true);
                expect(decoded.firebase, `firebase (${mode})`).toEqual({ identities: { email: ['walker@example.com'] }, sign_in_provider: 'password' });
                const { metadata } = await auth.getUser('walker');
                expect(metadata.lastRefreshTime, `lastRefreshTime (${mode})`).toBe(metadata.lastSignInTime);
            });
        });

        it('signs in without asking for tokens, and returns them anyway, as the emulator does', async () => {
            await testAllImplementations(async (auth, mode, client) => {
                await auth.createUser({ uid: 'checker', email: 'checker@example.com', password: 'secret1' });

                const response = await client.signInWithPassword({ email: 'checker@example.com', password: 'secret1', returnSecureToken: false });

                expect(response, `response (${mode})`).toMatchObject({ localId: 'checker', email: 'checker@example.com', idToken: expect.any(String) });
            });
        });

        it('refuses a wrong password, and a user without one', async () => {
            await testAllImplementations(async (auth, mode, client) => {
                await auth.createUser({ uid: 'guarded', email: 'guarded@example.com', password: 'secret1' });
                await auth.createUser({ uid: 'passwordless', email: 'passwordless@example.com' });

                await expectIdentityToolkitError(client.signInWithPassword({ email: 'guarded@example.com', password: 'wrong1', returnSecureToken: true }), 'INVALID_PASSWORD', `wrong (${mode})`);
                await expectIdentityToolkitError(
                    client.signInWithPassword({ email: 'passwordless@example.com', password: 'secret1', returnSecureToken: true }),
                    'INVALID_PASSWORD',
                    `none (${mode})`,
                );
            });
        });

        it('refuses an unknown email', async () => {
            await testAllImplementations(async (_auth, mode, client) => {
                await expectIdentityToolkitError(client.signInWithPassword({ email: 'nobody@example.com', password: 'secret1', returnSecureToken: true }), 'EMAIL_NOT_FOUND', `unknown (${mode})`);
            });
        });

        it('refuses a disabled user, whatever the password', async () => {
            await testAllImplementations(async (auth, mode, client) => {
                await auth.createUser({ uid: 'benched', email: 'benched@example.com', password: 'secret1', disabled: true });

                await expectIdentityToolkitError(client.signInWithPassword({ email: 'benched@example.com', password: 'secret1', returnSecureToken: true }), 'USER_DISABLED', `right (${mode})`);
                await expectIdentityToolkitError(client.signInWithPassword({ email: 'benched@example.com', password: 'wrong1', returnSecureToken: true }), 'USER_DISABLED', `wrong (${mode})`);
                await expectIdentityToolkitError(
                    client.signInWithCustomToken({ token: await auth.createCustomToken('benched'), returnSecureToken: true }),
                    'USER_DISABLED',
                    `custom token (${mode})`,
                );
            });
        });

        it('signs in with a custom token, carrying its claims', async () => {
            await testAllImplementations(async (auth, mode, client) => {
                await auth.createUser({ uid: 'custom', email: 'custom@example.com' });

                const response = await client.signInWithCustomToken({ token: await auth.createCustomToken('custom', { role: 'admin' }), returnSecureToken: true });

                expect(response, `response (${mode})`).toMatchObject({ idToken: expect.any(String), refreshToken: expect.any(String), expiresIn: '3600' });
                const decoded = await auth.verifyIdToken(response.idToken, true);
                expect(decoded, `claims (${mode})`).toMatchObject({ uid: 'custom', role: 'admin', firebase: { identities: { email: ['custom@example.com'] }, sign_in_provider: 'custom' } });
            });
        });

        it('refuses a malformed custom token, and an ID token', async () => {
            await testAllImplementations(async (auth, mode, client) => {
                await auth.createUser({ uid: 'mistaken' });
                const idToken = await signIn(auth, mode, 'mistaken');

                await expectIdentityToolkitError(client.signInWithCustomToken({ token: 'garbage', returnSecureToken: true }), 'INVALID_CUSTOM_TOKEN : Invalid assertion format', `garbage (${mode})`);
                await expectIdentityToolkitError(
                    client.signInWithCustomToken({ token: idToken, returnSecureToken: true }),
                    `INVALID_CUSTOM_TOKEN : ((Invalid aud (audience): ${EMULATOR_PROJECT_ID} Note: Firebase ID Tokens / third-party tokens cannot be used with signInWithCustomToken.))`,
                    `ID token (${mode})`,
                );
            });
        });
    });
});
