/**
 * Dependency injection pattern for testable services
 */

import {
    createFirestoreDatabase,
    type IFirestoreDatabase,
    StubFirestoreDatabase,
} from 'ts-firebase-simulator';

// Service that depends on the interface, not the implementation
class UserService {
    constructor(private db: IFirestoreDatabase) {}

    async createUser(id: string, name: string, email: string) {
        await this.db.doc(`users/${id}`).set({ name, email });
    }

    async getUser(id: string) {
        const doc = await this.db.doc(`users/${id}`).get();
        return doc.exists ? doc.data() : null;
    }

    async listUsers() {
        const snapshot = await this.db.collection('users').get();
        return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    }
}

async function main() {
    // In tests: use the stub
    const stubDb = new StubFirestoreDatabase();
    const testService = new UserService(stubDb);

    await testService.createUser('u1', 'Alice', 'alice@test.com');
    const user = await testService.getUser('u1');
    console.log('Test user:', user);

    // In production: use the real implementation
    // const realDb = createFirestoreDatabase(getFirestore());
    // const prodService = new UserService(realDb);
}

main().catch(console.error);
