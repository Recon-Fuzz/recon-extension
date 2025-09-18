import * as $ from 'solc-typed-ast';
import { CallType, CryticSolcCompilerOutput, FoundryCompilerOutput, RecordItem } from './types';
import {
  ContractInfo,
  getCallType,
  getDefinitions,
  getFunctionName,
  ignoreList,
  saveHTMLDiagrams,
  saveNavigationIndex,
  signatureEquals,
} from './utils';
import { processSlots } from './slot';

export function processCompilerOutput(
  compilerOutput: FoundryCompilerOutput | CryticSolcCompilerOutput,
  outDir: string = 'html_diagrams',
  _spinner: undefined | unknown = undefined,
  includeAll: boolean = false,
  includeDeps: boolean = false
) {
  const sourceUnits = 'output' in compilerOutput ? compilerOutput.output : compilerOutput;
  const asts: $.SourceUnit[] = new $.ASTReader().read(sourceUnits);
  // spinner removed for extension refactor

  // Collect contract information for the index
  const contractsInfo: ContractInfo[] = [];
  let processedContracts = 0;
  let totalContracts = 0;
  const successfulContracts: string[] = [];
  const failedContracts: { name: string; error: string }[] = [];
  const skippedContracts: string[] = [];

  // Count total contracts to process
  for (const ast of asts) {
    if (ignoreList.some((ignore) => ast.absolutePath.startsWith(ignore))) {
      continue;
    }
    for (const contract of ast.getChildrenByType($.ContractDefinition)) {
      if (!contract.fullyImplemented || contract.abstract || contract.kind !== 'contract') {
        continue;
      }
      totalContracts++;
    }
  }

  for (const ast of asts) {
    if (ignoreList.some((ignore) => ast.absolutePath.startsWith(ignore))) {
      continue;
    }
    for (const contract of ast.getChildrenByType($.ContractDefinition)) {
      if (!contract.fullyImplemented || contract.abstract || contract.kind !== 'contract') {
        continue;
      }

      processedContracts++;
      // Progress logging removed for extension context

      try {
        const result = processContract(contract, includeAll, includeDeps);

        // Only process contracts that have functions
        if (result.vFunctions.length > 0) {
          const slots = processSlots(contract);

          saveHTMLDiagrams(result.vFunctions, outDir, contract.name, result, slots);

          // Collect contract info for index
          const contractInfo: ContractInfo = {
            name: contract.name,
            functions: result.vFunctions.map((func: RecordItem) => {
              const functionName =
                func.ast instanceof $.FunctionDefinition ? getFunctionName(func.ast) : 'unknown';
              const stateMutability =
                func.ast instanceof $.FunctionDefinition ? func.ast.stateMutability : undefined;
              return {
                name: functionName,
                filename: `${functionName}.html`,
                stateMutability: stateMutability,
              };
            }),
            hasAllFunctionsFile: true,
          };
          contractsInfo.push(contractInfo);
          successfulContracts.push(contract.name);
        } else {
          // Contract has no public/external non-view/non-pure functions
          skippedContracts.push(contract.name);
          // Skipped logging removed
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        failedContracts.push({ name: contract.name, error: errorMessage });
      }
    }
  }

  // Generate navigation index
  if (contractsInfo.length > 0) {
    saveNavigationIndex(contractsInfo, outDir);
  }

  // Return summary for the main function to display
  return {
    successful: successfulContracts,
    failed: failedContracts,
    skipped: skippedContracts,
  };
}

export const processFunction = (
  fnDef: $.FunctionDefinition | $.ModifierDefinition,
  includeDeps: boolean = false
): RecordItem[] => {
  const result: RecordItem[] = [];
  fnDef.walk((n) => {
    if (
      'vReferencedDeclaration' in n &&
      n.vReferencedDeclaration &&
      n.vReferencedDeclaration !== fnDef
    ) {
      if (
        n.vReferencedDeclaration instanceof $.FunctionDefinition ||
        n.vReferencedDeclaration instanceof $.ModifierDefinition
      ) {
        const refSourceUnit = n.vReferencedDeclaration.getClosestParentByType($.SourceUnit);
        if (result.some((x) => x.ast === n.vReferencedDeclaration)) {
          return;
        }
        result.push({
          ast: n.vReferencedDeclaration,
          children:
            !includeDeps &&
            ignoreList.some((ignore) => refSourceUnit!.absolutePath.startsWith(ignore))
              ? []
              : processFunction(n.vReferencedDeclaration, includeDeps),
          callType: n instanceof $.FunctionCall ? getCallType(n) : CallType.Internal,
        });
      }
    }
  });
  return result;
};

export const processContract = (
  contract: $.ContractDefinition,
  includeAll: boolean,
  includeDeps: boolean = false
) => {
  const items = [
    'vStateVariables',
    'vEvents',
    'vStructs',
    'vErrors',
    'vEnums',
    'vUserDefinedValueTypes',
  ];
  const result: Record<string, any> = {};
  for (const item of items) {
    if (item in contract) {
      result[item] = getDefinitions(contract, item, false).reverse();
    }
  }
  result['vFunctions'] = [];
  const allFunctions = getDefinitions(
    contract,
    'vFunctions',
    true
  ).reverse() as $.FunctionDefinition[];

  for (const fnDef of allFunctions.filter((x) => x.implemented)) {
    if (
      fnDef.visibility !== $.FunctionVisibility.External &&
      fnDef.visibility !== $.FunctionVisibility.Public
    ) {
      continue;
    }
    if (
      !includeAll &&
      (fnDef.stateMutability === $.FunctionStateMutability.Pure ||
        fnDef.stateMutability === $.FunctionStateMutability.View)
    ) {
      continue;
    }
    if (!result['vFunctions'].some((x: $.FunctionDefinition) => signatureEquals(x, fnDef))) {
      const rec: RecordItem = {
        ast: fnDef,
        children: processFunction(fnDef, includeDeps),
      };
      result['vFunctions'].push(rec);
    }
  }
  return result;
};
