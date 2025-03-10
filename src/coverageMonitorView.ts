import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as parser from '@solidity-parser/parser';
import { getFoundryConfigPath, shouldExclude } from './utils';
import { ContractCoverage, FunctionLocation } from './types';

interface CoverageEntry {
    line: number;
    revert: number;
    success: number;
}

interface CoverageState {
    [file: string]: CoverageEntry[];
}

export class CoverageMonitorProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'recon-coverage-monitor';
    private _view?: vscode.WebviewView | vscode.WebviewPanel;
    private _watcher?: vscode.FileSystemWatcher;
    private _lastCoverage: CoverageState = {};
    private _functionLocations: Map<string, FunctionLocation[]> = new Map();

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) {
        this.startWatching();
    }

    private startWatching() {
        if (vscode.workspace.workspaceFolders) {
            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const foundryRoot = path.dirname(getFoundryConfigPath(workspaceRoot));
            const coveragePath = path.join(foundryRoot, 'medusa/coverage/coverage.json');

            this._watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(foundryRoot, 'medusa/coverage/coverage.json')
            );

            this._watcher.onDidChange(async () => {
                await this.updateCoverage(coveragePath);
            });

            this._watcher.onDidCreate(async () => {
                await this.updateCoverage(coveragePath);
            });
        }
    }

    private async loadContractASTs(): Promise<void> {
        if (!vscode.workspace.workspaceFolders) { return; }

        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const foundryRoot = path.dirname(getFoundryConfigPath(workspaceRoot));
        const combinedJsonPath = path.join(foundryRoot, 'crytic-export/combined_solc.json');

        try {
            const content = await fs.promises.readFile(combinedJsonPath, 'utf8');
            const combined = JSON.parse(content);

            for (const [filePath,] of Object.entries(combined.sources)) {
                const relativePath = path.relative(foundryRoot, filePath);
                if (shouldExclude(relativePath) && !filePath.includes('/recon/')) {
                    continue;
                }
                const functions: FunctionLocation[] = [];

                try {
                    const ast = parser.parse(await fs.promises.readFile(filePath, 'utf8'), { loc: true, range: true });
                    parser.visit(ast, {
                        FunctionDefinition: (node) => {
                            if (node.stateMutability !== 'view' && node.stateMutability !== 'pure') {
                                functions.push({
                                    name: node.name!,
                                    startLine: (node.loc?.start.line || 0) + 1,
                                    endLine: (node.loc?.end.line || 0) - 1,
                                    stateMutability: node.stateMutability!
                                });
                            }
                        }
                    });

                    if (functions.length > 0) {
                        this._functionLocations.set(filePath, functions);
                    }
                } catch (e) {
                    console.error(`Error parsing AST for ${filePath}:`, e);
                }
            }
        } catch (e) {
            console.error('Error loading combined_solc.json:', e);
        }
    }

    private calculateFunctionCoverage(file: string, entries: CoverageEntry[]): ContractCoverage {
        const functions = this._functionLocations.get(file) || [];
        // Read the file content to check for lines with only braces
        let fileContent: string[] = [];
        try {
            fileContent = fs.readFileSync(file, 'utf8').split('\n');
        } catch (e) {
            console.error(`Error reading file ${file}:`, e);
        }

        // Filter out lines that only contain curly braces and filter for successful executions
        const coveredLines = new Set(entries
            .filter(e => {
                const line = fileContent[e.line - 1];
                return e.success > 0 && (!line || line.trim() !== '{' && line.trim() !== '}');
            })
            .map(e => e.line));

        const functionsCoverage = functions.map(fn => {
            let coveredCount = 0;
            for (let line = fn.startLine; line <= fn.endLine; line++) {
                if (coveredLines.has(line)) {
                    coveredCount++;
                }
            }

            const totalLines = fn.endLine - fn.startLine + 1;
            return {
                name: fn.name,
                location: fn,
                coverage: {
                    coveredLines: coveredCount,
                    totalLines,
                    percentage: (coveredCount / totalLines) * 100
                }
            };
        });

        return {
            path: file,
            functions: functionsCoverage
        };
    }

    private async updateCoverage(coveragePath: string) {
        try {
            await this.loadContractASTs();
            const content = await fs.promises.readFile(coveragePath, 'utf8');
            const newCoverage: CoverageState = JSON.parse(content);

            if (this._view) {
                const changes = this.detectChanges(this._lastCoverage, newCoverage);
                this._lastCoverage = newCoverage;

                const contractsCoverage: ContractCoverage[] = Object.entries(newCoverage)
                    .filter(([file]) => this._functionLocations.has(file))
                    .map(([file, entries]) => ({
                        ...this.calculateFunctionCoverage(file, entries),
                        changed: changes.includes(file)
                    }));

                this._view.webview.postMessage({
                    type: 'update',
                    coverage: contractsCoverage
                });
            }
        } catch (error) {
            console.error('Error reading coverage:', error);
        }
    }

    private detectChanges(old: CoverageState, new_: CoverageState): string[] {
        const changes: string[] = [];

        // Check all files in new coverage
        for (const [file, entries] of Object.entries(new_)) {
            if (!old[file]) {
                changes.push(file);
                continue;
            }

            // Compare entries
            const oldEntries = old[file];
            if (JSON.stringify(entries) !== JSON.stringify(oldEntries)) {
                changes.push(file);
            }
        }

        return changes;
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

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Initial coverage load
        if (vscode.workspace.workspaceFolders) {
            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const foundryRoot = path.dirname(getFoundryConfigPath(workspaceRoot));
            const coveragePath = path.join(foundryRoot, 'medusa/coverage/coverage.json');

            if (fs.existsSync(coveragePath)) {
                this.updateCoverage(coveragePath);
            }
        }
    }

    public resolveWebviewPanel(
        panel: vscode.WebviewPanel,
    ) {
        this._view = panel;
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        panel.webview.html = this._getHtmlForWebview(panel.webview);

        // Initial coverage load
        if (vscode.workspace.workspaceFolders) {
            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const foundryRoot = path.dirname(getFoundryConfigPath(workspaceRoot));
            const coveragePath = path.join(foundryRoot, 'medusa/coverage/coverage.json');

            if (fs.existsSync(coveragePath)) {
                this.updateCoverage(coveragePath);
            }
        }

        // Clean up when panel is closed
        panel.onDidDispose(() => {
            if (this._view === panel) {
                this._view = undefined;
            }
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css'));
        const toolkitUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/webview-ui-toolkit', 'dist', 'toolkit.min.js'));

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link href="${codiconsUri}" rel="stylesheet" />
            <script type="module" src="${toolkitUri}"></script>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    color: var(--vscode-foreground);
                    padding: 10px;
                }
                .file-entry {
                    margin-bottom: 20px;
                    border-radius: 6px;
                    background: var(--vscode-editor-background);
                    overflow: hidden;
                    position: relative;
                }
                .file-header {
                    padding: 10px;
                    background: var(--vscode-sideBarSectionHeader-background);
                    font-weight: bold;
                    font-size: 12px;
                }
                .coverage-entry {
                    padding: 8px 10px;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    position: relative;
                }
                .line-number {
                    min-width: 40px;
                    color: var(--vscode-descriptionForeground);
                }
                .stats {
                    display: flex;
                    gap: 15px;
                    font-size: 12px;
                }
                .stat {
                    display: flex;
                    align-items: center;
                    gap: 5px;
                }
                .success { color: #4EC9B0; }
                .revert { color: #D16969; }
                
                @keyframes ripple {
                    0% {
                        box-shadow: 0 0 0 0 rgba(92, 37, 210, 0.3);
                    }
                    100% {
                        box-shadow: 0 0 0 20px rgba(92, 37, 210, 0);
                    }
                }
                .file-entry.changed {
                    animation: ripple 1s cubic-bezier(0, 0, 0.2, 1);
                }
                .function-entry {
                    padding: 8px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .function-name {
                    font-weight: bold;
                    margin-bottom: 4px;
                }
                .coverage-bar {
                    height: 4px;
                    background: var(--vscode-panel-border);
                    border-radius: 2px;
                    overflow: hidden;
                }
                .coverage-fill {
                    height: 100%;
                    background: #4EC9B0;
                    transition: width 0.3s ease;
                }
                .coverage-stats {
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    margin-top: 4px;
                }
                @keyframes highlight {
                    0% { background-color: rgba(78, 201, 176, 0.3); }
                    100% { background-color: transparent; }
                }
                .highlight {
                    animation: highlight 1s ease;
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
                .search-icon {
                    position: absolute;
                    right: 10px;
                    opacity: 0.6;
                }
                .no-results {
                    padding: 16px;
                    text-align: center;
                    color: var(--vscode-descriptionForeground);
                    font-style: italic;
                }
                .hidden {
                    display: none !important;
                }
                .highlight {
                    color: var(--vscode-textLink-foreground);
                    font-weight: bold;
                }
            </style>
        </head>
        <body>
            <div class="search-container">
                <vscode-text-field
                    id="search-input"
                    placeholder="Search coverage"
                    oninput="filterCoverage(this.value)"
                >
                    <span slot="end" class="codicon codicon-search"></span>
                </vscode-text-field>
            </div>
            <div id="coverage-container"></div>
            <div id="no-results" class="no-results hidden">
                No files found matching "<span id="search-term"></span>"
            </div>
            
            <script>
                const vscode = acquireVsCodeApi();
                let lastState = {};
                let currentCoverage = [];
                
                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.type === 'update') {
                        currentCoverage = message.coverage;
                        const searchInput = document.getElementById('search-input');
                        updateCoverage(currentCoverage, searchInput.value);
                    }
                });

                function fuzzyMatch(text, search) {
                    if (!search || search.trim() === '') {
                        return { match: true, score: 0, highlighted: text };
                    }
                    
                    search = search.toLowerCase();
                    const textLower = text.toLowerCase();
                    
                    if (textLower.includes(search)) {
                        const index = textLower.indexOf(search);
                        const highlighted = text.substring(0, index) +
                            '<span class="highlight">' + text.substring(index, index + search.length) + '</span>' +
                            text.substring(index + search.length);
                        return { match: true, score: 0, highlighted };
                    }
                    
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

                function filterCoverage(query) {
                    updateCoverage(currentCoverage, query);
                }
                
                function updateCoverage(coverage, searchQuery = '') {
                    const container = document.getElementById('coverage-container');
                    const noResults = document.getElementById('no-results');
                    const searchTerm = document.getElementById('search-term');
                    
                    container.innerHTML = '';
                    searchTerm.textContent = searchQuery;
                    
                    let visibleCount = 0;
                    
                    coverage.forEach(contract => {
                        const filePath = contract.path;
                        const fileMatch = fuzzyMatch(filePath, searchQuery);
                        
                        if (!searchQuery || fileMatch.match) {
                            visibleCount++;
                            const fileDiv = document.createElement('div');
                            fileDiv.className = 'file-entry' + (contract.changed ? ' changed' : '');
                            
                            const header = document.createElement('div');
                            header.className = 'file-header';
                            header.innerHTML = fileMatch.highlighted; // Use full path instead of just filename
                            fileDiv.appendChild(header);
                            
                            contract.functions.forEach(fn => {
                                const functionDiv = document.createElement('div');
                                functionDiv.className = 'function-entry';
                                
                                const nameDiv = document.createElement('div');
                                nameDiv.className = 'function-name';
                                const functionMatch = fuzzyMatch(fn.name, searchQuery);
                                nameDiv.innerHTML = functionMatch.highlighted;
                                
                                const barDiv = document.createElement('div');
                                barDiv.className = 'coverage-bar';
                                
                                const fillDiv = document.createElement('div');
                                fillDiv.className = 'coverage-fill';
                                fillDiv.style.width = Math.round(fn.coverage.percentage) + '%';
                                
                                const statsDiv = document.createElement('div');
                                statsDiv.className = 'coverage-stats';
                                statsDiv.textContent = \`\${fn.coverage.coveredLines}/\${fn.coverage.totalLines} lines (\${Math.round(fn.coverage.percentage)}%)\`;
                                
                                barDiv.appendChild(fillDiv);
                                functionDiv.appendChild(nameDiv);
                                functionDiv.appendChild(barDiv);
                                functionDiv.appendChild(statsDiv);
                                
                                if (lastState[contract.path]?.[fn.name] !== fn.coverage.percentage) {
                                    functionDiv.classList.add('highlight');
                                }
                                
                                fileDiv.appendChild(functionDiv);
                            });
                            
                            container.appendChild(fileDiv);
                        }
                    });
                    
                    // Show/hide no results message
                    if (visibleCount === 0 && searchQuery) {
                        noResults.classList.remove('hidden');
                        container.classList.add('hidden');
                    } else {
                        noResults.classList.add('hidden');
                        container.classList.remove('hidden');
                    }
                    
                    // Update last state
                    coverage.forEach(contract => {
                        lastState[contract.path] = {};
                        contract.functions.forEach(fn => {
                            lastState[contract.path][fn.name] = fn.coverage.percentage;
                        });
                    });
                }
            </script>
        </body>
        </html>`;
    }

    public dispose() {
        this._watcher?.dispose();
    }
}
