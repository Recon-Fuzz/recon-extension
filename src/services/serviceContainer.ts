import { OutputService } from './outputService';
import { StatusBarService } from './statusBarService';
import { ReconMainViewProvider } from '../reconMainView';
import { ReconContractsViewProvider } from '../reconContractsView';
import { CoverageViewProvider } from '../coverageView';
import { ContractWatcherService } from './contractWatcherService';
import { WorkspaceService } from './workspaceService';

export interface ServiceContainer {
    outputService: OutputService;
    statusBarService: StatusBarService;
    reconMainProvider: ReconMainViewProvider;
    reconContractsProvider: ReconContractsViewProvider;
    coverageViewProvider: CoverageViewProvider;
    contractWatcherService: ContractWatcherService;
    workspaceService?: WorkspaceService;
}
