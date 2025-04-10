import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getFoundryConfigPath } from './utils';
import { EchidnaMode, FuzzerTool } from './types';

export class ReconMainViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) {
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.type) {
                case 'generate':
                    vscode.commands.executeCommand('recon.installChimera');
                    break;
                case 'selectFoundryConfig':
                    this.selectFoundryConfig();
                    break;
                case 'updateEchidnaMode':
                    await vscode.workspace.getConfiguration('recon').update('echidna.mode', message.value, vscode.ConfigurationTarget.Workspace);
                    break;
                case 'updateEchidnaTestLimit':
                    await vscode.workspace.getConfiguration('recon').update('echidna.testLimit', message.value, vscode.ConfigurationTarget.Workspace);
                    break;
                case 'updateEchidnaWorkers':
                    await vscode.workspace.getConfiguration('recon').update('echidna.workers', message.value, vscode.ConfigurationTarget.Workspace);
                    break;
                case 'updateMedusaTestLimit':
                    await vscode.workspace.getConfiguration('recon').update('medusa.testLimit', message.value, vscode.ConfigurationTarget.Workspace);
                    break;
                case 'updateMedusaWorkers':
                    await vscode.workspace.getConfiguration('recon').update('medusa.workers', message.value, vscode.ConfigurationTarget.Workspace);
                    break;
                case 'openSettings':
                    vscode.commands.executeCommand('workbench.action.openWorkspaceSettings', '@ext:Recon-Fuzz.recon');
                    break;
                case 'updateDefaultFuzzer':
                    await vscode.workspace.getConfiguration('recon').update('defaultFuzzer', message.value, vscode.ConfigurationTarget.Workspace);
                    this._updateWebview();
                    break;
                case 'runFuzzer':
                    const defaultFuzzer = vscode.workspace.getConfiguration('recon').get<string>('defaultFuzzer', FuzzerTool.ECHIDNA);
                    if (defaultFuzzer === FuzzerTool.ECHIDNA) {
                        vscode.commands.executeCommand('recon.runEchidna');
                    } else {
                        vscode.commands.executeCommand('recon.runMedusa');
                    }
                    break;
            }
        });

        this._updateWebview();
    }

    private async selectFoundryConfig(): Promise<void> {
        if (!vscode.workspace.workspaceFolders) { return; }

        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri;
        const files = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspaceRoot, '**/foundry.toml'),
            '**/node_modules/**'
        );

        if (files.length === 0) {
            vscode.window.showErrorMessage('No foundry.toml files found in workspace');
            return;
        }

        const items = files.map(file => ({
            label: vscode.workspace.asRelativePath(file),
            file
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select foundry.toml file'
        });

        if (selected) {
            const relativePath = vscode.workspace.asRelativePath(selected.file);
            await vscode.workspace.getConfiguration('recon').update('foundryConfigPath', relativePath, vscode.ConfigurationTarget.Workspace);
            this._updateWebview();
        }
    }

    private _updateWebview() {
        if (!this._view) { return; }

        let mainContent: string;
        if (!vscode.workspace.workspaceFolders) {
            mainContent = this._getNoWorkspaceContent();
        } else {
            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const foundryPath = getFoundryConfigPath(workspaceRoot);

            if (!fs.existsSync(foundryPath)) {
                mainContent = this._getNotFoundryContent();
            } else {
                mainContent = this._getMainContent();
            }
        }

        this._view.webview.html = this._getHtmlForWebview(mainContent);
    }

    private getCodiconsUri(): vscode.Uri {
        return vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css');
    }

    private getToolkitUri(): vscode.Uri {
        return vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/webview-ui-toolkit', 'dist', 'toolkit.min.js');
    }

    private _getHtmlForWebview(mainContent: string): string {
        const codiconsUri = this._view?.webview.asWebviewUri(this.getCodiconsUri());
        const toolkitUri = this._view?.webview.asWebviewUri(this.getToolkitUri());

        return `<!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width,initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${this._view?.webview.cspSource}; script-src 'unsafe-inline' ${this._view?.webview.cspSource}; font-src ${this._view?.webview.cspSource};">
                <link href="${codiconsUri}" rel="stylesheet" />
                <script type="module" src="${toolkitUri}"></script>
                <title>Recon</title>
                <style>
                    body { 
                        padding: 10px; 
                        color: var(--vscode-foreground);
                        font-family: var(--vscode-font-family);
                    }
                    .button-container {
                        margin-bottom: 16px;
                    }
                    vscode-button::part(control) {
                        background: #5c25d2;
                        color: white;
                        border: none;
                        padding: 8px 12px;
                    }
                    vscode-button:hover::part(control) {
                        background: #4a1ea8;
                    }
                    vscode-checkbox {
                        --control-height: 12px;
                        --control-width: 12px;
                    }
                    #generate-btn {
                        width: 100%;
                    }
                    .no-contracts {
                        color: var(--vscode-descriptionForeground);
                        font-style: italic;
                        margin-top: 8px;
                    }
                    .generate-btn-content {
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        gap: 8px;
                        width: 100%;
                    }

                    .codicon {
                        font-size: 16px;
                    }
                    .settings-container {
                        margin-top: 16px;
                        display: flex;
                        flex-direction: column;
                        gap: 12px;
                    }
                    .setting-group {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                    }
                    .setting-group label {
                        min-width: 100px;
                        font-size: 12px;
                    }
                    vscode-dropdown, vscode-text-field {
                        flex: 1;
                    }
                    .header {
                        display: flex;
                        gap: 8px;
                        margin-bottom: 16px;
                    }
                    #generate-btn {
                        flex: 1;
                    }
                    #settings-btn::part(control) {
                        background: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                    }
                    #settings-btn:hover::part(control) {
                        background: var(--vscode-button-secondaryHoverBackground);
                    }
                    .fuzzer-selection {
                        margin-bottom: 16px;
                    }
                    .fuzzer-selection-label {
                        font-size: 12px;
                        margin-bottom: 8px;
                        font-weight: 500;
                    }
                    vscode-radio-group {
                        display: flex;
                        gap: 16px;
                        margin-bottom: 16px;
                    }
                    #fuzz-btn {
                        width: 100%;
                        margin-top: 16px;
                    }
                </style>
            </head>
            <body>
                ${mainContent}
                <script>
                    const vscode = acquireVsCodeApi();
                    
                    // Listen for button clicks and handle based on data attributes
                    document.addEventListener('click', (e) => {
                        const button = e.target.closest('vscode-button');
                        if (!button) return;
                        
                        // Check for specific button actions
                        if (button.id === 'generate-btn') {
                            vscode.postMessage({ type: 'generate' });
                        } else if (button.id === 'settings-btn') {
                            vscode.postMessage({ type: 'openSettings' });
                        } else if (button.id === 'fuzz-btn') {
                            vscode.postMessage({ type: 'runFuzzer' });
                        } else if (button.hasAttribute('data-select-config')) {
                            vscode.postMessage({ type: 'selectFoundryConfig' });
                        }
                    });

                    // Handle Echidna mode changes
                    document.getElementById('echidna-mode')?.addEventListener('change', (e) => {
                        vscode.postMessage({
                            type: 'updateEchidnaMode',
                            value: e.target.value
                        });
                    });

                    // Handle test limit changes
                    document.getElementById('echidna-test-limit')?.addEventListener('change', (e) => {
                        const value = parseInt(e.target.value, 10);
                        if (!isNaN(value) && value >= 1) {
                            vscode.postMessage({
                                type: 'updateEchidnaTestLimit',
                                value: value
                            });
                        }
                    });

                    // Handle workers changes
                    document.getElementById('echidna-workers')?.addEventListener('change', (e) => {
                        const value = parseInt(e.target.value, 10);
                        if (!isNaN(value) && value >= 1) {
                            vscode.postMessage({
                                type: 'updateEchidnaWorkers',
                                value: value
                            });
                        }
                    });
                    
                    // Handle Medusa test limit changes
                    document.getElementById('medusa-test-limit')?.addEventListener('change', (e) => {
                        const value = parseInt(e.target.value, 10);
                        if (!isNaN(value) && value >= 1) {
                            vscode.postMessage({
                                type: 'updateMedusaTestLimit',
                                value: value
                            });
                        }
                    });

                    // Handle Medusa workers changes
                    document.getElementById('medusa-workers')?.addEventListener('change', (e) => {
                        const value = parseInt(e.target.value, 10);
                        if (!isNaN(value) && value >= 1) {
                            vscode.postMessage({
                                type: 'updateMedusaWorkers',
                                value: value
                            });
                        }
                    });

                    // Update settings visibility based on fuzzer selection
                    document.getElementById('fuzzer-selection')?.addEventListener('change', (e) => {
                        const echidnaSettings = document.getElementById('echidna-settings');
                        const medusaSettings = document.getElementById('medusa-settings');
                        if (e.target.value === '${FuzzerTool.ECHIDNA}') {
                            echidnaSettings.style.display = '';
                            medusaSettings.style.display = 'none';
                        } else {
                            echidnaSettings.style.display = 'none';
                            medusaSettings.style.display = '';
                        }
                        vscode.postMessage({
                            type: 'updateDefaultFuzzer',
                            value: e.target.value
                        });
                    });
                </script>
            </body>
        </html>`;
    }

    private _getNoWorkspaceContent(): string {
        return `
            <div class="no-workspace">
                <vscode-button appearance="secondary">No workspace opened</vscode-button>
            </div>
        `;
    }

    private _getNotFoundryContent(): string {
        const configPath = vscode.workspace.getConfiguration('recon').get<string>('foundryConfigPath', 'foundry.toml');
        return `
            <div class="not-foundry">
                <vscode-button appearance="secondary" data-select-config>
                    <i class="codicon codicon-folder-opened" style="margin-right: 2px;"></i>
                    Select foundry.toml
                </vscode-button>
                <p>foundry.toml not found at: ${configPath}<br>Click button to select the file</p>
            </div>
        `;
    }

    private _getMainContent(): string {
        const config = vscode.workspace.getConfiguration('recon');
        const defaultFuzzer = config.get('defaultFuzzer') || FuzzerTool.ECHIDNA;
        const echidnaMode = config.get('echidna.mode', EchidnaMode.ASSERTION) as EchidnaMode;
        const echidnaTestLimit = config.get('echidna.testLimit', 1000000);
        const echidnaWorkers = config.get('echidna.workers', 1);
        const medusaTestLimit = config.get('medusa.testLimit', 1000000);
        const medusaWorkers = config.get('medusa.workers', 1);

        return `
            <div class="button-container">
                <div class="header">
                    <vscode-button id="generate-btn" appearance="primary">
                        <span class="generate-btn-content">
                            <i class="codicon codicon-wand"></i>
                            Scaffold
                        </span>
                    </vscode-button>
                    <vscode-button id="settings-btn" appearance="secondary">
                        <span class="generate-btn-content">
                            <i class="codicon codicon-gear"></i>
                        </span>
                    </vscode-button>
                </div>
                
                <div class="fuzzer-selection">
                    <div class="fuzzer-selection-label">Fuzzer:</div>
                    <vscode-radio-group id="fuzzer-selection" value="${defaultFuzzer}">
                        <vscode-radio value="${FuzzerTool.ECHIDNA}">Echidna</vscode-radio>
                        <vscode-radio value="${FuzzerTool.MEDUSA}">Medusa</vscode-radio>
                    </vscode-radio-group>
                </div>

                <div class="settings-container" ${defaultFuzzer !== FuzzerTool.ECHIDNA ? 'style="display: none;"' : ''} id="echidna-settings">
                    <div class="setting-group">
                        <label>Echidna Mode:</label>
                        <vscode-dropdown id="echidna-mode">
                            <vscode-option value="${EchidnaMode.PROPERTY}" ${echidnaMode === EchidnaMode.PROPERTY ? 'selected' : ''}>Property</vscode-option>
                            <vscode-option value="${EchidnaMode.ASSERTION}" ${echidnaMode === EchidnaMode.ASSERTION ? 'selected' : ''}>Assertion</vscode-option>
                            <vscode-option value="${EchidnaMode.OPTIMIZATION}" ${echidnaMode === EchidnaMode.OPTIMIZATION ? 'selected' : ''}>Optimization</vscode-option>
                            <vscode-option value="${EchidnaMode.OVERFLOW}" ${echidnaMode === EchidnaMode.OVERFLOW ? 'selected' : ''}>Overflow</vscode-option>
                            <vscode-option value="${EchidnaMode.EXPLORATION}" ${echidnaMode === EchidnaMode.EXPLORATION ? 'selected' : ''}>Exploration</vscode-option>
                        </vscode-dropdown>
                    </div>
                    <div class="setting-group">
                        <label>Test Limit:</label>
                        <vscode-text-field
                            id="echidna-test-limit"
                            type="number"
                            value="${echidnaTestLimit}"
                            min="1"
                        ></vscode-text-field>
                    </div>
                    <div class="setting-group">
                        <label>Workers:</label>
                        <vscode-text-field
                            id="echidna-workers"
                            type="number"
                            value="${echidnaWorkers}"
                            min="1"
                        ></vscode-text-field>
                    </div>
                </div>

                <div class="settings-container" ${defaultFuzzer !== FuzzerTool.MEDUSA ? 'style="display: none;"' : ''} id="medusa-settings">
                    <div class="setting-group">
                        <label>Test Limit:</label>
                        <vscode-text-field
                            id="medusa-test-limit"
                            type="number"
                            value="${medusaTestLimit}"
                            min="1"
                        ></vscode-text-field>
                    </div>
                    <div class="setting-group">
                        <label>Workers:</label>
                        <vscode-text-field
                            id="medusa-workers"
                            type="number"
                            value="${medusaWorkers}"
                            min="1"
                        ></vscode-text-field>
                    </div>
                </div>
                
                <vscode-button id="fuzz-btn" appearance="primary">
                    <span class="generate-btn-content">
                        <i class="codicon codicon-beaker"></i>
                        Fuzz with ${defaultFuzzer === FuzzerTool.ECHIDNA ? 'Echidna' : 'Medusa'}
                    </span>
                </vscode-button>
            </div>
        `;
    }
}