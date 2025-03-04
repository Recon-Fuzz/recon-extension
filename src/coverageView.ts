import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getFoundryConfigPath } from './utils';
import { CoverageFile, FuzzerTool } from './types';

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
                        gap: 8px;
                        padding: 8px;
                        border-radius: 4px;
                        cursor: pointer;
                        user-select: none;
                        justify-content: space-between;
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
                </style>
            </head>
            <body>
                <div class="coverage-list">
                    ${coverageFiles.map(file => `
                        <div class="coverage-item">
                            <div class="coverage-left" onclick="selectCoverage('${file.path}')">
                                <i class="codicon codicon-file"></i>
                                <div class="coverage-info">
                                    <div class="coverage-type">${file.type === 'echidna' ? 'Echidna' : 'Medusa'}</div>
                                    <div class="coverage-date">
                                        ${file.timestamp.toLocaleString()}
                                    </div>
                                </div>
                            </div>
                            <i class="codicon codicon-link-external external-link" onclick="openExternal('${file.path}')" title="Open in browser"></i>
                        </div>
                    `).join('')}
                </div>
                <script>
                    const vscode = acquireVsCodeApi();

                    function selectCoverage(path) {
                        // Remove selection from all items
                        document.querySelectorAll('.coverage-item').forEach(item => {
                            item.classList.remove('selected');
                        });
                        
                        // Add selection to clicked item
                        event.currentTarget.closest('.coverage-item').classList.add('selected');
                        
                        vscode.postMessage({
                            type: 'selectCoverage',
                            path: path
                        });
                    }

                    function openExternal(path) {
                        vscode.postMessage({
                            type: 'openExternal',
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
