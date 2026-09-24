/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Bytes at a guest address → one decoded instruction, or a refusal naming
 * the opcode.
 *
 * The decoder resolves prefixes, the opcode maps, the modrm/SIB addressing
 * forms (32-bit, and the 16-bit forms an address-size prefix selects) and
 * the immediates, and hands back the instruction with its operands as
 * records, its length, the flags it reads, writes and leaves undefined, and
 * how it can fault. It never guesses: an encoding the table does not hold,
 * a form outside user mode, a prefix on an instruction that has no meaning
 * for it, or a run past fifteen bytes is a `Refusal`, counted by opcode so
 * the table grows from what programs actually execute.
 *
 * The mode is a parameter from the first line: 32-bit today, and the seam a
 * 64-bit engine will put a REX-aware table behind without renaming anything.
 */

import {
    CONDITIONS, DF, Group, ONE_BYTE, Prefixed, SYS, TWO_BYTE, X87, conditionReads,
} from './table.js';

/** The longest an instruction may be; the processor faults past it. */
const MAX_LENGTH = 15;

/** The eight general registers by index; byte registers 4..7 are AH CH DH BH. */
export const REGISTERS = Object.freeze(['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi']);
export const SEGMENTS = Object.freeze(['es', 'cs', 'ss', 'ds', 'fs', 'gs']);

/**
 * @typedef {Object} Operand
 * @property {'reg' | 'mem' | 'imm' | 'rel' | 'seg' | 'x87' | 'mm' | 'xmm'} kind
 * @property {number} size          in bytes (0 for a register with no data width, as
 *                                  `lea`'s source)
 * @property {number} [reg]         register index, for reg/seg/x87/mm/xmm
 * @property {boolean} [high]       a byte register that is the high byte (AH..BH)
 * @property {number} [base]        mem: base register index, or -1
 * @property {number} [index]       mem: index register index, or -1
 * @property {number} [scale]       mem: 1, 2, 4 or 8
 * @property {number} [disp]        mem: signed displacement
 * @property {number} [segment]     mem: segment register index the access is relative to
 * @property {16 | 32} [addressSize]
 * @property {number} [value]       imm: the value, sign-extended where the form says so
 * @property {number} [target]      rel: the absolute target
 */

/**
 * @typedef {Object} Instruction
 * @property {number} eip
 * @property {number} length
 * @property {string} op
 * @property {Operand[]} operands
 * @property {number} size          the main operand size after prefixes: 1, 2, 4 (8/16 for SIMD)
 * @property {number} flagsRead
 * @property {number} flagsWritten
 * @property {number} flagsUndefined
 * @property {'none' | 'divide' | 'invalid' | 'trap' | 'halt'} faults
 * @property {boolean} memory       whether any operand is a memory operand
 * @property {{ lock: boolean, rep: boolean, repne: boolean, segment: number, operand: boolean,
 *              address: boolean }} prefixes
 * @property {number} [cc]          for jcc/setcc/cmovcc/fcmovcc
 * @property {string} opcode        the opcode bytes as text, "0f 2e", for a report
 */

/**
 * @typedef {Object} Refusal
 * @property {true} refused
 * @property {number} eip
 * @property {string} opcode
 * @property {string} reason
 */

/**
 * @param {(address: number) => number} read   one byte of guest memory
 * @param {number} eip
 * @param {{ bits: 32 | 64 }} [mode]
 * @returns {Instruction | Refusal}
 */
export function decode(read, eip, mode = { bits: 32 }){
    if (mode.bits !== 32)
    {
        return refusal(eip, '', 'a 64-bit decoder is a later package');
    }
    let at = eip;
    /** @returns {number} */
    const byte = ()=>{
        if (at - eip >= MAX_LENGTH)
        {
            throw new TooLong();
        }
        return read(at++) & 0xff;
    };
    try
    {
        return decodeAt(byte, eip, ()=>at - eip);
    }
    catch (e){
        if (e instanceof TooLong)
        {
            return refusal(eip, '', 'longer than fifteen bytes');
        }
        throw e;
    }
}

class TooLong extends Error {}

/** @param {number} eip @param {string} opcode @param {string} reason @returns {Refusal} */
function refusal(eip, opcode, reason){
    return { refused: true, eip, opcode, reason };
}

