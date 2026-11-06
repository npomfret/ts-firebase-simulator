/**
 * Integration Test: StubAuth vs Auth Emulator
 *
 * Verifies that StubAuth mirrors Firebase Auth by executing identical operations
 * against both implementations:
 * 1. Stub (in-memory) - always runs
 * 2. Emulator - runs when FIREBASE_AUTH_EMULATOR_HOST is set
 *
 * 3. Real Firebase - runs when a service account is available and the Auth emulator
 *    is not: the Admin SDK sends every app's Auth calls to the emulator while
 *    FIREBASE_AUTH_EMULATOR_HOST is set, so `npm run test:integration` runs this
 *    mode and `npm run test:with-emulator` the emulator's.
 *
 * Real mode deletes every account in the project and in its tenants before each
 * test. The project needs Identity Platform multi-tenancy with two tenants named
 * `tenant-1` and `tenant-2`, Email/Password enabled in each and in the project,
 * and a web app, whose API key the REST client uses.
 *
 * Configuration:
 * - Stub: No configuration needed
 * - Emulator: Run `firebase emulators:start` or use `npm run test:with-emulator`
 * - Real: Place service-account-key.json in the project root or set GOOGLE_APPLICATION_CREDENTIALS
 */

import { cert, getApps, initializeApp, type ServiceAccount } from 'firebase-admin/app';
import { type Auth, getAuth, type UserRecord } from 'firebase-admin/auth';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createAuth, createAuthClient, createTenantManager, type IAuth, type IAuthClient, IdentityToolkitError, type ITenantAwareAuth, type ITenantManager, StubAuth } from 'ts-firebase-simulator';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

type TestMode = 'stub' | 'emulator' | 'real';

const EMULATOR_PROJECT_ID = 'demo-test-project';
const EMULATOR_APP_NAME = 'auth-emulator-app';
const REAL_APP_NAME = 'auth-real-app';
/** The display names of the real project's tenants; Identity Platform generates their IDs */
const REAL_TENANT_NAMES = ['tenant-1', 'tenant-2'] as const;
/** The emulator creates a tenant the first time it is used */
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
/** A tenant ID no implementation's project has; the emulator creates it on use */
const UNKNOWN_TENANT = 'no-such-tenant';

function emulatorHost(): string | undefined {
    return process.env.FIREBASE_AUTH_EMULATOR_HOST;
}

function getServiceAccountPath(): string | null {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        return process.env.GOOGLE_APPLICATION_CREDENTIALS;
    }
    // __dirname is src/__tests__/integration, go up 3 levels to package root
    const localPath = path.resolve(__dirname, '../../..', 'service-account-key.json');
    return fs.existsSync(localPath) ? localPath : null;
}

/** The real project's Admin Auth, its tenants' IDs and a REST client with its web API key */
interface RealProject {
    projectId: string;
    auth: Auth;
    tenantIds: [string, string];
    client: IAuthClient;
}

async function connectRealProject(serviceAccountPath: string): Promise<RealProject> {
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8')) as ServiceAccount & { project_id: string; };
    const credential = cert(serviceAccount);
    const app = getApps().find((existing) => existing.name === REAL_APP_NAME)
        ?? initializeApp({ credential, projectId: serviceAccount.project_id }, REAL_APP_NAME);
    const auth = getAuth(app);

    const { tenants } = await auth.tenantManager().listTenants();
    const tenantIds = REAL_TENANT_NAMES.map((name) => {
        const tenant = tenants.find((candidate) => candidate.displayName === name);
        if (!tenant) {
            throw new Error(`Real project ${serviceAccount.project_id} has no tenant named ${name}; found ${tenants.map((t) => t.displayName).join(', ') || 'none'}`);
        }
        return tenant.tenantId;
    }) as [string, string];

    return {
        projectId: serviceAccount.project_id,
        auth,
        tenantIds,
        client: createAuthClient({ apiKey: await webApiKey(serviceAccount.project_id, credential), baseUrl: 'https://identitytoolkit.googleapis.com' }),
    };
}

/** The API key of the project's first web app, from the Firebase Management API */
async function webApiKey(projectId: string, credential: ReturnType<typeof cert>): Promise<string> {
    const headers = { Authorization: `Bearer ${(await credential.getAccessToken()).access_token}` };
    const appsResponse = await fetch(`https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps`, { headers });
    const { apps } = (await appsResponse.json()) as { apps?: { name: string; }[]; };
    if (!appsResponse.ok || !apps?.length) {
        throw new Error(`Real project ${projectId} has no web app to take an API key from: HTTP ${appsResponse.status}`);
    }
    const configResponse = await fetch(`https://firebase.googleapis.com/v1beta1/${apps[0].name}/config`, { headers });
    const { apiKey } = (await configResponse.json()) as { apiKey?: string; };
    if (!configResponse.ok || !apiKey) {
        throw new Error(`Reading the web app config of ${projectId} failed: HTTP ${configResponse.status}`);
    }
    return apiKey;
}

/** Deletes every account in the real project and its tenants */
async function clearRealAccounts(real: RealProject): Promise<void> {
    for (const auth of [real.auth, ...real.tenantIds.map((tenantId) => real.auth.tenantManager().authForTenant(tenantId))]) {
        const { users } = await auth.listUsers(1000);
        if (users.length > 0) {
            const result = await auth.deleteUsers(users.map((user) => user.uid));
            if (result.failureCount > 0) {
                throw new Error(`Clearing real accounts failed: ${result.errors.map((e) => e.error.message).join('; ')}`);
            }
        }
    }
}

function getEmulatorApp() {
    return getApps().find((existing) => existing.name === EMULATOR_APP_NAME) ?? initializeApp({ projectId: EMULATOR_PROJECT_ID }, EMULATOR_APP_NAME);
}

function getEmulatorAuth(): IAuth {
    return createAuth(getAuth(getEmulatorApp()));
}

function getEmulatorTenantManager(): ITenantManager {
    return createTenantManager(getAuth(getEmulatorApp()).tenantManager());
}

function getEmulatorAuthClient(): IAuthClient {
    return createAuthClient({ apiKey: 'fake-api-key', baseUrl: `http://${emulatorHost()}/identitytoolkit.googleapis.com` });
}

/** Deletes every account in the emulator's project, and in the tenants the tests use */
async function clearEmulatorAccounts(): Promise<void> {
    const project = `http://${emulatorHost()}/emulator/v1/projects/${EMULATOR_PROJECT_ID}`;
    for (const url of [`${project}/accounts`, `${project}/tenants/${TENANT_A}/accounts`, `${project}/tenants/${TENANT_B}/accounts`]) {
        const response = await fetch(url, { method: 'DELETE' });
        if (!response.ok) {
            throw new Error(`Clearing emulator accounts at ${url} failed: HTTP ${response.status}`);
        }
    }
}

/**
 * Turns on email enumeration protection in the emulator's project, as the real project and the
 * stub's project pool have it. The emulator's tenants take the project's setting.
 */
