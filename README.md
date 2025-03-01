# Recon - Smart Contract Fuzzing Extension

<p align="center">
  <img src="https://github.com/user-attachments/assets/c79df2a8-9577-48ab-82e8-4882a0fe7e06" alt="Recon Logo" width="128" height="128">
</p>

<p align="center">
  <strong>Seamless integration of Foundry, Medusa, and Echidna for smart contract testing</strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#getting-started">Getting Started</a> •
  <a href="#usage">Usage</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#troubleshooting">Troubleshooting</a> •
  <a href="#license">License</a>
</p>

---

## Features

Recon is a VS Code extension that streamlines smart contract testing by providing:

- **One-click setup**: Automatically install and configure Chimera templates
- **Integrated fuzzing**: Run Echidna and Medusa directly from VS Code
- **Contract explorer**: Browse and select target contracts and functions
- **Status bar integration**: Quick access to fuzzing tools
- **Coverage visualization**: View and analyze code coverage from fuzzers
- **Test reproduction**: Generate Foundry test cases from fuzzing findings
- **Mock generation**: Easily create mock contracts for testing
- **CodeLens integration**: Run tests and modify function behaviors directly in the editor

## Installation

### Prerequisites

- Visual Studio Code 1.88.0 or higher
- Foundry toolchain (forge, cast, anvil)
- Echidna (optional)
- Medusa (optional)

### Install from VS Code Marketplace

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X)
3. Search for "Recon"
4. Click "Install"

### Manual Installation

1. Download the `.vsix` file from the [latest release](https://github.com/Recon-Fuzz/recon-extension/releases/latest)
2. In VS Code, go to Extensions
3. Click the "..." menu and select "Install from VSIX..."
4. Select the downloaded file

## Getting Started

1. Open a Foundry project in VS Code
2. Click on the Recon icon in the activity bar
3. In the Cockpit view, click "Scaffold" to set up Recon templates
4. Select target contracts and functions in the Contracts view
5. Run Echidna or Medusa from the status bar or Cockpit view

## Usage

### Scaffolding a Project

The "Scaffold" button in the Recon Cockpit view will:

- Install Chimera as a library dependency
- Update remappings.txt with the necessary mappings
- Create template files in the test/recon directory
- Configure your project for fuzzing

### Selecting Target Contracts and Functions

In the Contracts view:

1. Enable the contracts you want to test
2. For each contract, select the functions to include in testing
3. Configure function properties:
   - Actor: Regular user or admin
   - Mode: Normal execution, expected failure, or catch exceptions

### Running Fuzzers

- Use the status bar buttons for quick access to Echidna and Medusa
- Set the default fuzzer and configuration in the Cockpit view
- View live fuzzing progress in the output panel

### Viewing Coverage

After running a fuzzer with coverage enabled:

1. Go to the Coverage Reports view
2. Select a coverage report to view
3. Click the external icon to open the report in a browser view
4. Use the "Clean up Coverage Report" command for better readability

### Generating Mocks

Right-click on a contract's JSON artifact or Solidity file and select "Generate Solidity Mock" to create a mock implementation of the contract.

## Configuration

Recon can be configured through VS Code settings:

### General Settings

- `recon.defaultFuzzer`: Choose between Echidna and Medusa
- `recon.showAllFiles`: Show or hide test and library files in the Contracts view
- `recon.foundryConfigPath`: Path to foundry.toml (relative to workspace root)

### Echidna Settings

- `recon.echidna.mode`: Select fuzzing strategy (assertion, property, etc.)
- `recon.echidna.testLimit`: Maximum number of test cases to run
- `recon.echidna.workers`: Number of parallel workers

### Medusa Settings

- `recon.medusa.testLimit`: Maximum number of test cases to run
- `recon.medusa.workers`: Number of parallel workers

### Forge Settings

- `recon.forge.buildArgs`: Additional arguments for forge build
- `recon.forge.testVerbosity`: Verbosity level for forge test output

## Troubleshooting

### Common Issues

- **Fuzzer not found**: Ensure Echidna/Medusa are installed and in your PATH
- **Compilation errors**: Run `forge build` manually to identify issues
- **No contracts showing**: Check if out/ directory exists with compiled contracts

## License

Recon is released under the MIT License.

```
MIT License

Copyright (c) 2023-2024 Recon-Fuzz Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

This extension is provided as-is, and contributions are welcome through our [GitHub repository](https://github.com/Recon-Fuzz/recon-extension).