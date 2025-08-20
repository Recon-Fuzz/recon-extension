import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { processLogs, generateJobMD, Fuzzer } from '@recon-fuzz/log-parser';
import { getFoundryConfigPath, getTestFolder, prepareTrace, stripAnsiCodes, getUid, getEnvironmentPath } from '../utils';
import { ServiceContainer } from '../services/serviceContainer';

export function registerFuzzingCommands(
    context: vscode.ExtensionContext,
    services: ServiceContainer
): void {
    // Register Echidna command
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.runEchidna', async (target?: string) => {
            await runFuzzer(Fuzzer.ECHIDNA, services, target);
        })
    );

    // Register Medusa command
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.runMedusa', async (target?: string) => {
            await runFuzzer(Fuzzer.MEDUSA, services, target);
        })
    );

    // Register Halmos command
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.runHalmos', async (target?: string) => {
            await runFuzzer(Fuzzer.HALMOS, services, target);
        })
    );
}

async function runFuzzer(
    fuzzerType: Fuzzer,
    services: ServiceContainer,
    target: string = 'CryticTester'
): Promise<void> {
    if (!vscode.workspace.workspaceFolders) {
        vscode.window.showErrorMessage('Please open a workspace first');
        return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const foundryConfigPath = getFoundryConfigPath(workspaceRoot);
    const foundryRoot = path.dirname(foundryConfigPath);

    let command: string;

    if (fuzzerType === Fuzzer.ECHIDNA) {
        const config = vscode.workspace.getConfiguration('recon.echidna');
        const workers = config.get<number>('workers', 8);
        const testLimit = config.get<number>('testLimit', 1000000);
        const mode = config.get<string>('mode', 'assertion');

        command = `echidna . --contract ${target || 'CryticTester'} --config echidna.yaml --format text --workers ${workers || 10} --test-limit ${testLimit} --test-mode ${mode}`;
    } else if (fuzzerType === Fuzzer.MEDUSA) {
        const config = vscode.workspace.getConfiguration('recon.medusa');
        const workers = config.get<number>('workers', 10);
        const testLimit = config.get<number>('testLimit', 0);

        command = `medusa fuzz --workers ${workers || 10} --test-limit ${testLimit}`;
        if (target !== 'CryticTester') {
            command += ` --target-contracts ${target || 'CryticTester'}`;
        }
    } else {
        const config = vscode.workspace.getConfiguration('recon.halmos');
        const depth = config.get<number>('depth', 22);
        const unroll = config.get<number>('unroll', 256);
        const solver = config.get<string>('solver', 'z3');

        command = `halmos --function-name "echidna_" --depth ${depth} --unroll ${unroll} --solver-timeout-assertion 0 --solver-timeout-branch 1 --early-exit --solver ${solver}`;
        if (target !== 'CryticTester') {
            command += ` --contract ${target}`;
        }
    }

    // Create output channel for live feedback
    const outputChannel = services.outputService.createFuzzerOutputChannel(
        fuzzerType === Fuzzer.ECHIDNA ? 'Echidna' : 
        fuzzerType === Fuzzer.MEDUSA ? 'Medusa' : 'Halmos'
    );
    outputChannel.show();

    let output = '';
    let processCompleted = false;
    let childProcess: any = null;
    let hasEnoughData = false;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: fuzzerType === Fuzzer.ECHIDNA ? 'Echidna' : 
               fuzzerType === Fuzzer.MEDUSA ? 'Medusa' : 'Halmos',
        cancellable: true
    }, async (progress, token) => {
        return new Promise<void>((resolve, reject) => {
            childProcess = require('child_process').spawn(command, {
                cwd: foundryRoot,
                shell: true,
                detached: true,
                ...(process.platform !== 'win32' && { stdio: 'pipe' }),
                env: {
                    ...process.env,
                    PATH: getEnvironmentPath()
                }
            });

            // Handle graceful shutdown
            async function handleShutdown(reason: string) {
                if (!processCompleted && childProcess) {
                    processCompleted = true;
                    resolve();

                    try {
                        if (process.platform === 'win32') {
                            require('child_process').execSync(
                                `taskkill /pid ${childProcess.pid} /T /F`,
                                { stdio: 'ignore' }
                            );
                        } else {
                            if (reason === 'stopped by user') {
                                if (fuzzerType === Fuzzer.MEDUSA) {
                                    process.kill(-childProcess.pid, 'SIGINT');
                                } else {
                                    process.kill(-childProcess.pid, 'SIGTERM');
                                }
                            }
                        }

                        outputChannel.appendLine(`\n${fuzzerType} process ${reason}`);

                        // Wait for completion signals for each fuzzer
                        if (fuzzerType === Fuzzer.ECHIDNA) {
                            // Wait for "Saving test reproducers" with 1 minute timeout
                            let waited = 0;
                            while (waited < 60000 && !output.includes("Saving test reproducers")) {
                                await new Promise(resolve => setTimeout(resolve, 1000));
                                waited += 1000;
                            }
                        } else if (fuzzerType === Fuzzer.MEDUSA) {
                            // Wait for "Test summary:" with 1 minute timeout
                            let waited = 0;
                            while (waited < 60000 && !output.includes("Test summary:")) {
                                await new Promise(resolve => setTimeout(resolve, 1000));
                                waited += 1000;
                            }
                        } else if (fuzzerType === Fuzzer.HALMOS) {
                            // Wait for "Halmos completed" or similar completion message
                            let waited = 0;
                            while (waited < 60000 && !output.includes("Symbolic execution completed")) {
                                await new Promise(resolve => setTimeout(resolve, 1000));
                                waited += 1000;
                            }
                        }

                        // Generate report if we have enough data
                        if (hasEnoughData) {
                            try {
                                if (fuzzerType === Fuzzer.ECHIDNA) {
                                    let splitOutput = output.split('Stopping.');
                                    if (splitOutput.length > 1) {
                                        splitOutput = splitOutput.slice(1);
                                        output = splitOutput.join('Stopping.');
                                    }
                                }
                                const results = processLogs(output, fuzzerType);
                                const reportContent = generateJobMD(
                                    fuzzerType,
                                    output,
                                    vscode.workspace.name || 'Recon Project',
                                );

                                const showReport = await vscode.window.showInformationMessage(
                                    `Fuzzing completed. View detailed report?`,
                                    { modal: true },
                                    'Yes', 'No'
                                );

                                if (showReport === 'Yes') {
                                    const reportDoc = await vscode.workspace.openTextDocument({
                                        content: reportContent,
                                        language: 'markdown'
                                    });
                                    await vscode.window.showTextDocument(reportDoc, { preview: true });
                                }

                                // Handle broken properties
                                if (results.brokenProperties.length > 0) {
                                    const repros = results.brokenProperties
                                        .map(prop => prepareTrace(fuzzerType, getUid(), prop.sequence, prop.brokenProperty))
                                        .join("\n\n");

                                    const answer = await vscode.window.showInformationMessage(
                                        `Found ${results.brokenProperties.length} broken properties. Save Foundry reproductions?`,
                                        { modal: true },
                                        'Yes', 'No'
                                    );

                                    if (answer === 'Yes') {
                                        try {
                                            const testFolder = await getTestFolder(workspaceRoot);
                                            const foundryTestPath = path.join(foundryRoot, testFolder, 'recon', 'CryticToFoundry.sol');

                                            try {
                                                const existingContent = await fs.readFile(foundryTestPath, 'utf8');
                                                const newContent = existingContent.replace(/}([^}]*)$/, `\n    ${repros}\n}$1`);
                                                await fs.writeFile(foundryTestPath, newContent);

                                                const doc = await vscode.workspace.openTextDocument(foundryTestPath);
                                                await vscode.window.showTextDocument(doc);
                                                vscode.window.showInformationMessage('Added reproductions to existing CryticToFoundry.sol');
                                            } catch (e) {
                                                vscode.window.showWarningMessage('Could not find CryticToFoundry.sol. Please create it first.');
                                            }
                                        } catch (error) {
                                            console.error('Error saving reproductions:', error);
                                            vscode.window.showErrorMessage('Failed to save Foundry reproductions');
                                        }
                                    }
                                }

                                vscode.window.showInformationMessage(
                                    `${fuzzerType} ${reason}: ${results.passed} passed, ${results.failed} failed`
                                );
                            } catch (error) {
                                console.error('Error generating report:', error);
                                vscode.window.showErrorMessage('Error generating report');
                            }
                        } else {
                            vscode.window.showInformationMessage(`${fuzzerType} ${reason} (not enough data for report)`);
                        }
                    } catch (err) {
                        console.error('Error during shutdown:', err);
                        reject(err);
                    }
                }
            }

            // Handle cancellation
            token.onCancellationRequested(() => {
                handleShutdown('stopped by user');
            });

            // Handle process output
            childProcess.stdout.on('data', (data: Buffer) => {
                const text = fuzzerType === Fuzzer.MEDUSA ? stripAnsiCodes(data.toString()) : data.toString();
                output += text;
                outputChannel.append(text);

                // Parse fuzzer-specific status
                if (fuzzerType === Fuzzer.ECHIDNA) {
                    if (text.includes("[status] tests:")) {
                        hasEnoughData = true;
                        const testMatch = text.match(/tests: (\d+)\/(\d+)/);
                        const fuzzingMatch = text.match(/fuzzing: (\d+)\/(\d+)/);
                        const corpusMatch = text.match(/corpus: (\d+)/);

                        if (fuzzingMatch) {
                            const [, currentFuzz, maxFuzz] = fuzzingMatch;
                            const current = parseInt(currentFuzz);
                            const max = parseInt(maxFuzz);
                            const corpusSize = corpusMatch ? corpusMatch[1] : '0';
                            const [, failedTests, totalTests] = testMatch || ['', '0', '0'];

                            const percentage = (current / max) * 100;
                            const increment = percentage - (progress as any).lastPercentage || 0;
                            (progress as any).lastPercentage = percentage;

                            progress.report({
                                message: `Tests: ${failedTests}/${totalTests} | Progress: ${currentFuzz}/${maxFuzz} | Corpus: ${corpusSize}`,
                                increment: Math.max(0, increment)
                            });
                        }
                    }
                } else if (fuzzerType === Fuzzer.MEDUSA) {
                    if (text.includes("fuzz: elapsed:")) {
                        hasEnoughData = true;
                        const corpusMatch = text.match(/corpus: (\d+)/);
                        const failuresMatch = text.match(/failures: (\d+)\/(\d+)/);
                        const callsMatch = text.match(/calls: (\d+)/);

                        if (corpusMatch && failuresMatch && callsMatch) {
                            const corpus = corpusMatch[1];
                            const [, failures, totalTests] = failuresMatch;
                            const calls = callsMatch[1];
                            const testLimit = vscode.workspace.getConfiguration('recon.medusa').get<number>('testLimit', 0);

                            const percentage = testLimit > 0 ? Math.min((parseInt(calls) / testLimit) * 100, 100) : 0;
                            const increment = percentage - (progress as any).lastPercentage || 0;
                            (progress as any).lastPercentage = percentage;

                            progress.report({
                                message: `Tests: ${failures}/${totalTests} | Calls: ${calls} | Corpus: ${corpus}`,
                                increment: Math.max(0, increment)
                            });
                        }
                    }
                } else if (fuzzerType === Fuzzer.HALMOS) {
                    if (text.includes("Running") || text.includes("PASS") || text.includes("FAIL")) {
                        hasEnoughData = true;
                        const passMatch = text.match(/PASS/g);
                        const failMatch = text.match(/FAIL/g);
                        const passed = passMatch ? passMatch.length : 0;
                        const failed = failMatch ? failMatch.length : 0;
                        const total = passed + failed;

                        if (total > 0) {
                            progress.report({
                                message: `Tests: ${failed}/${total} | Passed: ${passed} | Failed: ${failed}`,
                                increment: 10
                            });
                        }
                    }
                }
            });

            // Handle stderr
            childProcess.stderr.on('data', (data: Buffer) => {
                const text = data.toString();
                output += text;
                outputChannel.append(text);
            });

            // Handle process completion
            childProcess.on('close', async (code: number) => {
                if (!processCompleted) {
                    if (code === 0) {
                        handleShutdown('completed');
                    } else {
                        handleShutdown(`exited with code ${code}`);
                    }
                }
            });

            childProcess.on('error', (err: Error) => {
                if (!processCompleted) {
                    console.error('Process error:', err);
                    handleShutdown(`failed: ${err.message}`);
                }
            });
        });
    });
}
