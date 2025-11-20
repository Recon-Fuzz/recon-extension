import * as vscode from 'vscode';
import { ChimeraGenerator } from '../chimeraGenerator';
import { findOutputDirectory } from '../utils';
import { ReconContractsViewProvider } from '../reconContractsView';

export class ContractWatcherService implements vscode.Disposable {
    private watcher: vscode.FileSystemWatcher | undefined;
    private folderWatcher: vscode.FileSystemWatcher | undefined;
    private disposables: vscode.Disposable[] = [];

    constructor(
        private contractsProvider: ReconContractsViewProvider,
        private context: vscode.ExtensionContext
    ) {
        // Setup file system watchers if needed
        this.setupWatchers();
    }

    private setupWatchers(): void {
        // Setup watchers for contract changes
        // This can be implemented later if needed
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

    public dispose(): void {
        // Dispose all watchers
        if (this.watcher) {
            this.watcher.dispose();
        }
        if (this.folderWatcher) {
            this.folderWatcher.dispose();
        }
        
        // Dispose all tracked disposables
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
    }
}
