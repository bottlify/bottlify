/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The 64-bit corpus: random x86-64 instruction sequences run on this
 * processor, with what they did, for the 64-bit reference model to be judged
 * by (`modules/cork/src/ir64-corpus.test.js`).
 *
 *   node tools/x64-corpus.mjs [cases] [seed] [out]
 *
 * Each case is one to four instructions drawn from templates of the integer
 * set (arithmetic, shifts, bit tests, multiplies and divides, moves and
 * extensions, exchanges, the string operations, the stack, flag
 * instructions, short branches) at every operand width, assembled by
 * llvm-mc, with random starting registers and flags. Its memory is 8 KiB at
 * 0x10000000 (below 4 GiB, as the engine's window is) filled from the case's
 * seed; RBX, RSI, RDI and RBP point into it and R12 and R13 hold small
 * indexes, so memory operands land in it; RSP is near its end. The runner
 * (`x64-corpus/runner.c`, built here with clang) runs the cases natively and
 * reports the registers, the status flags, the bytes of the buffer that
 * changed, and a fault's signal and address with the registers as they stood
 * before the faulting instruction.
 *
 * Needs an x86-64 Linux host with clang, llvm-mc and llvm-objcopy. Writes
 * `modules/cork/src/x64-corpus.json.gz`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CASES = Number(process.argv[2] ?? 4000);
let state = Number(process.argv[3] ?? 0x5eed) >>> 0 || 1;
const OUT = process.argv[4] ?? join(ROOT, 'modules/cork/src/x64-corpus.json.gz');
if (platform() !== 'linux' || arch() !== 'x64')
{
    console.error('the corpus runs natively: an x86-64 Linux host is needed');
    process.exit(1);
}
const work = mkdtempSync(join(tmpdir(), 'x64-corpus-'));

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
/** @template T @param {T[]} list @returns {T} */
const pick = list=>list[below(list.length)];

const DATA_AT = 0x10000000n;
/** The xmm registers start from the case's seed with these bits flipped, as the runner's do. */
const XMM_SEED = 0x9e3779b9;

/**
 * Bytes from a seed, as the runner makes the data and the xmm registers:
 * xorshift32, the low byte each step.
 *
 * @param {number} size @param {number} seed
 */
function fill(size, seed){
    const out = Buffer.alloc(size);
    let x = seed >>> 0 || 1;
    for (let i = 0; i < size; i++)
    {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        out[i] = x & 0xff;
    }
    return out;
}
const CODE_AT = 0x20000000n;

/** The registers by width; the data ones are the ones written. */
const NAMES = {
    8: ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11', 'r12',
        'r13', 'r14', 'r15'],
    4: ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'r8d', 'r9d', 'r10d', 'r11d',
        'r12d', 'r13d', 'r14d', 'r15d'],
    2: ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di', 'r8w', 'r9w', 'r10w', 'r11w', 'r12w',
        'r13w', 'r14w', 'r15w'],
    1: ['al', 'cl', 'dl', 'bl', 'spl', 'bpl', 'sil', 'dil', 'r8b', 'r9b', 'r10b', 'r11b', 'r12b',
        'r13b', 'r14b', 'r15b'],
};
const DATA = [0, 1, 2, 8, 9, 10, 11, 14, 15];
const POINTERS = [3, 5, 6, 7];
const INDEXES = [12, 13];
const PTR = { 1: 'byte', 2: 'word', 4: 'dword', 8: 'qword', 16: 'xmmword' };
const SIZES = [1, 2, 4, 8];

