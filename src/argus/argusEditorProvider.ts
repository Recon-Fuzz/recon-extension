import * as vscode from 'vscode';
import { generateCallGraph } from './generateCallGraph';

interface ArgusSettings {
  includeAll: boolean; // formerly --all
  includeDeps: boolean; // formerly --libs
}

/**
 * CustomTextEditorProvider for displaying Argus call graph preview of a Solidity file.
 * Initial implementation is a dummy scaffold that echoes current settings and file name.
 * Later we will integrate the real processing pipeline from processor.ts (processCompilerOutput) adapted for single-file focus.
 */
export class ArgusCallGraphEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'recon.argusCallGraph';

  constructor(private readonly context: vscode.ExtensionContext) { }

  async resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
    };

    const settings: ArgusSettings = { includeAll: false, includeDeps: false };
    let genToken = 0;
    let lastPrimaryContract: string | undefined;
    const updateWebview = async () => {
      const token = ++genToken;
      webviewPanel.webview.html = this.getLoadingHtml(document, settings);
      const result = await generateCallGraph({
        source: document.getText(),
        filePath: document.uri.fsPath,
        includeAll: settings.includeAll,
        includeDeps: settings.includeDeps
      });
      if (token !== genToken) { return; } // stale generation
      lastPrimaryContract = result.primaryContractName || lastPrimaryContract;
      webviewPanel.webview.html = this.getHtml(webviewPanel.webview, document, settings, result.html);
    };
    const scheduleUpdate = debounce(updateWebview, 300);

    // Listen for document changes to refresh preview (future: incremental regen)
    const changeSub = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() === document.uri.toString()) {
        scheduleUpdate();
      }
    });
    webviewPanel.onDidDispose(() => changeSub.dispose());

    // Handle messages from the webview
    webviewPanel.webview.onDidReceiveMessage(msg => {
      switch (msg.type) {
        case 'updateSetting':
          if (msg.key in settings) {
            (settings as any)[msg.key] = !!msg.value;
            scheduleUpdate();
          }
          break;
        case 'runBuild':
          // Show interim building message
          webviewPanel.webview.postMessage?.({}); // no-op safeguard
          webviewPanel.webview.html = `<div style="font-family:var(--vscode-font-family);padding:16px;">` +
            `<strong>Building project (forge build --build-info)...</strong><br/><br/>` +
            `Open the <em>Recon</em> output channel to watch progress. The call graph will refresh automatically when done.` +
            `</div>`;
          // Await the build command; our command now returns a promise that resolves when build finishes
          Promise.resolve(vscode.commands.executeCommand('recon.buildWithInfo'))
            .finally(() => {
              // Refresh regardless of success/failure/cancel so the page doesn't get stuck
              scheduleUpdate();
            });
          break;
        case 'copyToClipboard':
          if (typeof msg.text === 'string' && msg.text.length > 0) {
            vscode.env.clipboard.writeText(msg.text).then(() => {
              // Optionally could post back success message; host already gives visual feedback
            });
          }
          break;
        case 'exportImage': {
          (async () => {
            try {
              const dataUrl: string | undefined = msg.dataUrl;
              const suggested: string | undefined = msg.name;
              console.log('[Argus] exportImage message received', { hasDataUrl: !!dataUrl, suggested });
              if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) {
                console.warn('[Argus] exportImage aborted: invalid or missing dataUrl');
                return;
              }
              const base64 = dataUrl.split(',')[1];
              const buffer = Buffer.from(base64, 'base64');
              const pathMod = require('path');
              const fs = require('fs');
              const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
              // Fallback to original document directory if no workspace or outside workspace
              const baseDirFs = workspaceRoot && document.uri.fsPath.startsWith(workspaceRoot)
                ? workspaceRoot
                : pathMod.dirname(document.uri.fsPath);
              const baseDirUri = vscode.Uri.file(baseDirFs);
              const inferredName = lastPrimaryContract ? `${lastPrimaryContract}-callgraph.png` : 'callgraph.png';
              const fileBase = (suggested || inferredName).replace(/[^a-z0-9_.-]/gi, '_');
              let targetName = fileBase;
              let attempt = 0;
              while (attempt < 50) {
                const candidate = pathMod.join(baseDirFs, targetName);
                console.log('[Argus] exportImage attempt', attempt + 1, 'candidate', candidate);
                if (!fs.existsSync(candidate)) {
                  const uri = vscode.Uri.file(candidate);
                  await vscode.workspace.fs.writeFile(uri, buffer);
                  const rel = workspaceRoot ? pathMod.relative(workspaceRoot, uri.fsPath) : uri.fsPath;
                  vscode.window.showInformationMessage(`Argus call graph image saved at workspace root: ${rel}`, 'Open').then(sel => {
                    if (sel === 'Open') { vscode.commands.executeCommand('vscode.open', uri); }
                  });
                  webviewPanel.webview.postMessage({ type: 'exportImageResult', ok: true, file: uri.fsPath });
                  console.log('[Argus] exportImage success', uri.fsPath);
                  return;
                }
                attempt++;
                const stem = fileBase.replace(/\.png$/i, '');
                targetName = `${stem}-${attempt}.png`;
              }
              vscode.window.showWarningMessage('Unable to save image: too many existing versions.');
              webviewPanel.webview.postMessage({ type: 'exportImageResult', ok: false, error: 'exists' });
              console.warn('[Argus] exportImage failed: too many existing versions');
            } catch (err: any) {
              vscode.window.showErrorMessage('Failed to save call graph image: ' + err.message);
              webviewPanel.webview.postMessage({ type: 'exportImageResult', ok: false, error: String(err?.message || err) });
              console.error('[Argus] exportImage error', err);
            }
          })();
          break;
        }
      }
    });

    updateWebview();
  }
  private getLoadingHtml(document: vscode.TextDocument, _settings: ArgusSettings): string {
    const fileName = vscode.workspace.asRelativePath(document.uri);
    return `<div style="font-family:var(--vscode-font-family);padding:16px;">Generating Argus Call Graph for <code>${escapeHtml(vscode.workspace.asRelativePath(document.uri))}</code>...</div>`;
  }

  private getHtml(webview: vscode.Webview, document: vscode.TextDocument, settings: ArgusSettings, body: string): string {
    const nonce = getNonce();
    const fileName = vscode.workspace.asRelativePath(document.uri);
    const html2canvasUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'html2canvas', 'dist', 'html2canvas.min.js'));
    // Extract inner <body> content if a full HTML document was returned to avoid nested <html> issues
    let fragment = body;
    const bodyMatch = body.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) { fragment = bodyMatch[1]; }
    // Collect any style tags from original HTML (head or body) to preserve design
    const styleTags: string[] = [];
    const styleRegex = /<style[^>]*>[\s\S]*?<\/style>/gi;
    let m: RegExpExecArray | null;
    while ((m = styleRegex.exec(body))) { styleTags.push(m[0]); }
    const collectedStyles = styleTags.join('\n');
    // Ensure any <script> tags inside the fragment receive the nonce so CSP allows execution
    const bodyWithNonce = fragment
      .replace(/<script(?![^>]*nonce=)/g, `<script nonce="${nonce}"`)
      .replace(/<style(?![^>]*nonce=)/g, `<style nonce="${nonce}"`);

    // Prism resource URIs (mirror working implementation in logToFoundryView)
    const prismCore = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'prismjs', 'prism.js'));
    const prismSolidity = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-solidity.min.js'));
    const prismTheme = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'prismjs', 'themes', 'prism-tomorrow.css'));
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline' ${this.getCspSource()}; script-src 'nonce-${nonce}' ${this.getCspSource()};" />
<title>Argus Call Graph Preview</title>
<link rel="stylesheet" href="${prismTheme}" />
${collectedStyles.replace(/<style/gi, `<style nonce="${nonce}"`).replace(/<script/gi, '<!-- stripped-script')}
<style nonce="${nonce}">
/* Header layout & logo (inline) */
header.argus-header { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:12px; }
.argus-header-left { display:flex; align-items:center; gap:10px; }
.argus-header-right { display:flex; align-items:center; gap:12px; }
.recon-logo-link { display:inline-flex; align-items:center; justify-content:center; text-decoration:none; padding:2px; border-radius:6px; transition:background .15s, box-shadow .15s; line-height:0; padding: 8px; }
.recon-logo-link:hover { background: rgba(255,255,255,0.08); }
.recon-logo-link:active { background: rgba(255,255,255,0.15); }
.recon-logo-link svg { width:90px; height:32px; display:block; }
.badge { background: var(--argus-accent); color: var(--vscode-button-foreground); font-size: 0.75em; font-weight: 600; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px; font-family: var(--vscode-font-family); }
/* Footer attribution */
footer.argus-footer { margin-top:32px; font-size:10px; opacity:0.65; text-align:center; font-family:var(--vscode-font-family); }
footer.argus-footer a { color:inherit; text-decoration:none; border-bottom:1px dotted currentColor; }
footer.argus-footer a:hover { opacity:0.85; }
</style>
<script nonce="${nonce}" src="${prismCore}"></script>
<script nonce="${nonce}" src="${prismSolidity}"></script>
<script nonce="${nonce}" src="${html2canvasUri}"></script>
 </head><body>
