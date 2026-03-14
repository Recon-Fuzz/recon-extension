import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getFoundryConfigPath, getTestFolder } from '../utils';
import { DynamicReplacement, ParsedConstant } from '../types';

export class DynamicReplacementViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _enabled = false;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'toggleEnabled':
                    this._enabled = message.value;
                    await this._updateWebview();
                    break;
                case 'saveReplacements':
                    if (Array.isArray(message.replacements)) {
                        await this._saveReplacements(message.replacements);
                    }
                    break;
                case 'removeReplacement':
                    await this._removeReplacement(message.index);
                    break;
                case 'refresh':
                    await this._updateWebview();
                    break;
            }
        });

        this._updateWebview();
    }

    public isEnabled(): boolean {
        return this._enabled;
    }

    private async _getSetupSolPath(): Promise<string | undefined> {
        if (!vscode.workspace.workspaceFolders) { return undefined; }
        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const foundryConfigPath = getFoundryConfigPath(workspaceRoot);
        const foundryRoot = path.dirname(foundryConfigPath);
        const testFolder = await getTestFolder(workspaceRoot);

        const candidates = [
            path.join(foundryRoot, testFolder, 'recon', 'Setup.sol'),
            path.join(foundryRoot, testFolder, 'Setup.sol'),
            path.join(foundryRoot, 'test', 'recon', 'Setup.sol'),
            path.join(foundryRoot, 'test', 'Setup.sol'),
        ];

        for (const candidate of candidates) {
            try {
                await fs.access(candidate);
                return candidate;
            } catch { /* not found, try next */ }
        }
        return undefined;
    }

    private _parseConstants(source: string): ParsedConstant[] {
        const constants: ParsedConstant[] = [];
        const lines = source.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            // Match state variable assignments: Type name = value;
            // Handles: IEVault newVault = IEVault(addr);
            //          address whale = 0x123;
            //          uint256 public constant X = 42;
            const match = trimmed.match(
                /^(\w[\w\[\]]*(?:\s+(?:public|private|internal|external|constant|immutable))*)\s+(\w+)\s*=\s*(.+?)\s*;$/
            );
            if (match) {
                const [, typePart, name, value] = match;
                // Skip function-level vars (inside function bodies)
                // We only want contract-level state variables
                if (!typePart.startsWith('//') && !typePart.startsWith('*')) {
                    constants.push({
                        name,
                        typeName: typePart.trim(),
                        initialValue: value.trim(),
                        fullAssignment: `${name} = ${typePart.split(/\s+/).pop() === name ? '' : ''}`,
                    });
                }
            }
        }
        return constants;
    }

    private async _getReconJsonPath(): Promise<string | undefined> {
        if (!vscode.workspace.workspaceFolders) { return undefined; }
        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        return path.join(workspaceRoot, 'recon.json');
    }

    private async _loadExistingReplacements(): Promise<DynamicReplacement[]> {
        const reconPath = await this._getReconJsonPath();
        if (!reconPath) { return []; }
        try {
            const content = await fs.readFile(reconPath, 'utf8');
            const config = JSON.parse(content);
            return Array.isArray(config.prepareContracts) ? config.prepareContracts : [];
        } catch {
            return [];
        }
    }

    private async _saveReplacements(replacements: DynamicReplacement[]): Promise<void> {
        const reconPath = await this._getReconJsonPath();
        if (!reconPath) {
            vscode.window.showErrorMessage('No workspace open');
            return;
        }

        let config: Record<string, unknown> = {};
        try {
            const content = await fs.readFile(reconPath, 'utf8');
            config = JSON.parse(content);
        } catch { /* file may not exist yet */ }

        // Filter out empty replacements
        const validReplacements = replacements.filter(
            (r) => r.target.trim() && r.replacement.trim()
        );

        config.prepareContracts = validReplacements;
        await fs.writeFile(reconPath, JSON.stringify(config, null, 2), 'utf8');
        vscode.window.showInformationMessage(
            `Saved ${validReplacements.length} dynamic replacement(s) to recon.json`
        );
        await this._updateWebview();
    }

    private async _removeReplacement(index: number): Promise<void> {
        const existing = await this._loadExistingReplacements();
        existing.splice(index, 1);
        await this._saveReplacements(existing);
    }

    private async _updateWebview(): Promise<void> {
        if (!this._view) { return; }

        const setupPath = await this._getSetupSolPath();
        let constants: ParsedConstant[] = [];

        if (setupPath) {
            try {
                const source = await fs.readFile(setupPath, 'utf8');
                constants = this._parseConstants(source);
            } catch { /* Setup.sol not readable */ }
        }

        const existingReplacements = await this._loadExistingReplacements();

        this._view.webview.html = this._getHtml(constants, existingReplacements);
    }

    private _getNonce(): string {
        return crypto.randomBytes(16).toString('base64');
    }

    private _getHtml(
        constants: ParsedConstant[],
        existingReplacements: DynamicReplacement[],
    ): string {
        const constantRows = constants.map((c, i) => {
            // Check if there's already a replacement for this constant
            const existing = existingReplacements.find(
                (r) => r.target.includes(c.name + ' =') || r.target.includes(c.name + '=')
            );
            const currentReplacement = existing ? existing.replacement : '';
            return `
                <tr>
                    <td class="name-cell" title="${this._escapeHtml(c.typeName)}">${this._escapeHtml(c.name)}</td>
                    <td class="value-cell" title="${this._escapeHtml(c.initialValue)}">${this._escapeHtml(c.initialValue)}</td>
                    <td class="input-cell">
                        <input type="text" class="replacement-input" data-index="${i}"
                               data-name="${this._escapeHtml(c.name)}"
                               data-type="${this._escapeHtml(c.typeName)}"
                               data-original="${this._escapeHtml(c.initialValue)}"
                               value="${this._escapeHtml(currentReplacement)}"
                               placeholder="New value..." />
                    </td>
                </tr>`;
        }).join('');

        const savedRows = existingReplacements.map((r, i) => `
            <tr>
                <td class="name-cell" title="${this._escapeHtml(r.target)}">${this._escapeHtml(r.target)}</td>
                <td class="value-cell">${this._escapeHtml(r.replacement)}</td>
                <td class="action-cell">
                    <button class="remove-btn" data-index="${i}" title="Remove">✕</button>
                </td>
            </tr>`).join('');

        const nonce = this._getNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px; margin: 0; }
        .toggle-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding: 8px; background: var(--vscode-editor-background); border-radius: 4px; }
        .toggle-row input[type="checkbox"] { width: 16px; height: 16px; }
        .toggle-row label { font-weight: bold; cursor: pointer; }
        h3 { margin: 12px 0 6px; font-size: 13px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.5px; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--vscode-widget-border); color: var(--vscode-descriptionForeground); font-size: 11px; }
        td { padding: 4px 6px; border-bottom: 1px solid var(--vscode-widget-border); vertical-align: middle; }
        .name-cell { max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .value-cell { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); }
        .replacement-input { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 2px; padding: 3px 6px; font-size: 12px; }
        .replacement-input:focus { outline: 1px solid var(--vscode-focusBorder); }
        .btn { display: block; width: 100%; padding: 6px 12px; margin-top: 8px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; cursor: pointer; font-size: 12px; }
        .btn:hover { background: var(--vscode-button-hoverBackground); }
        .remove-btn { background: none; border: none; color: var(--vscode-errorForeground); cursor: pointer; font-size: 14px; padding: 2px 6px; }
        .remove-btn:hover { background: var(--vscode-toolbar-hoverBackground); border-radius: 2px; }
        .disabled-overlay { opacity: 0.5; pointer-events: none; }
        .empty-msg { color: var(--vscode-descriptionForeground); font-style: italic; padding: 8px 0; }
    </style>
