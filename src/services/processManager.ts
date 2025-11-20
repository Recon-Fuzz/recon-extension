import * as vscode from 'vscode';
import { ChildProcess } from 'child_process';

/**
 * Manages all child processes created by the extension.
 * Ensures proper cleanup on deactivation.
 */
export class ProcessManager {
    private static instance: ProcessManager;
    private processes: Map<number, { process: ChildProcess; type: string; createdAt: Date }> = new Map();
    private shutdownLock: boolean = false;

    private constructor() {}

    public static getInstance(): ProcessManager {
        if (!ProcessManager.instance) {
            ProcessManager.instance = new ProcessManager();
        }
        return ProcessManager.instance;
    }

    /**
     * Register a child process for tracking
     */
    public registerProcess(process: ChildProcess, type: string): void {
        if (process.pid) {
            this.processes.set(process.pid, {
                process,
                type,
                createdAt: new Date()
            });
        }
    }

    /**
     * Unregister a child process
     */
    public unregisterProcess(pid: number): void {
        this.processes.delete(pid);
    }

    /**
     * Get a mutex lock for shutdown operations
     */
    public async acquireShutdownLock(): Promise<boolean> {
        if (this.shutdownLock) {
            return false;
        }
        this.shutdownLock = true;
        return true;
    }

    /**
     * Release the shutdown lock
     */
    public releaseShutdownLock(): void {
        this.shutdownLock = false;
    }

    /**
     * Terminate all tracked processes
     */
    public async terminateAll(): Promise<void> {
        const promises: Promise<void>[] = [];

        for (const [pid, { process, type }] of this.processes.entries()) {
            promises.push(
                this.terminateProcess(process, pid, type).catch(err => {
                    console.error(`Error terminating process ${pid} (${type}):`, err);
                })
            );
        }

        await Promise.allSettled(promises);
        this.processes.clear();
    }

    /**
     * Terminate a single process
     */
    private async terminateProcess(process: ChildProcess, pid: number, type: string): Promise<void> {
        return new Promise<void>((resolve) => {
            if (!process.pid || process.killed) {
                resolve();
                return;
            }

            try {
                const platform = require('process').platform;
                if (platform === 'win32') {
                    // Windows: Use taskkill
                    const { execSync } = require('child_process');
                    try {
                        execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
                    } catch (e) {
                        // Process might already be terminated
                    }
                } else {
                    // Unix: Kill process group
                    try {
                        process.kill('SIGTERM');
                        // Give it a moment to terminate gracefully
                        setTimeout(() => {
                            if (!process.killed) {
                                process.kill('SIGKILL');
                            }
                        }, 2000);
                    } catch (e) {
                        // Process might already be terminated
                    }
                }

                // Wait for process to exit
                const timeout = setTimeout(() => {
                    resolve();
                }, 3000);

                process.once('exit', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            } catch (err) {
                console.error(`Failed to terminate process ${pid}:`, err);
                resolve();
            }
        });
    }

    /**
     * Get count of active processes
     */
    public getActiveProcessCount(): number {
        return this.processes.size;
    }

    /**
     * Get all active process types
     */
    public getActiveProcessTypes(): string[] {
        return Array.from(this.processes.values()).map(p => p.type);
    }
}

