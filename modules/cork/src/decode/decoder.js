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
 * The mode is a parameter: 32-bit, or 64-bit long mode (`MODE_64`), where a REX
 * prefix widens the operand to 64 bits and names the eight further registers,
 * the near branches and the stack operations default to 64 bits, an address is
 * 64 bits wide (32 with the address-size prefix) and may be RIP-relative, and
 * the encodings the mode dropped are #UD. Records of either mode have the same
 * shape: a 64-bit operand is size 8 and its register 0-15; an 8-byte immediate
 * carries its high half in `upper`; a RIP-relative operand has `rip` set and its
 * absolute address in `disp`.
 */

import {
    CONDITIONS, DF, Group, I, ONE_BYTE, Prefixed, SYS, TWO_BYTE, X87, conditionReads,
} from './table.js';

/** The longest an instruction may be; the processor faults past it. */
const MAX_LENGTH = 15;

/** The eight general registers by index; byte registers 4..7 are AH CH DH BH. */
export const REGISTERS = Object.freeze(['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi']);
/** The sixteen general registers of long mode by index. */
export const REGISTERS64 = Object.freeze(['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi',
    'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15']);
export const SEGMENTS = Object.freeze(['es', 'cs', 'ss', 'ds', 'fs', 'gs']);

/**
 * @typedef {Object} Operand
 * @property {'reg' | 'mem' | 'imm' | 'rel' | 'seg' | 'x87' | 'mm' | 'xmm'} kind
 * @property {number} size          in bytes (0 for a register with no data width, as
 *                                  `lea`'s source)
 * @property {number} [reg]         register index, for reg/seg/x87/mm/xmm (0-15 in long mode)
 * @property {boolean} [high]       a byte register that is the high byte (AH..BH): never
 *                                  with a REX prefix, where 4..7 are SPL, BPL, SIL, DIL
 * @property {number} [base]        mem: base register index, or -1
 * @property {number} [index]       mem: index register index, or -1
 * @property {number} [scale]       mem: 1, 2, 4 or 8
 * @property {number} [disp]        mem: signed displacement
 * @property {number} [segment]     mem: segment register index the access is relative to
 * @property {16 | 32 | 64} [addressSize]
 * @property {true} [rip]           mem: RIP-relative, `disp` already the absolute address
 * @property {number} [value]       imm: the value, sign-extended where the form says so;
 *                                  of an 8-byte immediate the low 32 bits, unsigned
 * @property {number} [upper]       imm: of an 8-byte immediate the high 32 bits, unsigned;
 *                                  mem: of a 64-bit offset (`mov al, [moffs64]`) the high
 *                                  32 bits, `disp` its low 32 unsigned
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
 *              address: boolean, rex?: number }} prefixes  `rex` in long mode: the REX
 *              byte, or 0
 * @property {number} [cc]          for jcc/setcc/cmovcc/fcmovcc
 * @property {string} opcode        the opcode bytes as text, "0f 2e", for a report
 * @property {{ name: string, address: number, length: number }} [helper]
 *           set on the instructions a call to a compiler's runtime helper is formed as (helpers.js)
 *           and on a call to an import thunk formed as the call through its slot
 * @property {number} [thunk]       that thunk's address: the call retires its jump as well
 */

/**
 * @typedef {Object} Refusal
 * @property {true} refused
 * @property {number} eip
 * @property {string} opcode
 * @property {string} reason
 * @property {boolean} invalid  the encoding is no instruction at all, and a
 *     processor raises #UD on it -- as against one this decoder does not know
 */

/**
 * The slots of the one-byte groups that name no instruction on any x86: a
 * processor raises #UD there, and a program may run one on purpose (a
 * protection's probe, a deliberate trap its own handler answers).
 */
const INVALID_SLOTS = new Set([
    ...[2, 3, 4, 5, 6, 7].map(reg=>`fe /${reg}`), 'ff /7',
    ...[1, 2, 3, 4, 5, 6, 7].flatMap(reg=>[`8f /${reg}`, `c6 /${reg}`, `c7 /${reg}`]),
]);

/** Refusals whose encoding a processor rejects with #UD whatever it supports. */
const INVALID_REASONS = new Set(['no such segment register', 'register form only',
    'memory form only', 'lock on a register form', 'not in 64-bit mode']);