/**
 * @param {() => number} byte
 * @param {number} eip
 * @param {() => number} consumed
 * @returns {Instruction | Refusal}
 */
function decodeAt(byte, eip, consumed){
    const prefixes = {
        lock: false, rep: false, repne: false, segment: -1, operand: false, address: false,
    };
    let opcode = byte();
    for (;;)
    {
        if (opcode === 0x66)
        {
            prefixes.operand = true;
        }
        else if (opcode === 0x67)
        {
            prefixes.address = true;
        }
        else if (opcode === 0xf0)
        {
            prefixes.lock = true;
        }
        else if (opcode === 0xf2)
        {
            prefixes.repne = true;
            prefixes.rep = false;
        }
        else if (opcode === 0xf3)
        {
            prefixes.rep = true;
            prefixes.repne = false;
        }
        else if (opcode === 0x26 || opcode === 0x2e || opcode === 0x36 || opcode === 0x3e)
        {
            prefixes.segment = [0x26, 0x2e, 0x36, 0x3e].indexOf(opcode);
        }
        else if (opcode === 0x64 || opcode === 0x65)
        {
            prefixes.segment = opcode - 0x64 + 4;
        }
        else
        {
            break;
        }
        opcode = byte();
    }

    const operandSize = prefixes.operand ? 2 : 4;
    const addressSize = prefixes.address ? 16 : 32;
    /** @type {number | null} */
    let modrm = null;
    const fetchModrm = ()=>{
        if (modrm === null)
        {
            modrm = byte();
        }
        return modrm;
    };

    /** @type {import('./table.js').Entry | Group | Prefixed | typeof SYS | null} */
    let entry;
    let opcodeText;
    // The register an opcode's low three bits name (`inc eax` is 0x40+0),
    // taken from the last opcode byte -- the second one in the 0F map.
    let zReg = opcode & 7;
    if (opcode >= 0xd8 && opcode <= 0xdf)
    {
        const map = X87[opcode - 0xd8];
        const m = fetchModrm();
        entry = m < 0xc0 ? map.mem[m >> 3 & 7] : (map.reg[m] ?? null);
        opcodeText = `${hex(opcode)} ${hex(m)}`;
    }
    else if (opcode === 0x0f)
    {
        const second = byte();
        zReg = second & 7;
        opcodeText = `0f ${hex(second)}`;
        entry = TWO_BYTE[second];
        if (entry instanceof Prefixed)
        {
            // A mandatory prefix is not a repeat or an operand size here.
            const key = prefixes.rep ? 'f3' : prefixes.repne ? 'f2' : prefixes.operand ? '66' : '';
            const variant = entry.variants[key];
            if (variant === undefined)
            {
                return refusal(eip, `${key ? `${key} ` : ''}${opcodeText}`, 'not in table');
            }
            if (key !== '')
            {
                prefixes.rep = false;
                prefixes.repne = false;
                prefixes.operand = false;
                opcodeText = `${key} ${opcodeText}`;
            }
            entry = variant;
        }
    }
    else
    {
        entry = ONE_BYTE[opcode];
        opcodeText = hex(opcode);
    }

    if (entry instanceof Group)
    {
        entry = entry.entries[fetchModrm() >> 3 & 7];
        opcodeText = `${opcodeText} /${fetchModrm() >> 3 & 7}`;
    }
    if (entry === null || entry === undefined)
    {
        return refusal(eip, opcodeText, 'not in table');
    }
    if (entry === SYS)
    {
        return refusal(eip, opcodeText, 'not user mode');
    }

    // Operands, in the table's order; the modrm and its addressing bytes
    // come before any immediate whichever operand names them first, so the
    // modrm-bearing forms are resolved in a first pass.
    /** @type {Operand[]} */
    const operands = new Array(entry.forms.length);
    let memory = false;
    let mainSize = 0;
    // The forms that live in a modrm byte, and only those: a fixed segment
    // register (ES, GS) shares its first letter with the r/m and reg forms.
    const needsModrm = entry.forms.some(form=>
        /^(E[a-z]?$|G[a-z]$|M[a-z]*$|Q[a-z]$|W[a-z]+$|U[a-z]+$|N[a-z]$|V[a-z]+$|P[a-z]$|Sw$|STi$)/
            .test(form) || /^m\d/.test(form));
    if (needsModrm)
    {
        fetchModrm();
    }
    /** @type {Operand | null} */
    let rmOperand = null;
    /** @param {number} size @param {'reg' | 'mm' | 'xmm'} regKind @param {boolean} memoryOnly */
    const resolveRm = (size, regKind, memoryOnly)=>{
        const m = fetchModrm();
        if (m >= 0xc0)
        {
            if (memoryOnly)
            {
                return null;
            }
            return register(regKind, m & 7, size);
        }
        if (rmOperand === null)
        {
            rmOperand = addressSize === 32
                ? memory32(m, byte, prefixes.segment)
                : memory16(m, byte, prefixes.segment);
        }
        return { ...rmOperand, size };
    };

    for (let index = 0; index < entry.forms.length; index++)
    {
        const form = entry.forms[index];
        const sizeLetter = form.slice(1);
        /** @type {Operand | null} */
        let operand;
        // The x87 forms first: their letters collide with the segment and
        // memory forms' initials.
        if (form === 'STi')
        {
            operand = { kind: 'x87', size: 10, reg: fetchModrm() & 7 };
        }
        else if (form === 'ST' || form === 'ST0')
        {
            operand = { kind: 'x87', size: 10, reg: 0 };
        }
        else if (x87Size(form) > 0)
        {
            operand = resolveRm(x87Size(form), 'reg', true);
        }
        else if (/^[A-Z][A-Z]$|^eAX$|^1$|^Xlat$/.test(form))
        {
            // A fixed register (AL, DX, ES…): the segment names start with
            // the letters of the r/m and segment-field forms.
            operand = fixedOperand(form, operandSize, prefixes.segment, addressSize);
            if (operand === null)
            {
                throw new Error(`decoder: unknown operand form "${form}"`);
            }
        }
        else switch (form[0])
        {
            case 'E':
            case 'M':
                operand = resolveRm(gpSize(sizeLetter, operandSize), 'reg', form[0] === 'M');
                break;
            case 'G':
                operand = register('reg', fetchModrm() >> 3 & 7, gpSize(sizeLetter, operandSize));
                break;
            case 'S':
                operand = { kind: 'seg', size: 2, reg: fetchModrm() >> 3 & 7 };
                if ((operand.reg ?? 0) > 5)
                {
                    return refusal(eip, opcodeText, 'no such segment register');
                }
                break;
            case 'Z':
                operand = register('reg', zReg, gpSize(sizeLetter, operandSize));
                break;
            case 'I':
                operand = immediate(sizeLetter, operandSize, byte);
                break;
            case 'J':
            {
                const displacement = immediate(sizeLetter === 'b' ? 'bs' : 'zs', operandSize, byte);
                operand = { kind: 'rel', size: 4, target: 0 };
                // The target is relative to the end of the instruction, which
                // is known only once every byte is consumed: patched below.
                operand.value = displacement.value;
                break;
            }
            case 'O':
                operand = {
                    kind: 'mem', size: gpSize(sizeLetter, operandSize),
                    base: -1, index: -1, scale: 1,
                    disp: addressSize === 32 ? readU32(byte) : readU16(byte),
                    segment: prefixes.segment >= 0 ? prefixes.segment : 3, addressSize,
                };
                break;
            case 'X':
                operand = stringOperand(
                    6, gpSize(sizeLetter, operandSize), prefixes.segment, 3, addressSize);
                break;
            case 'Y':
                operand = stringOperand(7, gpSize(sizeLetter, operandSize), -1, 0, addressSize);
                break;
            case 'P':
                operand = register('mm', fetchModrm() >> 3 & 7, 8);
                break;
            case 'Q':
                operand = resolveRm(8, 'mm', false);
                break;
            case 'N':
                operand = resolveRm(8, 'mm', false);
                if (operand?.kind === 'mem')
                {
                    return refusal(eip, opcodeText, 'register form only');
                }
                break;
            case 'V':
                operand = register('xmm', fetchModrm() >> 3 & 7, simdSize(sizeLetter));
                break;
            case 'W':
                operand = resolveRm(simdSize(sizeLetter), 'xmm', false);
                break;
            case 'U':
                operand = resolveRm(simdSize(sizeLetter), 'xmm', false);
                if (operand?.kind === 'mem')
                {
                    return refusal(eip, opcodeText, 'register form only');
                }
                break;
            default:
                operand = fixedOperand(form, operandSize, prefixes.segment, addressSize);
                if (operand === null)
                {
                    throw new Error(`decoder: unknown operand form "${form}"`);
                }
        }
        if (operand === null)
        {
            return refusal(eip, opcodeText, 'memory form only');
        }
        if (operand.kind === 'mem')
        {
            memory = true;
        }
        // The main size follows the first operand, except a segment register:
        // `push es` moves a dword unless the prefix says a word, and
        // `mov ax, ds` writes the operand size.
        if (index === 0 && operand.kind !== 'seg')
        {
            mainSize = operand.size;
        }
        operands[index] = operand;
    }

    const length = consumed();
    for (const operand of operands)
    {
        if (operand.kind === 'rel')
        {
            operand.target = (eip + length + (operand.value ?? 0)) >>> 0;
            delete operand.value;
        }
    }
    if (prefixes.lock && !memory)
    {
        return refusal(eip, opcodeText, 'lock on a register form');
    }

    const flags = entry.flags;
    const instruction = {
        eip,
        length,
        op: entry.op,
        operands,
        size: mainSize || operandSize,
        flagsRead: flags.r | (isString(entry.op) ? DF : 0),
        flagsWritten: flags.w,
        flagsUndefined: flags.u,
        faults: entry.faults,
        memory,
        prefixes,
        opcode: opcodeText,
        ...(entry.cc === undefined ? {} : { cc: entry.cc }),
    };
    return instruction;
}

