import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
    SetupVariable,
    DynamicReplacement,
    DynamicReplacementConfig,
    findSetupSolPath,
    parseSetupVariables,
    loadDynamicReplacementConfig,
    saveDynamicReplacementConfig,
    buildReplacement,
    applyReplacementsToContent,
    escapeHtml,
} from '../utils/dynamicReplacement';

export class DynamicReplacementViewProvider {
    public static readonly viewType = 'recon.dynamicReplacement';

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public createWebviewPanel(): vscode.WebviewPanel {
        const panel = vscode.window.createWebviewPanel(
            DynamicReplacementViewProvider.viewType,
            'Dynamic Replacement',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [this._extensionUri],
            }
        );

        panel.webview.onDidReceiveMessage(async (message) => {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                await panel.webview.postMessage({ type: 'error', message: 'No workspace folder found' });
                return;
            }

            switch (message.type) {
                case 'loaded': {
                    await this.sendConstantsToWebview(panel, workspaceRoot);
                    break;
                }

                case 'toggleEnabled': {
                    try {
                        const config = await loadDynamicReplacementConfig(workspaceRoot);
                        config.enabled = message.enabled;
                        await saveDynamicReplacementConfig(workspaceRoot, config);
                        await panel.webview.postMessage({ type: 'enabledUpdated', enabled: config.enabled });
                    } catch (e) {
                        const msg = e instanceof Error ? e.message : 'Unknown error';
                        await panel.webview.postMessage({ type: 'error', message: msg });
                    }
                    break;
                }

                case 'saveReplacements': {
                    try {
                        const replacements: DynamicReplacement[] = [];
                        for (const entry of message.entries) {
                            if (entry.newValue && entry.newValue.trim()) {
                                replacements.push(buildReplacement(entry.name, entry.newValue.trim()));
                            }
                        }

                        const config = await loadDynamicReplacementConfig(workspaceRoot);
                        config.prepareContracts = replacements;
                        await saveDynamicReplacementConfig(workspaceRoot, config);

                        await panel.webview.postMessage({
                            type: 'saveSuccess',
                            count: replacements.length,
                        });
                    } catch (e) {
                        const msg = e instanceof Error ? e.message : 'Unknown error';
                        await panel.webview.postMessage({ type: 'error', message: msg });
                    }
                    break;
                }

                case 'updateSetupFile': {
                    try {
                        // Always read fresh from recon.json — not from stale UI state
                        const config = await loadDynamicReplacementConfig(workspaceRoot);
                        if (config.prepareContracts.length === 0) {
                            await panel.webview.postMessage({
                                type: 'error',
                                message: 'No replacements saved. Save replacements first.',
                            });
                            return;
                        }

                        const setupPath = await findSetupSolPath(workspaceRoot);
                        if (!setupPath) {
                            await panel.webview.postMessage({
                                type: 'error',
                                message: 'Setup.sol not found.',
                            });
                            return;
                        }

                        const content = await fs.readFile(setupPath, 'utf8');
                        const { result, applied, errors } = applyReplacementsToContent(
                            content,
                            config.prepareContracts
                        );

                        if (applied > 0) {
                            await fs.writeFile(setupPath, result, 'utf8');
                        }

                        await panel.webview.postMessage({
                            type: 'updateSuccess',
                            applied,
                            errors,
                        });

                        if (errors.length > 0) {
                            vscode.window.showWarningMessage(
                                `Dynamic Replacement: ${applied} applied, ${errors.length} warning(s)`
                            );
                        } else if (applied > 0) {
                            vscode.window.showInformationMessage(
                                `Dynamic Replacement: ${applied} replacement(s) applied to Setup.sol`
                            );
                        }
                    } catch (e) {
                        const msg = e instanceof Error ? e.message : 'Unknown error';
                        await panel.webview.postMessage({ type: 'error', message: msg });
                    }
                    break;
                }

                case 'openSetupSol': {
                    const setupPath = await findSetupSolPath(workspaceRoot);
                    if (setupPath) {
                        const doc = await vscode.workspace.openTextDocument(setupPath);
                        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
                    } else {
                        vscode.window.showWarningMessage('Setup.sol not found');
                    }
                    break;
                }
            }
        });

        panel.webview.html = this._getHtmlForWebview(panel.webview);
        return panel;
    }

    private async sendConstantsToWebview(
        panel: vscode.WebviewPanel,
        workspaceRoot: string
    ): Promise<void> {
        try {
            const setupPath = await findSetupSolPath(workspaceRoot);
            if (!setupPath) {
                await panel.webview.postMessage({
                    type: 'constantsLoaded',
                    variables: [],
                    config: { enabled: false, prepareContracts: [] },
                    error: 'Setup.sol not found. Scaffold your project first.',
                });
                return;
            }

            const variables = await parseSetupVariables(setupPath);
            const config = await loadDynamicReplacementConfig(workspaceRoot);

            await panel.webview.postMessage({
                type: 'constantsLoaded',
                variables,
                config,
                error: null,
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Unknown error';
            await panel.webview.postMessage({
                type: 'constantsLoaded',
                variables: [],
                config: { enabled: false, prepareContracts: [] },
                error: msg,
            });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
        );
        const toolkitUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/webview-ui-toolkit', 'dist', 'toolkit.min.js')
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1.0">
    <link href="${codiconsUri}" rel="stylesheet" />
    <script type="module" src="${toolkitUri}"></script>
    <title>Dynamic Replacement</title>
    <style>
        body {
            padding: 20px;
            color: var(--vscode-foreground);
            font-family: var(--vscode-font-family);
            background: var(--vscode-editor-background);
        }
        .container {
            max-width: 900px;
            margin: 0 auto;
        }
        h1 {
            font-size: 24px;
            margin-bottom: 4px;
            color: var(--vscode-foreground);
        }
        .description {
            margin-bottom: 20px;
            color: var(--vscode-descriptionForeground);
            font-size: 13px;
        }
        .toggle-row {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 20px;
            padding: 12px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 4px;
        }
        .toggle-row label {
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .actions-row {
            display: flex;
            gap: 8px;
            margin-bottom: 20px;
        }
        .btn {
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            border: 1px solid transparent;
        }
        .btn-primary {
            background: #5c25d2;
            color: white;
            border-color: #5c25d2;
        }
        .btn-primary:hover {
            background: #4a1ea8;
            border-color: #4a1ea8;
        }
        .btn-primary:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border-color: var(--vscode-button-border);
        }
        .btn-secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .constants-table {
            width: 100%;
            border-collapse: collapse;
        }
        .constants-table th {
            text-align: left;
            padding: 8px 12px;
            border-bottom: 2px solid var(--vscode-panel-border);
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: var(--vscode-descriptionForeground);
        }
        .constants-table td {
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            vertical-align: middle;
        }
        .var-name {
            font-family: var(--vscode-editor-font-family);
            font-weight: 600;
        }
        .var-type {
            font-family: var(--vscode-editor-font-family);
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }
        .var-value {
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            color: var(--vscode-textPreformat-foreground);
            max-width: 200px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .replacement-input {
            width: 100%;
            padding: 4px 8px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            border-radius: 3px;
            box-sizing: border-box;
        }
        .replacement-input:focus {
            outline: 1px solid var(--vscode-focusBorder);
            border-color: var(--vscode-focusBorder);
        }
        .replacement-input::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }
        .error-banner {
            padding: 12px 16px;
            background: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            border-radius: 4px;
            margin-bottom: 16px;
            color: var(--vscode-errorForeground);
        }
        .success-banner {
            padding: 12px 16px;
            background: var(--vscode-inputValidation-infoBackground);
            border: 1px solid var(--vscode-inputValidation-infoBorder);
            border-radius: 4px;
            margin-bottom: 16px;
        }
        .status-message {
            margin-bottom: 16px;
            font-size: 13px;
        }
        .loading {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            padding: 20px;
        }
        .empty-state {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            padding: 20px;
            text-align: center;
        }
        .open-link {
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            text-decoration: none;
            font-size: 13px;
        }
        .open-link:hover {
            text-decoration: underline;
        }
        .header-row {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
        }
        .mutability-badge {
            font-size: 10px;
            padding: 1px 6px;
            border-radius: 3px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            margin-left: 6px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header-row">
            <div>
                <h1>Dynamic Replacement</h1>
                <p class="description">
                    Replace constants in Setup.sol before fuzzing runs.
                    Edit replacement values below and save to recon.json.
                </p>
            </div>
            <a class="open-link" id="open-setup" href="#">Open Setup.sol</a>
        </div>

        <div class="toggle-row">
            <label>
                <input type="checkbox" id="enable-toggle" />
                Enable Dynamic Replacement
            </label>
        </div>

        <div id="status-area"></div>

        <div class="actions-row">
            <button class="btn btn-primary" id="save-btn" disabled>Save to recon.json</button>
            <button class="btn btn-secondary" id="update-btn" disabled>Update Setup.sol</button>
            <button class="btn btn-secondary" id="refresh-btn">Refresh</button>
        </div>

        <div id="content-area">
            <div class="loading">Loading constants from Setup.sol...</div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        let variables = [];
        let savedReplacements = [];
        let isEnabled = false;

        // DOM elements
        const enableToggle = document.getElementById('enable-toggle');
        const saveBtn = document.getElementById('save-btn');
        const updateBtn = document.getElementById('update-btn');
        const refreshBtn = document.getElementById('refresh-btn');
        const contentArea = document.getElementById('content-area');
        const statusArea = document.getElementById('status-area');
        const openSetupLink = document.getElementById('open-setup');

        // Request initial data
        vscode.postMessage({ type: 'loaded' });

        // Event handlers
        enableToggle.addEventListener('change', () => {
            isEnabled = enableToggle.checked;
            updateButtonStates();
            vscode.postMessage({ type: 'toggleEnabled', enabled: isEnabled });
        });

        saveBtn.addEventListener('click', () => {
            const entries = collectReplacementEntries();
            vscode.postMessage({ type: 'saveReplacements', entries });
        });

        updateBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'updateSetupFile' });
        });

        refreshBtn.addEventListener('click', () => {
            contentArea.innerHTML = '<div class="loading">Loading constants from Setup.sol...</div>';
            statusArea.innerHTML = '';
            vscode.postMessage({ type: 'loaded' });
        });

        openSetupLink.addEventListener('click', (e) => {
            e.preventDefault();
            vscode.postMessage({ type: 'openSetupSol' });
        });

        function collectReplacementEntries() {
            const entries = [];
            for (const v of variables) {
                const input = document.getElementById('replacement-' + v.name);
                if (input) {
                    entries.push({ name: v.name, newValue: input.value });
                }
            }
            return entries;
        }

        function updateButtonStates() {
            saveBtn.disabled = !isEnabled || variables.length === 0;
            updateBtn.disabled = !isEnabled || variables.length === 0;
        }

        function findSavedValue(variableName) {
            // Look through saved prepareContracts for a matching target
            for (const r of savedReplacements) {
                // target looks like "VARIABLE_NAME ="
                if (r.target === variableName + ' =') {
                    // Extract value from replacement string: "VARIABLE_NAME = VALUE;"
                    const match = r.replacement.match(/=\\s*(.+);$/);
                    if (match) {
                        return match[1].trim();
                    }
                }
            }
            return '';
        }

        function escapeHtmlClient(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }

        function renderConstants() {
            if (variables.length === 0) {
                contentArea.innerHTML = '<div class="empty-state">No constants or immutables found in Setup.sol.</div>';
                updateButtonStates();
                return;
            }

            let html = '<table class="constants-table">';
            html += '<thead><tr>';
            html += '<th>Name</th>';
            html += '<th>Type</th>';
            html += '<th>Current Value</th>';
            html += '<th>Replacement Value</th>';
            html += '</tr></thead>';
            html += '<tbody>';

            for (const v of variables) {
                const savedValue = findSavedValue(v.name);
                const escapedName = escapeHtmlClient(v.name);
                const escapedType = escapeHtmlClient(v.type);
                const escapedValue = escapeHtmlClient(v.currentValue);
                const escapedMutability = escapeHtmlClient(v.mutability);
                const escapedSavedValue = escapeHtmlClient(savedValue);

                html += '<tr>';
                html += '<td><span class="var-name">' + escapedName + '</span>'
                    + '<span class="mutability-badge">' + escapedMutability + '</span></td>';
                html += '<td><span class="var-type">' + escapedType + '</span></td>';
                html += '<td><span class="var-value" title="' + escapedValue + '">' + escapedValue + '</span></td>';
                html += '<td><input class="replacement-input" '
                    + 'id="replacement-' + escapedName + '" '
                    + 'placeholder="Enter new value..." '
                    + 'value="' + escapedSavedValue + '" /></td>';
                html += '</tr>';
            }

            html += '</tbody></table>';
            contentArea.innerHTML = html;
            updateButtonStates();
        }

        function showStatus(message, type) {
            const cls = type === 'error' ? 'error-banner' : 'success-banner';
            statusArea.innerHTML = '<div class="' + cls + '">' + escapeHtmlClient(message) + '</div>';
            if (type !== 'error') {
                setTimeout(() => { statusArea.innerHTML = ''; }, 5000);
            }
        }

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;

            switch (message.type) {
                case 'constantsLoaded': {
                    variables = message.variables || [];
                    const config = message.config || { enabled: false, prepareContracts: [] };
                    savedReplacements = Array.isArray(config.prepareContracts)
                        ? config.prepareContracts : [];
                    isEnabled = config.enabled === true;
                    enableToggle.checked = isEnabled;

                    if (message.error) {
                        contentArea.innerHTML = '<div class="error-banner">'
                            + escapeHtmlClient(message.error) + '</div>';
                        updateButtonStates();
                    } else {
                        renderConstants();
                    }
                    break;
                }
                case 'enabledUpdated': {
                    isEnabled = message.enabled;
                    enableToggle.checked = isEnabled;
                    updateButtonStates();
                    break;
                }
                case 'saveSuccess': {
                    showStatus('Saved ' + message.count + ' replacement(s) to recon.json', 'success');
                    break;
                }
                case 'updateSuccess': {
                    let msg = 'Applied ' + message.applied + ' replacement(s) to Setup.sol';
                    if (message.errors && message.errors.length > 0) {
                        msg += '. Warnings: ' + message.errors.join('; ');
                    }
                    showStatus(msg, message.errors && message.errors.length > 0 ? 'error' : 'success');
                    break;
                }
                case 'error': {
                    showStatus(message.message, 'error');
                    break;
                }
            }
        });
    </script>
</body>
</html>`;
    }
}