/**
 * The one-byte opcodes long mode dropped: the pushes and pops of ES, CS, SS and
 * DS, the decimal adjusts, pusha/popa, bound, the 82 alias of group 1, the far
 * call and jump, les/lds (the VEX prefixes there, and this processor has no
 * AVX), into, aam/aad and salc. 40..4F are REX prefixes and 63 is movsxd.
 */
const LONG_INVALID = new Set([0x06, 0x07, 0x0e, 0x16, 0x17, 0x1e, 0x1f, 0x27, 0x2f, 0x37, 0x3f,
    0x60, 0x61, 0x62, 0x82, 0x9a, 0xc4, 0xc5, 0xce, 0xd4, 0xd5, 0xd6, 0xea]);

/**
 * In long mode, the near branches: their operand size is 64 bits whatever
 * the prefixes say (as Intel's processors decode them), and their offset
 * stays 8 or 32 bits, sign-extended.
 */
const LONG_BRANCHES = new Set(['e8', 'e9', 'eb', 'c2', 'c3', 'e0', 'e1', 'e2', 'e3', 'ff /2',
    'ff /4', ...Array.from({ length: 16 }, (_, cc)=>(0x70 + cc).toString(16)),
    ...Array.from({ length: 16 }, (_, cc)=>`0f ${(0x80 + cc).toString(16)}`)]);
/**
 * In long mode, the stack operations: 64 bits by default, 16 with the
 * operand-size prefix, never 32.
 */
const LONG_STACK = new Set(['68', '6a', '8f /0', 'ff /6', '9c', '9d', 'c8', 'c9', '0f a0', '0f a1',
    '0f a8', '0f a9', ...Array.from({ length: 16 }, (_, reg)=>(0x50 + reg).toString(16))]);

/** movsxd, which long mode puts where arpl was. */
const MOVSXD = I('movsxd', 'Gv,Ed');
/** 90 with REX.B: xchg r8, rax, no longer a nop. */
const XCHG_R8 = I('xchg', 'eAX,Zv');
/** 0F C7 /1 with REX.W: the sixteen-byte compare and exchange. */
const CMPXCHG16B = I('cmpxchg16b', 'Mdq', 'cmpxchg8b');

/**
 * What a table entry's forms need, worked out once an entry: whether they take
 * a modrm byte, and each form's size letters, x87 memory size and whether it
 * names a fixed register (AL, DX, ES…) -- the string work the operand loop
 * would otherwise do for every instruction.
 *
 * @typedef {{ needsModrm: boolean, string: boolean,
 *     forms: { form: string, first: string, letter: string, x87: number, fixed: boolean }[] }} Plan
 * @type {WeakMap<object, Plan>}
 */
const plans = new WeakMap();

/** @param {import('./table.js').Entry} entry @returns {Plan} */
function planOf(entry){
    let plan = plans.get(entry);
    if (plan === undefined)
    {
        // The forms that live in a modrm byte, and only those: a fixed segment
        // register (ES, GS) shares its first letter with the r/m and reg forms.
        const needsModrm = entry.forms.some(form=>
            /^(E[a-z]?$|G[a-z]$|M[a-z]*$|Q[a-z]$|W[a-z]+$|U[a-z]+$|N[a-z]$|V[a-z]+$|P[a-z]$|Sw$|STi$)/
                .test(form) || /^m\d/.test(form));
        plan = {
            needsModrm, string: isString(entry.op),
            forms: entry.forms.map(form=>({ form, first: form[0], letter: form.slice(1),
                x87: x87Size(form), fixed: /^[A-Z][A-Z]$|^eAX$|^1$|^Xlat$/.test(form) })),
        };
        plans.set(entry, plan);
    }
    return plan;
}

const MODE_32 = Object.freeze({ bits: /** @type {32 | 64} */ (32) });
/** Long mode, for a 64-bit program. */
export const MODE_64 = Object.freeze({ bits: /** @type {32 | 64} */ (64) });

