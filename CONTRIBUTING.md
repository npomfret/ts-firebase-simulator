# Contributing / Running Integration Tests

This document covers how to set up and run the integration tests for this package. These tests verify that the stub implementations behave identically to real Firebase services.

## Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- **Firebase CLI**: `npm install -g firebase-tools`
- **gcloud CLI** (optional, for IAM setup): https://cloud.google.com/sdk/docs/install

## Setup

### 1. Create a Firebase Project

Create a new Firebase project (or use an existing one) at https://console.firebase.google.com

### 2. Enable Required Services

In the Firebase Console:
- **Firestore Database**: Firestore > Create Database
- **Storage**: Storage > Get Started

### 3. Download Service Account Key

1. Firebase Console > Project Settings > Service Accounts
2. Click "Generate New Private Key"
3. Save the file as `service-account-key.json` in this package's root directory

The service account file is gitignored and should never be committed.

### 4. Grant Required Permissions

The service account needs the **Cloud Datastore Index Admin** role to deploy indexes.

Via gcloud CLI:
```bash
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:YOUR_SERVICE_ACCOUNT_EMAIL" \
  --role="roles/datastore.indexAdmin"
```

Or via the [Google Cloud Console IAM page](https://console.cloud.google.com/iam-admin/iam):
1. Find your service account (e.g., `firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com`)
2. Click the pencil icon to edit
3. Add the role "Cloud Datastore Index Admin"
4. Save

### 5. Configure Storage Bucket (if needed)

By default, the tests use `{project-id}.firebasestorage.app`. If your bucket has a different name:

```bash
export FIREBASE_STORAGE_BUCKET=my-project.appspot.com
```

### 6. Deploy Firestore Indexes

Some integration tests require composite indexes:

```bash
npm run indexes:deploy
```

Index creation is asynchronous and may take a few minutes to complete.

The required indexes are defined in [`firestore.indexes.json`](firestore.indexes.json).

### 7. Run Tests

```bash
npm run test:integration
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run test` | Run all tests |
| `npm run test:unit` | Run unit tests only (no Firebase connection needed) |
| `npm run test:integration` | Run integration tests (requires setup above) |
| `npm run indexes:deploy` | Deploy Firestore indexes |
| `npm run test:wipe-data` | Delete all test data from Firestore (to re-seed) |
| `npm run build` | Build the package |

## Troubleshooting

### "The caller does not have permission" when deploying indexes

Make sure the service account has the "Cloud Datastore Index Admin" role. See step 4 above.

### "FAILED_PRECONDITION" errors in tests

This usually means an index hasn't been created yet. Run `npm run indexes:deploy` and wait a few minutes for indexes to build.

### Tests are slow on first run

The first run seeds test data to Firestore. Subsequent runs skip seeding if data already exists. If you need to re-seed, run `npm run test:wipe-data` first.

## Configuration Reference

| Setting | Environment Variable | File Alternative |
|---------|---------------------|------------------|
| Service Account | `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json` | Place `service-account-key.json` at package root |
| Storage Bucket | `FIREBASE_STORAGE_BUCKET=my-project.appspot.com` | Defaults to `{project-id}.firebasestorage.app` |

## Service Account Roles

| Role | Purpose |
|------|---------|
| Firebase Admin SDK Administrator Service Agent | Default role (included with service account) |
| Cloud Datastore Index Admin | Required to deploy Firestore indexes |
