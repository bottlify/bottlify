/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The 32-bit corpus: random i386 instruction sequences run on this
 * processor, with what they did, for cork's interpreters and translated code
 * to be judged by (`modules/cork/src/testing/x86-corpus.js`).
 *
 *   node tools/x86-corpus.mjs [cases] [seed] [out]
 *
 * Each case is one to a few instructions drawn from templates written from the
 * Intel SDM for the 32-bit set cork models and its `cpuid` advertises: the
 * integer set at every width with register and memory forms, the addressing
 * forms, decimal adjusts, strings with and without a repeat, the stack, flags,
 * bits, shifts, multiplies and divides (faulting ones too), conditional
 * moves, sets and jumps, loops and calls inside the case, the exchanges, x87,
 * MMX, SSE, SSE2, SSE3, and encodings that are no instruction (#UD). The
 * state starts at random: the registers (some pointing into the case's 8 KiB
 * buffer at DATA_AT, one a small index, ESP near the buffer's end), EFLAGS,
 * the x87 stack with its tags, control and status words, the MMX and XMM
 * registers and MXCSR; the buffer is filled from the case's seed.
 *
 * The runner (`x86-corpus/runner32.c`, a freestanding static i386 program
 * built here with clang and lld) runs every case twice: once for what it did
 * -- the registers, EFLAGS, the fxsave image with every x87 register bit for
 * bit, the full tag word, the buffer's changed bytes, or the fault and its
 * vector with the registers before it -- and once single-stepped, for the
 * instructions it ran. Each of those is decoded here (cork's decoder, whose
 * flag classes are the SDM's) to know which EFLAGS bits and which x87
 * condition codes the case leaves undefined; a case that reads a flag an
 * earlier instruction left undefined is drawn again.
 *
 * The x87 registers in cork are doubles, by design. Where the processor keeps
 * more than a double can (a 64-bit integer, the constants, transcendental
 * results, precision control at 64 bits, an exponent past a double's), the
 * case ends with that value or stores it in a form a double rounds alike:
 * such a value meets no further arithmetic and no 80-bit store. Rounding
 * control other than nearest is drawn only where cork follows it (the
 * integer roundings, and MXCSR's for the conversions to integers); its
 * arithmetic rounds to nearest whatever the control word says.
 *
 * Needs an x86-64 Linux host that runs i386 programs, with clang, ld.lld,
 * llvm-mc and llvm-objcopy. Writes `modules/cork/src/x86-corpus.json.gz`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { decode, isX87Opcode } from '../modules/cork/src/decode/decoder.js';
import { CF, DF, OF, ZF } from '../modules/cork/src/decode/table.js';
import { CORPUS_LAYOUT, X87_STATUS, fillData, statusAfter } from
    '../modules/cork/src/testing/x86-corpus.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CASES = Number(process.argv[2] ?? 16000);
const SEED = Number(process.argv[3] ?? 0x86c0de) >>> 0 || 1;
const OUT = process.argv[4] ?? join(ROOT, 'modules/cork/src/x86-corpus.json.gz');
if (platform() !== 'linux' || arch() !== 'x64')
{
    console.error('the corpus runs natively: an x86-64 Linux host that runs i386 code is needed');
    process.exit(1);
}
const { CODE_AT, DATA_AT, DATA_SIZE } = CORPUS_LAYOUT;
const started = Date.now();
const work = mkdtempSync(join(tmpdir(), 'x86-corpus-'));

let state = SEED;
/** xorshift32 for the cases themselves. */
function random(){
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
}
/** @param {number} n */
const below = n=>random() % n;
/** @template T @param {readonly T[]} list @returns {T} */
const pick = list=>list[below(list.length)];
/** @param {number} n */
const chance = n=>below(n) === 0;

const R32 = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
const R16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'];
const R8 = ['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh'];
const PTR = /** @type {Record<number, string>} */ ({ 1: 'byte', 2: 'word', 4: 'dword', 8: 'qword',
    10: 'tbyte', 16: 'xmmword' });
const CONDITIONS = ['o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge',
    'le', 'g'];
const SEGMENTS = ['es', 'cs', 'ss', 'ds'];

/** A 32-bit value of the kinds that find edges: carries, signs, zero, all ones. */
function interesting(){
    switch (below(12))
    {
        case 0: return 0;
        case 1: return pick([1, 2, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xffff]);
        case 2: return pick([0x7fffffff, 0x80000000, 0xffffffff, 0xfffffffe, 0x80000001]);
        case 3: return below(64);
        case 4: return (0x100000000 - 1 - below(64)) >>> 0;
        case 5: return (random() & 0xff) * 0x01010101 >>> 0;
        default: return random();
    }
}

/**
 * The registers' roles in one case: ESP the stack; pointers into the buffer,
 * which memory operands use as bases; at most one small index; the rest data,
 * the only registers a template writes but where it makes a role of its own
 * (a string's ESI and EDI, ENTER's EBP).
 */
class Roles {
    constructor(){
        this.pointers = new Set();
        /** @type {number} */
        this.index = -1;
        const candidates = [3, 5, 6, 7];
        const count = 1 + below(3);
        for (let i = 0; i < count; i++)
        {
            this.pointers.add(candidates.splice(below(candidates.length), 1)[0]);
        }
        if (candidates.length > 0 && !chance(4))
        {
            this.index = candidates.splice(below(candidates.length), 1)[0];
        }
    }

    /** The registers a template may write. */
    data(){
        return [0, 1, 2, 3, 5, 6, 7].filter(r=>!this.pointers.has(r) && r !== this.index);
    }

    /** @param {number} r */
    makePointer(r){
        this.pointers.add(r);
        if (this.index === r)
        {
            this.index = -1;
        }
    }
}

/** Operands for one case's templates, over its roles. */
class Operands {
    /** @param {Roles} roles */
    constructor(roles){
        this.roles = roles;
    }

    /** A data register of `size` bytes. @param {number} size */
    reg(size){
        const data = this.roles.data();
        if (size === 1)
        {
            const bytes = data.filter(r=>r < 4).flatMap(r=>[r, r + 4]);
            return R8[pick(bytes.length > 0 ? bytes : [0])];
        }
        return (size === 2 ? R16 : R32)[pick(data)];
    }

    /** Any register of `size` bytes, to read. @param {number} size */
    src(size){
        if (size === 1)
        {
            return R8[below(8)];
        }
        return (size === 2 ? R16 : R32)[below(8)];
    }

    /**
     * A data register of `size` bytes other than those of `not` (by number),
     * for a template whose implicit operands they are.
     *
     * @param {number} size @param {number[]} not
     */
    regExcept(size, not){
        for (;;)
        {
            const name = this.reg(size);
            const number = (size === 1 ? R8 : size === 2 ? R16 : R32).indexOf(name) & (size === 1
                ? 3 : 7);
            if (!not.includes(number))
            {
                return name;
            }
        }
    }

    /** A register or the registers' source, mostly the data ones. @param {number} size */
    any(size){
        return chance(3) ? this.src(size) : this.reg(size);
    }

    /** A pointer register's name. */
    base(){
        return R32[pick([...this.roles.pointers])];
    }

    /**
     * An address in the buffer, in one of the forms the ModRM and SIB bytes
     * encode: a base alone or with a displacement of 8 or 32 bits, a scaled
     * index, an index with no base, an absolute address, ESP and EBP as bases.
     * An aligned access takes no index (the index is any small number) and no
     * ESP (which is aligned to four).
     *
     * @param {number} [align]  the access's alignment; 1 for none
     */
    address(align = 1){
        const index = this.roles.index >= 0 && align === 1 ? R32[this.roles.index] : null;
        const small = ()=>(below(32) * 4 - 64) & ~(align - 1);
        const large = ()=>(below(0x80) * 4 - 0x100) & ~(align - 1);
        const absolute = ()=>DATA_AT + 0x400 + below(0x1000 / align) * align;
        const disp = (/** @type {number} */ value)=>value < 0 ? ` - ${-value}` : ` + ${value}`;
        const scale = pick([1, 2, 4, 8]);
        switch (below(12))
        {
            case 0: return `[${this.base()}]`;
            case 1: case 2: return `[${this.base()}${disp(small())}]`;
            case 3: return `[${this.base()}${disp(large())}]`;
            case 4: case 5:
                if (index)
                {
                    return `[${this.base()} + ${scale}*${index}${pick(['', disp(small()),
                        disp(large())])}]`;
                }
                return `[${this.base()}${disp(small())}]`;
            // A SIB byte with no index under a scale: the assembler writes it for EIZ.
            case 10: return `[${this.base()} + eiz*${scale}${pick(['', disp(small()),
                disp(large())])}]`;
            case 6:
                return index ? `[${scale}*${index} + ${absolute()}]` : `[${absolute()}]`;
            case 7: return `[${absolute()}]`;
            case 8:
                // ESP's own forms need a SIB byte; what lies above it is the buffer.
                if (align > 4)
                {
                    return `[${this.base()}]`;
                }
                return `[esp${chance(2) ? '' : disp(below(16) * 16)}]`;
            default:
                if (index)
                {
                    return `[${this.base()} + ${index}${disp(large())}]`;
                }
                return `[${this.base()}${disp(large())}]`;
        }
    }

    /**
     * A memory operand of `size` bytes, now and then with a segment override:
     * not CS, which a store through faults on.
     *
     * @param {number} size @param {number} [align]
     */
    mem(size, align = 1){
        const segment = chance(16) ? `${pick(['es', 'ss', 'ds'])}:` : '';
        return `${PTR[size]} ptr ${segment}${this.address(align)}`;
    }

    /** @param {number} size */
    rm(size){
        return chance(3) ? this.mem(size) : this.reg(size);
    }
}

/** An immediate of `size` bytes. @param {number} size */
function imm(size){
    const value = interesting();
    switch (size)
    {
        case 1: return String(value & 0xff);
        case 2: return String(value & 0xffff);
        default: return chance(3) ? String((value & 0xff) - 128) : String(value | 0);
    }
}

/**
 * The bytes of a double, as two dwords for `mov`. A NaN is written as the
 * positive quiet one: V8 leaves a NaN's sign to whichever tier computed it, so
 * the corpus would differ run to run; NaNs of either sign and any payload come
 * from `nanBits`.
 *
 * @param {number} value
 */
function doubleWords(value){
    const view = new DataView(new ArrayBuffer(8));
    if (Number.isNaN(value))
    {
        return [0, 0x7ff80000];
    }
    view.setFloat64(0, value, true);
    return [view.getUint32(0, true), view.getUint32(4, true)];
}

/** A float's bits, a NaN as the positive quiet one (see `doubleWords`). @param {number} value */
function floatBits(value){
    if (Number.isNaN(value))
    {
        return 0x7fc00000;
    }
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    return view.getUint32(0, true);
}

const ARITH = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];
const SHIFTS = ['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'sar'];
const SIZES = [1, 2, 4];

/** @typedef {{ lines: string[], kind?: 'x87' | 'mmx' | 'sse', pc?: number, rc?: number, mxrc?: number, wide?: boolean }} Piece */

/**
 * An integer instruction (or a few, where one needs its set-up).
 *
 * @param {Operands} o
 * @returns {string[]}
 */
function integer(o){
    const size = pick(SIZES);
    const wide = pick([2, 4]);
    switch (below(46))
    {
        case 0: case 1: case 2: case 3:
        {
            const op = pick(ARITH);
            const locked = op !== 'cmp' && chance(3) ? 'lock ' : '';
            switch (below(5))
            {
                case 0: return [`${op} ${o.reg(size)}, ${o.any(size)}`];
                case 1: return [`${locked}${op} ${o.mem(size)}, ${o.src(size)}`];
                case 2: return [`${op} ${o.reg(size)}, ${o.mem(size)}`];
                case 3: return [`${chance(2) ? locked : ''}${op} ${o.rm(size)}, ${imm(size)}`];
                default: return [`${op} ${['al', 'ax', 'eax'][SIZES.indexOf(size)]}, ${imm(size)}`];
            }
        }
        case 4: case 5:
        {
            const op = pick(['inc', 'dec', 'neg', 'not']);
            return chance(2) ? [`lock ${op} ${o.mem(size)}`] : [`${op} ${o.rm(size)}`];
        }
        case 6:
            switch (below(3))
            {
                case 0: return [`test ${o.rm(size)}, ${o.src(size)}`];
                case 1: return [`test ${o.rm(size)}, ${imm(size)}`];
                default: return [`test ${['al', 'ax', 'eax'][SIZES.indexOf(size)]}, ${imm(size)}`];
            }
        case 7: case 8:
            switch (below(3))
            {
                case 0: return [`${pick(['mul', 'imul'])} ${o.rm(size)}`];
                case 1: return [`imul ${o.reg(wide)}, ${o.rm(wide)}`];
                default: return [`imul ${o.reg(wide)}, ${o.rm(wide)}, ${imm(wide)}`];
            }
        case 9:
        {
            // Mostly a quotient that fits: a high half below the divisor. ECX is
            // always a data register; the dividend's own are AX, or EDX:EAX.
            const divisor = ['ch', 'cx', 'ecx'][SIZES.indexOf(size)];
            const high = ['ah', 'dx', 'edx'][SIZES.indexOf(size)];
            const setup = chance(4) ? [] : [`xor ${high}, ${high}`];
            return [...setup, `or ${divisor}, ${size === 1 ? 0x10 : 0x100}`,
                `${pick(['div', 'idiv'])} ${chance(3) ? o.mem(size) : divisor}`];
        }
        case 10:
        {
            // The divides that fault: by zero, and a quotient past the width.
            const divisor = ['cl', 'cx', 'ecx'][SIZES.indexOf(size)];
            switch (below(3))
            {
                case 0: return [`mov ${divisor}, 0`, `${pick(['div', 'idiv'])} ${divisor}`];
                case 1:
                    return [`mov ${['ah', 'dx', 'edx'][SIZES.indexOf(size)]}, ${pick([2, 0x7f,
                        -1])}`,
                    `mov ${divisor}, ${pick([1, 2])}`, `div ${divisor}`];
                default:
                    // The most negative dividend over -1.
                    return size === 1 ? ['mov ax, 0xff80', 'mov cl, -1', 'idiv cl']
                        : size === 2 ? ['mov dx, 0xffff', 'mov ax, 0x8000', 'mov cx, -1', 'idiv cx']
                            : ['mov edx, -1', 'mov eax, 0x80000000', 'mov ecx, -1', 'idiv ecx'];
            }
        }
        case 11: case 12: case 13:
        {
            const op = pick(SHIFTS);
            switch (below(4))
            {
                case 0: return [`${op} ${o.rm(size)}, 1`];
                case 1: return [`${op} ${o.rm(size)}, ${pick([0, 1, 2, 7, 8, 9, 15, 16, 17, 31, 32,
                    33, below(256)])}`];
                case 2:
                    return [`mov cl, ${pick([0, 1, 2, 7, 8, 9, 15, 16, 17, 31, 32, 33,
                        below(256)])}`,
                    `${op} ${o.rm(size)}, cl`];
                // The /6 encoding, which the processor runs as shl.
                default:
                {
                    const r = size === 1 ? pick([0, 1, 2, 4, 5, 6]) : pick(o.roles.data());
                    return [`.byte ${size === 1 ? '0xd0' : size === 2 ? '0x66, 0xd1'
                        : '0xd1'}, ${0xf0 + r}`];
                }
            }
        }
        case 14:
        {
            // A word shifted 16 or more is left undefined: words take counts below 16.
            const op = pick(['shld', 'shrd']);
            const count = wide === 2 ? below(16) : below(40);
            return chance(2) ? [`${op} ${o.rm(wide)}, ${o.src(wide)}, ${count}`]
                : [`mov cl, ${count}`, `${op} ${o.rm(wide)}, ${o.src(wide)}, cl`];
        }
        case 15: case 16:
        {
            const op = pick(['bt', 'bts', 'btr', 'btc']);
            const lock = op !== 'bt' && chance(3) ? 'lock ' : '';
            switch (below(3))
            {
                case 0: return [`${op} ${o.reg(wide)}, ${o.src(wide)}`];
                case 1: return [`${chance(2) ? '' : lock}${op} ${o.rm(wide)}, ${below(70)}`];
                // A register bit offset reaches past the operand, either way: kept near.
                default: return [`mov ecx, ${below(128) - 48}`,
                    `${lock}${op} ${o.mem(wide)}, ${wide === 2 ? 'cx' : 'ecx'}`];
            }
        }
        case 17:
        {
            const op = pick(['bsf', 'bsr', 'popcnt']);
            if (chance(5))
            {
                // A zero source: bsf and bsr leave the destination as it was.
                const zero = o.reg(wide);
                return [`mov ${zero}, 0`, `${op} ${o.reg(wide)}, ${zero}`];
            }
            return [`${op} ${o.reg(wide)}, ${o.rm(wide)}`];
        }
        case 18: case 19:
            switch (below(4))
            {
                case 0: return [`${pick(['movzx', 'movsx'])} ${o.reg(wide)}, ${o.rm(1)}`];
                case 1: return [`${pick(['movzx', 'movsx'])} ${o.reg(4)}, ${o.rm(2)}`];
                case 2: return [`mov ${o.rm(size)}, ${chance(2) ? o.src(size) : imm(size)}`];
                default: return [`mov ${o.reg(size)}, ${o.mem(size)}`];
            }
        case 20:
        {
            // moffs: the accumulator to and from an absolute address.
            const at = DATA_AT + 0x400 + below(0x1000);
            const acc = ['al', 'ax', 'eax'][SIZES.indexOf(size)];
            return [chance(2) ? `mov ${acc}, ${PTR[size]} ptr [${at}]`
                : `mov ${PTR[size]} ptr [${at}], ${acc}`];
        }
        case 21:
        {
            const r = o.reg(wide);
            switch (below(4))
            {
                case 0: return [`lea ${r}, ${o.address()}`];
                // The 16-bit forms of the address-size prefix: no access, only the sum.
                case 1: case 2:
                {
                    // A base, an index or both, with no displacement, one of 8 or one of 16 bits.
                    const parts = [...pick([[], ['bx'], ['bp']]), ...pick([[], ['si'], ['di']])];
                    const disp = pick([0, below(256) - 128, below(0x10000)]);
                    if (parts.length === 0 || disp !== 0 || parts.length === 1 && parts[0] === 'bp')
                    {
                        parts.push(String(disp));
                    }
                    return [`lea ${r}, [${parts.join(' + ').replace('+ -', '- ')}]`];
                }
                // SIB forms with no index (index field 100) under every scale, which
                // the assembler writes only when asked for EIZ.
                default:
                {
                    const scale = pick([1, 2, 4, 8]);
                    const disp = pick([0, below(256) - 128, below(0x1000) - 0x800]);
                    return [`lea ${r}, [${chance(4) ? DATA_AT + 0x400 + below(0x800) : o.base()}`
                        + ` + eiz*${scale}${disp < 0 ? ` - ${-disp}` : ` + ${disp}`}]`];
                }
            }
        }
        case 22: case 23:
            switch (below(5))
            {
                case 0: return [`xchg ${o.reg(size)}, ${o.reg(size)}`];
                case 1: return [`xchg ${o.mem(size)}, ${o.reg(size)}`];
                case 2: return [`${chance(2) ? 'lock ' : ''}xadd ${chance(3) ? o.reg(size)
                    : o.mem(size)}, ${o.reg(size)}`];
                case 3:
                {
                    const at = o.mem(size);
                    // Equal now and then: the accumulator loaded from the operand.
                    const acc = ['al', 'ax', 'eax'][SIZES.indexOf(size)];
                    return [...(chance(2) ? [`mov ${acc}, ${at}`] : []),
                        `${chance(2) ? 'lock ' : ''}cmpxchg ${chance(4) ? o.reg(size)
                            : at}, ${o.src(size)}`];
                }
                default: return [`xchg ${wide === 2 ? 'ax' : 'eax'}, ${o.reg(wide)}`];
            }
        case 24:
        {
            const at = o.address();
            return [...(chance(2) ? [`mov eax, dword ptr ${at}`,
                `mov edx, dword ptr ${at.replace(']', ' + 4]')}`] : []),
            `${chance(2) ? 'lock ' : ''}cmpxchg8b qword ptr ${at}`];
        }
        case 25: return [`bswap ${o.reg(4)}`];
        case 26: case 27: return [`cmov${pick(CONDITIONS)} ${o.reg(wide)}, ${o.rm(wide)}`];
        case 28: return [`set${pick(CONDITIONS)} ${o.rm(1)}`];
        case 29: return [pick(['cbw', 'cwde', 'cwd', 'cdq'])];
        case 30: case 31:
        {
            const cc = pick(CONDITIONS);
            switch (below(3))
            {
                case 0: return [`j${cc} 1f`, `inc ${o.reg(4)}`, '1:'];
                // The near form, rel32.
                case 1: return [`.byte 0x0f, ${0x80 + CONDITIONS.indexOf(cc)}`, '.long 1f - 2f',
                    '2:',
                    `not ${o.reg(4)}`, '1:'];
                default: return [`j${cc} 1f`, `add ${o.reg(size)}, ${imm(size)}`, '1:'];
            }
        }
        case 32:
            switch (below(4))
            {
                case 0: return [`mov ecx, ${1 + below(4)}`, '1:', `add ${o.regExcept(4, [1])}, 3`,
                    `${pick(['loop', 'loope', 'loopne'])} 1b`];
                case 1: return [`mov ecx, ${below(3)}`,
                    `${pick(['jecxz', 'loop', 'loope', 'loopne'])} 1f`, `inc ${o.reg(4)}`, '1:'];
                // The address-size prefix: CX counts.
                case 2: return [`mov ecx, ${pick([0, 1, 0x10000, 0x10001, 2])}`,
                    `.byte 0x67, ${pick([0xe3, 0xe2, 0xe1, 0xe0])}, 1f - 2f`, '2:',
                    `inc ${o.reg(4)}`, '1:'];
                default: return [`mov ecx, ${below(4)}`, '1:', `dec ${o.regExcept(1, [1])}`,
                    'jecxz 2f', 'loop 1b', '2:'];
            }
        case 33:
            switch (below(6))
            {
                case 0: return ['call 1f', '1:', `pop ${o.reg(4)}`];
                case 1: return ['call 1f', `inc ${o.reg(4)}`, 'jmp 2f', '1:',
                    `${chance(2) ? 'ret' : `ret ${pick([0, 4, 8])}`}`, '2:'];
                // Through a register and through memory, at an address made from EIP.
                case 2:
                {
                    const r = o.reg(4);
                    return ['call 3f', '3:', `pop ${r}`, `.byte 0x81, ${0xc0 | R32.indexOf(r)}`,
                        '.long 1f - 3b', `${pick(['call', 'jmp'])} ${r}`, `inc ${o.reg(4)}`, '1:'];
                }
                case 3:
                {
                    const at = o.mem(4);
                    const r = o.reg(4);
                    return ['call 3f', '3:', `pop ${r}`, `.byte 0x81, ${0xc0 | R32.indexOf(r)}`,
                        '.long 1f - 3b', `mov ${at}, ${r}`, `${pick(['call', 'jmp'])} ${at}`,
                        `inc ${o.reg(4)}`, '1:'];
                }
                case 4: return ['jmp 1f', `inc ${o.reg(4)}`, '1:'];
                default: return ['.byte 0xe9', '.long 1f - 2f', '2:', `inc ${o.reg(4)}`, '1:'];
            }
        case 34: case 35:
            switch (below(9))
            {
                case 0: return [`push ${o.src(4)}`, `pop ${o.reg(4)}`];
                case 1: return [`push ${chance(2) ? imm(4) : below(256) - 128}`, `pop ${o.mem(4)}`];
                case 2: return [`push ${o.mem(4)}`, `pop ${o.reg(4)}`];
                case 3: return [`push ${o.src(2)}`, `pop ${o.reg(2)}`];
                case 4: return [`push ${o.mem(2)}`, `pop ${o.mem(2)}`];
                case 5: return ['pushad',
                    `${chance(2) ? `mov dword ptr [esp + ${below(8) * 4}], ${imm(4)}` : 'nop'}`,
                    'popad'];
                case 6: return ['pushaw', 'popaw'];
                // The segment registers. A selector's value is the system's (Linux's
                // here, Windows's under cork), so each read is overwritten before
                // anything shows it: what is judged is the access's width and place.
                case 7:
                {
                    // A dword push writes the selector's word, and the word above it
                    // the processor may leave or clear: that word is cleared first.
                    const r = o.reg(4);
                    return pick([
                        ['mov dword ptr [esp - 4], 0', `.byte ${pick([0x06, 0x0e, 0x16, 0x1e])}`,
                            'mov word ptr [esp], 0', `pop ${r}`],
                        [pick(['.byte 0x66, 0x1e', '.byte 0x66, 0x06', '.byte 0x66, 0x16',
                            '.byte 0x66, 0x0e']),
                        'mov word ptr [esp], 0', `pop ${R16[R32.indexOf(r)]}`],
                    ]);
                }
                default:
                {
                    const r = o.reg(4);
                    const at = o.address();
                    // The pushed selector stays below ESP: cleared too.
                    const prefix = chance(2) ? '0x66, ' : '';
                    return [`.byte ${prefix}${pick([0x06, 0x1e])}`,
                        `.byte ${prefix}${pick([0x07, 0x1f])}`,
                        'mov dword ptr [esp - 4], 0',
                        ...pick([[`mov ${r}, ${pick(SEGMENTS)}`, `mov ${R16[R32.indexOf(r)]}, 0`],
                            [`.byte 0x66, 0x8c, ${0xc0 | below(4) << 3 | R32.indexOf(r)}`,
                                `mov ${R16[R32.indexOf(r)]}, 0`],
                            [`mov word ptr ${at}, ${pick(SEGMENTS)}`, `mov word ptr ${at}, 0`]])];
                }
            }
        case 36:
        {
            // Only the status flags and DF change; IF and IOPL are not the program's to change.
            const value = random() & 0x8d5 | (chance(2) ? 0x400 : 0) | (chance(4) ? 0x3200 : 0) | 2;
            switch (below(3))
            {
                case 0: return [`push ${value}`, 'popfd', 'pushfd', `pop ${o.reg(4)}`];
                case 1: return ['pushfd', `pop ${o.reg(4)}`];
                default: return [`push ${value & 0xffff}`, 'popf', 'pushf', `pop ${o.reg(2)}`];
            }
        }
        case 37: return [pick(['lahf', 'sahf', 'clc', 'stc', 'cmc', 'cld', 'std', 'salc'])];
        case 38:
            switch (below(4))
            {
                case 0: return [pick(['daa', 'das', 'aaa', 'aas'])];
                case 1: return [`aam ${chance(4) ? 10 : below(256)}`];
                case 2: return [`aad ${chance(4) ? 10 : below(256)}`];
                default: return [`mov al, ${below(256)}`, pick(['daa', 'das', 'aaa', 'aas'])];
            }
        case 39:
            // Nesting levels above zero copy frame pointers from EBP's frame.
            o.roles.makePointer(5);
            return ['mov ebp, esp', `enter ${below(64) * 4}, ${pick([0, 0, 1, 2, 3])}`,
                ...(chance(2) ? [`mov ${o.reg(4)}, dword ptr [ebp - 4]`] : []), 'leave'];
        case 40:
        {
            const from = o.base();
            o.roles.makePointer(3);
            return [`lea ebx, [${from} + ${below(64) - 32}]`, 'xlatb'];
        }
        case 41:
            return [`arpl ${chance(2) ? o.reg(2) : o.mem(2)}, ${o.src(2)}`];
        case 42:
            switch (below(5))
            {
                case 0: return ['nop'];
                case 1: return [`nop ${o.mem(pick([2, 4]))}`];
                case 2: return [`${pick(['prefetchnta', 'prefetcht0', 'prefetcht1',
                    'prefetcht2'])} byte ptr ${o.address()}`];
                case 3: return [pick(['lfence', 'mfence', 'sfence', 'pause'])];
                default: return [`movnti ${o.mem(4)}, ${o.src(4)}`];
            }
        case 43: case 44: return oddities(o);
        default:
            return [`${pick(ARITH)} ${o.reg(size)}, ${o.src(size)}`];
    }
}

/**
 * A ModRM byte (its reg field `reg`) and what follows it for a memory operand
 * at a pointer: EBP as a base needs a displacement.
 *
 * @param {Operands} o @param {number} reg
 */
function rawMemory(o, reg){
    const base = R32.indexOf(o.base());
    return base === 5 ? [0x45 | reg << 3, 0] : [base | reg << 3];
}

/**
 * Encodings the assembler does not write on its own: an operand-size prefix
 * where it changes nothing or makes a 16-bit form, the register forms of the
 * hint no-ops, the /6 alias of shl, a 16-bit push of an immediate, ENTER and
 * LEAVE at 16 bits.
 *
 * @param {Operands} o
 * @returns {string[]}
 */
function oddities(o){
    const data = ()=>pick(o.roles.data());
    switch (below(9))
    {
        case 0: return ['.byte 0x66', `${pick(ARITH)} ${o.reg(1)}, ${chance(2) ? imm(1)
            : o.src(1)}`];
        case 1:
        {
            const opcode = pick([0xb6, 0xb7, 0xbe, 0xbf]);
            return [`.byte 0x66, 0x0f, ${opcode}, ${chance(2) ? 0xc0 | data() << 3 | below(8)
                : rawMemory(o, data()).join(', ')}`];
        }
        case 2:
        {
            const at = o.address();
            return ['.byte 0x66', `cmpxchg8b qword ptr ${at}`];
        }
        case 3:
            o.roles.makePointer(5);
            return ['mov ebp, esp', `.byte 0x66, 0xc8, ${below(64) * 2}, 0, ${pick([0, 0, 1, 2])}`,
                '.byte 0x66, 0xc9'];
        case 4:
            return [chance(2) ? `.byte 0x66, 0x68, ${below(256)}, ${below(256)}`
                : `.byte 0x66, 0x6a, ${below(256)}`,
            `.byte 0x66, ${0x58 + data()}`];
        case 5:
        {
            // A selector's word written to memory, then overwritten: its value is the system's.
            const base = o.base();
            return [`.byte 0x66, 0x8c, ${R32.indexOf(base) === 5 ? `0x45 | ${below(4) << 3}, 0`
                : `${R32.indexOf(base) | below(4) << 3}`}`, `mov word ptr [${base}], 0`];
        }
        case 6: return [`.byte 0x0f, ${pick([0x1f, 0x18])}, ${0xc0 | below(4) << 3 | below(8)}`];
        case 7:
        {
            // shl's /6 alias, by one, by an immediate, by CL, on a register or memory.
            const opcode = pick([0xd0, 0xd1, 0xc0, 0xc1, 0xd2, 0xd3]);
            const prefix = (opcode & 1) !== 0 && chance(2) ? '0x66, ' : '';
            const operand = chance(2) ? [0xf0 | (opcode & 1 ? data() : pick([0, 1, 2, 4, 5, 6]))]
                : rawMemory(o, 6);
            const count = opcode === 0xc0 || opcode === 0xc1 ? [below(40)] : [];
            const setup = opcode >= 0xd2 ? [`mov cl, ${below(40)}`] : [];
            return [...setup, `.byte ${prefix}${opcode}, ${[...operand, ...count].join(', ')}`];
        }
        default:
            return [`.byte 0x66, 0x0f, 0x1f, ${rawMemory(o, 0).join(', ')}`];
    }
}

/**
 * A string instruction with its count and pointers set up: ESI and EDI point
 * into the buffer, ECX a few elements.
 *
 * @param {Operands} o
 */
function string(o){
    const letter = pick(['b', 'w', 'd']);
    const op = pick(['movs', 'stos', 'lods', 'cmps', 'scas']);
    const prefix = op === 'cmps' || op === 'scas'
        ? pick(['', 'repe ', 'repne ', 'repe ']) : pick(['', 'rep ', 'rep ', 'repne ']);
    // A segment override applies to the source alone (DS:ESI); ES:EDI has none.
    const segment = (op === 'movs' || op === 'lods' || op === 'cmps') && chance(4)
        ? [`.byte ${pick([0x26, 0x2e, 0x36, 0x3e])}`] : [];
    const setup = [];
    for (const r of [6, 7])
    {
        if (!o.roles.pointers.has(r) || chance(2))
        {
            setup.push(`lea ${R32[r]}, [${o.base()} + ${below(16) * 16 - 128}]`);
            o.roles.makePointer(r);
        }
    }
    // The comparisons find a match now and then: the accumulator from the destination.
    if ((op === 'scas') && chance(2))
    {
        setup.push(`mov eax, dword ptr [edi + ${below(8)}]`);
    }
    if (op === 'cmps' && chance(2))
    {
        setup.push('mov eax, dword ptr [esi]', 'mov dword ptr [edi], eax');
    }
    return [...setup, `mov ecx, ${pick([0, 1, 2, 3, 5, 8, 13])}`, ...(chance(3) ? ['std']
        : chance(2) ? ['cld'] : []),
    ...segment, `${prefix}${op}${letter}`];
}

// x87 ------------------------------------------------------------------------

/**
 * A value an x87 register starts with, or memory holds for it: `plain` ones
 * a double holds whose arithmetic stays in a double's range; the others zero,
 * the infinities, NaNs quiet and signalling, a double's subnormals (normal in
 * the 80-bit format), values past 2^±1000.
 *
 * @param {boolean} plain
 */
function x87Value(plain){
    const sign = chance(2) ? -1 : 1;
    switch (below(plain ? 8 : 14))
    {
        case 0: return sign * below(100);
        case 1: return sign * (below(2000) + 0.5);
        case 2: return sign * (1 + random() / 2 ** 32) * 2 ** (below(80) - 40);
        case 3: return sign * random() * 2 ** (below(40) - 50);
        case 4: return sign * (random() * 2 ** 21 + random() / 2 ** 11);
        case 5: return pick([0, -0, 1, -1, 2, 0.5, 3]);
        case 6: return sign * (2 ** 31 - below(3)) * (chance(2) ? 1 : 2 ** 32);
        case 7: return sign * (random() / 2 ** 32) * 2 ** below(8);
        case 8: return sign * Infinity;
        case 9: return NaN;
        case 10: return sign * (random() + 1) * 2 ** -1074;
        case 11: return sign * (1 + random() / 2 ** 32) * 2 ** (below(60) + 960);
        case 12: return sign * (1 + random() / 2 ** 32) * 2 ** (-below(60) - 960);
        default: return sign * 2 ** 63 * (1 + below(4) / 8);
    }
}

/** A NaN's double bits with a payload in the high fraction bits a double keeps. @param {boolean} quiet */
function nanBits(quiet){
    const high = (chance(2) ? 0x80000000 : 0) | 0x7ff00000 | (quiet ? 0x80000 : 0)
        | (random() & 0x7ffff) | (quiet ? 0 : 1);
    return [random() & ~0x7ff, high >>> 0];
}

/** The 80-bit image of double bits, as 20 hex digits, high first. @param {number} lo @param {number} hi */
function f80OfBits(lo, hi){
    const bits = BigInt(hi >>> 0) << 32n | BigInt(lo >>> 0);
    const sign = bits >> 63n;
    const exponent = Number(bits >> 52n & 0x7ffn);
    let fraction = bits & 0xfffffffffffffn;
    let e80 = 0;
    let mantissa = 0n;
    if (exponent === 0x7ff)
    {
        e80 = 0x7fff;
        mantissa = 1n << 63n | fraction << 11n;
    }
    else if (exponent === 0)
    {
        if (fraction !== 0n)
        {
            let e = -1022;
            while ((fraction & 1n << 52n) === 0n)
            {
                fraction <<= 1n;
                e--;
            }
            e80 = e + 16383;
            mantissa = fraction << 11n;
        }
    }
    else
    {
        e80 = exponent - 1023 + 16383;
        mantissa = 1n << 63n | fraction << 11n;
    }
    const word = sign << 79n | BigInt(e80) << 64n | mantissa;
    return word.toString(16).padStart(20, '0');
}

/** @param {number} value */
function f80Of(value){
    const [lo, hi] = doubleWords(value);
    return f80OfBits(lo, hi);
}

/** An x87 register's starting image: a value, or a NaN's bits. @param {boolean} plain */
function x87Register(plain){
    if (!plain && chance(6))
    {
        const [lo, hi] = nanBits(chance(2));
        return f80OfBits(lo, hi);
    }
    return f80Of(x87Value(plain));
}

/**
 * The x87 state a case starts from: a top, the registers held (mostly a stack
 * from the top down), every register's contents -- an empty one keeps what it
 * held --, the control word with every exception masked, the status word's
 * condition codes.
 *
 * @param {{ plain: boolean, pc: number, rc: number, held?: number }} given
 */
function x87Start({ plain, pc, rc, held }){
    const top = below(8);
    const count = held ?? pick([0, 1, 2, 2, 3, 3, 4, 5, 6, 8]);
    let tags = 0;
    for (let i = 0; i < count; i++)
    {
        tags |= 1 << ((top + i) & 7);
    }
    if (chance(8))
    {
        tags = random() & 0xff;
    }
    const st = Array.from({ length: 8 }, ()=>x87Register(plain));
    const cw = 0x7f | pc << 8 | rc << 10;
    const sw = top << 11 | (random() & 0x4700);
    return { cw, sw, tw: tags, st };
}

/** Precision control: double, single, now and then extended. */
const PC_CHAIN = [2, 2, 2, 0];

/** The arithmetic forms, register and memory. */
const X87_ARITH = ['fadd', 'fmul', 'fsub', 'fsubr', 'fdiv', 'fdivr'];

/**
 * Memory holding a value for an x87 load: written by the case first, so a
 * chain's operands are plain values, or the buffer's own bytes for a single
 * instruction.
 *
 * @param {Operands} o @param {'f32' | 'f64' | 'i16' | 'i32' | 'i64' | 'f80' | 'bcd'} format
 * @param {boolean} plain
 * @returns {{ at: string, setup: string[] }}
 */
function x87Memory(o, format, plain){
    const at = o.address(1);
    // The buffer's own bytes, now and then, for a format any bytes are a value
    // of; an 80-bit image of random bytes is mostly an unnormal, which is no operand.
    if (!plain && format !== 'f80' && format !== 'bcd' && chance(3))
    {
        return { at, setup: [] };
    }
    const base = at.slice(1, -1);
    const word = (/** @type {number} */ offset, /** @type {number} */ value, size = 4)=>
        `mov ${PTR[size]} ptr [${base} + ${offset}], ${value >>> 0}`;
    switch (format)
    {
        case 'f32': return { at, setup: [word(0, floatBits(x87Value(plain)))] };
        case 'f64':
        {
            const [lo, hi] = chance(8) && !plain ? nanBits(chance(2))
                : doubleWords(x87Value(plain));
            return { at, setup: [word(0, lo), word(4, hi)] };
        }
        case 'i16': return { at, setup: [word(0, interesting() & 0xffff, 2)] };
        case 'i32': return { at, setup: [word(0, interesting())] };
        case 'i64':
        {
            // Plain: a value a double holds, so arithmetic on it rounds alike.
            const value = plain ? BigInt(Math.round(x87Value(true)) || 0) & 0x1fffffffffffffn
                : BigInt(random()) << 32n | BigInt(random());
            const signed = plain && chance(2) ? -value : value;
            const bits = BigInt.asUintN(64, signed);
            return { at, setup: [word(0, Number(bits & 0xffffffffn)), word(4,
                Number(bits >> 32n))] };
        }
        case 'f80':
        {
            // Raw: an exponent near one and 64 random bits under the integer bit
            // set -- a normal number, as an unnormal is no operand.
            const image = plain || chance(2) ? BigInt(`0x${x87Register(plain)}`)
                : BigInt(0x3f00 + below(0x100)) << 64n | 1n << 63n
                    | BigInt(random() & 0x7fffffff) << 32n
                    | BigInt(random());
            return { at, setup: [word(0, Number(image & 0xffffffffn)), word(4,
                Number(image >> 32n & 0xffffffffn)),
            word(8, Number(image >> 64n), 2)] };
        }
        default:
        {
            // Packed BCD: eighteen digits, plain ones below 2^53.
            const digits = Array.from({ length: plain ? 15 : 18 }, ()=>below(10));
            let low = 0n;
            digits.forEach((digit, i)=>{
                low |= BigInt(digit) << BigInt(i * 4);
            });
            return { at, setup: [word(0, Number(low & 0xffffffffn)), word(4,
                Number(low >> 32n & 0xffffffffn)),
            word(8, Number(low >> 64n) | (chance(2) ? 0x8000 : 0), 2)] };
        }
    }
}

/** A stack index. */
const sti = ()=>`st(${below(8)})`;

/**
 * One x87 instruction that keeps a chain plain: arithmetic, loads and stores
 * a double holds, compares, the stack's own instructions.
 *
 * @param {Operands} o @param {boolean} plain
 * @returns {string[]}
 */
function x87Step(o, plain){
    switch (below(22))
    {
        case 0: case 1: case 2:
        {
            const op = pick(X87_ARITH);
            switch (below(4))
            {
                case 0: return [`${op} st, ${sti()}`];
                case 1: return [`${op} ${sti()}, st`];
                case 2: return [`${op}p ${sti()}, st`];
                default:
                {
                    const format = pick(['f32', 'f64']);
                    const { at, setup } = x87Memory(o, format, plain);
                    return [...setup, `${op} ${format === 'f32' ? 'dword' : 'qword'} ptr ${at}`];
                }
            }
        }
        case 3:
        {
            const format = pick(['i16', 'i32']);
            const { at, setup } = x87Memory(o, format, plain);
            return [...setup, `fi${pick(['add', 'mul', 'sub', 'subr', 'div',
                'divr'])} ${format === 'i16' ? 'word' : 'dword'} ptr ${at}`];
        }
        case 4: case 5:
        {
            const format = pick(['f32', 'f64', 'i16', 'i32', 'i64', 'bcd', 'f80']);
            const { at, setup } = x87Memory(o, format, true);
            const size = { f32: 'dword', f64: 'qword', i16: 'word', i32: 'dword', i64: 'qword',
                bcd: 'tbyte', f80: 'tbyte' }[format];
            const op = format.startsWith('i') ? 'fild' : format === 'bcd' ? 'fbld' : 'fld';
            return [...setup, `${op} ${size} ptr ${at}`];
        }
        case 6: return [pick(['fld1', 'fldz'])];
        case 7: return [`fld ${sti()}`];
        case 8:
        {
            const at = o.address();
            switch (below(5))
            {
                case 0: return [`fst${pick(['', 'p'])} dword ptr ${at}`];
                case 1: return [`fst${pick(['', 'p'])} qword ptr ${at}`];
                case 2: return [`fstp tbyte ptr ${at}`];
                case 3: return [`fist${pick(['', 'p'])} ${pick(['word', 'dword'])} ptr ${at}`];
                default: return [`fistp qword ptr ${at}`];
            }
        }
        case 9: return [`fisttp ${pick(['word', 'dword', 'qword'])} ptr ${o.address()}`];
        case 10: return [`fst${pick(['', 'p'])} ${sti()}`];
        case 11:
        {
            switch (below(6))
            {
                case 0: return [`f${pick(['com', 'comp', 'ucom', 'ucomp'])} ${sti()}`];
                case 1: return [pick(['fcompp', 'fucompp', 'ftst', 'fxam'])];
                case 2: return [`f${pick(['comi', 'comip', 'ucomi', 'ucomip'])} st, ${sti()}`];
                case 3:
                {
                    const format = pick(['f32', 'f64']);
                    const { at, setup } = x87Memory(o, format, plain);
                    return [...setup, `f${pick(['com', 'comp'])} ${format === 'f32' ? 'dword'
                        : 'qword'} ptr ${at}`];
                }
                case 4:
                {
                    const format = pick(['i16', 'i32']);
                    const { at, setup } = x87Memory(o, format, plain);
                    return [...setup, `fi${pick(['com', 'comp'])} ${format === 'i16' ? 'word'
                        : 'dword'} ptr ${at}`];
                }
                default: return [`f${pick(['com', 'comp'])} ${sti()}`];
            }
        }
        case 12: return [pick(['fchs', 'fabs', 'fsqrt', 'frndint', 'fxtract', 'fprem', 'fprem1'])];
        case 13: return [`fxch ${sti()}`];
        case 14: return [`fcmov${pick(['b', 'e', 'be', 'u', 'nb', 'ne', 'nbe',
            'nu'])} st, ${sti()}`];
        case 15: return [pick(['fincstp', 'fdecstp', 'fnop', 'fwait']), ...(chance(2)
            ? [`ffree${pick(['', 'p'])} ${sti()}`] : [])];
        case 16:
            // The undocumented aliases every processor honours: fxch, fstp.
            return [`.byte ${pick([[0xd9, 0xc8], [0xd9, 0xd8], [0xdd, 0xc8], [0xdf, 0xc8], [0xdf,
                0xd0], [0xdf, 0xd8]].map(([a, b])=>`${a}, ${b + below(8)}`))}`];
        case 17: return [`.byte ${pick(['0xdc, ' + (0xd0 + below(16)), '0xde, ' + (0xd0
            + below(8))])}`];
        case 18:
        {
            switch (below(3))
            {
                case 0: return ['fnstsw ax'];
                case 1: return [`fnstsw word ptr ${o.address()}`];
                default: return [`fnstcw word ptr ${o.address()}`];
            }
        }
        case 19: return ['fnclex'];
        case 20: return ['fninit'];
        default: return [`fstp ${sti()}`];
    }
}

/**
 * An x87 instruction whose result a double may not hold: the constants,
 * the transcendentals, loads of 64-bit integers, BCD and 80-bit values the
 * buffer gives. It ends a case's arithmetic.
 *
 * @param {Operands} o
 * @returns {string[]}
 */
function x87Wide(o){
    switch (below(8))
    {
        case 0: return [pick(['fldpi', 'fldl2e', 'fldl2t', 'fldlg2', 'fldln2'])];
        case 1: case 2: return transcendental(o);
        case 3:
        {
            const { at, setup } = x87Memory(o, 'i64', false);
            return [...setup, `fild qword ptr ${at}`];
        }
        case 4:
        {
            const { at, setup } = x87Memory(o, 'bcd', false);
            return [...setup, `fbld tbyte ptr ${at}`];
        }
        case 5:
        {
            const { at, setup } = x87Memory(o, 'f80', false);
            return [...setup, `fld tbyte ptr ${at}`];
        }
        case 6: return [`fbstp tbyte ptr ${o.address()}`];
        default: return [pick(['fsqrt', 'fscale', 'frndint', 'fxtract', 'fprem', 'fprem1']),
            ...(chance(2) ? [pick(X87_ARITH) + ' st, st(1)'] : [])];
    }
}

/**
 * A transcendental instruction over operands the case loads first, in the
 * range the SDM defines its result for: f2xm1's within ±1, fyl2xp1's within
 * ±(1 - √2/2), the trigonometric ones' mostly where no reduction is needed and
 * now and then past 2^63, where the operand stays and C2 says so.
 *
 * @param {Operands} o
 * @returns {string[]}
 */
function transcendental(o){
    const op = pick(['f2xm1', 'fyl2x', 'fyl2xp1', 'fsin', 'fcos', 'fsincos', 'fptan', 'fpatan']);
    const sign = ()=>chance(2) ? -1 : 1;
    /** @type {number[]} the values loaded, ST(1) first */
    let values;
    switch (op)
    {
        case 'f2xm1': values = [sign() * random() / 2 ** 32 * (chance(4) ? 2 ** -below(40)
            : 1)]; break;
        case 'fyl2xp1':
            values = [x87Value(true), sign() * random() / 2 ** 32 * 0.2928 * (chance(4)
                ? 2 ** -below(40) : 1)];
            break;
        case 'fyl2x':
            values = [x87Value(true), chance(8) ? pick([0, -1, Infinity]) : Math.abs(x87Value(true))
                || 1];
            break;
        case 'fpatan': values = [x87Value(!chance(4)), x87Value(!chance(4))]; break;
        default:
            values = [chance(8) ? sign() * 2 ** (63 + below(4))
                : sign() * random() / 2 ** 32 * pick([0.785, 1.57, 3.14, 6.28])];
    }
    /** @type {string[]} */
    const lines = [];
    for (const value of values)
    {
        const at = o.address();
        const base = at.slice(1, -1);
        const [lo, hi] = doubleWords(value);
        lines.push(`mov dword ptr [${base} + 0], ${lo >>> 0}`,
            `mov dword ptr [${base} + 4], ${hi >>> 0}`,
            `fld qword ptr ${at}`);
    }
    return [...lines, op];
}

/** The transcendental instructions, whose results cork computes to within ulps. */
const TRANSCENDENTAL = new Set(['f2xm1', 'fyl2x', 'fyl2xp1', 'fsin', 'fcos', 'fsincos', 'fptan',
    'fpatan']);

/**
 * What may follow a wide result: a store a double rounds alike, a compare,
 * the stack's own moves. After a transcendental result no float store: its
 * last bits are compared with a tolerance in the register, and memory has none.
 *
 * @param {Operands} o @param {string[]} before  the instructions before
 * @returns {string[]}
 */
function x87After(o, before){
    const at = o.address();
    const stores = !TRANSCENDENTAL.has(before[before.length - 1]);
    switch (below(stores ? 7 : 6) + (stores ? 0 : 1))
    {
        case 0: return [`fst${pick(['', 'p'])} ${pick(['dword', 'qword'])} ptr ${at}`];
        case 1: return [`fist${pick(['', 'p'])} ${pick(['word', 'dword'])} ptr ${at}`];
        case 2: return [pick(['ftst', 'fxam', 'fcompp', 'fucompp'])];
        case 3: return [`f${pick(['comi', 'ucomi', 'comip'])} st, ${sti()}`];
        case 4: return [`fxch ${sti()}`];
        case 5: return [pick(['fchs', 'fabs', 'fincstp', 'fdecstp'])];
        default: return [`fstp ${sti()}`];
    }
}

/**
 * An x87 case: a chain of plain instructions under precision control at 53 or
 * 24 bits (or a single one at 64), maybe one wide result and what may follow
 * it; or one control instruction over an image the case wrote first.
 *
 * @param {Operands} o
 * @returns {Piece}
 */
function x87(o){
    const kind = below(10);
    if (kind === 0)
    {
        return { ...x87Control(o), kind: 'x87' };
    }
    if (kind === 1)
    {
        // The integer roundings under each rounding control.
        const rc = below(4);
        const at = o.address();
        const step = pick([`fist${pick(['', 'p'])} ${pick(['word', 'dword'])} ptr ${at}`,
            `fistp qword ptr ${at}`,
            'frndint', `fbstp tbyte ptr ${at}`, `fisttp dword ptr ${at}`]);
        return { lines: [step, ...(chance(3) ? [pick(['frndint', 'fld1'])] : [])], kind: 'x87',
            pc: pick(PC_CHAIN), rc };
    }
    if (kind === 2)
    {
        // One instruction from anywhere: values past a double's range, wide values, 64-bit
        // precision.
        const lines = chance(2) ? x87Step(o, false) : x87Wide(o);
        return { lines: [...lines, ...(chance(3) ? x87After(o, lines) : [])], kind: 'x87',
            pc: pick([0, 2, 3, 3]), rc: 0, wide: true };
    }
    const pc = pick(PC_CHAIN);
    const lines = [];
    const count = 1 + below(4);
    for (let i = 0; i < count; i++)
    {
        lines.push(...x87Step(o, true));
    }
    if (chance(3))
    {
        const wide = x87Wide(o);
        lines.push(...wide);
        if (chance(2))
        {
            lines.push(...x87After(o, wide));
        }
    }
    // An operand-size prefix, which an x87 instruction other than the
    // environment's and the state's ignores.
    const plainOps = lines.map((line, i)=>/^f(?!nstenv|nsave|ldenv|rstor|xsave|xrstor)/.test(line) ? i : -1)
        .filter(i=>i >= 0);
    if (plainOps.length > 0 && chance(6))
    {
        lines.splice(pick(plainOps), 0, '.byte 0x66');
    }
    return { lines, kind: 'x87', pc, rc: 0 };
}

/**
 * The control instructions: environments and saves stored and loaded back,
 * changed in between where the change keeps every exception masked.
 *
 * @param {Operands} o
 * @returns {{ lines: string[], pc: number, rc: number }}
 */
function x87Control(o){
    const base = o.base();
    const offset = below(16) * 16;
    const at = `[${base} + ${offset}]`;
    const pc = pick([2, 3]);
    switch (below(7))
    {
        case 0: return { lines: [`fnstenv ${at}`, ...(chance(2)
            ? [`mov word ptr ${at.replace(']', ' + 8]')}, ${random() & 0xffff}`] : []),
        `fldenv ${at}`], pc, rc: 0 };
        case 1: return { lines: [`fnsave ${at}`, ...(chance(2) ? ['fld1'] : []), `frstor ${at}`],
            pc, rc: 0 };
        case 2: return { lines: [`fnsave ${at}`], pc, rc: 0 };
        case 3: return { lines: [`fnstenv ${at}`], pc, rc: 0 };
        case 4:
        {
            const word = 0x7f | pick([0, 2, 3]) << 8 | below(4) << 10 | (chance(2) ? 0x1000 : 0);
            return { lines: [`mov word ptr ${at}, ${word}`, `fldcw word ptr ${at}`,
                `fnstcw word ptr ${at.replace(']', ' + 2]')}`,
                ...(chance(2) ? [`fist dword ptr ${at.replace(']', ' + 4]')}`] : [])], pc, rc: 0 };
        }
        case 5: return { lines: [`fxsave ${at}`], pc, rc: 0 };
        default:
            return { lines: [`fxsave [${base}]`, ...(chance(2) ? [`mov word ptr [${base}], 0x27f`]
                : []), `fxrstor [${base}]`], pc, rc: 0 };
    }
}

// MMX, SSE, SSE2, SSE3 -------------------------------------------------------

const MMX_OPS = ['paddb', 'paddw', 'paddd', 'paddq', 'paddsb', 'paddsw', 'paddusb', 'paddusw',
    'psubb', 'psubw', 'psubd', 'psubq', 'psubsb', 'psubsw', 'psubusb', 'psubusw', 'pand', 'pandn',
    'por', 'pxor', 'pcmpeqb', 'pcmpeqw', 'pcmpeqd', 'pcmpgtb', 'pcmpgtw', 'pcmpgtd', 'pmullw',
    'pmulhw', 'pmulhuw', 'pmuludq', 'pmaddwd', 'pminub', 'pmaxub', 'pminsw', 'pmaxsw', 'pavgb',
    'pavgw', 'psadbw', 'packsswb', 'packuswb', 'packssdw', 'punpcklbw', 'punpcklwd', 'punpckldq',
    'punpckhbw', 'punpckhwd', 'punpckhdq', 'psllw', 'pslld', 'psllq', 'psrlw', 'psrld', 'psrlq',
    'psraw', 'psrad'];
/** The packed integer operations SSE2 adds on XMM beyond MMX's. */
const XMM_ONLY = ['punpcklqdq', 'punpckhqdq'];
const FLOAT_OPS = ['add', 'sub', 'mul', 'div', 'min', 'max', 'sqrt'];
const LOGIC = ['and', 'andn', 'or', 'xor'];
const PACKED_FLOAT = ['addsubps', 'addsubpd', 'haddps', 'haddpd', 'hsubps', 'hsubpd', 'cvtdq2ps',
    'cvtps2dq', 'cvttps2dq', 'cvtdq2pd', 'cvtpd2dq', 'cvttpd2dq', 'cvtps2pd', 'cvtpd2ps', 'movddup',
    'movshdup', 'movsldup', 'unpcklps', 'unpckhps', 'unpcklpd', 'unpckhpd'];
/** The x87's reserved register encodings: #UD. */
const X87_RESERVED = [
    ...[0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xe2, 0xe3, 0xe6, 0xe7,
        0xef].map(m=>`0xd9, ${m}`),
    ...Array.from({ length: 32 }, (_, i)=>0xe0 + i).filter(m=>m !== 0xe9).map(m=>`0xda, ${m}`),
    ...[0xe5, 0xe6, 0xe7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff].map(m=>`0xdb, ${m}`),
    ...Array.from({ length: 16 }, (_, i)=>`0xdd, ${0xf0 + i}`),
    ...[0xd8, 0xda, 0xdb, 0xdc, 0xdd, 0xde, 0xdf].map(m=>`0xde, ${m}`),
    ...Array.from({ length: 8 }, (_, i)=>`0xdf, ${0xf8 + i}`),
];

/** The packed operations whose memory source is eight bytes. */
const HALF_SOURCES = new Set(['movddup', 'cvtdq2pd', 'cvtps2pd']);
/** Conversions to integers, which round by MXCSR. */
const BY_MXCSR = new Set(['cvtps2dq', 'cvtpd2dq']);
const MOVES = ['movaps', 'movups', 'movapd', 'movupd', 'movdqa', 'movdqu'];

const mm = ()=>`mm${below(8)}`;
const xmm = ()=>`xmm${below(8)}`;

/**
 * An MMX case, and the SSE instructions on MMX registers.
 *
 * @param {Operands} o
 * @returns {Piece}
 */
function mmx(o){
    /** @type {string[]} */
    const lines = [];
    const count = 1 + below(3);
    for (let i = 0; i < count; i++)
    {
        switch (below(14))
        {
            case 0: case 1: case 2: case 3:
            {
                // The low unpacks read four bytes of memory on MMX.
                const op = pick(MMX_OPS);
                const size = /^punpckl/.test(op) ? 'dword' : 'qword';
                lines.push(`${op} ${mm()}, ${chance(3) ? `${size} ptr ${o.address()}` : mm()}`);
                break;
            }
            case 4:
                lines.push(`${pick(['psllw', 'pslld', 'psllq', 'psrlw', 'psrld', 'psrlq', 'psraw',
                    'psrad'])} ${mm()}, ${below(70)}`);
                break;
            case 5:
                switch (below(5))
                {
                    case 0: lines.push(`movd ${mm()}, ${chance(2) ? o.src(4)
                        : `dword ptr ${o.address()}`}`); break;
                    case 1: lines.push(`movd ${chance(2) ? o.reg(4)
                        : `dword ptr ${o.address()}`}, ${mm()}`); break;
                    case 2: lines.push(`movq ${mm()}, ${chance(2) ? mm()
                        : `qword ptr ${o.address()}`}`); break;
                    case 3: lines.push(`movq qword ptr ${o.address()}, ${mm()}`); break;
                    default: lines.push(`movntq qword ptr ${o.address()}, ${mm()}`); break;
                }
                break;
            case 6: lines.push(`pshufw ${mm()}, ${chance(3) ? `qword ptr ${o.address()}`
                : mm()}, ${below(256)}`); break;
            case 7: lines.push(`pextrw ${o.reg(4)}, ${mm()}, ${below(8)}`); break;
            case 8: lines.push(`pinsrw ${mm()}, ${chance(2) ? o.src(4)
                : `word ptr ${o.address()}`}, ${below(8)}`); break;
            case 9: lines.push(`pmovmskb ${o.reg(4)}, ${mm()}`); break;
            case 10:
            {
                const from = o.base();
                o.roles.makePointer(7);
                lines.push(`lea edi, [${from} + ${below(16) * 16}]`, `maskmovq ${mm()}, ${mm()}`);
                break;
            }
            case 11:
                switch (below(6))
                {
                    case 0: lines.push(`cvtpi2ps ${xmm()}, ${chance(2) ? mm()
                        : `qword ptr ${o.address()}`}`); break;
                    case 1: lines.push(`cvtpi2pd ${xmm()}, ${chance(2) ? mm()
                        : `qword ptr ${o.address()}`}`); break;
                    case 2: lines.push(`${pick(['cvtps2pi', 'cvttps2pi'])} ${mm()}, ${chance(2)
                        ? xmm() : `qword ptr ${o.address()}`}`); break;
                    case 3: lines.push(`${pick(['cvtpd2pi', 'cvttpd2pi'])} ${mm()}, ${chance(2)
                        ? xmm() : `xmmword ptr ${o.address(16)}`}`); break;
                    case 4: lines.push(`movq2dq ${xmm()}, ${mm()}`); break;
                    default: lines.push(`movdq2q ${mm()}, ${xmm()}`); break;
                }
                break;
            case 12: lines.push('emms'); break;
            default: lines.push(`${pick(MMX_OPS)} ${mm()}, ${mm()}`); break;
        }
    }
    return { lines, kind: 'mmx' };
}

/**
 * An SSE, SSE2 or SSE3 case.
 *
 * @param {Operands} o
 * @returns {Piece}
 */
function sse(o){
    /** @type {string[]} */
    const lines = [];
    const count = 1 + below(3);
    const aligned = ()=>`xmmword ptr ${o.address(16)}`;
    for (let i = 0; i < count; i++)
    {
        const kind = pick(['ps', 'pd', 'ss', 'sd']);
        const scalar = ()=>kind === 'ss' ? `dword ptr ${o.address()}` : kind === 'sd'
            ? `qword ptr ${o.address()}` : aligned();
        switch (below(22))
        {
            case 0: case 1: case 2:
                lines.push(`${pick(FLOAT_OPS)}${kind} ${xmm()}, ${chance(3) ? scalar() : xmm()}`);
                break;
            case 3: lines.push(`${pick(LOGIC)}${pick(['ps', 'pd'])} ${xmm()}, ${chance(3)
                ? aligned() : xmm()}`); break;
            case 4: lines.push(`cmp${kind} ${xmm()}, ${chance(3) ? scalar()
                : xmm()}, ${below(8)}`); break;
            case 5:
            {
                const op = pick(['comi', 'ucomi']) + pick(['ss', 'sd']);
                lines.push(`${op} ${xmm()}, ${chance(3) ? (op.endsWith('ss')
                    ? `dword ptr ${o.address()}` : `qword ptr ${o.address()}`) : xmm()}`);
                break;
            }
            case 6: lines.push(`cvtsi2${pick(['ss', 'sd'])} ${xmm()}, ${chance(2) ? o.src(4)
                : `dword ptr ${o.address()}`}`); break;
            case 7:
            {
                const op = pick(['cvt', 'cvtt']);
                const from = pick(['ss', 'sd']);
                const line = `${op}${from}2si ${o.reg(4)}, ${chance(3) ? (from === 'ss'
                    ? `dword ptr ${o.address()}` : `qword ptr ${o.address()}`) : xmm()}`;
                if (op === 'cvt')
                {
                    // MXCSR's rounding at random, for this conversion alone.
                    return { lines: [line], kind: 'sse', mxrc: below(4) };
                }
                lines.push(line);
                break;
            }
            case 8:
            {
                const op = pick(['cvtss2sd', 'cvtsd2ss']);
                const at = `${op === 'cvtss2sd' ? 'dword' : 'qword'} ptr ${o.address()}`;
                lines.push(`${op} ${xmm()}, ${chance(3) ? at : xmm()}`);
                break;
            }
            case 9: case 10: case 11:
            {
                const op = pick([...MMX_OPS, ...XMM_ONLY]);
                lines.push(`${op} ${xmm()}, ${chance(3) ? aligned() : xmm()}`);
                break;
            }
            case 12:
            {
                const op = pick(PACKED_FLOAT);
                const at = HALF_SOURCES.has(op) ? `qword ptr ${o.address()}` : aligned();
                const line = `${op} ${xmm()}, ${chance(3) ? at : xmm()}`;
                if (BY_MXCSR.has(op))
                {
                    return { lines: [line], kind: 'sse', mxrc: below(4) };
                }
                lines.push(line);
                break;
            }
            case 13:
                lines.push(`${pick(['psllw', 'pslld', 'psllq', 'psrlw', 'psrld', 'psrlq', 'psraw',
                    'psrad', 'pslldq', 'psrldq'])} ${xmm()}, ${below(20)}`);
                break;
            case 14:
                lines.push(`${pick(['pshufd', 'pshuflw', 'pshufhw', 'shufps',
                    'shufpd'])} ${xmm()}, ${chance(3) ? aligned() : xmm()}, ${below(256)}`);
                break;
            case 15:
                switch (below(5))
                {
                    case 0: lines.push(`${pick(MOVES)} ${xmm()}, ${chance(2) ? xmm()
                        : aligned()}`); break;
                    case 1: lines.push(`${pick(MOVES)} ${aligned()}, ${xmm()}`); break;
                    case 2: lines.push(`${pick(['movss', 'movsd'])} ${xmm()}, ${xmm()}`); break;
                    case 3:
                    {
                        const op = pick(['movss', 'movsd']);
                        const at = op === 'movss' ? `dword ptr ${o.address()}`
                            : `qword ptr ${o.address()}`;
                        lines.push(chance(2) ? `${op} ${xmm()}, ${at}` : `${op} ${at}, ${xmm()}`);
                        break;
                    }
                    default: lines.push(`${pick(['movntps', 'movntpd',
                        'movntdq'])} ${aligned()}, ${xmm()}`); break;
                }
                break;
            case 16:
                switch (below(5))
                {
                    case 0: lines.push(`movd ${xmm()}, ${chance(2) ? o.src(4)
                        : `dword ptr ${o.address()}`}`); break;
                    case 1: lines.push(`movd ${chance(2) ? o.reg(4)
                        : `dword ptr ${o.address()}`}, ${xmm()}`); break;
                    case 2: lines.push(`movq ${xmm()}, ${chance(2) ? xmm()
                        : `qword ptr ${o.address()}`}`); break;
                    case 3: lines.push(`movq qword ptr ${o.address()}, ${xmm()}`); break;
                    default:
                    {
                        const op = pick(['movhps', 'movlps', 'movhpd', 'movlpd']);
                        lines.push(chance(2) ? `${op} ${xmm()}, qword ptr ${o.address()}`
                            : `${op} qword ptr ${o.address()}, ${xmm()}`);
                        break;
                    }
                }
                break;
            case 17:
                switch (below(5))
                {
                    case 0: lines.push(`${pick(['pmovmskb', 'movmskps',
                        'movmskpd'])} ${o.reg(4)}, ${xmm()}`); break;
                    case 1: lines.push(`pextrw ${o.reg(4)}, ${xmm()}, ${below(8)}`); break;
                    case 2: lines.push(`pinsrw ${xmm()}, ${chance(2) ? o.src(4)
                        : `word ptr ${o.address()}`}, ${below(8)}`); break;
                    case 3: lines.push(`${pick(['movhlps', 'movlhps'])} ${xmm()}, ${xmm()}`); break;
                    default:
                    {
                        const from = o.base();
                        o.roles.makePointer(7);
                        lines.push(`lea edi, [${from} + ${below(16) * 16}]`,
                            `maskmovdqu ${xmm()}, ${xmm()}`);
                        break;
                    }
                }
                break;
            case 18: lines.push(`lddqu ${xmm()}, xmmword ptr ${o.address()}`); break;
            case 19:
            {
                const at = o.address(4);
                const word = 0x1f80 | below(4) << 13 | (random() & 0x3f);
                lines.push(`mov dword ptr ${at}, ${word}`, `ldmxcsr dword ptr ${at}`,
                    `stmxcsr dword ptr ${at.replace(']', ' + 4]')}`);
                if ((word >>> 13 & 3) !== 0)
                {
                    // Rounding other than nearest from here: only what cork rounds by it.
                    lines.push(`cvtps2dq ${xmm()}, ${xmm()}`);
                }
                return { lines, kind: 'sse', mxrc: 0 };
            }
            case 20: lines.push(`${pick(['sqrt', 'min', 'max', 'add', 'mul'])}${pick(['ps', 'pd',
                'ss', 'sd'])} ${xmm()}, ${xmm()}`); break;
            default: lines.push(`clflush byte ptr ${o.address()}`); break;
        }
    }
    return { lines, kind: 'sse', mxrc: 0 };
}

/**
 * Encodings that are no instruction: the undefined opcodes, the register forms
 * of memory-only ones and the reverse, a lock on what may not take one, the
 * x87's reserved slots. Each raises #UD.
 *
 * @returns {string[]}
 */
function invalid(){
    const modrm = ()=>0xc0 | below(64);
    const memory = ()=>below(8) << 3 | pick([0, 1, 2, 3, 6, 7]);
    switch (below(14))
    {
        case 0: return [pick(['ud2', '.byte 0x0f, 0xb9, 0xc0', '.byte 0x0f, 0xff, 0xc0'])];
        // The register forms of memory-only instructions.
        case 1: return [`.byte ${pick(['0x0f, 0x13', '0x0f, 0x17', '0x0f, 0x2b', '0x66, 0x0f, 0x13',
            '0x66, 0x0f, 0x17', '0x66, 0x0f, 0x2b', '0x0f, 0xc3', '0x66, 0x0f, 0xe7',
            '0x0f, 0xe7'])}, ${modrm()}`];
        // The memory forms of register-only ones: the fault comes before any access.
        case 2: return [`.byte ${pick(['0x0f, 0x50', '0x66, 0x0f, 0x50', '0x0f, 0xd7',
            '0x66, 0x0f, 0xd7', '0x0f, 0xf7', '0x66, 0x0f, 0xf7', '0x0f, 0xc5', '0x66, 0x0f, 0xc5',
            '0xf2, 0x0f, 0xd6', '0xf3, 0x0f, 0xd6'])}, ${below(8) << 3 | 6}`];
        // MMX and SSE2 shifts by an immediate in a slot with no operation, or
        // in one that has, with a memory operand; popcnt's opcode with no F3;
        // the register forms of movlpd and movhpd.
        case 3:
        {
            if (chance(3))
            {
                return [`.byte ${pick(['0x0f, 0xb8', '0x66, 0x0f, 0xb8', '0x66, 0x0f, 0x12',
                    '0x66, 0x0f, 0x16'])}, ${0xc0 | below(64)}`];
            }
            if (chance(2))
            {
                const opcode = pick([0x71, 0x72, 0x73]);
                const wide = chance(2);
                const slot = pick(opcode === 0x73 ? wide ? [2, 3, 6, 7] : [2, 6] : [2, 4, 6]);
                return [`.byte ${wide ? '0x66, ' : ''}0x0f, ${opcode}, ${slot << 3 | pick([0, 1, 2,
                    3, 6, 7])}, ${below(256)}`];
            }
            const wide = chance(2);
            const opcode = pick([0x71, 0x72, 0x73]);
            const valid = opcode === 0x73 ? wide ? [2, 3, 6, 7] : [2, 6] : [2, 4, 6];
            const slots = [0, 1, 2, 3, 4, 5, 6, 7].filter(slot=>!valid.includes(slot));
            return [`.byte ${wide ? '0x66, ' : ''}0x0f, ${opcode}, ${0xc0 | pick(slots) << 3
                | below(8)}, ${below(256)}`];
        }
        // Prefixes that make no instruction of an opcode.
        case 4: return [`.byte ${pick(['0x0f, 0x6c', '0x0f, 0x6d', '0x0f, 0xd6', '0x0f, 0xe6',
            '0x0f, 0x7c', '0x0f, 0x7d', '0x0f, 0xd0'])}, ${modrm()}`];
        // A lock on a register destination, or on an instruction with no memory write.
        case 5: return [pick([`.byte 0xf0, 0x01, ${modrm()}`, `.byte 0xf0, 0x8b, ${memory()}`,
            '.byte 0xf0, 0x90', `.byte 0xf0, 0xf7, ${0xd0 | below(8)}`,
            `.byte 0xf0, 0x0f, 0xa3, ${memory()}`])];
        // The x87's reserved encodings.
        // The x87's reserved register slots.
        case 6: case 7: case 8: case 9: return [`.byte ${pick(X87_RESERVED)}`];
        // Reserved memory slots of the x87 and of 0F C7.
        // Reserved memory slots of the x87, under any ModRM, and the register form
        // of 0F C7 /1; the bytes after them only make up a SIB and a displacement.
        case 10:
        {
            const [opcode, slot] = pick([[0xd9, 1], [0xdb, 4], [0xdb, 6], [0xdd, 5]]);
            const byte = below(3) << 6 | slot << 3 | below(8);
            return [`.byte ${chance(6) ? '0x0f, 0xc7, 0xc8'
                : `${opcode}, ${byte}`}, 0x00, 0x08, 0x10, 0x00, 0x00`];
        }
        // mov to CS, mov from a segment register past GS, a register for a memory operand.
        case 11: return [pick(['.byte 0x8e, 0xc8', '.byte 0x8c, 0xf0', '.byte 0x8e, 0xf8',
            '.byte 0x8d, 0xc0', '.byte 0x0f, 0xc7, 0xc9'])];
        case 12: return [`.byte 0x0f, ${pick([0x04, 0x0a, 0x0c, 0x0e, 0x24, 0x25, 0x26, 0x27, 0x36,
            0x39, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x7a, 0x7b, 0xa6, 0xa7])}, ${modrm()}`];
        default: return [`${pick(['popcnt', 'bsf'])} eax, ecx`, '.byte 0x0f, 0x0b'];
    }
}

/**
 * One case: a template family by weight, the registers' roles, the text.
 *
 * @returns {{ text: string[], kind: string | undefined,
 *     roles: { pointers: Set<number>, index: number }, pc: number, rc: number,
 *     mxrc: number, wide: boolean }}
 */
function makeCase(){
    const roles = new Roles();
    // The roles the registers start in: a template may give one another later.
    const start = { pointers: new Set(roles.pointers), index: roles.index };
    const o = new Operands(roles);
    /** @type {Piece} */
    let piece;
    const family = below(100);
    const swept = SWEEP.shift();
    if (swept)
    {
        piece = swept(o);
    }
    else if (family < 40)
    {
        /** @type {string[]} */
        const lines = [];
        const count = 1 + below(4);
        for (let i = 0; i < count; i++)
        {
            lines.push(...integer(o));
        }
        piece = { lines };
    }
    else if (family < 47)
    {
        piece = { lines: [...string(o), ...(chance(3) ? integer(o) : [])] };
    }
    else if (family < 68)
    {
        piece = x87(o);
    }
    else if (family < 76)
    {
        piece = mmx(o);
    }
    else if (family < 95)
    {
        piece = sse(o);
    }
    else
    {
        piece = { lines: [...(chance(2) ? integer(o) : []), ...invalid()] };
    }
    return { text: piece.lines, kind: piece.kind, roles: start, pc: piece.pc ?? 3, rc: piece.rc
        ?? 0,
    mxrc: piece.mxrc ?? 0, wide: piece.wide ?? false };
}

/**
 * The forms the random cases might miss, each in a case of its own ahead of
 * them: the encodings that are no instruction, slot by slot; the x87
 * instructions under an operand-size prefix; every 16-bit address form; every
 * shift and rotate at every width, count and operand; every two-operand
 * arithmetic with an immediate, short and full; the strings under
 * REPNE; each packed operation on a register and on memory.
 *
 * @type {((o: Operands) => Piece)[]}
 */
const SWEEP = [
    ...X87_RESERVED.map(bytes=>()=>({ lines: [`.byte ${bytes}`] })),
    ...[false, true].flatMap(wide=>[0x71, 0x72, 0x73].flatMap(opcode=>[0, 1, 2, 3, 4, 5, 6, 7]
        .map(slot=>()=>{
            const valid = opcode === 0x73 ? wide ? [2, 3, 6, 7] : [2, 6] : [2, 4, 6];
            const modrm = valid.includes(slot) ? slot << 3 | pick([0, 1, 2, 3, 4, 6, 7])
                : 0xc0 | slot << 3 | below(8);
            return { lines: [`.byte ${wide ? '0x66, '
                : ''}0x0f, ${opcode}, ${modrm}, 0, 0, 0, 0, 0`] };
        }))),
    ...[[0xd9, 1], [0xdb, 4], [0xdb, 6], [0xdd, 5]].flatMap(([opcode, slot])=>[0, 1, 2]
        .flatMap(mod=>[0, 1, 2, 3, 4, 5, 6, 7].map(rm=>()=>({
            lines: [`.byte ${opcode}, ${mod << 6 | slot << 3 | rm}, 0, 0, 0, 0, 0, 0`] })))),
    ...['ftst', 'fxam', 'fnop', 'fchs', 'fabs', 'fld1', 'fldl2t', 'fldl2e', 'fldpi', 'fldlg2',
        'fldln2', 'fldz', 'fld st(1)', 'fxch st(1)', 'fst st(2)', 'fstp st(1)', 'ffree st(3)',
        'fucom st(1)', 'fucomp st(1)', 'fst dword ptr M', 'fstp dword ptr M', 'fst qword ptr M',
        'fstp qword ptr M', 'fld dword ptr M', 'fld qword ptr M', 'fisttp qword ptr M',
        'fnstcw word ptr M', 'fldcw word ptr M']
        .map(op=>(/** @type {Operands} */ o)=>{
            const base = o.base();
            // A control word with every exception masked; a value a double holds.
            const setup = op.startsWith('fldcw') ? [`mov word ptr [${base}], 0x27f`]
                : op.startsWith('fld ') && op.endsWith(' M')
                    ? doubleWords(x87Value(true)).map((word,
                        i)=>`mov dword ptr [${base} + ${i * 4}], ${word >>> 0}`)
                    : [];
            return { lines: [...setup, '.byte 0x66', op.replace(' M', ` [${base}]`)], kind: 'x87',
                pc: 2, rc: 0 };
        }),
    ...[[], ['bx'], ['bp']].flatMap(base=>[[], ['si'], ['di']].flatMap(index=>[0, -100, 0x1234]
        .map(disp=>(/** @type {Operands} */ o)=>{
            const parts = [...base, ...index];
            if (parts.length === 0 || disp !== 0 || parts.length === 1 && parts[0] === 'bp')
            {
                parts.push(String(disp));
            }
            if (parts.length === 1 && base.length === 0 && index.length === 0)
            {
                // A displacement alone: the assembler takes it for a 32-bit address.
                const r = R32.indexOf(o.reg(4));
                return { lines: [`.byte 0x67, 0x8d, ${r << 3
                    | 6}, ${disp & 0xff}, ${disp >> 8 & 0xff}`] };
            }
            return { lines: [`lea ${o.reg(pick([2, 4]))}, [${parts.join(' + ').replace('+ -',
                '- ')}]`] };
        }))),
    ...SIZES.map(size=>(/** @type {Operands} */ o)=>({ lines: [`cmpxchg ${o.reg(size)}, ${o.src(size)}`] })),
    ...SHIFTS.flatMap(op=>SIZES.flatMap(size=>['1', 'imm', 'cl'].flatMap(count=>[false, true]
        .map(memory=>(/** @type {Operands} */ o)=>{
            const target = memory ? o.mem(size) : o.reg(size);
            const by = count === '1' ? '1' : count === 'imm' ? String(below(40)) : 'cl';
            return { lines: [...count === 'cl' ? [`mov cl, ${below(40)}`] : [],
                `${op} ${target}, ${by}`] };
        })))),
    ...ARITH.flatMap(op=>SIZES.flatMap(size=>[false, true].flatMap(memory=>[false, true]
        .map(small=>(/** @type {Operands} */ o)=>{
            const target = memory ? o.mem(size) : o.reg(size);
            return { lines: [`${op} ${target}, ${small ? below(256) - 128 : imm(size)}`] };
        })))),
    ...['movs', 'stos', 'lods'].flatMap(op=>['b', 'w', 'd'].map(letter=>(/** @type {Operands} */ o)=>{
        const lines = string(o);
        lines[lines.length - 1] = `repne ${op}${letter}`;
        return { lines };
    })),
    ...MMX_OPS.flatMap(op=>[false, true].map(memory=>(/** @type {Operands} */ o)=>({
        lines: [`${op} ${mm()}, ${memory ? `${/^punpckl/.test(op) ? 'dword' : 'qword'} ptr ${o.address()}` : mm()}`],
        kind: /** @type {'mmx'} */ ('mmx') }))),
    ...[...MMX_OPS, ...XMM_ONLY, ...PACKED_FLOAT.filter(op=>!BY_MXCSR.has(op))].map(op=>(/** @type {Operands} */ o)=>({
        lines: [`${op} ${xmm()}, ${HALF_SOURCES.has(op) ? `qword ptr ${o.address()}`
            : `xmmword ptr ${o.address(16)}`}`],
        kind: /** @type {'sse'} */ ('sse') })),
    ...FLOAT_OPS.flatMap(op=>['ps', 'pd', 'ss', 'sd'].map(kind=>(/** @type {Operands} */ o)=>({
        lines: [`${op}${kind} ${xmm()}, ${kind === 'ss' ? `dword ptr ${o.address()}` : kind === 'sd'
            ? `qword ptr ${o.address()}` : `xmmword ptr ${o.address(16)}`}`],
        kind: /** @type {'sse'} */ ('sse') }))),
];

/**
 * The starting registers: pointers into the buffer, an index below 32, ESP
 * near the buffer's end, the rest of the interesting values.
 *
 * @param {{ pointers: Set<number>, index: number }} roles
 */
function startRegisters(roles){
    const regs = Array.from({ length: 8 }, ()=>interesting());
    for (const r of roles.pointers)
    {
        regs[r] = DATA_AT + 0x400 + below(0x100) * 16;
    }
    if (roles.index >= 0)
    {
        regs[roles.index] = below(32);
    }
    regs[4] = DATA_AT + 0x1e00 + below(0x40) * 4;
    return regs;
}

/** An XMM register's start: lanes of floats of every class, doubles, integers, raw bits. */
function xmmStart(){
    const bytes = Buffer.alloc(16);
    switch (below(5))
    {
        case 0:
            for (let i = 0; i < 4; i++)
            {
                bytes.writeUInt32LE(chance(8) ? (nanBits(chance(2))[1] & 0xfff80000
                    | random() & 0x7ffff) >>> 0
                    : floatBits(x87Value(!chance(4))), i * 4);
            }
            break;
        case 1:
            for (let i = 0; i < 2; i++)
            {
                const [lo, hi] = chance(8) ? nanBits(chance(2)) : doubleWords(x87Value(!chance(4)));
                bytes.writeUInt32LE(lo >>> 0, i * 8);
                bytes.writeUInt32LE(hi >>> 0, i * 8 + 4);
            }
            break;
        case 2:
            for (let i = 0; i < 4; i++)
            {
                bytes.writeUInt32LE(interesting(), i * 4);
            }
            break;
        default:
            for (let i = 0; i < 4; i++)
            {
                bytes.writeUInt32LE(random(), i * 4);
            }
    }
    return bytes.toString('hex');
}

/** An MMX register's start: the 64 bits, under the exponent an MMX write leaves. */
function mmxStart(){
    const low = BigInt(interesting()) | BigInt(interesting()) << 32n;
    return (0xffffn << 64n | low).toString(16).padStart(20, '0');
}

// Generation ------------------------------------------------------------------

/**
 * @typedef {{ text: string[], kind: string | undefined, regs: number[], flags: number,
 *     seed: number, x87?: { cw: number, sw: number, tw: number, st: string[] },
 *     mxcsr?: number, xmm?: string[] }} Draft
 */

/** @returns {Draft} */
function draft(){
    const made = makeCase();
    const regs = startRegisters(made.roles);
    // The status flags and DF at random, IF and bit 1 as a user program has them.
    const flags = 0x202 | (random() & 0xcd5);
    /** @type {Draft} */
    const one = { text: made.text, kind: made.kind, regs, flags, seed: random() || 1 };
    if (made.kind === 'x87')
    {
        one.x87 = x87Start({ plain: !made.wide, pc: made.pc, rc: made.rc });
    }
    else if (made.kind === 'mmx')
    {
        one.x87 = { cw: 0x37f, sw: below(8) << 11, tw: random() & 0xff,
            st: Array.from({ length: 8 }, ()=>mmxStart()) };
        one.xmm = Array.from({ length: 8 }, ()=>xmmStart());
    }
    if (made.kind === 'sse')
    {
        one.xmm = Array.from({ length: 8 }, ()=>xmmStart());
    }
    if (made.kind === 'sse' || made.kind === 'mmx')
    {
        one.mxcsr = 0x1f80 | made.mxrc << 13;
    }
    return one;
}

/** @param {string} command @param {string[]} args @param {Buffer} [input] */
function run(command, args, input){
    const result = spawnSync(command, args, { input, maxBuffer: 1 << 30 });
    if (result.error || result.status !== 0)
    {
        console.error(`${command} failed:`, result.error?.message ?? result.stderr.toString());
        process.exit(1);
    }
    return result.stdout;
}

/**
 * Assembles drafts, one label each; a draft llvm-mc refuses is reported and
 * dropped with every other line of its case.
 *
 * @param {Draft[]} drafts
 * @returns {(Buffer | null)[]}
 */
function assemble(drafts){
    const source = ['.intel_syntax noprefix', '.text'];
    /** @type {number[]} the case each source line belongs to */
    const owner = [-1, -1];
    drafts.forEach((one, n)=>{
        source.push(`case_${n}:`);
        owner.push(n);
        for (const line of one.text)
        {
            source.push(`    ${line}`);
            owner.push(n);
        }
    });
    source.push(`case_${drafts.length}:`, '    nop');
    const asm = join(work, 'cases.s');
    writeFileSync(asm, `${source.join('\n')}\n`);
    const object = join(work, 'cases.o');
    const result = spawnSync('llvm-mc', ['-triple', 'i386', '-filetype=obj',
        '-x86-asm-syntax=intel',
        asm, '-o', object], { maxBuffer: 1 << 30 });
    if (result.status !== 0)
    {
        const bad = new Set();
        for (const match of result.stderr.toString().matchAll(/cases\.s:(\d+):\d+: error: (.*)/g))
        {
            const n = owner[Number(match[1]) - 1];
            if (!bad.has(n))
            {
                console.error(`refused: ${drafts[n]?.text.join('; ')}: ${match[2]}`);
            }
            bad.add(n);
        }
        if (bad.size === 0)
        {
            console.error(result.stderr.toString());
            process.exit(1);
        }
        const kept = drafts.map((one, n)=>bad.has(n) ? { ...one, text: ['nop'] } : one);
        const again = assemble(kept);
        return again.map((code, n)=>bad.has(n) ? null : code);
    }
    const text = join(work, 'cases.bin');
    run('llvm-objcopy', ['-O', 'binary', '--only-section=.text', object, text]);
    const code = readFileSync(text);
    /** @type {Map<string, number>} */
    const offsets = new Map();
    for (const line of run('llvm-nm', [object]).toString().split('\n'))
    {
        const match = /^([0-9a-f]+) t (case_\d+)$/.exec(line);
        if (match)
        {
            offsets.set(match[2], parseInt(match[1], 16));
        }
    }
    return drafts.map((_, n)=>code.subarray(/** @type {number} */ (offsets.get(`case_${n}`)),
        /** @type {number} */ (offsets.get(`case_${n + 1}`))));
}

/**
 * The fxsave image a case starts from: control, status and abridged tag
 * words, MXCSR, ST(0)..ST(7) from the physical registers, XMM0-7.
 *
 * @param {Draft} one
 */
function fxsaveImage(one){
    const image = Buffer.alloc(512);
    const fpu = one.x87 ?? { cw: 0x37f, sw: 0, tw: 0, st: Array(8).fill('0'.repeat(20)) };
    image.writeUInt16LE(fpu.cw, 0);
    image.writeUInt16LE(fpu.sw, 2);
    image[4] = fpu.tw;
    image.writeUInt32LE(one.mxcsr ?? 0x1f80, 24);
    const top = fpu.sw >>> 11 & 7;
    for (let i = 0; i < 8; i++)
    {
        const bits = BigInt(`0x${fpu.st[(top + i) & 7]}`);
        image.writeBigUInt64LE(bits & 0xffffffffffffffffn, 32 + 16 * i);
        image.writeUInt16LE(Number(bits >> 64n), 32 + 16 * i + 8);
        if (one.xmm)
        {
            Buffer.from(one.xmm[i], 'hex').copy(image, 160 + 16 * i);
        }
    }
    return image;
}

/**
 * @typedef {{ regs: number[], eflags: number, eip: number, trapno: number, signal: number,
 *     fx: Buffer, tag: number, writes: number[][], trace: { eip: number, regs: number[],
 *     eflags: number }[] }} Ran
 */

/**
 * Runs cases on the processor in one mode.
 *
 * @param {Draft[]} drafts @param {Buffer[]} codes @param {number} mode
 * @returns {Ran[]}
 */
function runCases(runner, drafts, codes, mode){
    /** @type {Buffer[]} */
    const input = [];
    drafts.forEach((one, n)=>{
        const head = Buffer.alloc(8);
        head.writeUInt32LE(mode, 0);
        head.writeUInt32LE(codes[n].length, 4);
        const regs = Buffer.alloc(36);
        one.regs.forEach((value, i)=>regs.writeUInt32LE(value >>> 0, i * 4));
        regs.writeUInt32LE(one.flags, 32);
        const seed = Buffer.alloc(4);
        seed.writeUInt32LE(one.seed);
        input.push(head, codes[n], regs, fxsaveImage(one), seed);
    });
    const output = run(runner, [], Buffer.concat(input));
    let at = 0;
    return drafts.map(()=>{
        const words = Array.from({ length: 15 }, (_, i)=>output.readUInt32LE(at + i * 4));
        at += 60;
        const fx = output.subarray(at, at + 512);
        at += 512;
        const tag = output.readUInt32LE(at);
        at += 4;
        const changed = output.readUInt32LE(at);
        at += 4;
        /** @type {number[][]} */
        const writes = [];
        for (let i = 0; i < changed; i++)
        {
            writes.push([output.readUInt32LE(at), output[at + 4]]);
            at += 5;
        }
        const steps = output.readUInt32LE(at);
        at += 4;
        const trace = [];
        for (let i = 0; i < steps; i++)
        {
            trace.push({ eip: output.readUInt32LE(at),
                regs: Array.from({ length: 8 }, (_, r)=>output.readUInt32LE(at + 4 + r * 4)),
                eflags: output.readUInt32LE(at + 36) });
            at += 40;
        }
        return { regs: words.slice(0, 8), eflags: words[8], eip: words[9], trapno: words[10],
            signal: words[12], fx, tag, writes, trace };
    });
}

/** The string instructions, which a repeat with a zero count does not run. */
const STRING_OPS = new Set(['movs', 'stos', 'lods', 'cmps', 'scas']);
/** The shifts and rotates, which write no flag at a count of zero. */
const SHIFT_OPS = new Set(['shl', 'sal', 'shr', 'sar', 'rol', 'ror', 'rcl', 'rcr', 'shld', 'shrd']);
/** The x87 instructions that copy the condition codes somewhere a case's result shows. */
const READS_STATUS = new Set(['fnstsw', 'fnstenv', 'fnsave', 'fxsave']);

/**
 * The bytes of a saved FPU environment the model does not keep, by where it
 * is stored: the last x87 instruction's and operand's pointers and opcode
 * (FIP, FCS, FOP, FDP, FDS), and in an fxsave image MXCSR_MASK, where the
 * model answers that it has no DAZ. Offsets and lengths from the image's start.
 */
const UNKEPT = /** @type {Record<string, [number, number][]>} */ ({
    fnstenv: [[12, 14]],
    fnsave: [[12, 14]],
    fxsave: [[6, 8], [16, 6], [28, 4]],
});

/**
 * What the case leaves undefined, from the instructions the processor ran:
 * the EFLAGS bits and the x87 condition codes, and the buffer's spans the
 * model does not keep; or null when an instruction reads a flag or a code an
 * earlier one left undefined. An instruction cork's decoder refuses leaves
 * every flag and code undefined: the case stays, for the engine to fail on.
 *
 * @param {Buffer} code @param {Ran} traced @param {boolean} faulted
 * @returns {{ flags: number, status: number, ignored: number[][], kind: string | undefined,
 *     transcendental: boolean } | null}
 */
function analyse(code, traced, faulted){
    const end = CODE_AT + code.length;
    /** @param {number} address */
    const read = address=>address >= CODE_AT && address < end ? code[address - CODE_AT]
        : address === end ? 0xf4 : 0;
    let flags = 0;
    let status = 0;
    /** @type {number[][]} */
    const ignored = [];
    // What the case ran, for how its x87 registers are compared: an MMX
    // instruction makes them integers.
    let ranMmx = false;
    let ranX87 = false;
    let simd = false;
    let ranTranscendental = false;
    const steps = traced.trace.filter((step, i, all)=>step.eip !== end
        && (i === 0 || all[i - 1].eip !== step.eip || !STRING_OPS.has(decodeOp(read, step.eip))));
    const ran = faulted ? steps.slice(0, -1) : steps;
    for (const step of ran)
    {
        const instruction = decode(read, step.eip);
        if ('refused' in instruction)
        {
            flags = CF | 0x4 | 0x10 | ZF | 0x80 | OF;
            status = 0x4700;
            continue;
        }
        const op = instruction.op;
        ranMmx ||= op === 'emms' || instruction.operands.some(operand=>operand.kind === 'mm');
        ranX87 ||= isX87Opcode(instruction.opcode);
        ranTranscendental ||= TRANSCENDENTAL.has(op);
        simd ||= instruction.operands.some(operand=>operand.kind === 'xmm');
        if ((instruction.flagsRead & flags) !== 0)
        {
            return null;
        }
        if (READS_STATUS.has(op) && status !== 0)
        {
            return null;
        }
        let writes = true;
        if (SHIFT_OPS.has(op))
        {
            const operand = instruction.operands[instruction.operands.length - 1];
            const count = operand.kind === 'imm' ? Number(operand.value) : step.regs[1] & 0xff;
            writes = (count & 31) !== 0;
        }
        else if (STRING_OPS.has(op) && (instruction.prefixes.rep || instruction.prefixes.repne))
        {
            writes = step.regs[1] !== 0;
        }
        if (writes)
        {
            const defined = instruction.flagsWritten & ~instruction.flagsUndefined;
            flags = flags & ~defined | instruction.flagsUndefined;
        }
        status = statusAfter(op, status);
        const spans = UNKEPT[op];
        if (spans !== undefined)
        {
            const operand = instruction.operands[0];
            const at = ((operand.base ?? -1) >= 0 ? step.regs[/** @type {number} */ (operand.base)] : 0)
                + ((operand.index ?? -1) >= 0
                    ? step.regs[/** @type {number} */ (operand.index)] * (operand.scale ?? 1) : 0)
                + (operand.disp ?? 0) - DATA_AT >>> 0;
            for (const [offset, length] of spans)
            {
                ignored.push([at + offset, length]);
            }
        }
    }
    return { flags: flags & (CF | 0x4 | 0x10 | ZF | 0x80 | OF | DF), status, ignored,
        kind: ranMmx ? 'mmx' : ranX87 ? 'x87' : simd ? 'sse' : undefined,
        transcendental: ranTranscendental };
}

/** @param {(address: number) => number} read @param {number} eip */
function decodeOp(read, eip){
    const instruction = decode(read, eip);
    return 'refused' in instruction ? '' : instruction.op;
}

/**
 * The vectors a case may end with besides the `hlt` that ends every case. Not
 * #PF: an access the runner's pages refuse is one past the buffer, where the
 * engines' memory is not the runner's, so the case says nothing; it is drawn
 * again.
 */
const VECTORS = new Set([0, 6, 13, 16, 17, 19]);

const runner = join(work, 'runner32');
run('clang', ['-m32', '-nostdlib', '-static', '-ffreestanding', '-fno-pic', '-fno-builtin', '-O1',
    '-fuse-ld=lld', '-Wl,--image-base=0x20000000', '-o', runner,
    join(ROOT, 'tools/x86-corpus/runner32.c')]);

/** @type {object[]} */
const cases = [];
let drawn = 0;
let redrawn = 0;
while (cases.length < CASES)
{
    const batch = Array.from({ length: Math.min(4000, (CASES - cases.length) * 1.2 + 16 | 0) },
        ()=>draft());
    drawn += batch.length;
    const codes = assemble(batch);
    const kept = batch.filter((_, n)=>codes[n] !== null);
    const keptCodes = /** @type {Buffer[]} */ (codes.filter(code=>code !== null));
    const results = runCases(runner, kept, keptCodes, 0);
    const traces = runCases(runner, kept, keptCodes, 1);
    kept.forEach((one, n)=>{
        if (cases.length >= CASES)
        {
            return;
        }
        const code = keptCodes[n];
        const result = results[n];
        const end = CODE_AT + code.length;
        const ended = result.trapno === 13 && result.eip === end;
        if (!ended && (!VECTORS.has(result.trapno) || result.signal === 14))
        {
            redrawn++;
            return;
        }
        if (traces[n].eip !== result.eip || traces[n].trapno !== result.trapno)
        {
            redrawn++;
            return;
        }
        const left = analyse(code, traces[n], !ended);
        if (left === null)
        {
            redrawn++;
            return;
        }
        cases.push(record(one, code, result, left, ended));
    });
}

/**
 * A case as the corpus keeps it: its text and bytes, the state it starts from,
 * and what the processor left.
 *
 * @param {Draft} one @param {Buffer} code @param {Ran} result
 * @param {{ flags: number, status: number, ignored: number[][], kind: string | undefined,
 *     transcendental: boolean }} left
 * @param {boolean} ended
 */
function record(one, code, result, left, ended){
    const fx = result.fx;
    const top = fx.readUInt16LE(2) >>> 11 & 7;
    const st = Array.from({ length: 8 }, (_, physical)=>{
        const i = (physical - top) & 7;
        const low = fx.readBigUInt64LE(32 + 16 * i);
        const high = BigInt(fx.readUInt16LE(32 + 16 * i + 8));
        return (high << 64n | low).toString(16).padStart(20, '0');
    });
    const xmmAfter = Array.from({ length: 8 }, (_, i)=>fx.subarray(160 + 16 * i, 176
        + 16 * i).toString('hex'));
    const startXmm = one.xmm ?? Array(8).fill('0'.repeat(32));
    /** @type {Record<number, string>} */
    const xmmChanged = {};
    xmmAfter.forEach((value, i)=>{
        if (value !== startXmm[i])
        {
            xmmChanged[i] = value;
        }
    });
    const out = {
        regs: result.regs,
        flags: result.eflags & 0xffff,
        ...ended ? {} : { vector: result.trapno, at: result.eip - CODE_AT },
        x87: { cw: fx.readUInt16LE(0), sw: fx.readUInt16LE(2), tag: result.tag, st },
        mxcsr: fx.readUInt32LE(24),
        ...Object.keys(xmmChanged).length > 0 ? { xmm: xmmChanged } : {},
        writes: result.writes,
        ...left.flags !== 0 ? { undefinedFlags: left.flags } : {},
        ...left.status !== 0 ? { undefinedStatus: left.status } : {},
        ...left.ignored.length > 0 ? { ignored: left.ignored } : {},
        ...left.transcendental ? { transcendental: true } : {},
    };
    // An untouched FPU is not repeated.
    const startFx = fxsaveImage(one);
    if (fx.subarray(0, 4).equals(startFx.subarray(0, 4)) && fx.subarray(32,
        160).equals(startFx.subarray(32, 160))
        && (result.tag & 0xffff) === tagOfStart(one))
    {
        delete /** @type {any} */ (out).x87;
    }
    if (out.mxcsr === (one.mxcsr ?? 0x1f80))
    {
        delete /** @type {any} */ (out).mxcsr;
    }
    return {
        text: one.text.join('; '),
        code: code.toString('hex'),
        ...left.kind ? { kind: left.kind } : {},
        regs: one.regs,
        flags: one.flags,
        seed: one.seed,
        ...one.x87 ? { x87: one.x87 } : {},
        ...one.mxcsr !== undefined && one.mxcsr !== 0x1f80 ? { mxcsr: one.mxcsr } : {},
        ...one.xmm ? { xmm: one.xmm } : {},
        out,
    };
}

/** The full tag word of a draft's start, as the processor derives it, for an unchanged FPU. @param {Draft} one */
function tagOfStart(one){
    if (!one.x87)
    {
        return 0xffff;
    }
    let tag = 0;
    for (let k = 0; k < 8; k++)
    {
        let field = 3;
        if ((one.x87.tw >>> k & 1) !== 0)
        {
            const bits = BigInt(`0x${one.x87.st[k]}`);
            const exponent = Number(bits >> 64n & 0x7fffn);
            const mantissa = bits & 0xffffffffffffffffn;
            field = exponent === 0x7fff || (exponent === 0 && mantissa !== 0n) || (exponent !== 0
                && (mantissa >> 63n) === 0n) ? 2
                : exponent === 0 ? 1 : 0;
        }
        tag |= field << (2 * k);
    }
    return tag;
}

void X87_STATUS;
void fillData;
const document = { codeAt: CODE_AT, dataAt: DATA_AT, dataSize: DATA_SIZE, seed: SEED, cases };
const packed = gzipSync(JSON.stringify(document), { level: 9 });
writeFileSync(OUT, packed);
const faults = cases.filter(one=>/** @type {any} */ (one).out.vector !== undefined).length;
console.log(`${cases.length} cases (${faults} fault; ${drawn} drawn, ${redrawn} drawn again)`
    + ` -> ${OUT}`
    + ` (${packed.length} bytes, ${((Date.now() - started) / 1000).toFixed(1)} s)`);