// The instruction being decoded: whose bytes, where it starts, how far it has
// been read, its modrm byte once fetched (-1 before) and its memory operand
// once resolved. Module state rather than closures made for every instruction,
// which a region's forming decodes by the thousand.
/** @type {(address: number) => number} */
let source = ()=>0;
let origin = 0;
let cursor = 0;
let modrmByte = -1;
/** @type {Operand | null} */
let rmOperand = null;
/** Whether the instruction is decoded in long mode, and its REX byte there (0 for none). */
let long = false;
let rex = 0;

/** The instruction's next byte. @returns {number} */
function next(){
    if (cursor - origin >= MAX_LENGTH)
    {
        throw new TooLong();
    }
    return source(cursor++) & 0xff;
}

/** The modrm byte, read the first time it is asked for. */
function fetchModrm(){
    if (modrmByte < 0)
    {
        modrmByte = next();
    }
    return modrmByte;
}

/**
 * @param {(address: number) => number} read   one byte of guest memory
 * @param {number} eip
 * @param {{ bits: 32 | 64 }} [mode]
 * @returns {Instruction | Refusal}
 */
export function decode(read, eip, mode = MODE_32){
    // Put back afterwards, so a reader that decodes does not lose its own
    // instruction, and nothing holds on to this one's reader.
    const outerSource = source;
    const outerOrigin = origin;
    const outerCursor = cursor;
    const outerModrm = modrmByte;
    const outerRm = rmOperand;
    const outerLong = long;
    const outerRex = rex;
    source = read;
    origin = eip;
    cursor = eip;
    modrmByte = -1;
    rmOperand = null;
    long = mode.bits === 64;
    rex = 0;
    try
    {
        return decodeAt(eip);
    }
    catch (e){
        if (e instanceof TooLong)
        {
            return refusal(eip, '', 'longer than fifteen bytes');
        }
        throw e;
    }
    finally
    {
        source = outerSource;
        origin = outerOrigin;
        cursor = outerCursor;
        modrmByte = outerModrm;
        rmOperand = outerRm;
        long = outerLong;
        rex = outerRex;
    }
}

class TooLong extends Error {}

/** @param {number} eip @param {string} opcode @param {string} reason @returns {Refusal} */
function refusal(eip, opcode, reason){
    const invalid = INVALID_REASONS.has(reason)
        || (reason === 'not in table' && INVALID_SLOTS.has(opcode));
    return { refused: true, eip, opcode, reason, invalid };
}

/**
 * The memory operand of the modrm byte at `size`, its addressing bytes read the
 * first time; a register form's register, or null where only memory will do.
 *
 * @param {number} size @param {'reg' | 'mm' | 'xmm'} regKind @param {boolean} memoryOnly
 * @param {number} segment @param {16 | 32 | 64} addressSize
 * @returns {Operand | null}
 */
function resolveRm(size, regKind, memoryOnly, segment, addressSize){
    const m = fetchModrm();
    if (m >= 0xc0)
    {
        if (memoryOnly)
        {
            return null;
        }
        // REX.B reaches the eight further general and xmm registers, never an mm one.
        return register(regKind, m & 7 | (regKind === 'mm' ? 0 : (rex & 1) << 3), size);
    }
    if (rmOperand === null)
    {
        rmOperand = long ? memory64(m, next, segment, /** @type {32 | 64} */ (addressSize))
            : addressSize === 32 ? memory32(m, next, segment) : memory16(m, next, segment);
    }
    return { ...rmOperand, size };
}

/** `d9 c0` and the like, by x87 opcode and modrm, each made once. @type {string[]} */
const X87_TEXT = [];
/** `0f 1f` and the like, by the second byte. @type {string[]} */
const TWO_TEXT = [];
/** A group member's `81 /7`, by the opcode's text and the reg field. @type {Map<string, string[]>} */
const GROUP_TEXT = new Map();

/**
 * @param {number} eip
 * @returns {Instruction | Refusal}
 */
