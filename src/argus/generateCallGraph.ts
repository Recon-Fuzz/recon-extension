import * as $ from 'solc-typed-ast';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CallType } from './types';
import { generateCombinedHTMLTree, getFunctionName } from './utils';
import { processContract } from './processor';
import { findOutputDirectory } from '../utils';

export interface ArgusGenerateOptions {
  source: string;
  filePath: string;            // absolute or workspace-relative path
  includeAll: boolean;         // include view/pure
  includeDeps: boolean;        // include external deps (currently no-op for single file)
}

export interface ArgusGenerateResult {
  html: string;
  contracts: {
    name: string;
    functions: { name: string; callType: CallType }[];
    elementSummary: { events: number; structs: number; errors: number; enums: number; udts: number };
  }[];
  errors: string[];
  empty: boolean;
  primaryContractName?: string; // first displayed contract name for filename inference
}

/**
 * Build a minimal Foundry-like compiler output object for a single file so we can reuse the ASTReader.
 */
function buildSingleFileCompilerJson(source: string, filePath: string) {
  return {
    sources: {
      [filePath]: { AST: { /* placeholder; we'll rely on solc-typed-ast parse from text API when available */ } }
    }
  } as any; // We won't actually use this path; instead we construct a fake SourceUnit manually.
}

/**
 * For now, we construct a SourceUnit via parsing using solidity-parser (fallback) if solc-typed-ast does not support direct parse without compiler JSON.
 * Simpler approach: we generate an empty html with message until we integrate real build-info consumption.
 */
