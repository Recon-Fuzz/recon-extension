import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { PropertyToggleCodeLensProvider, getIgnorePatterns, setIgnorePatterns } from './providers/propertyToggleCodeLens';
import { togglePropertyIgnore, showPropertyStatus, listIgnoredProperties, clearIgnoredProperties, addPropertyToIgnore, removePropertyFromIgnore } from './commands/propertyToggleCommands';
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
import { ReconCliService } from './services/reconCliService';

export async function activate(context: vscode.ExtensionContext) {
    // Create services
    const outputService = new OutputService(context);
    const statusBarService = new StatusBarService(context);
    const workspaceService = new WorkspaceService();
    const reconCliService = new ReconCliService();

    // Create view providers
    const reconMainProvider = new ReconMainViewProvider(context.extensionUri, reconCliService);
    const reconContractsProvider = new ReconContractsViewProvider(context.extensionUri, context);
    const coverageViewProvider = new CoverageViewProvider(context.extensionUri);

    // "Install Recon CLI" command — invoked by the install chip on the
    // Recon Fuzzer radio in the cockpit.
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.installReconCli', async () => {
            const ok = await reconCliService.install();
            if (ok) { reconMainProvider.refresh(); }
        })
    );

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

    // ===== CodeLens Property Toggle Registration =====

    // Register CodeLens for property toggle
    const propertyCodeLensProvider = new PropertyToggleCodeLensProvider(context);
    const codeLensDisposable = vscode.languages.registerCodeLensProvider(
        { language: 'solidity', scheme: 'file' },
        propertyCodeLensProvider
    );
    context.subscriptions.push(codeLensDisposable);

    // Register toggle command
    const toggleDisposable = vscode.commands.registerCommand(
        'recon.togglePropertyIgnore',
        togglePropertyIgnore
    );
    context.subscriptions.push(toggleDisposable);

    // Register status command
    const statusDisposable = vscode.commands.registerCommand(
        'recon.showPropertyStatus',
        showPropertyStatus
    );
    context.subscriptions.push(statusDisposable);

    // Register list command
    const listDisposable = vscode.commands.registerCommand(
        'recon.listIgnoredProperties',
        listIgnoredProperties
    );
    context.subscriptions.push(listDisposable);

    // Register clear command
    const clearDisposable = vscode.commands.registerCommand(
        'recon.clearIgnoredProperties',
        clearIgnoredProperties
    );
    context.subscriptions.push(clearDisposable);

    // Register add property command
    const addPropertyDisposable = vscode.commands.registerCommand(
        'recon.addPropertyToIgnore',
        addPropertyToIgnore
    );
    context.subscriptions.push(addPropertyDisposable);

    // Register remove property command
    const removePropertyDisposable = vscode.commands.registerCommand(
        'recon.removePropertyFromIgnore',
        removePropertyFromIgnore
    );
    context.subscriptions.push(removePropertyDisposable);
}

export function deactivate() { }
