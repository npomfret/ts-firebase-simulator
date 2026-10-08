import { type AuthClientConfig, type IAuthClient, IdentityToolkitError, type SignInWithCustomTokenResponse, type SignInWithPasswordResponse } from './auth-client-types';

/**
 * Calls the Identity Toolkit REST API with fetch. A network failure is rethrown as is;
 * an error response becomes an IdentityToolkitError.
 */
class IdentityToolkitClient implements IAuthClient {
    constructor(private readonly config: AuthClientConfig) {}

    signInWithPassword(request: { email: string; password: string; returnSecureToken: boolean; }): Promise<SignInWithPasswordResponse> {
        return this.post('signInWithPassword', request);
    }

    signInWithCustomToken(request: { token: string; returnSecureToken: true; }): Promise<SignInWithCustomTokenResponse> {
        return this.post('signInWithCustomToken', request);
    }

    private async post<T>(method: string, body: object): Promise<T> {
        const response = await fetch(`${this.config.baseUrl}/v1/accounts:${method}?key=${this.config.apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const text = await response.text();
        if (response.ok) {
            return JSON.parse(text) as T;
        }
        throw new IdentityToolkitError(response.status, errorMessage(text) ?? `HTTP_${response.status}`);
    }
}

/** The message of an error body, `{ error: { message } }`, if the body is one */
function errorMessage(text: string): string | undefined {
    try {
        const message: unknown = (JSON.parse(text) as { error?: { message?: unknown; }; } | null)?.error?.message;
        return typeof message === 'string' ? message : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Create a Firebase Auth REST API client
 */
export function createAuthClient(config: AuthClientConfig): IAuthClient {
    return new IdentityToolkitClient(config);
}
