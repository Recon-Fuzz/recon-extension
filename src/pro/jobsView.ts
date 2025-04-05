import * as vscode from 'vscode';
import { AuthService } from '../services/authService';
import { Job, JobsResponse, Share, SharesResponse, NewJobRequest } from './types';
import { proxyRequest } from './utils';

export class JobsViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'recon-pro.jobs';
    private _view?: vscode.WebviewView;
    private refreshInterval?: NodeJS.Timeout;
    private shares: Share[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly authService: AuthService
    ) {
        // Start auto-refresh when created
        this.startAutoRefresh();
    }

    private startAutoRefresh() {
        // Clear any existing interval
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
        }
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
        if (!token) { return; }

        await proxyRequest('POST', '/jobs', token, jobData);
        await this.refreshJobs();
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
                case 'download-repro':
                    // Handle download repro logic here
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
                        const shareUrl = `https://staging.getrecon.xyz/shares/${share.id}`;
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
                        const reportUrl = `https://staging.getrecon.xyz/shares/${share2.id}/report`;
                        vscode.env.openExternal(vscode.Uri.parse(reportUrl));
                    } else {
                        vscode.window.showWarningMessage('No share found for this job');
                    }
                    break;
                case 'stopJob':
                    await this.stopJob(message.jobId);
                    break;
                case 'new-job':
                    // Show the modal when new-job message is received
                    this._view?.webview.postMessage({ type: 'showModal' });
                    break;
            }
        });
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

        try {
            const [jobs, shares, currentRepo] = await Promise.all([
                this.getJobs(),
                this.getShares(),
                this.getCurrentRepo()
            ]);
            this.shares = shares;

            // Instead of refreshing the entire webview, just update the jobs list
            if (this._view.webview.html) {
                // If webview is already initialized, just update the jobs list
                const jobsListHtml = this.renderJobs(jobs, currentRepo);
                this._view.webview.postMessage({ 
                    type: 'updateJobsList', 
                    html: jobsListHtml, 
                    currentRepo: currentRepo
                });
            } else {
                // First load - initialize the full HTML
                const html = this._getHtmlForWebview(jobs, currentRepo);
                this._view.webview.html = html;
            }

        } catch (error) {
            vscode.window.showErrorMessage(`Failed to refresh data: ${error}`);
        }
    }

    private async getCurrentRepo(): Promise<{orgName: string, repoName: string, ref?: string}> {
        const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
        if (!gitExtension) { return {
            orgName: '',
            repoName: '',
            ref: ''
        }; }

        const api = gitExtension.getAPI(1);
        if (!api) { return {
            orgName: '',
            repoName: '',
            ref: ''
        }; }

        const repo = api.repositories[0];
        if (!repo) { return {
            orgName: '',
            repoName: '',
            ref: ''
        }; }

        const head = repo.state.HEAD;
        const remote = repo.state.remotes?.[0]?.fetchUrl;
        
        if (!remote) {
            return {
                orgName: '',
                repoName: '',
                ref: ''
            };
        }

        // Parse GitHub URL to extract org and repo name
        // Handles formats like:
        // https://github.com/orgName/repoName.git
        // git@github.com:orgName/repoName.git
        const urlMatch = remote.match(/(?:github\.com[:/])([^/]+)\/([^.]+)(?:\.git)?$/);
        if (!urlMatch) {
            // If URL doesn't match GitHub format, return just the branch name
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

    private _getHtmlForWebview(jobs: Job[], currentRepo: {orgName: string, repoName: string, ref?: string}): string {
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
                .status-running { background:rgba(204, 156, 23, 0.8); }
                .status-success { background: rgba(16, 148, 16, 0.8); }
                .status-failed { background: rgba(235, 55, 23, 0.8); }
                .status-stopped { background: rgba(119, 119, 119, 0.8); }
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
                .header-controls {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .add-job-btn {
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
                .add-job-btn:hover {
                    opacity: 1;
                    background: var(--vscode-toolbar-hoverBackground);
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
                    background: var(--vscode-editor-background);
                    padding: 12px;
                    width: 100%;
                    height: 100%;
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
                    background: var(--vscode-editor-background);
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
                .modal-header {
                    top: 0;
                    background: var(--vscode-editor-background);
                    padding: 16px 0;
                    border-bottom: 1px solid var(--vscode-widget-border);
                    z-index: 10;
                }
            </style>
        </head>
        <body>
            <div class="sticky-header">
                <vscode-checkbox id="show-all-jobs" onchange="toggleJobsFilter(this.checked)">
                    Show all jobs
                </vscode-checkbox>
                <button class="add-job-btn" onclick="addNewJob()" title="Create new job">
                    <i class="codicon codicon-plus"></i>
                </button>
            </div>
            
            <!-- Jobs container - this will be the only part that gets refreshed -->
            <div id="jobs-container" class="jobs-list">
                ${this.renderJobs(jobs, currentRepo)}
            </div>
            
            <!-- Modal is now outside the jobs container so it won't be affected by refreshes -->
            <div id="new-job-modal" class="modal" style="display: none;">
                <div class="modal-content">
                    <h4>Create a New Job</h2>
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
                                <input type="text" id="directory" value="${this.getFoundryDir()}" placeholder="Directory path">
                            </div>

                            <!-- Dynamic form sections -->
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
                                <vscode-button appearance="primary" onclick="submitJob()">Create Job</vscode-button>
                            </div>
                        </form>
                    </div>
                </div>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                
                // Initialize state management
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

                function downloadRepro(traces) {
                    vscode.postMessage({ 
                        type: 'download-repro',
                        traces: traces 
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

                // Listen for messages from the extension
                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.type) {
                        case 'showModal':
                            document.getElementById('new-job-modal').style.display = 'flex';
                            state.modalOpen = true;
                            vscode.setState(state);
                            break;
                        case 'updateJobsList':
                            // Update only the jobs container content
                            document.getElementById('jobs-container').innerHTML = message.html;
                            // After updating the jobs list, reapply the filter
                            filterJobs(message.currentRepo);
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
                    // Use the provided repo object or fall back to currentRepo
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

                    // Show/hide no jobs message
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
                    state.modalOpen = false;
                    vscode.setState(state);
                }

                function submitJob() {
                    const jobType = document.getElementById('job-type').value;
                    const orgName = document.getElementById('org-name').value;
                    const repoName = document.getElementById('repo-name').value;
                    const branchName = document.getElementById('branch-name').value;
                    const directory = document.getElementById('directory').value;

                    const jobData = {
                        jobType,
                        orgName,
                        repoName,
                        branchName,
                        directory
                    };

                    vscode.postMessage({ 
                        type: 'new-job',
                        jobData: jobData
                    });

                    closeModal();
                }

                function updateJobForm(value) {
                    // Hide all forms first
                    document.querySelectorAll('.fuzzer-form').forEach(form => {
                        form.style.display = 'none';
                    });

                    // Show the selected form
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

                    // Update specific form controls
                    const forkSelect = document.getElementById('echidna-fork');
                    if (forkSelect) {
                        toggleForkOptions(forkSelect.value);
                    }

                    const testCommandSelect = document.getElementById('foundry-test-command');
                    if (testCommandSelect) {
                        toggleTestTarget(testCommandSelect.value);
                    }
                    
                    // Save the selected job type to state
                    state.formData.jobType = value;
                    vscode.setState(state);
                }

                function toggleForkOptions(value) {
                    const forkOptions = document.getElementById('fork-options');
                    const rpcUrlGroup = document.getElementById('rpc-url-group');
                    const forkBlockGroup = document.getElementById('fork-block-group');
                    
                    if (!forkOptions || !rpcUrlGroup || !forkBlockGroup) return;

                    if (value === 'NONE') {
                        forkOptions.style.display = 'none';
                    } else {
                        forkOptions.style.display = 'block';
                        rpcUrlGroup.style.display = value === 'CUSTOM' ? 'block' : 'none';
                        forkBlockGroup.style.display = value !== 'NONE' ? 'block' : 'none';
                    }
                }

                function toggleTestTarget(value) {
                    const targetGroup = document.getElementById('test-target-group');
                    if (targetGroup) {
                        targetGroup.style.display = value === '--match-test' ? 'block' : 'none';
                    }
                }

                // Initialize the UI based on saved state
                document.addEventListener('DOMContentLoaded', () => {
                    // Restore show all jobs checkbox state
                    const showAllJobsCheckbox = document.getElementById('show-all-jobs');
                    if (showAllJobsCheckbox) {
                        showAllJobsCheckbox.checked = state.showAllJobs;
                    }
                    
                    // Restore modal state
                    if (state.modalOpen) {
                        document.getElementById('new-job-modal').style.display = 'flex';
                    }
                    
                    // Restore job type selection if available
                    if (state.formData && state.formData.jobType) {
                        const jobTypeSelect = document.getElementById('job-type');
                        if (jobTypeSelect) {
                            jobTypeSelect.value = state.formData.jobType;
                            updateJobForm(state.formData.jobType);
                        }
                    }
                    
                    // Apply initial filter
                    filterJobs();
                });
            </script>
        </body>
        </html>`;
    }

    private renderJobs(jobs: Job[], currentRepo: {orgName: string, repoName: string, ref?: string}): string {
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
                    ${job.testsDuration ? `<br>Duration: ${job.testsDuration}` : ''}
                    ${job.testsPassed !== null ? `<br>Tests: ${job.testsPassed} passed, ${job.testsFailed} failed` : ''}
                </div>
                ${(() => {
                    const testLimit = parseInt(job.fuzzerArgs.testLimit || '0');
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
                        ${job.brokenProperties.map(prop => `
                            <div class="broken-property">
                                <div class="broken-property-content">
                                    <i class="codicon codicon-error"></i>
                                    <span>${prop.brokenProperty}</span>
                                </div>
                                <button class="repro-button" onclick="downloadRepro('${prop.traces}')">
                                    <i class="codicon codicon-cloud-download"></i>
                                    Repro
                                </button>
                            </div>
                        `).join('')}
                    </div>
                ` : ''}
                <div class="job-links">
                    ${job.corpusUrl ? `
                        <span class="job-link" onclick="openUrl('${job.corpusUrl}')" title="Download Corpus">
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
        // Remove foundry.toml from the end if it exists
        return foundryPath.replace(/foundry\.toml$/, '');
    }

    private getMedusaForm(jobs: Job[], currentRepo: {orgName: string, repoName: string, ref?: string}): string {
        const relatedJobs = jobs.filter(j => 
            j.orgName === currentRepo.orgName && 
            j.repoName === currentRepo.repoName
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
                        <option value="${job.id}">${job.label || job.id}</option>
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

    private getEchidnaForm(jobs: Job[], currentRepo: {orgName: string, repoName: string, ref?: string}): string {
        const relatedJobs = jobs.filter(j => 
            j.orgName === currentRepo.orgName && 
            j.repoName === currentRepo.repoName
        );

        return `
            <div class="form-group">
                <label>Config file:</label>
                <input type="text" id="echidna-config">
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
                        <option value="${job.id}">${job.label || job.id}</option>
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
            <div id="fork-options" style="display: none;">
                <div class="form-group" id="rpc-url-group" style="display: none;">
                    <label>RPC URL:</label>
                    <input type="text" id="echidna-rpc-url">
                </div>
                <div class="form-group" id="fork-block-group" style="display: none;">
                    <label>Fork Block:</label>
                    <input type="text" id="echidna-fork-block" value="LATEST">
                </div>
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
                    <option value="">None</option>
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
                    <option value="">None</option>
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
