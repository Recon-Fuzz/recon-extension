import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { StatusBarService } from './services/statusBarService';
import { ReconMainViewProvider } from './reconMainView';
import { ReconContractsViewProvider } from './reconContractsView';
import { CoverageViewProvider } from './coverageView';
import { SolFileProcessor } from './solFileProcessor';
import { OutputService } from './services/outputService';
import { ContractWatcherService } from './services/contractWatcherService';
import { WorkspaceService } from './services/workspaceService';
import { LogToFoundryViewProvider } from './tools/logToFoundryView';
import { ArgusCallGraphEditorProvider } from './argus/argusEditorProvider';

export async function activate(context: vscode.ExtensionContext) {
    // Create services
    const outputService = new OutputService(context);
    const statusBarService = new StatusBarService(context);
    const workspaceService = new WorkspaceService();

    // Create view providers
    const reconMainProvider = new ReconMainViewProvider(context.extensionUri);
    const reconContractsProvider = new ReconContractsViewProvider(context.extensionUri, context);
    const coverageViewProvider = new CoverageViewProvider(context.extensionUri);

    // Register WebView Providers
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('recon-main', reconMainProvider),
        vscode.window.registerWebviewViewProvider('recon-contracts', reconContractsProvider),
        vscode.window.registerWebviewViewProvider('recon-coverage', coverageViewProvider),
        reconContractsProvider
    );

    // Create and setup contract watcher
    const contractWatcherService = new ContractWatcherService(reconContractsProvider, context);
    // await contractWatcherService.initializeWatcher();

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
        contractWatcherService,
        workspaceService
    });
    vscode.commands.executeCommand('recon.refreshContracts');
    vscode.commands.executeCommand('recon.refreshCoverage');

    // Register Log to Foundry command
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.logToFoundry', () => {
            const provider = new LogToFoundryViewProvider(context.extensionUri);
            provider.createWebviewPanel();
        })
    );

    // Register Argus custom editor provider
    const argusProvider = new ArgusCallGraphEditorProvider(context);
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(ArgusCallGraphEditorProvider.viewType, argusProvider)
    );

    // Command to open current Solidity file with Argus preview
    context.subscriptions.push(
        // Editor/Palette: always open beside
        vscode.commands.registerCommand('recon.previewArgusCallGraph', async (resource?: vscode.Uri) => {
            let target: vscode.Uri | undefined = undefined;
            if (resource && resource instanceof vscode.Uri) {
                target = resource;
            } else {
                const active = vscode.window.activeTextEditor;
                if (active && active.document.languageId === 'solidity') {
                    target = active.document.uri;
                }
            }
            if (!target) {
                vscode.window.showInformationMessage('Select or open a Solidity (.sol) file to preview Argus.');
                return;
            }
            await vscode.commands.executeCommand(
                'vscode.openWith',
                target,
                ArgusCallGraphEditorProvider.viewType,
                { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }
            );
        }),
        // Explorer: open in current group (full width)
        vscode.commands.registerCommand('recon.previewArgusCallGraphHere', async (resource?: vscode.Uri) => {
            let target: vscode.Uri | undefined = undefined;
            if (resource && resource instanceof vscode.Uri) {
                target = resource;
            } else {
                const active = vscode.window.activeTextEditor;
                if (active && active.document.languageId === 'solidity') {
                    target = active.document.uri;
                }
            }
            if (!target) {
                vscode.window.showInformationMessage('Select a Solidity (.sol) file in the Explorer to open Argus.');
                return;
            }
            await vscode.commands.executeCommand(
                'vscode.openWith',
                target,
                ArgusCallGraphEditorProvider.viewType
            );
        })
    );
}

export function deactivate() { }