/** @param {string} op */
const isString = op=>['movs', 'cmps', 'stos', 'lods', 'scas'].includes(op);

/** @param {number} value */
const hex = value=>value.toString(16).padStart(2, '0');

/**
 * @param {'reg' | 'mm' | 'xmm'} kind @param {number} index @param {number} size
 * @returns {Operand}
 */
function register(kind, index, size){
    if (kind === 'reg' && size === 1)
    {
        return { kind, size, reg: index & 3, high: index >= 4 };
    }
    return { kind, size, reg: index };
}

/** @param {string} letter @param {number} operandSize */
function gpSize(letter, operandSize){
    switch (letter)
    {
        case 'b': return 1;
        case 'w': return 2;
        case 'd': case 'y': return 4;
        case 'q': return 8;
        case 'dq': return 16;
        case 'v': case 'z': return operandSize;
        case 'a': return operandSize * 2;
        case '': return 0;
        default: throw new Error(`decoder: unknown size letter "${letter}"`);
    }
}

/** @param {string} letter */
function simdSize(letter){
    switch (letter)
    {
        case 'ss': case 'd': return 4;
        case 'sd': case 'q': return 8;
        case 'ps': case 'pd': case 'dq': case 'x': return 16;
        default: throw new Error(`decoder: unknown SIMD size "${letter}"`);
    }
}

