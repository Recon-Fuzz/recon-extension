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
import { ToolValidationService } from "../services/toolValidationService";
import { formatDuration } from "../utils";
import { filterIgnoredProperties } from "../utils/propertyFilter";
import { getWorkerConfig } from "../utils/workerConfig"

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

  // Register Recon Fuzzer command — same wire format as Echidna, just run via
  // the `recon fuzz` wrapper so the user gets Recon's value-add on top.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "recon.runReconFuzzer",
      async (target?: string) => {
        await runFuzzer(Fuzzer.ECHIDNA, services, target, { useReconWrapper: true });
      }
    )
  );

  // Right-click "Replay corpus with Recon Fuzzer" on a .txt file under recon/.
  // Appends --replay <absolute path> to the same Recon Fuzzer command.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "recon.replayReconFuzzer",
      async (resource?: vscode.Uri) => {
        let target: vscode.Uri | undefined = resource;
        if (!target) {
          const active = vscode.window.activeTextEditor;
          if (active && active.document.uri.scheme === "file") {
            target = active.document.uri;
          }
        }
        if (!target) {
          vscode.window.showErrorMessage(
            "Recon: select a corpus .txt file under recon/ to replay."
          );
          return;
        }
        await runFuzzer(Fuzzer.ECHIDNA, services, undefined, {
          useReconWrapper: true,
          replayFile: target.fsPath,
        });
      }
    )
  );
}

interface RunFuzzerOptions {
  /** When true, swap `echidna` for `recon fuzz` (output is identical). */
  useReconWrapper?: boolean;
  /** Absolute path of a corpus .txt file to replay (Recon Fuzzer only). */
  replayFile?: string;
}

const RECON_FUZZER_WEB_URL = "https://recon-fuzzer.vercel.app/";

let reconFuzzerWebPanel: vscode.WebviewPanel | undefined;

/**
 * Open (or reveal) a side webview panel that embeds the Recon Fuzzer web UI
 * via an iframe. Stays in sync with the running `--web` instance.
 */
function openReconFuzzerWebPanel(): void {
  if (reconFuzzerWebPanel) {
    reconFuzzerWebPanel.reveal(vscode.ViewColumn.Beside, true);
    return;
  }
  reconFuzzerWebPanel = vscode.window.createWebviewPanel(
    "reconFuzzerWeb",
    "Recon Fuzzer · Web UI",
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );
  reconFuzzerWebPanel.iconPath = new vscode.ThemeIcon("globe");
  reconFuzzerWebPanel.webview.html = reconFuzzerWebHtml(RECON_FUZZER_WEB_URL);
  reconFuzzerWebPanel.onDidDispose(() => {
    reconFuzzerWebPanel = undefined;
  });
}

