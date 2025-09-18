import * as $ from 'solc-typed-ast';
import { getDefinitions, toSource } from './utils';
import { Constant, Member } from './types';

enum typeByteSizes {
  bool = 1,
  address = 20,
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  'address payable' = 20,
  string = 32,
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  'string memory' = 32,
}

export const getBytesSize = (node: $.VariableDeclaration) => {
  if (node.typeString.includes('[]')) {
    return 32;
  }
  if (node.typeString.includes('mapping')) {
    return 32;
  }
  if (node.typeString.includes('struct')) {
    return 32;
  }
  if (node.typeString.startsWith('contract ')) {
    return 20;
  }
  if (node.typeString.startsWith('enum ')) {
    return 1;
  }
  if (node.typeString.startsWith('bytes')) {
    const rawSize = node.typeString.slice(5);
    return rawSize ? parseInt(rawSize) : 32;
  }
  if (node.typeString.startsWith('uint')) {
    const rawSize = node.typeString.slice(4);
    return rawSize ? parseInt(rawSize) / 8 : 32;
  }
  if (node.typeString.startsWith('int')) {
    const rawSize = node.typeString.slice(3);
    return rawSize ? parseInt(rawSize) / 8 : 32;
  }
  // if(type.typeString.startsWith("literal_string")) {
  //     return type.value.length;
  // }
  if (!typeByteSizes[node.typeString as keyof typeof typeByteSizes]) {
    console.log('HANDDLEE ME', node.typeString);
  }
  return typeByteSizes[node.typeString as keyof typeof typeByteSizes];
};

export const calcSlots = (members: Member[]) => {
  // Distribute members into slots
  const slots = [];
  let currentSlot: Member[] = [];
  let currentSlotSize = 0;

  for (const member of members) {
    if (member.children) {
      calcSlots(member.children).forEach((slot) => {
        if (currentSlotSize + slot.reduce((acc, cur) => acc + cur.size, 0) > 32) {
          slots.push(currentSlot);
          currentSlot = slot;
          currentSlotSize = slot.reduce((acc, cur) => acc + cur.size, 0);
        } else {
          currentSlot = currentSlot.concat(slot);
          currentSlotSize += slot.reduce((acc, cur) => acc + cur.size, 0);
        }
      });
    } else {
      if (currentSlotSize + member.size > 32) {
        slots.push(currentSlot);
        member.offset = 0;
        currentSlot = [member];
        currentSlotSize = member.size;
      } else {
        member.offset = currentSlotSize;
        currentSlot.push(member);
        currentSlotSize += member.size;
      }
    }
  }

  // Push the last slot if it's not empty
  if (currentSlot.length > 0) {
    slots.push(currentSlot);
  }

  return slots;
};

const getMembersRecursive = (varDef: $.VariableDeclaration, parent: any, members: any[] = []) => {
  const absolutePath = varDef.getClosestParentByType($.SourceUnit)?.absolutePath;
  if (varDef.typeString.startsWith('struct ')) {
    if (
      varDef.vType &&
      typeof varDef.vType === 'object' &&
      'vReferencedDeclaration' in varDef.vType
    ) {
      const referencedDeclaration = varDef.vType.vReferencedDeclaration;
      if (
        referencedDeclaration &&
        typeof referencedDeclaration === 'object' &&
        'ownChildren' in referencedDeclaration
      ) {
        const children = referencedDeclaration.ownChildren as $.VariableDeclaration[];
        for (const child of children.filter((x) => x instanceof $.VariableDeclaration)) {
          getMembersRecursive(
            child,
            parent || {
              name: varDef.name,
              type: varDef.typeString,
              visibility: varDef.visibility,
              constant: varDef.constant,
              mutability: varDef.mutability,
              absolutePath: absolutePath,
            },
            members
          );
        }
      }
    }
  } else {
    members.push({
      parent: parent,
      size: getBytesSize(varDef),
      name: varDef.name,
      type: varDef.typeString,
      visibility: varDef.visibility,
      constant: varDef.constant,
      mutability: varDef.mutability,
      absolutePath: absolutePath,
    });
  }
};

export const processSlots = (contract: $.ContractDefinition) => {
  const allVars: $.VariableDeclaration[] = getDefinitions(
    contract,
    'vStateVariables',
    true
  ) as $.VariableDeclaration[];
  const members: Member[] = [];
  const stateVariables = allVars.filter(
    (x) =>
      !x.constant &&
      x.mutability !== $.Mutability.Immutable &&
      x.mutability !== $.Mutability.Constant
  );
  for (let i = 0; i < stateVariables.length; i++) {
    getMembersRecursive(stateVariables[i], null, members);
  }
  let slots = [];
  const calculated = calcSlots(members);
  let counter = 0;
  for (let i = 0; i < calculated.length; i++) {
    const slot = calculated[i];
    if (slot.length === 1) {
      // find number between [ and ] if any inside slot[0].type
      const match = slot[0].type.match(/\[(.*?)\]/);
      if (match) {
        const arrayLength = match[1] ? parseInt(match[1]) : 1;
        for (let j = 0; j < arrayLength; j++) {
          slots.push({ [`0x${(counter + j).toString(16).padStart(64, '0')}`]: [...slot] });
        }
        counter += arrayLength;
      } else {
        slots.push({ [`0x${counter.toString(16).padStart(64, '0')}`]: [...slot] });
        counter++;
      }
    } else {
      slots.push({ [`0x${counter.toString(16).padStart(64, '0')}`]: [...slot] });
      counter++;
    }
  }
  // convert to object
  slots = Object.assign({}, ...slots);
  const constants: Constant[] = [];
  for (const cVar of allVars.filter(
    (x) =>
      x.constant ||
      x.mutability === $.Mutability.Immutable ||
      x.mutability === $.Mutability.Constant
  )) {
    const absolutePath = cVar.getClosestParentByType($.SourceUnit)?.absolutePath;
    constants.push({
      name: cVar.name,
      type: cVar.typeString,
      visibility: cVar.visibility,
      constant: cVar.constant,
      mutability: cVar.mutability,
      source: toSource(cVar),
      absolutePath: absolutePath || '',
    });
  }
  return { slots, constants };
};