/** @param {number} size */
const reg = size=>{
    // ah..bh now and then, where no REX register is in the instruction: the
    // caller asks for those apart (`high`).
    return NAMES[size][pick(DATA)];
};
/** @param {number} size @param {number} [align] */
const mem = (size, align = 1)=>{
    const base = NAMES[8][pick(POINTERS)];
    const disp = (below(16) * 8) & ~(align - 1);
    switch (below(4))
    {
        case 0: return `${PTR[size]} ptr [${base} + ${disp}]`;
        case 1: return `${PTR[size]} ptr [${base} + ${scaled(8)} + ${disp}]`;
        case 2: return `${PTR[size]} ptr [${base} - ${disp}]`;
        default: return `${PTR[size]} ptr [${base}]`;
    }
};
/** An index register times a scale, at `width` bytes. @param {number} width */
const scaled = width=>`${pick([1, 2, 4, 8])}*${NAMES[width][pick(INDEXES)]}`;
/** @param {number} size */
const rm = size=>(below(3) === 0 ? mem(size) : reg(size));
/** @param {number} size */
const imm = size=>{
    const value = random() | 0;
    switch (size)
    {
        case 1: return String(value & 0xff);
        case 2: return String(value & 0xffff);
        default: return below(3) === 0 ? String((value & 0xff) - 128) : String(value);
    }
};

