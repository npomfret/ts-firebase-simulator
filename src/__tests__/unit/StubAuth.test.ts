import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StubAuth, StubAuthError } from '../../StubAuth';

describe('StubAuth', () => {
    let auth: StubAuth;

    beforeEach(() => {
        auth = new StubAuth();
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

    it('returns records that changing the stub does not alter', async () => {
        const created = await auth.createUser({ uid: 'snapshot', displayName: 'Before' });

        await auth.updateUser('snapshot', { displayName: 'After' });

        expect(created.displayName).toBe('Before');
    });

    it('clear removes every user and pending failure', async () => {
        auth.seedUser({ uid: 'cleared', email: 'cleared@example.com' });
        auth.failNext('getUser', 'cleared', 1, new Error('Auth unavailable'));

        auth.clear();

        expect(auth.remainingFailures('getUser', 'cleared')).toBe(0);
        await expect(auth.getUser('cleared')).rejects.toMatchObject({ code: 'auth/user-not-found' });
        expect((await auth.listUsers()).users).toEqual([]);
    });
});
