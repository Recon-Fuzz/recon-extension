import * as os from 'os';
import * as vscode from 'vscode';

export type ExecType = 'echidna' | 'medusa';

/**
 * Get the number of cores to reserve for system/IDE
 */
export function getReservedCores(): number {
    const config = vscode.workspace.getConfiguration('recon');
    const reserved = config.get<number>('reservedCores', 2);// get reserved cores, if empty default reserved cores to 2
    const totalCores = os.cpus().length;

    // Validate: ensure at least 0, max (total cores - 1)
    const maxReservable = totalCores - 1; // it needs to fuzz at least with 1
    return Math.max(0, Math.min(reserved, maxReservable));
}

/**
 * Get available cores for workers (total - reserved)
 */
export function getAvailableCores(): number {
    const cpuCount = os.cpus().length;
    const reserved = getReservedCores();

    // Always leave at least 1 core available for workers
    return Math.max(1, cpuCount - reserved);
}

/**
 * Check if uncap mode is enabled
 */
export function isUncapModeEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('recon');
    return config.get<boolean>('uncapWorkers', false);
}

/**
 * Calculate optimal worker count based on available CPU cores and execution type
 */
export function getOptimalWorkerCount(execType: ExecType): number {
    const availableCores = getAvailableCores();
    const uncapMode = isUncapModeEnabled();

    if (uncapMode) {
        // Uncap mode: use all available cores (diminishing returns warning shown in UI)
        switch (execType) {
            case 'medusa':
                return availableCores;
            case 'echidna':
                return availableCores;
            default:
                return availableCores;
        }
    }

    // Default mode: recommended caps for optimal performance/stability
    switch (execType) {
        case 'medusa':
            // Medusa benefits from more workers for parallel fuzzing
            // Cap at 12 for optimal performance (diminishing returns beyond this)
            return Math.min(availableCores, 12);

        case 'echidna':
            // Echidna has diminishing returns beyond 8 workers
            return Math.min(availableCores, 8);

        default:
            return Math.min(availableCores, 8);
    }
}

/**
 * Get worker configuration for an execution type, respecting user overrides
 */
export function getWorkerConfig(execType: ExecType): number {
    const config = vscode.workspace.getConfiguration('recon');
    const isOverridden = config.get<boolean>(`${execType}.workersOverride`, false);
    const configuredWorkers = config.get<number | null>(`${execType}.workers`, null);

    // If user has overridden and set a value, use it
    if (isOverridden && configuredWorkers !== null) {
        return configuredWorkers;
    }

    // Otherwise, auto-calculate optimal workers
    return getOptimalWorkerCount(execType);
}

/**
 * Check if worker count is auto-detected or manually set
 */
export function isWorkersAutoDetected(execType: ExecType): boolean {
    const config = vscode.workspace.getConfiguration('recon');
    return !config.get<boolean>(`${execType}.workersOverride`, false);
}

/**
 * Update reserved cores configuration
 */
export async function setReservedCores(cores: number): Promise<void> {
    const config = vscode.workspace.getConfiguration('recon');
    const validCores = Math.max(0, Math.min(cores, 16));
    await config.update('reservedCores', validCores, vscode.ConfigurationTarget.Workspace);
}

/**
 * Set workers with override flag
 */
export async function setWorkers(execType: ExecType, workers: number, override: boolean = true): Promise<void> {
    const config = vscode.workspace.getConfiguration('recon');
    await config.update(`${execType}.workers`, workers, vscode.ConfigurationTarget.Workspace);
    await config.update(`${execType}.workersOverride`, override, vscode.ConfigurationTarget.Workspace);
}

/**
 * Reset to auto-detection
 */
export async function resetToAutoDetection(execType: ExecType): Promise<void> {
    const config = vscode.workspace.getConfiguration('recon');
    await config.update(`${execType}.workersOverride`, false, vscode.ConfigurationTarget.Workspace);
}

/**
 * Get system info for display
 */
export function getSystemInfo(): { cpuModel: string; cpuCount: number; reserved: number; available: number } {
    const cpuCount = os.cpus().length;
    const cpuModel = os.cpus()[0]?.model || 'Unknown';
    const reserved = getReservedCores();
    const available = getAvailableCores();

    return { cpuModel, cpuCount, reserved, available };
}
