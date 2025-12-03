/**
 * OIDC token configuration for authenticated Cloud Task requests
 */
export interface OidcToken {
    /** Service account email that will sign the token */
    serviceAccountEmail: string;
    /** Audience for the token (typically the target URL) */
    audience?: string;
}

/**
 * Interface for Cloud Tasks client operations
 * Abstracts the Google Cloud Tasks API for dependency injection and testing
 */
export interface ICloudTasksClient {
    /**
     * Get the full queue path for Cloud Tasks
     */
    queuePath(projectId: string, location: string, queueName: string): string;

    /**
     * Create a new task in the specified queue
     */
    createTask(request: {
        parent: string;
        task: {
            httpRequest: {
                httpMethod: 'POST' | 'GET' | 'PUT' | 'DELETE';
                url: string;
                headers?: Record<string, string>;
                body?: string;
                /** OIDC token for authenticating the task request */
                oidcToken?: OidcToken;
            };
        };
    }): Promise<[{ name: string; }]>;
}
