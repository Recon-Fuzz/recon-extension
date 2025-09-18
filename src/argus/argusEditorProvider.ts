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

    constructor(private readonly context: vscode.ExtensionContext) {}

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
      if (token !== genToken) return; // stale generation
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
          webviewPanel.webview.html = `<div style="font-family:var(--vscode-font-family);padding:16px;">`+
            `<strong>Building project (forge build --build-info)...</strong><br/><br/>`+
            `Open the <em>Recon</em> output channel to watch progress. The call graph will refresh automatically when done.`+
            `</div>`;
          vscode.commands.executeCommand('recon.buildWithInfo').then(() => {
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
              const fileBase = (suggested || inferredName).replace(/[^a-z0-9_.-]/gi,'_');
              let targetName = fileBase;
              let attempt = 0;
              while (attempt < 50) {
                const candidate = pathMod.join(baseDirFs, targetName);
                console.log('[Argus] exportImage attempt', attempt+1, 'candidate', candidate);
                if (!fs.existsSync(candidate)) {
                  const uri = vscode.Uri.file(candidate);
                  await vscode.workspace.fs.writeFile(uri, buffer);
                  const rel = workspaceRoot ? pathMod.relative(workspaceRoot, uri.fsPath) : uri.fsPath;
                  vscode.window.showInformationMessage(`Argus call graph image saved at workspace root: ${rel}` , 'Open').then(sel => {
                    if (sel === 'Open') { vscode.commands.executeCommand('vscode.open', uri); }
                  });
                  webviewPanel.webview.postMessage({ type: 'exportImageResult', ok: true, file: uri.fsPath });
                  console.log('[Argus] exportImage success', uri.fsPath);
                  return;
                }
                attempt++;
                const stem = fileBase.replace(/\.png$/i,'');
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
    const html2canvasUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'node_modules','html2canvas','dist','html2canvas.min.js'));
    // Extract inner <body> content if a full HTML document was returned to avoid nested <html> issues
  let fragment = body;
  const bodyMatch = body.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) fragment = bodyMatch[1];
  // Collect any style tags from original HTML (head or body) to preserve design
  const styleTags: string[] = [];
  const styleRegex = /<style[^>]*>[\s\S]*?<\/style>/gi;
  let m: RegExpExecArray | null;
  while((m = styleRegex.exec(body))){ styleTags.push(m[0]); }
  const collectedStyles = styleTags.join('\n');
    // Ensure any <script> tags inside the fragment receive the nonce so CSP allows execution
        const bodyWithNonce = fragment
          .replace(/<script(?![^>]*nonce=)/g, `<script nonce="${nonce}"`)
          .replace(/<style(?![^>]*nonce=)/g, `<style nonce="${nonce}"`);

    // Prism resource URIs (mirror working implementation in logToFoundryView)
        const prismCore = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'node_modules','prismjs','prism.js'));
        const prismSolidity = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'node_modules','prismjs','components','prism-solidity.min.js'));
        const prismTheme = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'node_modules','prismjs','themes','prism-tomorrow.css'));
        return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline' ${this.getCspSource()}; script-src 'nonce-${nonce}' ${this.getCspSource()};" />
<title>Argus Call Graph Preview</title>
<link rel="stylesheet" href="${prismTheme}" />
${collectedStyles.replace(/<style/gi, `<style nonce="${nonce}"`).replace(/<script/gi,'<!-- stripped-script')}
<script nonce="${nonce}" src="${prismCore}"></script>
<script nonce="${nonce}" src="${prismSolidity}"></script>
<script nonce="${nonce}" src="${html2canvasUri}"></script>
</head><body>
<header><h2 style="margin:0;">Argus Call Graph</h2><span class="badge">Experimental</span></header>
<div class="toggle-group"><label class="toggle"><input type="checkbox" id="includeAll" ${settings.includeAll ? 'checked' : ''}/>Include view/pure functions</label>
<label class="toggle"><input type="checkbox" id="includeDeps" ${settings.includeDeps ? 'checked' : ''}/>Include external libraries/dependencies</label></div><hr />
<section><strong>File:</strong> ${escapeHtml(fileName)}<div style="margin-top:12px;">${bodyWithNonce}</div></section>
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
    return str.replace(/[&<>'"]/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[s] as string));
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
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => fn(...args), wait);
  };
}
