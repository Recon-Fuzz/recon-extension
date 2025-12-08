import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { processLogs, generateJobMD, Fuzzer } from "@recon-fuzz/log-parser";
import {
  getFoundryConfigPath,
  getTestFolder,
  prepareTrace,
  stripAnsiCodes,
  getUid,
  getEnvironmentPath,
} from "../utils";
import { ServiceContainer } from "../services/serviceContainer";
import { ProcessManager } from "../services/processManager";

export function registerFuzzingCommands(
  context: vscode.ExtensionContext,
  services: ServiceContainer
): void {
  // Register Echidna command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "recon.runEchidna",
      async (target?: string) => {
        await runFuzzer(Fuzzer.ECHIDNA, services, target);
      }
    )
  );

  // Register Medusa command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "recon.runMedusa",
      async (target?: string) => {
        await runFuzzer(Fuzzer.MEDUSA, services, target);
      }
    )
  );

  // Register Halmos command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "recon.runHalmos",
      async (target?: string) => {
        await runFuzzer(Fuzzer.HALMOS, services, target);
      }
    )
  );
}

async function runFuzzer(
  fuzzerType: Fuzzer,
  services: ServiceContainer,
  target: string = "CryticTester"
): Promise<void> {
  if (!vscode.workspace.workspaceFolders) {
    vscode.window.showErrorMessage("Please open a workspace first");
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const foundryConfigPath = getFoundryConfigPath(workspaceRoot);
  const foundryRoot = path.dirname(foundryConfigPath);

  let command: string;

  if (fuzzerType === Fuzzer.ECHIDNA) {
    const config = vscode.workspace.getConfiguration("recon.echidna");
    const workers = config.get<number>("workers", 8);
    const testLimit = config.get<number>("testLimit", 1000000);
    const mode = config.get<string>("mode", "assertion");

    command = `echidna . --contract ${
      target || "CryticTester"
    } --config echidna.yaml --format text --workers ${
      workers || 10
    } --test-limit ${testLimit} --test-mode ${mode}`;
  } else if (fuzzerType === Fuzzer.MEDUSA) {
    const config = vscode.workspace.getConfiguration("recon.medusa");
    const workers = config.get<number>("workers", 10);
    const testLimit = config.get<number>("testLimit", 0);

    command = `medusa fuzz --workers ${
      workers || 10
    } --test-limit ${testLimit}`;
    if (target !== "CryticTester") {
      command += ` --target-contracts ${target || "CryticTester"}`;
    }
  } else {
    const config = vscode.workspace.getConfiguration("recon.halmos");
    const loop = config.get<number>("loop", 256);

    command = `halmos --match-contract ${
      target || "CryticTester"
    } -vv --solver-timeout-assertion 0 --loop ${loop} `;
  }

  // Create output channel for live feedback
  const outputChannel = services.outputService.createFuzzerOutputChannel(
    fuzzerType === Fuzzer.ECHIDNA
      ? "Echidna"
      : fuzzerType === Fuzzer.MEDUSA
      ? "Medusa"
      : "Halmos"
  );
  outputChannel.show();

  let output = "";
  let processCompleted = false;
  let childProcess: any = null;
  let hasEnoughData = false;
  const processManager = ProcessManager.getInstance();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title:
        fuzzerType === Fuzzer.ECHIDNA
          ? "Echidna"
          : fuzzerType === Fuzzer.MEDUSA
          ? "Medusa"
          : "Halmos",
      cancellable: true,
    },
    async (progress, token) => {
      return new Promise<void>((resolve, reject) => {
        childProcess = require("child_process").spawn(command, {
          cwd: foundryRoot,
          shell: true,
          detached: true,
          ...(process.platform !== "win32" && { stdio: "pipe" }),
          env: {
            ...process.env,
            PATH: getEnvironmentPath(),
          },
        });

        // Register process for tracking
        if (childProcess.pid) {
          processManager.registerProcess(childProcess, fuzzerType);
        }

        // Event-based completion detection
        let completionResolve: (() => void) | null = null;
        let completionTimeout: NodeJS.Timeout | null = null;
        const completionPromise = new Promise<void>((resolve) => {
          completionResolve = resolve;
        });

        // Setup completion detection based on fuzzer type
        const checkForCompletion = () => {
          if (processCompleted || !completionResolve) return;
          
          let shouldComplete = false;
          if (fuzzerType === Fuzzer.ECHIDNA && output.includes("Saving test reproducers")) {
            shouldComplete = true;
          } else if (fuzzerType === Fuzzer.MEDUSA && output.includes("Test summary:")) {
            shouldComplete = true;
          } else if (fuzzerType === Fuzzer.HALMOS) {
            // Halmos doesn't need special completion detection
            shouldComplete = true;
          }
          
          if (shouldComplete && completionResolve) {
            completionResolve();
            completionResolve = null;
            if (completionTimeout) {
              clearTimeout(completionTimeout);
              completionTimeout = null;
            }
          }
        };

        // Set timeout for completion detection
        const maxWaitTime = fuzzerType === Fuzzer.HALMOS ? 1000 : 60000;
        completionTimeout = setTimeout(() => {
          if (completionResolve) {
            completionResolve();
            completionResolve = null;
          }
        }, maxWaitTime);

        // Handle graceful shutdown with mutex lock
        async function handleShutdown(reason: string) {
          // Acquire shutdown lock to prevent race conditions
          const hasLock = await processManager.acquireShutdownLock();
          if (!hasLock || processCompleted || !childProcess) {
            if (hasLock) {
              processManager.releaseShutdownLock();
            }
            return;
          }

          try {
            processCompleted = true;
            
            // Unregister process
            if (childProcess.pid) {
              processManager.unregisterProcess(childProcess.pid);
            }

            // Clear completion timeout if set
            if (completionTimeout) {
              clearTimeout(completionTimeout);
            }

            // Terminate process
            try {
              if (process.platform === "win32") {
                require("child_process").execSync(
                  `taskkill /pid ${childProcess.pid} /T /F`,
                  { stdio: "ignore" }
                );
              } else {
                if (reason === "stopped by user") {
                  if (fuzzerType === Fuzzer.MEDUSA) {
                    process.kill(-childProcess.pid, "SIGINT");
                  } else {
                    process.kill(-childProcess.pid, "SIGTERM");
                  }
                }
              }
            } catch (killError) {
              // Process might already be terminated
              console.warn("Error killing process:", killError);
            }

            outputChannel.appendLine(`\n${fuzzerType} process ${reason}`);

            // Wait for completion signals using event-based approach
            await Promise.race([
              completionPromise,
              new Promise<void>((resolveTimeout) => {
                setTimeout(() => resolveTimeout(), 60000);
              })
            ]);

            // Generate report if we have enough data
            if (hasEnoughData) {
                try {
                  if (fuzzerType === Fuzzer.ECHIDNA) {
                    let splitOutput = output.split("Stopping.");
                    if (splitOutput.length > 1) {
                      splitOutput = splitOutput.slice(1);
                      output = splitOutput.join("Stopping.");
                    }
                  }
                  const results = processLogs(output, fuzzerType);
                  const reportContent = generateJobMD(
                    fuzzerType,
                    output,
                    vscode.workspace.name || "Recon Project"
                  );

                  const showReport = await vscode.window.showInformationMessage(
                    `Fuzzing completed. View detailed report?`,
                    { modal: true },
                    "Yes",
                    "No"
                  );

                  if (showReport === "Yes") {
                    const reportDoc = await vscode.workspace.openTextDocument({
                      content: reportContent,
                      language: "markdown",
                    });
                    await vscode.window.showTextDocument(reportDoc, {
                      preview: true,
                    });
                  }

                  // Handle broken properties
                  if (results.brokenProperties.length > 0) {
                    const repros = results.brokenProperties
                      .map((prop) =>
                        prepareTrace(
                          fuzzerType,
                          getUid(),
                          prop.sequence,
                          prop.brokenProperty
                        )
                      )
                      .join("\n\n");

                    const answer = await vscode.window.showInformationMessage(
                      `Found ${results.brokenProperties.length} broken properties. Save Foundry reproductions?`,
                      { modal: true },
                      "Yes",
                      "No"
                    );

                    if (answer === "Yes") {
                      try {
                        const testFolder = await getTestFolder(workspaceRoot);
                        const foundryTestPath = path.join(
                          foundryRoot,
                          testFolder,
                          "recon",
                          "CryticToFoundry.sol"
                        );

                        try {
                          const existingContent = await fs.readFile(
                            foundryTestPath,
                            "utf8"
                          );
                          const newContent = existingContent.replace(
                            /}([^}]*)$/,
                            `\n    ${repros}\n}$1`
                          );
                          await fs.writeFile(foundryTestPath, newContent);

                          const doc = await vscode.workspace.openTextDocument(
                            foundryTestPath
                          );
                          await vscode.window.showTextDocument(doc);
                          vscode.window.showInformationMessage(
                            "Added reproductions to existing CryticToFoundry.sol"
                          );
                        } catch (e) {
                          vscode.window.showWarningMessage(
                            "Could not find CryticToFoundry.sol. Please create it first."
                          );
                        }
                      } catch (error) {
                        console.error("Error saving reproductions:", error);
                        vscode.window.showErrorMessage(
                          "Failed to save Foundry reproductions"
                        );
                      }
                    }
                  }

                  vscode.window.showInformationMessage(
                    `${fuzzerType} ${reason}: ${results.passed} passed, ${results.failed} failed`
                  );
                } catch (error) {
                  console.error("Error generating report:", error);
                  vscode.window.showErrorMessage("Error generating report");
                }
              } else {
                vscode.window.showInformationMessage(
                  `${fuzzerType} ${reason} (not enough data for report)`
                );
              }
            
            // Release lock and resolve after all operations complete
            processManager.releaseShutdownLock();
            resolve();
          } catch (err) {
            console.error("Error during shutdown:", err);
            // Ensure lock is released even on error
            processManager.releaseShutdownLock();
            resolve(); // Still resolve to prevent hanging
          }
        }

        // Handle cancellation
        token.onCancellationRequested(async () => {
          await handleShutdown("stopped by user");
        });

        // Handle process output
        childProcess.stdout.on("data", (data: Buffer) => {
          const text =
            fuzzerType === Fuzzer.MEDUSA || fuzzerType === Fuzzer.HALMOS
              ? stripAnsiCodes(data.toString())
              : data.toString();
          output += text;
          outputChannel.append(text);
          
          // Check for completion signals
          checkForCompletion();

          // Parse fuzzer-specific status
          if (fuzzerType === Fuzzer.ECHIDNA) {
            if (text.includes("[status] tests:")) {
              hasEnoughData = true;
              const testMatch = text.match(/tests: (\d+)\/(\d+)/);
              const fuzzingMatch = text.match(/fuzzing: (\d+)\/(\d+)/);
              const corpusMatch = text.match(/corpus: (\d+)/);

              if (fuzzingMatch) {
                const [, currentFuzz, maxFuzz] = fuzzingMatch;
                const current = parseInt(currentFuzz);
                const max = parseInt(maxFuzz);
                const corpusSize = corpusMatch ? corpusMatch[1] : "0";
                const [, failedTests, totalTests] = testMatch || ["", "0", "0"];

                const percentage = max > 0 ? (current / max) * 100 : 0;
                const increment =
                  percentage - (progress as any).lastPercentage || 0;
                (progress as any).lastPercentage = percentage;

                progress.report({
                  message: `Tests: ${failedTests}/${totalTests} | Progress: ${currentFuzz}/${maxFuzz} | Corpus: ${corpusSize}`,
                  increment: Math.max(0, increment),
                });
              }
            }
          } else if (fuzzerType === Fuzzer.MEDUSA) {
            if (text.includes("fuzz: elapsed:")) {
              hasEnoughData = true;
              const corpusMatch = text.match(/corpus: (\d+)/);
              const failuresMatch = text.match(/failures: (\d+)\/(\d+)/);
              const callsMatch = text.match(/calls: (\d+)/);

              if (corpusMatch && failuresMatch && callsMatch) {
                const corpus = corpusMatch[1];
                const [, failures, totalTests] = failuresMatch;
                const calls = callsMatch[1];
                const testLimit = vscode.workspace
                  .getConfiguration("recon.medusa")
                  .get<number>("testLimit", 0);

                const percentage =
                  testLimit > 0
                    ? Math.min((parseInt(calls) / testLimit) * 100, 100)
                    : 0;
                const increment =
                  percentage - (progress as any).lastPercentage || 0;
                (progress as any).lastPercentage = percentage;

                progress.report({
                  message: `Tests: ${failures}/${totalTests} | Calls: ${calls} | Corpus: ${corpus}`,
                  increment: Math.max(0, increment),
                });
              }
            }
          } else if (fuzzerType === Fuzzer.HALMOS) {
            if (
              text.includes("Running") ||
              text.includes("PASS") ||
              text.includes("FAIL")
            ) {
              hasEnoughData = true;
              const passMatch = text.match(/PASS/g);
              const failMatch = text.match(/FAIL/g);
              const passed = passMatch ? passMatch.length : 0;
              const failed = failMatch ? failMatch.length : 0;
              const total = passed + failed;

              if (total > 0) {
                progress.report({
                  message: `Tests: ${failed}/${total} | Passed: ${passed} | Failed: ${failed}`,
                  increment: 10,
                });
              }
            }
          }
        });

        // Handle stderr
        childProcess.stderr.on("data", (data: Buffer) => {
          const text = data.toString();
          output += text;
          outputChannel.append(text);
        });

        // Handle process completion
        childProcess.on("close", async (code: number) => {
          if (!processCompleted) {
            // Trigger completion check
            checkForCompletion();
            if (code === 0) {
              await handleShutdown("completed");
            } else {
              await handleShutdown(`exited with code ${code}`);
            }
          }
        });

        childProcess.on("error", async (err: Error) => {
          if (!processCompleted) {
            console.error("Process error:", err);
            await handleShutdown(`failed: ${err.message}`);
          }
        });
        
        // Cleanup on promise resolution/rejection
        Promise.resolve().then(() => {
          // This ensures cleanup happens
        }).catch(() => {
          // Handle any unhandled rejections
        });
      });
    }
  );
}
