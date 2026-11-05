/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Which instruction set extensions a stretch of x86 code uses, by its bytes:
 * the encodings the engine executes and the ones it answers #UD to (VEX, EVEX,
 * XOP, the AES/SHA/ADX/PCLMULQDQ opcodes), each counted, with the instructions
 * a program uses to choose between code paths (cpuid, xgetbv) counted beside
 * them. Lengths and the extension come from the encoding as the Intel SDM
 * (volume 2, chapters 2 and 3, appendix A) and AMD's manual (volume 3, XOP)
 * lay it out; everything else is decoded by cork's own decoder, which is the
 * engine's view of what runs.
 *
 * Code is followed from where it is known to start along its branches
 * (`walk`), never read straight through: compilers keep data among a
 * function's instructions.
 */
import { MODE_64, decode } from '../modules/cork/src/decode/decoder.js';

/**
 * The extensions the engine translates, as its cpuid persona (a Nehalem)
 * announces them, and those it does not, which a processor of that class
 * answers #UD to. LZCNT and TZCNT are neither: their encodings are BSR and BSF
 * with a REP prefix, which a processor without them executes as BSR and BSF
 * (the same answer for TZCNT unless the source is zero; another one for
 * LZCNT), so they run, and run differently.
 */
export const EXECUTED = Object.freeze(['SSE3', 'SSSE3', 'SSE4.1', 'SSE4.2', 'POPCNT', 'MOVBE',
    'RDRAND']);
export const MISSING = Object.freeze(['AVX', 'AVX2', 'FMA', 'F16C', 'BMI1', 'BMI2', 'AVX-512',
    'XOP', 'AES', 'PCLMULQDQ', 'SHA', 'ADX', 'GFNI', 'XSAVE']);
export const DIFFERENT = Object.freeze(['LZCNT', 'TZCNT']);
/** What a program asks before it picks a path, counted where it stands. */
export const PROBES = Object.freeze(['cpuid', 'xgetbv']);

const SEGMENT_PREFIXES = new Set([0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65]);

/** SSE3's instructions as cork names them (the rest of its encodings share SSE2's maps). */
const SSE3 = new Set(['addsubps', 'addsubpd', 'haddps', 'haddpd', 'hsubps', 'hsubpd', 'lddqu',
    'movddup', 'movshdup', 'movsldup', 'fisttp']);

/**
 * The length of a modrm byte and what follows it for an address, from the
 * modrm byte at `at`; -1 past the end.
 *
 * @param {(address: number) => number} read @param {number} at
 * @param {32 | 64} bits @param {boolean} short  a 0x67 prefix: 16-bit addresses in 32-bit code
 */
function addressLength(read, at, bits, short){
    const modrm = read(at);
    const mod = modrm >> 6;
    const rm = modrm & 7;
    if (mod === 3)
    {
        return 1;
    }
    if (short && bits === 32)
    {
        return 1 + (mod === 1 ? 1 : mod === 2 || mod === 0 && rm === 6 ? 2 : 0);
    }
    let length = 1;
    let base = rm;
    if (rm === 4)
    {
        length++;
        base = read(at + 1) & 7;
    }
    if (mod === 1)
    {
        return length + 1;
    }
    if (mod === 2 || mod === 0 && (rm === 5 || rm === 4 && base === 5))
    {
        return length + 4;
    }
    return length;
}

/**
 * The extension of a VEX-encoded instruction (Intel SDM vol. 2, chapter 5
 * and appendix A), by map, opcode, implied prefix (`pp`: 0 none, 1 66, 2 F3,
 * 3 F2) and vector length.
 *
 * @param {number} map @param {number} opcode @param {number} pp @param {boolean} wide  VEX.L
 */