/** @param {string} form */
function x87Size(form){
    switch (form)
    {
        case 'm16int': case 'Mw': return 2;
        case 'm32fp': case 'm32int': return 4;
        case 'm64fp': case 'm64int': return 8;
        case 'm80fp': case 'm80bcd': return 10;
        case 'Menv': return 28;
        case 'Msave': return 108;
        default: return 0;
    }
}

/** @param {() => number} byte */
function readU16(byte){
    return byte() | byte() << 8;
}

/** @param {() => number} byte */
function readU32(byte){
    return (byte() | byte() << 8 | byte() << 16 | byte() << 24) >>> 0;
}

/**
 * @param {string} letter  b: unsigned byte; bs: sign-extended byte; w: word;
 *     z: 16/32 by operand size; zs: the same, signed; v: like z.
 * @param {number} operandSize
 * @param {() => number} byte
 * @returns {Operand}
 */
function immediate(letter, operandSize, byte){
    switch (letter)
    {
        case 'b': return { kind: 'imm', size: 1, value: byte() };
        case 'bs':
        {
            const value = byte() << 24 >> 24;
            return {
                kind: 'imm', size: operandSize,
                value: operandSize === 2 ? value & 0xffff : value >>> 0,
            };
        }
        case 'w': return { kind: 'imm', size: 2, value: readU16(byte) };
        case 'z':
        case 'v':
            return {
                kind: 'imm', size: operandSize,
                value: operandSize === 2 ? readU16(byte) : readU32(byte),
            };
        case 'zs':
            return {
                kind: 'imm', size: operandSize,
                value: operandSize === 2 ? readU16(byte) << 16 >> 16 : readU32(byte) | 0,
            };
        default: throw new Error(`decoder: unknown immediate form "${letter}"`);
    }
}

