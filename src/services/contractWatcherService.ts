import * as vscode from 'vscode';
import * as path from 'path';
import { ChimeraGenerator } from '../chimeraGenerator';
import { findOutputDirectory } from '../utils';
import { ReconContractsViewProvider } from '../reconContractsView';

export class ContractWatcherService {
    private watcher: vscode.FileSystemWatcher | undefined;
    private folderWatcher: vscode.FileSystemWatcher | undefined;

    constructor(
        private contractsProvider: ReconContractsViewProvider,
        private context: vscode.ExtensionContext
    ) { }

    public async initializeWatcher(): Promise<void> {
        if (!vscode.workspace.workspaceFolders) { return; }

        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const outPath = await findOutputDirectory(workspaceRoot);
        const relativePath = path.relative(workspaceRoot, outPath);

        // Create watcher for just the output directory in workspace root
        this.watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceRoot, `${relativePath}/**/*.json`),
            false, true, false
        );

        this.folderWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceRoot, relativePath),
            false, true, false
        );

        this.context.subscriptions.push(this.watcher);
        this.context.subscriptions.push(this.folderWatcher);

        // Watch for json files changes
        this.watcher.onDidCreate(() => {
            this.checkAndLoadContracts();
        });
        this.watcher.onDidDelete(() => {
            this.contractsProvider.setContracts([]);
        });

        // Watch for directory existence changes only
        this.folderWatcher.onDidCreate(() => {
            this.checkAndLoadContracts();
        });

        this.folderWatcher.onDidDelete(() => {
            this.contractsProvider.setContracts([]);
        });
        // Check contracts on initialization
        await this.checkAndLoadContracts();
    }

    public async checkAndLoadContracts(): Promise<void> {
        if (!vscode.workspace.workspaceFolders) { return; }

        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const outPath = await findOutputDirectory(workspaceRoot);

        try {
            // First check if out directory exists
            await vscode.workspace.fs.stat(vscode.Uri.file(outPath));

            const generator = new ChimeraGenerator(workspaceRoot);
            const contracts = await generator.findSourceContracts(outPath);

            // Always update contracts list, even if empty
            this.contractsProvider.setContracts(contracts);

        } catch (error) {
            // Out directory doesn't exist, clear contracts
            this.contractsProvider.setContracts([]);
        }
    }
}