function decodeAt(eip){
    const prefixes = {
        lock: false, rep: false, repne: false, segment: -1, operand: false, address: false,
    };
    let opcode = next();
    // In long mode a REX byte counts only right before the opcode: a legacy
    // prefix after it voids it.
    let rexByte = 0;
    for (;;)
    {
        if (long && opcode >= 0x40 && opcode <= 0x4f)
        {
            rexByte = opcode;
        }
        else if (opcode === 0x66)
        {
            prefixes.operand = true;
            rexByte = 0;
        }
        else if (opcode === 0x67)
        {
            prefixes.address = true;
            rexByte = 0;
        }
        else if (opcode === 0xf0)
        {
            prefixes.lock = true;
            rexByte = 0;
        }
        else if (opcode === 0xf2)
        {
            prefixes.repne = true;
            prefixes.rep = false;
            rexByte = 0;
        }
        else if (opcode === 0xf3)
        {
            prefixes.rep = true;
            prefixes.repne = false;
            rexByte = 0;
        }
        else if (opcode === 0x26 || opcode === 0x2e || opcode === 0x36 || opcode === 0x3e)
        {
            // Long mode ignores the ES, CS, SS and DS overrides: every one is flat.
            if (!long)
            {
                prefixes.segment = [0x26, 0x2e, 0x36, 0x3e].indexOf(opcode);
            }
            rexByte = 0;
        }
        else if (opcode === 0x64 || opcode === 0x65)
        {
            prefixes.segment = opcode - 0x64 + 4;
            rexByte = 0;
        }
        else
        {
            break;
        }
        opcode = next();
    }

    rex = rexByte;
    if (long)
    {
        /** @type {any} */ (prefixes).rex = rexByte;
    }
    let operandSize = long && (rexByte & 8) !== 0 ? 8 : prefixes.operand ? 2 : 4;
    const addressSize = long ? (prefixes.address ? 32 : 64) : prefixes.address ? 16 : 32;
    if (long && LONG_INVALID.has(opcode))
    {
        return refusal(eip, hex(opcode), 'not in 64-bit mode');
    }

    /** @type {import('./table.js').Entry | Group | Prefixed | typeof SYS | null} */
    let entry;
    let opcodeText;
    // The register an opcode's low three bits name (`inc eax` is 0x40+0),
    // taken from the last opcode byte -- the second one in the 0F map.
    let zReg = opcode & 7 | (rexByte & 1) << 3;
    if (opcode >= 0xd8 && opcode <= 0xdf)
    {
        const map = X87[opcode - 0xd8];
        const m = fetchModrm();
        entry = m < 0xc0 ? map.mem[m >> 3 & 7] : (map.reg[m] ?? null);
        opcodeText = X87_TEXT[(opcode - 0xd8) << 8 | m] ??= `${hex(opcode)} ${hex(m)}`;
    }
    else if (opcode === 0x0f)
    {
        const second = next();
        zReg = second & 7 | (rexByte & 1) << 3;
        opcodeText = TWO_TEXT[second] ??= `0f ${hex(second)}`;
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
        entry = long && opcode === 0x63 ? MOVSXD
            : long && opcode === 0x90 && (rexByte & 1) !== 0 && !prefixes.rep ? XCHG_R8
                : ONE_BYTE[opcode];
        opcodeText = hex(opcode);
    }

    if (entry instanceof Group)
    {
        const reg = fetchModrm() >> 3 & 7;
        entry = entry.entries[reg];
        let texts = GROUP_TEXT.get(opcodeText);
        if (texts === undefined)
        {
            texts = [];
            GROUP_TEXT.set(opcodeText, texts);
        }
        opcodeText = texts[reg] ??= `${opcodeText} /${reg}`;
    }
    if (entry === null || entry === undefined)
    {
        return refusal(eip, opcodeText, 'not in table');
    }
    if (entry === SYS)
    {
        return refusal(eip, opcodeText, 'not user mode');
    }
    if (long)
    {
        if (LONG_BRANCHES.has(opcodeText))
        {
            operandSize = 8;
        }
        else if (LONG_STACK.has(opcodeText))
        {
            operandSize = prefixes.operand ? 2 : 8;
        }
        else if (opcodeText === '0f c7 /1' && (rexByte & 8) !== 0)
        {
            entry = CMPXCHG16B;
        }
    }

    // Operands, in the table's order; the modrm and its addressing bytes
    // come before any immediate whichever operand names them first, so the
    // modrm-bearing forms are resolved in a first pass.
    /** @type {Operand[]} */
    const operands = new Array(entry.forms.length);
    let memory = false;
    let mainSize = 0;
    const plan = planOf(entry);
    if (plan.needsModrm)
    {
        fetchModrm();
    }
    const segment = prefixes.segment;
    /** A relative operand's displacement, until the instruction's end is known. */
    let relative = 0;

    for (let index = 0; index < plan.forms.length; index++)
    {
        const { form, first, letter: sizeLetter, x87, fixed } = plan.forms[index];
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
        else if (x87 > 0)
        {
            operand = resolveRm(x87, 'reg', true, segment, addressSize);
        }
        else if (fixed)
        {
            // A fixed register (AL, DX, ES…): the segment names start with
            // the letters of the r/m and segment-field forms.
            operand = fixedOperand(form, operandSize, prefixes.segment, addressSize);
            if (operand === null)
            {
                throw new Error(`decoder: unknown operand form "${form}"`);
            }
        }
        else switch (first)
        {
            case 'E':
            case 'M':
                operand = resolveRm(gpSize(sizeLetter, operandSize), 'reg', first === 'M', segment,
                    addressSize);
                break;
            case 'G':
                operand = register('reg', fetchModrm() >> 3 & 7 | (rexByte & 4) << 1,
                    gpSize(sizeLetter, operandSize));
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
                operand = immediate(sizeLetter, operandSize, next);
                break;
            case 'J':
            {
                const displacement = immediate(sizeLetter === 'b' ? 'bs' : 'zs',
                    long ? 4 : operandSize, next);
                operand = { kind: 'rel', size: long ? 8 : 4, target: 0 };
                // The target is relative to the end of the instruction, which
                // is known only once every byte is consumed: patched below.
                // Signed in long mode, where the target is not taken mod 2^32.
                relative = long ? /** @type {number} */ (displacement.value) | 0
                    : /** @type {number} */ (displacement.value);
                break;
            }
            case 'O':
                operand = {
                    kind: 'mem', size: gpSize(sizeLetter, operandSize),
                    base: -1, index: -1, scale: 1,
                    disp: addressSize === 32 || addressSize === 64 ? readU32(next) : readU16(next),
                    segment: prefixes.segment >= 0 ? prefixes.segment : 3, addressSize,
                };
                // A 64-bit offset's high half apart (`upper`), as an 8-byte immediate's is.
                if (addressSize === 64)
                {
                    operand.upper = readU32(next);
                }
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
                operand = resolveRm(8, 'mm', false, segment, addressSize);
                break;
            case 'N':
                operand = resolveRm(8, 'mm', false, segment, addressSize);
                if (operand?.kind === 'mem')
                {
                    return refusal(eip, opcodeText, 'register form only');
                }
                break;
            case 'V':
                operand = register('xmm', fetchModrm() >> 3 & 7 | (rexByte & 4) << 1,
                    simdSize(sizeLetter));
                break;
            case 'W':
                operand = resolveRm(simdSize(sizeLetter), 'xmm', false, segment, addressSize);
                break;
            case 'U':
                operand = resolveRm(simdSize(sizeLetter), 'xmm', false, segment, addressSize);
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

    const length = cursor - eip;
    for (const operand of operands)
    {
        if (operand.kind === 'rel')
        {
            operand.target = long ? eip + length + relative : (eip + length + relative) >>> 0;
        }
        else if (operand.rip)
        {
            const target = eip + length + /** @type {number} */ (operand.disp);
            operand.disp = addressSize === 32 ? target >>> 0 : target;
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
        flagsRead: flags.r | (plan.string ? DF : 0),
        flagsWritten: flags.w,
        flagsUndefined: flags.u,
        faults: entry.faults,
        memory,
        prefixes,
        opcode: opcodeText,
    };
    if (entry.cc !== undefined)
    {
        /** @type {Instruction} */ (instruction).cc = entry.cc;
    }
    return instruction;
}

const STRING_OPS = new Set(['movs', 'cmps', 'stos', 'lods', 'scas']);
/** @param {string} op */
const isString = op=>STRING_OPS.has(op);

/**
 * Whether an opcode text (`Instruction.opcode`) is an x87 one: an escape byte
 * d8..df with its modrm (`d9 c0`), or the wait (`9b`) -- what
 * `/^(9b$|d[89a-f] )/` answers, without a regular expression on every
 * instruction the emitter and the planner ask about.
 *
 * @param {string} text
 */
export function isX87Opcode(text){
    if (text.length <= 2)
    {
        return text === '9b';
    }
    const second = text.charCodeAt(1);
    return text.charCodeAt(0) === 0x64 && text.charCodeAt(2) === 0x20
        && (second === 0x38 || second === 0x39 || (second >= 0x61 && second <= 0x66));
}

/** Every byte as two hex digits, for the opcode text a record carries. */
const HEX = Array.from({ length: 256 }, (_, value)=>value.toString(16).padStart(2, '0'));
/** @param {number} value */
const hex = value=>HEX[value];

/**
 * @param {'reg' | 'mm' | 'xmm'} kind @param {number} index @param {number} size
 * @returns {Operand}
 */
function register(kind, index, size){
    if (kind === 'reg' && size === 1)
    {
        // With any REX prefix, 4..7 are the low bytes of SP, BP, SI and DI.
        return rex !== 0 ? { kind, size, reg: index, high: false }
            : { kind, size, reg: index & 3, high: index >= 4 };
    }
    return { kind, size, reg: index };
}

/** @param {string} letter @param {number} operandSize */
function gpSize(letter, operandSize){
    switch (letter)
    {
        case 'b': return 1;
        case 'w': return 2;
        case 'd': return 4;
        // A dword, or a qword with REX.W.
        case 'y': return operandSize === 8 ? 8 : 4;
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
            if (operandSize === 8)
            {
                return {
                    kind: 'imm', size: 8, value: value >>> 0, upper: value < 0 ? 0xffffffff : 0,
                };
            }
            return {
                kind: 'imm', size: operandSize,
                value: operandSize === 2 ? value & 0xffff : value >>> 0,
            };
        }
        case 'w': return { kind: 'imm', size: 2, value: readU16(byte) };
        case 'z':
        case 'v':
            if (operandSize === 8)
            {
                // `Iv` is the one 8-byte immediate (mov r64, imm64); `Iz`
                // stays four bytes, sign-extended.
                if (letter === 'v')
                {
                    const low = readU32(byte);
                    return { kind: 'imm', size: 8, value: low, upper: readU32(byte) };
                }
                const value = readU32(byte) | 0;
                return {
                    kind: 'imm', size: 8, value: value >>> 0, upper: value < 0 ? 0xffffffff : 0,
                };
            }
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
 * Long mode's modrm/SIB forms: REX.B and REX.X reach the further registers,
 * `mod 00 rm 101` is RIP-relative (its `disp` made absolute once the
 * instruction's length is known), and a SIB base of 101 under `mod 00` is a
 * bare disp32 whatever REX.B says, as is an index of 100 no index, whatever
 * REX.X says not. The address is 64 bits, or 32 with the address-size prefix.
 *
 * @param {number} modrm @param {() => number} byte @param {number} segmentOverride
 * @param {32 | 64} addressSize
 * @returns {Operand}
 */
function memory64(modrm, byte, segmentOverride, addressSize){
    const mod = modrm >> 6;
    const rm = modrm & 7;
    const extendBase = (rex & 1) << 3;
    let base = -1;
    let index = -1;
    let scale = 1;
    let disp = 0;
    let rip = false;
    if (rm === 4)
    {
        const sib = byte();
        scale = 1 << (sib >> 6);
        index = sib >> 3 & 7 | (rex & 2) << 2;
        if (index === 4)
        {
            index = -1;
        }
        base = sib & 7 | extendBase;
        if ((sib & 7) === 5 && mod === 0)
        {
            base = -1;
            disp = readU32(byte) | 0;
        }
    }
    else if (rm === 5 && mod === 0)
    {
        rip = true;
        disp = readU32(byte) | 0;
    }
    else
    {
        base = rm | extendBase;
    }
    if (mod === 1)
    {
        disp = byte() << 24 >> 24;
    }
    else if (mod === 2)
    {
        disp = readU32(byte) | 0;
    }
    const segment = segmentOverride >= 0 ? segmentOverride : (base === 4 || base === 5 ? 2 : 3);
    /** @type {Operand} */
    const operand = { kind: 'mem', size: 0, base, index, scale, disp, segment, addressSize };
    if (rip)
    {
        operand.rip = true;
    }
    return operand;
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
 * @param {16 | 32 | 64} addressSize
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
 * @param {number} segmentOverride @param {16 | 32 | 64} addressSize
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