<header class="argus-header">
  <div class="argus-header-left">
    <h2 style="margin:0;">Argus Call Graph</h2>
    <span class="badge">Experimental</span>
  </div>
  <div class="argus-header-right">
    <a class="recon-logo-link" href="https://getrecon.xyz" target="_blank" rel="noopener noreferrer" title="Open Recon Website" aria-label="Recon Website">
<svg width="216" height="98" viewBox="0 0 216 98" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M30.1313 82.2147C30.1271 83.6091 29.5526 84.9452 28.5333 85.9311C27.514 86.9171 26.1327 87.4728 24.6912 87.4769H21.6362L30.1313 97.2728V97.8739H24.7745L15.735 87.4709H5.44012C5.13109 87.466 4.82285 87.4391 4.5179 87.3904V97.8739H0V68.7749H24.6912C26.1327 68.779 27.514 69.3348 28.5333 70.3207C29.5526 71.3067 30.1271 72.6427 30.1313 74.0371V82.2147ZM24.6912 83.1044C24.9344 83.1022 25.1671 83.0078 25.3391 82.8414C25.5111 82.675 25.6087 82.45 25.611 82.2147V74.0395C25.609 73.804 25.5115 73.5787 25.3395 73.4121C25.1675 73.2454 24.9347 73.1508 24.6912 73.1486H5.44012C5.19635 73.1505 4.96309 73.2449 4.7906 73.4116C4.6181 73.5782 4.52017 73.8037 4.5179 74.0395V82.2147C4.5205 82.4503 4.61857 82.6755 4.79103 82.8419C4.96349 83.0082 5.19656 83.1025 5.44012 83.1044H24.6912Z" fill="white"/>
<path d="M74.8197 73.1059H51.7193V81.1213H70.3005V85.4926H51.7193V93.5079H74.8197V97.8793H47.2002V68.7334H74.8197V73.1059Z" fill="white"/>
<path d="M97.1638 73.1048C96.9202 73.1069 96.6873 73.2015 96.515 73.3681C96.3428 73.5347 96.2451 73.76 96.2428 73.9956V92.6171C96.2451 92.8527 96.3428 93.078 96.515 93.2446C96.6873 93.4112 96.9202 93.5057 97.1638 93.5079H121.773V97.8793H97.1638C96.449 97.8805 95.741 97.7453 95.0804 97.4813C94.4198 97.2173 93.8195 96.8298 93.3141 96.3409C92.8087 95.852 92.408 95.2714 92.1351 94.6323C91.8621 93.9933 91.7223 93.3085 91.7236 92.6171V73.9956C91.7223 73.3042 91.8621 72.6194 92.1351 71.9804C92.408 71.3413 92.8087 70.7607 93.3141 70.2718C93.8195 69.7829 94.4198 69.3954 95.0804 69.1314C95.741 68.8674 96.449 68.7321 97.1638 68.7334H121.773V73.1048H97.1638Z" fill="white"/>
<path d="M163.28 68.7334C163.995 68.7321 164.703 68.8674 165.363 69.1314C166.024 69.3954 166.624 69.7829 167.13 70.2718C167.635 70.7607 168.036 71.3413 168.309 71.9804C168.582 72.6194 168.722 73.3042 168.72 73.9956V92.6171C168.722 93.3085 168.582 93.9933 168.309 94.6323C168.036 95.2714 167.635 95.852 167.13 96.3409C166.624 96.8298 166.024 97.2173 165.363 97.4813C164.703 97.7453 163.995 97.8805 163.28 97.8793H144.029C143.314 97.8805 142.606 97.7453 141.946 97.4813C141.285 97.2173 140.685 96.8298 140.179 96.3409C139.674 95.852 139.273 95.2714 139 94.6323C138.727 93.9933 138.588 93.3085 138.589 92.6171V73.9956C138.588 73.3042 138.727 72.6194 139 71.9804C139.273 71.3413 139.674 70.7607 140.179 70.2718C140.685 69.7829 141.285 69.3954 141.946 69.1314C142.606 68.8674 143.314 68.7321 144.029 68.7334H163.28ZM163.28 93.5067C163.524 93.5046 163.757 93.41 163.929 93.2434C164.101 93.0768 164.199 92.8515 164.201 92.6159V73.9956C164.199 73.76 164.101 73.5347 163.929 73.3681C163.757 73.2015 163.524 73.1069 163.28 73.1048H144.029C143.785 73.1069 143.552 73.2015 143.38 73.3681C143.208 73.5347 143.11 73.76 143.108 73.9956V92.6171C143.11 92.8527 143.208 93.078 143.38 93.2446C143.552 93.4112 143.785 93.5057 144.029 93.5079L163.28 93.5067Z" fill="white"/>
<path d="M211.484 68.7344H216.007V97.879H210.65L190.391 74.5628V97.879H185.872V68.7344H191.229L211.488 92.0506L211.484 68.7344Z" fill="white"/>
<path d="M131.506 12.6071C131.506 15.2318 131.558 17.859 131.469 20.4821C131.431 21.1772 131.15 21.8391 130.672 22.3594C123.456 29.5661 116.211 36.7475 108.937 43.9035C107.81 45.0176 107.7 45.0134 106.541 43.8654C99.3832 36.7828 92.2206 29.703 85.0532 22.6259C84.7056 22.3131 84.4318 21.9316 84.2505 21.5072C84.0691 21.0828 83.9845 20.6256 84.0023 20.1667C84.0494 15.0439 84.0194 9.9203 84.0494 4.79667C84.1118 4.31479 84.2354 3.84218 84.4174 3.38954C84.9114 3.5696 85.3771 3.81531 85.801 4.11959C87.5758 5.81395 89.3343 7.529 91.0149 9.31027C91.4562 9.80497 91.7199 10.4247 91.7662 11.0766C91.8578 13.146 91.7474 15.2269 91.8373 17.2978C91.8707 17.9545 92.1307 18.5814 92.5757 19.0783C97.3172 23.8294 102.124 28.5202 106.878 33.2605C107.59 33.9707 108.043 33.8648 108.691 33.22C113.452 28.4862 118.251 23.788 122.992 19.0352C123.397 18.5604 123.625 17.9677 123.639 17.3525C123.717 15.2831 123.625 13.2031 123.706 11.1304C123.731 10.514 123.965 9.92256 124.371 9.44684C126.18 7.54969 128.066 5.72207 129.958 3.90107C130.293 3.66942 130.662 3.48932 131.054 3.36719C131.253 3.71253 131.393 4.08683 131.468 4.47551C131.503 7.18466 131.487 9.89464 131.487 12.6046H131.506" fill="white"/>
<path d="M107.824 0.00208965C113.334 0.00208965 118.843 -0.0086708 124.353 0.0186442C124.93 0.078645 125.5 0.197959 126.051 0.374567C125.796 0.916907 125.48 1.43044 125.109 1.90586C123.372 3.6921 121.606 5.45433 119.792 7.16772C119.457 7.46397 119.196 7.82955 119.028 8.23717C118.859 8.64478 118.788 9.08392 118.82 9.52178C118.88 11.6739 118.886 13.8375 118.809 15.9913C118.786 16.6074 118.549 17.1982 118.138 17.6691C115.034 20.8236 111.854 23.9085 108.732 27.0472C108.01 27.7732 107.483 27.7334 106.784 27.0315C103.688 23.9267 100.537 20.8724 97.4674 17.7436C97.0319 17.242 96.7814 16.6144 96.7554 15.9598C96.6699 13.8077 96.6895 11.6457 96.7417 9.4895C96.7707 9.07249 96.7022 8.65454 96.5413 8.26664C96.3804 7.87875 96.1313 7.53088 95.8124 7.24884C93.9975 5.53793 92.233 3.77239 90.4967 1.98615C90.0929 1.48218 89.7423 0.940345 89.4502 0.368773C90.0522 0.195974 90.67 0.0795567 91.2951 0.0211274C96.8051 -0.00618762 102.316 0.00208965 107.824 0.00208965Z" fill="white"/>
    </svg>
    </a>
  </div>