</head>
<body>
    <div class="toggle-row">
        <input type="checkbox" id="enableToggle" ${this._enabled ? 'checked' : ''} />
        <label for="enableToggle">Enable Dynamic Replacement</label>
    </div>

    <div id="content" class="${this._enabled ? '' : 'disabled-overlay'}">
        <h3>Setup.sol Constants</h3>
        ${constants.length > 0 ? `
            <table>
                <thead><tr><th>Name</th><th>Current</th><th>Replacement</th></tr></thead>
                <tbody>${constantRows}</tbody>
            </table>
            <button class="btn" id="saveBtn">Save Replacements</button>
        ` : '<p class="empty-msg">No Setup.sol found or no state variables detected.</p>'}

        ${existingReplacements.length > 0 ? `
            <h3>Saved Replacements (recon.json)</h3>
            <table>
                <thead><tr><th>Target</th><th>Replacement</th><th></th></tr></thead>
                <tbody>${savedRows}</tbody>
            </table>
        ` : ''}
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        document.getElementById('enableToggle').addEventListener('change', (e) => {
            vscode.postMessage({ type: 'toggleEnabled', value: e.target.checked });
        });

        const saveBtn = document.getElementById('saveBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                const inputs = document.querySelectorAll('.replacement-input');
                const replacements = [];
                inputs.forEach((input) => {
                    const value = input.value.trim();
                    if (value) {
                        const name = input.dataset.name;
                        const typeName = input.dataset.type;
                        const original = input.dataset.original;
                        // Extract the core type (last word before name in type declaration)
                        const typeWords = typeName.split(/\\s+/);
                        const coreType = typeWords[0];
                        replacements.push({
                            target: name + ' = ' + coreType,
                            replacement: name + ' = ' + value + ';',
                            endOfTargetMarker: '[^;]*',
                            targetContract: 'Setup.sol',
                        });
                    }
                });
                vscode.postMessage({ type: 'saveReplacements', replacements });
            });
        }

        document.querySelectorAll('.remove-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const index = parseInt(btn.dataset.index);
                vscode.postMessage({ type: 'removeReplacement', index });
            });
        });
    </script>
</body>
</html>`;
    }

    private _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}