/**
 * The 32-bit modrm/SIB addressing forms.
 *
 * @param {number} modrm @param {() => number} byte @param {number} segmentOverride
 * @returns {Operand}
 */
function memory32(modrm, byte, segmentOverride){
    const mod = modrm >> 6;
    const rm = modrm & 7;
    let base = -1;
    let index = -1;
    let scale = 1;
    let disp = 0;
    if (rm === 4)
    {
        const sib = byte();
        scale = 1 << (sib >> 6);
        index = sib >> 3 & 7;
        if (index === 4)
        {
            index = -1;
        }
        base = sib & 7;
        if (base === 5 && mod === 0)
        {
            base = -1;
            disp = readU32(byte) | 0;
        }
    }
    else if (rm === 5 && mod === 0)
    {
        disp = readU32(byte) | 0;
    }
    else
    {
        base = rm;
    }
    if (mod === 1)
    {
        disp = byte() << 24 >> 24;
    }
    else if (mod === 2)
    {
        disp = readU32(byte) | 0;
    }
    // A stack-based address defaults to SS, which is flat here like DS; the
    // segment is recorded for the emitter's `fs:` folding and for a report.
    const segment = segmentOverride >= 0 ? segmentOverride : (base === 4 || base === 5 ? 2 : 3);
    return { kind: 'mem', size: 0, base, index, scale, disp, segment, addressSize: 32 };
}

/**
 * The 16-bit addressing forms an address-size prefix selects.
 *
 * @param {number} modrm @param {() => number} byte @param {number} segmentOverride
 * @returns {Operand}
 */
function memory16(modrm, byte, segmentOverride){
    const mod = modrm >> 6;
    const rm = modrm & 7;
    // [bx+si] [bx+di] [bp+si] [bp+di] [si] [di] [bp]/disp16 [bx]
    const bases = [3, 3, 5, 5, -1, -1, 5, 3];
    const indexes = [6, 7, 6, 7, 6, 7, -1, -1];
    let base = bases[rm];
    const index = indexes[rm];
    let disp = 0;
    if (mod === 0 && rm === 6)
    {
        base = -1;
        disp = readU16(byte);
    }
    else if (mod === 1)
    {
        disp = byte() << 24 >> 24;
    }
    else if (mod === 2)
    {
        disp = readU16(byte) << 16 >> 16;
    }
    const segment = segmentOverride >= 0 ? segmentOverride : (base === 5 ? 2 : 3);
    return { kind: 'mem', size: 0, base, index, scale: 1, disp, segment, addressSize: 16 };
}

/**
 * A string instruction's operand: [esi] for the source, [edi] for the
 * destination (always ES, no override).
 *
 * @param {number} reg @param {number} size @param {number} override @param {number} fallback
 * @param {16 | 32} addressSize
 * @returns {Operand}
 */
function stringOperand(reg, size, override, fallback, addressSize){
    return {
        kind: 'mem', size, base: reg, index: -1, scale: 1, disp: 0,
        segment: override >= 0 ? override : fallback, addressSize,
    };
}

/**
 * The forms that name a fixed register.
 *
 * @param {string} form @param {number} operandSize
 * @param {number} segmentOverride @param {16 | 32} addressSize
 * @returns {Operand | null}
 */
function fixedOperand(form, operandSize, segmentOverride, addressSize){
    switch (form)
    {
        case 'AL': return register('reg', 0, 1);
        case 'CL': return register('reg', 1, 1);
        case 'AX': return register('reg', 0, 2);
        case 'DX': return register('reg', 2, 2);
        case 'eAX': return register('reg', 0, operandSize);
        case '1': return { kind: 'imm', size: 1, value: 1 };
        case 'ES': case 'CS': case 'SS': case 'DS': case 'FS': case 'GS':
            return { kind: 'seg', size: 2, reg: SEGMENTS.indexOf(form.toLowerCase()) };
        case 'Xlat':
            return {
                kind: 'mem', size: 1, base: 3, index: 0, scale: 1, disp: 0,
                segment: segmentOverride >= 0 ? segmentOverride : 3, addressSize,
            };
        default:
            return null;
    }
}

export { CONDITIONS, conditionReads };