</header>
<div class="toggle-group"><label class="toggle"><input type="checkbox" id="includeAll" ${settings.includeAll ? 'checked' : ''}/>Include view/pure functions</label>
<label class="toggle"><input type="checkbox" id="includeDeps" ${settings.includeDeps ? 'checked' : ''}/>Include external libraries/dependencies</label></div><hr />
<section><strong>File:</strong> ${escapeHtml(fileName)}<div style="margin-top:12px;">${bodyWithNonce}</div></section>
<footer class="argus-footer">Generated by the <strong>Recon</strong> VS Code Extension &middot; <a href="https://getrecon.xyz" target="_blank" rel="noopener noreferrer">getrecon.xyz</a></footer>
<script nonce="${nonce}">
// Pure JS host script (no TypeScript syntax)
// Acquire VS Code API exactly once; reuse via window.vscode / window.__vscodeApi to avoid multiple acquisition error.
if(!window.__vscodeApiInternal){
  try {
    window.__vscodeApiInternal = acquireVsCodeApi();
    console.log('[Argus] VS Code API acquired (initial)');
  } catch(err){
    console.error('[Argus] Failed initial acquireVsCodeApi', err);
  }
} else {
  console.log('[Argus] Reusing existing VS Code API instance');
}
// Provide canonical alias
var vscode = window.__vscodeApiInternal;
window.vscode = vscode;
// Explicit toggle functions (in case inner ones stripped or shadowed by Prism load order)
function toggleNode(nodeId){
  var node = document.getElementById(nodeId);
  if(!node) return;
  var children = document.getElementById(nodeId+'-children');
  var header = node.previousElementSibling;
  var toggle = header && header.querySelector ? header.querySelector('.node-toggle') : null;
  var collapsed = node.classList.contains('collapsed');
  if(collapsed){ node.classList.remove('collapsed'); if(children) children.classList.remove('collapsed'); if(toggle) toggle.textContent='▼'; }
  else { node.classList.add('collapsed'); if(children) children.classList.add('collapsed'); if(toggle) toggle.textContent='▶'; }
}
function expandAllNodes(){
  var contents = document.querySelectorAll('.node-content.collapsed, .node-children.collapsed');
  for(var i=0;i<contents.length;i++){ contents[i].classList.remove('collapsed'); }
  var toggles = document.querySelectorAll('.node-toggle');
  for(var j=0;j<toggles.length;j++){ if(toggles[j].textContent==='▶') toggles[j].textContent='▼'; }
}
// Expose globally for any inner scripts expecting window.toggleNode / window.expandAllNodes
window.toggleNode = toggleNode;
window.expandAllNodes = expandAllNodes;
// Fallback direct binding: if delegation or data-action missing, allow clicking header itself
function attachHeaderClicks(){
  var headers = document.querySelectorAll('.node-header[data-node-id], .node-header[data-action="toggle-node"]');
  for(var i=0;i<headers.length;i++){
    (function(h){
      h.addEventListener('click', function(ev){
        var nid = h.getAttribute('data-node-id') || (h.getAttribute('data-node-id')? h.getAttribute('data-node-id'): null);
        // Some templates use next sibling id pattern; attempt derive
        if(!nid){
          var next = h.nextElementSibling; if(next && next.id) nid = next.id;
        }
        console.log('[Argus] header click', nid);
        if(nid) toggleNode(nid);
      });
    })(headers[i]);
  }
  console.log('[Argus] Attached header click fallbacks:', headers.length);
}
document.addEventListener('DOMContentLoaded', attachHeaderClicks);
function send(key, value){ vscode.postMessage({ type: 'updateSetting', key, value }); }
var includeAll = document.getElementById('includeAll');
if(includeAll){ includeAll.addEventListener('change', function(){ send('includeAll', includeAll.checked); }); }
var includeDeps = document.getElementById('includeDeps');
if(includeDeps){ includeDeps.addEventListener('change', function(){ send('includeDeps', includeDeps.checked); }); }

