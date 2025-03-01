import handlebars from 'handlebars';
import { registerHelpers } from '../handlebars-helpers';

registerHelpers(handlebars);

export const medusaConfigTemplate = handlebars.compile(`{
  "fuzzing": {
    "workers": 10,
    "workerResetLimit": 50,
    "timeout": 0,
    "testLimit": 0,
    "callSequenceLength": 100,
    "corpusDirectory": "medusa",
    "coverageEnabled": true,
    "deploymentOrder": [
      "CryticTester"
    ],
    "targetContracts": [
      "CryticTester"
    ],
    "targetContractsBalances": [
      "0x27b46536c66c8e3000000"
    ],
    "constructorArgs": {},
    "deployerAddress": "0x7FA9385bE102ac3EAc297483Dd6233D62b3e1496",
    "senderAddresses": [
      "0x10000",
      "0x20000",
      "0x30000"
    ],
    "blockNumberDelayMax": 60480,
    "blockTimestampDelayMax": 604800,
    "blockGasLimit": 125000000,
    "transactionGasLimit": 12500000,
    "testing": {
      "stopOnFailedTest": false,
      "stopOnFailedContractMatching": false,
      "stopOnNoTests": true,
      "testAllContracts": false,
      "traceAll": false,
      "assertionTesting": {
        "enabled": true,
        "testViewMethods": true,
        "panicCodeConfig": {
          "failOnCompilerInsertedPanic": false,
          "failOnAssertion": true,
          "failOnArithmeticUnderflow": false,
          "failOnDivideByZero": false,
          "failOnEnumTypeConversionOutOfBounds": false,
          "failOnIncorrectStorageAccess": false,
          "failOnPopEmptyArray": false,
          "failOnOutOfBoundsArrayAccess": false,
          "failOnAllocateTooMuchMemory": false,
          "failOnCallUninitializedVariable": false
        }
      },
      "propertyTesting": {
        "enabled": true,
        "testPrefixes": [
          "invariant_"
        ]
      },
      "optimizationTesting": {
        "enabled": false,
        "testPrefixes": [
          "optimize_"
        ]
      }
    },
    "chainConfig": {
      "codeSizeCheckDisabled": true,
      "cheatCodes": {
        "cheatCodesEnabled": true,
        "enableFFI": false
      }
    }
  },
  "compilation": {
    "platform": "crytic-compile",
    "platformConfig": {
      "target": ".",
      "solcVersion": "",
      "exportDirectory": "",
      "args": [
        "--foundry-compile-all"
      ]
    }
  },
  "logging": {
    "level": "info",
    "logDirectory": ""
  }
}`, { noEscape: true });