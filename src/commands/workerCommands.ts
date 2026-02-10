import * as vscode from 'vscode';
import * as os from 'os';
import {
    getReservedCores,
    setReservedCores,
    getAvailableCores,
    getOptimalWorkerCount,
    getSystemInfo
} from '../utils/workerConfig';
import { ServiceContainer } from '../services/serviceContainer';

export function registerWorkerCommands(
    context: vscode.ExtensionContext,
    services: ServiceContainer
): void {

    // Command: Configure Reserved CPU Cores
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.configureReservedCores', async () => {
            const cpuCount = os.cpus().length;
            const current = getReservedCores();

            const input = await vscode.window.showInputBox({
                prompt: `Number of CPU cores to reserve (Total: ${cpuCount}, Current: ${current})`,
                value: current.toString(),
                placeHolder: 'e.g., 2',
                validateInput: (value) => {
                    const num = parseInt(value);
                    if (isNaN(num)) {
                        return 'Please enter a valid number';
                    }
                    if (num < 0) {
                        return 'Reserved cores must be at least 0';
                    }
                    if (num >= cpuCount) {
                        return `Must leave at least 1 core available (max: ${cpuCount - 1})`;
                    }
                    return null;
                }
            });

            if (input !== undefined) {
                const cores = parseInt(input);
                await setReservedCores(cores);

                const available = getAvailableCores();
                const echidnaWorkers = getOptimalWorkerCount('echidna');
                const medusaWorkers = getOptimalWorkerCount('medusa');

                // Log to main output channel
                const channel = services.outputService.getMainChannel();
                channel.appendLine('═══════════════════════════════════════════════════════');
                channel.appendLine(`[${new Date().toLocaleTimeString()}] Reserved cores updated`);
                channel.appendLine(`   Reserved: ${cores} → Available: ${available}`);
                channel.appendLine(`   Auto-configured workers:`);
                channel.appendLine(`   • Echidna: ${echidnaWorkers}`);
                channel.appendLine(`   • Medusa: ${medusaWorkers}`);
                channel.appendLine('═══════════════════════════════════════════════════════');

                vscode.window.showInformationMessage(
                    `Reserved cores: ${cores}. Available: ${available}. Workers → Echidna: ${echidnaWorkers}, Medusa: ${medusaWorkers}`
                );
            }
        })
    );

    // Command: Show Worker Configuration Info
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.showWorkerInfo', async () => {
            const { cpuModel, cpuCount, reserved, available } = getSystemInfo();
            const echidnaWorkers = getOptimalWorkerCount('echidna');
            const medusaWorkers = getOptimalWorkerCount('medusa');

            const info = `
💻 System Info:
   CPU Model: ${cpuModel}
   Total Cores: ${cpuCount}
   Reserved Cores: ${reserved}
   Available for Workers: ${available}

⚙️  Auto-configured Workers:
   • Echidna: ${echidnaWorkers} workers
   • Medusa: ${medusaWorkers} workers

💡 Tip: Configure reserved cores in Settings > Recon: Reserved Cores
            `.trim();

            const action = await vscode.window.showInformationMessage(
                `CPU Cores: ${cpuCount} | Reserved: ${reserved} | Available: ${available}`,
                'View Details',
                'Configure'
            );

            if (action === 'View Details') {
                const channel = services.outputService.getMainChannel();
                channel.clear();
                channel.appendLine('═══════════════════════════════════════════════════════');
                channel.appendLine('🚀 Recon Worker Configuration');
                channel.appendLine('═══════════════════════════════════════════════════════');
                channel.appendLine('');
                channel.appendLine(info);
                channel.appendLine('');
                channel.appendLine('═══════════════════════════════════════════════════════');
                channel.show();
            } else if (action === 'Configure') {
                vscode.commands.executeCommand('recon.configureReservedCores');
            }
        })
    );

    // Command: Reset Workers to Auto-Detection
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.resetWorkersToAuto', async () => {
            const config = vscode.workspace.getConfiguration('recon');

            // Reset both echidna and medusa
            await config.update('echidna.workersOverride', false, vscode.ConfigurationTarget.Workspace);
            await config.update('medusa.workersOverride', false, vscode.ConfigurationTarget.Workspace);

            const echidnaWorkers = getOptimalWorkerCount('echidna');
            const medusaWorkers = getOptimalWorkerCount('medusa');

            const channel = services.outputService.getMainChannel();
            channel.appendLine(`[${new Date().toLocaleTimeString()}] Workers reset to auto-detection`);
            channel.appendLine(`   • Echidna: ${echidnaWorkers} workers (auto)`);
            channel.appendLine(`   • Medusa: ${medusaWorkers} workers (auto)`);

            vscode.window.showInformationMessage(
                `Workers reset to auto-detection. Echidna: ${echidnaWorkers}, Medusa: ${medusaWorkers}`
            );
        })
    );
}