// Fallback implementations if inner script definitions were stripped
if(!window.toggleNode){ window.toggleNode = function(nodeId){
  var node = document.getElementById(nodeId);
  if(!node) return;
  var children = document.getElementById(nodeId+'-children');
  var header = node.previousElementSibling;
  var toggle = header && header.querySelector ? header.querySelector('.node-toggle') : null;
  var collapsed = node.classList.contains('collapsed');
  if(collapsed){ node.classList.remove('collapsed'); if(children) children.classList.remove('collapsed'); if(toggle) toggle.textContent='▼'; }
  else { node.classList.add('collapsed'); if(children) children.classList.add('collapsed'); if(toggle) toggle.textContent='▶'; }
}; }
if(!window.expandAllNodes){ window.expandAllNodes = function(){
  var contents = document.querySelectorAll('.node-content.collapsed, .node-children.collapsed');
  for(var i=0;i<contents.length;i++){ contents[i].classList.remove('collapsed'); }
  var toggles = document.querySelectorAll('.node-toggle');
  for(var j=0;j<toggles.length;j++){ if(toggles[j].textContent==='▶') toggles[j].textContent='▼'; }
}; }

document.addEventListener('click', function(e){
  var t = e.target;
  var el = t && t.closest ? t.closest('[data-action]') : null;
  if(!el) return;
  var action = el.getAttribute('data-action');
  if(action==='run-build'){
    vscode.postMessage({ type: 'runBuild' });
    return;
  }
  if(action==='toggle-node'){ console.log('[Argus] delegation toggle-node', el.getAttribute('data-node-id')); toggleNode(el.getAttribute('data-node-id')); }
  else if(action==='copy-node'){ try {
      var nid = el.getAttribute('data-node-id');
      if(nid){
        var content = document.querySelector('#'+CSS.escape(nid)+' pre code');
        var text = content ? content.textContent : '';
        if(text){
          var doFeedback = function(success){
            var original = el.textContent;
            el.textContent = success? '✅ Copied' : '❌ Failed';
            el.disabled = true;
            setTimeout(function(){ el.textContent = original; el.disabled = false; }, 1500);
          };
          if(navigator.clipboard && navigator.clipboard.writeText){
            navigator.clipboard.writeText(text).then(function(){ doFeedback(true); }, function(){ vscode.postMessage({ type:'copyToClipboard', text:text }); doFeedback(true); });
          } else {
            vscode.postMessage({ type:'copyToClipboard', text:text }); doFeedback(true);
          }
        }
      }
    } catch(err){ console.warn('copy-node error', err); }
  }
  else if(action==='expand-all'){ expandAllNodes(); }
  else if(action==='export-image'){
    console.log('[Argus] export-image click handler fired');
    console.log('[Argus] export-image state', {
      hasExportFn: typeof window.exportAsImage === 'function',
      hasHtml2Canvas: typeof window.html2canvas !== 'undefined',
      html2canvasType: typeof window.html2canvas,
      bodyChildren: document.body ? document.body.children.length : 'n/a'
    });
    var container = document.querySelector('.container');
    if(container){
      console.log('[Argus] container dimensions', { w: container.scrollWidth, h: container.scrollHeight });
    } else {
      console.warn('[Argus] export-image: .container element not found in DOM');
    }
    if(typeof window.exportAsImage === 'function'){
      try {
        window.exportAsImage();
      } catch(err){ console.error('[Argus] exportAsImage invocation error', err); }
    } else {
      console.warn('[Argus] exportAsImage function missing on window');
    }
  }
  else if(action==='toggle-contract'){ window.toggleContract && window.toggleContract(el.getAttribute('data-contract')); }
  else if(action==='load-content'){ window.loadContent && window.loadContent(el.getAttribute('data-path'), el.getAttribute('data-title')); }
});
console.log('[Argus] Host delegation script active (pure JS, nonce applied).');
console.log('[Argus] html2canvas present?', typeof window.html2canvas);
// Attempt Prism highlight after load
try { if (window.Prism && window.Prism.highlightAll) { window.Prism.highlightAll(); console.log('[Argus] Prism highlight executed (outer).'); } else { console.log('[Argus] Prism not ready at host script exec.'); setTimeout(()=>{ if(window.Prism&&window.Prism.highlightAll){ window.Prism.highlightAll(); console.log('[Argus] Prism highlight executed after retry.'); } }, 300); } } catch(e){ console.warn('[Argus] Prism highlight error host', e); }
window.addEventListener('message', function(event){
  var msg = event.data;
  if(!msg || msg.type !== 'exportImageResult') return;
  var btn = document.querySelector('.export-image-btn');
  if(!btn) return;
  if(msg.ok){ btn.innerHTML='✅ Saved'; setTimeout(function(){ btn.innerHTML='📷 Export as Image'; btn.disabled=false; }, 2000); }
  else { btn.innerHTML='❌ Save Failed'; setTimeout(function(){ btn.innerHTML='📷 Export as Image'; btn.disabled=false; }, 2200); }
});
</script></body></html>`;
  }

  private getCspSource(): string {
    return this.context.extensionUri.scheme === 'vscode-file' ? 'vscode-file:' : 'vscode-resource:';
  }
}

function escapeHtml(str: string): string {
  return str.replace(/[&<>'"]/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[s] as string));
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function debounce<T extends (...args: any[]) => unknown>(fn: T, wait: number) {
  let handle: NodeJS.Timeout | undefined;
  return (...args: Parameters<T>) => {
    if (handle) { clearTimeout(handle); }
    handle = setTimeout(() => fn(...args), wait);
  };
}
