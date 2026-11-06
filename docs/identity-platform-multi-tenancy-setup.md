# Setting up Identity Platform multi-tenancy

How to give a Firebase project separate authentication pools (tenants), each
with its own users and Email/Password sign-in. Everything below is in the
**Google Cloud console**, not the Firebase console. Replace `PROJECT_ID` with
the project's ID (for example `fir-simulator-test`, whose display name is
`firebase-simulator-test`).

## Before you start

- You need the **Identity Platform Admin** role (`roles/identityplatform.admin`)
  on the project.
- Enabling Identity Platform may ask for billing to be enabled. Identity
  Platform is priced per monthly active user above its free tier.

## 1. Enable Identity Platform

1. Open <https://console.cloud.google.com/marketplace/details/google-cloud-platform/customer-identity?project=PROJECT_ID>.
2. Click **Enable Identity Platform**.

Until this is done, the tenant settings below do not exist. In the Firebase
console, features such as *Blocking functions* show a lock icon.

## 2. Allow tenants

1. Open **Identity Platform → Settings**:
   <https://console.cloud.google.com/customer-identity/settings?project=PROJECT_ID>.
2. Choose the **Security** tab.
3. In **Multi-tenancy**, click **Allow tenants**. The **Tenants** page opens.

Google documents turning multi-tenancy off only through the Identity Toolkit
API (`projects.updateConfig`), not in the console.

## 3. Add the tenants

1. On **Identity Platform → Tenants**, click **Add a tenant**.
2. Enter a **Name** and click **Save**. Repeat for each tenant.

The name is only a display name. Identity Platform generates the **Tenant ID**,
for example `tenant-1-je6an`. Code uses the Tenant ID
(`getAuth().tenantManager().authForTenant(tenantId)`, or `tenantId` in an
Identity Toolkit REST request). It never uses the display name.

## 4. Enable Email/Password, once per pool

Each tenant has its own providers, and the project's own pool (no tenant) has
another set. Enable Email/Password in every pool that signs people in with a
password:

1. On **Identity Platform → Providers**
   (<https://console.cloud.google.com/customer-identity/providers?project=PROJECT_ID>),
   pick the pool in **Scope to a tenant**, or leave it unset for the project's
   own pool.
2. Click **Add a provider**, choose **Email/Password**, turn on **Enabled** and
   click **Save**.

For the project's own pool, the Firebase console works too: **Authentication →
Sign-in method → Email/Password → Enable → Save**. That setting is the
project-level provider, so it does not enable Email/Password in any tenant.

Enabling it in the tenants does not enable it in the project's own pool either.
A pool without it answers password sign-in, password reset and action-code
requests with `PASSWORD_LOGIN_DISABLED`.

## 5. Check it

With the project's service account, `getAuth().tenantManager().listTenants()`
should list each tenant with `emailSignInConfig: { enabled: true, ... }`.
Before step 2 it fails with
`auth/invalid-project-id … didn't enable multi-tenancy`.

## For this package's real-Firebase auth tests

- The project needs two tenants named **`tenant-1`** and **`tenant-2`**. The
  tests look them up by display name, so their generated IDs are not recorded
  anywhere.
- Email/Password must be enabled in both tenants **and** in the project's own pool.
- The project needs a web app (Firebase console → Project settings → *Your
  apps*). The tests read its API key with the service account at start-up, so no
  key is stored in the repository.
- The tests delete every account in the project and in both tenants before each
  test, so use a project kept for testing.
