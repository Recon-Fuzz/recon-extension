import {
  Assignment,
  ASTNode,
  ASTWriter,
  ContractDefinition,
  DataLocation,
  DefaultASTWriterMapping,
  FunctionCall,
  FunctionDefinition,
  FunctionKind,
  FunctionStateMutability,
  Identifier,
  IndexAccess,
  LatestCompilerVersion,
  MemberAccess,
  PrettyFormatter,
  VariableDeclaration,
} from 'solc-typed-ast';
import * as $ from 'solc-typed-ast';
import * as fs from 'fs';
import {
  CallType,
  Constant,
  ContractElements,
  CryticSolcCompilerOutput,
  ElementKey,
  FoundryCompilerOutput,
  Member,
  RecordItem,
} from './types';
import path from 'path';

/**
 * Read and parse the compiler output JSON file
 * @param filePath Path to the JSON file
 * @returns Parsed compiler output
 */
export async function readCompilerOutput(
  filePath: string
): Promise<FoundryCompilerOutput | CryticSolcCompilerOutput> {
  try {
    const fileContent = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(fileContent) as FoundryCompilerOutput | CryticSolcCompilerOutput;
  } catch (error) {
    throw new Error(
      `Failed to read or parse the compiler output file: ${(error as Error).message}`
    );
  }
}

export function highLevelCallWithOptions(fnCall: FunctionCall, noStatic = false): boolean {
  if (
    !(fnCall.vExpression instanceof MemberAccess) ||
    !(fnCall.vExpression.vExpression instanceof MemberAccess)
  ) { return false; }
  const ref = fnCall.vExpression?.vExpression.vReferencedDeclaration;
  if (!(ref instanceof FunctionDefinition)) { return false; }
  if (noStatic) {
    if (
      ref.stateMutability === FunctionStateMutability.Pure ||
      ref.stateMutability === FunctionStateMutability.View ||
      ref.stateMutability === FunctionStateMutability.Constant
    ) {
      return false;
    }
  }

  if (fnCall.vExpression.vExpression.vExpression.typeString.startsWith('type(library ')) {
    if (!ref.vReturnParameters || ref.vReturnParameters?.vParameters.length === 0) { return false; }
    for (const inFnCall of ref.getChildrenByType(FunctionCall)) {
      if (highLevelCall(inFnCall, noStatic)) { return true; }
      if (highLevelCallWithOptions(inFnCall, noStatic)) { return true; }
    }
  }
  return (
    fnCall.vExpression.vExpression.vExpression.typeString.startsWith('contract ') ||
    fnCall.vExpression.vExpression.typeString === 'address'
  );
}

export function highLevelCall(fnCall: FunctionCall, noStatic = false): boolean {
  if (!(fnCall.vExpression instanceof MemberAccess)) { return false; }
  const ref = fnCall.vExpression.vReferencedDeclaration;
  if (!(ref instanceof FunctionDefinition)) { return false; }
  if (noStatic) {
    if (
      ref.stateMutability === FunctionStateMutability.Pure ||
      ref.stateMutability === FunctionStateMutability.View ||
      ref.stateMutability === FunctionStateMutability.Constant
    ) {
      return false;
    }
  }

  if (fnCall.vExpression.vExpression.typeString.startsWith('type(library ')) {
    if (!ref.vReturnParameters || ref.vReturnParameters?.vParameters.length === 0) { return false; }
    for (const inFnCall of ref.getChildrenByType(FunctionCall)) {
      if (highLevelCall(inFnCall, noStatic)) { return true; }
      if (highLevelCallWithOptions(inFnCall, noStatic)) { return true; }
    }
  }
  return (
    fnCall.vExpression.vExpression.typeString.startsWith('contract ') ||
    fnCall.vExpression?.vExpression?.typeString === 'address'
  );
}

export function lowLevelCallWithOptions(fnCall: FunctionCall): boolean {
  return (
    fnCall.vExpression instanceof MemberAccess &&
    fnCall.vExpression.vExpression instanceof MemberAccess &&
    fnCall.vExpression.vExpression.memberName === 'call'
  );
}

export function lowLevelCall(fnCall: FunctionCall): boolean {
  if (fnCall.vExpression instanceof MemberAccess && fnCall.vExpression.memberName === 'call') {
    return true;
  } else if (lowLevelCallWithOptions(fnCall)) {
    return true;
  }
  return false;
}

export function lowLevelStaticCall(fnCall: FunctionCall): boolean {
  if (
    fnCall.vExpression instanceof MemberAccess &&
    fnCall.vExpression.memberName === 'staticcall'
  ) {
    return true;
  } else if (
    fnCall.vExpression instanceof FunctionCall &&
    fnCall.vExpression.vExpression instanceof MemberAccess &&
    fnCall.vExpression.vExpression.memberName === 'staticcall'
  ) {
    return true;
  }
  return false;
}

export function lowLevelDelegateCall(fnCall: FunctionCall): boolean {
  if (
    fnCall.vExpression instanceof MemberAccess &&
    fnCall.vExpression.memberName === 'delegatecall'
  ) {
    return true;
  } else if (
    fnCall.vExpression instanceof FunctionCall &&
    fnCall.vExpression.vExpression instanceof MemberAccess &&
    fnCall.vExpression.vExpression.memberName === 'delegatecall'
  ) {
    return true;
  }
  return false;
}

export function lowLevelSend(fnCall: FunctionCall): boolean {
  if (fnCall.vExpression instanceof MemberAccess && fnCall.vExpression.memberName === 'send') {
    return true;
  } else if (
    fnCall.vExpression instanceof FunctionCall &&
    fnCall.vExpression.vExpression instanceof MemberAccess &&
    fnCall.vExpression.vExpression.memberName === 'send'
  ) {
    return true;
  }
  return false;
}

export function lowLevelTransfer(fnCall: FunctionCall): boolean {
  if (fnCall.vExpression instanceof MemberAccess && fnCall.vExpression.memberName === 'transfer') {
    return true;
  } else if (
    fnCall.vExpression instanceof FunctionCall &&
    fnCall.vExpression.vExpression instanceof MemberAccess &&
    fnCall.vExpression.vExpression.memberName === 'transfer'
  ) {
    return true;
  }
  return false;
}

export function isStateVarAssignment(node: Assignment): boolean {
  const decl = getStateVarAssignment(node);
  if (!decl) { return false; }
  return decl && (decl.stateVariable || decl.storageLocation === DataLocation.Storage);
}

export function getStateVarAssignment(node: Assignment): VariableDeclaration | null {
  const decl = getDeepRef(node.vLeftHandSide);
  if (!(decl instanceof VariableDeclaration)) { return null; }
  return decl;
}

export function getDeepRef(node: ASTNode): ASTNode | undefined {
  if (node instanceof Identifier) {
    return node.vReferencedDeclaration;
  } else if (node instanceof IndexAccess) {
    return getDeepRef(node.vBaseExpression);
  } else if (node instanceof MemberAccess) {
    return getDeepRef(node.vExpression);
  } else {
    return undefined;
  }
}

export function getDefinitions(
  contract: ContractDefinition,
  kind: string,
  inclusion = true
): ASTNode[] {
  let defs: ASTNode[] = inclusion ? (contract[kind as keyof ContractDefinition] as ASTNode[]) : [];
  for (const child of contract.vLinearizedBaseContracts.filter((x) => x !== contract)) {
    defs = getDefinitions(child, kind).concat(
      defs.filter((x: ASTNode) => !getDefinitions(child, kind).includes(x))
    );
  }
  return defs;
}

