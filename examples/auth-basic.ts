/**
 * Basic Auth operations: admin calls, client sign-in and action codes
 */

import { IdentityToolkitError, StubAuth } from 'ts-firebase-simulator';

async function main() {
    // In this example, use StubAuth directly (not the interface) to access test helper methods like seedUser()
    const auth = new StubAuth({ projectId: 'my-project' });

    // Seed a user, then read it back through the Admin SDK interface
    auth.seedUser({ uid: 'alice', email: 'Alice@Example.com', password: 'secret1' });
    const user = await auth.getUserByEmail('alice@example.com');
    console.log('User:', user.uid, user.email, 'verified:', user.emailVerified);

    // Sign in through the REST client, which shares the stub's users
    const client = auth.client();
    const { idToken } = await client.signInWithPassword({ email: 'alice@example.com', password: 'secret1', returnSecureToken: true });
    const decoded = await auth.verifyIdToken(idToken!, true);
    console.log('Signed in as:', decoded.uid);

    // A wrong password is refused with Firebase's error message
    try {
        await client.signInWithPassword({ email: 'alice@example.com', password: 'wrong', returnSecureToken: true });
    } catch (error) {
        if (error instanceof IdentityToolkitError) {
            console.log('Refused:', error.status, error.reason);
        }
    }

    // Verify the email with the code the verification link would carry
    const oobCode = auth.issueActionCode('alice@example.com', 'VERIFY_EMAIL');
    await client.applyActionCode({ oobCode });
    console.log('Verified:', (await auth.getUser('alice')).emailVerified);

    // Tokens expire as Firebase's do
    auth.advanceClock(60 * 60 * 1000);
    await auth.verifyIdToken(idToken!).catch((error: { code: string; }) => console.log('After an hour:', error.code));

    // Clean up between tests
    auth.clear();
}

main().catch(console.error);
