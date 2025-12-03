# Examples

Each file demonstrates a single concept. Run with:

```bash
npx tsx examples/<filename>.ts
```

## Firestore

| File | Description |
|------|-------------|
| `firestore-create-document.ts` | Creating documents with set() |
| `firestore-read-document.ts` | Reading a single document |
| `firestore-update-document.ts` | Updating with update() and FieldValue |
| `firestore-set-merge.ts` | Using set() with merge option |
| `firestore-delete-document.ts` | Deleting documents |
| `firestore-nested-update.ts` | Dot notation for nested fields |
| `firestore-query-where.ts` | Filtering with where() |
| `firestore-query-orderby-limit.ts` | Sorting and limiting results |
| `firestore-query-array-contains.ts` | Querying arrays |
| `firestore-query-in.ts` | Using in/not-in operators |
| `firestore-query-count.ts` | Counting documents |
| `firestore-collection-group.ts` | Querying across subcollections |
| `firestore-transaction.ts` | Atomic operations |
| `firestore-batch-write.ts` | Batch writes |
| `firestore-realtime-listener.ts` | onSnapshot listeners |
| `firestore-triggers.ts` | Testing Cloud Functions triggers |
| `firestore-trigger-patterns.ts` | Wildcard path patterns |
| `firestore-seed-and-clear.ts` | Test setup helpers |

## Storage

| File | Description |
|------|-------------|
| `storage-basic.ts` | Upload, download, delete files |
| `storage-seed-files.ts` | Seeding files for tests |

## Cloud Tasks

| File | Description |
|------|-------------|
| `cloudtasks-basic.ts` | Creating tasks |
| `cloudtasks-with-oidc.ts` | OIDC authentication |
| `cloudtasks-assertions.ts` | Asserting on enqueued tasks |

## Patterns

| File | Description |
|------|-------------|
| `dependency-injection.ts` | Using interfaces for testability |
| `trigger-definitions.ts` | Triggers that work in prod and tests |
| `vitest-example.test.ts` | Complete Vitest test example |
