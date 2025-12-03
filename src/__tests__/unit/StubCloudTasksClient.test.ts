import { beforeEach, describe, expect, it } from 'vitest';
import { StubCloudTasksClient } from '../../StubCloudTasksClient';

describe('StubCloudTasksClient', () => {
    let client: StubCloudTasksClient;

    beforeEach(() => {
        client = new StubCloudTasksClient();
    });

    describe('queuePath', () => {
        it('should generate correct queue path format', () => {
            const path = client.queuePath('test-project', 'us-central1', 'my-queue');
            expect(path).toBe('projects/test-project/locations/us-central1/queues/my-queue');
        });
    });

    describe('createTask', () => {
        it('should enqueue a task and return task name', async () => {
            const queuePath = 'projects/test-project/locations/us-central1/queues/my-queue';
            const [response] = await client.createTask({
                parent: queuePath,
                task: {
                    httpRequest: {
                        httpMethod: 'POST',
                        url: 'https://example.com/handler',
                        headers: { 'Content-Type': 'application/json' },
                        body: Buffer.from(JSON.stringify({ data: { jobId: 'job-123' } })).toString('base64'),
                    },
                },
            });

            expect(response.name).toContain(queuePath);
            expect(response.name).toContain('stub-task-1');
        });

        it('should increment task counter for multiple tasks', async () => {
            const queuePath = 'projects/test-project/locations/us-central1/queues/my-queue';

            const [task1] = await client.createTask({
                parent: queuePath,
                task: {
                    httpRequest: {
                        httpMethod: 'POST',
                        url: 'https://example.com/handler1',
                    },
                },
            });

            const [task2] = await client.createTask({
                parent: queuePath,
                task: {
                    httpRequest: {
                        httpMethod: 'POST',
                        url: 'https://example.com/handler2',
                    },
                },
            });

            expect(task1.name).toContain('stub-task-1');
            expect(task2.name).toContain('stub-task-2');
        });

        it('should store task details for assertions', async () => {
            const queuePath = 'projects/test-project/locations/us-central1/queues/my-queue';
            const url = 'https://example.com/handler';
            const headers = { 'Content-Type': 'application/json' };
            const body = Buffer.from(JSON.stringify({ data: { jobId: 'job-123' } })).toString('base64');

            await client.createTask({
                parent: queuePath,
                task: {
                    httpRequest: {
                        httpMethod: 'POST',
                        url,
                        headers,
                        body,
                    },
                },
            });

            const enqueuedTasks = client.getEnqueuedTasks();
            expect(enqueuedTasks).toHaveLength(1);

            const task = enqueuedTasks[0];
            expect(task.queuePath).toBe(queuePath);
            expect(task.url).toBe(url);
            expect(task.method).toBe('POST');
            expect(task.headers).toEqual(headers);
            expect(task.body).toBe(body);
            expect(task.enqueuedAt).toBeInstanceOf(Date);
        });
    });

    describe('getLastEnqueuedTask', () => {
        it('should return undefined when no tasks enqueued', () => {
            expect(client.getLastEnqueuedTask()).toBeUndefined();
        });

        it('should return the most recent task', async () => {
            const queuePath = 'projects/test-project/locations/us-central1/queues/my-queue';

            await client.createTask({
                parent: queuePath,
                task: {
                    httpRequest: {
                        httpMethod: 'POST',
                        url: 'https://example.com/handler1',
                    },
                },
            });

            await client.createTask({
                parent: queuePath,
                task: {
                    httpRequest: {
                        httpMethod: 'POST',
                        url: 'https://example.com/handler2',
                    },
                },
            });

            const lastTask = client.getLastEnqueuedTask();
            expect(lastTask?.url).toBe('https://example.com/handler2');
        });
    });

    describe('getTaskCount', () => {
        it('should return 0 initially', () => {
            expect(client.getTaskCount()).toBe(0);
        });

        it('should return correct count after enqueueing tasks', async () => {
            const queuePath = 'projects/test-project/locations/us-central1/queues/my-queue';

            await client.createTask({
                parent: queuePath,
                task: {
                    httpRequest: {
                        httpMethod: 'POST',
                        url: 'https://example.com/handler',
                    },
                },
            });

            expect(client.getTaskCount()).toBe(1);

            await client.createTask({
                parent: queuePath,
                task: {
                    httpRequest: {
                        httpMethod: 'POST',
                        url: 'https://example.com/handler',
                    },
                },
            });

            expect(client.getTaskCount()).toBe(2);
        });
    });

    describe('clear', () => {
        it('should clear all enqueued tasks', async () => {
            const queuePath = 'projects/test-project/locations/us-central1/queues/my-queue';

            await client.createTask({
                parent: queuePath,
                task: {
                    httpRequest: {
                        httpMethod: 'POST',
                        url: 'https://example.com/handler',
                    },
                },
            });

            expect(client.getTaskCount()).toBe(1);

            client.clear();

            expect(client.getTaskCount()).toBe(0);
            expect(client.getEnqueuedTasks()).toHaveLength(0);
            expect(client.getLastEnqueuedTask()).toBeUndefined();
        });

        it('should reset task counter', async () => {
            const queuePath = 'projects/test-project/locations/us-central1/queues/my-queue';

            await client.createTask({
                parent: queuePath,
                task: {
                    httpRequest: {
                        httpMethod: 'POST',
                        url: 'https://example.com/handler',
                    },
                },
            });

            client.clear();

            const [task] = await client.createTask({
                parent: queuePath,
                task: {
                    httpRequest: {
                        httpMethod: 'POST',
                        url: 'https://example.com/handler',
                    },
                },
            });

            // Should be stub-task-1 again, not stub-task-2
            expect(task.name).toContain('stub-task-1');
        });
    });
});
