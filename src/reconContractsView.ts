import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ContractMetadata, FunctionConfig, Abi, Actor, Mode } from './types';

export class ReconContractsViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private contracts: ContractMetadata[] = [];
    private showAllFiles: boolean = false;
    private _disposables: vscode.Disposable[] = [];
    private collapsedContracts = new Set<string>();
    private saveStateTimeout: NodeJS.Timeout | null = null;
    private isStateSaving = false;
    private searchQuery: string = '';

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {
        this.showAllFiles = vscode.workspace.getConfiguration('recon').get('showAllFiles', false);
        this.loadState();

        this._disposables.push(
            vscode.commands.registerCommand('recon.showAllFiles', () => {
                this.setShowAllFiles(true);
            }),
            vscode.commands.registerCommand('recon.hideAllFiles', () => {
                this.setShowAllFiles(false);
            })
        );

        vscode.commands.executeCommand('setContext', 'recon.showingAllFiles', this.showAllFiles);

        this.contracts.forEach(c => this.collapsedContracts.add(c.jsonPath));
        this.startWatchingReconJson();
    }

    private async setShowAllFiles(value: boolean) {
        this.showAllFiles = value;
        await vscode.workspace.getConfiguration('recon').update('showAllFiles', this.showAllFiles, vscode.ConfigurationTarget.Workspace);
        await vscode.commands.executeCommand('setContext', 'recon.showingAllFiles', this.showAllFiles);
        this._updateWebview();
    }

    dispose() {
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }

    private getFunctionSignature(fn: Abi): string {
        const inputs = fn.inputs.map(input => input.type).join(',');
        return `${fn.name}(${inputs})`;
    }

    private async getReconJsonPath(): Promise<string> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!workspaceRoot) { throw new Error('No workspace folder found'); }
        return path.join(workspaceRoot, 'recon.json');
    }

    public async loadReconJson(): Promise<Record<string, { functions: FunctionConfig[], separated?: boolean, enabled?: boolean }>> {
        try {
            const jsonPath = await this.getReconJsonPath();
            const content = await fs.readFile(jsonPath, 'utf8');
            try {
                return JSON.parse(content);
            } catch (e) {
                console.error('Failed to parse recon.json:', e);
                return {};
            }
        } catch {
            return {};
        }
    }

    public async saveReconJson(data: Record<string, { functions: FunctionConfig[], separated?: boolean, enabled?: boolean }>) {
        if (this.isStateSaving) { return; }

        try {
            this.isStateSaving = true;
            const jsonPath = await this.getReconJsonPath();
            const content = JSON.stringify(data, null, 2);

            // First read existing content
            let existingContent = '';
            try {
                existingContent = await fs.readFile(jsonPath, 'utf8');
            } catch { } // Ignore if file doesn't exist

            // Only write if content has changed
            if (existingContent !== content) {
                await fs.writeFile(jsonPath, content);
            }
        } catch (e) {
            console.error('Failed to save recon.json:', e);
        } finally {
            this.isStateSaving = false;
        }
    }

    public async loadState() {
        try {
            const reconJson = await this.loadReconJson();

            this.contracts = this.contracts.map(contract => {
                const savedConfig = reconJson[contract.jsonPath];

                // A contract is enabled if it has any functions configured
                const isEnabled = savedConfig?.enabled ?? false;

                // Initialize empty arrays if needed
                const functionConfigs = savedConfig?.functions || [];
                const enabledFunctions = functionConfigs.map(f => f.signature);
                const separated = savedConfig?.separated ?? true; // Default to true

                return {
                    ...contract,
                    enabled: isEnabled,
                    functionConfigs,
                    enabledFunctions,
                    separated
                };
            });
        } catch (e) {
            console.error('Failed to load state:', e);
        }
    }

    public async saveState() {
        try {
            const reconJson = Object.fromEntries(
                this.contracts
                    .filter(c => c.enabled)
                    .map(c => [
                        c.jsonPath,
                        {
                            enabled: true,
                            functions: c.functionConfigs || [],
                            separated: c.separated
                        }
                    ])
            );

            await this.saveReconJson(reconJson);
        } catch (e) {
            console.error('Failed to save state:', e);
        }
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

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                vscode.commands.executeCommand('recon.refreshContracts');
            }
        });

        webviewView.webview.onDidReceiveMessage(async message => {
            try {
                switch (message.type) {
                    case 'build':
                        vscode.commands.executeCommand('recon.buildProject');
                        break;
                    case 'generate':
                        vscode.commands.executeCommand('recon.installChimera');
                        break;
                    case 'toggleShowAll':
                        this.showAllFiles = message.value;
                        this._updateWebview();
                        break;
                    case 'updateSearch':
                        this.searchQuery = message.query;
                        // Don't update the entire webview, let the client-side filter handle it
                        break;
                    case 'toggleContract':
                        const contract = this.contracts.find(c => c.jsonPath === message.pathName);
                        if (contract) {
                            this.toggleContract(contract, message.enabled);
                        }
                        break;
                    case 'toggleFunction':
                        const contract2 = this.contracts.find(c => c.jsonPath === message.pathName);
                        if (contract2) {
                            if (!contract2.enabledFunctions) {
                                contract2.enabledFunctions = [];
                            }
                            if (!contract2.functionConfigs) {
                                contract2.functionConfigs = [];
                            }

                            if (message.enabled) {
                                // Add to both enabled list and configs
                                if (!contract2.enabledFunctions.includes(message.functionName)) {
                                    contract2.enabledFunctions.push(message.functionName);
                                    // Add new config if it doesn't exist
                                    if (!contract2.functionConfigs.some(f => f.signature === message.functionName)) {
                                        contract2.functionConfigs.push({
                                            signature: message.functionName,
                                            actor: Actor.ACTOR,
                                            mode: Mode.NORMAL
                                        });
                                    }
                                }
                            } else {
                                // Remove from both enabled list and configs
                                contract2.enabledFunctions = contract2.enabledFunctions.filter(
                                    fn => fn !== message.functionName
                                );
                                contract2.functionConfigs = contract2.functionConfigs.filter(
                                    f => f.signature !== message.functionName
                                );
                            }
                            this.saveState();

                            // Return updated contract data without rerendering everything
                            if (message.clientUpdate) {
                                // We let client handle the UI update
                                return;
                            }
                        }
                        break;
                    case 'toggleCollapse':
                        if (this.collapsedContracts.has(message.pathName)) {
                            this.collapsedContracts.delete(message.pathName);
                        } else {
                            this.collapsedContracts.add(message.pathName);
                        }

                        // Only update the collapsed state without full rerender
                        if (this._view) {
                            this._view.webview.postMessage({
                                type: 'updatedCollapsedState',
                                pathName: message.pathName,
                                collapsed: this.collapsedContracts.has(message.pathName)
                            });
                            return;
                        }
                        break;
                    case 'updateFunctionMode':
                    case 'updateFunctionActor':
                        const contract3 = this.contracts.find(c => c.jsonPath === message.pathName);
                        if (contract3) {
                            if (!contract3.functionConfigs) {
                                contract3.functionConfigs = [];
                            }
                            const existingConfig = contract3.functionConfigs.find(f => f.signature === message.functionName);
                            if (existingConfig) {
                                if (message.type === 'updateFunctionMode') {
                                    existingConfig.mode = message.mode;
                                } else {
                                    existingConfig.actor = message.actor;
                                }
                            } else {
                                contract3.functionConfigs.push({
                                    signature: message.functionName,
                                    actor: message.type === 'updateFunctionActor' ? message.actor : Actor.ACTOR,
                                    mode: message.type === 'updateFunctionMode' ? message.mode : Mode.NORMAL
                                });
                            }
                            // Only save state, don't update webview
                            this.saveState();

                            // Only notify the client that the update was successful
                            if (message.clientUpdate && this._view) {
                                this._view.webview.postMessage({
                                    type: 'updateSuccess',
                                    pathName: message.pathName,
                                    functionName: message.functionName,
                                    property: message.type === 'updateFunctionMode' ? 'mode' : 'actor',
                                    value: message.type === 'updateFunctionMode' ? message.mode : message.actor
                                });
                                return;
                            }
                        }
                        break;
                    case 'openFile':
                        if (vscode.workspace.workspaceFolders) {
                            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
                            const filePath = vscode.Uri.file(path.join(workspaceRoot, message.path));
                            vscode.workspace.openTextDocument(filePath).then(doc => {
                                vscode.window.showTextDocument(doc);
                            });
                        }
                        break;
                    case 'toggleContractSeparated':
                        const contract4 = this.contracts.find(c => c.jsonPath === message.pathName);
                        if (contract4) {
                            contract4.separated = message.separated;
                            await this.saveState();

                            // Only notify the client that the update was successful
                            if (message.clientUpdate && this._view) {
                                this._view.webview.postMessage({
                                    type: 'updateSuccess',
                                    pathName: message.pathName,
                                    property: 'separated',
                                    value: message.separated
                                });
                                return;
                            }
                        }
                        break;
                    case 'getContractState':
                        // Send the current state of a specific contract to the client
                        if (this._view) {
                            const contract = this.contracts.find(c => c.jsonPath === message.pathName);
                            if (contract) {
                                this._view.webview.postMessage({
                                    type: 'contractState',
                                    contract: {
                                        name: contract.name,
                                        jsonPath: contract.jsonPath,
                                        enabled: contract.enabled,
                                        path: contract.path,
                                        separated: contract.separated,
                                        enabledFunctions: contract.enabledFunctions || [],
                                        functionConfigs: contract.functionConfigs || []
                                    }
                                });
                            }
                        }
                        break;
                    case 'batchUpdateFunctions':
                        const contract5 = this.contracts.find(c => c.jsonPath === message.pathName);
                        if (contract5) {
                            // Update multiple functions at once
                            if (message.enabledFunctions) {
                                contract5.enabledFunctions = [...message.enabledFunctions];
                            }
                            if (message.functionConfigs) {
                                contract5.functionConfigs = [...message.functionConfigs];
                            }
                            await this.saveState();

                            if (message.clientUpdate && this._view) {
                                this._view.webview.postMessage({
                                    type: 'batchUpdateSuccess',
                                    pathName: message.pathName
                                });
                                return;
                            }
                        }
                        break;
                }
            } catch (e) {
                console.error('Error handling webview message:', e);
            }
        });

        this._updateWebview();
    }

    private async toggleContract(contract: ContractMetadata, enabled: boolean) {
        contract.enabled = enabled;
        if (enabled && (!contract.functionConfigs || !contract.functionConfigs.length)) {
            const mutableFunctions = this.getMutableFunctions(contract.abi);
            contract.functionConfigs = mutableFunctions.map(fn => ({
                signature: this.getFunctionSignature(fn),
                actor: Actor.ACTOR,
                mode: Mode.NORMAL
            }));
            contract.enabledFunctions = contract.functionConfigs.map(f => f.signature);
        } else if (!enabled) {
            contract.enabledFunctions = [];
        }
        await this.saveState();

        // Send targeted update to webview instead of full refresh
        if (this._view) {
            this._view.webview.postMessage({
                type: 'contractToggled',
                pathName: contract.jsonPath,
                enabled: contract.enabled,
                enabledFunctions: contract.enabledFunctions,
                functionConfigs: contract.functionConfigs
            });
            return;
        }

        // Fall back to full refresh if targeted update fails
        this._updateWebview();
    }

    private _updateWebview() {
        if (!this._view) { return; }
        this._view.webview.html = this._getHtmlForWebview();
    }

    private _getHtmlForWebview(): string {
        const codiconsUri = this._view?.webview.asWebviewUri(this.getCodiconsUri());
        const toolkitUri = this._view?.webview.asWebviewUri(this.getToolkitUri());

        return `<!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width,initial-scale=1.0">
                <link href="${codiconsUri}" rel="stylesheet" />
                <script type="module" src="${toolkitUri}"></script>
                <style>
                    body {
                        padding: 0;
                        color: var(--vscode-foreground);
                        font-family: var(--vscode-font-family);
                        font-size: var(--vscode-font-size);
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

                    .search-container {
                        position: sticky;
                        top: 0;
                        background: var(--vscode-sideBar-background);
                        border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
                        padding: 8px;
                        z-index: 10;
                        display: flex;
                        align-items: center;
                    }
                    .search-container vscode-text-field {
                        width: 100%;
                    }
                    .search-container vscode-text-field::part(control) {
                        width: 100%;
                    }
                    .search-icon {
                        position: absolute;
                        right: 10px;
                        opacity: 0.6;
                    }
                    #contracts-list {
                       
                    }
                    .contract-item {
                        margin: 2px 0;
                        padding: 0 8px;
                    }
                    .contract-header {
                        display: flex;
                        flex-direction: column;
                        width: 100%;
                    }
                    .contract-title {
                        display: flex;
                        align-items: center;
                        gap: 4px;
                        font-family: var(--vscode-editor-font-family);
                    }
                    .toggle-button {
                        background: none;
                        border: none;
                        padding: 2px;
                        cursor: pointer;
                        color: var(--vscode-foreground);
                        opacity: 0.8;
                    }
                    .toggle-button:hover {
                        opacity: 1;
                    }
                    .functions-list.collapsed {
                        display: none;
                    }
                    .functions-list {
                        margin-left: 8px;
                    }
                    .function-item {
                        display: flex;
                        flex-direction: column;
                        font-size: var(--vscode-font-size);
                        opacity: 0.9;
                        padding: 2px 0;
                        position: relative;
                        border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
                        padding: 8px 0;
                    }
                    .function-item:last-child {
                        border-bottom: none;
                    }
                    .function-header {
                        display: flex;
                        align-items: center;
                        width: 100%;
                    }
                    .function-content {
                        margin-top: 2px;
                        font-size: 10px;
                        display: flex;
                        align-items: center;
                    }
                    .function-mode-label {
                        opacity: 0.7;
                    }
                    .contract-checkbox {
                        font-size: 12px;
                    }
                    .function-name {
                        white-space: nowrap;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        min-width: 0;
                        font-size: 12px;
                    }
                    .mode-group {
                        display: flex;
                        gap: 8px;
                        align-items: center;
                    }
                    .mode-option {
                        display: flex;
                        align-items: center;
                        gap: 4px;
                        font-size: 11px;
                        opacity: 0.9;
                    }
                    vscode-radio {
                        font-size: 11px;
                        height: 18px;
                    }
                    vscode-dropdown {
                        z-index: 100;
                    }
                    /* Make dropdown options appear above other content */
                    .webview-body {
                        position: relative;
                        z-index: 1;
                    }
                    .contracts-container {
                        position: relative;
                        z-index: 1;
                    }
                    .contract-path {
                        opacity: 0.7;
                        font-size: 10px;
                        margin-top: 2px;
                        font-family: var (--vscode-editor-font-family);
                        cursor: pointer;
                        white-space: nowrap;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        max-width: 100%;
                        display: block;
                    }
                    .contract-path:hover {
                        opacity: 1;
                        text-decoration: underline;
                    }
                    .no-contracts {
                        color: var(--vscode-descriptionForeground);
                        font-style: italic;
                        padding: 8px;
                    }
                    .contract-divider {
                        height: 1px;
                        background-color: var(--vscode-sideBarSectionHeader-border);
                        margin: 8px 0;
                    }
                    vscode-checkbox {
                        --checkbox-background: var(--vscode-checkbox-background);
                        --checkbox-foreground: var(--vscode-checkbox-foreground);
                        --checkbox-border: var(--vscode-checkbox-border);
                    }
                    .functions-header {
                        border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
                        padding: 4px 0;
                        margin-bottom: 8px;
                    }
                    .functions-header .select-all {
                        font-size: 11px;
                        text-transform: uppercase;
                        font-weight: 600;
                        opacity: 0.8;
                        letter-spacing: 0.04em;
                    }
                    .function-settings {
                        display: flex;
                        flex-direction: column;
                        width: 100%;
                        position: static;
                    }
                    vscode-radio-group {
                        display: flex;
                        gap: 4px;
                        margin: 2px 0;
                        position: static;
                    }
                    .contract-separated-checkbox {
                        margin-left: 8px;
                        opacity: 0.8;
                    }
                    .no-results {
                        padding: 16px;
                        text-align: center;
                        color: var(--vscode-descriptionForeground);
                        font-style: italic;
                    }
                    .highlight {
                        color: var(--vscode-textLink-foreground);
                        font-weight: bold;
                    }
                    .hidden {
                        display: none !important;
                    }
                    .batch-actions {
                        padding: 4px;
                        margin-top: 8px;
                        display: flex;
                        gap: 4px;
                    }
                    .batch-actions vscode-button {
                        flex: 1;
                    }
                    /* Add scaffold button styles */
                    .scaffold-button-container {
                        position: sticky;
                        bottom: 0;
                        background: var(--vscode-sideBar-background);
                        border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
                        padding: 8px;
                        z-index: 10;
                        display: flex;
                        gap: 8px;
                    }
                    .scaffold-button-container vscode-button {
                        flex: 1;
                    }
                    .scaffold-button-container vscode-button::part(control) {
                        width: 100%;
                    }
                    .generate-btn-content {
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        gap: 8px;
                        width: 100%;
                    }
                    /* Add virtual list support */
                    .virtual-list-container {
                        will-change: transform;
                    }
                    .collapsible-section {
                        overflow: hidden;
                        transition: max-height 0.2s ease-out;
                    }
                    /* Optimize performance for function settings */
                    .optimized-radio {
                        display: inline-block;
                        margin-right: 8px;
                    }
                    .radio-label {
                        cursor: pointer;
                        padding: 3px 6px;
                        border-radius: 3px;
                        border: 1px solid var(--vscode-button-border);
                        font-size: 10px;
                        user-select: none;
                    }
                    .radio-label.selected {
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                    }
                    /* Loading indication */
                    .saving-indicator {
                        position: absolute;
                        bottom: 4px;
                        right: 4px;
                        font-size: 10px;
                        color: var(--vscode-descriptionForeground);
                        background: var(--vscode-editor-background);
                        padding: 2px 4px;
                        border-radius: 3px;
                        opacity: 0;
                        transition: opacity 0.2s;
                    }
                    .saving-indicator.visible {
                        opacity: 1;
                    }
                    .select-all-container {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        margin-bottom: 4px;
                    }
                    /* Optimize radio buttons for better interaction */
                    .optimized-radio-group {
                        display: flex;
                        gap: 2px;
                        margin: 4px 0;
                        margin-bottom: 8px;
                    }
                    .section-header {
                        padding: 8px;
                        font-weight: 600;
                        font-size: 11px;
                        text-transform: uppercase;
                        letter-spacing: 0.1em;
                        color: var(--vscode-foreground);
                        opacity: 0.8;
                        background: rgba(255, 255, 255, 0.1);
                        border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
                    }
                    .section-divider {
                        height: 2px;
                        background-color: var(--vscode-sideBarSectionHeader-border);
                    }
                    .enabled-contracts {
                        background: var(--vscode-sideBarSectionHeader-background);
                        margin-bottom: 8px;
                    }
                </style>
            </head>
            <body class="webview-body">
                <div class="search-container">
                    <vscode-text-field
                        id="search-input"
                        placeholder="Search contracts"
                        value="${this.searchQuery}"
                        oninput="filterContracts(this.value)"
                        iconEnd="vscode-icons:file-search"
                    >
                    </vscode-text-field>
                    <i class="codicon codicon-search search-icon"></i>
                </div>
                <div id="contracts-list" class="contracts-container">
                    ${this.getContractsHtml()}
                </div>
                <div id="no-results" class="no-results hidden">
                    No contracts found matching "<span id="search-term"></span>"
                </div>
                <div id="saving-indicator" class="saving-indicator">Saving...</div>
                ${this.contracts.length > 0 ? `
                    <div class="scaffold-button-container">
                        <vscode-button id="generate-btn" appearance="primary">
                            <span class="generate-btn-content">
                                <i class="codicon codicon-wand"></i>
                                Scaffold
                            </span>
                        </vscode-button>
                    </div>
                ` : ''}
                <script>
                    const vscode = acquireVsCodeApi();
                    
                    // Store any state that will be needed between reloads
                    const state = vscode.getState() || { 
                        searchQuery: "${this.searchQuery}",
                        activeElement: null,
                        contractStates: {},
                        pendingUpdates: {},
                        isSaving: false
                    };
                    
                    // Set up observer to restore focus
                    const observer = new MutationObserver((mutationsList, observer) => {
                        const searchInput = document.getElementById('search-input');
                        if (document.activeElement !== searchInput && state.activeElement === 'search-input') {
                            searchInput.focus();
                            // Position cursor at the end of text
                            if (searchInput.value) {
                                setTimeout(() => {
                                    searchInput.setSelectionRange(
                                        searchInput.value.length,
                                        searchInput.value.length
                                    );
                                }, 0);
                            }
                        }
                    });
                    
                    observer.observe(document.body, { childList: true, subtree: true });

                    // Handle focus tracking
                    document.getElementById('search-input').addEventListener('focus', () => {
                        state.activeElement = 'search-input';
                        vscode.setState(state);
                    });

                    document.getElementById('search-input').addEventListener('blur', () => {
                        state.activeElement = null;
                        vscode.setState(state);
                    });
                    
                    // Listen for messages from the extension
                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.type) {
                            case 'updatedCollapsedState':
                                updateCollapsedState(message.pathName, message.collapsed);
                                break;
                            case 'contractToggled':
                                updateContractState(message.pathName, message.enabled, message.enabledFunctions, message.functionConfigs);
                                break;
                            case 'updateSuccess':
                                handleUpdateSuccess(message);
                                break;
                            case 'contractState':
                                updateContractStateFromServer(message.contract);
                                break;
                            case 'batchUpdateSuccess':
                                hideSavingIndicator();
                                break;
                        }
                    });

                    // Handle successful update response
                    function handleUpdateSuccess(message) {
                        // Update client-side state
                        if (!state.contractStates[message.pathName]) {
                            state.contractStates[message.pathName] = {};
                        }
                        
                        if (message.functionName) {
                            // Update function-specific property
                            const functionConfig = state.contractStates[message.pathName].functionConfigs?.find(
                                f => f.signature === message.functionName
                            );
                            if (functionConfig) {
                                functionConfig[message.property] = message.value;
                            }
                        } else {
                            // Update contract-level property
                            state.contractStates[message.pathName][message.property] = message.value;
                        }
                        
                        vscode.setState(state);
                        hideSavingIndicator();
                    }

                    // Show saving indicator for async operations
                    function showSavingIndicator() {
                        const indicator = document.getElementById('saving-indicator');
                        indicator.classList.add('visible');
                        state.isSaving = true;
                        vscode.setState(state);
                    }

                    // Hide saving indicator when complete
                    function hideSavingIndicator() {
                        const indicator = document.getElementById('saving-indicator');
                        indicator.classList.remove('visible');
                        state.isSaving = false;
                        vscode.setState(state);
                    }

                    // Cache contract states for client-side rendering
                    function updateContractStateFromServer(contract) {
                        state.contractStates[contract.jsonPath] = contract;
                        vscode.setState(state);
                    }

                    // Update contract state in UI without full rerender
                    function updateContractState(pathName, enabled, enabledFunctions, functionConfigs) {
                        const contractDiv = document.querySelector(\`[data-path-name="\${pathName}"]\`);
                        if (!contractDiv) return;
                        
                        // Update checkbox state
                        const checkbox = contractDiv.querySelector(\`#contract-\${pathName}\`);
                        if (checkbox) checkbox.checked = enabled;
                        
                        // Update functions list visibility
                        const functionsList = contractDiv.querySelector('.functions-list');
                        if (enabled) {
                            if (functionsList) {
                                // Render functions if contract is now enabled
                                renderFunctions(pathName, enabledFunctions, functionConfigs);
                                
                                // Show separated checkbox if needed
                                const separatedCheckboxContainer = contractDiv.querySelector('.contract-separated-checkbox');
                                if (!separatedCheckboxContainer) {
                                    const titleDiv = contractDiv.querySelector('.contract-title');
                                    const separatedCheckbox = document.createElement('vscode-checkbox');
                                    separatedCheckbox.className = 'contract-separated-checkbox';
                                    separatedCheckbox.id = \`contract-separated-\${pathName}\`;
                                    separatedCheckbox.checked = true; // Default to true
                                    separatedCheckbox.innerHTML = 'Separated';
                                    separatedCheckbox.setAttribute('onchange', \`toggleContractSeparated('\${pathName}', this.checked, true)\`);
                                    titleDiv.appendChild(separatedCheckbox);
                                }
                            }
                        } else {
                            // Clear functions if contract is disabled
                            if (functionsList) {
                                functionsList.innerHTML = '';
                            }
                            // Remove separated checkbox
                            const separatedCheckbox = contractDiv.querySelector(\`#contract-separated-\${pathName}\`);
                            if (separatedCheckbox) {
                                const parent = separatedCheckbox.parentElement;
                                parent.removeChild(parent.querySelector('.contract-separated-checkbox'));
                            }
                        }
                        
                        // Update local state
                        if (!state.contractStates[pathName]) {
                            state.contractStates[pathName] = {};
                        }
                        state.contractStates[pathName].enabled = enabled;
                        state.contractStates[pathName].enabledFunctions = enabledFunctions;
                        state.contractStates[pathName].functionConfigs = functionConfigs;
                        vscode.setState(state);
                    }
                    
                    // Render or re-render functions for a contract
                    function renderFunctions(pathName, enabledFunctions, functionConfigs) {
                        const functionsList = document.querySelector(\`[data-path-name="\${pathName}"] .functions-list\`);
                        if (!functionsList) return;
                        
                        // Get all function checkboxes and their data
                        const functionItems = functionsList.querySelectorAll('.function-item');
                        const functions = Array.from(functionItems).map(item => {
                            const checkbox = item.querySelector('.function-checkbox');
                            return {
                                signature: checkbox.dataset.function,
                                element: item
                            };
                        });
                        
                        // Update each function's enabled state and settings
                        functions.forEach(fn => {
                            const isEnabled = enabledFunctions && enabledFunctions.includes(fn.signature);
                            const checkbox = fn.element.querySelector('.function-checkbox');
                            if (checkbox) checkbox.checked = isEnabled;
                            
                            const config = functionConfigs && functionConfigs.find(c => c.signature === fn.signature);
                            if (isEnabled && config) {
                                // Update or create settings if enabled
                                let contentDiv = fn.element.querySelector('.function-content');
                                if (!contentDiv) {
                                    contentDiv = document.createElement('div');
                                    contentDiv.className = 'function-content';
                                    contentDiv.innerHTML = \`
                                        <div class="function-settings">
                                            <div class="optimized-radio-group" data-type="mode">
                                                <span class="optimized-radio">
                                                    <label class="radio-label \${config.mode === 'normal' ? 'selected' : ''}" 
                                                           data-value="normal" 
                                                           onclick="updateFunctionSetting('\${contractName}', '\${fn.signature}', 'mode', 'normal', this)">
                                                        Normal
                                                    </label>
                                                </span>
                                                <span class="optimized-radio">
                                                    <label class="radio-label \${config.mode === 'fail' ? 'selected' : ''}" 
                                                           data-value="fail" 
                                                           onclick="updateFunctionSetting('\${contractName}', '\${fn.signature}', 'mode', 'fail', this)">
                                                        Fail
                                                    </label>
                                                </span>
                                                <span class="optimized-radio">
                                                    <label class="radio-label \${config.mode === 'catch' ? 'selected' : ''}" 
                                                           data-value="catch" 
                                                           onclick="updateFunctionSetting('\${contractName}', '\${fn.signature}', 'mode', 'catch', this)">
                                                        Catch
                                                    </label>
                                                </span>
                                            </div>
                                            <div class="optimized-radio-group" data-type="actor">
                                                <span class="optimized-radio">
                                                    <label class="radio-label \${config.actor === 'actor' ? 'selected' : ''}" 
                                                           data-value="actor" 
                                                           onclick="updateFunctionSetting('\${contractName}', '\${fn.signature}', 'actor', 'actor', this)">
                                                        Actor
                                                    </label>
                                                </span>
                                                <span class="optimized-radio">
                                                    <label class="radio-label \${config.actor === 'admin' ? 'selected' : ''}" 
                                                           data-value="admin" 
                                                           onclick="updateFunctionSetting('\${contractName}', '\${fn.signature}', 'actor', 'admin', this)">
                                                        Admin
                                                    </label>
                                                </span>
                                            </div>
                                        </div>
                                    \`;
                                    fn.element.appendChild(contentDiv);
                                } else {
                                    // Update existing settings
                                    updateRadioLabels(contentDiv.querySelector('[data-type="mode"]'), config.mode);
                                    updateRadioLabels(contentDiv.querySelector('[data-type="actor"]'), config.actor);
                                }
                            } else {
                                // Remove settings if disabled
                                const contentDiv = fn.element.querySelector('.function-content');
                                if (contentDiv) {
                                    fn.element.removeChild(contentDiv);
                                }
                            }
                        });
                    }
                    
                    // Update selected radio label in a group
                    function updateRadioLabels(container, selectedValue) {
                        if (!container) return;
                        const labels = container.querySelectorAll('.radio-label');
                        labels.forEach(label => {
                            if (label.dataset.value === selectedValue) {
                                label.classList.add('selected');
                            } else {
                                label.classList.remove('selected');
                            }
                        });
                    }
                    
                    // Update function setting with optimized radio buttons
                    function updateFunctionSetting(pathName, functionName, settingType, value, element) {
                        // Show saving indicator
                        showSavingIndicator();
                        
                        // Update UI immediately
                        const container = element.closest('.optimized-radio-group');
                        updateRadioLabels(container, value);
                        
                        // Then send to extension with client update flag
                        vscode.postMessage({
                            type: settingType === 'mode' ? 'updateFunctionMode' : 'updateFunctionActor',
                            pathName,
                            functionName,
                            [settingType]: value,
                            clientUpdate: true
                        });
                    }
                    
                    // Function to update collapsed state without refresh
                    function updateCollapsedState(pathName, collapsed) {
                        const contractDiv = document.querySelector(\`[data-path-name="\${pathName}"]\`);
                        if (!contractDiv) return;
                        
                        const button = contractDiv.querySelector('.toggle-button .codicon');
                        if (button) {
                            if (collapsed) {
                                button.classList.replace('codicon-chevron-down', 'codicon-chevron-right');
                            } else {
                                button.classList.replace('codicon-chevron-right', 'codicon-chevron-down');
                            }
                        }
                        
                        const functionsList = contractDiv.querySelector('.functions-list');
                        if (functionsList) {
                            if (collapsed) {
                                functionsList.classList.add('collapsed');
                            } else {
                                functionsList.classList.remove('collapsed');
                            }
                        }
                    }

                    // Optimized version of toggle contract function
                    function toggleContract(pathName, enabled) {
                        showSavingIndicator();
                        vscode.postMessage({
                            type: 'toggleContract',
                            pathName: pathName,
                            enabled: enabled
                        });
                    }

                    // Fuzzy search matching function
                    function fuzzyMatch(text, search) {
                        if (!search || search.trim() === '') {
                            // Return the original text without highlights when search is empty
                            return { match: true, score: 0, highlighted: text };
                        }
                        
                        search = search.toLowerCase();
                        const textLower = text.toLowerCase();
                        
                        // Direct substring match (higher priority)
                        if (textLower.includes(search)) {
                            const index = textLower.indexOf(search);
                            const highlighted = text.substring(0, index) +
                                '<span class="highlight">' + text.substring(index, index + search.length) + '</span>' +
                                text.substring(index + search.length);
                            return { match: true, score: 0, highlighted };
                        }
                        
                        // Fuzzy matching
                        let searchIdx = 0;
                        let score = 0;
                        let lastMatchIdx = -1;
                        let consecutive = 0;
                        const matchPositions = [];
                        
                        for (let i = 0; i < textLower.length && searchIdx < search.length; i++) {
                            if (textLower[i] === search[searchIdx]) {
                                if (lastMatchIdx === i - 1) {
                                    consecutive++;
                                    score -= consecutive * 0.5;
                                } else {
                                    consecutive = 0;
                                }
                                
                                score += i;
                                lastMatchIdx = i;
                                matchPositions.push(i);
                                searchIdx++;
                            }
                        }
                        
                        const match = searchIdx === search.length;
                        
                        let highlighted = '';
                        if (match) {
                            let lastPos = 0;
                            for (const pos of matchPositions) {
                                highlighted += text.substring(lastPos, pos);
                                highlighted += '<span class="highlight">' + text[pos] + '</span>';
                                lastPos = pos + 1;
                            }
                            highlighted += text.substring(lastPos);
                        } else {
                            highlighted = text;
                        }
                        
                        return { match, score, highlighted };
                    }

                    function filterContracts(query) {
                        // Update state
                        state.searchQuery = query;
                        vscode.setState(state);
                        
                        // Tell extension about the query (but don't wait for refresh)
                        vscode.postMessage({
                            type: 'updateSearch',
                            query: query
                        });
                        
                        const contractItems = document.querySelectorAll('.contract-item');
                        const noResults = document.getElementById('no-results');
                        const searchTerm = document.getElementById('search-term');
                        const contractGroups = document.querySelectorAll('.contract-group');
                        
                        searchTerm.textContent = query;
                        
                        let visibleCount = 0;
                        
                        // First pass: reset all items if the query is empty
                        if (!query || query.trim() === '') {
                            contractGroups.forEach(group => {
                                group.classList.remove('hidden');
                            });
                            contractItems.forEach(item => {
                                // Reset to original text (no highlights)
                                const nameElement = item.querySelector('.contract-name');
                                const pathElement = item.querySelector('.contract-path');
                                
                                if (nameElement) {
                                    nameElement.textContent = item.getAttribute('data-name');
                                }
                                
                                if (pathElement) {
                                    pathElement.textContent = item.getAttribute('data-path');
                                }
                            });
                            
                            // Hide the no results message
                            noResults.classList.add('hidden');
                            return;
                        }
                        
                        // Search implementation for non-empty query
                        contractGroups.forEach(group => {
                            const item = group.querySelector('.contract-item');
                            if (item) {
                                const contractName = item.getAttribute('data-name');
                                const contractPath = item.getAttribute('data-path');
                                
                                const nameMatch = fuzzyMatch(contractName, query);
                                const pathMatch = fuzzyMatch(contractPath, query);
                                
                                if (nameMatch.match || pathMatch.match) {
                                    group.classList.remove('hidden');
                                    const nameElement = item.querySelector('.contract-name');
                                    const pathElement = item.querySelector('.contract-path');
                                    
                                    if (nameElement) {
                                        nameElement.innerHTML = nameMatch.highlighted;
                                    }
                                    if (pathElement) {
                                        pathElement.innerHTML = pathMatch.highlighted;
                                    }
                                    visibleCount++;
                                } else {
                                    group.classList.add('hidden');
                                }
                            }
                        });
                        
                        // Show/hide the "no results" message
                        if (visibleCount === 0) {
                            noResults.classList.remove('hidden');
                        } else {
                            noResults.classList.add('hidden');
                        }
                    }

                    function updateSearch(query) {
                        filterContracts(query);
                    }

                    function toggleFunction(pathName, functionName, enabled) {
                        vscode.postMessage({
                            type: 'toggleFunction',
                            pathName,
                            functionName,
                            enabled
                        });
                    }

                    function toggleAllFunctions(pathName, checked) {
                        document.querySelectorAll(\`[data-path-name="\${pathName}"] .function-checkbox\`).forEach(checkbox => {
                            checkbox.checked = checked;
                            toggleFunction(pathName, checkbox.dataset.function, checked);
                        });
                    }

                    function toggleCollapse(pathName) {
                        const contractDiv = document.querySelector(\`[data-path-name="\${pathName}"]\`);
                        const button = contractDiv.querySelector('.toggle-button .codicon');
                        
                        if (button.classList.contains('codicon-chevron-right')) {
                            button.classList.replace('codicon-chevron-right', 'codicon-chevron-down');
                        } else {
                            button.classList.replace('codicon-chevron-down', 'codicon-chevron-right');
                        }
                        
                        vscode.postMessage({
                            type: 'toggleCollapse',
                            pathName: pathName
                        });
                    }

                    function updateFunctionMode(pathName, functionName, mode) {
                        vscode.postMessage({
                            type: 'updateFunctionMode',
                            pathName,
                            functionName,
                            mode: mode || 'default'
                        });
                        // Update radio button state directly
                        const radioGroup = document.querySelector(
                            \`[data-path-name="\${pathName}"] [data-function="\${functionName}"] vscode-radio-group[data-type="mode"]\`
                        );
                        if (radioGroup) {
                            radioGroup.value = mode;
                        }
                    }

                    function updateFunctionActor(pathName, functionName, actor) {
                        vscode.postMessage({
                            type: 'updateFunctionActor',
                            pathName,
                            functionName,
                            actor
                        });
                        // Update radio button state directly
                        const radioGroup = document.querySelector(
                            \`[data-path-name="\${pathName}"] [data-function="\${functionName}"] vscode-radio-group[data-type="actor"]\`
                        );
                        if (radioGroup) {
                            radioGroup.value = actor;
                        }
                    }

                    function toggleContractSeparated(pathName, checked, clientUpdate = false) {
                        if (clientUpdate) {
                            showSavingIndicator();
                        }
                        
                        // Update client-side state if available
                        if (state.contractStates[pathName]) {
                            state.contractStates[pathName].separated = checked;
                            vscode.setState(state);
                        }
                        
                        vscode.postMessage({
                            type: 'toggleContractSeparated',
                            pathName: pathName,
                            separated: checked,
                            clientUpdate
                        });
                    }

                    // Add click handler for contract paths
                    document.querySelectorAll('.contract-path').forEach(path => {
                        path.addEventListener('click', () => {
                            vscode.postMessage({
                                type: 'openFile',
                                path: path.getAttribute('data-path')
                            });
                        });
                    });
                    
                    // Initialize with any existing search query
                    if (state.searchQuery) {
                        const searchInput = document.getElementById('search-input');
                        searchInput.value = state.searchQuery;
                        filterContracts(state.searchQuery);
                    } else {
                        // Make sure all contracts are visible with no highlights when there's no search
                        filterContracts('');
                    }

                    // Add scaffold button handler
                    document.getElementById('generate-btn')?.addEventListener('click', () => {
                        vscode.postMessage({ type: 'generate' });
                    });
                </script>
            </body>
            </html>`;
    }

    private hasMutableFunctions(contract: ContractMetadata): boolean {
        return this.getMutableFunctions(contract.abi).length > 0;
    }

    private getContractsHtml(): string {
        if (this.contracts.length === 0) {
            return `
                <div class="no-contracts">
                    <p>No contracts detected yet.</p>
                    <vscode-button appearance="secondary" onclick="vscode.postMessage({type: 'build'})">
                        <i class="codicon codicon-gear"></i>
                        Build Project
                    </vscode-button>
                </div>
            `;
        }

        const visibleContracts = this.contracts
            .filter(contract =>
                (this.showAllFiles || (contract.name.includes("Mock") && (contract.path.startsWith('test/') || contract.path.startsWith('src/test/'))) || (!contract.path.startsWith('test/') && !contract.path.startsWith('src/test/') && !contract.path.endsWith('.t.sol') && !contract.path.endsWith('.s.sol') && !contract.path.startsWith('lib/') && !contract.path.startsWith('node_modules/') && !contract.path.startsWith('script/')))
            )
            .sort((a, b) => {
                const aDepth = a.path.split('/').length;
                const bDepth = b.path.split('/').length;
                if (aDepth !== bDepth) { return aDepth - bDepth; }
                return a.path.localeCompare(b.path);
            });

        if (visibleContracts.length === 0) {
            return `
                <div class="no-contracts">
                    No contracts available.
                </div>
            `;
        }

        // Separate enabled and disabled contracts
        const enabledContracts = visibleContracts.filter(c => c.enabled);
        const disabledContracts = visibleContracts.filter(c => !c.enabled);

        return `
            ${enabledContracts.length > 0 ? `
                <div class="contracts-section enabled-contracts">
                    <div class="section-header">Selected Contracts</div>
                    ${enabledContracts.map((contract, index, array) => this.renderContractItem(contract, index, array)).join('')}
                </div>
            ` : ''}
            ${enabledContracts.length > 0 && disabledContracts.length > 0 ? `
                <div class="section-divider"></div>
            ` : ''}
            ${disabledContracts.length > 0 ? `
                <div class="contracts-section disabled-contracts">
                    ${disabledContracts.length > 0 && enabledContracts.length > 0 ? `
                        <div class="section-header">Available Contracts</div>
                    ` : ''}
                    ${disabledContracts.map((contract, index, array) => this.renderContractItem(contract, index, array)).join('')}
                </div>
            ` : ''}
        `;
    }

    // Add this helper method to keep the contract rendering logic clean
    private renderContractItem(contract: ContractMetadata, index: number, array: ContractMetadata[]): string {
        return `
            <div class="contract-group">
                <div class="contract-item" data-path-name="${contract.jsonPath}" data-name="${contract.name}" data-path="${contract.path}">
                    <div class="contract-header">
                        <div class="contract-title">
                            ${contract.enabled ? `
                                <button class="toggle-button" onclick="toggleCollapse('${contract.jsonPath}')">
                                    <i class="codicon ${this.collapsedContracts.has(contract.jsonPath) ? 'codicon-chevron-right' : 'codicon-chevron-down'}"></i>
                                </button>
                            ` : ''}
                            <vscode-checkbox
                                class="contract-checkbox"
                                id="contract-${contract.jsonPath}"
                                ${contract.enabled ? 'checked' : ''}
                                onchange="toggleContract('${contract.jsonPath}', this.checked)"
                            >
                                <span class="contract-name">${contract.name}</span>
                            </vscode-checkbox>
                            ${contract.enabled ? `
                                <vscode-checkbox
                                    class="contract-separated-checkbox"
                                    id="contract-separated-${contract.jsonPath}"
                                    ${contract.separated !== false ? 'checked' : ''}
                                    onchange="toggleContractSeparated('${contract.jsonPath}', this.checked)"
                                >
                                    Separated
                                </vscode-checkbox>
                            ` : ''}
                        </div>
                        <div class="contract-path" data-path="${contract.path}">${contract.path}</div>
                    </div>
                    ${contract.enabled ? `
                        <div class="functions-list ${this.collapsedContracts.has(contract.jsonPath) ? 'collapsed' : ''}">
                            ${this.getFunctionsHtml(contract)}
                        </div>
                    ` : ''}
                </div>
                ${index < array.length - 1 ? '<div class="contract-divider"></div>' : ''}
            </div>
        `;
    }

    private getFunctionsHtml(contract: ContractMetadata): string {
        if (!contract.enabled) { return ''; }

        const functions = this.getMutableFunctions(contract.abi);
        if (functions.length === 0) { return ''; }

        return `
            <div class="functions-list">
                ${functions.map(fn => {
            const signature = this.getFunctionSignature(fn);
            // Find existing config or use default only if no config exists
            const config = contract.functionConfigs?.find(f => f.signature === signature) ?? {
                signature,
                actor: Actor.ACTOR,
                mode: Mode.NORMAL
            };
            const isEnabled = contract.enabledFunctions?.includes(signature);

            return `
                        <div class="function-item">
                            <div class="function-header">
                                <vscode-checkbox
                                    class="function-checkbox"
                                    data-function="${signature}"
                                    ${isEnabled ? 'checked' : ''}
                                    onchange="toggleFunction('${contract.jsonPath}', '${signature}', this.checked)"
                                >
                                    <span class="function-name" title="${signature}">${signature}</span>
                                </vscode-checkbox>
                            </div>
                            ${isEnabled ? `
                                <div class="function-content">
                                    <div class="function-settings">
                                        <div class="optimized-radio-group" data-type="mode">
                                            <span class="optimized-radio">
                                                <label class="radio-label ${config.mode === Mode.NORMAL ? 'selected' : ''}" 
                                                       data-value="normal" 
                                                       onclick="updateFunctionSetting('${contract.jsonPath}', '${signature}', 'mode', 'normal', this)">
                                                    Normal
                                                </label>
                                            </span>
                                            <span class="optimized-radio">
                                                <label class="radio-label ${config.mode === Mode.FAIL ? 'selected' : ''}" 
                                                       data-value="fail" 
                                                       onclick="updateFunctionSetting('${contract.jsonPath}', '${signature}', 'mode', 'fail', this)">
                                                    Fail
                                                </label>
                                            </span>
                                            <span class="optimized-radio">
                                                <label class="radio-label ${config.mode === Mode.CATCH ? 'selected' : ''}" 
                                                       data-value="catch" 
                                                       onclick="updateFunctionSetting('${contract.jsonPath}', '${signature}', 'mode', 'catch', this)">
                                                    Catch
                                                </label>
                                            </span>
                                        </div>
                                        <div class="optimized-radio-group" data-type="actor">
                                            <span class="optimized-radio">
                                                <label class="radio-label ${config.actor === Actor.ACTOR ? 'selected' : ''}" 
                                                       data-value="actor" 
                                                       onclick="updateFunctionSetting('${contract.jsonPath}', '${signature}', 'actor', 'actor', this)">
                                                    Actor
                                                </label>
                                            </span>
                                            <span class="optimized-radio">
                                                <label class="radio-label ${config.actor === Actor.ADMIN ? 'selected' : ''}" 
                                                       data-value="admin" 
                                                       onclick="updateFunctionSetting('${contract.jsonPath}', '${signature}', 'actor', 'admin', this)">
                                                    Admin
                                                </label>
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            ` : ''}
                        </div>
                    `;
        }).join('')}
            </div>
        `;
    }

    private getMutableFunctions(abi: Abi[]): Abi[] {
        return abi.filter(item =>
            item.type === 'function' &&
            item.stateMutability !== 'view' &&
            item.stateMutability !== 'pure'
        );
    }

    private getCodiconsUri(): vscode.Uri {
        return vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css');
    }

    private getToolkitUri(): vscode.Uri {
        return vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/webview-ui-toolkit', 'dist', 'toolkit.min.js');
    }

    public setContracts(contracts: ContractMetadata[]) {
        this.contracts = contracts;
        contracts.forEach(c => this.collapsedContracts.add(c.name));
        this.loadState().then(() => this._updateWebview());
    }

    // Add watch functionality for recon.json
    public async startWatchingReconJson() {
        const fileSystemWatcher = vscode.workspace.createFileSystemWatcher('**/recon.json');

        fileSystemWatcher.onDidChange(async () => {
            await this.loadState();
            this._updateWebview();
        });

        this._disposables.push(fileSystemWatcher);
    }

    // Add new public method to access enabled contracts
    public async getEnabledContractData(): Promise<ContractMetadata[]> {
        await this.loadState();
        return this.contracts.filter(c => c.enabled);
    }

    public async updateFunctionConfig(pathName: string, functionName: string, update: { actor?: Actor, mode?: Mode }): Promise<void> {
        const contract = this.contracts.find(c => c.jsonPath === pathName);
        if (!contract || !contract.functionConfigs) { return; }

        const config = contract.functionConfigs.find(f => {
            const [configFuncName] = f.signature.split('(');
            return configFuncName === functionName;
        });

        if (config) {
            if (update.actor) { config.actor = update.actor; }
            if (update.mode) { config.mode = update.mode; }
            await this.saveState();
        }
    }
}
