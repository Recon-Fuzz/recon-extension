import * as vscode from 'vscode';
import { CLIENT_ID, proxyRequest } from '../pro/utils';

export interface AuthState {
    isLoggedIn: boolean;
    isPro: boolean;
}

export class AuthService {
    private static readonly ACCESS_TOKEN_KEY = 'recon.accessToken';
    private currentState: AuthState = { isLoggedIn: false, isPro: false };
    private deviceCodeCheckInterval?: NodeJS.Timeout;
    private isAuthenticating = false;
    private _onAuthStateChanged = new vscode.EventEmitter<AuthState>();
    public readonly onAuthStateChanged = this._onAuthStateChanged.event;

    constructor(private context: vscode.ExtensionContext) {
        this.currentState = context.globalState.get<AuthState>('authState') || { isLoggedIn: false, isPro: false };
        
        // Register auth commands
        this.context.subscriptions.push(
            vscode.commands.registerCommand('recon.authStateChanged', (state: AuthState) => {
                this.handleAuthStateChanged(state);
            }),
            vscode.commands.registerCommand('recon.authCancelled', () => {
                this.handleAuthCancelled();
            }),
            vscode.commands.registerCommand('recon.signOut', () => {
                this.signOut();
            })
        );

        // Validate token on startup
        this.validateToken().catch(() => {
            this.signOut();
        });
    }

    private handleAuthStateChanged(state: AuthState) {
        vscode.commands.executeCommand('setContext', 'recon:isPro', state.isPro);
        this.notifyWebviews(state);
    }

    private handleAuthCancelled() {
        this.notifyWebviews({ type: 'authCancelled' });
    }

    private notifyWebviews(message: any) {
        // Use VS Code's built-in message passing
        vscode.window.visibleTextEditors.forEach(editor => {
            const viewColumn = editor.viewColumn;
            if (viewColumn) {
                vscode.window.showTextDocument(editor.document, viewColumn);
            }
        });
    }

    public async signIn(): Promise<void> {
        if (this.isAuthenticating) {
            vscode.window.showInformationMessage('Authentication already in progress...');
            return;
        }

        try {
            this.isAuthenticating = true;
            // Get device code
            const deviceCodeResponse = await fetch('https://github.com/login/device/code', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    client_id: CLIENT_ID,
                    scope: 'read:user'
                })
            });

            const deviceData = await deviceCodeResponse.json();
            if (deviceData.error) {
                if (deviceData.error === 'slow_down' || deviceData.error === 'rate_limited') {
                    throw new Error('Too many requests. Please wait a moment and try again.');
                }
                throw new Error(deviceData.error_description || 'Failed to get device code');
            }

            // Show verification URL and code to user
            const continueButton = 'Copy and Continue';
            const cancelButton = 'Cancel';
            const message = `Please enter code: ${deviceData.user_code}`;

            const selection = await vscode.window.showInformationMessage(message, continueButton, cancelButton);
            if (selection === continueButton) {
                await vscode.env.clipboard.writeText(deviceData.user_code);
                await vscode.env.openExternal(vscode.Uri.parse(deviceData.verification_uri));
                // Poll for token
                await this.pollForToken(deviceData.device_code, deviceData.interval);
            } else if (selection === cancelButton || selection === undefined) {
                // User cancelled or closed the dialog, notify UI to restore button state
                this.notifyAuthCancelled();
                return;
            }

        } catch (error) {
            vscode.window.showErrorMessage(`Authentication failed: ${error}`);
            throw error;
        } finally {
            this.isAuthenticating = false;
        }
    }

    private notifyAuthCancelled(): void {
        vscode.commands.executeCommand('recon.authCancelled');
    }

    private async pollForToken(deviceCode: string, interval: number): Promise<void> {
        return new Promise((resolve, reject) => {
            // Clear any existing interval
            if (this.deviceCodeCheckInterval) {
                clearInterval(this.deviceCodeCheckInterval);
            }

            const pollFn = async () => {
                try {
                    const response = await fetch('https://github.com/login/oauth/access_token', {
                        method: 'POST',
                        headers: {
                            'Accept': 'application/json',
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            client_id: CLIENT_ID,
                            device_code: deviceCode,
                            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
                        })
                    });

                    const data = await response.json();

                    if (data.error) {
                        if (data.error === 'authorization_pending') {
                            // Still waiting for user to authorize
                            return;
                        }
                        if (data.error === 'slow_down') {
                            // Increase polling interval
                            clearInterval(this.deviceCodeCheckInterval);
                            this.deviceCodeCheckInterval = setInterval(pollFn, (interval + 5) * 1000);
                            return;
                        }
                        // Other errors - stop polling
                        clearInterval(this.deviceCodeCheckInterval);
                        reject(new Error(data.error_description || 'Token request failed'));
                        return;
                    }

                    if (data.access_token) {
                        clearInterval(this.deviceCodeCheckInterval);
                        console.log('Access token received:', data.access_token);
                        await this.context.secrets.store(AuthService.ACCESS_TOKEN_KEY, data.access_token);
                        await this.validateToken();
                        resolve();
                    }
                } catch (error) {
                    clearInterval(this.deviceCodeCheckInterval);
                    reject(error);
                }
            };

            this.deviceCodeCheckInterval = setInterval(pollFn, interval * 1000);
        });
    }

    private async validateToken(): Promise<void> {
        const token = await this.context.secrets.get(AuthService.ACCESS_TOKEN_KEY);
        if (!token) {
            throw new Error('No access token found');
        }
        console.log('Access token received:', token);
        const isProUser = await this.checkProStatus(token);
        
        this.currentState = {
            isLoggedIn: true,
            isPro: isProUser
        };

        await this.context.globalState.update('authState', this.currentState);
        this.notifyStateChange();
    }

    public async getAccessToken(): Promise<string | undefined> {
        if (!this.currentState.isLoggedIn) {
            return undefined;
        }
        return await this.context.secrets.get(AuthService.ACCESS_TOKEN_KEY);
    }

    private async checkProStatus(token: string): Promise<boolean> {
        try {
            const response = await proxyRequest('GET', '/organizations/my', token);

            if (!response.ok) {
                // Delete token if it's invalid
                await this.context.secrets.delete(AuthService.ACCESS_TOKEN_KEY);
                console.error('Failed to check pro status:', await response.text());
                return false;
            }

            const data = await response.json();
            return data.data?.billingStatus === 'PAID';
        } catch (error) {
            // Delete token on any error as it might be invalid
            await this.context.secrets.delete(AuthService.ACCESS_TOKEN_KEY);
            console.error('Error checking pro status:', error);
            return false;
        }
    }

    public getAuthState(): AuthState {
        return this.currentState;
    }

    private notifyStateChange(): void {
        vscode.commands.executeCommand('recon.authStateChanged', this.currentState);
        this._onAuthStateChanged.fire(this.currentState);
    }

    public async signOut(): Promise<void> {
        if (this.isAuthenticating) {
            this.isAuthenticating = false;
        }
        if (this.deviceCodeCheckInterval) {
            clearInterval(this.deviceCodeCheckInterval);
        }
        
        // Clear token from secret storage
        await this.context.secrets.delete(AuthService.ACCESS_TOKEN_KEY);
        
        this.currentState = { isLoggedIn: false, isPro: false };
        await this.context.globalState.update('authState', this.currentState);
        this.notifyStateChange();
    }
}