function vexExtension(map, opcode, pp, wide){
    if (map === 2)
    {
        if (opcode >= 0x96 && opcode <= 0xbf && (opcode & 0xf) >= 6)
        {
            return 'FMA';
        }
        if (opcode === 0xf2 || opcode === 0xf3 || opcode === 0xf7 && pp === 0)
        {
            return 'BMI1';
        }
        if (opcode === 0xf5 || opcode === 0xf6 || opcode === 0xf7)
        {
            return 'BMI2';
        }
        if (opcode === 0x13)
        {
            return 'F16C';
        }
        if ([0x16, 0x36, 0x45, 0x46, 0x47, 0x58, 0x59, 0x5a, 0x78, 0x79, 0x8c, 0x8e, 0x90, 0x91,
            0x92, 0x93].includes(opcode))
        {
            return 'AVX2';
        }
        // The integer forms of SSSE3 and SSE4.1 widened to 256 bits.
        const integer = opcode <= 0x0b || opcode >= 0x1c && opcode <= 0x1e
            || opcode >= 0x20 && opcode <= 0x2b || opcode >= 0x30 && opcode <= 0x40;
        return wide && integer && pp === 1 ? 'AVX2' : 'AVX';
    }
    if (map === 3)
    {
        if (opcode === 0xf0)
        {
            return 'BMI2';
        }
        if (opcode === 0x1d)
        {
            return 'F16C';
        }
        if ([0x00, 0x01, 0x02, 0x38, 0x39, 0x46].includes(opcode))
        {
            return 'AVX2';
        }
        const integer = [0x0e, 0x0f, 0x42, 0x4c].includes(opcode);
        return wide && integer ? 'AVX2' : 'AVX';
    }
    // Map 1: the packed integer forms widened to 256 bits are AVX2's; moves,
    // floating point and the 128-bit forms are AVX's.
    const integer = pp === 1 && (opcode >= 0x60 && opcode <= 0x6d
        || opcode >= 0x70 && opcode <= 0x76
        || opcode >= 0xd1 && opcode <= 0xfe && ![0xd6, 0xe6, 0xe7].includes(opcode));
    return wide && integer ? 'AVX2' : 'AVX';
}

/**
 * The extension and length of a non-VEX 0f 38 / 0f 3a instruction, whose
 * opcode byte is at `at` (Intel SDM vol. 2, tables A-4 and A-5).
 *
 * @param {(address: number) => number} read @param {number} at
 * @param {0x38 | 0x3a} map @param {number} mandatory  0, 0x66, 0xf2 or 0xf3
 * @param {32 | 64} bits @param {boolean} short
 * @returns {{ extension: string | null, length: number }}
 */
function threeByte(read, at, map, mandatory, bits, short){
    const opcode = read(at);
    const length = 1 + addressLength(read, at + 1, bits, short) + (map === 0x3a ? 1 : 0);
    if (map === 0x38)
    {
        if (opcode <= 0x0b || opcode >= 0x1c && opcode <= 0x1e)
        {
            return { extension: 'SSSE3', length };
        }
        if (opcode === 0x37)
        {
            return { extension: 'SSE4.2', length };
        }
        if (opcode >= 0xc8 && opcode <= 0xcd)
        {
            return { extension: 'SHA', length };
        }
        if (opcode === 0xcf)
        {
            return { extension: 'GFNI', length };
        }
        if (opcode >= 0xdb && opcode <= 0xdf)
        {
            return { extension: 'AES', length };
        }
        if (opcode === 0xf0 || opcode === 0xf1)
        {
            return { extension: mandatory === 0xf2 ? 'SSE4.2' : 'MOVBE', length };
        }
        if (opcode === 0xf6 && (mandatory === 0x66 || mandatory === 0xf3))
        {
            return { extension: 'ADX', length };
        }
        if (opcode >= 0x10 && opcode <= 0x41 && mandatory === 0x66)
        {
            return { extension: 'SSE4.1', length };
        }
        return { extension: null, length };
    }
    if (opcode === 0x0f)
    {
        return { extension: 'SSSE3', length };
    }
    if (opcode >= 0x60 && opcode <= 0x63)
    {
        return { extension: 'SSE4.2', length };
    }
    if (opcode === 0x44)
    {
        return { extension: 'PCLMULQDQ', length };
    }
    if (opcode === 0xcc)
    {
        return { extension: 'SHA', length };
    }
    if (opcode === 0xce || opcode === 0xcf)
    {
        return { extension: 'GFNI', length };
    }
    if (opcode === 0xdf)
    {
        return { extension: 'AES', length };
    }
    if (opcode >= 0x08 && opcode <= 0x22 || opcode >= 0x40 && opcode <= 0x42)
    {
        return { extension: 'SSE4.1', length };
    }
    return { extension: null, length };
}

