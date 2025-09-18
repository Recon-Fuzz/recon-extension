/**
 * Types for the foundry compiler output format
 */
import * as $ from 'solc-typed-ast';

export enum CallType {
  Internal = 'internal',
  HighLevel = 'high-level',
  LowLevel = 'low-level',
}

export interface ContractElements {
  vEvents?: $.ASTNode[];
  vStructs?: $.ASTNode[];
  vErrors?: $.ASTNode[];
  vEnums?: $.ASTNode[];
  vUserDefinedValueTypes?: $.ASTNode[];
}

export type ElementKey = keyof ContractElements;

export type Member = {
  parent: any;
  size: number;
  name: string;
  type: string;
  source: string;
  visibility: string;
  constant: boolean;
  mutability: string;
  absolutePath: string;
  offset?: number;
  children?: Member[];
};

export type Constant = {
  name: string;
  type: string;
  source: string;
  visibility: string;
  mutability: string;
  constant: boolean;
  absolutePath: string;
};

export interface FoundryCompilerOutput {
  id: string;
  source_id_to_path: Record<string, string>;
  language: string;
  _format: string;
  input: {
    sources: {
      [path: string]: { content: string };
    };
  };
  output: {
    contracts: {
      [path: string]: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        [contractName: string]: { abi: Record<string, any> };
      };
    };
    sources: {
      [path: string]: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        [contractName: string]: { id: number; ast: Record<string, any> };
      };
    };
  };
  solcLongVersion: string;
  solcVersion: string;
}

export interface CryticSolcCompilerOutput {
  sources: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [path: string]: { AST: Record<string, any> };
  };
  contracts: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [path: string]: { abi: Record<string, any> };
  };
  sourceList: string[];
}

export type RecordItem = {
  ast: $.ASTNode;
  children: RecordItem[];
  callType?: CallType;
};
