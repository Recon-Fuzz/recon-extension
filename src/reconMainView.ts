import * as vscode from 'vscode';
import * as fs from 'fs';
import { getFoundryConfigPath } from './utils';
import { EchidnaMode, FuzzerTool } from './types';
import { getOptimalWorkerCount } from './utils/workerConfig';


export class ReconMainViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _configChangeDisposable?: vscode.Disposable;


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


        // Clean up old listener if it exists
        if (this._configChangeDisposable) {
            this._configChangeDisposable.dispose();
        }

        // Listen to config changes and refresh on uncapWorkers or reservedCores change
        this._configChangeDisposable = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('recon.uncapWorkers') || e.affectsConfiguration('recon.reservedCores')) {
                this._updateWebview();
            }
        });

        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.type) {
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
                    const echidnaValue = message.value === '' ? null : parseInt(message.value, 10);
                    await vscode.workspace.getConfiguration('recon').update('echidna.workers', echidnaValue, vscode.ConfigurationTarget.Workspace);
                    await vscode.workspace.getConfiguration('recon').update('echidna.workersOverride', echidnaValue !== null, vscode.ConfigurationTarget.Workspace);
                    break;
                case 'updateMedusaTestLimit':
                    await vscode.workspace.getConfiguration('recon').update('medusa.testLimit', message.value, vscode.ConfigurationTarget.Workspace);
                    break;
                case 'updateMedusaWorkers':
                    const medusaValue = message.value === '' ? null : parseInt(message.value, 10);
                    await vscode.workspace.getConfiguration('recon').update('medusa.workers', medusaValue, vscode.ConfigurationTarget.Workspace);
                    await vscode.workspace.getConfiguration('recon').update('medusa.workersOverride', medusaValue !== null, vscode.ConfigurationTarget.Workspace);
                    break;
                case 'updateHalmosLoop':
                    await vscode.workspace.getConfiguration('recon').update('halmos.loop', message.value, vscode.ConfigurationTarget.Workspace);
                    break;
                case 'openSettings':
                    vscode.commands.executeCommand('workbench.action.openWorkspaceSettings', '@ext:Recon-Fuzz.recon');
                    break;
                case 'updateDefaultFuzzer':
                    await vscode.workspace.getConfiguration('recon').update('defaultFuzzer', message.value, vscode.ConfigurationTarget.Workspace);
                    break;
                case 'runFuzzer':
                    const defaultFuzzer = vscode.workspace.getConfiguration('recon').get<string>('defaultFuzzer', FuzzerTool.ECHIDNA);
                    if (defaultFuzzer === FuzzerTool.ECHIDNA) {
                        vscode.commands.executeCommand('recon.runEchidna', message.value);
                    } else if (defaultFuzzer === FuzzerTool.MEDUSA) {
                        vscode.commands.executeCommand('recon.runMedusa', message.value);
                    } else if (defaultFuzzer === FuzzerTool.HALMOS) {
                        vscode.commands.executeCommand('recon.runHalmos', message.value);
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
                        flex-direction: column;
                        gap: 4px;
                    }
                    .setting-group label {
                        font-size: 12px;
                    }
                    .auto-workers-label {
                        font-size: 11px;
                        color: var(--vscode-descriptionForeground);
                        font-style: italic;
                        margin-left: 2px;
                        min-height: 16px;
                    }
                    vscode-dropdown, vscode-text-field {
                        flex: 1;
                    }
                    .header {
                        display: flex;
                        gap: 8px;
                        margin-bottom: 16px;
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
                        flex: 1;
                    }
                </style>
            </head>
            <body>
                ${mainContent}
                <script>
                    const vscode = acquireVsCodeApi();
                    
                    function updateAutoLabel(inputId, labelId) {
                        const input = document.getElementById(inputId);
                        const label = document.getElementById(labelId);
                        if (!input || !label) return;
                        
                        if (input.value === '' || input.value === null || input.value === undefined) {
                            label.style.visibility = 'visible';
                        } else {
                            label.style.visibility = 'hidden';
                        }
                    }


                    document.addEventListener('click', (e) => {
                        const button = e.target.closest('vscode-button');
                        if (!button) return;
                        const target = document.getElementById('target-contract')?.value || 'CryticTester';
                        
                        if (button.id === 'settings-btn') {
                            vscode.postMessage({ type: 'openSettings' });
                        } else if (button.id === 'fuzz-btn') {
                            vscode.postMessage({
                                type: 'runFuzzer',
                                value: target
                            });
                        } else if (button.hasAttribute('data-select-config')) {
                            vscode.postMessage({ type: 'selectFoundryConfig' });
                        }
                    });


                    document.getElementById('echidna-mode')?.addEventListener('change', (e) => {
                        vscode.postMessage({
                            type: 'updateEchidnaMode',
                            value: e.target.value
                        });
                    });


                    document.getElementById('echidna-test-limit')?.addEventListener('change', (e) => {
                        const value = parseInt(e.target.value, 10);
                        if (!isNaN(value) && value >= 1) {
                            vscode.postMessage({
                                type: 'updateEchidnaTestLimit',
                                value: value
                            });
                        }
                    });


                    document.getElementById('echidna-workers')?.addEventListener('input', (e) => {
                        const value = e.target.value;
                        updateAutoLabel('echidna-workers', 'echidna-auto-label');
                        vscode.postMessage({
                            type: 'updateEchidnaWorkers',
                            value: value
                        });
                    });
                    
                    document.getElementById('medusa-test-limit')?.addEventListener('change', (e) => {
                        const value = parseInt(e.target.value, 10);
                        if (!isNaN(value) && value >= 1) {
                            vscode.postMessage({
                                type: 'updateMedusaTestLimit',
                                value: value
                            });
                        }
                    });


                    document.getElementById('medusa-workers')?.addEventListener('input', (e) => {
                        const value = e.target.value;
                        updateAutoLabel('medusa-workers', 'medusa-auto-label');
                        vscode.postMessage({
                            type: 'updateMedusaWorkers',
                            value: value
                        });
                    });


                    document.getElementById('halmos-loop')?.addEventListener('change', (e) => {
                        const value = parseInt(e.target.value, 10);
                        if (!isNaN(value) && value >= 0) {
                            vscode.postMessage({
                                type: 'updateHalmosLoop',
                                value: value
                            });
                        }
                    });


                    const radioGroup = document.getElementById('fuzzer-selection');
                    if (radioGroup) {
                        radioGroup.addEventListener('change', (e) => {
                            const selectedValue = e.target.value;
                            
                            const echidnaSettings = document.getElementById('echidna-settings');
                            const medusaSettings = document.getElementById('medusa-settings');
                            const halmosSettings = document.getElementById('halmos-settings');
                            
                            const fuzzBtn = document.getElementById('fuzz-btn');
                            const btnContent = fuzzBtn?.querySelector('.generate-btn-content');
                            
                            if (selectedValue === '${FuzzerTool.ECHIDNA}') {
                                echidnaSettings.style.display = '';
                                medusaSettings.style.display = 'none';
                                halmosSettings.style.display = 'none';
                                setTimeout(() => updateAutoLabel('echidna-workers', 'echidna-auto-label'), 0);
                                if (btnContent) {
                                    btnContent.innerHTML = '<i class="codicon codicon-beaker"></i>Fuzz with Echidna';
                                }
                            } else if (selectedValue === '${FuzzerTool.MEDUSA}') {
                                echidnaSettings.style.display = 'none';
                                medusaSettings.style.display = '';
                                halmosSettings.style.display = 'none';
                                setTimeout(() => updateAutoLabel('medusa-workers', 'medusa-auto-label'), 0);
                                if (btnContent) {
                                    btnContent.innerHTML = '<i class="codicon codicon-beaker"></i>Fuzz with Medusa';
                                }
                            } else if (selectedValue === '${FuzzerTool.HALMOS}') {
                                echidnaSettings.style.display = 'none';
                                medusaSettings.style.display = 'none';
                                halmosSettings.style.display = '';
                                if (btnContent) {
                                    btnContent.innerHTML = '<i class="codicon codicon-beaker"></i>Verify with Halmos';
                                }
                            }
                            
                            vscode.postMessage({
                                type: 'updateDefaultFuzzer',
                                value: selectedValue
                            });
                        });
                    }


                    setTimeout(() => {
                        updateAutoLabel('echidna-workers', 'echidna-auto-label');
                        updateAutoLabel('medusa-workers', 'medusa-auto-label');
                    }, 0);
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
        const echidnaWorkers = config.get<number | null>('echidna.workers', null);
        const echidnaOverride = config.get<boolean>('echidna.workersOverride', false);
        const medusaTestLimit = config.get('medusa.testLimit', 1000000);
        const medusaWorkers = config.get<number | null>('medusa.workers', null);
        const medusaOverride = config.get<boolean>('medusa.workersOverride', false);
        const halmosLoop = config.get('halmos.loop', 10);


        const echidnaAutoWorkers = getOptimalWorkerCount('echidna');
        const medusaAutoWorkers = getOptimalWorkerCount('medusa');


        const showEchidnaAuto = !echidnaOverride;
        const showMedusaAuto = !medusaOverride;


        const echidnaDisplayValue = echidnaOverride && echidnaWorkers !== null ? echidnaWorkers.toString() : '';
        const medusaDisplayValue = medusaOverride && medusaWorkers !== null ? medusaWorkers.toString() : '';


        return `
            <div class="button-container">
                <div class="header">
                    <vscode-button id="fuzz-btn" appearance="primary">
                        <span class="generate-btn-content">
                            <i class="codicon codicon-beaker"></i>
                            ${defaultFuzzer === FuzzerTool.HALMOS ? "Verify" : "Fuzz"} with ${defaultFuzzer === FuzzerTool.ECHIDNA ? 'Echidna' : defaultFuzzer === FuzzerTool.MEDUSA ? 'Medusa' : 'Halmos'}
                        </span>
                    </vscode-button>
                    <vscode-button id="settings-btn" appearance="secondary">
                        <span class="generate-btn-content">
                            <i class="codicon codicon-gear"></i>
                        </span>
                    </vscode-button>
                </div>
                
                <div class="fuzzer-selection">
                    <vscode-radio-group id="fuzzer-selection" value="${defaultFuzzer}">
                        <vscode-radio value="${FuzzerTool.ECHIDNA}">Echidna</vscode-radio>
                        <vscode-radio value="${FuzzerTool.MEDUSA}">Medusa</vscode-radio>
                        <vscode-radio value="${FuzzerTool.HALMOS}">Halmos</vscode-radio>
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
                            value="${echidnaDisplayValue}"
                            min="1"
                            placeholder="Auto"
                        ></vscode-text-field>
                        <span id="echidna-auto-label" class="auto-workers-label" style="visibility: ${showEchidnaAuto ? 'visible' : 'hidden'}">
                            Auto selected: ${echidnaAutoWorkers}
                        </span>
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
                            value="${medusaDisplayValue}"
                            min="1"
                            placeholder="Auto"
                        ></vscode-text-field>
                        <span id="medusa-auto-label" class="auto-workers-label" style="visibility: ${showMedusaAuto ? 'visible' : 'hidden'}">
                            Auto selected: ${medusaAutoWorkers}
                        </span>
                    </div>
                </div>
                
                <div class="settings-container" ${defaultFuzzer !== FuzzerTool.HALMOS ? 'style="display: none;"' : ''} id="halmos-settings">
                    <div class="setting-group">
                        <label>Target:</label>
                        <vscode-text-field
                            id="target-contract"
                            value="CryticTester"
                        ></vscode-text-field>
                    </div>
                    <div class="setting-group">
                        <label>Loop:</label>
                        <vscode-text-field
                            id="halmos-loop"
                            type="number"
                            value="${halmosLoop}"
                            min="0"
                        ></vscode-text-field>
                    </div>
                </div>


            </div>
        `;
    }
}
