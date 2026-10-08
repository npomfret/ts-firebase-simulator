import { beforeEach, describe, expect, it } from 'vitest';
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