export function toSource(node: ASTNode, version?: string) {
  const formatter = new PrettyFormatter(4, 0);
  const writer = new ASTWriter(
    DefaultASTWriterMapping,
    formatter,
    version ? version : LatestCompilerVersion
  );
  return writer.write(node);
}

export function getCallType(fnCall: FunctionCall): CallType {
  if (highLevelCall(fnCall)) {
    return CallType.HighLevel;
  } else if (lowLevelCall(fnCall)) {
    return CallType.LowLevel;
  }
  return CallType.Internal;
}

// Function to escape HTML text
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Function to generate unique node ID
export function generateNodeId(prefix: string, index: number): string {
  return `${prefix}_${index}`;
}

// Helper function to build JSON tree from RecordItem
export function buildJsonTree(item: RecordItem): any {
  const code = toSource(item.ast);

  return {
    code: code,
    children: item.children.map((child) => buildJsonTree(child)),
  };
}

export const ignoreList = ['node_modules', 'test', 'tests', 'lib', 'script', 'scripts'];

export const getFunctionName = (fnDef: FunctionDefinition): string => {
  if (fnDef.name) {
    return fnDef.name;
  }
  if (fnDef.isConstructor || fnDef.kind === FunctionKind.Constructor) {
    return 'constructor';
  }
  if (fnDef.kind === FunctionKind.Fallback) {
    return 'fallback';
  }
  if (fnDef.kind === FunctionKind.Receive) {
    return 'receive';
  }
  return 'Unknown';
};

// Function to generate slots viewer
function generateSlotsViewer(slots?: {
  slots: Record<string, Member[]>;
  constants: Constant[];
}): string {
  if (
    !slots ||
    ((!slots.slots || Object.keys(slots.slots).length === 0) &&
      (!slots.constants || slots.constants.length === 0))
  ) {
    return '';
  }

  let constantsHtml = '';
  if (slots.constants && slots.constants.length > 0) {
    constantsHtml = `
            <div class="element-section">
                <div class="node-header" data-action="toggle-element" data-target="constants-section">
                    <span class="element-toggle collapsed" id="toggle-constants-section">▶</span>
                    <span class="element-label">Constant/Immutable Variables</span>
                    <span class="element-count">${slots.constants.length}</span>
                </div>
                <div class="element-content collapsed" id="constants-section">
                    ${slots.constants
        .map(
          (constant) => `
                        <div class="element-item">
                            <pre><code class="language-solidity">${escapeHtml(constant.source)};</code></pre>
                        </div>
                    `
        )
        .join('')}
                </div>
            </div>
        `;
  }

  // Generate byte ruler with numbered positions
  const byteRulerHtml = `
        <div class="slots-ruler">
            <div class="ruler-label">Slot</div>
            <div class="ruler-bytes">
                <div class="tick-section">
                    ${Array.from({ length: 17 }, (_, i) => {
    const pos = 32 - i * 2;
    return `<div class="ruler-section"><div class="ruler-tick">${pos}</div></div>`;
  }).join('')}
                </div>
                ${Array.from({ length: 16 }, (_, i) => {
    const pos = 32 - i * 2;
    const showBorder = pos % 8 === 0;
    return `
                        <div class="ruler-section">
                            <div class="ruler-byte" style="box-shadow: ${showBorder ? '-2px 0 0 0 white, 1px 0 0 0 var(--argus-border)' : '0 0 0 0 white, 1px 0 0 0 var(--argus-border)'};"></div>
                            <div class="ruler-byte"></div>
                        </div>
                    `;
  }).join('')}
            </div>
        </div>
    `;

  // Generate slot rows
  const slotsHtml = Object.entries(slots.slots)
    .map(([slotKey, slotMembers]) => {
      // Truncate in the middle: 0x00...01 format
      const truncatedSlotKey = slotKey.slice(0, 6) + '...' + slotKey.slice(-2);
      // Convert hex to decimal for tooltip
      const decimalValue = parseInt(slotKey, 16);
      const totalUsedBytes = slotMembers.reduce((sum, member) => sum + member.size, 0);
      const emptyBytes = 32 - totalUsedBytes;

      return `
            <div class="slot-row">
                <div class="slot-label" title="${slotKey} => ${decimalValue}">${truncatedSlotKey}</div>
                <div class="slot-bytes">
                    ${Array.from({ length: emptyBytes }, () => '<div class="byte-cell empty"></div>').join('')}
                    ${slotMembers
          .slice()
          .reverse()
          .map(
            (member) => `
                        <div class="byte-cell occupied" 
                             style="flex: ${member.size}; background-color: ${member.parent ? 'var(--argus-warn-bg)' : 'var(--argus-accent-active)'};"
                             title="${member.parent ? `${member.parent.type} ${member.parent.name} -> ${member.type} ${member.name}` : `${member.type} ${member.name}`}&#10;Visibility: ${member.visibility}&#10;Size: ${member.size} bytes&#10;Offset: ${member.offset}">
                            ${member.size === 1 ? '●' : `${member.type} ${member.name}`}
                        </div>
                    `
          )
          .join('')}
                </div>
            </div>
        `;
    })
    .join('');

  return `
        <div class="contract-elements-sidebar">
            <div class="sidebar-header">
                <h3>🗂️ Storage Slots</h3>
            </div>
            <div class="sidebar-content">
                ${constantsHtml}
                ${byteRulerHtml}
                ${slotsHtml}
            </div>
        </div>
    `;
}

function generateContractElementsSidebar(contractElements?: ContractElements): string {
  if (!contractElements) {
    return '';
  }

  const elementTypes = [
    { key: 'vEvents' as ElementKey, label: 'Events' },
    { key: 'vStructs' as ElementKey, label: 'Structs' },
    { key: 'vErrors' as ElementKey, label: 'Errors' },
    { key: 'vEnums' as ElementKey, label: 'Enums' },
    { key: 'vUserDefinedValueTypes' as ElementKey, label: 'User Defined Types' },
  ];

  let sidebarContent = '';
  let elementCounter = 0;

  for (const elementType of elementTypes) {
    const elements = contractElements[elementType.key];
    if (elements && elements.length > 0) {
      const sectionId = `element-section-${elementCounter++}`;
      sidebarContent += `
                <div class="element-section">
                    <div class="node-header" data-action="toggle-element" data-target="${sectionId}">
                        <span class="element-toggle collapsed" id="toggle-${sectionId}">▶</span>
                        <span class="element-label">${elementType.label}</span>
                        <span class="element-count">${elements.length}</span>
                    </div>
                    <div class="element-content collapsed" id="${sectionId}">
                        ${elements
          .map(
            (element: ASTNode) => `
                            <div class="element-item">
                                <pre><code class="language-solidity">${escapeHtml(toSource(element))}</code></pre>
                            </div>
                        `
          )
          .join('')}
                    </div>
                </div>
            `;
    }
  }

  if (!sidebarContent) {
    return '';
  }

  return `
        <div class="contract-elements-sidebar">
            <div class="sidebar-header">
                <h3>📋 Contract Elements</h3>
            </div>
            <div class="sidebar-content">
                ${sidebarContent}
            </div>
        </div>
    `;
}

// Function to collect internal functions and their external callers
function collectInternalFunctionsWithCallers(functions: RecordItem[]): Map<
  string,
  {
    internalFunction: RecordItem;
    externalCallers: Set<string>;
  }
