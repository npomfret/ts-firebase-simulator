/**
 * Identity Platform tenants: one pool of accounts per tenant, in one simulator
 */

import { type IAuthClient, type ITenantManager, StubAuth } from 'ts-firebase-simulator';

/** Signs a person in to one tenant, and verifies the token as that tenant's server would */
async function signInToTenant(tenants: ITenantManager, client: IAuthClient, tenantId: string, email: string, password: string): Promise<string> {
    const { idToken } = await client.signInWithPassword({ email, password, returnSecureToken: true, tenantId });
    const decoded = await tenants.authForTenant(tenantId).verifyIdToken(idToken!, true);
    return decoded.uid;
}

async function main() {
    // In production: createTenantManager(getAuth().tenantManager()) and createAuthClient(...)
    const auth = new StubAuth({ projectId: 'my-project' });
    const tenants = auth.tenantManager();
    const client = auth.client();

    // The same email registers separately in each tenant, with its own password
    const red = tenants.authForTenant('red-tenant');
    const blue = tenants.authForTenant('blue-tenant');
    await red.createUser({ email: 'alice@example.com', password: 'red-password' });
    await blue.createUser({ email: 'alice@example.com', password: 'blue-password' });

    console.log('Red account:', await signInToTenant(tenants, client, 'red-tenant', 'alice@example.com', 'red-password'));
    console.log('Blue account:', await signInToTenant(tenants, client, 'blue-tenant', 'alice@example.com', 'blue-password'));

    // A red token is refused by the blue tenant
    const { idToken } = await client.signInWithPassword({ email: 'alice@example.com', password: 'red-password', returnSecureToken: true, tenantId: 'red-tenant' });
    await blue.verifyIdToken(idToken!).catch((error: { code: string; }) => console.log('Red token in blue:', error.code));

    // A password reset changes only the red account
    const oobCode = red.issueActionCode('alice@example.com', 'PASSWORD_RESET');
    await client.resetPassword({ oobCode, newPassword: 'new-red-password', tenantId: 'red-tenant' });
    console.log('Blue password still works:', await signInToTenant(tenants, client, 'blue-tenant', 'alice@example.com', 'blue-password'));

    // Clean up every pool between tests
    auth.clear();
}

main().catch(console.error);