export async function generateCallGraph(options: ArgusGenerateOptions): Promise<ArgusGenerateResult> {
  try {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const outDir = await findOutputDirectory(workspaceRoot);
    const buildInfoDir = path.join(outDir, 'build-info');
    const latest = await findLatestBuildInfoFile(buildInfoDir);
    if (!latest) {
      const message = `No build-info artifacts found (expected in ${escapeHtml(buildInfoDir)}). Click 'Run Build' to generate.`;
      return stub(message, true);
    }

    let compilerOutputRaw: any;
    try {
      compilerOutputRaw = JSON.parse(await fs.promises.readFile(latest, 'utf8'));
    } catch (e) {
      return stub(`Failed to read build-info file: ${(e as Error).message}`, true);
    }

    // Foundry build-info structure has .output.sources[path].ast
    const sourceUnitsSection = compilerOutputRaw.output?.sources;
    if (!sourceUnitsSection || Object.keys(sourceUnitsSection).length === 0) {
      return stub('Build-info present but missing embedded AST (output.sources). Re-run forge build --build-info with a profile that keeps AST, then retry.', true);
    }

    const { asts, debugSourceKeys } = await getCachedOrReadAsts(latest, sourceUnitsSection).catch(err => {
      return { asts: [] as $.SourceUnit[], debugSourceKeys: Object.keys(sourceUnitsSection || {}) };
    });
    if (!asts || asts.length === 0) {
      const keys = debugSourceKeys && debugSourceKeys.length ? debugSourceKeys : Object.keys(sourceUnitsSection || {});
      return stub('No ASTs parsed from build-info. (keys: '+ escapeHtml(keys.join(', ')) +')', true);
    }

    // Normalize file path to match SourceUnit.absolutePath endings
  const targetPathAbs = normalizePath(options.filePath);
  const workspaceRootNorm = normalizePath(workspaceRoot) + '/';
  const targetPathRel = targetPathAbs.startsWith(workspaceRootNorm) ? targetPathAbs.slice(workspaceRootNorm.length) : targetPathAbs;
  const targetUnit = asts.find(u => pathMatches(normalizePath(u.absolutePath), targetPathAbs, targetPathRel));
    if (!targetUnit) {
      const unitPaths = asts.map(u => normalizePath(u.absolutePath));
      const debugLines = [
        'Debug Info:',
        ` workspaceRoot: ${escapeHtml(workspaceRoot)}`,
        ` filePathAbs: ${escapeHtml(targetPathAbs)}`,
        ` filePathRel: ${escapeHtml(targetPathRel)}`,
        ` sourceUnits.count: ${asts.length}`,
        ' sourceUnits.list:'
      ].concat(unitPaths.map(p => '  - '+escapeHtml(p)));
      const message = `Current file not present in latest build-info (${escapeHtml(path.basename(latest))}). Save & rebuild?`;
      return stub(message + '<pre style="margin-top:12px;max-height:250px;overflow:auto;">' + debugLines.join('\n') + '</pre>', true);
    }

    const contracts: ArgusGenerateResult['contracts'] = [];
    const errors: string[] = [];
    for (const contract of targetUnit.getChildrenByType($ .ContractDefinition)) {
      if (!contract.fullyImplemented || contract.abstract || contract.kind !== 'contract') continue;
      try {
        const processed = processContract(contract, options.includeAll, options.includeDeps);
        if (processed.vFunctions.length === 0) continue;
        let html = generateCombinedHTMLTree(
          processed.vFunctions,
          contract.name,
          {
            vEvents: processed.vEvents,
            vStructs: processed.vStructs,
            vErrors: processed.vErrors,
            vEnums: processed.vEnums,
            vUserDefinedValueTypes: processed.vUserDefinedValueTypes
          },
          options.includeAll,
          undefined
        );
        html = sanitizeGraphHtml(html);
        html = injectPrism(html);
        contracts.push({
          name: contract.name,
            functions: processed.vFunctions.map((f: any) => ({
              name: f.ast instanceof $ .FunctionDefinition ? getFunctionName(f.ast) : 'unknown',
              callType: f.callType || CallType.Internal
            })),
          elementSummary: {
            events: processed.vEvents?.length || 0,
            structs: processed.vStructs?.length || 0,
            errors: processed.vErrors?.length || 0,
            enums: processed.vEnums?.length || 0,
            udts: processed.vUserDefinedValueTypes?.length || 0
          }
        });
        // For single file we currently show first contract html (later multi-tab)
  return { html, contracts, errors, empty: contracts.length === 0, primaryContractName: contracts[0]?.name };
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
    if (contracts.length === 0) {
      return stub('No non-abstract contracts with eligible functions in this file.');
    }
  return { html: '<div>Unknown state</div>', contracts, errors, empty: false, primaryContractName: contracts[0]?.name };
  } catch (err) {
    return {
      html: `<div style=\"font-family:var(--vscode-font-family);padding:16px;color:var(--vscode-errorForeground);\"><strong>Argus Error:</strong> ${escapeHtml((err as Error).message)}</div>`,
      contracts: [],
      errors: [(err as Error).message],
      empty: true,
      primaryContractName: undefined
    };
  }
}

async function findLatestBuildInfoFile(buildInfoDir: string): Promise<string | null> {
  try {
    if (!fs.existsSync(buildInfoDir)) return null;
    const files = await fs.promises.readdir(buildInfoDir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    if (jsonFiles.length === 0) return null;
    const stats = await Promise.all(jsonFiles.map(async f => {
      const fp = path.join(buildInfoDir, f);
      const st = await fs.promises.stat(fp);
      return { file: fp, mtime: st.mtime.getTime() };
    }));
    stats.sort((a,b)=> b.mtime - a.mtime);
    return stats[0].file;
  } catch {
    return null;
  }
}

function stub(message: string, showBuild?: boolean): ArgusGenerateResult {
  return {
    html: `<div style="font-family:var(--vscode-font-family);padding:16px;">`+
      `<p>${escapeHtml(message)}</p>`+
       (showBuild ? `<div style="margin-top:8px;display:flex;gap:8px;">`+
         `<button data-action="run-build">Run Build</button>`+
       `</div>`: '')+
      `</div>`,
    contracts: [],
    errors: [],
    empty: true
  };
}

function normalizePath(p: string): string { return p.split(path.sep).join('/'); }
function pathsEqual(a: string, b: string): boolean { return a === b || a.endsWith('/'+path.basename(b)); }
function pathMatches(unitPath: string, abs: string, rel: string): boolean {
  return unitPath === abs || unitPath === rel || unitPath.endsWith('/'+path.basename(abs)) || unitPath.endsWith('/'+path.basename(rel));
}

function escapeHtml(str: string) {
  return str.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;','\'':'&#39;'}[c] as string));
}
// Remove inline event handlers and external prism CDN references to satisfy CSP
function sanitizeGraphHtml(html: string): string {
  // Strip on* attributes (onclick, onmouseover, etc.)
  html = html.replace(/\son[a-zA-Z]+="[^"]*"/g, '');
  // Remove script/style/link tags pointing to cdnjs prism
  html = html.replace(/<link[^>]*prism[^>]*>/gi, '');
  html = html.replace(/<script[^>]*prism[^>]*><\/script>/gi, '');
  return html;
}

