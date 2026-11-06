import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StubAuth, StubAuthError } from '../../StubAuth';

describe('StubAuth', () => {
    let auth: StubAuth;

    const TENANTS = { 'tenant-a': {}, 'tenant-b': {} };

    beforeEach(() => {
        auth = new StubAuth({ tenants: TENANTS });
    });

    describe('seedUser', () => {
        it('writes a user that the Auth operations then read', async () => {
            const seeded = auth.seedUser({ uid: 'seeded', email: 'Seeded@Example.com', password: 'secret1', displayName: 'Seeded', emailVerified: true });

            expect(seeded.email).toBe('seeded@example.com');
            expect((await auth.getUser('seeded')).toJSON()).toEqual(seeded.toJSON());
            expect((await auth.getUserByEmail('seeded@example.com')).uid).toBe('seeded');
            expect(seeded.providerData.map((info) => info.providerId)).toEqual(['password']);
        });

        it('uses the given creation time', () => {
            const seeded = auth.seedUser({ uid: 'old', creationTime: new Date('2024-01-02T03:04:05.678Z') });

            expect(seeded.metadata.creationTime).toBe('Tue, 02 Jan 2024 03:04:05 GMT');
        });

        it('replaces a user with the same uid', async () => {
            auth.seedUser({ uid: 'replaced', email: 'before@example.com', displayName: 'Before' });

            auth.seedUser({ uid: 'replaced', email: 'after@example.com' });

            const user = await auth.getUser('replaced');
            expect(user.email).toBe('after@example.com');
            expect(user.displayName).toBeUndefined();
            await expect(auth.getUserByEmail('before@example.com')).rejects.toMatchObject({ code: 'auth/user-not-found' });
        });

        it('refuses an email that belongs to another user', () => {
            auth.seedUser({ uid: 'owner', email: 'owner@example.com' });

            expect(() => auth.seedUser({ uid: 'other', email: 'OWNER@example.com' })).toThrow(StubAuthError);
        });
    });

    describe('failNext', () => {
        it('makes the next getUser calls for a user throw, then recovers', async () => {
            auth.seedUser({ uid: 'flaky' });
            const outage = new Error('Auth unavailable');

            auth.failNext('getUser', 'flaky', 2, outage);

            await expect(auth.getUser('flaky')).rejects.toBe(outage);
            expect(auth.remainingFailures('getUser', 'flaky')).toBe(1);
            await expect(auth.getUser('flaky')).rejects.toBe(outage);
            expect(auth.remainingFailures('getUser', 'flaky')).toBe(0);
            await expect(auth.getUser('flaky')).resolves.toMatchObject({ uid: 'flaky' });
        });

        it('makes updateUser throw without changing the user', async () => {
            auth.seedUser({ uid: 'flaky', displayName: 'Before' });
            const outage = new Error('Auth unavailable');

            auth.failNext('updateUser', 'flaky', 1, outage);

            await expect(auth.updateUser('flaky', { displayName: 'After' })).rejects.toBe(outage);
            expect((await auth.getUser('flaky')).displayName).toBe('Before');
            await expect(auth.updateUser('flaky', { displayName: 'After' })).resolves.toMatchObject({ displayName: 'After' });
        });

        it('affects only the given operation and user', async () => {
            auth.seedUser({ uid: 'flaky' });
            auth.seedUser({ uid: 'steady' });

            auth.failNext('updateUser', 'flaky', 1, new Error('Auth unavailable'));

            await expect(auth.getUser('flaky')).resolves.toMatchObject({ uid: 'flaky' });
            await expect(auth.updateUser('steady', { displayName: 'Steady' })).resolves.toMatchObject({ displayName: 'Steady' });
            expect(auth.remainingFailures('updateUser', 'flaky')).toBe(1);
        });
    });

    describe('tokens', () => {
        const FIVE_MINUTES = 5 * 60 * 1000;

        afterEach(() => {
            vi.useRealTimers();
        });

        it('expires an ID token after an hour', async () => {
            auth.seedUser({ uid: 'expiring' });
            const idToken = auth.issueIdToken('expiring');

            auth.advanceClock(3600 * 1000 - 1000);
            await expect(auth.verifyIdToken(idToken, true)).resolves.toMatchObject({ uid: 'expiring' });

            auth.advanceClock(1000);
            await expect(auth.verifyIdToken(idToken, true)).rejects.toMatchObject({
                code: 'auth/id-token-expired',
                message:
                    'Firebase ID token has expired. Get a fresh ID token from your client app and try again (auth/id-token-expired). See https://firebase.google.com/docs/auth/admin/verify-id-tokens for details on how to retrieve an ID token.',
            });
            await expect(auth.createSessionCookie(idToken, { expiresIn: FIVE_MINUTES })).rejects.toMatchObject({ code: 'auth/id-token-expired' });
        });

        it('expires a session cookie after its duration', async () => {
            auth.seedUser({ uid: 'expiring' });
            const cookie = await auth.createSessionCookie(auth.issueIdToken('expiring'), { expiresIn: FIVE_MINUTES });

            auth.advanceClock(FIVE_MINUTES - 1000);
            await expect(auth.verifySessionCookie(cookie, true)).resolves.toMatchObject({ uid: 'expiring' });

            auth.advanceClock(1000);
            await expect(auth.verifySessionCookie(cookie, true)).rejects.toMatchObject({
                code: 'auth/session-cookie-expired',
                message:
                    'Firebase session cookie has expired. Get a fresh session cookie from your client app and try again (auth/session-cookie-expired). See https://firebase.google.com/docs/auth/admin/manage-cookies for details on how to retrieve a session cookie.',
            });
        });

        it('keeps a token signed in during the second of revocation, and refuses it once revoked a second later', async () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date('2026-01-01T00:00:00.100Z'));
            auth.seedUser({ uid: 'same-second' });
            const idToken = auth.issueIdToken('same-second');

            vi.setSystemTime(new Date('2026-01-01T00:00:00.900Z'));
            await auth.revokeRefreshTokens('same-second');
            await expect(auth.verifyIdToken(idToken, true)).resolves.toMatchObject({ uid: 'same-second' });

            vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
            await auth.revokeRefreshTokens('same-second');
            await expect(auth.verifyIdToken(idToken, true)).rejects.toMatchObject({ code: 'auth/id-token-revoked' });
        });

        it('looks the user up only when checkRevoked is set, as real Firebase does', async () => {
            auth.seedUser({ uid: 'gone' });
            const idToken = auth.issueIdToken('gone');
            const cookie = await auth.createSessionCookie(idToken, { expiresIn: FIVE_MINUTES });

            await auth.deleteUser('gone');

            await expect(auth.verifyIdToken(idToken)).resolves.toMatchObject({ uid: 'gone' });
            await expect(auth.verifySessionCookie(cookie)).resolves.toMatchObject({ uid: 'gone' });
            await expect(auth.verifyIdToken(idToken, true)).rejects.toMatchObject({ code: 'auth/user-not-found' });
        });

        it('refuses a token another stub issued', async () => {
            const other = new StubAuth();
            other.seedUser({ uid: 'stranger' });
            auth.seedUser({ uid: 'stranger' });

            await expect(auth.verifyIdToken(other.issueIdToken('stranger'))).rejects.toMatchObject({
                code: 'auth/argument-error',
                message: 'Firebase ID token has invalid signature. See https://firebase.google.com/docs/auth/admin/verify-id-tokens for details on how to retrieve an ID token.',
            });
        });

        it('refuses a token issued for another project', async () => {
            const other = new StubAuth({ projectId: 'other-project' });
            other.seedUser({ uid: 'stranger' });

            await expect(auth.verifyIdToken(other.issueIdToken('stranger'))).rejects.toMatchObject({
                code: 'auth/argument-error',
                message: expect.stringContaining('Firebase ID token has incorrect "aud" (audience) claim. Expected "test-project" but got "other-project".'),
            });
        });

        it('refuses to sign in a disabled user', () => {
            auth.seedUser({ uid: 'disabled', disabled: true });

            expect(() => auth.issueIdToken('disabled')).toThrow(expect.objectContaining({ code: 'auth/user-disabled' }));
        });
    });

    describe('client', () => {
        it('refuses a custom token another stub issued', async () => {
            const other = new StubAuth();
            auth.seedUser({ uid: 'stranger' });

            await expect(auth.client().signInWithCustomToken({ token: await other.createCustomToken('stranger'), returnSecureToken: true })).rejects.toMatchObject({
                status: 400,
                reason: 'INVALID_CUSTOM_TOKEN',
            });
        });

        it('accepts the action codes issueActionCode issues', async () => {
            auth.seedUser({ uid: 'issued', email: 'issued@example.com' });

            const oobCode = auth.issueActionCode('Issued@Example.com', 'VERIFY_AND_CHANGE_EMAIL', 'Changed@Example.com');

            await expect(auth.client().resetPassword({ oobCode })).resolves.toEqual({ requestType: 'VERIFY_AND_CHANGE_EMAIL', email: 'issued@example.com', newEmail: 'changed@example.com' });
            await expect(auth.client().applyActionCode({ oobCode })).resolves.toEqual({ localId: 'issued', email: 'changed@example.com', newEmail: 'changed@example.com', emailVerified: true });
        });

        it('refuses to issue an action code for an unknown email, as the links refuse it', () => {
            const unprotected = new StubAuth({ emailEnumerationProtection: false });

            expect(() => auth.issueActionCode('nobody@example.com', 'PASSWORD_RESET')).toThrow(expect.objectContaining({ code: 'auth/internal-error' }));
            expect(() => unprotected.issueActionCode('nobody@example.com', 'PASSWORD_RESET')).toThrow(expect.objectContaining({ code: 'auth/email-not-found' }));
            expect(() => auth.issueActionCode('nobody@example.com', 'VERIFY_EMAIL')).toThrow(expect.objectContaining({ code: 'auth/user-not-found' }));
        });
    });

    describe('email enumeration protection', () => {
        const signIn = (stub: StubAuth, email: string, password: string, tenantId?: string) => stub.client().signInWithPassword({ email, password, returnSecureToken: true, tenantId });

        it('is on for the project pool and off for tenants unless configured', async () => {
            auth.seedUser({ uid: 'root', email: 'member@example.com', password: 'secret1' });
            auth.tenantManager().authForTenant('tenant-a').seedUser({ uid: 'a', email: 'member@example.com', password: 'secret1' });

            await expect(signIn(auth, 'member@example.com', 'wrong1')).rejects.toMatchObject({ message: 'INVALID_LOGIN_CREDENTIALS' });
            await expect(signIn(auth, 'nobody@example.com', 'secret1')).rejects.toMatchObject({ message: 'INVALID_LOGIN_CREDENTIALS' });
            await expect(signIn(auth, 'member@example.com', 'wrong1', 'tenant-a')).rejects.toMatchObject({ message: 'INVALID_PASSWORD' });
            await expect(signIn(auth, 'nobody@example.com', 'secret1', 'tenant-a')).rejects.toMatchObject({ message: 'EMAIL_NOT_FOUND' });
        });

        it('follows the options for the project pool and each tenant', async () => {
            const configured = new StubAuth({ emailEnumerationProtection: false, tenants: { 'tenant-a': { emailEnumerationProtection: true } } });
            configured.seedUser({ uid: 'root', email: 'member@example.com', password: 'secret1' });
            const tenantA = configured.tenantManager().authForTenant('tenant-a');
            tenantA.seedUser({ uid: 'a', email: 'member@example.com', password: 'secret1' });
            tenantA.seedUser({ uid: 'b', email: 'other@example.com' });

            await expect(signIn(configured, 'member@example.com', 'wrong1')).rejects.toMatchObject({ message: 'INVALID_PASSWORD' });
            await expect(signIn(configured, 'nobody@example.com', 'secret1')).rejects.toMatchObject({ message: 'EMAIL_NOT_FOUND' });
            await expect(signIn(configured, 'member@example.com', 'wrong1', 'tenant-a')).rejects.toMatchObject({ message: 'INVALID_LOGIN_CREDENTIALS' });
            await expect(tenantA.generatePasswordResetLink('nobody@example.com')).rejects.toMatchObject({ code: 'auth/internal-error' });
            await expect(tenantA.generateVerifyAndChangeEmailLink('member@example.com', 'other@example.com')).rejects.toMatchObject({
                code: 'auth/internal-error',
                message: 'INTERNAL ASSERT FAILED: Unable to create the email action link',
            });
            await expect(configured.generatePasswordResetLink('nobody@example.com')).rejects.toMatchObject({ code: 'auth/email-not-found' });
        });
    });

    describe('tenants', () => {
        const FIVE_MINUTES = 5 * 60 * 1000;
        const invalidSignature = {
            code: 'auth/argument-error',
            message: 'Firebase ID token has invalid signature. See https://firebase.google.com/docs/auth/admin/verify-id-tokens for details on how to retrieve an ID token.',
        };

        /** The token with its payload rewritten and its signature kept */
        function tamper(token: string, change: (payload: Record<string, unknown>) => void): string {
            const [header, payload, signature] = token.split('.');
            const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
            change(claims);
            return `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;
        }

        it('refuses an empty tenant ID, as the Admin SDK does', () => {
            expect(() => auth.tenantManager().authForTenant('')).toThrow(
                expect.objectContaining({ code: 'auth/invalid-tenant-id', message: 'The tenant ID must be a valid non-empty string.' }),
            );
        });

        it('refuses a tenant it was not made with, as Firebase refuses a tenant the project does not have', async () => {
            const unknown = auth.tenantManager().authForTenant('tenant-z');
            const known = auth.tenantManager().authForTenant('tenant-a');
            known.seedUser({ uid: 'member', email: 'member@example.com', password: 'secret1' });
            const idToken = known.issueIdToken('member');
            const notFound = {
                code: 'auth/internal-error',
                message:
                    'An internal error has occurred. Raw server response: "{"error":{"code":400,"message":"INVALID_TENANT_ID","errors":[{"message":"INVALID_TENANT_ID","domain":"global","reason":"invalid"}]}}"',
            };

            expect(unknown.tenantId).toBe('tenant-z');
            await expect(unknown.createUser({ email: 'member@example.com', password: 'secret1' })).rejects.toMatchObject(notFound);
            await expect(unknown.getUser('member')).rejects.toMatchObject(notFound);
            await expect(unknown.getUserByEmail('member@example.com')).rejects.toMatchObject(notFound);
            await expect(unknown.getUsers([{ uid: 'member' }])).rejects.toMatchObject(notFound);
            await expect(unknown.updateUser('member', { displayName: 'x' })).rejects.toMatchObject(notFound);
            await expect(unknown.listUsers()).rejects.toMatchObject(notFound);
            await expect(unknown.deleteUser('member')).rejects.toMatchObject(notFound);
            await expect(unknown.revokeRefreshTokens('member')).rejects.toMatchObject(notFound);
            await expect(unknown.generatePasswordResetLink('member@example.com')).rejects.toMatchObject(notFound);
            await expect(unknown.generateEmailVerificationLink('member@example.com')).rejects.toMatchObject(notFound);
            await expect(unknown.generateVerifyAndChangeEmailLink('member@example.com', 'new@example.com')).rejects.toMatchObject(notFound);
            // As the Admin SDK: the lookup checkRevoked makes reaches the server, and is refused before the tenant is compared
            await expect(unknown.verifyIdToken(idToken, true)).rejects.toMatchObject(notFound);
            await expect(unknown.verifyIdToken(idToken)).rejects.toMatchObject({ code: 'auth/mismatching-tenant-id' });
            expect(() => unknown.seedUser({ uid: 'member' })).toThrow(expect.objectContaining(notFound));
            expect(() => unknown.issueIdToken('member')).toThrow(expect.objectContaining(notFound));

            // As the Admin SDK: a custom token is signed locally, and Firebase then refuses the sign-in
            const customToken = await unknown.createCustomToken('member');
            for (
                const call of [
                    auth.client().signInWithCustomToken({ token: customToken, returnSecureToken: true, tenantId: 'tenant-z' }),
                    auth.client().signInWithCustomToken({ token: 'garbage', returnSecureToken: true, tenantId: 'tenant-z' }),
                    auth.client().signInWithPassword({ email: 'member@example.com', password: 'secret1', returnSecureToken: true, tenantId: 'tenant-z' }),
                    auth.client().resetPassword({ oobCode: 'none', tenantId: 'tenant-z' }),
                    auth.client().applyActionCode({ oobCode: 'none', tenantId: 'tenant-z' }),
                ]
            ) {
                await expect(call).rejects.toMatchObject({ status: 400, reason: 'INVALID_TENANT_ID', message: 'INVALID_TENANT_ID' });
            }
        });

        it('reaches the same pool each time a tenant is asked for', async () => {
            auth.tenantManager().authForTenant('tenant-a').seedUser({ uid: 'kept', email: 'kept@example.com' });

            const again = auth.tenantManager().authForTenant('tenant-a');

            expect(again).toBe(auth.tenantManager().authForTenant('tenant-a'));
            expect(again.tenantId).toBe('tenant-a');
            await expect(again.getUserByEmail('kept@example.com')).resolves.toMatchObject({ uid: 'kept', tenantId: 'tenant-a' });
        });

        it('keeps two simulators apart: their tenants share neither accounts nor tokens', async () => {
            const other = new StubAuth({ tenants: TENANTS });
            const ours = auth.tenantManager().authForTenant('tenant-a');
            const theirs = other.tenantManager().authForTenant('tenant-a');
            ours.seedUser({ uid: 'member', email: 'member@example.com', password: 'secret1' });
            theirs.seedUser({ uid: 'member', email: 'member@example.com', password: 'other1' });

            await expect(auth.client().signInWithPassword({ email: 'member@example.com', password: 'other1', returnSecureToken: true, tenantId: 'tenant-a' })).rejects.toMatchObject({
                reason: 'INVALID_PASSWORD',
            });
            await expect(ours.verifyIdToken(theirs.issueIdToken('member'))).rejects.toMatchObject(invalidSignature);
            await expect(auth.client().signInWithCustomToken({ token: await theirs.createCustomToken('member'), returnSecureToken: true, tenantId: 'tenant-a' })).rejects.toMatchObject({
                message: 'INVALID_CUSTOM_TOKEN',
            });

            other.clear();
            await expect(ours.getUser('member')).resolves.toMatchObject({ uid: 'member' });
        });

        it('refuses a token whose tenant was rewritten, by its signature', async () => {
            const a = auth.tenantManager().authForTenant('tenant-a');
            const b = auth.tenantManager().authForTenant('tenant-b');
            a.seedUser({ uid: 'member' });
            b.seedUser({ uid: 'member' });
            const idToken = a.issueIdToken('member');
            const cookie = await a.createSessionCookie(idToken, { expiresIn: FIVE_MINUTES });
            const toB = (claims: Record<string, unknown>) => {
                (claims.firebase as Record<string, unknown>).tenant = 'tenant-b';
            };

            await expect(b.verifyIdToken(tamper(idToken, toB))).rejects.toMatchObject(invalidSignature);
            await expect(b.verifySessionCookie(tamper(cookie, toB))).rejects.toMatchObject({ code: 'auth/argument-error', message: expect.stringContaining('session cookie has invalid signature') });
            const customToken = tamper(await a.createCustomToken('member'), (claims) => {
                claims.tenant_id = 'tenant-b';
            });
            await expect(auth.client().signInWithCustomToken({ token: customToken, returnSecureToken: true, tenantId: 'tenant-b' })).rejects.toMatchObject({ message: 'INVALID_CUSTOM_TOKEN' });
        });

        it('refuses another tenant without checkRevoked, and the project-level instance accepts it, as the Admin SDK does', async () => {
            // Against the emulator the Admin SDK always looks the user up, so this is the stub's alone
            const a = auth.tenantManager().authForTenant('tenant-a');
            const b = auth.tenantManager().authForTenant('tenant-b');
            a.seedUser({ uid: 'a-only' });
            const idToken = a.issueIdToken('a-only');
            const cookie = await a.createSessionCookie(idToken, { expiresIn: FIVE_MINUTES });

            await expect(b.verifyIdToken(idToken)).rejects.toMatchObject({ code: 'auth/mismatching-tenant-id' });
            await expect(b.verifySessionCookie(cookie)).rejects.toMatchObject({ code: 'auth/mismatching-tenant-id' });
            await expect(auth.verifyIdToken(idToken)).resolves.toMatchObject({ uid: 'a-only', firebase: { tenant: 'tenant-a' } });
            await expect(auth.verifySessionCookie(cookie)).resolves.toMatchObject({ uid: 'a-only', firebase: { tenant: 'tenant-a' } });
        });

        it('expires a tenant token on the simulator clock', async () => {
            const a = auth.tenantManager().authForTenant('tenant-a');
            a.seedUser({ uid: 'expiring' });
            const idToken = a.issueIdToken('expiring');

            auth.advanceClock(3600 * 1000);

            await expect(a.verifyIdToken(idToken)).rejects.toMatchObject({ code: 'auth/id-token-expired' });
        });

        it('gives each tenant its own test controls', async () => {
            const a = auth.tenantManager().authForTenant('tenant-a');
            const b = auth.tenantManager().authForTenant('tenant-b');
            a.seedUser({ uid: 'member', email: 'member@example.com' });
            b.seedUser({ uid: 'member', email: 'member@example.com' });
            const outage = new Error('Auth unavailable');

            a.failNext('getUser', 'member', 1, outage);
            const oobCode = a.issueActionCode('member@example.com', 'VERIFY_EMAIL');

            await expect(b.getUser('member')).resolves.toMatchObject({ uid: 'member' });
            expect(b.remainingFailures('getUser', 'member')).toBe(0);
            await expect(a.getUser('member')).rejects.toBe(outage);
            await expect(auth.client().applyActionCode({ oobCode, tenantId: 'tenant-b' })).rejects.toMatchObject({ reason: 'INVALID_OOB_CODE' });
            await expect(auth.client().applyActionCode({ oobCode, tenantId: 'tenant-a' })).resolves.toMatchObject({ emailVerified: true });
            expect((await b.getUser('member')).emailVerified).toBe(false);
        });

        it('clear empties every tenant pool as well as the project pool', async () => {
            const a = auth.tenantManager().authForTenant('tenant-a');
            a.seedUser({ uid: 'cleared', email: 'cleared@example.com' });
            const oobCode = a.issueActionCode('cleared@example.com', 'PASSWORD_RESET');

            auth.clear();

            await expect(a.getUser('cleared')).rejects.toMatchObject({ code: 'auth/user-not-found' });
            await expect(auth.client().resetPassword({ oobCode, tenantId: 'tenant-a' })).rejects.toMatchObject({ reason: 'INVALID_OOB_CODE' });
        });
    });

    it('returns records that changing the stub does not alter', async () => {
        const created = await auth.createUser({ uid: 'snapshot', displayName: 'Before' });

        await auth.updateUser('snapshot', { displayName: 'After' });

        expect(created.displayName).toBe('Before');
    });

    it('clear removes every user, action code and pending failure', async () => {
        auth.seedUser({ uid: 'cleared', email: 'cleared@example.com' });
        auth.failNext('getUser', 'cleared', 1, new Error('Auth unavailable'));
        const oobCode = auth.issueActionCode('cleared@example.com', 'VERIFY_EMAIL');

        auth.clear();

        expect(auth.remainingFailures('getUser', 'cleared')).toBe(0);
        await expect(auth.getUser('cleared')).rejects.toMatchObject({ code: 'auth/user-not-found' });
        expect((await auth.listUsers()).users).toEqual([]);
        await expect(auth.client().resetPassword({ oobCode })).rejects.toMatchObject({ reason: 'INVALID_OOB_CODE' });
    });
});
