export interface FuzzerArgs {
    config?: string;
    contract?: string;
    forkMode?: string;
    forkBlock?: string;
    forkReplacement: boolean;
    rpcUrl?: string;
    testMode?: string;
    corpusDir?: string;
    testLimit?: string;
    preprocess?: string;
    pathToTester?: string;
    targetCorpus?: string;
    timeout?: string;
}

export enum JobType {
    MEDUSA = 'medusa',
    ECHIDNA = 'echidna',
    FOUNDRY = 'foundry',
    HALMOS = 'halmos',
    KONTROL = 'kontrol'
}

export enum ForkMode {
    NONE = 'NONE',
    CUSTOM = 'CUSTOM',
    MAINNET = 'MAINNET',
    OPTIMISM = 'OPTIMISM',
    ARBITRUM = 'ARBITRUM',
    POLYGON = 'POLYGON',
    BASE = 'BASE'
}

export enum EchidnaTestMode {
    CONFIG = 'config',
    EXPLORATION = 'exploration',
    OPTIMIZATION = 'optimization',
    ASSERTION = 'assertion',
    PROPERTY = 'property'
}

export interface NewJobRequest {
    jobType: JobType;
    orgName: string;
    repoName: string;
    ref: string;
    directory?: string;
    preprocess?: string;
    label?: string;
    config?: string;
    contract?: string;
    forkMode?: string;
    forkBlock?: string;
    forkReplacement: boolean;
    rpcUrl?: string;
    testMode?: string;
    corpusDir?: string;
    testLimit?: string;
    mode: string;
    pathToTester?: string;
    targetCorpus?: string;
    timeout?: string;
    
    runs?: string;
    seed?: string;
    testCommand?: string;
    testTarget?: string;
    verbosity?: string;

    halmosArray?: string;
    halmosLoops?: string;
    halmosPrefix?: string;

    kontrolTest?: string;
}

export interface JobMetadata {
    commit: string;
    method: string;
    startedBy: string;
}

export interface BrokenProperty {
    id: string;
    brokenProperty: string;
    traces: string;
    jobId: string;
    createdAt: string;
}

export interface Job {
    id: string;
    orgName: string;
    repoName: string;
    ref: string;
    fuzzer: string;
    directory: string;
    preprocess: string | null;
    duration: string | null;
    arbitraryCommand: string | null;
    fuzzerArgs: FuzzerArgs;
    taskArn: string;
    corpusUrl: string | null;
    coverageUrl: string | null;
    logsUrl: string | null;
    status: string;
    organizationId: string;
    experimentId: string | null;
    createdAt: string;
    updatedAt: string;
    recurringJobId: string | null;
    pullRequestID: string | null;
    label: string;
    metadata: JobMetadata;
    testsDuration: string | null;
    testsCoverage: number | null;
    testsFailed: number | null;
    testsPassed: number | null;
    numberOfTests: number | null;
    recipeId: string | null;
    brokenProperties: BrokenProperty[];
    recipe: any | null;
}

export interface JobsResponse {
    message: string;
    data: Job[];
}

export interface Share {
    id: string;
    organizationId: string;
    jobId: string;
    job: Job;
}

export interface SharesResponse {
    message: string;
    data: Share[];
}
