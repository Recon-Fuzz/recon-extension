// @ts-nocheck

import { Command } from 'commander';
import path from 'path';
import * as fs from 'fs';
import { readCompilerOutput } from './utils';
import { processCompilerOutput } from './processor';

/**
 * Find the latest build-info JSON file in the out/build-info directory
 * @returns Path to the latest build-info JSON file, or null if none found
 */
async function findLatestBuildInfoFile(): Promise<string | null> {
  const buildInfoDir = path.resolve('out/build-info');

  try {
    if (!fs.existsSync(buildInfoDir)) return null;
    const files = await fs.promises.readdir(buildInfoDir);
    const jsonFiles = files.filter((file: string) => file.endsWith('.json'));

    if (jsonFiles.length === 0) {
      return null;
    }

    // Get file stats to find the most recently modified file
    const fileStats = await Promise.all(
      jsonFiles.map(async (file: string) => {
        const filePath = path.join(buildInfoDir, file);
        const stats = await fs.promises.stat(filePath);
        return { file: filePath, mtime: stats.mtime };
      })
    );

    // Sort by modification time (newest first)
  fileStats.sort((a: any, b: any) => b.mtime.getTime() - a.mtime.getTime());

    // Return the newest file
    return fileStats[0].file;
  } catch (error) {
    console.error('Error checking build-info directory:', error);
    return null;
  }
}

// Set up the CLI program
const program = new Command();

program
  .name('argus')
  .description(
    'CLI tool to process Solidity compiler output and generate Function Call Graphs (use --all to include view functions)'
  )
  .version('1.0.0');

program
  .argument('[input]', 'Path to the compiler output JSON file (optional if build-info JSON exists)')
  .option('-o, --output <directory>', 'Output directory for html diagrams', 'html_diagrams')
  .option('--all', 'Include view and pure functions in addition to state-changing functions')
  .option('--libs', 'Include external libraries and dependencies')
  .action(
    async (input: string | undefined, options: { output: string; all: boolean; libs: boolean }) => {
      try {
  console.log('Argus - Solidity Function Call Graph Generator');

        if (options.all) console.log('Including view and pure functions (--all)');
        if (options.libs) console.log('Including external libraries and dependencies (--libs)');

  let inputPath: string;

        // If input is not provided, try to find the latest build-info JSON file
        if (!input) {
          const cryticJsonPath = path.resolve('crytic-export/combined_solc.json');
          // if the file exists, use it as input
          const cryticJsonExists = fs.existsSync(cryticJsonPath);
          if (cryticJsonExists) {
            inputPath = cryticJsonPath;
            console.log(`Using: ${inputPath}`);
          } else {
            const latestBuildInfo = await findLatestBuildInfoFile();
            if (latestBuildInfo) {
              inputPath = latestBuildInfo;
              console.log(`Using: ${path.basename(inputPath)}`);
            } else {
              console.error('Error: No input provided and no build-info JSON file found.');
              process.exit(1);
            }
          }
        } else {
          // Use the provided input
          inputPath = path.resolve(input);
          const inputExists = fs.existsSync(inputPath);
          if (!inputExists) {
            console.error(`Error: Input file not found: ${inputPath}`);
            process.exit(1);
          }
          console.log(`Using: ${inputPath}`);
        }

        // Read and parse the compiler output
        try {
          const compilerOutput = await readCompilerOutput(inputPath);
          // Process the compiler output
          const summary = processCompilerOutput(
            compilerOutput,
            options.output,
            undefined,
            options.all,
            options.libs
          );
          console.log('Processing Complete!');
          console.log(`Output directory: ${options.output}`);

          if (summary.successful.length > 0) {
            console.log(`Processed (${summary.successful.length}):`);
            summary.successful.forEach((name) => console.log(`  - ${name}`));
          }

          if (summary.failed.length > 0) {
            console.log(`Errors (${summary.failed.length}):`);
            summary.failed.forEach(({ name, error }) => console.log(`  - ${name}: ${error}`));
          }

          if (summary.successful.length === 0 && summary.failed.length === 0) {
            console.log('No contracts found to process.');
          } else if (summary.successful.length > 0) {
            console.log(`Open ${path.join(options.output, 'index.html')} to view diagrams.`);
          }
        } catch (error) {
          throw error;
        }
      } catch (error) {
        console.error('Error:', (error as Error).message);
        process.exit(1);
      }
    }
  );

// Parse command line arguments
program.parse();
