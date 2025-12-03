/**
 * Integration Test: Cloud Tasks Client Compatibility
 *
 * Verifies that CloudTasksClientWrapper and StubCloudTasksClient implement
 * the ICloudTasksClient interface correctly.
 *
 * Note: Unlike Firestore, Cloud Tasks does not have a local emulator, so we
 * cannot test against real Cloud Tasks API without authentication. Instead,
 * this test verifies:
 * 1. Both implementations follow the same interface contract
 * 2. StubCloudTasksClient behavior is correct and testable
 * 3. Queue path generation is consistent
 */

import { createCloudTasksClient, type ICloudTasksClient, StubCloudTasksClient } from '@billsplit-wl/firebase-simulator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('Cloud Tasks Client Compatibility - Integration Test', () => {
    let realClient: ICloudTasksClient;
    let stubClient: StubCloudTasksClient;

    const testConfig = {
        projectId: 'test-project',
        location: 'us-central1',
        queueName: 'test-queue',
    };

    beforeEach(() => {
        realClient = createCloudTasksClient();
        stubClient = new StubCloudTasksClient();
    });

    afterEach(() => {
        stubClient.clear();
    });

    describe('Interface Contract - Queue Path Generation', () => {
        it('should generate identical queue paths for both implementations', () => {
            const realPath = realClient.queuePath(
                testConfig.projectId,
                testConfig.location,
                testConfig.queueName,
            );

            const stubPath = stubClient.queuePath(
                testConfig.projectId,
                testConfig.location,
                testConfig.queueName,
            );

            const expectedPath = `projects/${testConfig.projectId}/locations/${testConfig.location}/queues/${testConfig.queueName}`;

            expect(realPath).toBe(expectedPath);
            expect(stubPath).toBe(expectedPath);
            expect(stubPath).toBe(realPath);
        });

        it('should handle different configurations identically', () => {
            const configs = [
                { projectId: 'my-project', location: 'us-central1', queueName: 'default' },
                { projectId: 'test-123', location: 'europe-west1', queueName: 'priority-queue' },
                { projectId: 'prod-app', location: 'asia-east1', queueName: 'background-jobs' },
            ];

            configs.forEach((config) => {
                const realPath = realClient.queuePath(config.projectId, config.location, config.queueName);
                const stubPath = stubClient.queuePath(config.projectId, config.location, config.queueName);

                expect(stubPath).toBe(realPath);
                expect(stubPath).toBe(
                    `projects/${config.projectId}/locations/${config.location}/queues/${config.queueName}`,
                );
            });
        });
    });

    describe('Stub Implementation - Task Creation and Tracking', () => {
        it('should create tasks with valid response format', async () => {
            const queuePath = stubClient.queuePath(
                testConfig.projectId,
                testConfig.location,
                testConfig.queueName,
            );

            const taskPayload = {
                data: { jobId: 'test-job-123', userId: 'user-456' },
            };

            const [response] = await stubClient.createTask({
                parent: queuePath,
                task: {
                    httpRequest: {
                        httpMethod: 'POST',
                        url: 'https://example.com/handler',
                        headers: { 'Content-Type': 'application/json' },
                        body: Buffer.from(JSON.stringify(taskPayload)).toString('base64'),
                    },
                },
            });

            expect(response).toBeDefined();
            expect(response.name).toBeDefined();
            expect(typeof response.name).toBe('string');
            expect(response.name!.length).toBeGreaterThan(0);
            expect(response.name).toContain(queuePath);
        });

        it('should handle tasks without headers', async () => {
            const queuePath = stubClient.queuePath(
                testConfig.projectId,
                testConfig.location,
                testConfig.queueName,
            );

            const [response] = await stubClient.createTask({
                parent: queuePath,
                task: {
                    httpRequest: {
                        httpMethod: 'POST',
                        url: 'https://example.com/minimal',
                    },
                },
            });

            expect(response).toBeDefined();
            expect(response.name).toBeDefined();
        });

        it('should handle tasks without body', async () => {
            const queuePath = stubClient.queuePath(
                testConfig.projectId,
                testConfig.location,
                testConfig.queueName,
            );

            const [response] = await stubClient.createTask({
                parent: queuePath,
                task: {
                    httpRequest: {
                        httpMethod: 'GET',
                        url: 'https://example.com/status',
                        headers: { 'X-Custom-Header': 'value' },
                    },
                },
            });

            expect(response).toBeDefined();
            expect(response.name).toBeDefined();
        });

        it('should support different HTTP methods', async () => {
            const queuePath = stubClient.queuePath(
                testConfig.projectId,
                testConfig.location,
                testConfig.queueName,
            );

            const methods: Array<'POST' | 'GET' | 'PUT' | 'DELETE'> = ['POST', 'GET', 'PUT', 'DELETE'];

            for (const method of methods) {
                const [response] = await stubClient.createTask({
                    parent: queuePath,
                    task: {
                        httpRequest: {
                            httpMethod: method,
                            url: `https://example.com/${method.toLowerCase()}`,
                        },
                    },
                });

                expect(response, `${method} task created`).toBeDefined();
                expect(response.name, `${method} task has name`).toBeDefined();
            }
        });

        it('should create multiple tasks with unique names', async () => {
            const queuePath = stubClient.queuePath(
                testConfig.projectId,
                testConfig.location,
                testConfig.queueName,
            );

            const taskNames: string[] = [];

            for (let i = 0; i < 3; i++) {
                const [response] = await stubClient.createTask({
                    parent: queuePath,
                    task: {
                        httpRequest: {
                            httpMethod: 'POST',
                            url: `https://example.com/task-${i}`,
                            body: Buffer.from(JSON.stringify({ index: i })).toString('base64'),
                        },
                    },
                });

                taskNames.push(response.name!);
            }

            const uniqueNames = new Set(taskNames);
            expect(uniqueNames.size).toBe(3);

            taskNames.forEach((name, index) => {
                expect(name, `Task ${index} name defined`).toBeDefined();
                expect(name.length, `Task ${index} name not empty`).toBeGreaterThan(0);
            });
        });

        it('should track enqueued tasks for test assertions', async () => {
            const queuePath = stubClient.queuePath(
                testConfig.projectId,
                testConfig.location,
                testConfig.queueName,
            );

            expect(stubClient.getTaskCount()).toBe(0);
            expect(stubClient.getEnqueuedTasks()).toHaveLength(0);
            expect(stubClient.getLastEnqueuedTask()).toBeUndefined();

            const taskPayload = { data: { test: 'value' } };
            const headers = { 'Content-Type': 'application/json' };
            const body = Buffer.from(JSON.stringify(taskPayload)).toString('base64');

            await stubClient.createTask({
                parent: queuePath,
                task: {
                    httpRequest: {
                        httpMethod: 'POST',
                        url: 'https://example.com/test',
                        headers,
                        body,
                    },
                },
            });

            expect(stubClient.getTaskCount()).toBe(1);
            expect(stubClient.getEnqueuedTasks()).toHaveLength(1);

            const lastTask = stubClient.getLastEnqueuedTask();
            expect(lastTask).toBeDefined();
            expect(lastTask?.queuePath).toBe(queuePath);
            expect(lastTask?.url).toBe('https://example.com/test');
            expect(lastTask?.method).toBe('POST');
            expect(lastTask?.headers).toEqual(headers);
            expect(lastTask?.body).toBe(body);
            expect(lastTask?.enqueuedAt).toBeInstanceOf(Date);
        });

        it('should allow clearing enqueued tasks', async () => {
            const queuePath = stubClient.queuePath(
                testConfig.projectId,
                testConfig.location,
                testConfig.queueName,
            );

            for (let i = 0; i < 3; i++) {
                await stubClient.createTask({
                    parent: queuePath,
                    task: {
                        httpRequest: {
                            httpMethod: 'POST',
                            url: `https://example.com/task-${i}`,
                        },
                    },
                });
            }

            expect(stubClient.getTaskCount()).toBe(3);

            stubClient.clear();

            expect(stubClient.getTaskCount()).toBe(0);
            expect(stubClient.getEnqueuedTasks()).toHaveLength(0);
            expect(stubClient.getLastEnqueuedTask()).toBeUndefined();
        });

        it('should reset task counter after clear', async () => {
            const queuePath = stubClient.queuePath(
                testConfig.projectId,
                testConfig.location,
                testConfig.queueName,
            );

            const [firstTask] = await stubClient.createTask({
                parent: queuePath,
                task: {
                    httpRequest: {
                        httpMethod: 'POST',
                        url: 'https://example.com/task-1',
                    },
                },
            });

            expect(firstTask.name).toContain('stub-task-1');

            stubClient.clear();

            const [newTask] = await stubClient.createTask({
                parent: queuePath,
                task: {
                    httpRequest: {
                        httpMethod: 'POST',
                        url: 'https://example.com/task-new',
                    },
                },
            });

            // Should be stub-task-1 again, not stub-task-2
            expect(newTask.name).toContain('stub-task-1');
        });
    });

    describe('Stub Implementation - Detailed Task Tracking', () => {
        it('should capture all task request details', async () => {
            const queuePath = stubClient.queuePath(
                testConfig.projectId,
                testConfig.location,
                testConfig.queueName,
            );

            const url = 'https://us-central1-my-project.cloudfunctions.net/handleMerge';
            const method = 'POST';
            const headers = {
                'Content-Type': 'application/json',
                'X-CloudTasks-QueueName': testConfig.queueName,
            };
            const payload = { jobId: 'merge-123', userId: 'user-456' };
            const body = Buffer.from(JSON.stringify({ data: payload })).toString('base64');

            await stubClient.createTask({
                parent: queuePath,
                task: {
                    httpRequest: {
                        httpMethod: method,
                        url,
                        headers,
                        body,
                    },
                },
            });

            const tasks = stubClient.getEnqueuedTasks();
            expect(tasks).toHaveLength(1);

            const task = tasks[0];
            expect(task.queuePath).toBe(queuePath);
            expect(task.url).toBe(url);
            expect(task.method).toBe(method);
            expect(task.headers).toEqual(headers);
            expect(task.body).toBe(body);
            expect(task.enqueuedAt).toBeInstanceOf(Date);
            expect(Date.now() - task.enqueuedAt.getTime()).toBeLessThan(1000);
        });

        it('should track multiple tasks in order', async () => {
            const queuePath = stubClient.queuePath(
                testConfig.projectId,
                testConfig.location,
                testConfig.queueName,
            );

            const urls = [
                'https://example.com/task-1',
                'https://example.com/task-2',
                'https://example.com/task-3',
            ];

            for (const url of urls) {
                await stubClient.createTask({
                    parent: queuePath,
                    task: {
                        httpRequest: {
                            httpMethod: 'POST',
                            url,
                        },
                    },
                });
            }

            const tasks = stubClient.getEnqueuedTasks();
            expect(tasks).toHaveLength(3);

            tasks.forEach((task, index) => {
                expect(task.url).toBe(urls[index]);
            });
        });
    });
});