> {
  const internalFunctions = new Map<
    string,
    {
      internalFunction: RecordItem;
      externalCallers: Set<string>;
    }
  >();

  function extractInternalFunctions(item: RecordItem, rootFunctionName: string) {
    // If this is an internal function, track it
    if (item.callType === CallType.Internal && item.ast instanceof $.FunctionDefinition) {
      const internalFunctionName = getFunctionName(item.ast);
      if (!internalFunctions.has(internalFunctionName)) {
        internalFunctions.set(internalFunctionName, {
          internalFunction: item,
          externalCallers: new Set(),
        });
      }
      internalFunctions.get(internalFunctionName)!.externalCallers.add(rootFunctionName);
    }

    // Recursively process children
    for (const child of item.children) {
      extractInternalFunctions(child, rootFunctionName);
    }
  }

  // Process all root functions
  functions.forEach((rootFunction) => {
    const rootFunctionName =
      rootFunction.ast instanceof $.FunctionDefinition
        ? getFunctionName(rootFunction.ast)
        : 'Unknown';

    // Process all children of this root function
    rootFunction.children.forEach((child) => {
      extractInternalFunctions(child, rootFunctionName);
    });
  });

  return internalFunctions;
}

// Function to generate internal functions section HTML
function generateInternalFunctionsSection(
  internalFunctionsMap: Map<
    string,
    {
      internalFunction: RecordItem;
      externalCallers: Set<string>;
    }
  >
): string {
  if (internalFunctionsMap.size === 0) {
    return '';
  }

  // Sort internal functions alphabetically
  const sortedInternalFunctions = Array.from(internalFunctionsMap.entries()).sort(
    ([nameA], [nameB]) => nameA.localeCompare(nameB)
  );

  const internalFunctionsHtml = sortedInternalFunctions
    .map(([functionName, data]) => {
      const sourceCode = toSource(data.internalFunction.ast);
      const callersArray = Array.from(data.externalCallers).sort();

      // Generate clickable links for each caller
      const callersLinksHtml = callersArray
        .map(
          (callerName) =>
            `<a href="${escapeHtml(callerName)}.html" class="caller-link">${escapeHtml(callerName)}</a>`
        )
        .join(', ');

      // Get the absolute path of the source file
      const sourceUnit = data.internalFunction.ast.getClosestParentByType($.SourceUnit);
      const absolutePath = sourceUnit ? sourceUnit.absolutePath : '';

      return `
      <div class="internal-function-item">
        <div class="internal-function-header">
          <span class="internal-function-name">${escapeHtml(functionName)}</span>
          <span class="node-path">${escapeHtml(absolutePath)}</span>
        </div>
        <div class="internal-function-callers">
          <strong>Called by:</strong> ${callersLinksHtml}
        </div>
        <div class="internal-function-code">
          <pre><code class="language-solidity">${escapeHtml(sourceCode)}</code></pre>
        </div>
      </div>
    `;
    })
    .join('');

  return `
    <div class="contract-elements-sidebar">
      <div class="sidebar-header">
        <h3>🔗 Internal Functions</h3>
      </div>
      <div class="sidebar-content">
        <div class="element-section">
          <div class="node-header" data-action="toggle-element" data-target="internal-functions-section">
            <span class="element-toggle collapsed" id="toggle-internal-functions-section">▶</span>
            <span class="element-label">Internal Functions</span>
            <span class="element-count">${internalFunctionsMap.size}</span>
          </div>
          <div class="element-content collapsed" id="internal-functions-section">
            ${internalFunctionsHtml}
          </div>
        </div>
      </div>
    </div>
  `;
}

