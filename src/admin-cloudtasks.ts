import { CloudTasksClient as GoogleCloudTasksClient } from '@google-cloud/tasks';
import type { ICloudTasksClient } from './cloudtasks-types';

/**
 * Wraps the real Google Cloud Tasks client to match our interface
 */
export class CloudTasksClientWrapper implements ICloudTasksClient {
    constructor(private readonly client: GoogleCloudTasksClient) {}

    queuePath(projectId: string, location: string, queueName: string): string {
        return this.client.queuePath(projectId, location, queueName);
    }

    async createTask(request: {
        parent: string;
        task: {
            httpRequest: {
                httpMethod: 'POST' | 'GET' | 'PUT' | 'DELETE';
                url: string;
                headers?: Record<string, string>;
                body?: string;
            };
        };
    }): Promise<[{ name: string; }]> {
        const [task] = await this.client.createTask(request as any);
        return [{ name: task.name || '' }];
    }
}

/**
 * Create a wrapped Cloud Tasks client
 */
export function createCloudTasksClient(): ICloudTasksClient {
    return new CloudTasksClientWrapper(new GoogleCloudTasksClient());
}
