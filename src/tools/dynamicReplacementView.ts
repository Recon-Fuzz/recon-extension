import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as $ from 'solc-typed-ast';
import { findOutputDirectory, getFoundryConfigPath } from '../utils';

export interface ConstantInfo {
    name: string;
    type: string;
    currentValue: string;
    lineNumber: number;
    source: string;
}

export interface DynamicReplacement {
    target: string;
    replacement: string;
    endOfTargetMarker: string;
    targetContract: string;
}

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
            switch (message.type) {
                case 'loadConstants':
                    try {
                        const constants = await this.loadConstantsFromSetup();
                        // Load existing replacements from recon.json to populate values
                        const existingReplacements = await this.loadReplacementsFromReconJson();
                        await panel.webview.postMessage({
                            type: 'constantsLoaded',
                            constants,
                            existingReplacements,
                        });
                    } catch (error) {
                        const errorMessage =
                            error instanceof Error ? error.message : 'Unknown error occurred';
                        vscode.window.showErrorMessage(
                            `Error loading constants: ${errorMessage}`
                        );
                        await panel.webview.postMessage({
                            type: 'error',
                            message: errorMessage,
                        });
                    }
                    break;
                case 'saveReplacements':
                    try {
                        await this.saveReplacementsToReconJson(message.replacements);
                        vscode.window.showInformationMessage('Dynamic replacements saved successfully');
                        await panel.webview.postMessage({
                            type: 'replacementsSaved',
                        });
                    } catch (error) {
                        const errorMessage =
                            error instanceof Error ? error.message : 'Unknown error occurred';
                        vscode.window.showErrorMessage(
                            `Error saving replacements: ${errorMessage}`
                        );
                    }
                    break;
                case 'updateSetupFile':
                    try {
                        // Load replacements from recon.json (in case user manually edited it)
                        const replacementsFromJson = await this.loadReplacementsFromReconJson();
                        // Use replacements from recon.json if available, otherwise use UI replacements
                        const replacementsToUse = replacementsFromJson.length > 0 
                            ? replacementsFromJson 
                            : message.replacements;
                        await this.updateSetupFile(replacementsToUse);
                        // Also save to recon.json (merge with existing)
                        await this.saveReplacementsToReconJson(replacementsToUse);
                        vscode.window.showInformationMessage('Setup.sol updated and saved to recon.json');
                        await panel.webview.postMessage({
                            type: 'setupFileUpdated',
                        });
                    } catch (error) {
                        const errorMessage =
                            error instanceof Error ? error.message : 'Unknown error occurred';
                        vscode.window.showErrorMessage(
                            `Error updating Setup.sol: ${errorMessage}`
                        );
                    }
                    break;
                case 'showWarning':
                    vscode.window.showWarningMessage(message.text);
                    break;
            }
        });

        panel.webview.html = this._getHtmlForWebview(panel.webview);
        return panel;
    }

    private async findSetupFile(): Promise<string> {
        if (!vscode.workspace.workspaceFolders) {
            throw new Error('No workspace folder found');
        }

        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const foundryConfigPath = getFoundryConfigPath(workspaceRoot);
        const foundryRoot = path.dirname(foundryConfigPath);

        // Common paths for Setup.sol
        const possiblePaths = [
            path.join(foundryRoot, 'test', 'recon', 'Setup.sol'),
            path.join(foundryRoot, 'test', 'Setup.sol'),
            path.join(foundryRoot, 'tests', 'recon', 'Setup.sol'),
            path.join(foundryRoot, 'src', 'test', 'recon', 'Setup.sol'),
        ];

        for (const setupPath of possiblePaths) {
            try {
                await fs.access(setupPath);
                return setupPath;
            } catch {
                continue;
            }
        }

        throw new Error('Setup.sol not found. Please ensure Setup.sol exists in test/recon/ directory');
    }

    private async loadReplacementsFromReconJson(): Promise<DynamicReplacement[]> {
        if (!vscode.workspace.workspaceFolders) {
            return [];
        }

        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const reconJsonPath = path.join(workspaceRoot, 'recon.json');

        try {
            const content = await fs.readFile(reconJsonPath, 'utf8');
            const reconJson = JSON.parse(content);

            if (!reconJson.prepareContracts || !Array.isArray(reconJson.prepareContracts)) {
                return [];
            }

            return reconJson.prepareContracts as DynamicReplacement[];
        } catch {
            // File doesn't exist or invalid JSON, return empty array
            return [];
        }
    }

    private async loadConstantsFromSetup(): Promise<ConstantInfo[]> {
        const setupPath = await this.findSetupFile();
        const setupContent = await fs.readFile(setupPath, 'utf8');

        // Try to parse using compiler output first
        try {
            const workspaceRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;
            const outDir = await findOutputDirectory(workspaceRoot);
            const constants = await this.parseConstantsFromCompilerOutput(setupPath, outDir);
            if (constants.length > 0) {
                return constants;
            }
        } catch (error) {
            console.warn('Could not parse from compiler output, using regex fallback:', error);
        }

        // Fallback to regex parsing
        return this.parseConstantsWithRegex(setupContent, setupPath);
    }

    private async parseConstantsFromCompilerOutput(
        setupPath: string,
        outDir: string
    ): Promise<ConstantInfo[]> {
        try {
            // Find the compiled JSON for Setup.sol
            const setupFileName = path.basename(setupPath, '.sol');
            const possibleJsonPaths = [
                path.join(outDir, setupFileName, `${setupFileName}.json`),
                path.join(outDir, 'Setup.sol', 'Setup.json'),
            ];

            let compilerOutput: any = null;
            for (const jsonPath of possibleJsonPaths) {
                try {
                    const content = await fs.readFile(jsonPath, 'utf8');
                    compilerOutput = JSON.parse(content);
                    break;
                } catch {
                    continue;
                }
            }

            if (!compilerOutput || !compilerOutput.metadata) {
                return [];
            }

            // Parse metadata to get AST
            const metadata = typeof compilerOutput.metadata === 'string'
                ? JSON.parse(compilerOutput.metadata)
                : compilerOutput.metadata;

            if (!metadata.sources || !metadata.sources[setupPath]) {
                return [];
            }

            // Use solc-typed-ast to parse
            const asts = new $.ASTReader().read(metadata.sources);
            const constants: ConstantInfo[] = [];

            for (const ast of asts) {
                for (const contract of ast.getChildrenByType($.ContractDefinition)) {
                    if (contract.name !== 'Setup') {
                        continue;
                    }

                    const allVars = contract.getChildrenByType($.VariableDeclaration);
                    for (const variable of allVars) {
                        if (
                            variable.constant ||
                            variable.mutability === $.Mutability.Constant ||
                            variable.mutability === $.Mutability.Immutable
                        ) {
                            const source = this.getSourceFromAST(variable);
                            const value = this.extractValueFromSource(source, variable.name || '');

                            constants.push({
                                name: variable.name || '',
                                type: variable.typeString || 'unknown',
                                currentValue: value,
                                lineNumber: variable.src?.split(':')[0] ? parseInt(variable.src.split(':')[0]) : 0,
                                source: source,
                            });
                        }
                    }
                }
            }

            return constants;
        } catch (error) {
            console.error('Error parsing constants from compiler output:', error);
            return [];
        }
    }

    private getSourceFromAST(variable: $.VariableDeclaration): string {
        // Try to get source from AST
        if (variable.src) {
            // src format: "start:length:fileIndex"
            // We'd need the source file to extract, but for now use a fallback
            return '';
        }
        return '';
    }

    private extractValueFromSource(source: string, name: string): string {
        // Extract value from source code
        const match = source.match(new RegExp(`${name}\\s*=\\s*([^;]+);`));
        return match ? match[1].trim() : '';
    }

    private parseConstantsWithRegex(content: string, filePath: string): ConstantInfo[] {
        const constants: ConstantInfo[] = [];
        const lines = content.split('\n');

        // Pattern to match constant declarations only
        // Matches: constant TYPE NAME = VALUE; or TYPE constant NAME = VALUE;
        // Also handles public/private/internal/external modifiers
        // REQUIRES the constant keyword to be present
        const constantPattern = /(?:public\s+|private\s+|internal\s+|external\s+)?(?:constant\s+(\w+(?:\s*\[\s*\])?)\s+(\w+)|(\w+(?:\s*\[\s*\])?)\s+constant\s+(\w+))\s*=\s*([^;]+);/g;

        let match;
        while ((match = constantPattern.exec(content)) !== null) {
            const fullMatch = match[0];
            // Match group 1,2 for "constant TYPE NAME" or 3,4 for "TYPE constant NAME"
            const type = (match[1] || match[3] || '').trim();
            const name = (match[2] || match[4] || '').trim();
            const value = (match[5] || '').trim();

            // Find line number
            const lineNumber = content.substring(0, match.index).split('\n').length;

            // Skip if it's a function parameter or local variable (check context)
            const beforeMatch = content.substring(Math.max(0, match.index - 50), match.index);
            if (beforeMatch.includes('function') || beforeMatch.includes('(')) {
                continue;
            }

            constants.push({
                name,
                type,
                currentValue: value,
                lineNumber,
                source: fullMatch,
            });
        }

        // Also match immutable variables
        const immutablePattern = /(?:public\s+|private\s+|internal\s+)?(\w+(?:\s*\[\s*\])?)\s+immutable\s+(\w+)\s*=\s*([^;]+);/g;
        while ((match = immutablePattern.exec(content)) !== null) {
            const fullMatch = match[0];
            const type = match[1].trim();
            const name = match[2].trim();
            const value = match[3].trim();

            const lineNumber = content.substring(0, match.index).split('\n').length;

            constants.push({
                name,
                type,
                currentValue: value,
                lineNumber,
                source: fullMatch,
            });
        }

        // Remove duplicates (same name)
        const uniqueConstants = new Map<string, ConstantInfo>();
        for (const constant of constants) {
            if (!uniqueConstants.has(constant.name)) {
                uniqueConstants.set(constant.name, constant);
            }
        }

        return Array.from(uniqueConstants.values());
    }

    private async saveReplacementsToReconJson(
        replacements: DynamicReplacement[]
    ): Promise<void> {
        if (!vscode.workspace.workspaceFolders) {
            throw new Error('No workspace folder found');
        }

        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const reconJsonPath = path.join(workspaceRoot, 'recon.json');

        let reconJson: any = {};
        try {
            const content = await fs.readFile(reconJsonPath, 'utf8');
            reconJson = JSON.parse(content);
        } catch {
            // File doesn't exist, create new
        }

        // The format should match the runner's expected format
        // Based on the issue description, prepareContracts is an array
        if (!reconJson.prepareContracts || !Array.isArray(reconJson.prepareContracts)) {
            reconJson.prepareContracts = [];
        }

        // Merge with existing replacements (avoid duplicates)
        const existingTargets = new Set(
            reconJson.prepareContracts.map((r: DynamicReplacement) => r.target)
        );

        // Add new replacements, update existing ones
        for (const replacement of replacements) {
            const existingIndex = reconJson.prepareContracts.findIndex(
                (r: DynamicReplacement) => r.target === replacement.target
            );

            const replacementData = {
                target: replacement.target,
                replacement: replacement.replacement,
                endOfTargetMarker: replacement.endOfTargetMarker || '[^;]*',
                targetContract: replacement.targetContract || 'Setup.sol',
            };

            if (existingIndex >= 0) {
                reconJson.prepareContracts[existingIndex] = replacementData;
            } else {
                reconJson.prepareContracts.push(replacementData);
            }
        }

        await fs.writeFile(reconJsonPath, JSON.stringify(reconJson, null, 2));
    }

    private async updateSetupFile(replacements: DynamicReplacement[]): Promise<void> {
        const setupPath = await this.findSetupFile();
        let content = await fs.readFile(setupPath, 'utf8');

        // Apply replacements to the file
        // Sort by last occurrence in file (process from end to beginning) to prevent index issues
        const sortedReplacements = [...replacements].sort((a, b) => {
            const aIndex = content.lastIndexOf(a.target);
            const bIndex = content.lastIndexOf(b.target);
            return bIndex - aIndex; // Process from end to beginning
        });

        for (const replacement of sortedReplacements) {
            // Escape special regex characters in target
            const escapedTarget = replacement.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Build the full pattern with end marker (no global flag - replace one at a time)
            const fullPattern = escapedTarget + (replacement.endOfTargetMarker || '[^;]*');
            const regex = new RegExp(fullPattern);
            
            // Escape special regex characters in replacement too (but keep backreferences)
            const escapedReplacement = replacement.replacement.replace(/\$/g, '$$$$');
            
            // Replace only the first occurrence at the sorted position
            content = content.replace(regex, escapedReplacement);
        }

        await fs.writeFile(setupPath, content, 'utf8');
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const toolkitUri = webview.asWebviewUri(
            vscode.Uri.joinPath(
                this._extensionUri,
                'node_modules',
                '@vscode/webview-ui-toolkit',
                'dist',
                'toolkit.min.js'
            )
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <script type="module" src="${toolkitUri}"></script>
    <style>
        body {
            padding: 20px;
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
        }
        .header {
            margin-bottom: 20px;
        }
        .constants-list {
            margin-top: 20px;
        }
        .constant-item {
            margin-bottom: 15px;
            padding: 10px;
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
        }
        .constant-name {
            font-weight: bold;
            margin-bottom: 5px;
        }
        .constant-type {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 5px;
        }
        .constant-value {
            margin-top: 5px;
        }
        vscode-text-field {
            width: 100%;
            margin-top: 5px;
        }
        .actions {
            margin-top: 20px;
            display: flex;
            gap: 10px;
        }
        .info {
            padding: 10px;
            background: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-textBlockQuote-border);
            margin-bottom: 20px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h2>Dynamic Replacement</h2>
        <div class="info">
            This panel allows you to replace constants in Setup.sol before running fuzzing tools.
            Changes are saved to recon.json and applied to Setup.sol automatically.
        </div>
    </div>
    <div id="constants-container">
        <p>Loading constants from Setup.sol...</p>
    </div>
    <div class="actions">
        <vscode-button id="save-btn" appearance="primary">Save Replacements</vscode-button>
        <vscode-button id="update-file-btn" appearance="secondary">Update Setup.sol</vscode-button>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        let constants = [];
        let replacements = {};

        // Load constants on page load
        vscode.postMessage({ type: 'loadConstants' });

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'constantsLoaded':
                    constants = message.constants;
                    // Load existing replacements from recon.json to populate values
                    if (message.existingReplacements) {
                        const replacementMap = {};
                        message.existingReplacements.forEach(r => {
                            // Extract constant name from target pattern (e.g., "name = value" -> "name")
                            const match = r.target.match(/^(\w+)\s*=/);
                            if (match) {
                                replacementMap[match[1]] = r.replacement.match(/=\s*(.+)$/)?.[1] || '';
                            }
                        });
                        // Update constants with values from recon.json
                        constants = constants.map(c => {
                            if (replacementMap[c.name]) {
                                return { ...c, currentValue: replacementMap[c.name] };
                            }
                            return c;
                        });
                    }
                    renderConstants();
                    break;
                case 'error':
                    const container = document.getElementById('constants-container');
                    container.innerHTML = \`<p style="color: var(--vscode-errorForeground);">\${escapeHtml(message.message)}</p>\`;
                    break;
                case 'replacementsSaved':
                    vscode.postMessage({ type: 'showInfo', text: 'Replacements saved successfully' });
                    break;
                case 'setupFileUpdated':
                    vscode.postMessage({ type: 'showInfo', text: 'Setup.sol updated successfully' });
                    break;
            }
        });

        function escapeHtml(str) {
            if (!str) return '';
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }

        function renderConstants() {
            const container = document.getElementById('constants-container');
            if (constants.length === 0) {
                container.innerHTML = '<p>No constants found in Setup.sol</p>';
                return;
            }

            container.innerHTML = constants.map((constant, index) => {
                // Escape HTML to prevent XSS
                const safeName = escapeHtml(constant.name);
                const safeType = escapeHtml(constant.type);
                const safeValue = escapeHtml(constant.currentValue);
                return \`
                <div class="constant-item">
                    <div class="constant-name">\${safeName}</div>
                    <div class="constant-type">Type: \${safeType}</div>
                    <div class="constant-value">
                        <label>Current Value:</label>
                        <vscode-text-field 
                            id="value-\${index}" 
                            value="\${safeValue}" 
                            placeholder="Enter replacement value"
                        ></vscode-text-field>
                    </div>
                </div>
            \`;
            }).join('');

            // Add event listeners
            constants.forEach((constant, index) => {
                const input = document.getElementById(\`value-\${index}\`);
                if (input) {
                    input.addEventListener('input', (e) => {
                        const newValue = e.target.value.trim();
                        if (newValue && newValue !== constant.currentValue) {
                            // Build target pattern: "name = value"
                            const targetPattern = \`\${constant.name} = \${constant.currentValue}\`;
                            // Build replacement: "name = newValue"
                            const replacementPattern = \`\${constant.name} = \${newValue}\`;
                            
                            replacements[constant.name] = {
                                target: targetPattern,
                                replacement: replacementPattern,
                                endOfTargetMarker: '[^;]*',
                                targetContract: 'Setup.sol'
                            };
                        } else {
                            delete replacements[constant.name];
                        }
                    });
                }
            });
        }

        document.getElementById('save-btn').addEventListener('click', () => {
            const replacementArray = Object.values(replacements);
            if (replacementArray.length === 0) {
                vscode.postMessage({ type: 'showWarning', text: 'No replacements to save' });
                return;
            }
            vscode.postMessage({
                type: 'saveReplacements',
                replacements: replacementArray
            });
        });

        document.getElementById('update-file-btn').addEventListener('click', () => {
            const replacementArray = Object.values(replacements);
            if (replacementArray.length === 0) {
                vscode.postMessage({ type: 'showWarning', text: 'No replacements to apply' });
                return;
            }
            vscode.postMessage({
                type: 'updateSetupFile',
                replacements: replacementArray
            });
        });
    </script>
</body>
</html>`;
    }
}

