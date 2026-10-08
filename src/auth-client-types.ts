/**
 * Interface for the Firebase Auth REST API (Identity Toolkit) calls a server makes with a web API key
 * Request and response bodies as the REST API defines them, trimmed to the fields supported
 */
export interface IAuthClient {
    /** `accounts:signInWithPassword` */
    signInWithPassword(request: { email: string; password: string; returnSecureToken: boolean; }): Promise<SignInWithPasswordResponse>;
    /** `accounts:signInWithCustomToken` */
    signInWithCustomToken(request: { token: string; returnSecureToken: true; }): Promise<SignInWithCustomTokenResponse>;
    /** `accounts:resetPassword`: without `newPassword` it reads a code of any type; with it, it uses a password-reset code */
    resetPassword(request: { oobCode: string; newPassword?: string; }): Promise<ResetPasswordResponse>;
    /** `accounts:update` with an `oobCode`: applies a VERIFY_EMAIL or VERIFY_AND_CHANGE_EMAIL code */
    applyActionCode(request: { oobCode: string; }): Promise<UpdateAccountResponse>;
}

export interface SignInWithPasswordResponse {
    localId: string;
    email: string;
    idToken?: string;
    refreshToken?: string;
    /** The ID token's lifetime in seconds, e.g. "3600" */
    expiresIn?: string;
}

export interface SignInWithCustomTokenResponse {
    idToken: string;
    refreshToken: string;
    /** The ID token's lifetime in seconds, e.g. "3600" */
    expiresIn: string;
}

/** The kinds of action code (oobCode) supported */
export type ActionCodeRequestType = 'PASSWORD_RESET' | 'VERIFY_EMAIL' | 'VERIFY_AND_CHANGE_EMAIL';

export interface ResetPasswordResponse {
    requestType: ActionCodeRequestType;
    /** The account email the code was issued for */
    email: string;
    /** A VERIFY_AND_CHANGE_EMAIL code's new email */
    newEmail?: string;
}

export interface UpdateAccountResponse {
    localId: string;
    /** The account email, after any change the code made */
    email: string;
    emailVerified: boolean;
}

export interface AuthClientConfig {
    /** The project's web API key */
    apiKey: string;
    /** e.g. `https://identitytoolkit.googleapis.com`, or the emulator's `http://127.0.0.1:9099/identitytoolkit.googleapis.com` */
    baseUrl: string;
}

/**
 * Thrown by both implementations for an error response. The message is Firebase's, e.g.
 * `INVALID_CUSTOM_TOKEN : Invalid assertion format`.
 */
export class IdentityToolkitError extends Error {
    /** The reason the message starts with, before any " : " detail, e.g. `INVALID_CUSTOM_TOKEN` */
    readonly reason: string;

    constructor(readonly status: number, message: string) {
        super(message);
        this.name = 'IdentityToolkitError';
        this.reason = message.split(' : ')[0].trim();
    }
}
