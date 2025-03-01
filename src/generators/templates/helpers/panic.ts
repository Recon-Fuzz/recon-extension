import handlebars from 'handlebars';
import { registerHelpers } from '../../handlebars-helpers';

registerHelpers(handlebars);

export const panicTemplate = handlebars.compile(`// SPDX-License-Identifier: GPL-2.0
pragma solidity ^0.8.0;

library Panic {
    // compiler panics
    string constant assertionPanic = "Panic(1)";
    string constant arithmeticPanic = "Panic(17)";
    string constant divisionPanic = "Panic(18)";
    string constant enumPanic = "Panic(33)";
    string constant arrayPanic = "Panic(34)";
    string constant emptyArrayPanic = "Panic(49)";
    string constant outOfBoundsPanic = "Panic(50)";
    string constant memoryPanic = "Panic(65)";
    string constant functionPanic = "Panic(81)";
}`, { noEscape: true });