function injectPrism(html: string): string {
  // If already has our marker, skip
  if (html.includes('data-prism-inline')) return html;
  // We still keep token CSS but omit injecting the JS portion because provider now loads external prism scripts.
  const delegationJs = `document.addEventListener('click', function(e){
    var target = e.target;
    if(!target) return;
    var el = (target.closest && target.closest('[data-action]')) || null;
    if(!el) return;
    var action = el.getAttribute('data-action');
    if(action==='toggle-element') {
      var id = el.getAttribute('data-target');
      if(!id) return;
      var section = document.getElementById(id);
      var toggle = document.getElementById('toggle-'+id);
      if(section){ section.classList.toggle('collapsed'); }
      if(toggle){ toggle.classList.toggle('collapsed'); toggle.textContent = toggle.classList.contains('collapsed') ? '▶' : '▼'; }
      return;
    }
    var w = window;
    if(action==='toggle-node') {
      var nid = el.getAttribute('data-node-id'); if(nid && w.toggleNode) w.toggleNode(nid);
    } else if(action==='expand-all') {
      if(w.expandAllNodes) w.expandAllNodes();
    } else if(action==='export-image') {
      // Disabled here to avoid double invocation; host script in provider handles export-image clicks.
      // if(w.exportAsImage) w.exportAsImage();
    } else if(action==='toggle-contract') {
      var name = el.getAttribute('data-contract'); if(name && w.toggleContract) w.toggleContract(name);
    } else if(action==='load-content') {
      var p = el.getAttribute('data-path'); var title = el.getAttribute('data-title'); if(p && w.loadContent) w.loadContent(p, title);
    }
  });`;
  const darkCss = `:root { --argus-bg: var(--vscode-editor-background); --argus-panel-bg: var(--vscode-editorWidget-background, #1e1e1e); --argus-border: var(--vscode-editorWidget-border, #333); --argus-accent: var(--vscode-editorLineNumber-activeForeground, #569CD6); --argus-text: var(--vscode-editor-foreground, #d4d4d4); }
  body, .container, .functions-container, .node-header, .node-actions, .stats-panel, .element-content, .internal-function-code pre, .internal-function-callers, .internal-function-header { background: var(--argus-panel-bg) !important; color: var(--argus-text) !important; }
  body { background: var(--argus-bg) !important; }
  .container { box-shadow: none !important; border:1px solid var(--argus-border); }
  .node-header { border:1px solid var(--argus-border); }
  .node-header:hover { background: rgba(255,255,255,0.05) !important; }
  .node-content { border:1px solid var(--argus-border); }
  .stats-panel { border:1px solid var(--argus-border); }
  .element-item pre, .node-content pre, .internal-function-code pre { background: #1e1e1e !important; }
  .action-btn:hover, .export-btn:hover { filter:brightness(1.1); }
  .element-count { background: linear-gradient(135deg,var(--argus-accent),#267dbe) !important; box-shadow:none !important; }
  h1, .node-name, .internal-function-name, .element-label, .slot-label, .ruler-label, .ruler-tick { color: var(--argus-text) !important; }
  .byte-cell.empty { background: rgba(86,156,214,0.15) !important; }
  .byte-cell.occupied { background: #0e639c !important; }
  .warning-bg { background:#3d3a1a !important; border-color:#776f2a !important; }
  .danger-bg { background:#5a1e23 !important; border-color:#7a2d33 !important; }
  .info-panel { background:#094771 !important; border-color:#0e639c !important; }
  .element-item { border-bottom:1px solid rgba(255,255,255,0.05) !important; }
  .element-content.collapsed { display:none !important; }
  .slots-ruler { border-bottom:1px solid var(--argus-border) !important; }
  .ruler-byte { background: rgba(86,156,214,0.08) !important; box-shadow: 0 0 0 0 black, 1px 0 0 0 #333 !important; }
  .node-children { border-left:2px solid var(--argus-accent) !important; }
  .element-count { color:#fff !important; }
  .node-toggle { color: var(--argus-accent) !important; }
  .internal-function-callers { background:#094771 !important; border-color:#0e639c !important; }
  .caller-link { color: var(--argus-accent) !important; }
  /* Contract Elements sidebar overrides for dark theme */
  .contract-elements-sidebar .sidebar-content,
  .contract-elements-sidebar .element-content,
  .contract-elements-sidebar .node-header,
  .contract-elements-sidebar .element-item,
  .contract-elements-sidebar .sidebar-header h3 { background: var(--argus-panel-bg) !important; color: var(--argus-text) !important; }
  .contract-elements-sidebar .element-content { border:1px solid var(--argus-border) !important; border-top:none !important; }
  .contract-elements-sidebar .node-header { background: var(--argus-panel-bg) !important; }
  .contract-elements-sidebar .node-header:hover,
  .contract-elements-sidebar .element-item:hover { background: rgba(255,255,255,0.05) !important; }
  .contract-elements-sidebar .element-item { transition: background-color .15s ease; }
  .contract-elements-sidebar .element-toggle,
  .contract-elements-sidebar .element-label { color: var(--argus-text) !important; }
  .contract-elements-sidebar .element-count { box-shadow:none !important; }
  .contract-elements-sidebar .element-item pre { background:#1e1e1e !important; }
  .contract-elements-sidebar .element-item code { color: var(--argus-text) !important; }
`;
  // Inline only Prism + delegation here (html2canvas now injected in host head)
  // Only delegation JS now; Prism highlight handled by provider (with retry)
  const scriptTag = `<script data-prism-inline>${delegationJs}</script>`;
  const darkStyle = `<style data-argus-dark>${darkCss}</style>`;
  // Insert just before closing body or at end
  if (html.includes('</body>')) {
    return html.replace('</body>', `${darkStyle}${scriptTag}</body>`);
  }
  return  darkStyle + scriptTag + html;
}

