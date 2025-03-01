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

        this.contracts.forEach(c => this.collapsedContracts.add(c.name));
        this.startWatchingReconJson();
    }

    private async setShowAllFiles(value: boolean) {
        this.showAllFiles = value;
        await vscode.workspace.getConfiguration('recon').update('showAllFiles', this.showAllFiles, true);
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

    public async loadReconJson(): Promise<Record<string, { functions: FunctionConfig[], separated?: boolean }>> {
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

    public async saveReconJson(data: Record<string, { functions: FunctionConfig[], separated?: boolean }>) {
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

    private debouncedSaveState() {
        if (this.saveStateTimeout) {
            clearTimeout(this.saveStateTimeout);
        }

        this.saveStateTimeout = setTimeout(async () => {
            await this.saveState();
        }, 500); // 500ms debounce
    }

    public async loadState() {
        try {
            const reconJson = await this.loadReconJson();

            this.contracts = this.contracts.map(contract => {
                const savedConfig = reconJson[contract.jsonPath];

                // A contract is enabled if it has any functions configured
                const isEnabled = savedConfig?.functions?.length > 0;

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
            // Save function configs and separated flag to recon.json
            const reconJson = Object.fromEntries(
                this.contracts
                    .filter(c => c.enabled && (c.functionConfigs?.length || c.separated === false))
                    .map(c => [
                        c.jsonPath,
                        {
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

        webviewView.webview.onDidReceiveMessage(async message => {
            try {
                switch (message.type) {
                    case 'build':
                        vscode.commands.executeCommand('recon.buildProject');
                        break;
                    case 'toggleShowAll':
                        this.showAllFiles = message.value;
                        this._updateWebview();
                        break;
                    case 'toggleContract':
                        const contract = this.contracts.find(c => c.name === message.contractName);
                        if (contract) {
                            this.toggleContract(contract, message.enabled);
                        }
                        break;
                    case 'toggleFunction':
                        const contract2 = this.contracts.find(c => c.name === message.contractName);
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
                        }
                        break;
                    case 'toggleCollapse':
                        if (this.collapsedContracts.has(message.contractName)) {
                            this.collapsedContracts.delete(message.contractName);
                        } else {
                            this.collapsedContracts.add(message.contractName);
                        }
                        this._updateWebview();
                        break;
                    case 'updateFunctionMode':
                    case 'updateFunctionActor':
                        const contract3 = this.contracts.find(c => c.name === message.contractName);
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
                        const contract4 = this.contracts.find(c => c.name === message.contractName);
                        if (contract4) {
                            contract4.separated = message.separated;
                            await this.saveState();
                        }
                        break;
                }
                // Use debounced save for all state changes
                this.debouncedSaveState();
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
                    .select-all-container {
                        position: sticky;
                        top: 0;
                        background: var(--vscode-sideBar-background);
                        border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
                        padding: 4px 8px;
                        z-index: 10;
                    }
                    .select-all {
                        font-size: 11px;
                        text-transform: uppercase;
                        font-weight: 600;
                        opacity: 0.8;
                        letter-spacing: 0.04em;
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
                </style>
            </head>
            <body class="webview-body">
                <div class="select-all-container">
                    <vscode-checkbox 
                        class="select-all" 
                        onchange="toggleAllContracts(this.checked)"
                        ${this.areAllContractsSelected() ? 'checked' : ''}
                    >
                        Select All Contracts
                    </vscode-checkbox>
                </div>
                <div id="contracts-list" class="contracts-container">
                    ${this.getContractsHtml()}
                </div>
                <script>
                    const vscode = acquireVsCodeApi();
                    
                    function toggleContract(name, enabled) {
                        vscode.postMessage({
                            type: 'toggleContract',
                            contractName: name,
                            enabled: enabled
                        });
                    }

                    function toggleAllContracts(checked) {
                        document.querySelectorAll('.contract-checkbox').forEach(checkbox => {
                            if (checkbox.checked !== checked) {
                                checkbox.checked = checked;
                                const contractName = checkbox.id.replace('contract-', '');
                                toggleContract(contractName, checked);
                            }
                        });
                    }

                    function toggleFunction(contractName, functionName, enabled) {
                        vscode.postMessage({
                            type: 'toggleFunction',
                            contractName,
                            functionName,
                            enabled
                        });
                    }

                    function toggleAllFunctions(contractName, checked) {
                        document.querySelectorAll(\`[data-contract="\${contractName}"] .function-checkbox\`).forEach(checkbox => {
                            checkbox.checked = checked;
                            toggleFunction(contractName, checkbox.dataset.function, checked);
                        });
                    }

                    function toggleCollapse(contractName) {
                        const contractDiv = document.querySelector(\`[data-contract="\${contractName}"]\`);
                        const button = contractDiv.querySelector('.toggle-button .codicon');
                        
                        if (button.classList.contains('codicon-chevron-right')) {
                            button.classList.replace('codicon-chevron-right', 'codicon-chevron-down');
                        } else {
                            button.classList.replace('codicon-chevron-down', 'codicon-chevron-right');
                        }
                        
                        vscode.postMessage({
                            type: 'toggleCollapse',
                            contractName: contractName
                        });
                    }

                    function updateFunctionMode(contractName, functionName, mode) {
                        vscode.postMessage({
                            type: 'updateFunctionMode',
                            contractName,
                            functionName,
                            mode: mode || 'default'
                        });
                        // Update radio button state directly
                        const radioGroup = document.querySelector(
                            \`[data-contract="\${contractName}"] [data-function="\${functionName}"] vscode-radio-group[data-type="mode"]\`
                        );
                        if (radioGroup) {
                            radioGroup.value = mode;
                        }
                    }

                    function updateFunctionActor(contractName, functionName, actor) {
                        vscode.postMessage({
                            type: 'updateFunctionActor',
                            contractName,
                            functionName,
                            actor
                        });
                        // Update radio button state directly
                        const radioGroup = document.querySelector(
                            \`[data-contract="\${contractName}"] [data-function="\${functionName}"] vscode-radio-group[data-type="actor"]\`
                        );
                        if (radioGroup) {
                            radioGroup.value = actor;
                        }
                    }

                    function toggleContractSeparated(name, checked) {
                        vscode.postMessage({
                            type: 'toggleContractSeparated',
                            contractName: name,
                            separated: checked
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
                </script>
            </body>
            </html>`;
    }

    private hasMutableFunctions(contract: ContractMetadata): boolean {
        return this.getMutableFunctions(contract.abi).length > 0;
    }

    private areAllContractsSelected(): boolean {
        const visibleContracts = this.contracts.filter(
            contract =>
                this.hasMutableFunctions(contract) &&
                (this.showAllFiles || (!contract.path.startsWith('test/') && !contract.path.startsWith('lib/') && !contract.path.startsWith('script/')))
        );
        return visibleContracts.length > 0 && visibleContracts.every(c => c.enabled);
    }

    private getContractsHtml(): string {
        if (this.contracts.length === 0) {
            return `
                <div class="no-contracts">
                    No contracts detected yet.
                    <vscode-button appearance="secondary" onclick="vscode.postMessage({type: 'build'})">
                        <i class="codicon codicon-gear"></i>
                        Build Project
                    </vscode-button>
                </div>
            `;
        }

        return this.contracts
            .filter(contract =>
                this.hasMutableFunctions(contract) &&
                (this.showAllFiles || (!contract.path.startsWith('test/') && !contract.path.startsWith('lib/') && !contract.path.startsWith('node_modules/') && !contract.path.startsWith('script/')))
            )
            .sort((a, b) => {
                const aDepth = a.path.split('/').length;
                const bDepth = b.path.split('/').length;
                if (aDepth !== bDepth) { return aDepth - bDepth; }
                return a.path.localeCompare(b.path);
            })
            .map((contract, index, array) => `
                <div class="contract-item" data-contract="${contract.name}">
                    <div class="contract-header">
                        <div class="contract-title">
                            <button class="toggle-button" onclick="toggleCollapse('${contract.name}')">
                                <i class="codicon ${this.collapsedContracts.has(contract.name) ? 'codicon-chevron-right' : 'codicon-chevron-down'}"></i>
                            </button>
                            <vscode-checkbox
                                class="contract-checkbox"
                                id="contract-${contract.name}"
                                ${contract.enabled ? 'checked' : ''}
                                onchange="toggleContract('${contract.name}', this.checked)"
                            >
                                ${contract.name}
                            </vscode-checkbox>
                            ${contract.enabled ? `
                                <vscode-checkbox
                                    class="contract-separated-checkbox"
                                    id="contract-separated-${contract.name}"
                                    ${contract.separated !== false ? 'checked' : ''}
                                    onchange="toggleContractSeparated('${contract.name}', this.checked)"
                                >
                                    Separated
                                </vscode-checkbox>
                            ` : ''}
                        </div>
                        <div class="contract-path" data-path="${contract.path}">${contract.path}</div>
                    </div>
                    <div class="functions-list ${this.collapsedContracts.has(contract.name) ? 'collapsed' : ''}">
                        ${this.getFunctionsHtml(contract)}
                    </div>
                </div>
                ${index < array.length - 1 ? '<div class="contract-divider"></div>' : ''}
            `).join('');
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
                                    onchange="toggleFunction('${contract.name}', '${signature}', this.checked)"
                                >
                                    <span class="function-name" title="${signature}">${signature}</span>
                                </vscode-checkbox>
                            </div>
                            ${isEnabled ? `
                                <div class="function-content">
                                    <div class="function-settings">
                                        <vscode-radio-group 
                                            orientation="horizontal"
                                            data-type="mode"
                                            onchange="updateFunctionMode('${contract.name}', '${signature}', this.value)"
                                            value="${config.mode}"
                                        >
                                            <vscode-radio value="normal" ${config.mode === Mode.NORMAL ? 'checked' : ''}>Normal</vscode-radio>
                                            <vscode-radio value="fail" ${config.mode === Mode.FAIL ? 'checked' : ''}>Fail</vscode-radio>
                                            <vscode-radio value="catch" ${config.mode === Mode.CATCH ? 'checked' : ''}>Catch</vscode-radio>
                                        </vscode-radio-group>
                                        <vscode-radio-group 
                                            orientation="horizontal"
                                            data-type="actor"
                                            onchange="updateFunctionActor('${contract.name}', '${signature}', this.value)"
                                            value="${config.actor}"
                                        >
                                            <vscode-radio value="actor" ${config.actor === Actor.ACTOR ? 'checked' : ''}>Actor</vscode-radio>
                                            <vscode-radio value="admin" ${config.actor === Actor.ADMIN ? 'checked' : ''}>Admin</vscode-radio>
                                        </vscode-radio-group>
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

    public async updateFunctionConfig(contractName: string, functionName: string, update: { actor?: Actor, mode?: Mode }): Promise<void> {
        const contract = this.contracts.find(c => c.name === contractName);
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
