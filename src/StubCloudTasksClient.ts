import type { ICloudTasksClient, OidcToken } from './cloudtasks-types';

/**
 * Task that has been enqueued
 */
export interface EnqueuedTask {
    taskName: string;
    queuePath: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    /** OIDC token config if provided (not validated in stub, just stored) */
    oidcToken?: OidcToken;
    enqueuedAt: Date;
}

/**
 * Stub implementation of Cloud Tasks client for testing
 */
export class StubCloudTasksClient implements ICloudTasksClient {
    private enqueuedTasks: EnqueuedTask[] = [];
    private taskCounter = 0;

    /**
     * Generate a queue path (matches GCP format)
     */
    queuePath(projectId: string, location: string, queueName: string): string {
        return `projects/${projectId}/locations/${location}/queues/${queueName}`;
    }

    /**
     * "Create" a task by storing it in memory
     */
    async createTask(request: {
        parent: string;
        task: {
            httpRequest: {
                httpMethod: 'POST' | 'GET' | 'PUT' | 'DELETE';
                url: string;
                headers?: Record<string, string>;
                body?: string;
                oidcToken?: OidcToken;
            };
        };
    }): Promise<[{ name: string; }]> {
        this.taskCounter++;
        const taskName = `${request.parent}/tasks/stub-task-${this.taskCounter}`;

        const task: EnqueuedTask = {
            taskName,
            queuePath: request.parent,
            url: request.task.httpRequest.url,
            method: request.task.httpRequest.httpMethod,
            headers: request.task.httpRequest.headers || {},
            body: request.task.httpRequest.body || '',
            oidcToken: request.task.httpRequest.oidcToken,
            enqueuedAt: new Date(),
        };

        this.enqueuedTasks.push(task);

        return [{ name: taskName }];
    }

    /**
     * Get all enqueued tasks (for test assertions)
     */
    getEnqueuedTasks(): readonly EnqueuedTask[] {
        return [...this.enqueuedTasks];
    }

    /**
     * Get the last enqueued task (convenience method)
     */
    getLastEnqueuedTask(): EnqueuedTask | undefined {
        return this.enqueuedTasks[this.enqueuedTasks.length - 1];
    }

    /**
     * Get count of enqueued tasks
     */
    getTaskCount(): number {
        return this.enqueuedTasks.length;
    }

    /**
     * Clear all enqueued tasks
     */
    clear(): void {
        this.enqueuedTasks = [];
        this.taskCounter = 0;
    }
}