const ARITH = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];
const SHIFTS = ['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'sar'];
const CONDITIONS = ['o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge',
    'le', 'g'];

/** One instruction's text (or a few, where one needs a set-up). @returns {string[]} */
function instruction(){
    return below(5) < 3 ? integer() : vector();
}

/** An integer instruction. @returns {string[]} */
function integer(){
    const size = pick(SIZES);
    const wide = pick([2, 4, 8]);
    switch (below(30))
    {
        case 0: case 1: case 2:
        {
            const op = pick(ARITH);
            switch (below(4))
            {
                case 0: return [`${op} ${rm(size)}, ${reg(size)}`];
                case 1: return [`${op} ${reg(size)}, ${mem(size)}`];
                case 2: return [`${op} ${rm(size)}, ${imm(size)}`];
                default: return [`${op} ${NAMES[size][0]}, ${imm(size)}`];
            }
        }
        case 3: return [`${pick(['inc', 'dec', 'neg', 'not'])} ${rm(size)}`];
        case 4: return [`test ${rm(size)}, ${below(2) ? reg(size) : imm(size)}`];
        case 5:
            switch (below(3))
            {
                case 0: return [`${pick(['mul', 'imul'])} ${rm(size)}`];
                case 1: return [`imul ${reg(wide)}, ${rm(wide)}`];
                default: return [`imul ${reg(wide)}, ${rm(wide)}, ${imm(wide === 2 ? 2 : 4)}`];
            }
        case 6:
        {
            // A divisor of at least 0x100 and a small high half, so most divide.
            const divisor = NAMES[size][pick([1, 3, 8, 9])];
            const setup = size === 1 ? ['mov ah, 0'] : [`xor ${NAMES[size][2]}, ${NAMES[size][2]}`];
            const wider = NAMES[Math.max(size, 2)][NAMES[size].indexOf(divisor)];
            return [...(below(4) ? setup : []), `or ${wider}, 0x100`,
                `${pick(['div', 'idiv'])} ${divisor}`];
        }
        case 7: case 8:
        {
            const op = pick(SHIFTS);
            switch (below(3))
            {
                case 0: return [`${op} ${rm(size)}, 1`];
                case 1: return [`${op} ${rm(size)}, ${below(70)}`];
                default: return [`${op} ${rm(size)}, cl`];
            }
        }
        case 9:
            // A word shifted 16 or more is left undefined: words take counts below 16.
            return [`${pick(['shld', 'shrd'])} ${rm(wide)}, ${reg(wide)}, ${wide === 2 ? below(16)
                : below(2) ? below(70) : 'cl'}`];
        case 10:
        {
            const op = pick(['bt', 'bts', 'btr', 'btc']);
            switch (below(3))
            {
                case 0: return [`${op} ${reg(wide)}, ${reg(wide)}`];
                case 1: return [`${op} ${rm(wide)}, ${below(80)}`];
                // A register bit offset reaches past the operand: kept small.
                default:
                    return [`and ${NAMES[wide][1]}, 127`, `${op} ${mem(wide)}, ${NAMES[wide][1]}`];
            }
        }
        case 11: return [`${pick(['bsf', 'bsr', 'popcnt'])} ${reg(wide)}, ${rm(wide)}`];
        case 12:
            switch (below(5))
            {
                case 0: return [`movzx ${reg(pick([2, 4, 8]))}, ${rm(1)}`];
                case 1: return [`movsx ${reg(pick([2, 4, 8]))}, ${rm(1)}`];
                case 2: return [`${pick(['movzx', 'movsx'])} ${reg(pick([4, 8]))}, ${rm(2)}`];
                case 3: return [`movsxd ${reg(8)}, ${rm(4)}`];
                default: return [`mov ${rm(size)}, ${below(2) ? reg(size) : imm(size)}`];
            }
        case 13:
            switch (below(4))
            {
                case 0: return [`movabs ${reg(8)}, ${BigInt.asIntN(64, wide64())}`];
                case 1: return [`mov ${reg(size)}, ${mem(size)}`];
                case 2: return [`mov ${reg(8)}, qword ptr [rip + ${below(8)}]`];
                default: return [`mov ${reg(4)}, ${imm(4)}`];
            }
        case 14:
        {
            // With the address-size prefix the address is 32 bits wide.
            const width = below(4) === 0 ? 4 : 8;
            const parts = [NAMES[width][pick(POINTERS)], scaled(width), String(below(256) - 128)];
            return [`lea ${reg(pick([4, 8]))}, [${parts.slice(0, 1 + below(3)).join(' + ')}]`];
        }
        case 15:
            switch (below(4))
            {
                case 0: return [`xchg ${rm(size)}, ${reg(size)}`];
                case 1: return [`${below(2) ? 'lock ' : ''}xadd ${mem(size)}, ${reg(size)}`];
                case 2: return [`${below(2) ? 'lock ' : ''}cmpxchg ${rm(size)}, ${reg(size)}`];
                default: return [below(2) ? `cmpxchg8b ${mem(8)}` : `cmpxchg16b ${mem(16, 16)}`];
            }
        case 16: return [`bswap ${reg(pick([4, 8]))}`];
        case 17: return [`cmov${pick(CONDITIONS)} ${reg(wide)}, ${rm(wide)}`];
        case 18: return [`set${pick(CONDITIONS)} ${rm(1)}`];
        case 19: return [pick(['cbw', 'cwde', 'cdqe', 'cwd', 'cdq', 'cqo'])];
        case 20:
            switch (below(5))
            {
                case 0: return [`push ${NAMES[8][pick(DATA)]}`, `pop ${NAMES[8][pick(DATA)]}`];
                case 1: return [`push ${imm(4)}`, `pop qword ptr [${NAMES[8][pick(POINTERS)]}]`];
                case 2:
                    return [`push qword ptr [${NAMES[8][pick(POINTERS)]}]`,
                        `pop ${NAMES[8][pick(DATA)]}`];
                case 3: return [`push ${NAMES[2][pick(DATA)]}`, `pop ${NAMES[2][pick(DATA)]}`];
                // A flags word of the status flags only: no trap, no alignment check.
                default:
                    return [`push ${random() & 0x8d5}`, 'popfq', 'pushfq',
                        `pop ${NAMES[8][pick(DATA)]}`];
            }
        case 21: return [pick(['lahf', 'sahf', 'clc', 'stc', 'cmc', 'cld', 'std'])];
        case 22: case 23:
        {
            const letter = { 1: 'b', 2: 'w', 4: 'd', 8: 'q' }[size];
            const op = pick(['movs', 'stos', 'lods', 'cmps', 'scas']);
            const prefix = op === 'cmps' || op === 'scas'
                ? pick(['', 'repe ', 'repne ']) : pick(['', 'rep ']);
            return [`mov ecx, ${below(9)}`, `${prefix}${op}${letter}`];
        }
        case 24:
        {
            const cc = pick(CONDITIONS);
            return [`j${cc} 1f`, `add ${reg(4)}, 1`, '1:'];
        }
        case 25: return ['call 1f', '1:', `pop ${NAMES[8][pick(DATA)]}`];
        case 26: return [`mov ecx, ${below(4)}`,
            `${pick(['jrcxz', 'jecxz', 'loop', 'loope', 'loopne'])} 1f`,
            `inc ${reg(8)}`, '1:'];
        case 27: return [`${pick(ARITH)} ${reg(8)}, ${imm(4)}`];
        case 28: return [`${pick(SHIFTS)} ${reg(8)}, ${below(2) ? 'cl' : below(64)}`];
        default: return [`lea ${reg(8)}, [rip + ${below(64)}]`];
    }
}

const FLOAT_OPS = ['add', 'sub', 'mul', 'div', 'min', 'max', 'sqrt'];
const LOGIC = ['and', 'andn', 'or', 'xor'];
const PACKED = ['paddb', 'paddw', 'paddd', 'paddq', 'paddsb', 'paddsw', 'paddusb', 'paddusw',
    'psubb', 'psubw', 'psubd', 'psubq', 'psubsb', 'psubsw', 'psubusb', 'psubusw', 'pand', 'pandn',
    'por', 'pxor', 'pcmpeqb', 'pcmpeqw', 'pcmpeqd', 'pcmpgtb', 'pcmpgtw', 'pcmpgtd', 'pmullw',
    'pmulhw', 'pmulhuw', 'pmuludq', 'pmaddwd', 'pminub', 'pmaxub', 'pminsw', 'pmaxsw', 'pavgb',
    'pavgw', 'psadbw', 'packsswb', 'packuswb', 'packssdw', 'punpcklbw', 'punpcklwd', 'punpckldq',
    'punpcklqdq', 'punpckhbw', 'punpckhwd', 'punpckhdq', 'punpckhqdq', 'unpcklps', 'unpckhps',
    'unpcklpd', 'unpckhpd', 'addsubps', 'addsubpd', 'haddps', 'haddpd', 'hsubps', 'hsubpd',
    'cvtdq2ps', 'cvtps2dq', 'cvttps2dq', 'cvtdq2pd', 'cvtpd2dq', 'cvttpd2dq', 'cvtps2pd',
    'cvtpd2ps', 'movddup', 'movshdup', 'movsldup', 'psllw', 'pslld', 'psllq', 'psrlw', 'psrld',
    'psrlq', 'psraw', 'psrad'];
/** The packed operations whose memory source is eight bytes. */
const HALF_SOURCES = new Set(['movddup', 'cvtdq2pd', 'cvtps2pd']);
const MOVES = ['movaps', 'movups', 'movapd', 'movupd', 'movdqa', 'movdqu'];

/** An xmm register. */
const xmm = ()=>`xmm${below(16)}`;
/** A 16-byte memory operand, 16-byte aligned. */
const aligned = ()=>`xmmword ptr [${NAMES[8][pick(POINTERS)]} + ${below(8) * 16}]`;

/** An SSE, SSE2 or SSE3 instruction, of the kinds a compiler emits. @returns {string[]} */
function vector(){
    const kind = pick(['ps', 'pd', 'ss', 'sd']);
    const scalarMemory = kind === 'ss' ? mem(4) : kind === 'sd' ? mem(8) : aligned();
    switch (below(16))
    {
        case 0: case 1:
            return [`${pick(FLOAT_OPS)}${kind} ${xmm()}, ${below(3) ? xmm() : scalarMemory}`];
        case 2:
        {
            const source = below(3) ? xmm() : aligned();
            return [`${pick(LOGIC)}${pick(['ps', 'pd'])} ${xmm()}, ${source}`];
        }
        case 3: return [`cmp${kind} ${xmm()}, ${below(3) ? xmm() : scalarMemory}, ${below(8)}`];
        case 4: return [`${pick(['comi', 'ucomi'])}${pick(['ss', 'sd'])} ${xmm()}, ${xmm()}`];
        case 5:
        {
            // Small integers in, so the arithmetic after them has ordinary numbers.
            const width = pick([4, 8]);
            return [`cvtsi2${pick(['ss', 'sd'])} ${xmm()}, ${below(3) ? reg(width) : mem(width)}`];
        }
        case 6:
            return [`${pick(['cvt', 'cvtt'])}${pick(['ss', 'sd'])}2si ${reg(pick([4, 8]))},`
                + ` ${xmm()}`];
        case 7: return [`${pick(['cvtss2sd', 'cvtsd2ss'])} ${xmm()}, ${xmm()}`];
        case 8: case 9:
        {
            const op = pick(PACKED);
            const at = HALF_SOURCES.has(op) ? aligned().replace('xmmword', 'qword') : aligned();
            return [`${op} ${xmm()}, ${below(4) ? xmm() : at}`];
        }
        case 10:
            return [`${pick(['psllw', 'pslld', 'psllq', 'psrlw', 'psrld', 'psrlq', 'psraw', 'psrad',
                'pslldq', 'psrldq'])} ${xmm()}, ${below(20)}`];
        case 11:
            return [`${pick(['pshufd', 'pshuflw', 'pshufhw', 'shufps', 'shufpd'])} ${xmm()},`
                + ` ${xmm()}, ${below(256)}`];
        case 12:
            switch (below(4))
            {
                case 0: return [`${pick(MOVES)} ${xmm()}, ${below(2) ? xmm() : aligned()}`];
                case 1: return [`${pick(MOVES)} ${aligned()}, ${xmm()}`];
                case 2: return [`${pick(['movss', 'movsd'])} ${xmm()}, ${xmm()}`];
                default:
                {
                    const op = pick(['movss', 'movsd']);
                    const at = op === 'movss' ? mem(4) : mem(8);
                    return [below(2) ? `${op} ${xmm()}, ${at}` : `${op} ${at}, ${xmm()}`];
                }
            }
        case 13:
            switch (below(5))
            {
                case 0: return [`movd ${xmm()}, ${below(2) ? reg(4) : mem(4)}`];
                case 1: return [`movd ${below(2) ? reg(4) : mem(4)}, ${xmm()}`];
                case 2: return [`movq ${xmm()}, ${pick([reg(8), mem(8), xmm()])}`];
                case 3: return [`movq ${below(2) ? reg(8) : mem(8)}, ${xmm()}`];
                default: return [`${pick(['movhps', 'movlps', 'movhpd', 'movlpd'])} ${below(2)
                    ? `${xmm()}, ${mem(8)}` : `${mem(8)}, ${xmm()}`}`];
            }
        case 14:
            switch (below(4))
            {
                case 0:
                    return [`${pick(['pmovmskb', 'movmskps', 'movmskpd'])} ${reg(4)}, ${xmm()}`];
                case 1: return [`pextrw ${reg(4)}, ${xmm()}, ${below(8)}`];
                case 2: return [`pinsrw ${xmm()}, ${below(2) ? reg(4) : mem(2)}, ${below(8)}`];
                default: return [`${pick(['movhlps', 'movlhps'])} ${xmm()}, ${xmm()}`];
            }
        default:
            return [`lddqu ${xmm()}, xmmword ptr [${NAMES[8][pick(POINTERS)]} + ${below(64)}]`];
    }
}

/** A random 64-bit value as a BigInt. */
function wide64(){
    return BigInt(random()) << 32n | BigInt(random());
}

/** @type {{ text: string[], regs: bigint[], flags: number, seed: number }[]} */
const cases = [];
for (let n = 0; n < CASES; n++)
{
    const count = 1 + below(4);
    /** @type {string[]} */
    const text = [];
    for (let i = 0; i < count; i++)
    {
        text.push(...instruction());
    }
    const regs = Array.from({ length: 16 }, ()=>wide64());
    for (const index of POINTERS)
    {
        regs[index] = DATA_AT + BigInt(0x400 + below(0x40) * 16);
    }
    for (const index of INDEXES)
    {
        regs[index] = BigInt(below(0x20));
    }
    regs[4] = DATA_AT + 0x1f00n;
    // The six status flags and DF at random, bit 1 always set.
    const flags = 0x2 | (random() & 0xcd5);
    cases.push({ text, regs, flags, seed: random() || 1 });
}

// One file, a label a case, its end found from the next one.
const source = ['.intel_syntax noprefix', '.text'];
cases.forEach((one, n)=>{
    source.push(`case_${n}:`, ...one.text.map(line=>`    ${line}`));
});
source.push(`case_${cases.length}:`, '    nop');
const asm = join(work, 'cases.s');
writeFileSync(asm, `${source.join('\n')}\n`);

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
const object = join(work, 'cases.o');
run('llvm-mc', ['-triple', 'x86_64', '-filetype=obj', '-x86-asm-syntax=intel', asm, '-o', object]);
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

const runner = join(work, 'runner');
run('clang', ['-O1', '-o', runner, join(ROOT, 'tools/x64-corpus/runner.c')]);

/** @type {Buffer[]} */
const input = [];
const bytesOf = cases.map((_, n)=>code.subarray(/** @type {number} */ (offsets.get(`case_${n}`)),
    /** @type {number} */ (offsets.get(`case_${n + 1}`))));
cases.forEach((one, n)=>{
    const head = Buffer.alloc(4);
    head.writeUInt32LE(bytesOf[n].length);
    const regs = Buffer.alloc(17 * 8);
    one.regs.forEach((value, i)=>regs.writeBigUInt64LE(value, i * 8));
    regs.writeBigUInt64LE(BigInt(one.flags), 16 * 8);
    const seed = Buffer.alloc(4);
    seed.writeUInt32LE(one.seed);
    input.push(head, bytesOf[n], regs, seed);
});
const output = run(runner, [], Buffer.concat(input));

let at = 0;
const results = cases.map((one, n)=>{
    const regs = [];
    for (let i = 0; i < 16; i++)
    {
        regs.push(output.readBigUInt64LE(at + i * 8).toString(16));
    }
    const flags = Number(output.readBigUInt64LE(at + 128));
    at += 136;
    // Of the xmm registers, only those that changed from what the seed gave.
    const start = fill(256, one.seed ^ XMM_SEED);
    /** @type {Record<number, string>} */
    const xmms = {};
    for (let i = 0; i < 16; i++)
    {
        const after = output.subarray(at + i * 16, at + i * 16 + 16);
        if (!after.equals(start.subarray(i * 16, i * 16 + 16)))
        {
            xmms[i] = after.toString('hex');
        }
    }
    at += 256;
    const signal = output.readUInt32LE(at);
    const faultAt = output.readBigUInt64LE(at + 4);
    at += 12;
    const changed = output.readUInt32LE(at);
    at += 4;
    /** @type {number[][]} */
    const writes = [];
    for (let i = 0; i < changed; i++)
    {
        writes.push([output.readUInt32LE(at), output[at + 4]]);
        at += 5;
    }
    return {
        text: one.text.join('; '),
        code: bytesOf[n].toString('hex'),
        regs: one.regs.map(value=>value.toString(16)),
        flags: one.flags,
        seed: one.seed,
        out: { regs, flags, xmm: xmms, signal, ...signal ? { at: Number(faultAt - CODE_AT) } : {},
            writes },
    };
});
writeFileSync(OUT, gzipSync(JSON.stringify({ dataAt: Number(DATA_AT), dataSize: 0x2000,
    codeAt: Number(CODE_AT), codeSize: 0x10000, xmmSeed: XMM_SEED, cases: results }),
{ level: 9 }));
const faults = results.filter(one=>one.out.signal !== 0).length;
console.log(`${results.length} cases (${faults} fault) -> ${OUT}`
    + ` (${readFileSync(OUT).length} bytes)`);