// Function to generate combined HTML tree for all functions
export function generateCombinedHTMLTree(
  functions: RecordItem[],
  contractName: string,
  contractElements?: ContractElements,
  isAllFunctions: boolean = true,
  slots?: { slots: Record<string, Member[]>; constants: Constant[] }
): string {
  let allFunctionsHtml = '';
  let nodeCounter = 0;

  function processNode(item: RecordItem, depth: number = 0, functionIndex: number = 0): string {
    const nodeId = `func${functionIndex}_${generateNodeId('node', nodeCounter++)}`;

    // Get the source code for the node
    const sourceCode = toSource(item.ast);
    const nodeName =
      item.ast instanceof $.FunctionDefinition
        ? getFunctionName(item.ast)
        : item.ast instanceof $.ModifierDefinition
          ? item.ast.name
          : 'Unknown';

    // Get the absolute path of the source file
    const sourceUnit = item.ast.getClosestParentByType($.SourceUnit);
    const absolutePath = sourceUnit ? sourceUnit.absolutePath : '';

    // Check if function is view/pure
    const isViewOrPure =
      item.ast instanceof $.FunctionDefinition &&
      (item.ast.stateMutability === $.FunctionStateMutability.Pure ||
        item.ast.stateMutability === $.FunctionStateMutability.View);
    const viewPureIndicator =
      isViewOrPure && item.ast instanceof $.FunctionDefinition
        ? `<span class="view-pure-indicator" title="${item.ast.stateMutability}">👁️</span>`
        : '';

    // Get call type and determine background color
    const callType = item.callType || CallType.Internal;
    const callTypeText = callType === CallType.Internal ? 'Local' : callType;
    let backgroundClass = '';

    if (callType === CallType.HighLevel || callType === CallType.LowLevel) {
      if (item.ast instanceof $.FunctionDefinition) {
        const isPureOrView =
          item.ast.stateMutability === $.FunctionStateMutability.Pure ||
          item.ast.stateMutability === $.FunctionStateMutability.View;
        backgroundClass = isPureOrView ? 'warning-bg' : 'danger-bg';
      } else {
        backgroundClass = 'danger-bg'; // Default for non-function definitions
      }
    }

    // Count external calls recursively for combined view
    const redCount = countRedExternalCalls(item);
    const yellowCount = countYellowExternalCalls(item);

    const hasChildren = item.children.length > 0;
    const indent = '  '.repeat(depth);

    // Build JSON data for this node
    const jsonData = buildJsonTree(item);
    const jsonDataStr = escapeHtml(JSON.stringify(jsonData));

    let html = `
${indent}<div class="tree-node" style="margin-left: ${depth * 20}px;">
${indent}  <div class="node-header ${backgroundClass}" data-action="toggle-node" data-node-id="${nodeId}">
${indent}    <div class="node-header-left">
${indent}      <span class="node-toggle">▶</span>
${indent}      <span class="node-name">${escapeHtml(nodeName || 'Unknown')}${viewPureIndicator}</span>
${indent}      <span class="call-type">[${callTypeText}]</span>
${indent}      ${redCount > 0 ? `<span class="external-indicator red-indicator">${redCount}</span>` : ''}
${indent}      ${yellowCount > 0 ? `<span class="external-indicator yellow-indicator">${yellowCount}</span>` : ''}
${indent}    </div>
${indent}    <span class="node-path">${escapeHtml(absolutePath)}</span>
${indent}  </div>
${indent}  <div class="node-content collapsed" id="${nodeId}" data-json="${jsonDataStr}">
${indent}    <pre><code class="language-solidity">${escapeHtml(sourceCode)}</code></pre>
${indent}  </div>`;

    if (hasChildren) {
      html += `${indent}  <div class="node-children collapsed" id="${nodeId}-children">`;
      for (const child of item.children) {
        html += processNode(child, depth + 1, functionIndex);
      }
      html += `${indent}  </div>`;
    }

    html += `${indent}</div>`;
    return html;
  }

  // Generate HTML for each function
  functions.forEach((functionItem, index) => {
    allFunctionsHtml += processNode(functionItem, 0, index);

    // Reset node counter for each function to avoid conflicts
    nodeCounter = 0;
  });

  // Generate internal functions section (only for all functions view)
  const internalFunctionsHtml = generateInternalFunctionsSection(collectInternalFunctionsWithCallers(functions));

  // Generate slots viewer and contract elements sidebar
  const slotsViewerHtml = generateSlotsViewer(slots);
  const contractElementsHtml = generateContractElementsSidebar(contractElements);

  const fullHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>All Function Call Trees - ${contractName}</title>
  <!-- External Prism theme removed; styling provided by injected VS Code themed CSS -->
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 20px;
            background-color: #f8f9fa;
        }
        
        .container {
            max-width: 1200px;
            min-width: 920px;
            margin: 0 auto;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            padding: 20px;
        }
        
        h1 {
            color: #2c3e50;
            padding-bottom: 10px;
            margin-bottom: 30px;
        }
    /* Title row to place action buttons inline with contract name */
    .title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      flex-wrap: wrap;
      margin-bottom: 30px;
      border-bottom: 3px solid var(--argus-accent);
    }
    .title-row h1 { margin: 0; }
    .action-buttons.header-actions { 
      margin: 0; 
      justify-content: flex-end; 
    }
        
        .tree-node {
            border-left: 2px solid var(--argus-accent);
            position: relative;
        }
        
        .node-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            background: #f8f9fa;
            border: 1px solid var(--argus-border);
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s;
            margin-top: 5px;
        }
        
        .node-header:hover {
            background: #e9ecef;
            transform: translateX(2px);
        }
        
        .node-header-left {
            display: flex;
            align-items: center;
        }
        
        .node-toggle {
            margin-right: 8px;
            font-size: 12px;
            color: #6c757d;
            user-select: none;
        }
        
        .node-name {
            font-weight: 600;
            color: var(--argus-text);
            font-size: 14px;
        }
        
        .node-path {
            font-size: 11px;
            color: #6c757d;
            font-family: 'Fira Code', 'Cascadia Code', Consolas, Monaco, monospace;
            opacity: 0.7;
            max-width: 300px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        
        .node-content {
            margin-left: 20px;
            margin-top: 5px;
            border: 1px solid var(--argus-border);
            border-radius: 6px;
            overflow: hidden;
        }
        
        .node-content pre {
            margin: 0;
            background: #2d3748;
            color: #e2e8f0;
            font-size: 13px;
            line-height: 1.5;
            overflow-x: auto;
        }
        
        .node-content code {
            display: block;
            padding: 15px;
            font-family: 'Fira Code', 'Cascadia Code', Consolas, Monaco, monospace;
        }
        
        .node-children {
            border-left: 2px solid #3498db;
            margin-left: -2px;
            padding-left: 10px;
        }
        
        .collapsed {
            display: none;
        }
        
        .info-panel {
            background: #e3f2fd;
            border: 1px solid #bbdefb;
            border-radius: 6px;
            padding: 15px;
            margin-bottom: 20px;
        }
        
        .info-panel h3 {
            margin: 0 0 10px 0;
            color: #1976d2;
        }
        
        .call-type {
            font-size: 10px;
            color: #6c757d;
            margin-left: 8px;
            font-weight: normal;
            opacity: 0.8;
        }
        
        .warning-bg {
            background-color: #fff3cd !important;
            border-color: #ffeaa7 !important;
        }
        
        .warning-bg:hover {
            background-color: #ffecb5 !important;
        }
        
        .danger-bg {
            background-color: #f8d7da !important;
            border-color: #f5c6cb !important;
        }
        
        .danger-bg:hover {
            background-color: #f1b0b7 !important;
        }
        
        .stats-panel {
            background: #f8f9fa;
            border: 1px solid var(--argus-border);
            border-radius: 6px;
            padding: 15px;
            margin-bottom: 20px;
            display: flex;
            justify-content: space-around;
            text-align: center;
        }
        /* Legend panel for color and count indicators */
        .legend-panel {
          border: 1px solid var(--argus-border);
          border-radius: 6px;
          padding: 12px 14px;
          margin: 12px 0 20px;
        }
        .legend-title {
          margin: 0 0 8px 0;
          font-size: 12px;
          letter-spacing: .02em;
          color: var(--argus-text);
          opacity: .8;
          text-transform: uppercase;
        }
        .legend-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
        .legend-swatch { width: 16px; height: 12px; border-radius: 3px; border: 1px solid var(--argus-border); display: inline-block; }
        .legend-red { background-color: #f8d7da; border-color: #f5c6cb; }
        .legend-yellow { background-color: #fff3cd; border-color: #ffeaa7; }
        .legend-text { font-size: 12px; color: var(--argus-text); }
        
        .stat-item {
            flex: 1;
        }
        
        .stat-number {
            font-size: 24px;
            font-weight: bold;
            color: var(--argus-accent-alt);
        }

        .stat-label {
            font-size: 12px;
            color: var(--argus-accent);
             text-transform: uppercase;
         }
         
         .external-indicator {
             display: inline-block;
             min-width: 18px;
             height: 18px;
             border-radius: 50%;
             font-size: 10px;
             font-weight: bold;
             text-align: center;
             line-height: 18px;
             margin-left: 6px;
             color: white;
         }
         
        .red-indicator {
             background-color: #dc3545;
        }
         
        .yellow-indicator {
            background-color: #ffc107;            color: #212529;
        }
        
        .view-pure-indicator {
            margin-left: 6px;
            font-size: 12px;
        }
        
        .node-actions {
            display: flex;
            flex-direction: row;
            gap: 4px;
            padding: 10px 15px;
            background: #f8f9fa;
            border-top: 1px solid var(--argus-border);
        }
        
        .export-btn {
            color: white;
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.2s;
            box-shadow: 0 2px 4px rgba(0,123,255,0.3);
        }
        
        .export-btn:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 8px rgba(0,123,255,0.4);
        }
        
        .export-btn:active {
            transform: translateY(0);
            box-shadow: 0 2px 4px rgba(0,123,255,0.3);
        }
        
              
        .contract-elements-sidebar {
            margin-top: 20px;
        }

        
        .contract-elements-sidebar .sidebar-header h3 {
            margin: 0;
            font-size: 18px;
            font-weight: 600;
        }
        
        .sidebar-content {
            background: white;
        }
        
        .element-section {
            overflow: hidden;
        }
        
        .element-toggle {
            margin-right: 10px;
            font-size: 14px;
            color: var(--argus-text);
            transition: transform 0.2s;
            font-weight: bold;
        }
        
        .element-toggle.collapsed {
            display: block;
        }
        
        .element-label {
            flex: 1;
            font-weight: 600;
            font-size: 14px;
            color: var(--argus-text);
        }
        
        .element-count {
            color: white;
            padding: 4px 10px;
            border-radius: 15px;
            font-size: 11px;
            font-weight: 600;
            box-shadow: 0 2px 4px rgba(0,123,255,0.3);
        }
        
        .element-content {
            background: white;
            overflow-y: auto;
            transition: max-height 0.3s ease-out;
        }
        
        .element-content.collapsed {
            max-height: 0;
            overflow: hidden;
        }
        
        .element-item {
            border-bottom: 1px solid #f8f9fa;
            transition: background-color 0.2s;
        }
        
        .element-item:last-child {
            border-bottom: none;
        }
        
        .element-item pre {
            margin: 0;
            background: #2d3748;
            color: #e2e8f0;
            font-size: 12px;
            line-height: 1.4;
            border-radius: 6px;
            overflow-x: auto;
            box-shadow: inset 0 2px 4px rgba(0,0,0,0.1);
        }
        
        .element-item code {
            display: block;
            padding: 10px 12px;
            font-family: 'Fira Code', 'Cascadia Code', Consolas, Monaco, monospace;
        }
        
        .main-container {
            display: flex;
            min-height: 100vh;
        }

        .slots-ruler {
            display: flex;
            align-items: center;
            margin-bottom: 10px;
            padding-bottom: 10px;
            border-bottom: 2px solid var(--argus-border);
        }
        
        .ruler-label {
            width: 90px;
            font-size: 12px;
            font-weight: 600;
            color: var(--argus-text);
            font-family: 'Fira Code', 'Cascadia Code', Consolas, Monaco, monospace;
        }
        
        .ruler-bytes {
            display: flex;
            flex: 1;
            position: relative;
            margin-top: 16px;
        }
        
        .ruler-section {
            display: flex;
            flex: 1;
            justify-content: center;
        }
        .tick-section {
            position: absolute;
            flex: 1;
            display: flex;
            left: -26px;
            right: -26px;
            top: -16px;
        }
        .ruler-byte {
            flex: 1;
            height: 28px;
            background: rgba(102, 126, 234, 0.1);
            /*border-right: 1px solid var(--argus-border);*/
            box-shadow: 0 0 0 0 white, 1px 0 0 0 var(--argus-accent-alt);
            position: relative;
            display: flex;
            align-items: end;
            justify-content: center;
        }
        
        .ruler-tick {
            font-size: 10px;
            font-weight: 600;
            color: var(--argus-text);
            font-family: 'Fira Code', 'Cascadia Code', Consolas, Monaco, monospace;
        }
        
        .slot-row {
            display: flex;
            align-items: center;
            margin-bottom: 5px;
        }
        
        .slot-label {
            width: 90px;
            font-size: 11px;
            font-weight: 600;
            color: var(--argus-text);
            font-family: 'Fira Code', 'Cascadia Code', Consolas, Monaco, monospace;
            cursor: help;
        }
        
        .slot-bytes {
            display: flex;
            flex: 1;
        }
        
        .byte-cell {
            height: 32px;
            box-shadow: 0 0 0 0 white, 1px 0 0 0 var(--argus-border);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 10px;
            font-weight: 600;
            color: white;
            text-align: center;
            cursor: help;
            font-family: 'Fira Code', 'Cascadia Code', Consolas, Monaco, monospace;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        
        .byte-cell.empty {
            background: rgba(102, 126, 234, 0.1);
            flex: 1;
        }
        
        .byte-cell.occupied {
            border-radius: 4px;
            margin: 1px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            transition: all 0.2s;
        }
        
        .byte-cell.occupied:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 8px rgba(0,0,0,0.2);
        }
        
        
        .action-buttons {
            display: flex;
            gap: 12px;
            margin-bottom: 20px;
            justify-content: center;
            flex-wrap: wrap;
        }
        
        .action-btn {
            background: linear-gradient(135deg, #28a745 0%, #20c997 100%);
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            box-shadow: 0 4px 12px rgba(40, 167, 69, 0.3);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .action-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 16px rgba(40, 167, 69, 0.4);
        }
        
        .action-btn:active {
            transform: translateY(0);
            box-shadow: 0 2px 8px rgba(40, 167, 69, 0.3);
        }
        
        .expand-all-btn {
            box-shadow: 0 4px 12px rgba(0, 123, 255, 0.3);
        }
        
        .expand-all-btn:hover {
            box-shadow: 0 6px 16px rgba(0, 123, 255, 0.4);
        }
        
        .export-image-btn {
            background: linear-gradient(135deg, #6f42c1 0%, #563d7c 100%);
            box-shadow: 0 4px 12px rgba(111, 66, 193, 0.3);
        }
        
        .export-image-btn:hover {
            box-shadow: 0 6px 16px rgba(111, 66, 193, 0.4);
        }
        
        /* Internal Functions Section Styles */
        
        .internal-function-item {
            border-bottom: 1px solid #f8f9fa;
            transition: background-color 0.2s;
            margin-bottom: 15px;
        }
        
        .internal-function-item:last-child {
            border-bottom: none;
            margin-bottom: 0;
        }
        
        .internal-function-item:hover {
            background-color: #f8f9fa;
        }
        
        .internal-function-header {
            background: var(--argus-surface-3);
            padding: 8px 12px;
            border-bottom: 1px solid var(--argus-surface-2);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .internal-function-name {
            font-weight: 600;
            font-size: 14px;
            color: var(--argus-text);
        }
        
        .internal-function-path {
            font-size: 11px;
            color: #6c757d;
            opacity: 0.7;
            max-width: 300px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        
        .internal-function-callers {
            background: #e8f4fd;
            padding: 8px 12px;
            border-bottom: 1px solid var(--argus-border);
            font-size: 13px;
            color: var(--argus-text);
        }
        
        .internal-function-callers strong {
            color: var(--argus-accent-alt);
            margin-right: 5px;
        }
        
        .caller-link {
            color: white;
            font-size: 11px;
            text-decoration: none;
            font-weight: 500;
            padding: 2px 6px;
            border-radius: 4px;
            transition: all 0.2s;
        }
        
        .caller-link:hover {
            background-color: var(--argus-accent);
            color: white;
            text-decoration: none;
            transform: translateY(-1px);
            box-shadow: 0 2px 4px rgba(0, 123, 255, 0.3);
        }
        
        .caller-link:active {
            transform: translateY(0);
        }
        
        .internal-function-code {
          border: 1px solid var(--argus-border);
            background: var(--argus-surface-2);
        }
        
        .internal-function-code pre {
            margin: 0;
            background: transparent;
            color: #e2e8f0;
            font-size: 13px;
            line-height: 1.5;
            overflow-x: auto;
        }
        
        .internal-function-code code {
            display: block;
            padding: 12px;
        }
    </style>
</head>
<body>
    <div class="main-container">
        <div class="container">
      <div class="title-row">
        <h1>🧬 ${escapeHtml(contractName)}</h1>
        <div class="action-buttons header-actions">
          <button class="action-btn expand-all-btn" data-action="expand-all" title="Expand all function trees">
            🔍 Expand All
          </button>
          <button class="action-btn export-image-btn" data-action="export-image" title="Export page as image">
            📷 Export as Image
          </button>
        </div>
      </div>
       <div class="stats-panel">
            <div class="stat-item">
                <div class="stat-number">${functions.length}</div>
                <div class="stat-label">Total Functions</div>
            </div>
            <div class="stat-item">
                <div class="stat-number">${functions.reduce((sum, f) => sum + countAllNodes(f), 0)}</div>
                <div class="stat-label">Total Calls</div>
            </div>
            <div class="stat-item">
                <div class="stat-number">${functions.reduce((sum, f) => sum + countExternalCalls(f), 0)}</div>
                <div class="stat-label">External Calls</div>
            </div>
        </div>
        
        <div class="functions-container">
            ${allFunctionsHtml}
        </div>

        <div class="legend-panel" role="note" aria-label="Color legend for nodes and counters">
          <h4 class="legend-title">Legend</h4>
          <div class="legend-row"><span class="legend-swatch legend-red"></span><span class="legend-text">Red header = mutable external/public call</span></div>
          <div class="legend-row"><span class="legend-swatch legend-yellow"></span><span class="legend-text">Yellow header = immutable (view/pure) external call</span></div>
          <div class="legend-row"><span class="external-indicator red-indicator">2</span><span class="legend-text">Red circle = number of mutable external calls under this node (recursive)</span></div>
          <div class="legend-row"><span class="external-indicator yellow-indicator">3</span><span class="legend-text">Yellow circle = number of immutable (view/pure) external calls under this node (recursive)</span></div>
        </div>
        
        ${slotsViewerHtml}
        ${contractElementsHtml}
        ${internalFunctionsHtml}
    </div>
</div>
  <!-- External Prism scripts removed; local inline assets injected in host -->
    <!-- html2canvas CDN removed; local bundle injected elsewhere -->
    <script>
        function toggleNode(nodeId) {
            const node = document.getElementById(nodeId);
            const children = document.getElementById(nodeId + '-children');
            const toggle = node.previousElementSibling.querySelector('.node-toggle');
            
            if (node.classList.contains('collapsed')) {
                // Expanding - show content and children
                node.classList.remove('collapsed');
                if (children) {
                    children.classList.remove('collapsed');
                }
                toggle.textContent = '▼';
            } else {
                // Collapsing - hide content and recursively collapse all children
                node.classList.add('collapsed');
                if (children) {
                    children.classList.add('collapsed');
                    // Recursively collapse all descendant nodes
                    collapseAllChildren(children);
                }
                toggle.textContent = '▶';
            }
        }
        
        function collapseAllChildren(parentElement) {
            // Find all node-content and node-children elements within this parent
            const allContents = parentElement.querySelectorAll('.node-content, .node-children');
            const allToggles = parentElement.querySelectorAll('.node-toggle');
            
            allContents.forEach(element => {
                element.classList.add('collapsed');
            });
            
            allToggles.forEach(toggle => {
                if (toggle.textContent === '▼') {
                    toggle.textContent = '▶';
                }
            });
        }
        
        function toggleElementSection(sectionId) {
            const content = document.getElementById(sectionId);
            const toggle = document.getElementById('toggle-' + sectionId);
            
            if (content.classList.contains('collapsed')) {
                content.classList.remove('collapsed');
                toggle.classList.remove('collapsed');
                toggle.textContent = '▼';
            } else {
                content.classList.add('collapsed');
                toggle.classList.add('collapsed');
                toggle.textContent = '▶';
            }
        }
        
        function exportNodeToJson(nodeId, event) {
            event.stopPropagation(); // Prevent node toggle
            
            // Get the JSON data from the data attribute
            const nodeElement = document.getElementById(nodeId);
            const jsonDataStr = nodeElement.getAttribute('data-json');
            const nodeData = JSON.parse(jsonDataStr);
            
            // Create downloadable JSON
            const jsonStr = JSON.stringify(nodeData, null, 2);
            const blob = new Blob([jsonStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            
            // Extract function name for filename
            const functionName = nodeData.code.split(/[\\s(]/)[0] || 'node';
            
            const a = document.createElement('a');
            a.href = url;
            a.download = \`\${functionName}_tree.json\`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
        
        function copyNodeToPrompt(nodeId, event) {
            event.stopPropagation(); // Prevent node toggle
            
            // Get the JSON data from the data attribute
            const nodeElement = document.getElementById(nodeId);
            const jsonDataStr = nodeElement.getAttribute('data-json');
            const nodeData = JSON.parse(jsonDataStr);
            
            // Flatten the tree to get all function sources
            const flattenedSources = [];
            
            function flattenTree(node) {
                if (node.code && node.code.trim()) {
                    flattenedSources.push(node.code.trim());
                }
                if (node.children && node.children.length > 0) {
                    node.children.forEach(child => flattenTree(child));
                }
            }
            
            flattenTree(nodeData);
            
            // Join all sources with double newlines
            const flattenedText = flattenedSources.join('\\n\\n');
            
            // Copy to clipboard and show a success message
            navigator.clipboard.writeText(flattenedText);
            alert('Flattened sources copied to clipboard');
        }
        
        // Function to expand all nested nodes
        function expandAllNodes() {
            // Find all collapsed node-content and node-children elements
            const allCollapsedContents = document.querySelectorAll('.node-content.collapsed, .node-children.collapsed');
            const allToggles = document.querySelectorAll('.node-toggle');
            
            // Expand all content sections
            allCollapsedContents.forEach(element => {
                element.classList.remove('collapsed');
            });
            
            // Update all toggle indicators to show expanded state
            allToggles.forEach(toggle => {
                if (toggle.textContent === '▶') {
                    toggle.textContent = '▼';
                }
            });
            
            // Show success message
            const button = document.querySelector('.expand-all-btn');
            const originalText = button.innerHTML;
            button.innerHTML = '✅ All Code Expanded';
            button.disabled = true;
            
            setTimeout(() => {
                button.innerHTML = originalText;
                button.disabled = false;
            }, 2000);
        }
        
        // Function to export page as image
    function exportAsImage() {
      if(window.__argusExportInFlight){
        console.warn('[Argus] exportAsImage ignored: already in progress');
        return;
      }
      window.__argusExportInFlight = true;
            const button = document.querySelector('.export-image-btn');
            console.log('[Argus] exportAsImage invoked');
            if(!button){ console.warn('[Argus] exportAsImage: button not found'); return; }
            const originalText = button.innerHTML;
            button.innerHTML = '📸 Capturing...';
            button.disabled = true;

            // Capture the entire document (full scrollable body) rather than just the inner .container
            const element = document.body;
            const docEl = document.documentElement;
            const fullWidth = Math.max(
              element.scrollWidth,
              docEl.scrollWidth,
              element.clientWidth,
              docEl.clientWidth
            );
            const fullHeight = Math.max(
              element.scrollHeight,
              docEl.scrollHeight,
              element.clientHeight,
              docEl.clientHeight
            );
            console.log('[Argus] exportAsImage full page dims', { fullWidth, fullHeight });
            const options = {
                allowTaint: true,
                useCORS: true,
                scale: 2,
                scrollX: 0,
                scrollY: 0,
                width: fullWidth,
                height: fullHeight,
                backgroundColor: '#1e1e1e'
            };
      const w = window;
      // Reuse cached API if present (set by host script); never call acquireVsCodeApi again to avoid duplicate acquisition error.
      const vscodeApi = w.vscode || w.__vscodeApiInternal || undefined;
      if(!w.html2canvas){
                console.warn('[Argus] exportAsImage: html2canvas not yet loaded, retry in 400ms');
                setTimeout(exportAsImage, 400);
                return;
            }
            const start = performance.now();
            w.html2canvas(element, options).then(canvas => {
                const dur = performance.now() - start;
                console.log('[Argus] html2canvas rendered in', dur.toFixed(1)+'ms', 'canvas size', canvas.width+'x'+canvas.height);
                const dataUrl = canvas.toDataURL('image/png');
                console.log('[Argus] exportAsImage captured length', dataUrl.length);
                if(vscodeApi){
                    const name = (document.title.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'callgraph') + '.png';
                    console.log('[Argus] posting exportImage message', { name });
                    vscodeApi.postMessage({ type: 'exportImage', dataUrl, name });
          button.innerHTML = '💾 Saving...';
                } else {
                    console.log('[Argus] vscodeApi unavailable, performing fallback download');
                    const link = document.createElement('a');
                    link.download = 'callgraph.png';
                    link.href = dataUrl;
                    document.body.appendChild(link); link.click(); document.body.removeChild(link);
                    button.innerHTML = '✅ Image Exported';
          setTimeout(() => { button.innerHTML = originalText; button.disabled = false; window.__argusExportInFlight = false; }, 2000);
                }
            }).catch(err => {
                console.error('[Argus] Error capturing image:', err);
                button.innerHTML = '❌ Export Failed';
                setTimeout(() => {
          button.innerHTML = originalText;
          button.disabled = false;
          window.__argusExportInFlight = false;
                }, 2000);
            });
        }
        
        // Initialize all nodes as collapsed
        document.addEventListener('DOMContentLoaded', function() {
            Prism.highlightAll();
        });
    </script>
</body>
</html>`;

  return fullHtml;
}

// Helper function to count all nodes in a tree
function countAllNodes(item: RecordItem): number {
  let count = 1; // Count the current node
  for (const child of item.children) {
    count += countAllNodes(child);
  }
  return count;
}

// Helper function to count external calls
function countExternalCalls(item: RecordItem): number {
  let count = 0;
  if (item.callType === CallType.HighLevel || item.callType === CallType.LowLevel) {
    count = 1;
  }
  for (const child of item.children) {
    count += countExternalCalls(child);
  }
  return count;
}

// Helper function to count red external calls (high/low level non-pure/view)
function countRedExternalCalls(item: RecordItem): number {
  let count = 0;
  if (item.callType === CallType.HighLevel || item.callType === CallType.LowLevel) {
    if (item.ast instanceof $.FunctionDefinition) {
      const isPureOrView =
        item.ast.stateMutability === $.FunctionStateMutability.Pure ||
        item.ast.stateMutability === $.FunctionStateMutability.View;
      if (!isPureOrView) {
        count = 1;
      }
    } else {
      count = 1; // Default for non-function definitions
    }
  }
  for (const child of item.children) {
    count += countRedExternalCalls(child);
  }
  return count;
}

// Helper function to count yellow external calls (high/low level pure/view)
function countYellowExternalCalls(item: RecordItem): number {
  let count = 0;
  if (item.callType === CallType.HighLevel || item.callType === CallType.LowLevel) {
    if (item.ast instanceof $.FunctionDefinition) {
      const isPureOrView =
        item.ast.stateMutability === $.FunctionStateMutability.Pure ||
        item.ast.stateMutability === $.FunctionStateMutability.View;
      if (isPureOrView) {
        count = 1;
      }
    }
  }
  for (const child of item.children) {
    count += countYellowExternalCalls(child);
  }
  return count;
}

// Function to save HTML diagrams for all functions
export function saveHTMLDiagrams(
  functions: RecordItem[],
  outDir: string = 'html_diagrams',
  contractName: string,
  contractElements?: ContractElements,
  slots?: { slots: Record<string, Member[]>; constants: Constant[] }
) {
  // Create output directory
  const outputDir = path.join(process.cwd(), outDir, contractName);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const generatedFiles: string[] = [];

  // Save individual function files
  functions.forEach((functionItem, index) => {
    const functionName =
      functionItem.ast instanceof $.FunctionDefinition
        ? getFunctionName(functionItem.ast)
        : `function_${index}`;

    const htmlContent = generateCombinedHTMLTree(
      [functionItem],
      contractName,
      contractElements,
      false,
      slots
    );

    // Save to file
    const filename = `${functionName}.html`;
    const filepath = path.join(outputDir, filename);

    fs.writeFileSync(filepath, htmlContent, 'utf8');
    generatedFiles.push(`${contractName}/${filename}`);
  });

  // Save combined file with all functions
  const combinedHtmlContent = generateCombinedHTMLTree(
    functions,
    contractName,
    contractElements,
    true,
    slots
  );
  const combinedFilepath = path.join(outputDir, `${contractName}_all_functions.html`);
  fs.writeFileSync(combinedFilepath, combinedHtmlContent, 'utf8');
  generatedFiles.push(`${contractName}/${contractName}_all_functions.html`);

  return generatedFiles;
}

// Interface for contract information
export interface ContractInfo {
  name: string;
  functions: {
    name: string;
    filename: string;
    stateMutability?: string;
  }[];
  hasAllFunctionsFile: boolean;
}

// Function to generate the main index.html navigation file
export function generateNavigationIndex(contracts: ContractInfo[]): string {
  const indexHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Argus - Contract Analysis Dashboard</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            height: 100vh;
            overflow: hidden;
            background: #f8f9fa;
        }
        
        .dashboard {
            display: flex;
            height: 100vh;
        }
        
        .sidebar {
            width: 350px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            display: flex;
            flex-direction: column;
            box-shadow: 2px 0 10px rgba(0,0,0,0.1);
        }
        
        .sidebar-header {
            padding: 20px;
            background: rgba(0,0,0,0.1);
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        
        .sidebar-header h1 {
            font-size: 24px;
            font-weight: 700;
            margin-bottom: 5px;
        }
        
        .sidebar-header p {
            opacity: 0.8;
            font-size: 14px;
        }
        
        .search-container {
            padding: 15px 20px;
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        
        .search-input {
            width: 100%;
            padding: 10px 15px;
            border: none;
            border-radius: 20px;
            background: rgba(255,255,255,0.15);
            color: white;
            font-size: 14px;
            outline: none;
            transition: all 0.3s;
        }
        
        .search-input::placeholder {
            color: rgba(255,255,255,0.7);
        }
        
        .search-input:focus {
            background: rgba(255,255,255,0.25);
            transform: scale(1.02);
        }
        
        .contracts-list {
            flex: 1;
            overflow-y: auto;
            padding: 10px 0;
        }
        
        .contract-group {
            margin-bottom: 5px;
        }
        
        .contract-header {
            display: flex;
            align-items: center;
            padding: 12px 20px;
            cursor: pointer;
            transition: all 0.2s;
            user-select: none;
        }
        
        .contract-header:hover {
            background: rgba(255,255,255,0.1);
        }
        
        .contract-toggle {
            margin-right: 10px;
            font-size: 12px;
            transition: transform 0.2s;
        }
        
        .contract-toggle.expanded {
            transform: rotate(90deg);
        }
        
        .contract-name {
            font-weight: 600;
            font-size: 13px;
        }
        
        .contract-stats {
            margin-left: auto;
            font-size: 11px;
            opacity: 0.7;
        }
        
        .functions-list {
            background: rgba(0,0,0,0.1);
            max-height: 0;
            overflow: hidden;
            transition: max-height 0.3s ease-out;
        }
        
        .functions-list.expanded {
            max-height: 10000px;
        }
        
        .function-item, .all-functions-item {
            padding: 8px 50px;
            cursor: pointer;
            transition: all 0.2s;
            font-size: 14px;
            border-left: 3px solid transparent;
        }
        
        .function-item:hover, .all-functions-item:hover {
            background: rgba(255,255,255,0.15);
            border-left-color: #ffc107;
            transform: translateX(2px);
        }
        
        .all-functions-item {
            font-weight: 600;
            background: rgba(255,255,255,0.05);
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        
        .all-functions-item:hover {
            background: rgba(255,255,255,0.2);
        }
        
        .content {
            flex: 1;
            display: flex;
            flex-direction: column;
        }
        
        .content-header {
            background: white;
            padding: 15px 20px;
            border-bottom: 1px solid var(--argus-border);
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        
        .content-title {
            font-size: 18px;
            color: var(--argus-text);
            margin: 0;
        }
        
        .content-frame {
            flex: 1;
            border: none;
            background: white;
        }
        
        .welcome-screen {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            text-align: center;
            padding: 40px;
        }
        
        .welcome-content {
            max-width: 500px;
        }
        
        .welcome-content h2 {
            font-size: 32px;
            color: #2c3e50;
            margin-bottom: 15px;
        }
        
        .welcome-content p {
            font-size: 16px;
            color: #6c757d;
            line-height: 1.6;
            margin-bottom: 20px;
        }
        
        .feature-list {
            list-style: none;
            text-align: left;
        }
        
        .feature-list li {
            padding: 8px 0;
            color: var(--argus-text);
        }
        
        .feature-list li::before {
            content: "✨";
            margin-right: 10px;
        }
        
        .hidden {
            display: none;
        }
        
        /* Scrollbar styling */
        .contracts-list::-webkit-scrollbar {
            width: 6px;
        }
        
        .contracts-list::-webkit-scrollbar-track {
            background: rgba(255,255,255,0.1);
        }
        
        .contracts-list::-webkit-scrollbar-thumb {
            background: rgba(255,255,255,0.3);
            border-radius: 3px;
        }
        
        .contracts-list::-webkit-scrollbar-thumb:hover {
            background: rgba(255,255,255,0.5);
        }
    </style>
</head>
<body>
    <div class="dashboard">
        <div class="sidebar">
            <div class="sidebar-header">
                <h1>🛡️ Argus</h1>
                <p>Smart Contract Analysis Dashboard</p>
            </div>
            
            <div class="search-container">
                <input 
                    type="text" 
                    class="search-input" 
                    placeholder="Search contracts and functions..."
                    id="searchInput"
                >
            </div>
            
            <div class="contracts-list" id="contractsList">
                ${contracts
      .map(
        (contract) => `
                <div class="contract-group" data-contract="${contract.name}">
                    <div class="contract-header" data-action="toggle-contract" data-contract="${contract.name}">
                        <span class="contract-toggle" id="toggle-${contract.name}">▶</span>
                        <span class="contract-name">${escapeHtml(contract.name)}</span>
                        <span class="contract-stats">${contract.functions.length} functions</span>
                    </div>
                    <div class="functions-list" id="functions-${contract.name}">
                        ${contract.hasAllFunctionsFile
            ? `
            <div class="all-functions-item" data-action="load-content" data-path="${contract.name}/${contract.name}_all_functions.html" data-title="All Functions - ${contract.name}">
                            � All Functions
                        </div>
                        `
            : ''
          }
                        ${contract.functions
            .map(
              (func) => `
                        <div class="function-item" data-action="load-content" data-path="${contract.name}/${func.filename}" data-title="${func.name} - ${contract.name}">
                            ${func.stateMutability === 'pure' || func.stateMutability === 'view' ? `👁️` : `🔧`} ${escapeHtml(func.name)}
                        </div>
                        `
            )
            .join('')}
                    </div>
                </div>
                `
      )
      .join('')}
            </div>
        </div>
        
        <div class="content">
            <div class="content-header">
                <h2 class="content-title" id="contentTitle">Welcome to Argus</h2>
            </div>
            
            <div class="welcome-screen" id="welcomeScreen">
                <div class="welcome-content">
                    <h2>🚀 Ready to Analyze</h2>
                    <p>Select a contract from the sidebar to start exploring function call trees and security analysis.</p>
                    <ul class="feature-list">
                        <li>Interactive function call trees</li>
                        <li>External call analysis</li>
                        <li>Security risk indicators</li>
                        <li>Source code visualization</li>
                    </ul>
                </div>
            </div>
            
            <div class="content-frame hidden" id="contentFrame"></div>
        </div>
    </div>

    <script>
        let expandedContracts = new Set();
        
        function toggleContract(contractName) {
            const toggle = document.getElementById(\`toggle-\${contractName}\`);
            const functionsList = document.getElementById(\`functions-\${contractName}\`);
            
            if (expandedContracts.has(contractName)) {
                // Collapse
                expandedContracts.delete(contractName);
                toggle.classList.remove('expanded');
                functionsList.classList.remove('expanded');
            } else {
                // Expand
                expandedContracts.add(contractName);
                toggle.classList.add('expanded');
                functionsList.classList.add('expanded');
            }
        }
        
        function loadContent(filePath, title) {
            const welcomeScreen = document.getElementById('welcomeScreen');
            const contentFrame = document.getElementById('contentFrame');
            const contentTitle = document.getElementById('contentTitle');
            
            // Hide welcome screen and show iframe
            welcomeScreen.classList.add('hidden');
            contentFrame.classList.remove('hidden');
            
            // Update title and load content
            contentTitle.textContent = title;
            contentFrame.src = filePath;
        }
        
        // Search functionality
        document.getElementById('searchInput').addEventListener('input', function(e) {
            const searchTerm = e.target.value.toLowerCase();
            const contractGroups = document.querySelectorAll('.contract-group');
            
            contractGroups.forEach(group => {
                const contractName = group.dataset.contract.toLowerCase();
                const functionItems = group.querySelectorAll('.function-item');
                let hasVisibleFunctions = false;
                
                // Check contract name match
                const contractMatches = contractName.includes(searchTerm);
                
                // Check function name matches
                functionItems.forEach(item => {
                    const functionName = item.textContent.toLowerCase();
                    const matches = functionName.includes(searchTerm) || contractMatches;
                    
                    if (matches) {
                        item.style.display = 'block';
                        hasVisibleFunctions = true;
                    } else {
                        item.style.display = 'none';
                    }
                });
                
                // Show/hide entire contract group
                if (hasVisibleFunctions || contractMatches) {
                    group.style.display = 'block';
                    
                    // Auto-expand if searching
                    if (searchTerm && !expandedContracts.has(group.dataset.contract)) {
                        toggleContract(group.dataset.contract);
                    }
                } else {
                    group.style.display = 'none';
                }
            });
        });
        
        // Initialize with first contract expanded if available
        document.addEventListener('DOMContentLoaded', function() {
            const firstContract = document.querySelector('.contract-group');
            if (firstContract) {
                const contractName = firstContract.dataset.contract;
                toggleContract(contractName);
            }
        });
    </script>
</body>
</html>`;

  return indexHtml;
}

// Function to save the navigation index
export function saveNavigationIndex(contracts: ContractInfo[], outDir: string = 'html_diagrams') {
  const indexContent = generateNavigationIndex(contracts);
  const indexPath = path.join(process.cwd(), outDir, 'index.html');

  fs.writeFileSync(indexPath, indexContent, 'utf8');
}

export const signatureEquals = (a: $.FunctionDefinition, b: $.FunctionDefinition) => {
  if (!a.name || !b.name) { return false; }
  if (a.name !== b.name) { return false; }
  if (
    a.vParameters.vParameters.map((x) => x.type).join(',') !==
    b.vParameters.vParameters.map((x) => x.type).join(',')
  ) { return false; }
  if (a.visibility !== b.visibility) { return false; }
  return a.stateMutability === b.stateMutability;
};
