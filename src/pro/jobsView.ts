import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { AuthService } from '../services/authService';
import { Job, JobsResponse, Share, SharesResponse, NewJobRequest } from './types';
import { proxyRequest, downloadAndExtractCorpus, RECON_URL } from './utils';
import { getFoundryConfigPath, getTestFolder, getUid, prepareTrace } from '../utils';
import { Fuzzer } from '@recon-fuzz/log-parser';

export class JobsViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'recon-pro.jobs';
    private _view?: vscode.WebviewView;
    private refreshInterval?: NodeJS.Timeout;
    private shares: Share[] = [];
    private jobs: Job[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly authService: AuthService
    ) {
        // Only start auto-refresh based on Pro status
        this.updateRefreshState();
        
        // Listen for auth state changes to update refresh behavior
        authService.onAuthStateChanged(state => {
            this.updateRefreshState();
        });
    }

    private updateRefreshState() {
        // Clear any existing interval first
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = undefined;
        }

        // Only start auto-refresh if user is Pro
        if (this.authService.getAuthState().isPro) {
            this.startAutoRefresh();
        }
    }

    private startAutoRefresh() {
        // Refresh every 30 seconds
        this.refreshInterval = setInterval(() => this.refreshJobs(), 30000);
    }

    private async getShares(): Promise<Share[]> {
        const token = await this.authService.getAccessToken();
        if (!token) { return []; }

        const response = await proxyRequest('GET', '/shares/', token);
        const data: SharesResponse = await response.json();
        return data.data;
    }

    private async createShare(jobId: string): Promise<void> {
        const token = await this.authService.getAccessToken();
        if (!token) { return; }

        await proxyRequest('POST', '/shares/', token, { jobId });
    }

    private async createNewJob(jobData: NewJobRequest): Promise<void> {
        const token = await this.authService.getAccessToken();
        if (!token) {
            vscode.window.showErrorMessage('Authentication token not available');
            return;
        }

        try {
            // First check if repository is accessible
            const canCloneResponse = await proxyRequest('POST', '/jobs/canclone/', token, {
                orgName: jobData.orgName,
                repoName: jobData.repoName
            });

            const canCloneData = await canCloneResponse.json();

            if (!canCloneData.data?.hasAccess) {
                // Send error message to webview without closing modal
                this._view?.webview.postMessage({
                    type: 'jobCreationError',
                    message: 'Cannot access this repository. Please make sure the repo exists and if it is private, install the Recon GitHub App first.',
                    installUrl: 'https://github.com/apps/recon-staging/installations/new/'
                });
                return;
            }

            // If repository is accessible, proceed with job creation
            const data = {
                orgName: jobData.orgName,
                repoName: jobData.repoName,
                ref: jobData.ref,
                directory: jobData.directory || '',
                fuzzerArgs: {},
                preprocess: jobData.preprocess || '',
                label: jobData.label || '',
                recipeId: null
            }
            switch (jobData.jobType) {
                case 'medusa':
                    data.fuzzerArgs = {
                        config: jobData.config || '',
                        timeout: jobData.timeout || '',
                        targetCorpus: jobData.targetCorpus || '',
                    };
                    break;
                case 'echidna':
                    data.fuzzerArgs = {
                        pathToTester: jobData.pathToTester || '',
                        config: jobData.config || '',
                        contract: jobData.contract || '',
                        corpusDir: jobData.corpusDir || '',
                        testLimit: jobData.testLimit || '',
                        testMode: jobData.mode || 'config',
                        targetCorpus: jobData.targetCorpus || '',
                        forkMode: jobData.forkMode || 'NONE',
                        rpcUrl: jobData.rpcUrl || '',
                        forkBlock: jobData.forkBlock || '',
                        forkReplacement: jobData.forkReplacement || false,
                    };
                    break;
                case 'foundry':
                    data.fuzzerArgs = {
                        contract: jobData.contract || '',
                        runs: jobData.runs || '',
                        seed: jobData.seed || '',
                        rpcUrl: jobData.rpcUrl || '',
                        forkMode: jobData.forkMode || 'NONE',
                        forkBlock: jobData.forkBlock || '',
                        verbosity: jobData.verbosity || '-vv',
                        testCommand: jobData.testCommand || '',
                        testTarget: jobData.testTarget || '',
                        preprocess: jobData.preprocess || '',
                        recipeId: null,
                    };
                    break;
                case 'halmos':
                    data.fuzzerArgs = {
                        contract: jobData.contract || '',
                        verbosity: jobData.verbosity || '-vv',
                        preprocess: jobData.preprocess || '',
                        halmosArray: jobData.halmosArray || '',
                        halmosLoops: jobData.halmosLoops || '',
                        halmosPrefix: jobData.halmosPrefix || '',
                    };
                    break;
                case 'kontrol':
                    data.fuzzerArgs = {
                        preprocess: jobData.preprocess || '',
                        kontrolTest: jobData.kontrolTest || '',
                    };
                    break;
                default:
                    throw new Error(`Unknown job type: ${jobData.jobType}`);
            }
            await proxyRequest('POST', `/jobs/${jobData.jobType}`, token, data);

            // Close the modal after successful job creation
            this._view?.webview.postMessage({ type: 'closeModal' });

            await this.refreshJobs();
            vscode.window.showInformationMessage('Job submitted successfully!');
        } catch (error) {
            console.error('Error creating job:', error);
            this._view?.webview.postMessage({
                type: 'jobCreationError',
                message: 'Cannot access this repository. Please make sure the repo exists and if it is private, install the Recon GitHub App first.',
                installUrl: 'https://github.com/apps/recon-staging/installations/new/'
            });
        }
    }

    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        // Get shares on initial load
        try {
            this.shares = await this.getShares();
        } catch (error) {
            console.error('Failed to fetch shares:', error);
        }

        await this.refreshJobs();

        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.type) {
                case 'refresh':
                    await this.refreshJobs();
                    break;
                case 'openUrl':
                    vscode.env.openExternal(vscode.Uri.parse(message.url));
                    break;
                case 'download-corpus':
                    await this.downloadCorpus(message.url);
                    break;
                case 'download-repro':
                    const job = this.jobs.find(s => s.id === message.jobId);
                    if (!job) {
                        vscode.window.showWarningMessage('No share found for this job');
                        return;
                    }
                    const item = job.brokenProperties[message.idx];
                    let fuzzer = job.fuzzer === 'ECHIDNA' ? Fuzzer.ECHIDNA : job.fuzzer === 'MEDUSA' ? Fuzzer.MEDUSA : null;
                    if (!fuzzer) {
                        vscode.window.showWarningMessage('Fuzzer not supported for repro download');
                        return;
                    }
                    const repros = prepareTrace(fuzzer, getUid(), item.traces, item.brokenProperty);
                    try {
                        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                            vscode.window.showErrorMessage('Please open a workspace to save reproductions.');
                            return;
                        }
                        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
                        const foundryConfigPath = getFoundryConfigPath(workspaceRoot);
                        const foundryRoot = path.dirname(foundryConfigPath);
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
                    break;
                case 'share-job':
                    let share = this.shares.find(s => s.jobId === message.jobId);
                    if (!share) {
                        try {
                            await this.createShare(message.jobId);
                            this.shares = await this.getShares();
                            share = this.shares.find(s => s.jobId === message.jobId);
                        } catch (error) {
                            vscode.window.showErrorMessage(`Failed to create share: ${error}`);
                            return;
                        }
                    }

                    if (share) {
                        const shareUrl = `${RECON_URL}/shares/${share.id}`;
                        await vscode.env.clipboard.writeText(shareUrl);
                        vscode.window.showInformationMessage('Share URL copied to clipboard!');
                    } else {
                        vscode.window.showWarningMessage('Could not create share for this job');
                    }
                    break;
                case 'job-report':
                    let share2 = this.shares.find(s => s.jobId === message.jobId);
                    if (!share2) {
                        try {
                            await this.createShare(message.jobId);
                            this.shares = await this.getShares();
                            share2 = this.shares.find(s => s.jobId === message.jobId);
                        } catch (error) {
                            vscode.window.showErrorMessage(`Failed to create share: ${error}`);
                            return;
                        }
                    }
                    if (share2) {
                        const reportUrl = `${RECON_URL}/shares/${share2.id}/report`;
                        vscode.env.openExternal(vscode.Uri.parse(reportUrl));
                    } else {
                        vscode.window.showWarningMessage('No share found for this job');
                    }
                    break;
                case 'stopJob':
                    await this.stopJob(message.jobId);
                    break;
                case 'new-job':
                    this._view?.webview.postMessage({ type: 'showModal' });
                    break;
                case 'createNewJob':
                    await this.createNewJob(message.jobData);
                    break;
            }
        });
    }

    private async downloadCorpus(url: string): Promise<void> {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('Please open a workspace to download corpus files.');
            return;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;

        try {
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Downloading corpus...",
                cancellable: false
            }, async (progress) => {
                progress.report({ increment: 0 });

                const extractedPath = await downloadAndExtractCorpus(url, workspaceRoot);

                progress.report({ increment: 100 });
                vscode.window.showInformationMessage(`Corpus downloaded and extracted to ${extractedPath}`);
            });
        } catch (error) {
            console.error('Error downloading corpus:', error);
            vscode.window.showErrorMessage(`Failed to download corpus: ${error}`);
        }
    }

    dispose() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
        }
    }

    private async getJobs(): Promise<Job[]> {
        const token = await this.authService.getAccessToken();
        if (!token) { return []; }

        const response = await proxyRequest('GET', '/jobs', token);
        const data: JobsResponse = await response.json();
        this.jobs = data.data;
        return data.data;
    }

    private async stopJob(jobId: string): Promise<void> {
        const token = await this.authService.getAccessToken();
        if (!token) { return; }

        try {
            await proxyRequest('PUT', `/jobs/stop/${jobId}`, token, {});
            await this.refreshJobs();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to stop job: ${error}`);
        }
    }

    private async refreshJobs() {
        if (!this._view) { return; }
        
        // Double check the user is still Pro before refreshing
        if (!this.authService.getAuthState().isPro) {
            return;
        }

        try {
            const [jobs, shares, currentRepo] = await Promise.all([
                this.getJobs(),
                this.getShares(),
                this.getCurrentRepo()
            ]);
            this.shares = shares;

            if (this._view.webview.html) {
                const jobsListHtml = this.renderJobs(jobs, currentRepo);
                this._view.webview.postMessage({
                    type: 'updateJobsList',
                    html: jobsListHtml,
                    currentRepo: currentRepo
                });
            } else {
                const html = this._getHtmlForWebview(jobs, currentRepo);
                this._view.webview.html = html;
            }

        } catch (error) {
            vscode.window.showErrorMessage(`Failed to refresh data: ${error}`);
        }
    }

    private async getCurrentRepo(): Promise<{ orgName: string, repoName: string, ref?: string }> {
        const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
        if (!gitExtension) {
            return {
                orgName: '',
                repoName: '',
                ref: ''
            };
        }

        const api = gitExtension.getAPI(1);
        if (!api) {
            return {
                orgName: '',
                repoName: '',
                ref: ''
            };
        }

        const repo = api.repositories.find((r: { rootUri: { path: string | undefined; }; }) => r.rootUri.path === vscode.workspace.workspaceFolders?.[0].uri.path);
        if (!repo) {
            return {
                orgName: '',
                repoName: '',
                ref: ''
            };
        }

        const head = repo.state.HEAD;
        const remote = repo.state.remotes?.[0]?.fetchUrl;

        if (!remote) {
            return {
                orgName: '',
                repoName: '',
                ref: ''
            };
        }

        const urlMatch = remote.match(/(?:github\.com[:/])([^/]+)\/([^.]+)(?:\.git)?$/);
        if (!urlMatch) {
            return {
                ref: '',
                orgName: '',
                repoName: ''
            };
        }

        return {
            orgName: urlMatch[1],
            repoName: urlMatch[2],
            ref: head.name
        };
    }

    private _getHtmlForWebview(jobs: Job[], currentRepo: { orgName: string, repoName: string, ref?: string }): string {
        const toolkitUri = this._view?.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/webview-ui-toolkit', 'dist', 'toolkit.min.js')
        );

        const codiconsUri = this._view?.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
        );

        return `<!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width,initial-scale=1.0">
            <script type="module" src="${toolkitUri}"></script>
            <link href="${codiconsUri}" rel="stylesheet" />
            <style>
                body { padding: 0; }
                .jobs-list {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                    padding: 8px;
                }
                .job-card {
                    padding: 12px;
                    border: 1px solid var(--vscode-widget-border);
                    border-radius: 4px;
                    background: var(--vscode-editor-background);
                }
                .job-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 8px;
                }
                .job-title {
                    font-weight: 600;
                }
                .job-status-container {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .job-status {
                    font-size: 10px;
                    font-weight: bold;
                    color: white;
                    padding: 2px 6px;
                    border-radius: 3px;
                }
                .status-started { background: rgba(59, 129, 195, 0.8)); }
                .status-running { background:rgba(204, 156, 23, 0.8); }
                .status-success { background: rgba(16, 148, 16, 0.8); }
                .status-failed { background: rgba(235, 55, 23, 0.8); }
                .status-stopped { background: rgba(119, 119, 119, 0.8); }
                .status-queued { background: rgba(0, 0, 0, 0.8); }
                .terminate-btn {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    font-size: 10px;
                    padding: 2px 6px;
                    border-radius: 3px;
                    background: rgba(235, 55, 23, 0.4);
                    color: var(--vscode-button-foreground);
                    cursor: pointer;
                    border: none;
                }
                .terminate-btn:hover {
                    background: rgba(235, 55, 23, 0.7);
                }
                .job-info {
                    font-size: 12px;
                    opacity: 0.8;
                }
                .job-links {
                    margin-top: 8px;
                    display: flex;
                    gap: 8px;
                    align-items: center;
                    justify-content: flex-start;
                }
                .job-link {
                    opacity: 0.8;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    padding: 4px;
                    border-radius: 3px;
                }
                .job-link:hover {
                    opacity: 1;
                    background: var(--vscode-toolbar-hoverBackground);
                }
                .share-link {
                    margin-left: auto; /* Push to the right */
                }
                .broken-properties {
                    margin-top: 8px;
                    padding-top: 8px;
                    border-top: 1px solid var(--vscode-widget-border);
                }
                .broken-property {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 8px;
                    font-size: 12px;
                    padding: 4px 8px;
                    margin: 4px 0;
                    background: var(--vscode-inputValidation-errorBackground);
                    border-radius: 3px;
                    color: var(--vscode-inputValidation-errorForeground);
                    line-height: 1.4;
                }
                .broken-property-content {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    min-width: 0; /* Enable flex item shrinking */
                }
                .broken-property-content span {
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .repro-button {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    font-size: 10px;
                    padding: 2px 6px;
                    border-radius: 3px;
                    background: rgba(228, 203, 63, 0.4);
                    color: var(--vscode-button-foreground);
                    cursor: pointer;
                    border: none;
                }
                .repro-button:hover {
                    background: rgba(228, 203, 63, 0.7);
                }
                .job-progress {
                    margin-top: 8px;
                    background: rgba(255, 255, 255, 0.1);
                    border-radius: 2px;
                    height: 4px;
                    overflow: hidden;
                    position: relative;
                    width: 100%;
                }
                .job-progress-bar {
                    position: absolute;
                    left: 0;
                    top: 0;
                    height: 100%;
                    background: var(--vscode-progressBar-background);
                    transition: width 0.3s ease;
                }
                .job-progress-text {
                    font-size: 11px;
                    opacity: 0.8;
                    margin-top: 4px;
                }
                .sticky-header {
                    position: sticky;
                    top: 0;
                    background: var(--vscode-editor-background);
                    padding: 8px;
                    border-bottom: 1px solid var(--vscode-widget-border);
                    z-index: 100;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                }
                .header-actions {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .action-btn {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 24px;
                    height: 24px;
                    border-radius: 4px;
                    border: none;
                    background: none;
                    color: var(--vscode-foreground);
                    cursor: pointer;
                    opacity: 0.8;
                }
                .action-btn:hover {
                    opacity: 1;
                    background: var(--vscode-toolbar-hoverBackground);
                }
                .loading-spinner {
                    display: inline-block;
                    width: 14px;
                    height: 14px;
                    border: 2px solid rgba(255, 255, 255, 0.3);
                    border-radius: 50%;
                    border-top-color: var(--vscode-button-foreground);
                    animation: spin 1s ease-in-out infinite;
                }
                @keyframes spin {
                    to { transform: rotate(360deg); }
                }
                .button-content {
                    min-width: 120px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 6px;
                }
                .no-jobs {
                    padding: 20px;
                    text-align: center;
                    color: var(--vscode-descriptionForeground);
                    font-style: italic;
                }
                .modal {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.5);
                    display: flex;
                    justify-content: center;
                    align-items: flex-start;
                    z-index: 1000;
                    overflow-y: auto;
                }
                .modal-content {
                    background: var(--vscode-editorWidget-background);
                    padding: 12px;
                    width: 100%;
                    height: calc(100% - 24px);
                    overflow-y: auto;
                    border: none;
                }
                .form-group {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    margin-bottom: 8px;
                    padding: 4px 0;
                }
                .form-group label {
                    width: 100%;
                    max-width: 90px;
                    text-align: right;
                    font-size: 12px;
                    opacity: 0.9;
                }
                .form-group input,
                .form-group select,
                .form-group input[type="checkbox"] {
                    flex: 1;
                    height: 24px;
                    padding: 0 8px;
                    background: var(--vscode-input-background);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 2px;
                    color: var(--vscode-input-foreground);
                    font-size: 12px;
                    box-sizing: border-box;
                }
                .form-group input[type="checkbox"] {
                    width: 24px;
                    min-width: 24px;
                    flex: 0;
                    margin: 0;
                    padding: 0;
                    accent-color: var(--vscode-inputOption-activeBackground);
                }
                .form-group input:focus,
                .form-group select:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                    border-color: transparent;
                }
                .form-actions {
                    position: sticky;
                    bottom: 0;
                    padding: 16px 0;
                    border-top: 1px solid var(--vscode-widget-border);
                    margin-top: 20px;
                    display: flex;
                    justify-content: flex-end;
                    gap: 8px;
                }
                .info-box {
                    margin: 8px;
                    padding: 12px;
                    font-size: 12px;
                    background: var(--vscode-banner-background);
                    border-radius: 4px;
                }
                .info-box ul {
                    margin: 8px 0;
                    padding-left: 20px;
                }
                .info-box ul li {
                    margin-bottom: 4px;
                }
                .modal-header {
                    top: 0;
                    background: var(--vscode-editor-background);
                    padding: 16px 0;
                    border-bottom: 1px solid var(--vscode-widget-border);
                    z-index: 10;
                }
                .error-message {
                    color: var(--vscode-errorForeground);
                    background: var(--vscode-inputValidation-errorBackground);
                    border: 1px solid var(--vscode-inputValidation-errorBorder);
                    padding: 8px 12px;
                    margin: 8px 0;
                    border-radius: 4px;
                    display: none;
                    font-size: 12px;
                }
                .error-message a {
                    color: var(--vscode-textLink-foreground);
                    text-decoration: underline;
                }
            </style>
        </head>
        <body>
            <div class="sticky-header">
                <vscode-checkbox id="show-all-jobs" onchange="toggleJobsFilter(this.checked)">
                    Show all jobs
                </vscode-checkbox>
                <div class="header-actions">
                    <button class="action-btn" onclick="refresh()" title="Refresh jobs">
                        <i class="codicon codicon-refresh"></i>
                    </button>
                    <button class="action-btn" onclick="addNewJob()" title="Create new job">
                        <i class="codicon codicon-plus"></i>
                    </button>
                </div>
            </div>
            
            <div id="jobs-container" class="jobs-list">
                ${this.renderJobs(jobs, currentRepo)}
            </div>
            
            <div id="new-job-modal" class="modal" style="display: none;">
                <div class="modal-content">
                    <h4>Create a New Job</h2>
                    
                    <div id="job-creation-error" class="error-message"></div>
                    
                    <div class="modal-body">
                        <div class="info-box">
                            <span><strong>Important:</strong></span>
                            <ul>
                                <li>Push your changes to remote branch before creating a job</li>
                                <li>For private repositories, install the <a href="#" onclick="openUrl('https://getrecon.xyz/dashboard/installs')">Recon GitHub App</a> first</li>
                            </ul>
                        </div>
                        <form id="new-job-form">
                            <div class="form-group">
                                <label>Job Type:</label>
                                <select id="job-type" onchange="updateJobForm(this.value)">
                                    <option value="medusa">Medusa</option>
                                    <option value="echidna">Echidna</option>
                                    <option value="foundry">Foundry</option>
                                    <option value="halmos">Halmos</option>
                                    <option value="kontrol">Kontrol</option>
                                </select>
                            </div>

                            <div class="form-group">
                                <label>Label:</label>
                                <input type="text" id="label">
                            </div>

                            <div class="form-group">
                                <label>Organization:</label>
                                <input type="text" id="org-name" value="${currentRepo.orgName}">
                            </div>

                            <div class="form-group">
                                <label>Repository:</label>
                                <input type="text" id="repo-name" value="${currentRepo.repoName}">
                            </div>

                            <div class="form-group">
                                <label>Branch:</label>
                                <input type="text" id="branch-name" value="${currentRepo.ref || ''}">
                            </div>

                            <div class="form-group">
                                <label>Directory:</label>
                                <input type="text" id="directory" value="${this.getFoundryDir()}">
                            </div>

                            <div id="medusa-form" class="fuzzer-form">
                                ${this.getMedusaForm(jobs, currentRepo)}
                            </div>

                            <div id="echidna-form" class="fuzzer-form" style="display:none">
                                ${this.getEchidnaForm(jobs, currentRepo)}
                            </div>

                            <div id="foundry-form" class="fuzzer-form" style="display:none">
                                ${this.getFoundryForm()}
                            </div>

                            <div id="halmos-form" class="fuzzer-form" style="display:none">
                                ${this.getHalmosForm()}
                            </div>

                            <div id="kontrol-form" class="fuzzer-form" style="display:none">
                                ${this.getKontrolForm()}
                            </div>

                            <div class="form-actions">
                                <vscode-button appearance="secondary" onclick="closeModal()">Cancel</vscode-button>
                                <vscode-button id="submit-job-btn" appearance="primary" onclick="submitJob()">
                                    <span class="button-content">Create Job</span>
                                </vscode-button>
                            </div>
                        </form>
                    </div>
                </div>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                
                const state = vscode.getState() || { 
                    modalOpen: false,
                    showAllJobs: false,
                    formData: {}
                };

                function openUrl(url) {
                    vscode.postMessage({ type: 'openUrl', url });
                }

                function refresh() {
                    vscode.postMessage({ type: 'refresh' });
                }

                function stopJob(jobId) {
                    vscode.postMessage({ 
                        type: 'stopJob',
                        jobId: jobId 
                    });
                }

                function downloadRepro(jobId, idx) {
                    vscode.postMessage({ 
                        type: 'download-repro',
                        jobId: jobId,
                        idx: idx
                    });
                }

                function downloadCorpus(url) {
                    vscode.postMessage({ 
                        type: 'download-corpus',
                        url: url
                    });
                }

                function shareJob(jobId) {
                    vscode.postMessage({ 
                        type: 'share-job',
                        jobId: jobId 
                    });
                }
                function jobReport(jobId) {
                    vscode.postMessage({ 
                        type: 'job-report',
                        jobId: jobId 
                    });
                }

                function addNewJob() {
                    document.getElementById('new-job-modal').style.display = 'flex';
                    state.modalOpen = true;
                    vscode.setState(state);
                }

                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.type) {
                        case 'showModal':
                            document.getElementById('new-job-modal').style.display = 'flex';
                            state.modalOpen = true;
                            vscode.setState(state);
                            break;
                        case 'closeModal':
                            closeModal();
                            break;
                        case 'updateJobsList':
                            document.getElementById('jobs-container').innerHTML = message.html;
                            filterJobs(message.currentRepo);
                            break;
                        case 'jobCreationError':
                            const submitBtn = document.getElementById('submit-job-btn');
                            if (submitBtn) {
                                const btnContent = submitBtn.querySelector('.button-content');
                                btnContent.textContent = 'Create Job';
                                submitBtn.disabled = false;
                            }
                            
                            const errorDiv = document.getElementById('job-creation-error');
                            if (errorDiv) {
                                if (message.installUrl) {
                                    errorDiv.innerHTML = \`\${message.message} <a href="#" onclick="openUrl('\${message.installUrl}')">Install Recon GitHub App</a>\`;
                                } else {
                                    errorDiv.textContent = message.message;
                                }
                                errorDiv.style.display = 'block';
                                
                                const modalContent = document.querySelector('.modal-content');
                                if (modalContent) {
                                    modalContent.scrollTop = 0;
                                }
                            }
                            break;
                    }
                });

                let showAllJobs = state.showAllJobs || false;
                let currentRepo = ${JSON.stringify(currentRepo)};

                function toggleJobsFilter(checked) {
                    showAllJobs = checked;
                    state.showAllJobs = checked;
                    vscode.setState(state);
                    filterJobs();
                }

                function filterJobs(repo) {
                    const repoToFilter = repo || currentRepo;
                    const jobCards = document.querySelectorAll('.job-card');
                    let visibleCount = 0;

                    jobCards.forEach(card => {
                        const repoName = card.dataset.repoName;
                        const orgName = card.dataset.orgName;
                        
                        if (showAllJobs || (repoName === repoToFilter.repoName && orgName === repoToFilter.orgName)) {
                            card.style.display = '';
                            visibleCount++;
                        } else {
                            card.style.display = 'none';
                        }
                    });

                    const noJobsMsg = document.querySelector('.no-jobs');
                    if (visibleCount === 0) {
                        if (!noJobsMsg) {
                            const msg = document.createElement('div');
                            msg.className = 'no-jobs';
                            msg.textContent = showAllJobs ? 'No jobs found' : 'No jobs found for current repository';
                            document.getElementById('jobs-container').appendChild(msg);
                        }
                    } else if (noJobsMsg) {
                        noJobsMsg.remove();
                    }
                }

                function closeModal() {
                    document.getElementById('new-job-modal').style.display = 'none';
                    
                    const submitBtn = document.getElementById('submit-job-btn');
                    if (submitBtn) {
                        const btnContent = submitBtn.querySelector('.button-content');
                        btnContent.textContent = 'Create Job';
                        submitBtn.disabled = false;
                    }
                    
                    const errorDiv = document.getElementById('job-creation-error');
                    if (errorDiv) {
                        errorDiv.style.display = 'none';
                    }
                    
                    state.modalOpen = false;
                    vscode.setState(state);
                }

                function submitJob() {
                    const errorDiv = document.getElementById('job-creation-error');
                    if (errorDiv) {
                        errorDiv.style.display = 'none';
                    }
                    
                    const submitBtn = document.getElementById('submit-job-btn');
                    if (submitBtn) {
                        const btnContent = submitBtn.querySelector('.button-content');
                        btnContent.innerHTML = '<span class="loading-spinner"></span> Creating...';
                        submitBtn.disabled = true;
                    }
                    
                    const jobType = document.getElementById('job-type').value;
                    const label = document.getElementById('label').value;
                    const orgName = document.getElementById('org-name').value;
                    const repoName = document.getElementById('repo-name').value;
                    const ref = document.getElementById('branch-name').value;
                    const directory = document.getElementById('directory').value;

                    const jobData = {
                        jobType,
                        label,
                        orgName,
                        repoName,
                        ref,
                        directory
                    };

                    switch(jobType) {
                        case 'medusa':
                            jobData.config = document.getElementById('medusa-config').value;
                            jobData.timeout = document.getElementById('medusa-timeout').value;
                            jobData.targetCorpus = document.getElementById('medusa-corpus').value;
                            jobData.preprocess = document.getElementById('medusa-preprocess').value;
                            break;
                        case 'echidna':
                            jobData.config = document.getElementById('echidna-config').value;
                            jobData.pathToTester = document.getElementById('echidna-contract-path').value;
                            jobData.contract = document.getElementById('echidna-contract').value;
                            jobData.corpusDir = document.getElementById('echidna-corpus-dir').value;
                            jobData.testLimit = document.getElementById('echidna-test-limit').value;
                            jobData.mode = document.getElementById('echidna-mode').value;
                            jobData.targetCorpus = document.getElementById('echidna-corpus').value;
                            jobData.forkMode = document.getElementById('echidna-fork').value;
                            jobData.forkReplacement = document.getElementById('echidna-fork-replacement').checked;
                            
                            if (jobData.forkMode === 'CUSTOM') {
                                jobData.rpcUrl = document.getElementById('echidna-rpc-url').value;
                            }
                            
                            if (jobData.forkMode !== 'NONE') {
                                jobData.forkBlock = document.getElementById('echidna-fork-block').value;
                            }
                            
                            jobData.preprocess = document.getElementById('echidna-preprocess').value;
                            break;
                        case 'foundry':
                            jobData.contract = document.getElementById('foundry-contract').value;
                            jobData.runs = document.getElementById('foundry-runs').value;
                            jobData.seed = document.getElementById('foundry-seed').value;
                            jobData.testCommand = document.getElementById('foundry-test-command').value;
                            
                            if (jobData.testCommand === '--match-test') {
                                jobData.testTarget = document.getElementById('foundry-test-target').value;
                            }
                            
                            jobData.verbosity = document.getElementById('foundry-verbosity').value;
                            jobData.forkMode = document.getElementById('foundry-fork').value;
                            
                            if (jobData.forkMode !== 'NONE') {
                                jobData.forkBlock = document.getElementById('foundry-fork-block').value;
                            }
                            
                            jobData.preprocess = document.getElementById('foundry-preprocess').value;
                            break;
                        case 'halmos':
                            jobData.contract = document.getElementById('halmos-contract').value;
                            jobData.halmosPrefix = document.getElementById('halmos-prefix').value;
                            jobData.halmosArray = document.getElementById('halmos-array').value;
                            jobData.halmosLoops = document.getElementById('halmos-loops').value;
                            jobData.verbosity = document.getElementById('halmos-verbosity').value;
                            jobData.preprocess = document.getElementById('halmos-preprocess').value;
                            break;
                        case 'kontrol':
                            jobData.kontrolTest = document.getElementById('kontrol-test').value;
                            jobData.preprocess = document.getElementById('kontrol-preprocess').value;
                            break;
                    }

                    vscode.postMessage({ 
                        type: 'createNewJob',
                        jobData: jobData
                    });
                }

                function updateJobForm(value) {
                    document.querySelectorAll('.fuzzer-form').forEach(form => {
                        form.style.display = 'none';
                    });

                    switch (value) {
                        case 'medusa':
                            document.getElementById('medusa-form').style.display = 'block';
                            break;
                        case 'echidna':
                            document.getElementById('echidna-form').style.display = 'block';
                            break;
                        case 'foundry':
                            document.getElementById('foundry-form').style.display = 'block';
                            break;
                        case 'halmos':
                            document.getElementById('halmos-form').style.display = 'block';
                            break;
                        case 'kontrol':
                            document.getElementById('kontrol-form').style.display = 'block';
                            break;
                    }

                    const forkSelect = document.getElementById('echidna-fork');
                    if (forkSelect) {
                        toggleForkOptions(forkSelect.value);
                    }

                    const testCommandSelect = document.getElementById('foundry-test-command');
                    if (testCommandSelect) {
                        toggleTestTarget(testCommandSelect.value);
                    }
                    
                    state.formData.jobType = value;
                    vscode.setState(state);
                }

                function toggleForkOptions(value) {
                    const rpcUrlGroup = document.getElementById('rpc-url-group');
                    const forkBlockGroup = document.getElementById('fork-block-group');
                    
                    if (!rpcUrlGroup || !forkBlockGroup) return;

                    if (value === 'NONE') {
                        rpcUrlGroup.style.display = 'none';
                        forkBlockGroup.style.display = 'none';
                    } else {
                        rpcUrlGroup.style.display = value === 'CUSTOM' ? 'flex' : 'none';
                        forkBlockGroup.style.display = 'flex';
                    }
                }

                function toggleTestTarget(value) {
                    const targetGroup = document.getElementById('test-target-group');
                    if (targetGroup) {
                        targetGroup.style.display = value === '--match-test' ? 'flex' : 'none';
                    }
                }

                document.addEventListener('DOMContentLoaded', () => {
                    const showAllJobsCheckbox = document.getElementById('show-all-jobs');
                    if (showAllJobsCheckbox) {
                        showAllJobsCheckbox.checked = state.showAllJobs;
                    }
                    
                    if (state.modalOpen) {
                        document.getElementById('new-job-modal').style.display = 'flex';
                    }
                    
                    if (state.formData && state.formData.jobType) {
                        const jobTypeSelect = document.getElementById('job-type');
                        if (jobTypeSelect) {
                            jobTypeSelect.value = state.formData.jobType;
                            updateJobForm(state.formData.jobType);
                        }
                    }
                    
                    filterJobs();
                });
            </script>
        </body>
        </html>`;
    }

    private renderJobs(jobs: Job[], currentRepo: { orgName: string, repoName: string, ref?: string }): string {
        if (jobs.length === 0) {
            return `<div class="no-jobs">No jobs found</div>`;
        }

        return jobs.map(job => `
            <div class="job-card" 
                 data-repo-name="${job.repoName}" 
                 data-org-name="${job.orgName}">
                <div class="job-header">
                    <div class="job-title">${job.label || 'Untitled Job'}</div>
                    <div class="job-status-container">
                        ${job.status === 'RUNNING' ? `
                            <button class="terminate-btn" onclick="stopJob('${job.id}')">
                                <i class="codicon codicon-stop-circle"></i>
                                Terminate
                            </button>
                        ` : ''}
                        <div class="job-status status-${job.status.toLowerCase()}">${job.status}</div>
                    </div>
                </div>
                <div class="job-info">
                    ${job.repoName} (${job.ref}) - ${job.fuzzer}
                    ${job.createdAt ? `<br>Created: ${new Date(job.createdAt).toLocaleString()}` : ''}
                    ${job.testsDuration ? `<br>Duration: ${job.testsDuration}` : ''}
                    ${job.testsPassed !== null ? `<br>Tests: ${job.testsPassed} passed, ${job.testsFailed} failed` : ''}
                </div>
                ${(() => {
                const testLimit = parseInt(job.fuzzerArgs?.testLimit || '0');
                if (testLimit > 0 && job.numberOfTests !== null) {
                    const isCompleted = job.status === 'SUCCESS' || job.status === 'FAILED' || job.status === 'STOPPED';
                    const progress = isCompleted ? 100 : Math.min((job.numberOfTests / testLimit) * 100, 100);
                    return `
                            <div class="job-progress">
                                <div class="job-progress-bar" style="width: ${progress}%; background: ${progress < 100 ? '#5c25d2' : '#2ea043'};"></div>
                            </div>
                            <div class="job-progress-text">
                                ${job.numberOfTests.toLocaleString()} / ${testLimit.toLocaleString()} tests (${progress.toFixed(1)}%)
                            </div>
                        `;
                }
                return '';
            })()}
                ${job.brokenProperties.length > 0 ? `
                    <div class="broken-properties">
                        <div class="job-info">Broken Properties:</div>
                        ${job.brokenProperties.map((prop, idx) => `
                            <div class="broken-property">
                                <div class="broken-property-content">
                                    <i class="codicon codicon-error"></i>
                                    <span>${prop.brokenProperty}</span>
                                </div>
                                <button class="repro-button" onclick="downloadRepro('${job.id}', ${idx})">
                                    <i class="codicon codicon-cloud-download"></i>
                                    Repro
                                </button>
                            </div>
                        `).join('')}
                    </div>
                ` : ''}
                <div class="job-links">
                    ${job.corpusUrl ? `
                        <span class="job-link" onclick="downloadCorpus('${job.corpusUrl}')" title="Download Corpus">
                            <i class="codicon codicon-file-zip"></i>
                        </span>
                    ` : ''}
                    ${job.coverageUrl ? `
                        <span class="job-link" onclick="openUrl('${job.coverageUrl}')" title="View Coverage">
                            <i class="codicon codicon-symbol-event"></i>
                        </span>
                    ` : ''}
                    ${job.logsUrl ? `
                        <span class="job-link" onclick="openUrl('${job.logsUrl}')" title="View Logs">
                            <i class="codicon codicon-output"></i>
                        </span>
                    ` : ''}
                    <span class="job-link" onclick="jobReport('${job.id}')" title="View Full Report">
                        <i class="codicon codicon-repo"></i>
                    </span>
                    <span class="job-link share-link" onclick="shareJob('${job.id}')">
                        <i class="codicon codicon-link"></i> Share
                    </span>
                </div>
            </div>
        `).join('');
    }

    private getFoundryDir(): string {
        const config = vscode.workspace.getConfiguration('recon');
        const foundryPath = config.get<string>('foundryConfigPath', 'foundry.toml');
        return foundryPath.replace(/foundry\.toml$/, '');
    }

    private getMedusaForm(jobs: Job[], currentRepo: { orgName: string, repoName: string, ref?: string }): string {
        const relatedJobs = jobs.filter(j =>
            j.orgName === currentRepo.orgName &&
            j.repoName === currentRepo.repoName &&
            j.fuzzer === 'MEDUSA'
        );

        return `
            <div class="form-group">
                <label>Config file:</label>
                <input type="text" id="medusa-config">
            </div>
            <div class="form-group">
                <label>Timeout:</label>
                <input type="number" id="medusa-timeout" value="3600">
            </div>
            <div class="form-group">
                <label>Corpus Re-use Job ID:</label>
                <select id="medusa-corpus">
                    <option value="">None</option>
                    ${relatedJobs.map(job => `
                        <option value="${job.id}">${job.label || job.id.substring(0, 4)} - ${new Date(job.createdAt).toLocaleString()}</option>
                    `).join('')}
                </select>
            </div>
            <div class="form-group">
                <label>Custom pre-install process:</label>
                <select id="medusa-preprocess">
                    <option value="">No preprocess</option>
                    <option value="yarn install --ignore-scripts">yarn install --ignore-scripts</option>
                </select>
            </div>
        `;
    }

    private getEchidnaForm(jobs: Job[], currentRepo: { orgName: string, repoName: string, ref?: string }): string {
        const relatedJobs = jobs.filter(j =>
            j.orgName === currentRepo.orgName &&
            j.repoName === currentRepo.repoName &&
            j.fuzzer === 'ECHIDNA'
        );

        return `
            <div class="form-group">
                <label>Config file:</label>
                <input type="text" id="echidna-config">
            </div>
            <div class="form-group">
                <label>Path To Test Contract:</label>
                <input type="text" id="echidna-contract-path">
            </div>
            <div class="form-group">
                <label>Tester Contract Name:</label>
                <input type="text" id="echidna-contract">
            </div>
            <div class="form-group">
                <label>Corpus Dir:</label>
                <input type="text" id="echidna-corpus-dir">
            </div>
            <div class="form-group">
                <label>Test Limit:</label>
                <input type="number" id="echidna-test-limit" value="100000">
            </div>
            <div class="form-group">
                <label>Select Mode:</label>
                <select id="echidna-mode">
                    <option value="config">Use config</option>
                    <option value="exploration">Exploration</option>
                    <option value="optimization">Optimization</option>
                    <option value="assertion">Assertion</option>
                    <option value="property">Property</option>
                </select>
            </div>
            <div class="form-group">
                <label>Corpus Re-use Job ID:</label>
                <select id="echidna-corpus">
                    <option value="">None</option>
                    ${relatedJobs.map(job => `
                        <option value="${job.id}">${job.label || job.id.substring(0, 4)} - ${new Date(job.createdAt).toLocaleString()}</option>
                    `).join('')}
                </select>
            </div>
            <div class="form-group">
                <label>Select Fork Mode:</label>
                <select id="echidna-fork" onchange="toggleForkOptions(this.value)">
                    <option value="NONE">Non-Forked</option>
                    <option value="CUSTOM">Custom RPC URL</option>
                    <option value="MAINNET">Mainnet</option>
                    <option value="OPTIMISM">Optimism</option>
                    <option value="ARBITRUM">Arbitrum</option>
                    <option value="POLYGON">Polygon</option>
                    <option value="BASE">Base</option>
                </select>
            </div>
            <div class="form-group" id="rpc-url-group" style="display: none;">
                <label>RPC URL:</label>
                <input type="text" id="echidna-rpc-url">
            </div>
            <div class="form-group" id="fork-block-group" style="display: none;">
                <label>Fork Block:</label>
                <input type="text" id="echidna-fork-block" value="LATEST">
            </div>
            <div style="margin-bottom: 8px; padding: 4px 0; margin-left:24px;">
                <label title="This allows Recon to dynamically replace the fork block and timestamp in your tester. Requires the use of Recon specific tags.">
                    <input type="checkbox" id="echidna-fork-replacement">
                    Dynamic Block Replacement
                </label>
            </div>
            <div class="form-group">
                <label>Custom pre-install process:</label>
                <select id="echidna-preprocess">
                    <option value="">No preprocess</option>
                    <option value="yarn install --ignore-scripts">yarn install --ignore-scripts</option>
                </select>
            </div>
        `;
    }

    private getFoundryForm(): string {
        return `
            <div class="form-group">
                <label>Tester Contract Name:</label>
                <input type="text" id="foundry-contract">
            </div>
            <div class="form-group">
                <label>Runs:</label>
                <input type="number" id="foundry-runs">
            </div>
            <div class="form-group">
                <label>Seed:</label>
                <input type="text" id="foundry-seed">
            </div>
            <div class="form-group">
                <label>Select test command:</label>
                <select id="foundry-test-command" onchange="toggleTestTarget(this.value)">
                    <option value="">None</option>
                    <option value="--match-test">Match Test</option>
                </select>
            </div>
            <div class="form-group" id="test-target-group" style="display: none;">
                <label>Target Test:</label>
                <input type="text" id="foundry-test-target">
            </div>
            <div class="form-group">
                <label>Select verbosity:</label>
                <select id="foundry-verbosity">
                    <option value="-vv">-vv</option>
                    <option value="-vvv">-vvv</option>
                    <option value="-vvvv">-vvvv</option>
                    <option value="-vvvvv">-vvvvv</option>
                </select>
            </div>
            <div class="form-group">
                <label>Select Fork Mode:</label>
                <select id="foundry-fork" onchange="toggleFoundryForkBlock(this.value)">
                    <option value="NONE">Non-Forked</option>
                    <option value="MAINNET">Mainnet</option>
                    <option value="OPTIMISM">Optimism</option>
                    <option value="ARBITRUM">Arbitrum</option>
                    <option value="POLYGON">Polygon</option>
                    <option value="BASE">Base</option>
                </select>
            </div>
            <div class="form-group" id="foundry-fork-block-group" style="display: none;">
                <label>Fork Block:</label>
                <input type="text" id="foundry-fork-block" value="LATEST">
            </div>
            <div class="form-group">
                <label>Custom pre-install process:</label>
                <select id="foundry-preprocess">
                    <option value="">No preprocess</option>
                    <option value="yarn install --ignore-scripts">yarn install --ignore-scripts</option>
                </select>
            </div>
        `;
    }

    private getHalmosForm(): string {
        return `
            <div class="form-group">
                <label>Tester Contract Name:</label>
                <input type="text" id="halmos-contract">
            </div>
            <div class="form-group">
                <label>Tester Function Prefix:</label>
                <input type="text" id="halmos-prefix">
            </div>
            <div class="form-group">
                <label>Array Lengths:</label>
                <input type="text" id="halmos-array">
            </div>
            <div class="form-group">
                <label>Loops:</label>
                <input type="text" id="halmos-loops">
            </div>
            <div class="form-group">
                <label>Select verbosity:</label>
                <select id="halmos-verbosity">
                    <option value="-vv">-vv</option>
                    <option value="-vvv">-vvv</option>
                    <option value="-vvvv">-vvvv</option>
                    <option value="-vvvvv">-vvvvv</option>
                </select>
            </div>
            <div class="form-group">
                <label>Custom pre-install process:</label>
                <select id="halmos-preprocess">
                    <option value="">No preprocess</option>
                    <option value="yarn install --ignore-scripts">yarn install --ignore-scripts</option>
                </select>
            </div>
        `;
    }

    private getKontrolForm(): string {
        return `
            <div class="form-group">
                <label>Target Test:</label>
                <input type="text" id="kontrol-test">
            </div>
            <div class="form-group">
                <label>Custom pre-install process:</label>
                <select id="kontrol-preprocess">
                    <option value="">No preprocess</option>
                    <option value="yarn install --ignore-scripts">yarn install --ignore-scripts</option>
                </select>
            </div>
        `;
    }
}
