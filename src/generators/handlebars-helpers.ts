import { pascal, snake, camel } from "case";
import Handlebars from "handlebars";
import { Actor, ParamDefinition, Mode } from '../types';


function capitalizeFirstLetter(string: string) {
    if (string.length === 0) {
        return string;
    }
    return string.charAt(0).toUpperCase() + string.slice(1);
}

function getUsableInternalType(internalType: string): string {
    if (internalType.split(" ").length > 1) {
        return internalType.split(" ")[1];
    } else {
        return internalType;
    }
}

function conditionallyAddMemoryLocation(
    type: string,
    internalType: string
): string {
    // Is an array
    if (type.indexOf("[") !== -1) { // Note: To handle sized arrays [N]
        // May still be a complex type
        if (internalType.startsWith("struct ") || internalType.startsWith("enum ") || internalType.startsWith("contract ")) {
            // Replace tuple with internal type
            const usable = getUsableInternalType(internalType);

            return `${usable} memory`;
        }

        return `${type} memory`;
    }

    // Is a complex type
    if (internalType.startsWith("struct ") || internalType.startsWith("enum ") || internalType.startsWith("contract ")) {
        return `${getUsableInternalType(internalType)}${internalType.startsWith("struct ") ? " memory" : ""}`; // NOTE: If tuple, we need to use the internalType
    }

    // Is a string or bytes
    if (type === "bytes" || type === "string") {
        return `${type} memory`;
    }

    return internalType || type;
}

export function registerHelpers(handlebars: typeof Handlebars) {
    handlebars.registerHelper('snake', function (str: string): string {
        return snake(str);
    });

    handlebars.registerHelper('scream', function (str: string): string {
        return snake(str).toUpperCase();
    });

    handlebars.registerHelper('camel', function (str: string): string {
        return camel(str);
    });

    handlebars.registerHelper('pascal', function (str: string): string {
        return pascal(str);
    });

    // Add new handlebar helper for function definitions
    handlebars.registerHelper('functionDefinition', function ({ contractName, abi, actor, mode }) {
        contractName = camel(contractName);
        let modifiers = [];
        if (abi.stateMutability === 'payable') {
            modifiers.push('payable');
        }
        if (actor === Actor.ADMIN) {
            modifiers.push('asAdmin');
        } else if (actor === Actor.ACTOR) {
            modifiers.push('asActor');
        }
        const valueStr = abi.stateMutability === 'payable' ? '{value: msg.value}' : '';
        const modifiersStr = modifiers.length ?
            modifiers.join(' ') + ' ' : '';
        const hasOutputs = abi.outputs && abi.outputs.length > 0;
        const outputs: string =
            abi.outputs && abi.outputs.length > 0
                ? abi.outputs
                    .map(
                        (output: ParamDefinition, index: number) =>
                            `${conditionallyAddMemoryLocation(output.type, output.internalType)} ${output.name !== "" ? output.name : `value${index}`
                            };`
                    )
                    .join("\n        ")
                : "";
        const returnTypes =
            abi.outputs && abi.outputs.length > 0
                ? abi.outputs
                    .map(
                        (output: ParamDefinition, index: number) =>
                            `${conditionallyAddMemoryLocation(output.type, output.internalType)} ${output.name !== ""
                                ? `temp${capitalizeFirstLetter(output.name!)}`
                                : `tempValue${index}`
                            }`
                    )
                    .join(", ")
                : "";
        const assignValues =
            abi.outputs && abi.outputs.length > 0
                ? abi.outputs
                    .map(
                        (output: ParamDefinition, index: number) =>
                            `${output.name !== "" ? output.name : `value${index}`} = ${output.name !== ""
                                ? `temp${capitalizeFirstLetter(output.name!)}`
                                : `tempValue${index}`
                            };`
                    )
                    .join("\n            ")
                : "";


        if (mode === Mode.NORMAL || mode === Mode.FAIL) {
            return `
    function ${contractName}_${abi.name}(${abi.inputs
                    .map(
                        (input: ParamDefinition) =>
                            `${conditionallyAddMemoryLocation(input.type, input.internalType)} ${input.name
                            }`
                    )
                    .join(", ")}) public ${modifiersStr}{
        ${contractName}.${abi.name}${valueStr}(${abi.inputs
                    .map((input: ParamDefinition) => input.name ? input.name : getDefaultValue(input.type))
                    .join(", ")});${mode === 'fail'
                        ? `
        t(false, "${contractName}_${abi.name}");`
                        : ""
                }
    }`;
        } else {
            return `
    function ${contractName}_${abi.name}(${abi.inputs
                    .map(
                        (input: ParamDefinition) =>
                            `${conditionallyAddMemoryLocation(input.type, input.internalType)} ${input.name
                            }`
                    )
                    .join(", ")}) public ${modifiersStr}{
        ${hasOutputs ? `${outputs}
        try ${contractName}.${abi.name}${valueStr}(${abi.inputs
                        .map((input: ParamDefinition) => input.name ? input.name : getDefaultValue(input.type))
                        .join(", ")}) returns (${returnTypes}) {
            ${assignValues}
        }`
                    : `try ${contractName}.${abi.name}(${abi.inputs
                        .map((input: ParamDefinition) => input.name ? input.name : getDefaultValue(input.type))
                        .join(", ")}) {}`
                } catch {
          ${hasOutputs ? "  " : "  "}t(false, "${contractName}_${abi.name
                }");
      ${hasOutputs ? "  " : "  "}}
    }`;
        }
    });
}

function getDefaultValue(type: string) {
    if(type === "address"){
        return "address(0)";
    } else if(type.startsWith("uint") || type.startsWith("int")){
        return "0";
    } else if(type === "bool"){
        return "false";
    } else if(type === "string"){
        return '""';
    } else if(type === "bytes"){
        return 'bytes("")';
    } else if(type.startsWith("bytes")){
        return `${type}("")`;
    } 
    return '"__HandleMe__"';
}

