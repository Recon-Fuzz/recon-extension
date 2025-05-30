import * as vscode from 'vscode';
import { ChimeraGenerator } from '../chimeraGenerator';
import { findOutputDirectory } from '../utils';
import { ReconContractsViewProvider } from '../reconContractsView';

export class ContractWatcherService {
    // private watcher: vscode.FileSystemWatcher | undefined;
    // private folderWatcher: vscode.FileSystemWatcher | undefined;

    constructor(
        private contractsProvider: ReconContractsViewProvider,
        private context: vscode.ExtensionContext
    ) { }

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
