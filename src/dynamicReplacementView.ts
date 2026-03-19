import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getFoundryConfigPath, getTestFolder } from './utils';

interface ConstantEntry {
    type: string;
    name: string;
    value: string;
    sourceLine: string; // the full source line for replacement
    lineIndex: number;  // 0-based line number in Setup.sol
}

interface DynamicReplacementState {
    enabled: boolean;
    constants: Record<string, string>; // name -> replacement value
}

const STATE_KEY = 'recon.dynamicReplacement';

export class DynamicReplacementViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _enabled: boolean = false;
    private _constants: ConstantEntry[] = [];
    private _replacements: Record<string, string> = {};

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {
        this.loadState();
    }

    private async loadState() {
        const state = this._context.globalState.get<DynamicReplacementState>(STATE_KEY);
        if (state) {
            this._enabled = state.enabled;
            this._replacements = state.constants || {};
        }
    }

    private async saveState() {
        await this._context.globalState.update(STATE_KEY, {
            enabled: this._enabled,
            constants: this._replacements
        } as DynamicReplacementState);
    }

    private async getSetupSolPath(): Promise<string | undefined> {
        if (!vscode.workspace.workspaceFolders) return undefined;
        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const foundryConfigPath = getFoundryConfigPath(workspaceRoot);
        const foundryRoot = path.dirname(foundryConfigPath);
        const testFolder = await getTestFolder(workspaceRoot);
        return path.join(foundryRoot, testFolder, 'recon', 'Setup.sol');
    }

    private async getReconJsonPath(): Promise<string | undefined> {
        if (!vscode.workspace.workspaceFolders) return undefined;
        return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'recon.json');
    }

    private async parseConstants(): Promise<ConstantEntry[]> {
        const setupPath = await this.getSetupSolPath();
        if (!setupPath) return [];

        try {
            const content = await fs.readFile(setupPath, 'utf8');
            // Match lines like: uint256 constant MAX_SUPPLY = 1000;
            // Also match: uint256 public constant MAX_SUPPLY = 1000;
            // Also match: address constant OWNER = 0x...;
            const regex = /^\s*(?:\w+\s+)*(constant)\s+(\w+(?:\[\])*)\s+(\w+)\s*=\s*(.+?)\s*;/gm;
            const constants: ConstantEntry[] = [];
            let match: RegExpExecArray | null;

            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const lineMatch = /^\s*(?:\w+\s+)*(constant)\s+(\w+(?:\[\])*)\s+(\w+)\s*=\s*(.+?)\s*;/.exec(line);
                if (lineMatch) {
                    constants.push({
                        type: lineMatch[2],
                        name: lineMatch[3],
                        value: lineMatch[4].trim(),
                        sourceLine: line,
                        lineIndex: i
                    });
                }
            }

            return constants;
        } catch {
            return [];
        }
    }

    private async applyReplacements(): Promise<void> {
        const setupPath = await this.getSetupSolPath();
        const reconJsonPath = await this.getReconJsonPath();
        if (!setupPath || !reconJsonPath) return;

        try {
            // Read Setup.sol
            let content = await fs.readFile(setupPath, 'utf8');
            const lines = content.split('\n');

            // Apply replacements
            for (const constant of this._constants) {
                const replacement = this._replacements[constant.name];
                if (replacement !== undefined && replacement !== constant.value) {
                    const regex = new RegExp(
                        `(${escapeRegex(constant.sourceLine.trimEnd())})`
                    );
                    const newLine = constant.sourceLine.replace(
                        /=\s*.+?\s*;/,
                        `= ${replacement};`
                    );
                    lines[constant.lineIndex] = newLine;
                    // Update the parsed value
                    constant.value = replacement;
                    constant.sourceLine = newLine;
                }
            }

            await fs.writeFile(setupPath, lines.join('\n'));

            // Save to recon.json
            await this.saveToReconJson(reconJsonPath);
        } catch (e) {
            console.error('Failed to apply replacements:', e);
        }
    }

    private async saveToReconJson(reconJsonPath: string): Promise<void> {
        try {
            let reconData: Record<string, any> = {};
            try {
                const content = await fs.readFile(reconJsonPath, 'utf8');
                reconData = JSON.parse(content);
            } catch {
                // File doesn't exist or is invalid, start fresh
            }

            // Build dynamic replacement data
            const dynamicReplacements: Record<string, { type: string; value: string; originalValue: string }> = {};
            for (const constant of this._constants) {
                const replacement = this._replacements[constant.name];
                if (replacement !== undefined) {
                    dynamicReplacements[constant.name] = {
                        type: constant.type,
                        value: replacement,
                        originalValue: constant.value
                    };
                }
            }

            // Store under a top-level key matching the internal convention
            reconData.__dynamicReplacements = {
                enabled: this._enabled,
                constants: dynamicReplacements
            };

            await fs.writeFile(reconJsonPath, JSON.stringify(reconData, null, 2));
        } catch (e) {
            console.error('Failed to save to recon.json:', e);
        }
    }

    private async loadFromReconJson(): Promise<void> {
        const reconJsonPath = await this.getReconJsonPath();
        if (!reconJsonPath) return;

        try {
            const content = await fs.readFile(reconJsonPath, 'utf8');
            const reconData = JSON.parse(content);

            const dr = reconData.__dynamicReplacements;
            if (dr) {
                this._enabled = dr.enabled ?? false;
                this._replacements = {};
                if (dr.constants) {
                    for (const [name, entry] of Object.entries(dr.constants)) {
                        const e = entry as any;
                        this._replacements[name] = e.value;
                    }
                }
                await this.saveState();
            }
        } catch {
            // Ignore
        }
    }

    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.type) {
                case 'toggleEnabled':
                    this._enabled = message.enabled;
                    await this.saveState();
                    await this.loadFromReconJson();
                    if (this._enabled) {
                        await this.applyReplacements();
                    }
                    this._updateWebview();
                    break;
                case 'updateConstant':
                    if (message.name && message.value !== undefined) {
                        this._replacements[message.name] = message.value;
                        await this.saveState();
                        if (this._enabled) {
                            await this.applyReplacements();
                        }
                    }
                    break;
                case 'resetConstant':
                    if (message.name) {
                        const constant = this._constants.find(c => c.name === message.name);
                        if (constant) {
                            this._replacements[message.name] = constant.value;
                            await this.saveState();
                            if (this._enabled) {
                                await this.applyReplacements();
                            }
                            this._updateWebview();
                        }
                    }
                    break;
                case 'resetAll':
                    this._replacements = {};
                    await this.saveState();
                    if (this._enabled) {
                        await this.applyReplacements();
                    }
                    this._updateWebview();
                    break;
            }
        });

        webviewView.onDidChangeVisibility(async () => {
            if (webviewView.visible) {
                await this.refresh();
            }
        });

        await this.refresh();
    }

    public async refresh() {
        this._constants = await this.parseConstants();
        await this.loadFromReconJson();
        this._updateWebview();
    }

    private _updateWebview() {
        if (!this._view) return;

        const webview = this._view.webview;
        webview.html = this._getHtmlForWebview(webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const constantsHtml = this._constants.length === 0
            ? `<div class="empty-state">No constants found in Setup.sol</div>`
            : this._constants.map(c => {
                const currentValue = this._replacements[c.name] ?? c.value;
                const isModified = currentValue !== c.value;
                return `
                    <div class="constant-row ${isModified ? 'modified' : ''}">
                        <div class="constant-header">
                            <span class="constant-type">${escapeHtml(c.type)}</span>
                            <span class="constant-name">${escapeHtml(c.name)}</span>
                            ${isModified ? '<span class="badge modified-badge">Modified</span>' : ''}
                        </div>
                        <div class="constant-original">
                            Original: <code>${escapeHtml(c.value)}</code>
                        </div>
                        <div class="constant-edit">
                            <input type="text"
                                class="constant-input"
                                data-name="${escapeHtml(c.name)}"
                                value="${escapeHtml(currentValue)}"
                                placeholder="${escapeHtml(c.value)}"
                                ${!this._enabled ? 'disabled' : ''} />
                            ${isModified ? `<button class="reset-btn" data-name="${escapeHtml(c.name)}">↺ Reset</button>` : ''}
                        </div>
                    </div>
                `;
            }).join('');

        return /*html*/ `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    * { box-sizing: border-box; margin: 0; padding: 0; }
                    body {
                        font-family: var(--vscode-font-family);
                        font-size: var(--vscode-font-size);
                        color: var(--vscode-foreground);
                        padding: 8px;
                    }
                    .header {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        margin-bottom: 12px;
                        padding-bottom: 8px;
                        border-bottom: 1px solid var(--vscode-panel-border);
                    }
                    .header h3 {
                        font-size: 13px;
                        font-weight: 600;
                        text-transform: uppercase;
                        letter-spacing: 0.5px;
                        color: var(--vscode-foreground);
                    }
                    .toggle-container {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                    }
                    .toggle-label {
                        font-size: 12px;
                        color: var(--vscode-descriptionForeground);
                    }
                    .toggle {
                        position: relative;
                        width: 36px;
                        height: 20px;
                        background: var(--vscode-input-background);
                        border: 1px solid var(--vscode-input-border);
                        border-radius: 10px;
                        cursor: pointer;
                        transition: background 0.2s;
                    }
                    .toggle.active {
                        background: var(--vscode-button-background);
                    }
                    .toggle::after {
                        content: '';
                        position: absolute;
                        top: 2px;
                        left: 2px;
                        width: 14px;
                        height: 14px;
                        background: var(--vscode-foreground);
                        border-radius: 50%;
                        transition: left 0.2s;
                    }
                    .toggle.active::after {
                        left: 18px;
                    }
                    .constant-row {
                        margin-bottom: 10px;
                        padding: 8px;
                        background: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 4px;
                    }
                    .constant-row.modified {
                        border-color: var(--vscode-inputValidation-infoBorder, #007acc);
                        background: var(--vscode-inputValidation-infoBackground, rgba(0,122,204,0.06));
                    }
                    .constant-header {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        margin-bottom: 4px;
                    }
                    .constant-type {
                        font-size: 11px;
                        color: var(--vscode-descriptionForeground);
                        background: var(--vscode-badge-background);
                        padding: 1px 5px;
                        border-radius: 3px;
                    }
                    .constant-name {
                        font-weight: 600;
                        font-size: 13px;
                    }
                    .badge {
                        font-size: 10px;
                        padding: 1px 5px;
                        border-radius: 3px;
                    }
                    .modified-badge {
                        background: var(--vscode-inputValidation-infoBackground, rgba(0,122,204,0.15));
                        color: var(--vscode-inputValidation-infoForeground, #007acc);
                    }
                    .constant-original {
                        font-size: 11px;
                        color: var(--vscode-descriptionForeground);
                        margin-bottom: 4px;
                    }
                    .constant-original code {
                        color: var(--vscode-foreground);
                    }
                    .constant-edit {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                    }
                    .constant-input {
                        flex: 1;
                        padding: 3px 6px;
                        background: var(--vscode-input-background);
                        border: 1px solid var(--vscode-input-border);
                        color: var(--vscode-input-foreground);
                        font-family: var(--vscode-font-family);
                        font-size: 12px;
                        border-radius: 2px;
                    }
                    .constant-input:disabled {
                        opacity: 0.5;
                    }
                    .constant-input:focus {
                        outline: 1px solid var(--vscode-focusBorder);
                    }
                    .reset-btn {
                        padding: 2px 8px;
                        font-size: 11px;
                        background: transparent;
                        border: 1px solid var(--vscode-input-border);
                        color: var(--vscode-foreground);
                        border-radius: 2px;
                        cursor: pointer;
                        white-space: nowrap;
                    }
                    .reset-btn:hover {
                        background: var(--vscode-list-hoverBackground);
                    }
                    .toolbar {
                        display: flex;
                        justify-content: flex-end;
                        margin-bottom: 8px;
                    }
                    .reset-all-btn {
                        padding: 3px 10px;
                        font-size: 11px;
                        background: transparent;
                        border: 1px solid var(--vscode-input-border);
                        color: var(--vscode-foreground);
                        border-radius: 2px;
                        cursor: pointer;
                    }
                    .reset-all-btn:hover {
                        background: var(--vscode-list-hoverBackground);
                    }
                    .empty-state {
                        padding: 20px;
                        text-align: center;
                        color: var(--vscode-descriptionForeground);
                        font-size: 12px;
                    }
                    .disabled-overlay {
                        opacity: 0.5;
                        pointer-events: none;
                    }
                </style>
            </head>
            <body>
                <div class="header">
                    <h3>Dynamic Replacement</h3>
                    <div class="toggle-container">
                        <span class="toggle-label">Enable</span>
                        <div class="toggle ${this._enabled ? 'active' : ''}" id="toggle-enabled"></div>
                    </div>
                </div>
                <div id="constants-list" class="${!this._enabled ? 'disabled-overlay' : ''}">
                    <div class="toolbar">
                        <button class="reset-all-btn" id="reset-all">Reset All</button>
                    </div>
                    ${constantsHtml}
                </div>
                <script>
                    const vscode = acquireVsCodeApi();

                    document.getElementById('toggle-enabled').addEventListener('click', () => {
                        const toggle = document.getElementById('toggle-enabled');
                        const isActive = toggle.classList.toggle('active');
                        vscode.postMessage({ type: 'toggleEnabled', enabled: isActive });
                    });

                    document.querySelectorAll('.constant-input').forEach(input => {
                        let debounceTimer;
                        input.addEventListener('input', (e) => {
                            clearTimeout(debounceTimer);
                            debounceTimer = setTimeout(() => {
                                vscode.postMessage({
                                    type: 'updateConstant',
                                    name: e.target.dataset.name,
                                    value: e.target.value
                                });
                            }, 500);
                        });
                    });

                    document.querySelectorAll('.reset-btn').forEach(btn => {
                        btn.addEventListener('click', () => {
                            vscode.postMessage({
                                type: 'resetConstant',
                                name: btn.dataset.name
                            });
                        });
                    });

                    document.getElementById('reset-all').addEventListener('click', () => {
                        vscode.postMessage({ type: 'resetAll' });
                    });
                </script>
            </body>
            </html>
        `;
    }
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