/**
 * One instruction at `at`: its length and what it is counted as (an
 * extension, a probe, or null for the base set).
 *
 * @param {(address: number) => number} read @param {number} at @param {32 | 64} bits
 * @returns {Classified}
 */
export function classify(read, at, bits){
    let cursor = at;
    let mandatory = 0;
    let short = false;
    for (let i = 0; i < 14; i++)
    {
        const b = read(cursor);
        if (b === 0x66 || b === 0xf2 || b === 0xf3)
        {
            mandatory = b;
        }
        else if (b === 0x67)
        {
            short = true;
        }
        else if (!(b === 0xf0 || SEGMENT_PREFIXES.has(b)))
        {
            break;
        }
        cursor++;
    }
    if (bits === 64 && (read(cursor) & 0xf0) === 0x40)
    {
        cursor++;
    }
    const first = read(cursor);
    const second = read(cursor + 1);
    // C4, C5 and 62 are LES, LDS and BOUND in 32-bit code unless the next byte
    // would be a register modrm, which those take no form of.
    const prefixed = bits === 64 || second >= 0xc0;
    if (first === 0xc5 && prefixed)
    {
        const opcode = read(cursor + 2);
        // vzeroupper and vzeroall (77) are the one VEX form without a modrm byte.
        const length = cursor + 3 - at + (opcode === 0x77 ? 0
            : addressLength(read, cursor + 3, bits, short) + (vexImmediate(1, opcode) ? 1 : 0));
        return { length, extension: vexExtension(1, opcode, second & 3, (second & 4) !== 0) };
    }
    if (first === 0xc4 && prefixed)
    {
        const map = second & 0x1f;
        const third = read(cursor + 2);
        const opcode = read(cursor + 3);
        const length = cursor + 4 - at + (map === 1 && opcode === 0x77 ? 0
            : addressLength(read, cursor + 4, bits, short)
                + (map === 3 || map === 1 && vexImmediate(1, opcode) ? 1 : 0));
        return { length, extension: vexExtension(map, opcode, third & 3, (third & 4) !== 0) };
    }
    if (first === 0x62 && prefixed)
    {
        const map = second & 7;
        const opcode = read(cursor + 4);
        // A compressed displacement is one byte like any disp8: the length is
        // the same; only its scale differs.
        let length = cursor + 5 - at + addressLength(read, cursor + 5, bits, short);
        if (map === 3 || map === 1 && vexImmediate(1, opcode))
        {
            length++;
        }
        return { length, extension: 'AVX-512' };
    }
    if (first === 0x8f && (second & 0x1f) >= 8 && prefixed)
    {
        const map = second & 0x1f;
        const length = cursor + 4 - at + addressLength(read, cursor + 4, bits, short)
            + (map === 8 || map === 0xa ? (map === 0xa ? 4 : 1) : 0);
        return { length, extension: 'XOP' };
    }
    if (first === 0x0f && (second === 0x38 || second === 0x3a))
    {
        const found = threeByte(read, cursor + 2, second, mandatory, bits, short);
        return { length: cursor + 2 - at + found.length, extension: found.extension };
    }
    if (first === 0x0f && second === 0x01 && read(cursor + 2) === 0xd0)
    {
        return { length: cursor + 3 - at, extension: 'xgetbv' };
    }
    if (first === 0x0f && second === 0xae && read(cursor + 2) < 0xc0
        && [4, 5, 6].includes(read(cursor + 2) >> 3 & 7) && mandatory === 0)
    {
        return { length: cursor + 2 - at + addressLength(read, cursor + 2, bits, short),
            extension: 'XSAVE' };
    }
    if (first === 0x0f && second === 0xc7 && read(cursor + 2) < 0xc0
        && [3, 4, 5].includes(read(cursor + 2) >> 3 & 7))
    {
        return { length: cursor + 2 - at + addressLength(read, cursor + 2, bits, short),
            extension: 'XSAVE' };
    }
    const instruction = decode(read, at, bits === 64 ? MODE_64 : undefined);
    if ('refused' in instruction)
    {
        return { length: 1, extension: null, refused: instruction.opcode || 'unknown' };
    }
    /** @type {string | null} */
    let extension = null;
    const [operand] = instruction.operands;
    const op = instruction.op;
    /** @type {Classified['flow']} */
    const flow = {
        target: operand?.kind === 'rel' ? operand.target : undefined,
        ends: op === 'jmp' || op === 'ret' || op === 'retf' || op === 'iret'
            || instruction.faults === 'invalid' || instruction.faults === 'halt'
            || instruction.faults === 'trap',
    };
    if (instruction.op === 'cpuid')
    {
        extension = 'cpuid';
    }
    else if (instruction.op === 'popcnt')
    {
        extension = 'POPCNT';
    }
    else if (instruction.op === 'rdrand')
    {
        extension = 'RDRAND';
    }
    else if (mandatory === 0xf3 && first === 0x0f && (second === 0xbd || second === 0xbc))
    {
        extension = second === 0xbd ? 'LZCNT' : 'TZCNT';
    }
    else if (SSE3.has(instruction.op))
    {
        extension = 'SSE3';
    }
    return { length: instruction.length, extension, flow };
}