// Caching of parsed ASTs to avoid re-reading on frequent preview refreshes
interface AstCacheEntry { file: string; mtimeMs: number; asts: $ .SourceUnit[]; sourceKeys: string[] }
let astCache: AstCacheEntry | undefined;

async function getCachedOrReadAsts(latestFile: string, sourcesSection: Record<string, any>): Promise<{ asts: $ .SourceUnit[]; debugSourceKeys: string[] }> {
  const reader = new $ .ASTReader();
  const stat = await fs.promises.stat(latestFile).catch(()=>undefined);
  if (stat && astCache && astCache.file === latestFile && astCache.mtimeMs === stat.mtimeMs) {
    return { asts: astCache.asts, debugSourceKeys: astCache.sourceKeys };
  }
  const solcSources: Record<string, any> = {};
  for (const [p, value] of Object.entries<any>(sourcesSection)) {
    try {
      if (value && typeof value === 'object' && (value as any).ast) {
        solcSources[p] = { AST: (value as any).ast };
      }
    } catch {/* ignore bad entry */}
  }
  let asts: $ .SourceUnit[] = [];
  try {
    asts = reader.read({ sources: solcSources } as any) || [];
  } catch {
    asts = [];
  }
  if (stat) {
    astCache = { file: latestFile, mtimeMs: stat.mtimeMs, asts, sourceKeys: Object.keys(solcSources) };
  }
  return { asts, debugSourceKeys: Object.keys(solcSources) };
}
