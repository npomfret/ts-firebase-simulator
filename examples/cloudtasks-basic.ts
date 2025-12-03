/**
 * Basic Cloud Tasks operations
 */

import { StubCloudTasksClient } from 'ts-firebase-simulator';

async function main() {
    const client = new StubCloudTasksClient();

    // Generate a queue path
    const queuePath = client.queuePath('my-project', 'us-central1', 'my-queue');
    console.log('Queue path:', queuePath);

    // Create a task
    const [task] = await client.createTask({
        parent: queuePath,
        task: {
            httpRequest: {
                httpMethod: 'POST',
                url: 'https://my-app.com/api/process',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: 'user-1', action: 'notify' }),
            },
        },
    });

    console.log('Task created:', task.name);

    // Inspect enqueued tasks
    const tasks = client.getEnqueuedTasks();
    console.log('Enqueued tasks:', tasks.length);
    console.log('Last task URL:', client.getLastEnqueuedTask()?.url);
}

main().catch(console.error);
