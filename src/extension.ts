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
import { ReconProViewProvider } from './reconProView';
import { AuthService, AuthState } from './services/authService';
import { JobsViewProvider } from './pro/jobsView';

export async function activate(context: vscode.ExtensionContext) {
    // Create services
    const outputService = new OutputService(context);
    const statusBarService = new StatusBarService(context);
    const workspaceService = new WorkspaceService();

    const authService = new AuthService(context);

    // Create view providers
    const reconMainProvider = new ReconMainViewProvider(context.extensionUri);
    const reconContractsProvider = new ReconContractsViewProvider(context.extensionUri, context);
    const coverageViewProvider = new CoverageViewProvider(context.extensionUri);

    const reconProProvider = new ReconProViewProvider(
        context.extensionUri,
        authService,
        context
    );

    // Register WebView Providers
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('recon-main', reconMainProvider),
        vscode.window.registerWebviewViewProvider('recon-contracts', reconContractsProvider),
        vscode.window.registerWebviewViewProvider('recon-coverage', coverageViewProvider),
        vscode.window.registerWebviewViewProvider('recon-pro-main', reconProProvider),
        vscode.window.registerWebviewViewProvider(
            JobsViewProvider.viewType,
            new JobsViewProvider(context.extensionUri, authService)
        ),
        reconContractsProvider
    );

    // Set context for conditional view
    vscode.commands.executeCommand('setContext', 'recon:isPro', authService.getAuthState().isPro);

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
}

export function deactivate() {}