function reconFuzzerWebHtml(url: string): string {
  // VS Code webviews can embed external URLs via an <iframe> as long as the
  // frame-src CSP allows the host. Keep the iframe full-bleed.
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "frame-src https://recon-fuzzer.vercel.app https://*.vercel.app https:",
    "img-src https: data:",
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Recon Fuzzer · Web UI</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: #0e0e10; }
    iframe { width: 100%; height: 100%; border: 0; display: block; }
  </style>
</head>
<body>
  <iframe src="${url}" allow="clipboard-write; clipboard-read"></iframe>
</body>
</html>`;
}

async function runFuzzer(
  fuzzerType: Fuzzer,
  services: ServiceContainer,
  target: string = "CryticTester",
  opts: RunFuzzerOptions = {}
): Promise<void> {
  if (!vscode.workspace.workspaceFolders) {
    vscode.window.showErrorMessage("Please open a workspace first");
    return;
  }

  // Validate that the fuzzer tool is available (echidna and medusa)
  let validatedCommand: string | undefined;
  if (fuzzerType === Fuzzer.ECHIDNA || fuzzerType === Fuzzer.MEDUSA) {
    const validationService = new ToolValidationService();
    const fuzzerName = fuzzerType === Fuzzer.ECHIDNA ? "echidna" : "medusa";
    const validation = await validationService.validateFuzzer(fuzzerName);

    if (!validation.isValid) {
      const result = await vscode.window.showWarningMessage(
        validation.error || `${fuzzerName} not found`,
        "Open Settings",
        "Cancel"
      );

      if (result === "Open Settings") {
        vscode.commands.executeCommand(
          "workbench.action.openSettings",
          `recon.${fuzzerName}.path`
        );
      }
      return;
    }
    validatedCommand = validation.command;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const foundryConfigPath = getFoundryConfigPath(workspaceRoot);
  const foundryRoot = path.dirname(foundryConfigPath);

  let cmdBinary: string;
  let cmdArgs: string[];
  let webUiEnabled = false;

  if (fuzzerType === Fuzzer.ECHIDNA) {
    const config = vscode.workspace.getConfiguration("recon.echidna");
    // const workers = config.get<number>("workers", 8); prev default, now dynamic
    const workers = getWorkerConfig('echidna');
    const testLimit = config.get<number>("testLimit", 1000000);
    const mode = config.get<string>("mode", "assertion");

    // Pick the binary: recon fuzz wrapper, the validated custom echidna
    // path, or `echidna` from PATH.
    // Args array prevents command injection — each value is a separate
    // argv element, never parsed by a shell.
    if (opts.useReconWrapper) {
      cmdBinary = "recon";
      cmdArgs = ["fuzz"];
    } else {
      cmdBinary = validatedCommand || "echidna";
      cmdArgs = [];
    }
    cmdArgs.push(".", "--contract", target || "CryticTester",
      "--config", "echidna.yaml", "--format", "text",
      "--workers", String(workers || 10),
      "--test-limit", String(testLimit), "--test-mode", mode);

    if (opts.useReconWrapper) {
      const reconCfg = vscode.workspace.getConfiguration("recon.reconFuzzer");
      const keepEchidnaCorpus = reconCfg.get<boolean>("generateEchidnaCorpus", false);
      // Recon Fuzzer writes corpus + coverage to ./recon/ so we can tell
      // its output apart from raw Echidna's ./echidna/ output.
      cmdArgs.push(keepEchidnaCorpus ? "--recon-corpus-dir" : "--corpus-dir", "recon");
      if (reconCfg.get<boolean>("skipPureViewFunctions", false)) {
        cmdArgs.push("--mutable-only");
      }
      // --web is interactive and incompatible with a one-shot replay run,
      // so skip it for replays even if the setting is enabled.
      if (reconCfg.get<boolean>("webUi", false) && !opts.replayFile) {
        cmdArgs.push("--web", "--no-open");
        webUiEnabled = true;
      }
      if (opts.replayFile) {
        cmdArgs.push("--replay", opts.replayFile);
      }
    }

    if (webUiEnabled) {
      openReconFuzzerWebPanel();
    }
  } else if (fuzzerType === Fuzzer.MEDUSA) {
    const config = vscode.workspace.getConfiguration("recon.medusa");
    // const workers = config.get<number>("workers", 10); prev default, now dynamic
    const workers = getWorkerConfig('medusa');
    const testLimit = config.get<number>("testLimit", 0);

    cmdBinary = validatedCommand || "medusa";
    cmdArgs = ["fuzz", "--workers", String(workers || 10),
      "--test-limit", String(testLimit)];
    if (target !== "CryticTester") {
      cmdArgs.push("--target-contracts", target || "CryticTester");
    }
  } else {
    const config = vscode.workspace.getConfiguration("recon.halmos");
    const loop = config.get<number>("loop", 256);

    cmdBinary = "halmos";
    cmdArgs = ["--match-contract", target || "CryticTester",
      "-vv", "--solver-timeout-assertion", "0", "--loop", String(loop)];
  }

  // Display label distinguishes the Recon-wrapped Echidna from raw Echidna,
  // and tags replay runs separately for the output channel + progress UI.
  const displayName =
    opts.useReconWrapper && fuzzerType === Fuzzer.ECHIDNA
      ? opts.replayFile
        ? `Recon Fuzzer (replay)`
        : "Recon Fuzzer"
      : fuzzerType === Fuzzer.ECHIDNA
      ? "Echidna"
      : fuzzerType === Fuzzer.MEDUSA
      ? "Medusa"
      : "Halmos";

  // Create output channel for live feedback
  const outputChannel = services.outputService.createFuzzerOutputChannel(displayName);
  outputChannel.show();

  let output = "";
  let processCompleted = false;
  let childProcess: any = null;
  let hasEnoughData = false;
  // Web UI mode is interactive (long-lived web server). Skip the test-counter
  // polling, the wait-for-shutdown-message loop, and the report flow — the
  // user drives everything from the embedded web view and stops via Cancel.
  const isWebUiRun = !!webUiEnabled;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: isWebUiRun ? `${displayName} (Web UI)` : displayName,
      cancellable: true,
    },
    async (progress, token) => {
      const startTime = Date.now();
      return new Promise<void>((resolve, reject) => {
        if (isWebUiRun) {
          progress.report({ message: `Web UI running · open ${RECON_FUZZER_WEB_URL} — Cancel to stop` });
        }

        childProcess = require("child_process").spawn(cmdBinary, cmdArgs, {
          cwd: foundryRoot,
          ...(process.platform === "win32"
            ? { stdio: "pipe", detached: false }
            : { stdio: "pipe", detached: true }),
          env: {
            ...process.env,
            PATH: getEnvironmentPath(),
          },
        });

        // Handle graceful shutdown
        async function handleShutdown(reason: string) {
          if (!processCompleted && childProcess) {
            processCompleted = true;
            resolve();

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

            outputChannel.appendLine(`\n${displayName.toUpperCase()} process ${reason}`);

            // Web UI runs are interactive — no shrinking step, no broken
            // properties report, just close cleanly.
            if (isWebUiRun) {
              vscode.window.showInformationMessage(`${displayName} ${reason}`);
              return;
            }

            try {
              // Wait for completion signals for each fuzzer
              if (fuzzerType === Fuzzer.ECHIDNA) {
                // Wait for "Saving test reproducers" with 1 minute timeout
                let waited = 0;
                while (
                  waited < 60000 &&
                  !output.includes("Saving test reproducers")
                ) {
                  await new Promise((resolve) => setTimeout(resolve, 1000));
                  waited += 1000;
                }
              } else if (fuzzerType === Fuzzer.MEDUSA) {
                // Wait for "Test summary:" with 1 minute timeout
                let waited = 0;
                while (waited < 60000 && !output.includes("Test summary:")) {
                  await new Promise((resolve) => setTimeout(resolve, 1000));
                  waited += 1000;
                }
              } else if (fuzzerType === Fuzzer.HALMOS) {
                // Halmos doesn't do shrinking so we shouldn't need to wait much
                let waited = 0;
                while (
                  waited < 1000 &&
                  !output.includes("HALMOS process completed")
                ) {
                  await new Promise((resolve) => setTimeout(resolve, 1000));
                  waited += 1000;
                }
              }

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
                  let reportContent = generateJobMD(
                    fuzzerType,
                    output,
                    vscode.workspace.name || "Recon Project"
                  );

                  // Fix table header and rows for optimization mode
                  if (fuzzerType === Fuzzer.ECHIDNA) {
                    const echidnaMode = vscode.workspace
                      .getConfiguration("recon.echidna")
                      .get<string>("mode", "assertion");
                    if (echidnaMode === "optimization") {
                      // Replace table header
                      reportContent = reportContent.replace(
                        "| Property | Status |",
                        "| Property | Max Value |"
                      );

                      // Parse optimization results from raw output
                      const optimizationResults: { property: string; value: string }[] = [];
                      const lines = output.split('\n');
                      for (const line of lines) {
                        if (line.includes(': max value:')) {
                          const parts = line.split(': max value:');
                          const property = parts[0].trim();
                          const value = parts[1].trim();
                          optimizationResults.push({ property, value });
                        }
                      }

                      // Build table rows with dynamic column widths
                      if (optimizationResults.length > 0) {
                        // Calculate column widths
                        const propertyHeader = "Property";
                        const valueHeader = "Max Value";
                        const maxPropertyLen = Math.max(
                          propertyHeader.length,
                          ...optimizationResults.map(r => r.property.length)
                        );
                        const maxValueLen = Math.max(
                          valueHeader.length,
                          ...optimizationResults.map(r => r.value.length)
                        );

                        // Build dynamic table
                        const headerRow = `| ${propertyHeader.padEnd(maxPropertyLen)} | ${valueHeader.padEnd(maxValueLen)} |`;
                        const separatorRow = `|${'-'.repeat(maxPropertyLen + 2)}|${'-'.repeat(maxValueLen + 2)}|`;
                        const tableRows = optimizationResults
                          .map(r => `| ${r.property.padEnd(maxPropertyLen)} | ${r.value.padEnd(maxValueLen)} |`)
                          .join('\n');

                        // Replace all empty tables by splitting and rejoining
                        const fullTable = `${headerRow}\n${separatorRow}\n${tableRows}`;
                        // The original separator has 10 dashes for Property and 8 for Status
                        // After header replacement, it's still |----------|--------|
                        const emptyTable = "| Property | Max Value |\n|----------|--------|";
                        const parts = reportContent.split(emptyTable);
                        reportContent = parts.join(fullTable);
                      }
                    }
                  }

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
                  const filteredProperties = filterIgnoredProperties(results.brokenProperties);
                  if (filteredProperties.length > 0) {
                    const repros = filteredProperties
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
                      `Found ${filteredProperties.length} broken properties. Save Foundry reproductions?`,
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
                    `${displayName} ${reason}: ${results.passed} passed, ${results.failed} failed`
                  );
                } catch (error) {
                  console.error("Error generating report:", error);
                  vscode.window.showErrorMessage("Error generating report");
                }
              } else {
                vscode.window.showInformationMessage(
                  `${displayName} ${reason} (not enough data for report)`
                );
              }
            } catch (err) {
              console.error("Error during shutdown:", err);
              reject(err);
            }
          }
        }

        // Handle cancellation
        token.onCancellationRequested(() => {
          handleShutdown("stopped by user");
        });

        // Handle process output
        childProcess.stdout.on("data", (data: Buffer) => {
          const text =
            fuzzerType === Fuzzer.MEDUSA || fuzzerType === Fuzzer.HALMOS
              ? stripAnsiCodes(data.toString())
              : data.toString();
          output += text;
          outputChannel.append(text);

          // Parse fuzzer-specific status — skip for Web UI runs since the
          // user is watching live state in the embedded web panel.
          if (isWebUiRun) { return; }
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

                const percentage = (current / max) * 100;
                const increment =
                  percentage - (progress as any).lastPercentage || 0;
                (progress as any).lastPercentage = percentage;

                let etaStr = "";
                if (current > 0) {
                  const elapsedSeconds = (Date.now() - startTime) / 1000;
                  const testsPerSecond = current / elapsedSeconds;
                  const remainingTests = max - current;
                  const remainingSeconds = remainingTests / testsPerSecond;
                  etaStr = `ETA: ${formatDuration(remainingSeconds)}`;
                }

                progress.report({
                  message: `Tests: ${etaStr} | ${failedTests}/${totalTests} | Progress: ${currentFuzz}/${maxFuzz} | Corpus: ${corpusSize}`,
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
                const [, failures, totalTestsStr] = failuresMatch;
                const totalTests = parseInt(totalTestsStr);
                const calls = callsMatch[1];
                const currentCalls = parseInt(calls);
                let testLimit = vscode.workspace
                  .getConfiguration("recon.medusa")
                  .get<number>("testLimit", 0);

                const percentage =
                  testLimit > 0
                    ? Math.min((currentCalls / testLimit) * 100, 100)
                    : 0;
                const increment =
                  percentage - (progress as any).lastPercentage || 0;
                (progress as any).lastPercentage = percentage;

                let etaStr = "";
                if (testLimit > 0 && currentCalls > 0) {
                  const elapsedSeconds = (Date.now() - startTime) / 1000;
                  const callsPerSecond = currentCalls / elapsedSeconds;
                  const remainingCalls = testLimit - currentCalls;
                  const remainingSeconds = remainingCalls / callsPerSecond;
                  etaStr = `ETA: ${formatDuration(remainingSeconds)}`;
                }

                progress.report({
                  message: `Tests: ${etaStr} | ${failures}/${totalTestsStr} | Calls: ${calls} | Corpus: ${corpus}`,
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
            if (code === 0) {
              handleShutdown("completed");
            } else {
              handleShutdown(`exited with code ${code}`);
            }
          }
        });

        childProcess.on("error", (err: Error) => {
          if (!processCompleted) {
            console.error("Process error:", err);
            handleShutdown(`failed: ${err.message}`);
          }
        });
      });
    }
  );
}