async function enableEmulatorEmailEnumerationProtection(): Promise<void> {
    const response = await fetch(`http://${emulatorHost()}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailPrivacyConfig: { enableImprovedEmailPrivacy: true } }),
    });
    if (!response.ok) {
        throw new Error(`Configuring the emulator's email privacy failed: HTTP ${response.status}`);
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

/** A JWT's payload, read without verifying it */
function jwtPayload(token: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** The oobCode an action link carries */
function oobCodeOf(link: string): string {
    return new URL(link).searchParams.get('oobCode')!;
}

/** A Firebase metadata time: a UTC string within a few seconds of now */
function expectRecentUtcString(value: string | null | undefined, label: string): void {
    expect(value, label).toBe(new Date(Date.parse(value!)).toUTCString());
    expect(Math.abs(Date.now() - Date.parse(value!)), label).toBeLessThan(5000);
}

/**
 * Real Firebase answers each Auth call in about 200-400 ms, so a test making 20 to 30 of them took
 * up to 9.1 s, and in an earlier run over 11.7 s, against the 10 s default (6 November 2026). The
 * user approved a longer limit for that latency, for the real mode only: 20 s, about 1.7 times the
 * worst seen. The stub and emulator modes keep the default.
 */
const REAL_FIREBASE_TEST_TIMEOUT_MS = 20_000;
const realModeRuns = !process.env.FIREBASE_AUTH_EMULATOR_HOST && getServiceAccountPath() !== null;

describe('Auth Stub Compatibility - Integration Test', { timeout: realModeRuns ? REAL_FIREBASE_TEST_TIMEOUT_MS : undefined }, () => {
    let stubAuth: StubAuth;
    let emulatorAuth: IAuth | null = null;
    let emulatorAuthClient: IAuthClient | null = null;
    let emulatorTenantManager: ITenantManager | null = null;
    let real: RealProject | null = null;
    let realAuth: IAuth | null = null;
    let realTenantManager: ITenantManager | null = null;
    const emulatorAvailable = !!emulatorHost();
    const serviceAccountPath = getServiceAccountPath();
    const realAvailable = realModeRuns;

    beforeAll(async () => {
        console.log(`Auth test modes: stub=yes, emulator=${emulatorAvailable ? 'yes' : 'no'}, real=${realAvailable ? 'yes' : 'no'}`);
        if (emulatorAvailable) {
            emulatorAuth = getEmulatorAuth();
            emulatorAuthClient = getEmulatorAuthClient();
            emulatorTenantManager = getEmulatorTenantManager();
            await enableEmulatorEmailEnumerationProtection();
        }
        if (realAvailable) {
            real = await connectRealProject(serviceAccountPath!);
            realAuth = createAuth(real.auth);
            realTenantManager = createTenantManager(real.auth.tenantManager());
        }
    });

    beforeEach(async () => {
        stubAuth = new StubAuth({ projectId: EMULATOR_PROJECT_ID, tenants: { [TENANT_A]: {}, [TENANT_B]: {} } });
        if (emulatorAvailable) {
            await clearEmulatorAccounts();
        }
        if (real) {
            await clearRealAccounts(real);
        }
    });

    function projectIdOf(mode: TestMode): string {
        return mode === 'real' ? real!.projectId : EMULATOR_PROJECT_ID;
    }

    /** An ID token for the user, from a custom-token sign-in */
    async function signIn(auth: IAuth, mode: TestMode, uid: string): Promise<string> {
        if (mode === 'stub') {
            return stubAuth.issueIdToken(uid);
        }
        if (mode === 'emulator') {
            return emulatorSignIn(auth, uid);
        }
        return (await real!.client.signInWithCustomToken({ token: await auth.createCustomToken(uid), returnSecureToken: true })).idToken;
    }

    /** Lets the clock pass into a later second, which revocation needs to tell tokens apart */
    async function passOneSecond(mode: TestMode): Promise<void> {
        if (mode === 'stub') {
            stubAuth.advanceClock(1000);
        } else {
            await new Promise((resolve) => setTimeout(resolve, 1100));
        }
    }

    /**
     * Runs the test against each implementation. The tests assert real Firebase's behaviour, which
     * the stub matches; where the emulator differs, the test says so with `mode === 'emulator'`.
     */
    async function testAllImplementations(testFn: (auth: IAuth, mode: TestMode, client: IAuthClient) => Promise<void>) {
        await testFn(stubAuth, 'stub', stubAuth.client());
        if (emulatorAuth && emulatorAuthClient) {
            await testFn(emulatorAuth, 'emulator', emulatorAuthClient);
        }
        if (realAuth && real) {
            await testFn(realAuth, 'real', real.client);
        }
    }

    /** The project's pool and two tenants' pools of one implementation, and a tenant its project does not have */
    interface Pools {
        root: IAuth;
        a: ITenantAwareAuth;
        b: ITenantAwareAuth;
        unknown: ITenantAwareAuth;
    }

    async function testAllTenantImplementations(testFn: (pools: Pools, mode: TestMode, client: IAuthClient) => Promise<void>) {
        const stubTenants = stubAuth.tenantManager();
        await testFn({ root: stubAuth, a: stubTenants.authForTenant(TENANT_A), b: stubTenants.authForTenant(TENANT_B), unknown: stubTenants.authForTenant(UNKNOWN_TENANT) }, 'stub', stubAuth.client());
        if (emulatorAuth && emulatorAuthClient && emulatorTenantManager) {
            await testFn(
                {
                    root: emulatorAuth,
                    a: emulatorTenantManager.authForTenant(TENANT_A),
                    b: emulatorTenantManager.authForTenant(TENANT_B),
                    unknown: emulatorTenantManager.authForTenant(UNKNOWN_TENANT),
                },
                'emulator',
                emulatorAuthClient,
            );
        }
        if (realAuth && real && realTenantManager) {
            const [tenantA, tenantB] = real.tenantIds;
            await testFn(
                { root: realAuth, a: realTenantManager.authForTenant(tenantA), b: realTenantManager.authForTenant(tenantB), unknown: realTenantManager.authForTenant(UNKNOWN_TENANT) },
                'real',
                real.client,
            );
        }
    }

    /** An ID token for the pool's user, from a custom-token sign-in through the REST API in that pool */
    async function signInToPool(client: IAuthClient, auth: IAuth | ITenantAwareAuth, uid: string): Promise<string> {
        const tenantId = 'tenantId' in auth ? auth.tenantId : undefined;
        return (await client.signInWithCustomToken({ token: await auth.createCustomToken(uid), returnSecureToken: true, tenantId })).idToken;
    }

    /** Expects the call to fail as the REST API fails it: an IdentityToolkitError, by default with HTTP 400 */
    async function expectIdentityToolkitError(call: Promise<unknown>, message: string, label: string, status = 400): Promise<void> {
        const error = await call.then(() => undefined, (thrown: unknown) => thrown);
        expect(error, label).toBeInstanceOf(IdentityToolkitError);
        expect(error, label).toMatchObject({ status, reason: message.split(' : ')[0], message });
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
                // The emulator counts creating an account as its first sign-in
                expect(user.metadata.lastSignInTime, `lastSignInTime (${mode})`).toBe(mode === 'emulator' ? user.metadata.creationTime : null);
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

                const passwordProvider = { uid: 'full@example.com', displayName: 'Full', email: 'full@example.com', photoURL: 'https://example.com/full.png', providerId: 'password' };
                const phoneProvider = { uid: '+15555550100', providerId: 'phone', phoneNumber: '+15555550100' };
                const { metadata, tokensValidAfterTime, ...json } = user.toJSON() as Record<string, unknown>;
                expect(json, `toJSON (${mode})`).toEqual({
                    uid: 'full-user',
                    email: 'full@example.com',
                    emailVerified: true,
                    displayName: 'Full',
                    photoURL: 'https://example.com/full.png',
                    phoneNumber: '+15555550100',
                    disabled: true,
                    // The emulator lists the password provider first
                    providerData: mode === 'emulator' ? [passwordProvider, phoneProvider] : [phoneProvider, passwordProvider],
                    // The emulator's fake hash; the stub keeps no hash
                    ...(mode === 'emulator' ? { passwordHash: expect.any(String), passwordSalt: expect.any(String) } : {}),
                });
                expect(Object.keys(metadata as object), `metadata (${mode})`).toEqual(['lastSignInTime', 'creationTime', 'lastRefreshTime']);
                expect(tokensValidAfterTime, `tokensValidAfterTime (${mode})`).toEqual(expect.any(String));
            });
        });

        it('gives a user without a password no provider, and every user a tokensValidAfterTime', async () => {
            await testAllImplementations(async (auth, mode) => {
                const withEmail = await auth.createUser({ uid: 'email-only', email: 'email-only@example.com' });
                const withPassword = await auth.createUser({ uid: 'password-only', password: 'secret1' });

                expect(withEmail.providerData, `email only: providerData (${mode})`).toEqual([]);
                // The emulator gives an account tokensValidAfterTime only with a password
                if (mode === 'emulator') {
                    expect(withEmail.tokensValidAfterTime, `email only: tokensValidAfterTime (${mode})`).toBeUndefined();
                } else {
                    expectRecentUtcString(withEmail.tokensValidAfterTime, `email only: tokensValidAfterTime (${mode})`);
                }
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
                const created = await auth.createUser({ uid: 'updated', email: 'updated@example.com', displayName: 'Before', photoURL: 'https://example.com/before.png' });

                const user = await auth.updateUser('updated', { displayName: 'After', emailVerified: true, disabled: true });

                expect(user.displayName, `displayName (${mode})`).toBe('After');
                expect(user.emailVerified, `emailVerified (${mode})`).toBe(true);
                expect(user.disabled, `disabled (${mode})`).toBe(true);
                expect(user.email, `email (${mode})`).toBe('updated@example.com');
                expect(user.photoURL, `photoURL (${mode})`).toBe('https://example.com/before.png');
                expect(user.tokensValidAfterTime, `tokensValidAfterTime unchanged (${mode})`).toBe(created.tokensValidAfterTime);
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
                const idToken = await signIn(auth, mode, 'mover');
                const before = await auth.getUser('mover');

                // Every account has tokensValidAfterTime from creation, so the change must land in a later second to show it moved
                await passOneSecond(mode);
                const user = await auth.updateUser('mover', { email: 'After@Example.com' });

                expect(user.email, `email (${mode})`).toBe('after@example.com');
                expectRecentUtcString(user.tokensValidAfterTime, `tokensValidAfterTime (${mode})`);
                // The emulator gives an account tokensValidAfterTime only with a password, so it has none to move from
                if (mode === 'emulator') {
                    expect(before.tokensValidAfterTime, `tokensValidAfterTime before (${mode})`).toBeUndefined();
                } else {
                    expect(Date.parse(user.tokensValidAfterTime!), `tokensValidAfterTime moved (${mode})`).toBeGreaterThan(Date.parse(before.tokensValidAfterTime!));
                }
                await expect(auth.verifyIdToken(idToken, true), `earlier ID token (${mode})`).rejects.toMatchObject({ code: 'auth/id-token-revoked' });
                expect(user.metadata.lastRefreshTime, `lastRefreshTime unchanged (${mode})`).toBe(before.metadata.lastRefreshTime);
                await expect(auth.getUserByEmail('before@example.com'), `old email (${mode})`).rejects.toMatchObject({ code: 'auth/user-not-found' });
            });
        });

        it('adds the password provider and revalidates tokens when a password is set', async () => {
            await testAllImplementations(async (auth, mode) => {
                await auth.createUser({ uid: 'new-password', email: 'new-password@example.com' });
                const idToken = await signIn(auth, mode, 'new-password');
                const before = await auth.getUser('new-password');

                // Every account has tokensValidAfterTime from creation, so the change must land in a later second to show it moved
                await passOneSecond(mode);
                const user = await auth.updateUser('new-password', { password: 'secret2' });

                expect(user.providerData.map((info) => info.toJSON()), `providerData (${mode})`).toEqual([
                    { uid: 'new-password@example.com', email: 'new-password@example.com', providerId: 'password' },
                ]);
                expectRecentUtcString(user.tokensValidAfterTime, `tokensValidAfterTime (${mode})`);
                // The emulator gives an account tokensValidAfterTime only with a password, so it has none to move from
                if (mode === 'emulator') {
                    expect(before.tokensValidAfterTime, `tokensValidAfterTime before (${mode})`).toBeUndefined();
                } else {
                    expect(Date.parse(user.tokensValidAfterTime!), `tokensValidAfterTime moved (${mode})`).toBeGreaterThan(Date.parse(before.tokensValidAfterTime!));
                }
                await expect(auth.verifyIdToken(idToken, true), `earlier ID token (${mode})`).rejects.toMatchObject({ code: 'auth/id-token-revoked' });
                // The emulator counts a new password as refreshing the account
                if (mode === 'emulator') {
                    expect(Date.parse(user.metadata.lastRefreshTime!), `lastRefreshTime moved (${mode})`).toBeGreaterThan(Date.parse(before.metadata.lastRefreshTime!));
                } else {
                    expect(user.metadata.lastRefreshTime, `lastRefreshTime unchanged (${mode})`).toBe(before.metadata.lastRefreshTime);
                }
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
                    aud: projectIdOf(mode),
                    iss: `https://securetoken.google.com/${projectIdOf(mode)}`,
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

                // The emulator gives every token email_verified; Firebase only an account with an email
                expect(decoded.email_verified, `email_verified (${mode})`).toBe(mode === 'emulator' ? false : undefined);
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
                // The emulator gives an account tokensValidAfterTime only with a password
                expect(user.tokensValidAfterTime, `tokensValidAfterTime (${mode})`).toBe(mode === 'emulator' ? undefined : user.metadata.creationTime);
                expect(user.metadata.lastSignInTime, `lastSignInTime (${mode})`).toBe(user.metadata.creationTime);
                expect(user.metadata.lastRefreshTime, `lastRefreshTime (${mode})`).toBe(user.metadata.creationTime);
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
                    message: `Firebase ID token has incorrect "iss" (issuer) claim. Expected "https://securetoken.google.com/${projectIdOf(mode)}" but got "https://session.firebase.google.com/${
                        projectIdOf(mode)
                    }". Make sure the ID token comes from the same Firebase project as the service account used to authenticate this SDK. See https://firebase.google.com/docs/auth/admin/verify-id-tokens for details on how to retrieve an ID token.`,
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
                    iss: `https://session.firebase.google.com/${projectIdOf(mode)}`,
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

        it('signs in without asking for tokens, and returns only an ID token', async () => {
            await testAllImplementations(async (auth, mode, client) => {
                await auth.createUser({ uid: 'checker', email: 'checker@example.com', password: 'secret1' });

                const response = await client.signInWithPassword({ email: 'checker@example.com', password: 'secret1', returnSecureToken: false });

                expect(response, `response (${mode})`).toMatchObject({ localId: 'checker', email: 'checker@example.com', idToken: expect.any(String) });
                // The emulator returns a refresh token whatever returnSecureToken asks for
                expect(response.refreshToken, `refreshToken (${mode})`).toEqual(mode === 'emulator' ? expect.any(String) : undefined);
            });
        });

        it('refuses a wrong password, and a user without one, without saying which', async () => {
            await testAllImplementations(async (auth, mode, client) => {
                await auth.createUser({ uid: 'guarded', email: 'guarded@example.com', password: 'secret1' });
                await auth.createUser({ uid: 'passwordless', email: 'passwordless@example.com' });

                // The project pool has email enumeration protection
                await expectIdentityToolkitError(
                    client.signInWithPassword({ email: 'guarded@example.com', password: 'wrong1', returnSecureToken: true }),
                    'INVALID_LOGIN_CREDENTIALS',
                    `wrong (${mode})`,
                );
                await expectIdentityToolkitError(
                    client.signInWithPassword({ email: 'passwordless@example.com', password: 'secret1', returnSecureToken: true }),
                    'INVALID_LOGIN_CREDENTIALS',
                    `none (${mode})`,
                );
            });
        });

        it('refuses an unknown email as it refuses a wrong password', async () => {
            await testAllImplementations(async (_auth, mode, client) => {
                await expectIdentityToolkitError(
                    client.signInWithPassword({ email: 'nobody@example.com', password: 'secret1', returnSecureToken: true }),
                    'INVALID_LOGIN_CREDENTIALS',
                    `unknown (${mode})`,
                );
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

                // The emulator words both refusals differently
                await expectIdentityToolkitError(
                    client.signInWithCustomToken({ token: 'garbage', returnSecureToken: true }),
                    mode === 'emulator' ? 'INVALID_CUSTOM_TOKEN : Invalid assertion format' : 'INVALID_CUSTOM_TOKEN : Invalid assertion format. 3 dot separated segments required.',
                    `garbage (${mode})`,
                );
                await expectIdentityToolkitError(
                    client.signInWithCustomToken({ token: idToken, returnSecureToken: true }),
                    mode === 'emulator'
                        ? `INVALID_CUSTOM_TOKEN : ((Invalid aud (audience): ${projectIdOf(mode)} Note: Firebase ID Tokens / third-party tokens cannot be used with signInWithCustomToken.))`
                        : 'INVALID_CUSTOM_TOKEN',
                    `ID token (${mode})`,
                );
            });
        });
    });

    describe('action codes', () => {
        it('reads a password-reset code without using it, then resets the password once', async () => {
            await testAllImplementations(async (auth, mode, client) => {
                await auth.createUser({ uid: 'forgetful', email: 'forgetful@example.com', password: 'secret1' });
                const idToken = await signIn(auth, mode, 'forgetful');
                const before = await auth.getUser('forgetful');
                const link = await auth.generatePasswordResetLink('Forgetful@Example.com');
                const oobCode = oobCodeOf(link);
                const read = { requestType: 'PASSWORD_RESET', email: 'forgetful@example.com' };

                expect(new URL(link).searchParams.get('mode'), `mode (${mode})`).toBe('resetPassword');
                expect(await client.resetPassword({ oobCode }), `first read (${mode})`).toMatchObject(read);
                expect(await client.resetPassword({ oobCode }), `second read (${mode})`).toMatchObject(read);

                await passOneSecond(mode);
                const reset = await client.resetPassword({ oobCode, newPassword: 'secret2' });

                expect(reset, `reset (${mode})`).toMatchObject(read);
                expect(reset.newEmail, `newEmail (${mode})`).toBeUndefined();
                const user = await auth.getUser('forgetful');
                expect(user.emailVerified, `emailVerified (${mode})`).toBe(true);
                expect(user.tokensValidAfterTime, `tokensValidAfterTime (${mode})`).not.toBe(before.tokensValidAfterTime);
                expectRecentUtcString(user.tokensValidAfterTime, `tokensValidAfterTime (${mode})`);
                expect(user.metadata.lastRefreshTime, `lastRefreshTime (${mode})`).toBe(before.metadata.lastRefreshTime);
                await expect(auth.verifyIdToken(idToken, true), `old ID token (${mode})`).rejects.toMatchObject({ code: 'auth/id-token-revoked' });
                await expect(client.signInWithPassword({ email: 'forgetful@example.com', password: 'secret2', returnSecureToken: true }), `new password (${mode})`).resolves.toMatchObject({
                    localId: 'forgetful',
                });
                await expectIdentityToolkitError(client.resetPassword({ oobCode, newPassword: 'secret3' }), 'INVALID_OOB_CODE', `reset again (${mode})`);
                await expectIdentityToolkitError(client.resetPassword({ oobCode }), 'INVALID_OOB_CODE', `read again (${mode})`);
            });
        });

        it('refuses a weak password, leaving the code usable', async () => {
            await testAllImplementations(async (auth, mode, client) => {
                await auth.createUser({ uid: 'weak', email: 'weak@example.com', password: 'secret1' });
                const oobCode = oobCodeOf(await auth.generatePasswordResetLink('weak@example.com'));

                await expectIdentityToolkitError(client.resetPassword({ oobCode, newPassword: '12345' }), 'WEAK_PASSWORD : Password should be at least 6 characters', `weak (${mode})`);
                await expect(client.resetPassword({ oobCode, newPassword: '123456' }), `strong enough (${mode})`).resolves.toMatchObject({ requestType: 'PASSWORD_RESET' });
            });
        });

        it('refuses a code of the wrong type for the call, leaving it usable', async () => {
            await testAllImplementations(async (auth, mode, client) => {
                await auth.createUser({ uid: 'mixed', email: 'mixed@example.com', password: 'secret1' });
                const verifyCode = oobCodeOf(await auth.generateEmailVerificationLink('mixed@example.com'));
                const resetCode = oobCodeOf(await auth.generatePasswordResetLink('mixed@example.com'));

                await expectIdentityToolkitError(client.resetPassword({ oobCode: verifyCode, newPassword: 'secret2' }), 'INVALID_OOB_CODE', `verify code reset (${mode})`);
                // The emulator does not implement applying a password-reset code: it answers 501
                if (mode === 'emulator') {
                    await expectIdentityToolkitError(client.applyActionCode({ oobCode: resetCode }), 'PASSWORD_RESET', `reset code applied (${mode})`, 501);
                } else {
                    await expectIdentityToolkitError(client.applyActionCode({ oobCode: resetCode }), 'INVALID_OOB_CODE', `reset code applied (${mode})`);
                }

                await expect(client.resetPassword({ oobCode: verifyCode }), `verify code (${mode})`).resolves.toMatchObject({ requestType: 'VERIFY_EMAIL' });
                await expect(client.resetPassword({ oobCode: resetCode }), `reset code (${mode})`).resolves.toMatchObject({ requestType: 'PASSWORD_RESET' });
            });
        });

        it('verifies an email once, without revoking tokens', async () => {
            await testAllImplementations(async (auth, mode, client) => {
                const created = await auth.createUser({ uid: 'unverified', email: 'unverified@example.com' });
                const idToken = await signIn(auth, mode, 'unverified');
                const link = await auth.generateEmailVerificationLink('Unverified@Example.com');
                const oobCode = oobCodeOf(link);

                expect(new URL(link).searchParams.get('mode'), `mode (${mode})`).toBe('verifyEmail');
                expect(await client.resetPassword({ oobCode }), `read (${mode})`).toMatchObject({ requestType: 'VERIFY_EMAIL', email: 'unverified@example.com' });

                await passOneSecond(mode);
                const applied = await client.applyActionCode({ oobCode });

                expect(applied, `applied (${mode})`).toMatchObject({ localId: 'unverified', email: 'unverified@example.com', emailVerified: true });
                const user = await auth.getUser('unverified');
                expect(user.emailVerified, `emailVerified (${mode})`).toBe(true);
                expect(user.tokensValidAfterTime, `tokensValidAfterTime unchanged (${mode})`).toBe(created.tokensValidAfterTime);
                await expect(auth.verifyIdToken(idToken, true), `ID token (${mode})`).resolves.toMatchObject({ uid: 'unverified' });
                await expectIdentityToolkitError(client.applyActionCode({ oobCode }), 'INVALID_OOB_CODE', `applied again (${mode})`);
            });
        });

        it('changes the email once, verified, revoking earlier tokens', async () => {
            await testAllImplementations(async (auth, mode, client) => {
                await auth.createUser({ uid: 'mover', email: 'mover@example.com' });
                const idToken = await signIn(auth, mode, 'mover');
                const link = await auth.generateVerifyAndChangeEmailLink('Mover@Example.com', 'Moved@Example.com');
                const oobCode = oobCodeOf(link);

                expect(new URL(link).searchParams.get('mode'), `mode (${mode})`).toBe('verifyAndChangeEmail');
                expect(await client.resetPassword({ oobCode }), `read (${mode})`).toMatchObject({
                    requestType: 'VERIFY_AND_CHANGE_EMAIL',
                    email: 'mover@example.com',
                    newEmail: 'moved@example.com',
                });

                await passOneSecond(mode);
                const applied = await client.applyActionCode({ oobCode });

                expect(applied, `applied (${mode})`).toMatchObject({ localId: 'mover', email: 'moved@example.com', emailVerified: true });
                expect((await auth.getUserByEmail('moved@example.com')).uid, `new email (${mode})`).toBe('mover');
                await expect(auth.getUserByEmail('mover@example.com'), `old email (${mode})`).rejects.toMatchObject({ code: 'auth/user-not-found' });
                // The emulator neither revokes tokens on an email change nor returns newEmail
                if (mode === 'emulator') {
                    expect((await auth.getUser('mover')).tokensValidAfterTime, `tokensValidAfterTime (${mode})`).toBeUndefined();
                    await expect(auth.verifyIdToken(idToken, true), `ID token (${mode})`).resolves.toMatchObject({ uid: 'mover' });
                } else {
                    expect(applied.newEmail, `newEmail (${mode})`).toBe('moved@example.com');
                    expectRecentUtcString((await auth.getUser('mover')).tokensValidAfterTime, `tokensValidAfterTime (${mode})`);
                    await expect(auth.verifyIdToken(idToken, true), `ID token (${mode})`).rejects.toMatchObject({ code: 'auth/id-token-revoked' });
                }
                await expectIdentityToolkitError(client.applyActionCode({ oobCode }), 'INVALID_OOB_CODE', `applied again (${mode})`);
            });
        });

        it('refuses an email change to an address taken meanwhile, leaving the code usable', async () => {
            await testAllImplementations(async (auth, mode, client) => {
                await auth.createUser({ uid: 'slow', email: 'slow@example.com' });
                const oobCode = oobCodeOf(await auth.generateVerifyAndChangeEmailLink('slow@example.com', 'wanted@example.com'));
                await auth.createUser({ uid: 'fast', email: 'wanted@example.com' });

                await expectIdentityToolkitError(client.applyActionCode({ oobCode }), 'EMAIL_EXISTS', `taken (${mode})`);

                expect((await auth.getUser('slow')).email, `email (${mode})`).toBe('slow@example.com');
                // The emulator uses the code up
                if (mode === 'emulator') {
                    await expectIdentityToolkitError(client.resetPassword({ oobCode }), 'INVALID_OOB_CODE', `read after (${mode})`);
                } else {
                    await expect(client.resetPassword({ oobCode }), `read after (${mode})`).resolves.toMatchObject({ requestType: 'VERIFY_AND_CHANGE_EMAIL', newEmail: 'wanted@example.com' });
                }
            });
        });

        it('refuses a code whose account no longer has its email', async () => {
            await testAllImplementations(async (auth, mode, client) => {
                await auth.createUser({ uid: 'renamed', email: 'before@example.com', password: 'secret1' });
                const resetCode = oobCodeOf(await auth.generatePasswordResetLink('before@example.com'));
                const verifyCode = oobCodeOf(await auth.generateEmailVerificationLink('before@example.com'));

                await auth.updateUser('renamed', { email: 'after@example.com' });

                // The emulator answers both as an invalid code
                const emulator = mode === 'emulator';
                await expectIdentityToolkitError(client.resetPassword({ oobCode: resetCode, newPassword: 'secret2' }), emulator ? 'INVALID_OOB_CODE' : 'USER_NOT_FOUND', `reset (${mode})`);
                await expectIdentityToolkitError(client.applyActionCode({ oobCode: verifyCode }), emulator ? 'INVALID_OOB_CODE' : 'EMAIL_NOT_FOUND', `verify (${mode})`);
            });
        });

        it('refuses an unknown code', async () => {
            await testAllImplementations(async (_auth, mode, client) => {
                await expectIdentityToolkitError(client.resetPassword({ oobCode: 'unknown' }), 'INVALID_OOB_CODE', `read (${mode})`);
                await expectIdentityToolkitError(client.resetPassword({ oobCode: 'unknown', newPassword: 'secret1' }), 'INVALID_OOB_CODE', `reset (${mode})`);
                await expectIdentityToolkitError(client.applyActionCode({ oobCode: 'unknown' }), 'INVALID_OOB_CODE', `apply (${mode})`);
            });
        });

        it('refuses a link for an unknown user, and withholds one that would reveal whether an email is in use', async () => {
            await testAllImplementations(async (auth, mode) => {
                await auth.createUser({ uid: 'settled', email: 'settled@example.com' });
                await auth.createUser({ uid: 'neighbour', email: 'neighbour@example.com' });
                // With email enumeration protection Firebase answers without a link, which the Admin SDK reports so
                const withheld = { code: 'auth/internal-error', message: 'INTERNAL ASSERT FAILED: Unable to create the email action link' };

                await expect(auth.generatePasswordResetLink('nobody@example.com'), `reset (${mode})`).rejects.toMatchObject(withheld);
                const userNotFound = { code: 'auth/user-not-found', message: 'There is no user record corresponding to the provided identifier.' };
                await expect(auth.generateEmailVerificationLink('nobody@example.com'), `verify (${mode})`).rejects.toMatchObject(userNotFound);
                await expect(auth.generateVerifyAndChangeEmailLink('nobody@example.com', 'free@example.com'), `change (${mode})`).rejects.toMatchObject(userNotFound);
                // The emulator says the new email is in use, despite email enumeration protection
                const inUse = mode === 'emulator' ? { code: 'auth/email-already-exists', message: 'The email address is already in use by another account.' } : withheld;
                await expect(auth.generateVerifyAndChangeEmailLink('settled@example.com', 'Neighbour@Example.com'), `taken (${mode})`).rejects.toMatchObject(inUse);
                await expect(auth.generateVerifyAndChangeEmailLink('settled@example.com', 'settled@example.com'), `own (${mode})`).rejects.toMatchObject(inUse);
            });
        });
    });

    describe('tenants', () => {
        const mismatchingTenant = { code: 'auth/mismatching-tenant-id', message: 'User tenant ID does not match with the current TenantAwareAuth tenant ID.' };
        const FIVE_MINUTES = 5 * 60 * 1000;

        it('refuses a tenant the project does not have, except for a custom token, which is signed locally', async () => {
            await testAllTenantImplementations(async ({ a, unknown }, mode, client) => {
                await a.createUser({ uid: 'member', email: 'member@example.com', password: 'secret1' });
                const idToken = await signInToPool(client, a, 'member');
                const customToken = await unknown.createCustomToken('member');
                expect(jwtPayload(customToken).tenant_id, `custom token (${mode})`).toBe(UNKNOWN_TENANT);

                if (mode === 'emulator') {
                    // The emulator creates a tenant the first time it is used, so it refuses nothing
                    await expect(unknown.getUser('member'), `getUser (${mode})`).rejects.toMatchObject({ code: 'auth/user-not-found' });
                    return;
                }
                // The Admin SDK maps Firebase's INVALID_TENANT_ID to no code of its own
                const refused = {
                    code: 'auth/internal-error',
                    message:
                        'An internal error has occurred. Raw server response: "{"error":{"code":400,"message":"INVALID_TENANT_ID","errors":[{"message":"INVALID_TENANT_ID","domain":"global","reason":"invalid"}]}}"',
                };
                await expect(unknown.createUser({ email: 'member@example.com', password: 'secret1' }), `createUser (${mode})`).rejects.toMatchObject(refused);
                await expect(unknown.getUser('member'), `getUser (${mode})`).rejects.toMatchObject(refused);
                await expect(unknown.getUserByEmail('member@example.com'), `getUserByEmail (${mode})`).rejects.toMatchObject(refused);
                await expect(unknown.listUsers(10), `listUsers (${mode})`).rejects.toMatchObject(refused);
                await expect(unknown.generatePasswordResetLink('member@example.com'), `reset link (${mode})`).rejects.toMatchObject(refused);
                // The user lookup checkRevoked makes is refused before the token's tenant is compared
                await expect(unknown.verifyIdToken(idToken, true), `verifyIdToken checkRevoked (${mode})`).rejects.toMatchObject(refused);

                await expectIdentityToolkitError(
                    client.signInWithPassword({ email: 'member@example.com', password: 'secret1', returnSecureToken: true, tenantId: UNKNOWN_TENANT }),
                    'INVALID_TENANT_ID',
                    `password sign-in (${mode})`,
                );
                await expectIdentityToolkitError(
                    client.signInWithCustomToken({ token: customToken, returnSecureToken: true, tenantId: UNKNOWN_TENANT }),
                    'INVALID_TENANT_ID',
                    `custom token sign-in (${mode})`,
                );
                await expectIdentityToolkitError(
                    client.signInWithCustomToken({ token: 'garbage', returnSecureToken: true, tenantId: UNKNOWN_TENANT }),
                    'INVALID_TENANT_ID',
                    `garbage token sign-in (${mode})`,
                );
                await expectIdentityToolkitError(client.resetPassword({ oobCode: 'none', tenantId: UNKNOWN_TENANT }), 'INVALID_TENANT_ID', `resetPassword (${mode})`);
                await expectIdentityToolkitError(client.applyActionCode({ oobCode: 'none', tenantId: UNKNOWN_TENANT }), 'INVALID_TENANT_ID', `applyActionCode (${mode})`);
            });
        });

        it('keeps the same email in each pool as a separate account with its own password', async () => {
            await testAllTenantImplementations(async ({ root, a, b }, mode, client) => {
                const inA = await a.createUser({ email: 'Shared@Example.com', password: 'password-a' });
                const inB = await b.createUser({ email: 'shared@example.com', password: 'password-b' });
                const inRoot = await root.createUser({ email: 'shared@example.com', password: 'password-root' });

                expect(new Set([inA.uid, inB.uid, inRoot.uid]).size, `separate uids (${mode})`).toBe(3);
                expect(inA.tenantId, `tenant A record (${mode})`).toBe(a.tenantId);
                expect(inB.tenantId, `tenant B record (${mode})`).toBe(b.tenantId);
                expect(inRoot.tenantId, `root record (${mode})`).toBeUndefined();
                expect((await a.getUserByEmail('shared@example.com')).toJSON(), `A lookup (${mode})`).toEqual(inA.toJSON());
                expect((await b.getUserByEmail('SHARED@example.com')).uid, `B lookup (${mode})`).toBe(inB.uid);
                expect((await root.getUserByEmail('shared@example.com')).uid, `root lookup (${mode})`).toBe(inRoot.uid);

                const signedInA = await client.signInWithPassword({ email: 'shared@example.com', password: 'password-a', returnSecureToken: true, tenantId: a.tenantId });
                expect(signedInA.localId, `A sign-in (${mode})`).toBe(inA.uid);
                expect((await a.verifyIdToken(signedInA.idToken!, true)).firebase, `A token (${mode})`).toEqual({
                    identities: { email: ['shared@example.com'] },
                    sign_in_provider: 'password',
                    tenant: a.tenantId,
                });
                const signedInB = await client.signInWithPassword({ email: 'shared@example.com', password: 'password-b', returnSecureToken: true, tenantId: b.tenantId });
                expect(signedInB.localId, `B sign-in (${mode})`).toBe(inB.uid);
                const signedInRoot = await client.signInWithPassword({ email: 'shared@example.com', password: 'password-root', returnSecureToken: true });
                expect(signedInRoot.localId, `root sign-in (${mode})`).toBe(inRoot.uid);
                expect((await root.verifyIdToken(signedInRoot.idToken!, true)).firebase.tenant, `root token (${mode})`).toBeUndefined();

                // The tenants have no email enumeration protection; the emulator's take the project's
                await expectIdentityToolkitError(
                    client.signInWithPassword({ email: 'shared@example.com', password: 'password-b', returnSecureToken: true, tenantId: a.tenantId }),
                    mode === 'emulator' ? 'INVALID_LOGIN_CREDENTIALS' : 'INVALID_PASSWORD',
                    `B's password in A (${mode})`,
                );
                await expectIdentityToolkitError(
                    client.signInWithPassword({ email: 'shared@example.com', password: 'password-a', returnSecureToken: true }),
                    'INVALID_LOGIN_CREDENTIALS',
                    `A's password in root (${mode})`,
                );
            });
        });

        it('refuses a duplicate email within a tenant, and finds users only in their own pool', async () => {
            await testAllTenantImplementations(async ({ root, a, b }, mode, client) => {
                await a.createUser({ uid: 'only-in-a', email: 'only-in-a@example.com', password: 'secret1' });

                await expect(a.createUser({ email: 'ONLY-IN-A@example.com' }), `duplicate in A (${mode})`).rejects.toMatchObject({ code: 'auth/email-already-exists' });
                await expect(b.getUser('only-in-a'), `B getUser (${mode})`).rejects.toMatchObject({ code: 'auth/user-not-found' });
                await expect(root.getUser('only-in-a'), `root getUser (${mode})`).rejects.toMatchObject({ code: 'auth/user-not-found' });
                await expect(b.getUserByEmail('only-in-a@example.com'), `B getUserByEmail (${mode})`).rejects.toMatchObject({ code: 'auth/user-not-found' });
                expect((await b.getUsers([{ uid: 'only-in-a' }])).notFound, `B getUsers (${mode})`).toEqual([{ uid: 'only-in-a' }]);
                expect((await a.getUsers([{ uid: 'only-in-a' }])).users.map((user) => user.uid), `A getUsers (${mode})`).toEqual(['only-in-a']);
                expect((await b.listUsers()).users, `B listUsers (${mode})`).toEqual([]);
                expect((await a.listUsers()).users.map((user) => user.uid), `A listUsers (${mode})`).toEqual(['only-in-a']);
                await expect(b.updateUser('only-in-a', { displayName: 'x' }), `B updateUser (${mode})`).rejects.toMatchObject({ code: 'auth/user-not-found' });
                await expect(b.deleteUser('only-in-a'), `B deleteUser (${mode})`).rejects.toMatchObject({ code: 'auth/user-not-found' });
                // The tenants have no email enumeration protection; the emulator's take the project's
                await expectIdentityToolkitError(
                    client.signInWithPassword({ email: 'only-in-a@example.com', password: 'secret1', returnSecureToken: true, tenantId: b.tenantId }),
                    mode === 'emulator' ? 'INVALID_LOGIN_CREDENTIALS' : 'EMAIL_NOT_FOUND',
                    `B sign-in (${mode})`,
                );

                await a.deleteUser('only-in-a');
                await expect(a.getUser('only-in-a'), `deleted from A (${mode})`).rejects.toMatchObject({ code: 'auth/user-not-found' });
            });
        });

        it('refuses an ID token and session cookie of another pool, after any revocation check', async () => {
            await testAllTenantImplementations(async ({ root, a, b }, mode, client) => {
                // The same uid in every pool, so a revocation check finds a user and the tenant is what is refused
                for (const pool of [root, a, b]) {
                    await pool.createUser({ uid: 'member' });
                }
                await a.createUser({ uid: 'a-only' });
                const tokenA = await signInToPool(client, a, 'member');
                const rootToken = await signInToPool(client, root, 'member');
                const cookieA = await a.createSessionCookie(tokenA, { expiresIn: FIVE_MINUTES });

                expect((await a.verifyIdToken(tokenA, true)).firebase.tenant, `A token in A (${mode})`).toBe(a.tenantId);
                expect(await a.verifySessionCookie(cookieA, true), `A cookie in A (${mode})`).toMatchObject({
                    uid: 'member',
                    iss: `https://session.firebase.google.com/${projectIdOf(mode)}`,
                    firebase: { tenant: a.tenantId },
                });

                await expect(b.verifyIdToken(tokenA, true), `A token in B (${mode})`).rejects.toMatchObject(mismatchingTenant);
                await expect(b.verifySessionCookie(cookieA, true), `A cookie in B (${mode})`).rejects.toMatchObject(mismatchingTenant);
                await expect(b.createSessionCookie(tokenA, { expiresIn: FIVE_MINUTES }), `A token to a B cookie (${mode})`).rejects.toMatchObject(mismatchingTenant);
                await expect(a.verifyIdToken(rootToken, true), `root token in A (${mode})`).rejects.toMatchObject(mismatchingTenant);
                await expect(a.createSessionCookie(rootToken, { expiresIn: FIVE_MINUTES }), `root token to an A cookie (${mode})`).rejects.toMatchObject(mismatchingTenant);

                // As the Admin SDK: the project-level instance compares no tenant, and looks the uid up in the project's own pool
                expect((await root.verifyIdToken(tokenA, true)).firebase.tenant, `A token at project level (${mode})`).toBe(a.tenantId);
                expect((await root.verifySessionCookie(cookieA, true)).firebase.tenant, `A cookie at project level (${mode})`).toBe(a.tenantId);
                await expect(root.verifyIdToken(await signInToPool(client, a, 'a-only'), true), `A-only user at project level (${mode})`).rejects.toMatchObject({
                    code: 'auth/user-not-found',
                });
                await expect(b.verifyIdToken(await signInToPool(client, a, 'a-only'), true), `A-only user in B (${mode})`).rejects.toMatchObject({ code: 'auth/user-not-found' });
            });
        });

        it('revokes tokens and cookies in one pool only', async () => {
            await testAllTenantImplementations(async ({ a, b }, mode, client) => {
                await a.createUser({ uid: 'member' });
                const createdInB = await b.createUser({ uid: 'member' });
                const tokenA = await signInToPool(client, a, 'member');
                const tokenB = await signInToPool(client, b, 'member');
                const cookieA = await a.createSessionCookie(tokenA, { expiresIn: FIVE_MINUTES });
                const cookieB = await b.createSessionCookie(tokenB, { expiresIn: FIVE_MINUTES });

                await passOneSecond(mode);
                await a.revokeRefreshTokens('member');

                expectRecentUtcString((await a.getUser('member')).tokensValidAfterTime, `A tokensValidAfterTime (${mode})`);
                expect((await b.getUser('member')).tokensValidAfterTime, `B tokensValidAfterTime unchanged (${mode})`).toBe(createdInB.tokensValidAfterTime);
                await expect(a.verifyIdToken(tokenA, true), `A token (${mode})`).rejects.toMatchObject({ code: 'auth/id-token-revoked' });
                await expect(a.verifySessionCookie(cookieA, true), `A cookie (${mode})`).rejects.toMatchObject({ code: 'auth/session-cookie-revoked' });
                await expect(b.verifyIdToken(tokenB, true), `B token (${mode})`).resolves.toMatchObject({ uid: 'member' });
                await expect(b.verifySessionCookie(cookieB, true), `B cookie (${mode})`).resolves.toMatchObject({ uid: 'member' });

                await passOneSecond(mode);
                await expect(a.verifyIdToken(await signInToPool(client, a, 'member'), true), `fresh A sign-in (${mode})`).resolves.toMatchObject({ uid: 'member' });
            });
        });

        it('mints custom tokens for its tenant, and refuses them in another tenant\'s sign-in', async () => {
            await testAllTenantImplementations(async ({ root, a, b }, mode, client) => {
                const tokenA = await a.createCustomToken('newcomer', { role: 'admin' });
                const rootCustomToken = await root.createCustomToken('newcomer');

                expect(jwtPayload(tokenA).tenant_id, `A custom token (${mode})`).toBe(a.tenantId);
                expect(jwtPayload(rootCustomToken).tenant_id, `root custom token (${mode})`).toBeUndefined();
                const emulator = mode === 'emulator';
                const mismatch = 'TENANT_ID_MISMATCH : Specified tenant ID does not match the custom token.';
                // The emulator words the refusal without detail
                await expectIdentityToolkitError(
                    client.signInWithCustomToken({ token: tokenA, returnSecureToken: true, tenantId: b.tenantId }),
                    emulator ? 'TENANT_ID_MISMATCH' : mismatch,
                    `A token in B (${mode})`,
                );
                // Firebase answers a project token in a tenant with an internal error; the emulator with a mismatch
                await expectIdentityToolkitError(
                    client.signInWithCustomToken({ token: rootCustomToken, returnSecureToken: true, tenantId: a.tenantId }),
                    emulator ? 'TENANT_ID_MISMATCH' : 'Internal error encountered.',
                    `root token in A (${mode})`,
                    emulator ? 400 : 500,
                );
                // The emulator signs a tenant's token in to the project's pool when no tenant is named
                const tokenAWithoutTenant = client.signInWithCustomToken({ token: await a.createCustomToken('a-token-in-root'), returnSecureToken: true });
                if (emulator) {
                    await expect(tokenAWithoutTenant, `A token without a tenant (${mode})`).resolves.toMatchObject({ idToken: expect.any(String) });
                } else {
                    await expectIdentityToolkitError(tokenAWithoutTenant, mismatch, `A token without a tenant (${mode})`);
                }

                const { idToken } = await client.signInWithCustomToken({ token: tokenA, returnSecureToken: true, tenantId: a.tenantId });

                expect(await a.verifyIdToken(idToken, true), `claims (${mode})`).toMatchObject({ uid: 'newcomer', role: 'admin', firebase: { sign_in_provider: 'custom', tenant: a.tenantId } });
                expect((await a.getUser('newcomer')).tenantId, `created in A (${mode})`).toBe(a.tenantId);
                await expect(b.getUser('newcomer'), `not in B (${mode})`).rejects.toMatchObject({ code: 'auth/user-not-found' });
                await expect(root.getUser('newcomer'), `not in root (${mode})`).rejects.toMatchObject({ code: 'auth/user-not-found' });
            });
        });

        it('resets the password in its own pool only, refusing the code in another pool', async () => {
            await testAllTenantImplementations(async ({ root, a, b }, mode, client) => {
                const inA = await a.createUser({ email: 'shared@example.com', password: 'password-a' });
                await b.createUser({ email: 'shared@example.com', password: 'password-b' });
                await root.createUser({ email: 'shared@example.com', password: 'password-root' });
                const link = await a.generatePasswordResetLink('shared@example.com');
                const oobCode = oobCodeOf(link);

                expect(new URL(link).searchParams.get('tenantId'), `link tenant (${mode})`).toBe(a.tenantId);
                await expectIdentityToolkitError(client.resetPassword({ oobCode, tenantId: b.tenantId }), 'INVALID_OOB_CODE', `read in B (${mode})`);
                await expectIdentityToolkitError(client.resetPassword({ oobCode, newPassword: 'changed1', tenantId: b.tenantId }), 'INVALID_OOB_CODE', `reset in B (${mode})`);
                await expectIdentityToolkitError(client.resetPassword({ oobCode, newPassword: 'changed1' }), 'INVALID_OOB_CODE', `reset in root (${mode})`);

                await expect(client.resetPassword({ oobCode, newPassword: 'changed1', tenantId: a.tenantId }), `reset in A (${mode})`).resolves.toMatchObject({
                    requestType: 'PASSWORD_RESET',
                    email: 'shared@example.com',
                });

                const signIn = (password: string, tenantId?: string) => client.signInWithPassword({ email: 'shared@example.com', password, returnSecureToken: true, tenantId });
                await expect(signIn('changed1', a.tenantId), `new A password (${mode})`).resolves.toMatchObject({ localId: inA.uid });
                // The tenants have no email enumeration protection; the emulator's take the project's
                const wrongPassword = mode === 'emulator' ? 'INVALID_LOGIN_CREDENTIALS' : 'INVALID_PASSWORD';
                await expectIdentityToolkitError(signIn('password-a', a.tenantId), wrongPassword, `old A password (${mode})`);
                await expectIdentityToolkitError(signIn('changed1', b.tenantId), wrongPassword, `new A password in B (${mode})`);
                await expect(signIn('password-b', b.tenantId), `B password (${mode})`).resolves.toMatchObject({ email: 'shared@example.com' });
                await expect(signIn('password-root'), `root password (${mode})`).resolves.toMatchObject({ email: 'shared@example.com' });
                expect((await b.getUserByEmail('shared@example.com')).emailVerified, `B unverified (${mode})`).toBe(false);
            });
        });

        it('verifies and changes an email in its own pool only, refusing the code in another pool', async () => {
            await testAllTenantImplementations(async ({ a, b }, mode, client) => {
                const inA = await a.createUser({ email: 'shared@example.com' });
                const inB = await b.createUser({ email: 'shared@example.com' });
                await b.createUser({ email: 'taken-in-b@example.com' });
                const verifyCode = oobCodeOf(await a.generateEmailVerificationLink('shared@example.com'));

                await expectIdentityToolkitError(client.applyActionCode({ oobCode: verifyCode, tenantId: b.tenantId }), 'INVALID_OOB_CODE', `verify in B (${mode})`);
                await expectIdentityToolkitError(client.applyActionCode({ oobCode: verifyCode }), 'INVALID_OOB_CODE', `verify in root (${mode})`);
                await expect(client.applyActionCode({ oobCode: verifyCode, tenantId: a.tenantId }), `verify in A (${mode})`).resolves.toMatchObject({
                    localId: inA.uid,
                    emailVerified: true,
                });
                expect((await b.getUser(inB.uid)).emailVerified, `B unverified (${mode})`).toBe(false);

                // An email in use in another pool is free in this one
                const changeLink = await a.generateVerifyAndChangeEmailLink('shared@example.com', 'taken-in-b@example.com');
                const changeCode = oobCodeOf(changeLink);
                expect(new URL(changeLink).searchParams.get('tenantId'), `link tenant (${mode})`).toBe(a.tenantId);
                await expectIdentityToolkitError(client.applyActionCode({ oobCode: changeCode, tenantId: b.tenantId }), 'INVALID_OOB_CODE', `change in B (${mode})`);
                await expect(client.applyActionCode({ oobCode: changeCode, tenantId: a.tenantId }), `change in A (${mode})`).resolves.toMatchObject({
                    localId: inA.uid,
                    email: 'taken-in-b@example.com',
                });

                expect((await a.getUserByEmail('taken-in-b@example.com')).uid, `A's new email (${mode})`).toBe(inA.uid);
                expect((await b.getUserByEmail('shared@example.com')).uid, `B keeps its email (${mode})`).toBe(inB.uid);
                expect((await b.getUserByEmail('taken-in-b@example.com')).uid, `B's other user (${mode})`).not.toBe(inA.uid);
            });
        });
    });
});
