import * as vscode from 'vscode';

export enum Actor {
    ACTOR = 'actor',
    ADMIN = 'admin'
}

export enum Mode {
    NORMAL = 'normal',
    FAIL = 'fail',
    CATCH = 'catch'
}

export enum FuzzerTool {
    ECHIDNA = 'Echidna',
    MEDUSA = 'Medusa',
    HALMOS = 'Halmos'
}

export interface CoverageFile {
    path: string;
    type: FuzzerTool;
    timestamp: Date;
}


export interface FileBlock {
    path: string;
    content: string;
}

export enum EchidnaMode {
    PROPERTY = 'property',
    ASSERTION = 'assertion',
    OPTIMIZATION = 'optimization',
    OVERFLOW = 'overflow',
    EXPLORATION = 'exploration'
}

export type ParamDefinition = {
    name: string;
    type: string;
    internalType: string;
    components?: ParamDefinition[];
};

export type Abi = {
    type: string;
    name?: string;
    inputs: ParamDefinition[];
    outputs: ParamDefinition[];
    stateMutability?: string;
};

export type ContractMetadata = {
    name: string;
    jsonPath: string;
    path: string;
    abi: Abi[];
    enabled: boolean;
    functionConfigs?: FunctionConfig[];
    enabledFunctions?: string[];
    separated?: boolean;
};

export type FunctionConfig = {
    signature: string;
    actor: Actor;
    mode: Mode;
};

export interface TestFunction {
    name: string;
    range: vscode.Range;
    isPublicOrExternal: boolean;
}

export interface FunctionDefinitionParams {
    contractName: string;
    contractPath: string;
    jsonPath?: string; 
    functionName: string;
    abi: Abi;
    actor: Actor;
    mode: Mode;
    separated?: boolean;
}

export interface TargetFunction extends TestFunction {
    fullName: string;
    contractName: string;
    fnParams: FunctionDefinitionParams;
}

export interface ReproStep {
    function: string;
    args?: any[];
}

export interface EchidnaCorpusItem {
    name: string;
    steps: ReproStep[];
}

export interface JobSummary {
    fuzzer: string;
    project: string;
    startTime: string;
    endTime?: string;
    duration: number;
    contracts: string[];
    passed: number;
    failed: number;
    corpus: number;
    calls: number;
}

export interface BrokenProperty {
    brokenProperty: string;
    sequence: string;
}

export interface FuzzerResults {
    jobSummary: JobSummary;
    brokenProperties: BrokenProperty[];
    passed: number;
    failed: number;
}

export interface ProcessOptions {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    shell?: boolean;
    detached?: boolean;
}

export interface ProcessResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}
