import { ChildProcess, spawn, exec, ExecOptions } from 'child_process';
import { ProcessOptions, ProcessResult } from '../types';


export class ProcessRunnerService {
    /**
     * Runs a command as a detached process that can be terminated
     * @returns The child process
     */
    public spawnDetachedProcess(command: string, args: string[], options: ProcessOptions): ChildProcess {
        return spawn(command, args, {
            ...options,
            detached: true,
            shell: true
        });
    }

    /**
     * Executes a command and returns a promise with the result
     */
    public executeCommand(command: string, options: ProcessOptions): Promise<ProcessResult> {
        return new Promise((resolve, reject) => {
            // Create a new options object that matches ExecOptions
            const execOptions: ExecOptions = {
                cwd: options.cwd,
                env: options.env
                // Omitting shell which is boolean in our type but string in ExecOptions
            };

            exec(command, execOptions, (error, stdout, stderr) => {
                if (error) {
                    resolve({ exitCode: error.code || 1, stdout, stderr });
                    return;
                }

                resolve({ exitCode: 0, stdout, stderr });
            });
        });
    }

    /**
     * Terminates a child process safely across platforms
     */
    public async terminateProcess(childProcess: ChildProcess): Promise<void> {
        if (childProcess.pid === undefined) {
            return;
        }

        try {
            // Use the global process.platform instead of process.platform
            if (process.platform === 'win32') {
                await this.executeCommand(`taskkill /pid ${childProcess.pid} /T /F`, { cwd: '.' });
            } else {
                // Send SIGINT first for graceful shutdown
                childProcess.kill('SIGINT');

                // Wait a bit for graceful shutdown
                await new Promise(resolve => setTimeout(resolve, 1000));

                // Force kill if still running and has not exited
                if (childProcess.exitCode === null) {
                    childProcess.kill('SIGKILL');
                }
            }
        } catch (err) {
            console.error('Failed to terminate process:', err);
        }
    }
}
