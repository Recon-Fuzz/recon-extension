# Changelog

## [0.0.31] - 17.04.2026

### Added
- Recon Fuzzer (cockpit option, replay corpus, optional web UI)
- Recon CLI auto-detect + one-click install via reconup
- Coverage Reports list Recon Fuzzer outputs from `recon/`
- `Install Chimera` also adds `recon` and `.recon` to `.gitignore`
- Property ignore patterns with CodeLens toggle on `*Properties.sol`
- CPU-aware worker auto-detection (reserved cores, uncap mode)
- Custom binary paths for Echidna and Medusa, with pre-run tool validation
- ETA in fuzz progress for Echidna and Medusa
- "Generate Mock and add to Setup" command

### Fixed
- Optimization-mode markdown report table
- Coverage HTML report regenerates when source is newer

## [0.0.30] - 06.11.2025

### Fixed & Improved
- Various fixes and improvements across the cockpit, fuzzers, and coverage view

## [0.0.29] - 05.11.2025

### fix
- Argus for non-abstract contracts
- Argus non-root foundry config

## [0.0.28] - 04.11.2025

### Added
- Argus call graph

## [0.0.27] - 14.10.2025

### Added
- Halmos Fuzzer
- Vyper Compilation

## [0.0.26] - 08.08.2025

### Added
- Linking libraries (experimental)
- Improved Medusa.json and Echidna.yaml to match CCA

## [0.0.25] - 25.06.2025

### Added
- Log to Foundry Repro Converter

### Fixed
- Rearrange the buttons for better UX
- Upgrade dependencies

## [0.0.24] - 29.05.2025

### Fixed
- Custom target contract
- Custom src folder handling
- Fallback/Receive functions mock
- Payable functions mock

## [0.0.23] - 26.05.2025

### Fixed
- Load the PATH env variable correctly

## [0.0.22] - 15.05.2025

### Fixed
- Waiting for Medusa process to exit completely (with maximum of 60 seconds)
- Persistant recon.json

## [0.0.21] - 15.05.2025

### Fixed
- Waiting for Echidna process to exit completely (with maximum of 60 seconds)
- Upgrade packages to latest versions

## [0.0.20] - 12.05.2025

### Fixed
- Issue with PATH - (h/t: @SethTenenbaum)
- Overloaded functions in mock (functions with same name)
- Memory issue because of output folder watchers
- Better Echidna repro (using shrunken version)
- Refresh contracts button

## [0.0.19] - 17.04.2025

### Fixed
- Contract watcher now correctly tracks individual file changes in output folder

## [0.0.18] - 17.04.2025

### Fixed
- Coverage report compatibility with new Medusa report format
- Issue with fuzzer not stopping

[0.0.31]: https://github.com/Recon-Fuzz/recon-extension/releases/tag/v0.0.31
[0.0.30]: https://github.com/Recon-Fuzz/recon-extension/releases/tag/v0.0.30
[0.0.29]: https://github.com/Recon-Fuzz/recon-extension/releases/tag/v0.0.29
[0.0.28]: https://github.com/Recon-Fuzz/recon-extension/releases/tag/v0.0.28
[0.0.27]: https://github.com/Recon-Fuzz/recon-extension/releases/tag/v0.0.27
[0.0.26]: https://github.com/Recon-Fuzz/recon-extension/releases/tag/v0.0.26
[0.0.25]: https://github.com/Recon-Fuzz/recon-extension/releases/tag/v0.0.25
[0.0.24]: https://github.com/Recon-Fuzz/recon-extension/releases/tag/v0.0.24
[0.0.23]: https://github.com/Recon-Fuzz/recon-extension/releases/tag/v0.0.23
[0.0.22]: https://github.com/Recon-Fuzz/recon-extension/releases/tag/v0.0.22
[0.0.21]: https://github.com/Recon-Fuzz/recon-extension/releases/tag/v0.0.21
[0.0.20]: https://github.com/Recon-Fuzz/recon-extension/releases/tag/v0.0.20
[0.0.19]: https://github.com/Recon-Fuzz/recon-extension/releases/tag/v0.0.19
[0.0.18]: https://github.com/Recon-Fuzz/recon-extension/releases/tag/v0.0.18
