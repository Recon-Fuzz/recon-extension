import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { getEnvironmentPath } from '../utils';

const RECONUP_INSTALLER_URL = 'https://raw.githubusercontent.com/Recon-Fuzz/reconup/refs/heads/main/install';

/**
 * Checks whether the `recon` CLI is reachable in the user's PATH or in the
 * canonical install location (~/.recon/bin/recon[.exe]). Result is cached
 * for the session and can be busted via `invalidate()` after install.
 */
export class ReconCliService {
    private cached: boolean | null = null;

    isAvailableSync(): boolean {
        if (this.cached !== null) { return this.cached; }
        this.cached = this.detect();
        return this.cached;
    }

    invalidate(): void {
        this.cached = null;
    }

    private detect(): boolean {
        // 1) Canonical install location.
        const home = os.homedir();
        const candidates = process.platform === 'win32'
            ? [path.join(home, '.recon', 'bin', 'recon.exe'), path.join(home, '.recon', 'bin', 'recon')]
            : [path.join(home, '.recon', 'bin', 'recon')];
        for (const p of candidates) {
            try {
                fs.accessSync(p, fs.constants.X_OK);
                return true;
            } catch { /* try next */ }
        }

        // 2) PATH lookup.
        const PATH = getEnvironmentPath();
        const sep = process.platform === 'win32' ? ';' : ':';
        const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
        for (const dir of PATH.split(sep).filter(Boolean)) {
            for (const ext of exts) {
                const candidate = path.join(dir, 'recon' + ext);
                try {
                    fs.accessSync(candidate, fs.constants.X_OK);
                    return true;
                } catch { /* try next */ }
            }
        }
        return false;
    }

    /**
     * Install via the official reconup installer:
     *   Unix:    curl -L <url> | bash
     *   Windows: same script via Git Bash (no WSL fallback to keep things
     *            simple — instructs the user if Git Bash isn't found).
     * Then run `~/.recon/bin/reconup` to actually pull the latest `recon`.
     */
    async install(): Promise<boolean> {
        return await vscode.window.withProgress<boolean>(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Installing Recon CLI',
                cancellable: false
            },
            async (progress) => {
                progress.report({ message: 'Locating shell…' });
                const bash = this.findBash();
                if (!bash) {
                    vscode.window.showErrorMessage(
                        process.platform === 'win32'
                            ? 'Recon CLI install requires Git Bash. Install Git for Windows (or use WSL) and try again.'
                            : 'No bash shell was found on PATH.'
                    );
                    return false;
                }

                try {
                    progress.report({ message: 'Downloading reconup installer…' });
                    await this.runInBash(bash, `curl -fsSL ${RECONUP_INSTALLER_URL} | bash`);

                    progress.report({ message: 'Installing recon via reconup…' });
                    const reconupBin = path.join(os.homedir(), '.recon', 'bin', 'reconup');
                    await this.runInBash(bash, `"${reconupBin}"`);

                    this.invalidate();
                    if (this.isAvailableSync()) {
                        vscode.window.showInformationMessage('Recon CLI installed.');
                        return true;
                    }
                    vscode.window.showWarningMessage(
                        'reconup finished but `recon` is still not on PATH. Try restarting VS Code so it picks up the updated shell PATH.'
                    );
                    return false;
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Recon CLI install failed: ${msg}`);
                    return false;
                }
            }
        );
    }

    private findBash(): string | null {
        if (process.platform !== 'win32') {
            return process.env.SHELL || '/bin/bash';
        }
        // Common Git Bash locations.
        const candidates = [
            'C:\\Program Files\\Git\\bin\\bash.exe',
            'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
            path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Git', 'bin', 'bash.exe')
        ];
        for (const p of candidates) {
            try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* try next */ }
        }
        return null;
    }

    private runInBash(bash: string, command: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const child = spawn(bash, ['-lc', command], {
                env: { ...process.env, PATH: getEnvironmentPath() },
                stdio: ['ignore', 'pipe', 'pipe']
            });
            let stderr = '';
            child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
            // We don't need to surface stdout — reconup is fairly quiet.
            child.on('error', (err) => reject(err));
            child.on('close', (code) => {
                if (code === 0) { resolve(); }
                else { reject(new Error(`exit ${code}${stderr ? ' — ' + stderr.trim().slice(0, 300) : ''}`)); }
            });
        });
    }
}
