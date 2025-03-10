import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { StatusBarService } from './services/statusBarService';
import { ReconMainViewProvider } from './reconMainView';
import { ReconContractsViewProvider } from './reconContractsView';
import { CoverageViewProvider } from './coverageView';
import { SolFileProcessor } from './solFileProcessor';
import { OutputService } from './services/outputService';
import { ContractWatcherService } from './services/contractWatcherService';
import * as fs from 'fs/promises';
import { getFoundryConfigPath, outputDirectoryExist } from './utils';
import { CoverageMonitorProvider } from './coverageMonitorView';

export async function activate(context: vscode.ExtensionContext) {
    // Create services
    const outputService = new OutputService(context);
    const statusBarService = new StatusBarService(context);
    
    // Create view providers
    const reconMainProvider = new ReconMainViewProvider(context.extensionUri);
    const reconContractsProvider = new ReconContractsViewProvider(context.extensionUri, context);
    const coverageViewProvider = new CoverageViewProvider(context.extensionUri);
    const coverageMonitorProvider = new CoverageMonitorProvider(context.extensionUri);
    
    // Register WebView Providers
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('recon-main', reconMainProvider),
        vscode.window.registerWebviewViewProvider('recon-contracts', reconContractsProvider),
        vscode.window.registerWebviewViewProvider('recon-coverage', coverageViewProvider),
        reconContractsProvider
    );

    // Register Coverage Monitor as a separate panel
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.openCoverageMonitor', () => {
            const panel = vscode.window.createWebviewPanel(
                'recon-coverage-monitor',
                'Coverage Monitor',
                vscode.ViewColumn.Two,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [context.extensionUri]
                }
            );
            coverageMonitorProvider.resolveWebviewPanel(panel);
        })
    );

    // Create and setup contract watcher
    const contractWatcherService = new ContractWatcherService(reconContractsProvider, context);
    await contractWatcherService.initializeWatcher();

    // Register CodeLens provider
    const codeLensProvider = new SolFileProcessor(reconContractsProvider);
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { language: 'solidity', scheme: 'file' },
            codeLensProvider
        )
    );
    
    // Register all commands
    await registerCommands(context, {
        outputService, 
        statusBarService,
        reconMainProvider,
        reconContractsProvider,
        coverageViewProvider,
        contractWatcherService
    });

    // Check if we need to build the project automatically
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]) {
        const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        try {
            const foundryConfigPath = getFoundryConfigPath(workspacePath);
            await fs.access(foundryConfigPath);
            
            // foundry.toml exists, check output directory
            const exists = await outputDirectoryExist(workspacePath);
            if (!exists) {
                vscode.commands.executeCommand('recon.buildProject');
            }
        } catch {
            // foundry.toml doesn't exist, do nothing
        }
    }
}

export function deactivate() {}
