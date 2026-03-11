import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface SolidityConstant {
  name: string;
  type: string;
  value: string;
  line: number;
}

export function parseSetupSolConstants(content: string): SolidityConstant[] {
  const constants: SolidityConstant[] = [];
  const lines = content.split('\n');
  // Match: uint256 public constant FOO = 123;
  //        address public constant BAR = 0x...;
  //        bytes32 constant BAZ = ...;
  const regex = /^\s*(\w+(?:\[\])?)\s+(?:public\s+)?constant\s+(\w+)\s*=\s*([^;]+);/;
  lines.forEach((line, idx) => {
    const m = line.match(regex);
    if (m) {
      constants.push({ type: m[1], name: m[2], value: m[3].trim(), line: idx });
    }
  });
  return constants;
}

export function applyReplacements(content: string, constants: SolidityConstant[]): string {
  const lines = content.split('\n');
  for (const c of constants) {
    const regex = new RegExp(
      `(\\s*\\w+(?:\\[\\])?\\s+(?:public\\s+)?constant\\s+${c.name}\\s*=\\s*)([^;]+)(;)`
    );
    lines[c.line] = lines[c.line].replace(regex, `$1${c.value}$3`);
  }
  return lines.join('\n');
}

export class DynamicReplacementPanel {
  public static currentPanel: DynamicReplacementPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _constants: SolidityConstant[] = [];
  private _setupSolPath: string | undefined;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri) {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (DynamicReplacementPanel.currentPanel) {
      DynamicReplacementPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'dynamicReplacement',
      'Dynamic Replacement',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    DynamicReplacementPanel.currentPanel = new DynamicReplacementPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      msg => this._handleMessage(msg),
      null,
      this._disposables
    );

    this._loadConstants();
  }

  private _findSetupSol(): string | undefined {
    const wsFolders = vscode.workspace.workspaceFolders;
    if (!wsFolders) return undefined;
    for (const folder of wsFolders) {
      const candidate = path.join(folder.uri.fsPath, 'Setup.sol');
      if (fs.existsSync(candidate)) return candidate;
      // Also check test/ and src/ subdirectories
      for (const sub of ['test', 'src']) {
        const sub_candidate = path.join(folder.uri.fsPath, sub, 'Setup.sol');
        if (fs.existsSync(sub_candidate)) return sub_candidate;
      }
    }
    return undefined;
  }

  private _loadConstants() {
    this._setupSolPath = this._findSetupSol();
    if (this._setupSolPath) {
      try {
        const content = fs.readFileSync(this._setupSolPath, 'utf8');
        this._constants = parseSetupSolConstants(content);
      } catch (err) {
        this._constants = [];
        vscode.window.showErrorMessage(`Failed to read Setup.sol: ${err}`);
      }
    } else {
      this._constants = [];
    }
    this._panel.webview.html = this._getHtml();
  }

  private _handleMessage(msg: any) {
    if (msg.command === 'save' && this._setupSolPath) {
      this._constants = msg.constants as SolidityConstant[];
      try {
        const original = fs.readFileSync(this._setupSolPath, 'utf8');
        const updated = applyReplacements(original, this._constants);
        fs.writeFileSync(this._setupSolPath, updated, 'utf8');
        vscode.window.showInformationMessage('Setup.sol updated with new constant values.');
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to save Setup.sol: ${err}`);
      }
    } else if (msg.command === 'refresh') {
      this._loadConstants();
    }
  }

  private _getHtml(): string {
    const rows = this._constants
      .map(
        (c, i) =>
          `<tr>
            <td class="name">${escapeHtml(c.name)}</td>
            <td class="type">${escapeHtml(c.type)}</td>
            <td><input data-idx="${i}" value="${escapeHtml(c.value)}" /></td>
          </tr>`
      )
      .join('');

    const fileInfo = this._setupSolPath
      ? `<p class="file-path">📄 ${escapeHtml(this._setupSolPath)}</p>`
      : `<p class="error">⚠️ Setup.sol not found in workspace root or test/src subdirectories.</p>`;

    const emptyRow =
      this._constants.length === 0
        ? `<tr><td colspan="3" class="empty">No constants found${this._setupSolPath ? ' in Setup.sol' : ' — open a workspace with Setup.sol'}.</td></tr>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dynamic Replacement</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px;
    }
    h2 { margin-top: 0; }
    .file-path {
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
      word-break: break-all;
    }
    .error { color: var(--vscode-errorForeground); }
    table {
      border-collapse: collapse;
      width: 100%;
      margin-bottom: 12px;
    }
    th, td {
      border: 1px solid var(--vscode-panel-border);
      padding: 6px 10px;
      text-align: left;
    }
    th {
      background: var(--vscode-editor-inactiveSelectionBackground);
      font-weight: bold;
    }
    td.name { font-weight: 600; white-space: nowrap; }
    td.type { color: var(--vscode-symbolIcon-variableForeground, #569cd6); white-space: nowrap; }
    td.empty { text-align: center; color: var(--vscode-descriptionForeground); padding: 20px; }
    input {
      width: 100%;
      box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      padding: 3px 6px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.95em;
    }
    input:focus { outline: 1px solid var(--vscode-focusBorder); }
    .actions { display: flex; gap: 8px; margin-top: 8px; }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 14px;
      cursor: pointer;
      font-size: 0.95em;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    #status { margin-top: 8px; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <h2>Dynamic Replacement</h2>
  <p>View and edit Solidity <code>constant</code> declarations in <code>Setup.sol</code>.</p>
  ${fileInfo}
  <table>
    <thead>
      <tr>
        <th>Name</th>
        <th>Type</th>
        <th>Value</th>
      </tr>
    </thead>
    <tbody>
      ${rows || emptyRow}
    </tbody>
  </table>
  <div class="actions">
    <button onclick="save()">💾 Save to file</button>
    <button class="secondary" onclick="refresh()">🔄 Refresh</button>
  </div>
  <div id="status"></div>
  <script>
    const vscode = acquireVsCodeApi();
    const constants = ${JSON.stringify(this._constants)};

    function save() {
      document.querySelectorAll('input[data-idx]').forEach(el => {
        constants[+el.getAttribute('data-idx')].value = el.value;
      });
      vscode.postMessage({ command: 'save', constants });
      document.getElementById('status').textContent = 'Saving…';
      setTimeout(() => { document.getElementById('status').textContent = ''; }, 2000);
    }

    function refresh() {
      document.getElementById('status').textContent = 'Refreshing…';
      vscode.postMessage({ command: 'refresh' });
    }

    // Allow Ctrl+S / Cmd+S to save
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        save();
      }
    });
  </script>
</body>
</html>`;
  }

  public dispose() {
    DynamicReplacementPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
