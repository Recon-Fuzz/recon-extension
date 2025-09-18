import * as $ from 'solc-typed-ast';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CallType } from './types';
import { generateCombinedHTMLTree, getFunctionName } from './utils';
import { processSlots } from './slot';
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
        // Always compute storage slot layout so slots viewer is shown regardless of includeAll flag
        const slotData = processSlots(contract);
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
          slotData
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
  const darkCss = `/*
  Argus Call Graph Embedded Styles
  ------------------------------------------------------------------
  Token Mapping (design system -> CSS variable)
  - back-neutral-primary (page background)        -> --argus-bg
  - card/panel base (rest)                        -> --argus-surface-1
  - card hover / subtle raised                    -> --argus-surface-2
  - card pressed / active                         -> --argus-surface-3
  - fill-accent-primary (primary button rest)     -> --argus-accent
  - fill-accent-primary (hover)                   -> --argus-accent-hover
  - fill-accent-primary (pressed)                 -> --argus-accent-active
  - fill-accent-alt-* (lighter accent variants)   -> --argus-accent-alt / hover
  - fore-neutral-primary (strong text)            -> --argus-text-strong
  - fore-neutral-secondary (body text)            -> --argus-text
  - fore-neutral-tertiary (muted)                 -> --argus-text-muted
  - fore-neutral-quaternary (faint)               -> --argus-text-faint
  - stroke-neutral-decorative / borders           -> --argus-border
  - stroke-strong                                 -> --argus-border-strong
  - accent stroke                                 -> --argus-border-accent
  - focus ring (accent glow)                      -> --argus-focus-ring
  - semantic info / warn / danger backgrounds     -> --argus-info-bg / --argus-warn-bg / --argus-danger-bg
  - code background                               -> --argus-code-bg
  Additions:
  - scroll thumb colors                           -> --argus-scroll-thumb / hover
  ------------------------------------------------------------------ */
  /* Design Tokens (Dark) inspired by system design */
  :root {
    /* Background surfaces */
    --argus-bg: #1f1d27; /* page background (closest to back-neutral-primary) */
    --argus-surface-1: #221f2b; /* card / panel base */
    --argus-surface-2: #2a2733; /* raised / hovered */
    --argus-surface-3: #322f3b; /* active / pressed */
    /* Accent scale (primary -> tertiary) */
    --argus-accent: #6f5af6; /* primary accent default */
    --argus-accent-hover: #5d47f2;
    --argus-accent-active: #4b39d6;
    --argus-accent-alt: #8a7bfa; /* lighter alt */
    --argus-accent-alt-hover: #7b6cf5;
    /* Text colors */
    --argus-text-strong: #ffffff;
    --argus-text: #d5d3de; /* body text */
    --argus-text-muted: #9b97aa;
    --argus-text-faint: #6b6779;
    /* Borders / outlines */
    --argus-border: #3a3646;
    --argus-border-strong: #4a4556;
    --argus-border-accent: #6f5af6;
    /* States */
    --argus-focus-ring: 0 0 0 2px rgba(111,90,246,0.6);
    --argus-scroll-thumb: #3e3950;
    --argus-scroll-thumb-hover: #4a4460;
    /* Semantic backgrounds */
    --argus-info-bg: #21324a;
    --argus-info-border: #2f4d73;
    --argus-warn-bg: #403519;
    --argus-warn-border: #6b5520;
    --argus-danger-bg: #47262a;
    --argus-danger-border: #6f373d;
    /* Code */
    --argus-code-bg: #1e1d26;
  }
  body { background: var(--argus-bg) !important; color: var(--argus-text); }
  .container { background: var(--argus-surface-1) !important; border:1px solid var(--argus-border); border-radius:8px; }
  h1, .node-name, .internal-function-name { color: var(--argus-text-strong) !important; font-weight:600; }
  .node-header { background: var(--argus-surface-1) !important; border:1px solid var(--argus-border); border-radius:6px; padding:6px 10px; }
  .node-header:hover { background: var(--argus-surface-2) !important; }
  .node-header:active { background: var(--argus-surface-3) !important; }
  .node-content { border:1px solid var(--argus-border); background: var(--argus-surface-2) !important; border-radius:6px; }
  .stats-panel { border:1px solid var(--argus-border); background: var(--argus-surface-1) !important; border-radius:8px; }
  .internal-function-code pre, .element-item pre, .node-content pre { background: var(--argus-code-bg) !important; }
  .element-count { background: var(--argus-accent); color: #fff !important; border-radius:999px; font-weight:600; }
  .element-item { border-bottom:1px solid var(--argus-border); }
  .element-item:hover { background: var(--argus-surface-2) !important; }
  .element-content.collapsed { display:none !important; }
  .node-children { border-left:2px solid var(--argus-accent) !important; }
  .node-toggle { color: var(--argus-accent); }
  .byte-cell.empty { background: var(--argus-surface-2) !important; }
  /* Storage slot grid separators */
  .byte-cell { border-left:1px solid var(--argus-border); box-shadow:none !important; margin:0 !important; }
  .slot-bytes .byte-cell:first-child { border-left:none; }
  .warning-bg { background: var(--argus-warn-bg) !important; border-color: var(--argus-warn-border) !important; }
  .danger-bg { background: var(--argus-danger-bg) !important; border-color: var(--argus-danger-border) !important; }
  .info-panel { background: var(--argus-info-bg) !important; border-color: var(--argus-info-border) !important; }
  .internal-function-callers { background: var(--argus-info-bg) !important; border-color: var(--argus-info-border) !important; }

  /* Buttons */
  .export-btn, .action-btn { background: var(--argus-accent); color:#fff; border:1px solid var(--argus-accent); border-radius:8px; padding:6px 14px; font-weight:500; font-family: inherit; cursor:pointer; transition: background .15s, box-shadow .15s, transform .15s; }
  .export-btn:hover, .action-btn:hover { background: var(--argus-accent-hover); }
  .export-btn:active, .action-btn:active { background: var(--argus-accent-active); transform:translateY(1px); }
  .export-btn:focus-visible, .action-btn:focus-visible { outline:none; box-shadow: var(--argus-focus-ring); }
  .export-btn.secondary, .action-btn.secondary { background: var(--argus-surface-2); color: var(--argus-text); border:1px solid var(--argus-border); }
  .export-btn.secondary:hover, .action-btn.secondary:hover { background: var(--argus-surface-3); }
  .export-btn.outline, .action-btn.outline { background: transparent; color: var(--argus-text); border:1px solid var(--argus-border-accent); }
  .export-btn.outline:hover, .action-btn.outline:hover { background: var(--argus-surface-2); }
  /* Scrollbar */
  ::-webkit-scrollbar { width:10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--argus-scroll-thumb); border-radius:6px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--argus-scroll-thumb-hover); }
  /* Contract Elements sidebar overrides for dark theme */
  .contract-elements-sidebar .sidebar-content,
  .contract-elements-sidebar .element-content,
  .contract-elements-sidebar .node-header,
  .contract-elements-sidebar .element-item,
  .contract-elements-sidebar .sidebar-header h3 { background: var(--argus-surface-1) !important; color: var(--argus-text) !important; }
  .contract-elements-sidebar .element-content { margin-left: 10px; margin-right: 10px; }
  .contract-elements-sidebar .node-header { background: var(--argus-surface-1) !important; }
  .contract-elements-sidebar .node-header:hover { background: var(--argus-surface-2) !important; }
  .contract-elements-sidebar .element-item:hover { background: var(--argus-surface-2) !important; }
  .contract-elements-sidebar .element-item { transition: background-color .15s ease; }
  .contract-elements-sidebar .element-toggle,
  .contract-elements-sidebar .element-label { color: var(--argus-text) !important; }
  .contract-elements-sidebar .element-count { background: var(--argus-accent); box-shadow:none !important; }
  .contract-elements-sidebar .element-item pre { background: var(--argus-code-bg) !important; }
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
