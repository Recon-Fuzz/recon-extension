import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getFoundryConfigPath } from './utils';
import { CoverageFile, FuzzerTool } from './types';
import { readCoverageFileAndProcess } from 'echidna-coverage-parser';

export class CoverageViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _filesWatcher?: vscode.FileSystemWatcher;
    private _workspaceRoot: string;

    constructor(private readonly _extensionUri: vscode.Uri) {
        if (!vscode.workspace.workspaceFolders?.[0]) {
            throw new Error('No workspace folder found');
        }
        this._workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        this.startWatchingCoverageFiles();
    }

    public async resolveWebviewView(
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
            if(webviewView.visible) {
                vscode.commands.executeCommand('recon.refreshCoverage');
            }
        });

        webviewView.webview.html = await this._getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.type) {
                case 'selectCoverage':
                    await this.enableCoverage(message.path);
                    break;
                case 'openExternal':
                    const type = message.path.includes('medusa') ? 'medusa' : 'echidna';
                    await this.openCleandReport(message.path, type);
                    break;
                case 'showCoverageStats':
                    await this.showCoverageStats(message.path);
                    break;
            }
        });
    }

    private async startWatchingCoverageFiles() {
        const foundryRoot = path.dirname(getFoundryConfigPath(this._workspaceRoot));
        
        if (this._filesWatcher) {
            this._filesWatcher.dispose();
        }

        this._filesWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(foundryRoot, '{echidna/**/covered.*.lcov,medusa/**/lcov.info}')
        );

        this._filesWatcher.onDidCreate(() => this._updateWebview());
        this._filesWatcher.onDidChange(() => this._updateWebview());
        this._filesWatcher.onDidDelete(() => this._updateWebview());
    }

    private async findCoverageFiles(): Promise<CoverageFile[]> {
        const foundryRoot = path.dirname(getFoundryConfigPath(this._workspaceRoot));
        const files: CoverageFile[] = [];

        // Check Echidna coverage files
        try {
            const echidnaDir = path.join(foundryRoot, 'echidna');
            const echidnaEntries = await fs.readdir(echidnaDir, { withFileTypes: true });
            
            for (const entry of echidnaEntries) {
                if (entry.isFile() && entry.name.startsWith('covered.') && entry.name.endsWith('.lcov')) {
                    const timestamp = new Date(parseInt(entry.name.split('.')[1]) * 1000);
                    files.push({
                        path: path.join(echidnaDir, entry.name),
                        type: FuzzerTool.ECHIDNA,
                        timestamp
                    });
                }
            }
        } catch (e) {
            // Echidna directory might not exist
        }

        // Check Medusa coverage files
        try {
            const medusaCoveragePath = path.join(foundryRoot, 'medusa', 'coverage', 'lcov.info');
            const stats = await fs.stat(medusaCoveragePath);
            files.push({
                path: medusaCoveragePath,
                type: FuzzerTool.MEDUSA,
                timestamp: stats.mtime
            });
        } catch (e) {
            // Medusa coverage might not exist
        }

        return files.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    }

    private async enableCoverage(coveragePath: string) {
        let extension = vscode.extensions.getExtension('ryanluker.vscode-coverage-gutters');
        let continueRun = false;
        if (!extension) {
            const answer = await vscode.window.showInformationMessage(
                'Coverage Gutters extension is required to display coverage. Would you like to install it?',
                'Install',
                'Cancel'
            );
            
            if (answer === 'Install') {
                await vscode.commands.executeCommand(
                    'workbench.extensions.installExtension',
                    'ryanluker.vscode-coverage-gutters'
                );
                continueRun = true;
            }
            if(!continueRun) {
                return;
            }
        }
        extension = vscode.extensions.getExtension('ryanluker.vscode-coverage-gutters');
        if(!extension) {
            return;
        }
        // If extension is not activated, activate it
        if (!extension.isActive) {
            await extension.activate();
        }

        // Remove any existing coverage
        await vscode.commands.executeCommand('coverage-gutters.removeCoverage');

        // Set the coverage file path in settings using manualCoverageFilePaths
        await vscode.workspace.getConfiguration('coverage-gutters').update(
            'manualCoverageFilePaths',
            [coveragePath],
            vscode.ConfigurationTarget.Workspace
        );

        // Display the coverage
        await vscode.commands.executeCommand('coverage-gutters.displayCoverage');
        
        // Enable watching for coverage updates
        await vscode.commands.executeCommand('coverage-gutters.watchCoverageAndVisibleEditors');
    }

    private async openCleandReport(coveragePath: string, type: 'echidna' | 'medusa'): Promise<void> {
        const dir = path.dirname(coveragePath);
        const filename = path.basename(coveragePath);
        let cleanedHtmlPath: string;

        if (type === 'medusa') {
            cleanedHtmlPath = path.join(dir, 'coverage_report-cleaned.html');
        } else {
            const timestamp = filename.split('.')[1];
            cleanedHtmlPath = path.join(dir, `covered.${timestamp}-cleaned.html`);
        }

        try {
            // Check if cleaned report exists
            await fs.access(cleanedHtmlPath);
        } catch {
            // Generate it if it doesn't exist
            const originalHtmlPath = path.join(dir, type === 'medusa' ? 'coverage_report.html' : `covered.${filename.split('.')[1]}.html`);
            
            try {
                await vscode.commands.executeCommand('recon.cleanupCoverageReport', vscode.Uri.file(originalHtmlPath));
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to clean coverage report: ${error}`);
                return;
            }
        }

        // Read the HTML content
        let content = await fs.readFile(cleanedHtmlPath, 'utf8');
        
        // Inject reset styles
        const resetStyles = `
            <style>
                html, body { background: white; color: black; padding: 8px; }
                code { all: unset; white-space: pre-wrap; font-size: 12px; font-family: monospace; display: block; background-color: #eee; }.executed { background-color: #afa; }.reverted { background-color: #ffa; }.unexecuted { background-color: #faa; }.neutral { background-color: #eee; }
                .row-source { font-family: monospace; font-size: 12px; font-weight: bold; }
                pre { margin: 0; }
            </style>
        `;

        // Insert reset styles after the first <head> tag
        content = content.replace('<head>', '<head>' + resetStyles);
        
        // Create a new webview panel with the filename as title
        const panel = vscode.window.createWebviewPanel(
            'coverageReport',
            path.basename(cleanedHtmlPath), // Use the filename as the panel title
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                enableFindWidget: true
            }
        );

        panel.webview.html = content;
    }

    private async showCoverageStats(coveragePath: string): Promise<void> {
        try {
            const content = await fs.readFile(coveragePath.replace(".lcov",".txt"), 'utf8');
            const filesData = readCoverageFileAndProcess(content, true);
            
            const panel = vscode.window.createWebviewPanel(
                'coverageStats',
                'Coverage Statistics',
                { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            panel.webview.html = `<!DOCTYPE html>
                <html>
                <head>
                    <style>
                        body { 
                            font-family: var(--vscode-font-family);
                            line-height: 1.4;
                            padding: 0;
                            margin: auto;
                            max-width: 1024px;
                        }
                        .file-header {
                            background: var(--vscode-sideBarSectionHeader-background);
                            padding: 12px;
                            position: sticky;
                            top: 0;
                            z-index: 10;
                            border-bottom: 1px solid var(--vscode-widget-border);
                            display: flex;
                            justify-content: space-between;
                            align-items: center;
                        }
                        .file-path {
                            font-weight: bold;
                            color: var(--vscode-foreground);
                        }
                        .coverage-stats {
                            display: flex;
                            gap: 16px;
                            font-size: 0.9em;
                        }
                        .stat-item {
                            display: flex;
                            align-items: center;
                            gap: 4px;
                        }
                        .stat-value {
                            font-weight: bold;
                        }
                        .functions-table {
                            width: 100%;
                            table-layout: fixed;
                            border-collapse: collapse;
                            font-size: 0.9em;
                        }
                        .functions-table th,
                        .functions-table td {
                            padding: 8px;
                            border-bottom: 1px solid var(--vscode-widget-border);
                            white-space: nowrap;
                            overflow: hidden;
                            text-overflow: ellipsis;
                        }
                        .functions-table th {
                            text-align: left;
                            background: var(--vscode-editor-background);
                            position: sticky;
                            top: 40px;
                        }
                        .functions-table th:nth-child(1) { width: auto; }    /* Function - flexible */
                        .functions-table th:nth-child(2) { width: 100px; }   /* Status - fixed */
                        .functions-table th:nth-child(3) { width: 100px; }   /* Lines - fixed */
                        
                        .untouched-code {
                            margin: 4px 0;
                            padding: 8px;
                            background: var(--vscode-textCodeBlock-background);
                            border-radius: 3px;
                            font-family: var(--vscode-editor-font-family);
                            white-space: pre;
                            font-size: 0.9em;
                            /* Reset the table cell's constraints for code blocks */
                            white-space: pre;
                            overflow: visible;
                        }
                        
                        /* Adjust position for the sticky header when there's untouched code */
                        tr:has(.untouched-code) td {
                            white-space: normal;
                            overflow: visible;
                        }

                        .function-name {
                            font-family: monospace;
                            color: var(--vscode-symbolIcon-functionForeground);
                        }
                        .status-tag {
                            display: inline-flex;
                            align-items: center;
                            padding: 2px 6px;
                            border-radius: 3px;
                            font-size: 0.85em;
                        }
                        .status-covered { background: var(--vscode-testing-iconPassed); color: white; }
                        .status-reverted { background: var(--vscode-testing-iconFailed); color: white; }
                        .status-untouched { background: var(--vscode-testing-iconSkipped); color: white; }
                        .untouched-code {
                            font-family: monospace;
                            background: rgba(255, 50, 50, 0.1);
                            border-radius: 6px;
                            padding: 8px;
                            margin: 4px 0;
                            border-radius: 3px;
                            white-space: pre;
                            font-size: 0.9em;
                        }
                        .file-section {
                            margin-bottom: 32px;
                        }
                        .file-section:last-child {
                            margin-bottom: 0;
                        }
                        .progress-bar {
                            width: 100%;
                            height: 4px;
                            background: var(--vscode-progressBar-background);
                            position: relative;
                            margin-top: 8px;
                        }
                        .progress-fill {
                            height: 100%;
                            background: var(--vscode-progressBar-foreground);
                            transition: width 0.3s ease;
                        }
                        .search-container {
                            position: sticky;
                            top: 0;
                            z-index: 20;
                            padding: 8px;
                            background: var(--vscode-editor-background);
                            border-bottom: 1px solid var(--vscode-widget-border);
                        }
                        .search-input {
                            width: 100%;
                            padding: 4px 8px;
                            font-size: 13px;
                            background: var(--vscode-input-background);
                            color: var(--vscode-input-foreground);
                            border: 1px solid var(--vscode-input-border);
                            border-radius: 2px;
                        }
                        .search-input:focus {
                            outline: 1px solid var(--vscode-focusBorder);
                            border-color: transparent;
                        }
                        .file-section.hidden,
                        tr.hidden {
                            display: none;
                        }
                        .highlight {
                            background-color: var(--vscode-editor-findMatchHighlightBackground);
                            color: var(--vscode-editor-foreground);
                        }
                        .no-results {
                            padding: 20px;
                            text-align: center;
                            color: var(--vscode-descriptionForeground);
                            font-style: italic;
                        }
                    </style>
                </head>
                <body>
                    <div class="search-container">
                        <input type="text" 
                               class="search-input" 
                               placeholder="Search contracts or functions..."
                               oninput="filterContent(this.value)">
                    </div>
                    <div id="content">
                        ${filesData.map(data => `
                            <div class="file-section" data-path="${data.path}">
                                <div class="file-header">
                                    <div class="file-path">📄 ${data.path}</div>
                                    <div class="coverage-stats">
                                        <div class="stat-item">
                                            <span>Functions:</span>
                                            <span class="stat-value">${data.coverage.functionCoveragePercentage.toFixed(1)}%</span>
                                        </div>
                                        <div class="stat-item">
                                            <span>Lines:</span>
                                            <span class="stat-value">${data.coverage.lineCoveragePercentage.toFixed(1)}%</span>
                                        </div>
                                    </div>
                                </div>
                                <table class="functions-table">
                                    <thead>
                                        <tr>
                                            <th>Function</th>
                                            <th>Status</th>
                                            <th>Lines</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${data.data.map(func => `
                                            <tr>
                                                <td class="function-name">${func.functionName}</td>
                                                <td>
                                                    ${func.isFullyCovered ? 
                                                        `<span class="status-tag status-covered">✓ Covered</span>` :
                                                        `${func.touched ? 
                                                            `<span class="status-tag status-reverted">⚠ Reverted</span>` : 
                                                            `<span class="status-tag status-untouched">✗ Untouched</span>`
                                                        }`
                                                    }
                                                </td>
                                                <td>${func.untouchedLines > 0 ? 
                                                    `${func.untouchedLines} untouched` : 
                                                    'All covered'
                                                }</td>
                                            </tr>
                                            ${func.untouchedContent.length > 0 ? `
                                                <tr>
                                                    <td colspan="3">
                                                        <pre class="untouched-code">${func.untouchedContent.join('\n')}</pre>
                                                    </td>
                                                </tr>
                                            ` : ''}
                                        `).join('')}
                                    </tbody>
                                </table>
                            </div>
                        `).join('')}
                    </div>
                    <div id="no-results" class="no-results hidden">
                        No matching contracts or functions found
                    </div>
                    <script>
                        function fuzzyMatch(text, search) {
                            search = search.toLowerCase();
                            text = text.toLowerCase();
                            
                            if (text.includes(search)) {
                                const index = text.indexOf(search);
                                return {
                                    matched: true,
                                    score: index,
                                    highlighted: text.slice(0, index) +
                                        '<span class="highlight">' +
                                        text.slice(index, index + search.length) +
                                        '</span>' +
                                        text.slice(index + search.length)
                                };
                            }
                            
                            let searchIdx = 0;
                            let score = 0;
                            const matchIndexes = [];
                            
                            for (let i = 0; i < text.length && searchIdx < search.length; i++) {
                                if (text[i] === search[searchIdx]) {
                                    matchIndexes.push(i);
                                    score += i;
                                    searchIdx++;
                                }
                            }
                            
                            if (searchIdx === search.length) {
                                let highlighted = '';
                                let lastIdx = 0;
                                
                                matchIndexes.forEach(idx => {
                                    highlighted += text.slice(lastIdx, idx);
                                    highlighted += '<span class="highlight">' + text[idx] + '</span>';
                                    lastIdx = idx + 1;
                                });
                                highlighted += text.slice(lastIdx);
                                
                                return { matched: true, score, highlighted };
                            }
                            
                            return { matched: false, score: Infinity, highlighted: text };
                        }

                        function filterContent(query) {
                            if (!query) {
                                // Reset everything if query is empty
                                document.querySelectorAll('.file-section').forEach(section => {
                                    section.classList.remove('hidden');
                                    section.querySelectorAll('tr').forEach(row => {
                                        row.classList.remove('hidden');
                                        // Reset highlights
                                        const funcName = row.querySelector('.function-name');
                                        if (funcName) {
                                            funcName.textContent = funcName.textContent;
                                        }
                                    });
                                });
                                document.getElementById('no-results').classList.add('hidden');
                                return;
                            }

                            let hasVisibleContent = false;

                            document.querySelectorAll('.file-section').forEach(section => {
                                const path = section.dataset.path;
                                const pathMatch = fuzzyMatch(path, query);
                                let sectionHasMatch = pathMatch.matched;
                                
                                // Update file path if there's a match
                                if (pathMatch.matched) {
                                    const pathElement = section.querySelector('.file-path');
                                    if (pathElement) {
                                        pathElement.innerHTML = '📄 ' + pathMatch.highlighted;
                                    }
                                }

                                // Search through functions
                                section.querySelectorAll('tr').forEach(row => {
                                    const funcName = row.querySelector('.function-name');
                                    if (funcName) {
                                        const funcMatch = fuzzyMatch(funcName.textContent || '', query);
                                        if (funcMatch.matched) {
                                            sectionHasMatch = true;
                                            row.classList.remove('hidden');
                                            funcName.innerHTML = funcMatch.highlighted;
                                            // Show the next row if it contains untouched lines
                                            const nextRow = row.nextElementSibling;
                                            if (nextRow && nextRow.querySelector('.untouched-code')) {
                                                nextRow.classList.remove('hidden');
                                            }
                                        } else {
                                            row.classList.add('hidden');
                                            // Hide the next row if it contains untouched lines
                                            const nextRow = row.nextElementSibling;
                                            if (nextRow && nextRow.querySelector('.untouched-code')) {
                                                nextRow.classList.add('hidden');
                                            }
                                        }
                                    }
                                });

                                if (sectionHasMatch) {
                                    section.classList.remove('hidden');
                                    hasVisibleContent = true;
                                } else {
                                    section.classList.add('hidden');
                                }
                            });

                            // Show/hide no results message
                            const noResults = document.getElementById('no-results');
                            if (hasVisibleContent) {
                                noResults.classList.add('hidden');
                            } else {
                                noResults.classList.remove('hidden');
                            }
                        }
                    </script>
                </body>
                </html>`;
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load coverage stats: ${error}`);
        }
    }

    public async _updateWebview() {
        if (this._view) {
            this._view.webview.html = await this._getHtmlForWebview();
        }
    }

    private async _getHtmlForWebview(): Promise<string> {
        const toolkitUri = this._view?.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/webview-ui-toolkit', 'dist', 'toolkit.min.js')
        );

        const codiconsUri = this._view?.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
        );

        const coverageFiles = await this.findCoverageFiles();

        return `<!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width,initial-scale=1.0">
                <script type="module" src="${toolkitUri}"></script>
                <link href="${codiconsUri}" rel="stylesheet" />
                <style>
                    body {
                        padding: 0;
                        color: var(--vscode-foreground);
                        font-family: var(--vscode-font-family);
                        font-size: var(--vscode-font-size);
                    }
                    .coverage-list {
                        display: flex;
                        flex-direction: column;
                        gap: 8px;
                        padding: 8px;
                    }
                    .coverage-item {
                        display: flex;
                        align-items: center;
                        padding: 8px;
                        border-radius: 4px;
                        cursor: pointer;
                    }
                    .coverage-item:hover {
                        background: var(--vscode-list-hoverBackground);
                    }
                    .coverage-item.selected {
                        background: var(--vscode-list-activeSelectionBackground);
                        color: var(--vscode-list-activeSelectionForeground);
                    }
                    .coverage-info {
                        flex: 1;
                    }
                    .coverage-type {
                        font-size: 0.9em;
                        opacity: 0.8;
                    }
                    .coverage-date {
                        font-size: 0.8em;
                        opacity: 0.7;
                    }
                    .coverage-left {
                        display: flex;
                        flex: 1;
                        align-items: center;
                        gap: 8px;
                    }
                    .external-link {
                        opacity: 0.6;
                        cursor: pointer;
                    }
                    .external-link:hover {
                        opacity: 1;
                    }
                    .coverage-actions {
                        display: flex;
                        gap: 8px;
                        align-items: center;
                        margin-left: auto; /* Push to the right */
                        padding: 0 4px;
                    }
                    .coverage-stats,
                    .external-link {
                        opacity: 0.6;
                        cursor: pointer;
                        padding: 4px;
                        border-radius: 3px;
                    }
                    .coverage-stats:hover,
                    .external-link:hover {
                        opacity: 1;
                        background: var(--vscode-toolbar-hoverBackground);
                    }
                </style>
            </head>
            <body>
                <div class="coverage-list">
                    ${coverageFiles.map(file => `
                        <div class="coverage-item">
                            <div class="coverage-left">
                                <i class="codicon codicon-file"></i>
                                <div class="coverage-info">
                                    <div class="coverage-type">${file.type === FuzzerTool.ECHIDNA ? 'Echidna' : 'Medusa'}</div>
                                    <div class="coverage-date">
                                        ${file.timestamp.toLocaleString()}
                                    </div>
                                </div>
                            </div>
                            <div class="coverage-actions">
                                ${file.type === FuzzerTool.ECHIDNA ? `
                                    <i class="codicon codicon-checklist coverage-stats" onclick="showCoverageStats('${file.path}')" title="Coverage Stats"></i>
                                ` : ''}
                                <i class="codicon codicon-link-external external-link" onclick="openExternal('${file.path}')" title="Open in browser"></i>
                            </div>
                        </div>
                    `).join('')}
                </div>
                <script>
                    const vscode = acquireVsCodeApi();

                    document.querySelectorAll('.coverage-item').forEach(item => {
                        item.addEventListener('click', function(event) {
                            // Only handle clicks on the item itself or the left side, not the actions
                            if (!event.target.closest('.coverage-actions')) {
                                document.querySelectorAll('.coverage-item').forEach(i => 
                                    i.classList.remove('selected'));
                                this.classList.add('selected');
                                const path = this.querySelector('.coverage-actions').lastElementChild.getAttribute('onclick').match(/'([^']+)'/)[1];
                                selectCoverage(path);
                            }
                        });
                    });

                    function selectCoverage(path) {
                        vscode.postMessage({
                            type: 'selectCoverage',
                            path: path
                        });
                    }

                    function openExternal(path) {
                        event.stopPropagation();
                        vscode.postMessage({
                            type: 'openExternal',
                            path: path
                        });
                    }

                    function showCoverageStats(path) {
                        event.stopPropagation();
                        vscode.postMessage({
                            type: 'showCoverageStats',
                            path: path
                        });
                    }
                </script>
            </body>
            </html>`;
    }

    dispose() {
        this._filesWatcher?.dispose();
    }
}
