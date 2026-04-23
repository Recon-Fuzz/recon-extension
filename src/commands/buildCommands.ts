import * as vscode from 'vscode';
import * as path from 'path';
import { exec, spawn } from 'child_process';
import { getEnvironmentPath, getFoundryConfigPath } from '../utils';
import { ServiceContainer } from '../services/serviceContainer';

export function registerBuildCommands(
    context: vscode.ExtensionContext,
    services: ServiceContainer
): void {
    // Register forge build command
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.buildProject', async () => {
            if (!vscode.workspace.workspaceFolders) {
                vscode.window.showErrorMessage('Please open a workspace first');
                return;
            }

            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const foundryConfigPath = getFoundryConfigPath(workspaceRoot);
            const foundryRoot = path.dirname(foundryConfigPath);
            const outputChannel = services.outputService.getMainChannel();

            // Get extra build arguments from settings
            const extraBuildArgs = vscode.workspace.getConfiguration('recon.forge').get<string>('buildArgs', '');

            // Show and clear output channel
            outputChannel.show();
            outputChannel.clear();
            outputChannel.appendLine('Starting Forge build...');

            // Return the progress promise so callers can await build completion
            return vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Building Foundry Project",
                cancellable: true
            }, async (progress, token) => {
                return new Promise((resolve, reject) => {
                    const args = ['build', ...extraBuildArgs.split(/\s+/).filter(Boolean)];
                    const buildProcess = spawn('forge', args, {
                        cwd: foundryRoot,
                        env: {
                            ...process.env,
                            PATH: getEnvironmentPath()
                        }
                    });

                    let stdout = '';
                    let stderr = '';

                    buildProcess.stdout.on('data', (data: Buffer) => {
                        const text = data.toString();
                        stdout += text;
                        outputChannel.append(text);
                    });

                    buildProcess.stderr.on('data', (data: Buffer) => {
                        const text = data.toString();
                        stderr += text;
                        outputChannel.append(text);
                    });

                    buildProcess.on('close', (code: number) => {
                        if (token.isCancellationRequested) { return; }
                        if (code !== 0) {
                            const errorMsg = `Build failed with exit code ${code}`;
                            outputChannel.appendLine(errorMsg);
                            vscode.window.showErrorMessage(errorMsg);
                            reject(new Error(errorMsg));
                            return;
                        }
                        outputChannel.appendLine('Build completed successfully');
                        vscode.window.showInformationMessage('Build completed successfully');
                        vscode.commands.executeCommand('recon.refreshContracts');
                        services.contractWatcherService.checkAndLoadContracts();
                        resolve(stdout);
                    });

                    token.onCancellationRequested(() => {
                        buildProcess.kill();
                        outputChannel.appendLine('Build cancelled by user');
                        vscode.window.showInformationMessage('Build cancelled');
                        resolve(undefined);
                    });
                });
            });
        })
    );

    // Register refresh contracts command
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.refreshContracts', () => {
            services.contractWatcherService.checkAndLoadContracts();
        })
    );

    // Build with build-info (used by Argus preview)
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.buildWithInfo', async () => {
            if (!vscode.workspace.workspaceFolders) {
                vscode.window.showErrorMessage('Please open a workspace first');
                return;
            }
            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const foundryConfigPath = getFoundryConfigPath(workspaceRoot);
            const foundryRoot = path.dirname(foundryConfigPath);
            const outputChannel = services.outputService.getMainChannel();

            outputChannel.show();
            outputChannel.clear();
            outputChannel.appendLine('Starting Forge build (with build-info)...');

            const baseCmd = 'forge build --build-info --skip */test/** */tests/** */script/** */scripts/** */contracts/test/**';
            // Return the progress promise so callers (e.g., Argus webview) can await completion
            return vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Building Foundry Project (build-info)',
                cancellable: true
            }, async (progress, token) => {
                progress.report({ message: 'Running forge build...' });
                return new Promise((resolve, reject) => {
                    const buildProcess = exec(baseCmd, {
                        cwd: foundryRoot,
                        env: { ...process.env, PATH: getEnvironmentPath() }
                    }, (error, stdout, stderr) => {
                        if (error && !token.isCancellationRequested) {
                            const errorMsg = `Build (build-info) failed: ${error.message}`;
                            outputChannel.appendLine(errorMsg);
                            vscode.window.showErrorMessage(errorMsg);
                            reject(error);
                            return;
                        }
                        if (stdout) {
                            outputChannel.appendLine(stdout);
                        }
                        if (stderr) {
                            outputChannel.appendLine('Build warnings:');
                            outputChannel.appendLine(stderr);
                        }
                        if (!token.isCancellationRequested) {
                            outputChannel.appendLine('Build (build-info) completed successfully');
                            vscode.window.showInformationMessage('Build (build-info) completed successfully');
                            vscode.commands.executeCommand('recon.refreshContracts');
                            services.contractWatcherService.checkAndLoadContracts();
                            resolve(stdout);
                        }
                    });

                    token.onCancellationRequested(() => {
                        buildProcess.kill();
                        outputChannel.appendLine('Build (build-info) cancelled by user');
                        vscode.window.showInformationMessage('Build (build-info) cancelled');
                        resolve(undefined);
                    });
                });
            });
        })
    );
}
