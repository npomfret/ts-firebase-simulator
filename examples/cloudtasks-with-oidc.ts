/**
 * Cloud Tasks with OIDC authentication
 */

import { StubCloudTasksClient } from 'ts-firebase-simulator';

async function main() {
    const client = new StubCloudTasksClient();
    const queuePath = client.queuePath('my-project', 'us-central1', 'my-queue');

    // Create task with OIDC token
    await client.createTask({
        parent: queuePath,
        task: {
            httpRequest: {
                httpMethod: 'POST',
                url: 'https://my-app.com/api/secure-endpoint',
                body: JSON.stringify({ data: 'sensitive' }),
                oidcToken: {
                    serviceAccountEmail: 'my-sa@my-project.iam.gserviceaccount.com',
                    audience: 'https://my-app.com',
                },
            },
        },
    });

    // Verify OIDC config was stored
    const task = client.getLastEnqueuedTask();
    console.log('OIDC email:', task?.oidcToken?.serviceAccountEmail);
    console.log('OIDC audience:', task?.oidcToken?.audience);
}

main().catch(console.error);
