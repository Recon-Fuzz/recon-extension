import * as vscode from "vscode";
import {
  echidnaLogsToFunctions,
  medusaLogsToFunctions,
  halmosLogsToFunctions,
  processLogs,
  Fuzzer,
  VmParsingData,
  FuzzingResults,
} from "@recon-fuzz/log-parser";

import { filterIgnoredProperties } from "../utils/propertyFilter";

interface VmOptions {
  prank: boolean;
  roll: boolean;
  warp: boolean;
}

export class LogToFoundryViewProvider {
  public static readonly viewType = "recon.logToFoundry";

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public createWebviewPanel(): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      LogToFoundryViewProvider.viewType,
      "Log to Foundry",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [this._extensionUri],
      }
    );

    panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case "convert":
          try {
            const results = this.convertLog(
              message.log,
              message.vmOptions,
              message.fuzzer
            );
            await panel.webview.postMessage({
              type: "conversionResult",
              results,
            });
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : "Unknown error occurred";
            vscode.window.showErrorMessage(
              `Error converting log: ${errorMessage}`
            );
          }
          break;
        case "regenerate":
          try {
            const code = this.regenerateCode(
              message.trace,
              message.brokenProperty,
              message.vmData,
              message.fuzzer,
              message.index
            );
            await panel.webview.postMessage({
              type: "regenerateResult",
              code,
              index: message.index,
            });
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : "Unknown error occurred";
            vscode.window.showErrorMessage(
              `Error regenerating code: ${errorMessage}`
            );
          }
          break;
        case "copy":
          vscode.env.clipboard.writeText(message.text);
          break;
      }
    });

    panel.webview.html = this._getHtmlForWebview(panel.webview);
    return panel;
  }

  private convertLog(log: string, vmOptions: VmOptions, fuzzer: string): any {
    if (!log.trim()) {
      return { brokenProperties: [], traces: [], generatedCode: [] };
    }

    try {
      // Process logs using recon-fuzz/log-parser
      const jobStats: FuzzingResults = processLogs(
        log,
        fuzzer.toUpperCase() as unknown as Fuzzer
      );

      // Track original count before filtering
      const originalCount = jobStats.brokenProperties?.length || 0;

      // Filter out ignored properties
      jobStats.brokenProperties = filterIgnoredProperties(jobStats.brokenProperties);

      if (
        !jobStats.brokenProperties ||
        jobStats.brokenProperties.length === 0
      ) {
        return { 
          brokenProperties: [], 
          traces: [], 
          generatedCode: [],
          originalCount,
          filteredCount: originalCount,
        };
      }

      // Extract traces and prepare VM data for each property
      const traces = jobStats.brokenProperties.map((prop) => prop.sequence);
      const useVmData = jobStats.brokenProperties.map(() => ({
        roll: true,
        time: true,
        prank: true,
      }));

      // Generate code for each broken property using the actual functions
      const generatedCode = jobStats.brokenProperties.map((prop, index) => {
        const vmData: VmParsingData = {
          roll: true,
          time: true,
          prank: true,
        };

        let finalTrace = "";
        if (fuzzer === "medusa") {
          finalTrace = medusaLogsToFunctions(
            prop.sequence,
            index.toString(),
            vmData
          );
        } else if (fuzzer === "halmos") {
          finalTrace = halmosLogsToFunctions(
            prop.sequence,
            index.toString(),
            prop.brokenProperty,
            vmData
          );
        } else {
          finalTrace = echidnaLogsToFunctions(
            prop.sequence,
            index.toString(),
            prop.brokenProperty,
            vmData
          );
        }

        const functionName = finalTrace
          .split("() public")[0]
          .replace("function ", "");
        const forgeCommand =
          `// forge test --match-test ${functionName} -vvv`.replace("\n", "");

        return `${forgeCommand}\n${finalTrace}`;
      });

      return {
        brokenProperties: jobStats.brokenProperties,
        traces,
        useVmData,
        generatedCode,
        fuzzer,
        originalCount,
        filteredCount: originalCount - jobStats.brokenProperties.length,
      };
    } catch (error) {
      console.error("Error converting log:", error);
      throw error;
    }
  }

  private regenerateCode(
    trace: string,
    brokenProperty: string,
    vmData: VmParsingData,
    fuzzer: string,
    index: number
  ): string {
    try {
      let finalTrace = "";
      if (fuzzer === "medusa") {
        finalTrace = medusaLogsToFunctions(trace, index.toString(), vmData);
      } else if (fuzzer === "halmos" || fuzzer === "Halmos") {
        finalTrace = halmosLogsToFunctions(
          trace,
          index.toString(),
          brokenProperty,
          vmData
        );
      } else {
        finalTrace = echidnaLogsToFunctions(
          trace,
          index.toString(),
          brokenProperty,
          vmData
        );
      }

      const functionName = finalTrace
        .split("() public")[0]
        .replace("function ", "");
      const forgeCommand =
        `// forge test --match-test ${functionName} -vvv`.replace("\n", "");

      return `${forgeCommand}\n${finalTrace}`;
    } catch (error) {
      console.error("Error regenerating code:", error);
      throw error;
    }
  }

  private getPrismThemeUri(webview: vscode.Webview): vscode.Uri {
    return webview.asWebviewUri(
      vscode.Uri.joinPath(
        this._extensionUri,
        "node_modules",
        "prismjs",
        "themes",
        "prism-tomorrow.css"
      )
    );
  }

  private getPrismScriptUri(webview: vscode.Webview): vscode.Uri {
    return webview.asWebviewUri(
      vscode.Uri.joinPath(
        this._extensionUri,
        "node_modules",
        "prismjs",
        "prism.js"
      )
    );
  }

  private getPrismSolidityUri(webview: vscode.Webview): vscode.Uri {
    return webview.asWebviewUri(
      vscode.Uri.joinPath(
        this._extensionUri,
        "node_modules",
        "prismjs",
        "components",
        "prism-solidity.min.js"
      )
    );
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const prismThemeUri = this.getPrismThemeUri(webview);
    const prismScriptUri = this.getPrismScriptUri(webview);
    const prismSolidityUri = this.getPrismSolidityUri(webview);

    return `<!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width,initial-scale=1.0">
                <link href="${prismThemeUri}" rel="stylesheet" />
                <script src="${prismScriptUri}"></script>
                <script src="${prismSolidityUri}"></script>
                <title>Log to Foundry</title>
                <style>
                    body { 
                        padding: 20px; 
                        color: var(--vscode-foreground);
                        font-family: var(--vscode-font-family);
                        background: var(--vscode-editor-background);
                    }
                    
                    .container {
                        max-width: 1200px;
                        margin: 0 auto;
                    }
                    
                    h1 {
                        font-size: 24px;
                        margin-bottom: 8px;
                        color: var(--vscode-foreground);
                    }
                    
                    .description {
                        margin-bottom: 20px;
                        color: var(--vscode-descriptionForeground);
                    }
                    
                    .fuzzer-options {
                        margin-bottom: 16px;
                    }
                    
                    .fuzzer-options label {
                        margin-right: 20px;
                        cursor: pointer;
                        display: inline-flex;
                        align-items: center;
                        gap: 6px;
                    }
                    
                    .log-input {
                        width: 100%;
                        min-height: 200px;
                        padding: 12px;
                        border: 1px solid var(--vscode-input-border);
                        background: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                        font-family: var(--vscode-editor-font-family);
                        font-size: var(--vscode-editor-font-size);
                        resize: vertical;
                        border-radius: 4px;
                        margin-bottom: 16px;
                    }
                    
                    .convert-btn {
                        background: #5c25d2;
                        color: white;
                        border: 1px solid #5c25d2;
                        padding: 10px 20px;
                        border-radius: 4px;
                        cursor: pointer;
                        font-family: var(--vscode-font-family);
                        font-size: var(--vscode-font-size);
                        margin-bottom: 20px;
                    }
                    
                    .convert-btn:hover {
                        background: #4a1ea8;
                        border-color: #4a1ea8;
                    }
                    
                    .convert-btn:disabled {
                        opacity: 0.5;
                        cursor: not-allowed;
                        background: #5c25d2;
                    }
                    
                    .results-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin: 20px 0;
                    }
                    
                    .results-title {
                        font-size: 20px;
                        font-weight: bold;
                    }
                    
                    .results-title.filtered {
                        color: #f0ad4e;
                    }
                    
                    .filtered-info {
                        background: rgba(240, 173, 78, 0.15);
                        border: 1px solid rgba(240, 173, 78, 0.3);
                        border-radius: 6px;
                        padding: 12px 16px;
                        margin-top: 10px;
                        display: flex;
                        align-items: center;
                        gap: 10px;
                    }
                    
                    .filtered-info .icon {
                        font-size: 18px;
                    }
                    
                    .filtered-info .text {
                        color: #ccc;
                    }
                    
                    .filtered-info .text strong {
                        color: #f0ad4e;
                    }
                    
                    .copy-all-btn {
                        background: #5c25d2;
                        color: white;
                        border: 1px solid #5c25d2;
                        padding: 8px 16px;
                        border-radius: 4px;
                        cursor: pointer;
                        font-family: var(--vscode-font-family);
                        display: flex;
                        align-items: center;
                        gap: 8px;
                    }
                    
                    .copy-all-btn:hover {
                        background: #4a1ea8;
                        border-color: #4a1ea8;
                    }
                    
                    .property-item {
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 6px;
                        margin-bottom: 12px;
                        overflow: hidden;
                    }
                    
                    .property-header {
                        padding: 12px 16px;
                        background: var(--vscode-editor-background);
                        cursor: pointer;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        border-bottom: 1px solid var(--vscode-panel-border);
                    }
                    
                    .property-header:hover {
                        background: var(--vscode-list-hoverBackground);
                    }
                    
                    .property-title {
                        font-size: 16px;
                        font-weight: 500;
                    }
                    
                    .property-content {
                        display: none;
                        padding: 16px;
                        background: var(--vscode-editor-background);
                    }
                    
                    .property-content.expanded {
                        display: block;
                    }
                    
                    .vm-controls {
                        display: flex;
                        gap: 12px;
                        margin-bottom: 16px;
                        flex-wrap: wrap;
                    }
                    
                    .vm-btn {
                        padding: 6px 12px;
                        border: 1px solid var(--vscode-button-border);
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 12px;
                        background: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                    }
                    
                    .vm-btn.active {
                        background: #5c25d2;
                        color: white;
                        border-color: #5c25d2;
                    }
                    
                    .vm-btn.active:hover {
                        background: #4a1ea8;
                        border-color: #4a1ea8;
                    }
                    
                    .code-section {
                        position: relative;
                        margin-bottom: 16px;
                    }
                    
                    .code-section pre {
                        margin: 0;
                        padding: 16px;
                        border-radius: 4px;
                        background: var(--vscode-textCodeBlock-background) !important;
                        border: 1px solid var(--vscode-panel-border);
                        overflow-x: auto;
                    }
                    
                    .copy-btn {
                        position: absolute;
                        top: 8px;
                        right: 8px;
                        background: #5c25d2;
                        color: white;
                        border: 1px solid #5c25d2;
                        padding: 4px 8px;
                        border-radius: 3px;
                        cursor: pointer;
                        font-size: 11px;
                    }
                    
                    .copy-btn:hover {
                        background: #4a1ea8;
                        border-color: #4a1ea8;
                    }
                    
                    .trace-section {
                        margin-top: 12px;
                    }
                    
                    .trace-btn {
                        background: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                        border: 1px solid var(--vscode-button-border);
                        padding: 6px 12px;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 12px;
                        margin-bottom: 8px;
                    }
                    
                    .trace-btn:hover {
                        background: var(--vscode-button-secondaryHoverBackground);
                    }
                    
                    .trace-content {
                        display: none;
                    }
                    
                    .trace-content.show {
                        display: block;
                    }
                    
                    .chevron {
                        transition: transform 0.2s;
                        font-size: 12px;
                    }
                    
                    .chevron.expanded {
                        transform: rotate(180deg);
                    }
                    
                    .hidden {
                        display: none;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Log to Foundry</h1>
                    <p class="description">Paste your fuzzer log below to convert it to Foundry tests.</p>
                    
                    <div class="fuzzer-options">
                        <label>
                            <input type="radio" name="fuzzer" value="echidna" checked> Echidna
                        </label>
                        <label>
                            <input type="radio" name="fuzzer" value="medusa"> Medusa
                        </label>
                        <label>
                            <input type="radio" name="fuzzer" value="halmos"> Halmos
                        </label>
                    </div>
                    
                    <textarea id="log-input" class="log-input" placeholder="Paste your fuzzer log here..."></textarea>
                    
                    <button id="convert-btn" class="convert-btn" disabled>Convert</button>
                    
                    <div id="results" class="hidden">
                        <div class="results-header">
                            <div class="results-title" id="results-title">0 Broken Properties</div>
                            <button id="copy-all-btn" class="copy-all-btn">
                                <span>Copy all repro</span>
                            </button>
                        </div>
                        <div id="properties-list"></div>
                    </div>
                </div>
                
                <script>
                    const vscode = acquireVsCodeApi();
                    let currentResults = null;
                    let showBrokenProp = [];
                    let showTrace = [];
                    let useVmData = [];
                    
                    // DOM elements
                    const logInput = document.getElementById('log-input');
                    const convertBtn = document.getElementById('convert-btn');
                    const resultsDiv = document.getElementById('results');
                    const resultsTitle = document.getElementById('results-title');
                    const propertiesList = document.getElementById('properties-list');
                    const copyAllBtn = document.getElementById('copy-all-btn');
                    
                    // Enable/disable convert button based on input
                    logInput.addEventListener('input', () => {
                        convertBtn.disabled = !logInput.value.trim();
                    });
                    
                    // Convert button click
                    convertBtn.addEventListener('click', () => {
                        const log = logInput.value.trim();
                        if (!log) return;
                        
                        convertBtn.disabled = true;
                        convertBtn.textContent = 'Converting...';
                        
                        // Use default VM options for initial conversion
                        const vmOptions = {
                            prank: true,
                            roll: true,
                            warp: true
                        };
                        
                        const fuzzer = document.querySelector('input[name="fuzzer"]:checked').value;
                        
                        vscode.postMessage({
                            type: 'convert',
                            log,
                            vmOptions,
                            fuzzer
                        });
                    });
                    
                    // Copy all button
                    copyAllBtn.addEventListener('click', () => {
                        if (!currentResults || !currentResults.brokenProperties.length) return;
                        
                        const allCode = currentResults.brokenProperties.map((prop, index) => {
                            return prepareTrace(index);
                        }).join('\\n\\n');
                        
                        vscode.postMessage({
                            type: 'copy',
                            text: allCode
                        });
                        
                        copyAllBtn.innerHTML = '<span>Copied ✅</span>';
                        setTimeout(() => {
                            copyAllBtn.innerHTML = '<span>Copy all repro</span>';
                        }, 2000);
                    });
                    
                    // Prepare trace function (now uses backend-generated code)
                    function prepareTrace(index) {
                        return currentResults.generatedCode[index];
                    }
                    
                    // Handle VM data changes
                    function handleVmData(index, property) {
                        useVmData[index][property] = !useVmData[index][property];
                        const btn = document.getElementById(\`vm-\${property}-\${index}\`);
                        
                        if (useVmData[index][property]) {
                            btn.classList.add('active');
                        } else {
                            btn.classList.remove('active');
                        }
                        
                        // Send message to backend to regenerate code
                        const prop = currentResults.brokenProperties[index];
                        vscode.postMessage({
                            type: 'regenerate',
                            trace: currentResults.traces[index],
                            brokenProperty: prop.brokenProperty,
                            vmData: useVmData[index],
                            fuzzer: currentResults.fuzzer,
                            index: index
                        });
                    }
                    
                    // Update property code display
                    function updatePropertyCode(index, newCode) {
                        currentResults.generatedCode[index] = newCode;
                        const codeElement = document.getElementById(\`code-\${index}\`);
                        codeElement.textContent = newCode;
                        Prism.highlightElement(codeElement);
                    }
                    
                    // Copy individual property
                    function copyProperty(index) {
                        const code = currentResults.generatedCode[index];
                        
                        vscode.postMessage({
                            type: 'copy',
                            text: code
                        });
                        
                        const btn = document.getElementById(\`copy-btn-\${index}\`);
                        btn.textContent = 'Copied!';
                        setTimeout(() => {
                            btn.textContent = 'Copy';
                        }, 2000);
                    }
                    
                    // Toggle property visibility
                    function toggleProperty(index) {
                        showBrokenProp[index].show = !showBrokenProp[index].show;
                        const content = document.getElementById(\`property-content-\${index}\`);
                        const chevron = document.getElementById(\`chevron-\${index}\`);
                        
                        if (showBrokenProp[index].show) {
                            content.classList.add('expanded');
                            chevron.classList.add('expanded');
                        } else {
                            content.classList.remove('expanded');
                            chevron.classList.remove('expanded');
                        }
                    }
                    
                    // Toggle trace visibility
                    function toggleTrace(index) {
                        showTrace[index].show = !showTrace[index].show;
                        const traceContent = document.getElementById(\`trace-content-\${index}\`);
                        const traceBtn = document.getElementById(\`trace-btn-\${index}\`);
                        
                        if (showTrace[index].show) {
                            traceContent.classList.add('show');
                            traceBtn.textContent = 'Hide trace';
                        } else {
                            traceContent.classList.remove('show');
                            traceBtn.textContent = 'Show trace';
                        }
                    }
                    
                    // Render properties
                    function renderProperties() {
                        if (!currentResults) {
                            resultsDiv.classList.add('hidden');
                            return;
                        }
                        
                        const count = currentResults.brokenProperties.length;
                        const originalCount = currentResults.originalCount || count;
                        const filteredCount = currentResults.filteredCount || 0;
                        
                        // If no properties at all (nothing found, nothing filtered)
                        if (count === 0 && filteredCount === 0) {
                            resultsDiv.classList.add('hidden');
                            return;
                        }
                        
                        // Reset filtered class
                        resultsTitle.classList.remove('filtered');
                        
                        // Show appropriate message
                        if (filteredCount > 0 && count === 0) {
                            // All properties were filtered out
                            resultsTitle.classList.add('filtered');
                            resultsTitle.textContent = 'Results';
                            propertiesList.innerHTML = \`
                                <div class="filtered-info">
                                    <span class="icon">⚠️</span>
                                    <span class="text">
                                        <strong>\${originalCount} broken propert\${originalCount === 1 ? 'y' : 'ies'}</strong> 
                                        matched your ignore patterns and \${originalCount === 1 ? 'was' : 'were'} filtered out.
                                        <br>Edit <em>recon.ignorePropertyPatterns</em> in settings to adjust.
                                    </span>
                                </div>
                            \`;
                            document.getElementById('copy-all-btn').style.display = 'none';
                            resultsDiv.classList.remove('hidden');
                            return;
                        } else if (filteredCount > 0) {
                            // Some properties filtered, some remain
                            resultsTitle.classList.add('filtered');
                            resultsTitle.textContent = \`\${count} Broken Propert\${count === 1 ? 'y' : 'ies'} (\${filteredCount} filtered)\`;
                        } else {
                            // No filtering applied
                            resultsTitle.textContent = \`\${count} Broken Propert\${count === 1 ? 'y' : 'ies'}\`;
                        }
                        resultsDiv.classList.remove('hidden');
                        
                        // Show copy-all button
                        document.getElementById('copy-all-btn').style.display = '';
                        
                        // Initialize state arrays
                        showBrokenProp = currentResults.brokenProperties.map((_, index) => ({ id: index, show: false }));
                        showTrace = currentResults.brokenProperties.map((_, index) => ({ id: index, show: false }));
                        useVmData = currentResults.useVmData;
                        
                        // Render each property
                        propertiesList.innerHTML = currentResults.brokenProperties.map((prop, index) => {
                            const code = prepareTrace(index);
                            
                            return \`
                                <div class="property-item">
                                    <div class="property-header" onclick="toggleProperty(\${index})">
                                        <div class="property-title">\${index + 1} - \${prop.brokenProperty}</div>
                                        <span id="chevron-\${index}" class="chevron">▼</span>
                                    </div>
                                    <div id="property-content-\${index}" class="property-content">
                                        <div class="vm-controls">
                                            <button id="vm-prank-\${index}" class="vm-btn \${useVmData[index].prank ? 'active' : ''}" 
                                                    onclick="handleVmData(\${index}, 'prank')">Use vm.prank</button>
                                            <button id="vm-roll-\${index}" class="vm-btn \${useVmData[index].roll ? 'active' : ''}" 
                                                    onclick="handleVmData(\${index}, 'roll')">Use vm.roll</button>
                                            <button id="vm-time-\${index}" class="vm-btn \${useVmData[index].time ? 'active' : ''}" 
                                                    onclick="handleVmData(\${index}, 'time')">Use vm.warp</button>
                                        </div>
                                        
                                        <div class="code-section">
                                            <pre><code id="code-\${index}" class="language-solidity">\${code}</code></pre>
                                            <button id="copy-btn-\${index}" class="copy-btn" onclick="copyProperty(\${index})">Copy</button>
                                        </div>
                                        
                                        <div class="trace-section">
                                            <button id="trace-btn-\${index}" class="trace-btn" onclick="toggleTrace(\${index})">Show trace</button>
                                            <div id="trace-content-\${index}" class="trace-content">
                                                <pre><code class="language-bash">\${currentResults.traces[index]}</code></pre>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            \`;
                        }).join('');
                        
                        // Highlight all code
                        Prism.highlightAll();
                    }
                    
                    // Handle messages from extension
                    window.addEventListener('message', event => {
                        const message = event.data;
                        
                        if (message.type === 'conversionResult') {
                            currentResults = message.results;
                            convertBtn.disabled = false;
                            convertBtn.textContent = 'Convert';
                            renderProperties();
                        } else if (message.type === 'regenerateResult') {
                            updatePropertyCode(message.index, message.code);
                        }
                    });
                    
                    // Make functions global
                    window.toggleProperty = toggleProperty;
                    window.toggleTrace = toggleTrace;
                    window.handleVmData = handleVmData;
                    window.copyProperty = copyProperty;
                </script>
            </body>
        </html>`;
  }
}
