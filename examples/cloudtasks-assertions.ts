/**
 * Asserting on enqueued tasks in tests
 */

import { StubCloudTasksClient } from 'ts-firebase-simulator';

async function main() {
    // In this example, use StubCloudTasksClient directly (not the interface) to access test helper methods
    const client = new StubCloudTasksClient();
    const queuePath = client.queuePath('my-project', 'us-central1', 'notifications');

    // Simulate your service enqueueing tasks
    await client.createTask({
        parent: queuePath,
        task: {
            httpRequest: {
                httpMethod: 'POST',
                url: 'https://api.example.com/send-email',
                body: JSON.stringify({ to: 'user@example.com', template: 'welcome' }),
            },
        },
    });

    await client.createTask({
        parent: queuePath,
        task: {
            httpRequest: {
                httpMethod: 'POST',
                url: 'https://api.example.com/send-sms',
                body: JSON.stringify({ phone: '+1234567890', message: 'Hello!' }),
            },
        },
    });

    // Test assertions
    console.log('Task count:', client.getTaskCount()); // 2

    const tasks = client.getEnqueuedTasks();
    const emailTask = tasks.find((t) => t.url.includes('send-email'));
    console.log('Email task body:', emailTask?.body);

    // Clear between tests
    client.clear();
    console.log('After clear:', client.getTaskCount()); // 0
}

main().catch(console.error);
