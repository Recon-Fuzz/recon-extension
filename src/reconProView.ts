import * as vscode from 'vscode';
import { AuthService, AuthState } from './services/authService';

export class ReconProViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly authService: AuthService,
        private readonly _context: vscode.ExtensionContext
    ) {
        // No command registration needed here anymore
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.type) {
                case 'openExternal':
                    vscode.env.openExternal(vscode.Uri.parse(message.url));
                    break;
                case 'login':
                    await this.authService.signIn();
                    break;
                case 'logout':
                    await this.authService.signOut();
                    break;
            }
        });
    }

    private _getHtmlForWebview(): string {
        const toolkitUri = this._view?.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/webview-ui-toolkit', 'dist', 'toolkit.min.js')
        );

        const codiconsUri = this._view?.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
        );

        const iconUri = this._view?.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'images', 'icon.png')
        );

        const authState = this.authService.getAuthState();

        return `<!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width,initial-scale=1.0">
            <script type="module" src="${toolkitUri}"></script>
            <link href="${codiconsUri}" rel="stylesheet" />
            <style>
                body {
                    padding: 16px;
                    color: var(--vscode-foreground);
                    font-family: var(--vscode-font-family);
                }

                .pro-card {
                    background: linear-gradient(288deg, rgba(30, 13, 66, .67) -21.63%, hsla(0, 0%, 9%, .67) 92%);
                    border-radius: 16px;
                    padding: 24px;
                    margin-bottom: 20px;
                    backdrop-filter: blur(10px);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                }

                .pro-icon {
                    width: 64px;
                    height: 64px;
                    margin: 0 auto 16px;
                    display: block;
                }

                .pro-header {
                    font-size: 1.5em;
                    font-weight: bold;
                    margin-bottom: 16px;
                    color: #fff;
                    text-align: center;
                }

                .feature-list {
                    list-style: none;
                    padding: 0;
                    margin: 20px 0;
                }

                .feature-item {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    margin-bottom: 12px;
                    color: #fff;
                    opacity: 0.9;
                }

                .feature-item i {
                    color: #5c25d2;
                }

                .learn-more {
                    display: flex;
                    justify-content: center;
                    margin-top: 24px;
                }

                .learn-more-btn {
                    background: #5c25d2;
                    color: white;
                    text-decoration: none;
                    padding: 10px 20px;
                    border-radius: 20px;
                    display: inline-flex;
                    align-items: center;
                    gap: 8px;
                    font-weight: 500;
                    border: none;
                    cursor: pointer;
                    transition: background-color 0.3s ease;
                }

                .learn-more-btn:hover {
                    background: #4a1ea8;
                }

                .login-section {
                    text-align: center;
                    margin-top: 20px;
                    padding: 0 24px;
                }

                .github-login-btn {
                    width: 100%;
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 10px 16px;
                    border-radius: 6px;
                    cursor: pointer;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                    font-size: 14px;
                    font-weight: 500;
                    transition: all 0.2s ease;
                }

                .github-login-btn:hover {
                    background: var(--vscode-button-hoverBackground);
                }

                .github-login-btn i.codicon-github {
                    font-size: 16px;
                }

                .github-login-btn.loading {
                    opacity: 0.7;
                    cursor: wait;
                    pointer-events: none;
                }

                .github-login-btn.loading i {
                    animation: spin 1s linear infinite;
                }

                @keyframes spin {
                    100% { transform: rotate(360deg); }
                }

                @keyframes gradient {
                    0% { background-position: 0% 50%; }
                    50% { background-position: 100% 50%; }
                    100% { background-position: 0% 50%; }
                }
            </style>
        </head>
        <body>
            ${!authState.isPro ? `
            <div class="pro-card">
                <img src="${iconUri}" alt="Recon Pro" class="pro-icon">
                <div class="pro-header">
                    Upgrade to PRO!
                </div>
                <div class="feature-list">
                    <div class="feature-item">
                        <i class="codicon codicon-check"></i>
                        Run invariant tests in the Cloud
                    </div>
                    <div class="feature-item">
                        <i class="codicon codicon-check"></i>
                        Add Public and Private Repos
                    </div>
                    <div class="feature-item">
                        <i class="codicon codicon-check"></i>
                        Automated Runs on PR or Commit
                    </div>
                    <div class="feature-item">
                        <i class="codicon codicon-check"></i>
                        Multiple simultaneous cloud fuzzers
                    </div>
                    <div class="feature-item">
                        <i class="codicon codicon-check"></i>
                        Automated Test Generation
                    </div>
                    <div class="feature-item">
                        <i class="codicon codicon-check"></i>
                        Advanced Builder
                    </div>
                    <div class="feature-item">
                        <i class="codicon codicon-check"></i>
                        Store common job recipes
                    </div>
                    <div class="feature-item">
                        <i class="codicon codicon-check"></i>
                        Shareable Job Reports
                    </div>
                    <div class="feature-item">
                        <i class="codicon codicon-check"></i>
                        Private Coaching
                    </div>
                </div>
                <div class="learn-more">
                    <button class="learn-more-btn" onclick="openProPage()">
                        <i class="codicon codicon-link-external"></i>
                        Read more
                    </button>
                </div>
            </div>
            ` : ''}
            <div class="login-section">
                <button class="github-login-btn" onclick="handleLogin()">
                    <i class="codicon codicon-github"></i>
                    <span>Continue with GitHub</span>
                </button>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                const authState = ${JSON.stringify(authState)};

                function openProPage() {
                    vscode.postMessage({
                        type: 'openExternal',
                        url: 'https://getrecon.xyz/pro'
                    });
                }

                function handleLogin() {
                    const loginBtn = document.querySelector('.github-login-btn');
                    loginBtn.classList.add('loading');
                    loginBtn.querySelector('i').classList.replace('codicon-github', 'codicon-sync');
                    loginBtn.querySelector('span').textContent = 'Authenticating...';
                    vscode.postMessage({ type: 'login' });
                }

                function handleLogout() {
                    const loginBtn = document.querySelector('.github-login-btn');
                    loginBtn.classList.add('loading');
                    loginBtn.querySelector('i').classList.replace('codicon-sign-out', 'codicon-sync');
                    loginBtn.querySelector('span').textContent = 'Signing out...';
                    vscode.postMessage({ type: 'logout' });
                }

                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.type) {
                        case 'authStateChanged':
                            updateAuthState(message.state);
                            break;
                        case 'authCancelled':
                            restoreButton();
                            break;
                    }
                });

                function updateAuthState(state) {
                    const loginBtn = document.querySelector('.github-login-btn');
                    loginBtn.classList.remove('loading');
                    if (state.isLoggedIn) {
                        loginBtn.innerHTML = '<i class="codicon codicon-sign-out"></i><span>Sign Out</span>';
                        loginBtn.onclick = handleLogout;
                    } else {
                        loginBtn.innerHTML = '<i class="codicon codicon-github"></i><span>Continue with GitHub</span>';
                        loginBtn.onclick = handleLogin;
                    }
                }

                function restoreButton() {
                    const loginBtn = document.querySelector('.github-login-btn');
                    loginBtn.classList.remove('loading');
                    loginBtn.innerHTML = '<i class="codicon codicon-github"></i><span>Continue with GitHub</span>';
                    loginBtn.onclick = handleLogin;
                }

                // Initialize state
                updateAuthState(authState);
            </script>
        </body>
        </html>`;
    }
}