/**
 * @typedef {Object} Classified
 * @property {number} length
 * @property {string | null} extension  the extension or probe it counts as, null for the base set
 * @property {string} [refused]         the opcode cork's decoder does not take
 * @property {{ target?: number, ends: boolean }} [flow]  a branch's target, and whether
 *           the next instruction is not reached from this one (a jump, a return, a trap)
 */

/**
 * Whether a VEX map 1 opcode carries an 8-bit immediate (Intel SDM vol. 2,
 * table A-3: pshufd and the shifts by immediate, cmpps, pinsrw, pextrw, shufps).
 *
 * @param {number} map @param {number} opcode
 */
function vexImmediate(map, opcode){
    return map === 1 && [0x70, 0x71, 0x72, 0x73, 0xc2, 0xc4, 0xc5, 0xc6].includes(opcode);
}

/**
 * @typedef {Object} Scan
 * @property {number} instructions   how many were read
 * @property {number} bytes          how many bytes of code they cover
 * @property {Map<string, number>} counts         instructions by extension or probe
 * @property {Map<string, number>} refused        where a path met an opcode cork does not
 *           decode, by opcode
 */

/**
 * Follows the code of each group from its starts along every way an
 * instruction leads on (the next instruction, a direct branch's target),
 * inside the group's bounds, and counts what it meets. A path stops at an
 * unconditional jump, a return, a trap, an instruction the engine faults on
 * and anything cork does not decode; an indirect jump's targets (a switch's
 * table) are not followed. Data a function keeps between its instructions is
 * so never read as code.
 *
 * @param {(address: number) => number} read
 * @param {{ starts: number[], within: (address: number) => boolean }[]} groups
 * @param {32 | 64} bits
 * @param {(extension: string, group: number) => void} [seen]  told each extension's
 *        first instruction in each group
 * @returns {Scan}
 */
export function walk(read, groups, bits, seen = ()=>{}){
    /** @type {Scan} */
    const scan = { instructions: 0, bytes: 0, counts: new Map(), refused: new Map() };
    /** @type {Set<number>} */
    const visited = new Set();
    groups.forEach(({ starts, within }, group)=>{
        /** @type {Set<string>} */
        const here = new Set();
        const pending = starts.filter(within);
        while (pending.length > 0)
        {
            let at = /** @type {number} */ (pending.pop());
            while (within(at) && !visited.has(at))
            {
                visited.add(at);
                const found = classify(read, at, bits);
                if (found.refused !== undefined)
                {
                    scan.refused.set(found.refused, (scan.refused.get(found.refused) ?? 0) + 1);
                    break;
                }
                scan.instructions++;
                scan.bytes += found.length;
                if (found.extension !== null)
                {
                    scan.counts.set(found.extension, (scan.counts.get(found.extension) ?? 0) + 1);
                    if (!here.has(found.extension))
                    {
                        here.add(found.extension);
                        seen(found.extension, group);
                    }
                }
                if (found.flow?.target !== undefined && within(found.flow.target))
                {
                    pending.push(found.flow.target);
                }
                if (found.flow?.ends)
                {
                    break;
                }
                at += found.length;
            }
        }
    });
    return scan;
}
