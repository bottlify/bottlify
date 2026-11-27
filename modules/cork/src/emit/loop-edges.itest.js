/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A loop's ways out beside the interpreter: the back edge that finds the
 * budget spent, the fault of a store, a store into code, the end of the turns
 * a hoisted loop's test cleared -- whose unchecked copy counts its turns on
 * the budget and runs two a wasm turn (`emitHoistedLoop`). Seeded programs of
 * loops of one block and of several -- store streams moving by a stride
 * (hoisted, `planLoop`), RAM's end at the turn after a window's last, carry
 * chains whose head reads the flags the turn before left (`adc` after `add`),
 * heads that write them first, compares owing their result to the branch,
 * pointers the data moves, registers alone, x87 -- run under budgets from a
 * few instructions to a million a turn, some streams running off the end of
 * RAM into the fault. Each runs translated and interpreted, and the two must
 * stop the same way with the same instruction count, registers and memory,
 * and with the same flags where the program halts (a way out to code that
 * writes the flags first leaves an empty record, so a fault's context is not
 * promised them).
 * Beside them: loop bodies of blocks that charge the count of the block before
 * them (`planCarries` in region.js), stopped at a limit and compared with the
 * interpreter run to the count they report; and a narrow register write
 * widened soon after (`widenedNext` in integer.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from '../machine.js';

const CODE = 0x401000;
const DATA = 0x500000;
const SOURCE = 0x600000;
const STACK = 0xf00000;
/** RAM's end: a stream that reaches it faults (#GP) at its first store past it. */
const END = 16 << 20;
const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip'];
const CHUNKS = [7, 23, 60, 250, 5000, 1_000_000, 1_000_000, 1_000_000];

/** @param {number} value */
const le = value=>[value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff, value >>> 24];

/** @param {number} seed */
function random(seed){
    let state = seed >>> 0;
    /** @param {number} n */
    return n=>{
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return (state >>> 8) % n;
    };
}

/**
 * One loop, its start at `code.length`: a body that ends in `dec ecx; jnz`
 * back to it, of one block or of several.
 *
 * @param {(n: number) => number} pick @param {number[]} code
 * @param {{ stride: number }} shape
 */
function loop(pick, code, { stride }){
    const kind = [0, 0, 1, 2, 3, 4, 4, 5, 6, 7, 7, 8, 8][pick(13)];
    if (kind >= 7)
    {
        code.push(0xd9, 0xe8); // fld1: what the loop keeps in st0
    }
    const head = code.length;
    const step = stride < 0 ? [0x83, 0xef, -stride] : [0x83, 0xc7, stride]; // sub/add edi, |stride|
    if (kind === 0)
    {
        // A store stream: stores off edi, the data moved between them.
        for (let k = 1 + pick(3); k > 0; k--)
        {
            const disp = pick(3) * 4;
            const form = pick(4);
            if (form === 0)
            {
                code.push(0x88, 0x47, disp); // mov [edi+disp], al
            }
            else if (form === 1)
            {
                code.push(0x8b, 0x06, 0x89, 0x47, disp); // mov eax, [esi]; mov [edi+disp], eax
            }
            else
            {
                code.push(0x89, 0x47, disp); // mov [edi+disp], eax
            }
            code.push(...[[0x01, 0xd0], [0x31, 0xd0], [0x6b, 0xc0, 0x05]][pick(3)]); // add/xor/imul eax
        }
        code.push(...step);
        if (pick(2))
        {
            code.push(0x83, 0xc6, 0x04); // add esi, 4
        }
    }
    else if (kind === 1)
    {
        // A carry chain: the head's adc reads the carry the turn before left.
        code.push(pick(2) ? 0x13 : 0x1b, 0x06); // adc / sbb eax, [esi]
        code.push(0x8d, 0x76, 0x04); // lea esi, [esi+4]
        if (pick(2))
        {
            code.push(0x89, 0x07, ...step); // mov [edi], eax; add edi, stride
        }
    }
    else if (kind === 2)
    {
        // Two blocks, the head writing the flags first.
        code.push(0x03, 0x06, 0x73, 0x01, 0x42); // add eax, [esi]; jnc +1; inc edx
        code.push(0x83, 0xc6, 0x04, 0x89, 0x07, ...step); // add esi, 4; mov [edi], eax; step
    }
    else if (kind === 3)
    {
        // Two blocks, the head reading the carry of the turn before.
        code.push(0x83, 0xd2, 0x00); // adc edx, 0
        code.push(0x03, 0x06, 0x8d, 0x76, 0x04); // add eax, [esi]; lea esi, [esi+4]
        code.push(0x73, 0x02, 0x89, 0x17); // jnc +2; mov [edi], edx
        code.push(0x8d, 0x7f, stride & 0xff); // lea edi, [edi+stride]
    }
    else if (kind === 4)
    {
        // One block whose pointer the data moves, so no stream is planned
        // (a plain self-loop): edi on by a byte it reads, masked (by none
        // for a stride of 0, a pad in the code, which it stays in). Every read
        // past RAM's end comes after a store that faults first: a read is
        // wrapped into RAM, untested (`readsWrapped`), where the model faults.
        const mask = stride === 0 ? 0 : [3, 15, 127][pick(3)];
        code.push(0x89, 0x1f); // mov [edi], ebx: tested, the read after it inside it
        code.push(0x0f, 0xb6, 0x47, 0x01); // movzx eax, byte [edi+1]
        code.push(0x83, 0xe0, mask); // and eax, mask
        code.push(0x01, 0xc3); // add ebx, eax
        code.push(0x01, 0xc7); // add edi, eax
        if (pick(2))
        {
            code.push(0x11, 0xda); // adc edx, ebx: the add's carry
        }
    }
    else if (kind === 5)
    {
        // One block of registers alone, a carry kept across the back edge.
        code.push(0x01, 0xd0, 0xc1, 0xc2, 1 + pick(31)); // add eax, edx; rol edx, n
        code.push(0x11, 0xc3); // adc ebx, eax
        if (pick(2))
        {
            code.push(0x31, 0xda); // xor edx, ebx
        }
    }
    else if (kind === 6)
    {
        // One block closed by a compare whose result its branch alone needs
        // (owed, `oweResult`), the head reading its parity the turn after.
        code.push(0x0f, 0x9a, 0xc3); // setp bl
        code.push(0x01, 0xd8, 0xc1, 0xc0, 1 + pick(31)); // add eax, ebx; rol eax, n
        if (pick(2))
        {
            code.push(0x89, 0x07, ...step); // mov [edi], eax; step: a stream, hoisted
        }
        code.push(0x49, 0x83, 0xf9, 0x00); // dec ecx; cmp ecx, 0
    }
    else if (kind === 7)
    {
        // x87 through edi, the stack as deep at the back edge as at the head
        // (`loopsOntoItself`): fst [edi]; fld [edi]; fadd st0, st1; fmulp st1, st0.
        code.push(0xd9, 0x17, 0xd9, 0x07, 0xd8, 0xc1, 0xde, 0xc9, ...step);
    }
    else if (kind === 8)
    {
        // x87 whose turn ends with a single just loaded in st0, which the
        // block's end writes into its f64 local (`x87BlockEnd`): fstp st0;
        // fld dword [esi], or fld dword [esi]; fstp st1; then a store through edi.
        code.push(...pick(2) ? [0xdd, 0xd8, 0xd9, 0x06] : [0xd9, 0x06, 0xdd, 0xd9]);
        code.push(0x83, 0xc6, 0x04, 0x89, 0x07, ...step); // add esi, 4; mov [edi], eax
    }
    if (kind !== 6)
    {
        code.push(0x49); // dec ecx
    }
    const back = head - (code.length + 2);
    if (back >= -128)
    {
        code.push(0x75, back & 0xff);
    }
    else
    {
        code.push(0x0f, 0x85, ...le(head - (code.length + 6)));
    }
    if (kind >= 7)
    {
        // The FPU's state as the loop left it -- its top, condition codes and
        // which registers are empty -- with the instruction and operand
        // pointers, which the translation does not keep, cleared, and each tag
        // made empty or not and the status word its top and codes: how a
        // value is tagged and the sticky exception bits are not this gate's
        // (both differ from the model before this change, on a loaded NaN);
        // then what the loop kept in st0.
        const tags = le(DATA + 0x208);
        code.push(0xd9, 0x35, ...le(DATA + 0x200)); // fnstenv [DATA+0x200]
        for (let at = 12; at < 28; at += 4)
        {
            code.push(0xc7, 0x05, ...le(DATA + 0x200 + at), ...le(0)); // mov dword [...], 0
        }
        code.push(0x9c, 0x50, 0x52); // pushfd; push eax; push edx: the loop's, read after
        code.push(0x66, 0xa1, ...tags, 0x66, 0x89, 0xc2); // mov ax, tags; mov dx, ax
        code.push(0x66, 0xd1, 0xea); // shr dx, 1
        code.push(0x66, 0x21, 0xd0, 0x66, 0x25, 0x55, 0x55); // and ax, dx; and ax, 0x5555
        code.push(0x66, 0xa3, ...tags); // mov tags, ax
        code.push(0x66, 0x81, 0x25, ...le(DATA + 0x204), 0x00, 0x7f); // and [status], 0x7f00
        code.push(0x5a, 0x58, 0x9d); // pop edx; pop eax; popfd
        code.push(0xdd, 0x1d, ...le(DATA + 0x100)); // fstp qword [DATA+0x100]
    }
}

/**
 * A program of loops, the whole run ten times so it is translated, each
 * loop's registers set before it and some of its flags read after it.
 *
 * @param {number} seed
 * @returns {{ code: number[], chunk: number }}
 */
function generate(seed){
    const pick = random(seed);
    const code = [0xbd, ...le(10)]; // mov ebp, 10
    const outer = code.length;
    for (let k = 1 + pick(3); k > 0; k--)
    {
        // Some streams run off RAM's end, some store into the loop's own code
        // granule (a pad jumped over, so the stores change nothing the
        // program runs, and each one is a store into translated code), the
        // rest stay in the data.
        const where = pick(8);
        const off = where < 2;
        const over = where === 2;
        const stride = over ? 0 : [1, 4, 4, 8, 12, -4, 64][pick(7)];
        if (over)
        {
            code.push(0xeb, 16, ...new Array(16).fill(0)); // jmp over the pad
        }
        let turns = 1 + pick(off ? 6000 : 300);
        let base = off ? END - 4 * pick(4096) - 64 : over ? CODE + code.length - 16
            : DATA + 0x8000 + pick(64) * 4;
        if (off && stride > 0 && pick(2))
        {
            // RAM's end at about the turn after the last one a window test
            // clears (`planLoop`'s turns, by the widest stride: edi's, or
            // esi's 4), where a turn too many run unchecked would store past it.
            const cleared = 1 + Math.floor(4096 / (pick(2) ? stride : Math.max(stride, 4)));
            const at = cleared - 1 + pick(3);
            base = END - at * stride - pick(12);
            turns = at + 2 + pick(50);
        }
        code.push(0xbf, ...le(stride < 0 && !off ? base + 0x4000 : base)); // mov edi, base
        code.push(0xbe, ...le(SOURCE + pick(64) * 4)); // mov esi, source
        if (off)
        {
            // More turns each outer turn, enough to reach RAM's end (or
            // `turns`, for a stream moving down) by the third to the ninth:
            // the fault comes in a loop translated by then.
            const reach = stride > 0 ? Math.ceil((END - base) / stride) : turns;
            const step = Math.max(1, Math.ceil(reach / (3 + pick(7))));
            code.push(0xb9, ...le(11), 0x29, 0xe9); // mov ecx, 11; sub ecx, ebp
            code.push(0x69, 0xc9, ...le(step), 0x85, 0xc9); // imul ecx, ecx, step; test ecx, ecx
        }
        else
        {
            code.push(0xb9, ...le(turns)); // mov ecx, turns
        }
        code.push(0xb8, ...le(pick(1 << 30))); // mov eax, value
        code.push(0xba, ...le(pick(1 << 30))); // mov edx, value
        code.push(pick(2) ? 0xf9 : 0xf8); // stc / clc
        loop(pick, code, { stride });
        if (pick(2))
        {
            // The loop's last flags read after it: setc / setz into memory.
            code.push(0x0f, pick(2) ? 0x92 : 0x94, 0xc3); // setc / setz bl
            code.push(0x88, 0x1d, ...le(DATA + k)); // mov [DATA+k], bl
        }
        code.push(0xa3, ...le(DATA + 0x40 + k * 4)); // mov [DATA+0x40+k*4], eax
    }
    code.push(0x4d, 0x0f, 0x85, ...le(outer - (code.length + 7)), 0xf4); // dec ebp; jnz outer; hlt
    return { code, chunk: CHUNKS[pick(CHUNKS.length)] };
}

/**
 * @param {number[]} code @param {Record<string, unknown>} config
 * @param {number} [limit]  the instructions the run stops at
 */
async function runProgram(code, config, limit = 5_000_000){
    const m = createMachine({ ramSize: END, config: { hotThreshold: 2, ...config } });
    try
    {
        m.load(CODE, code);
        const source = new Uint8Array(0x1000);
        const pick = random(code.length);
        for (let i = 0; i < source.length; i++)
        {
            source[i] = pick(256);
        }
        m.load(SOURCE, source);
        m.setReg('esp', STACK);
        m.setReg('eip', CODE);
        const stop = await m.run({ maxInstructions: limit });
        return {
            stop: { reason: stop.reason, vector: stop.vector, retired: stop.retired },
            data: [...m.read(DATA, 0x10000)],
            end: [...m.read(END - 0x2000, 0x2000)],
            registers: Object.fromEntries(REGISTERS.map(name=>[name, m.reg(name)])),
            flags: stop.reason === 'halt' ? m.reg('eflags') & 0x8d5 : 0,
            translated: stop.translated,
        };
    }
    finally
    {
        m.dispose();
    }
}

test('loops left at the budget, a fault or their turns\' end match the interpreter', async()=>{
    let faults = 0;
    let translated = 0;
    for (let seed = 1; seed <= 160; seed++)
    {
        const { code, chunk } = generate(seed * 7919);
        const interpreted = await runProgram(code, { translate: false });
        const ran = await runProgram(code, { yieldChunk: chunk });
        assert.deepEqual({ ...ran, translated: 0 }, interpreted, `seed ${seed}, chunk ${chunk}`);
        faults += interpreted.stop.reason === 'fault' ? 1 : 0;
        translated += ran.translated > interpreted.stop.retired / 2 ? 1 : 0;
    }
    // Both ways out are met: programs that end at a store's fault, programs mostly translated.
    assert.ok(faults > 10, `${faults} programs end at a fault`);
    assert.ok(translated > 100, `${translated} programs ran mostly translated code`);
});

/**
 * A loop whose body is a run of blocks each reached by one way from the block
 * before (`planCarries`): if/else diamonds (`jcc else; then; jmp join; else:`),
 * a then-block alone (`jcc join; then`), a jump to the next instruction, and a
 * break out of the loop, their blocks storing through edi -- off RAM's end
 * in some programs, a fault in the middle of a block that charges the blocks
 * before it -- and the turns' count left to the budget's chunks.
 *
 * @param {number} seed
 * @returns {{ code: number[], chunk: number }}
 */
function chained(seed){
    const pick = random(seed);
    const off = pick(4) === 0;
    const code = [0xbd, ...le(10)]; // mov ebp, 10
    const outer = code.length;
    code.push(0xbf, ...le(off ? END - 4 * (200 + pick(2000)) : DATA + 0x8000)); // mov edi, base
    code.push(0xbe, ...le(SOURCE + pick(64) * 4)); // mov esi, source
    code.push(0xb9, ...le(off ? 1 << 16 : 1 + pick(400))); // mov ecx, turns
    code.push(0xb8, ...le(pick(1 << 30)), 0xba, ...le(pick(1 << 30))); // mov eax, edx
    const head = code.length;
    /** @type {number[]} where each break's rel32 is, patched to the loop's end */
    const breaks = [];
    /** A straight piece of a block: plain operations, a store at times. */
    const plain = ()=>{
        /** @type {number[]} */
        const out = [];
        for (let n = 1 + pick(3); n > 0; n--)
        {
            out.push(...[[0x01, 0xd0], [0x31, 0xc2], [0xc1, 0xc0, 1 + pick(31)], [0x03, 0x06],
                [0x89, 0x47, pick(4) * 4], [0x8d, 0x52, pick(128)]][pick(6)]);
        }
        return out;
    };
    code.push(...plain());
    for (let k = 1 + pick(4); k > 0; k--)
    {
        const form = pick(5);
        code.push(0xa8, 1 << pick(8)); // test al, bit
        const cc = 0x74 + pick(2); // jz / jnz
        if (form === 0)
        {
            const then = plain();
            const other = plain();
            code.push(cc, then.length + 2, ...then, 0xeb, other.length, ...other);
        }
        else if (form === 1)
        {
            const then = plain();
            code.push(cc, then.length, ...then);
        }
        else if (form === 2)
        {
            code.push(0xeb, 0x00, ...plain()); // jmp to the next instruction
        }
        else if (form === 3)
        {
            code.push(0x0f, cc + 0x10); // a break: jz / jnz rel32 out of the loop
            breaks.push(code.length);
            code.push(0, 0, 0, 0, ...plain());
        }
        else
        {
            code.push(...plain());
        }
    }
    code.push(0x83, 0xc6, 0x04, 0x83, 0xc7, 0x04, 0x49); // add esi, 4; add edi, 4; dec ecx
    code.push(0x0f, 0x85, ...le(head - (code.length + 6))); // jnz head
    for (const at of breaks)
    {
        code.splice(at, 4, ...le(code.length - (at + 4)));
    }
    code.push(0x89, 0x15, ...le(DATA + 0x40), 0xa3, ...le(DATA + 0x44)); // store edx, eax
    code.push(0x4d, 0x0f, 0x85, ...le(outer - (code.length + 7)), 0xf4); // dec ebp; jnz outer; hlt
    return { code, chunk: CHUNKS[pick(CHUNKS.length)] };
}

test('blocks charging the count of the block before them match the interpreter', async()=>{
    let faults = 0;
    for (let seed = 1; seed <= 160; seed++)
    {
        const { code, chunk } = chained(seed * 6151);
        // Stopped by a limit, translated code stops at a way out past it: what
        // it says it retired is what the interpreter leaves after as many, and
        // one that ends before it stops (a halt, a fault) ends as the whole run.
        for (const limit of [5_000_000, 1 + chunk % 997 + seed * 31])
        {
            const ran = await runProgram(code, { yieldChunk: chunk }, limit);
            const counted = await runProgram(code, { translate: false },
                ran.stop.reason === 'limit' ? ran.stop.retired : 5_000_000);
            assert.deepEqual({ ...ran, translated: 0 }, counted,
                `seed ${seed}, chunk ${chunk}, limit ${limit}`);
            faults += limit === 5_000_000 && counted.stop.reason === 'fault' ? 1 : 0;
        }
    }
    assert.ok(faults > 10, `${faults} programs end at a fault`);
});

/**
 * Narrow writes of a register, each followed or not by a `movzx`/`movsx` that
 * widens a register's low byte or word -- the one just written into itself
 * (`widenedNext`), or another -- with plain operations between them that name
 * that register or not, in a loop run twenty times, every register stored at
 * the end of a turn.
 *
 * @param {number} seed
 */
function narrow(seed){
    const pick = random(seed);
    const code = [0xbd, ...le(20)]; // mov ebp, 20
    const outer = code.length;
    const words = [0, 1, 2, 3, 6, 7];
    for (const reg of words)
    {
        code.push(0xb8 + reg, ...le(pick(1 << 30) * 3)); // mov r32, value
    }
    for (let k = 4 + pick(12); k > 0; k--)
    {
        const word = pick(4) === 0;
        // A byte register: al..bl or ah..bh; a word one among ax..bx, si, di.
        const dst = word ? words[pick(words.length)] : pick(8);
        const src = word ? words[pick(words.length)] : pick(8);
        const prefix = word ? [0x66] : [];
        const form = pick(5);
        if (form === 0 && !word)
        {
            code.push(0x39, 0xc0 | pick(4) << 3 | pick(4)); // cmp r32, r32
            code.push(0x0f, 0x90 + pick(16), 0xc0 | dst); // setcc r8
        }
        else if (form === 1)
        {
            code.push(...prefix, word ? 0xb8 + dst : 0xb0 + dst, pick(256),
                ...word ? [pick(256)] : []); // mov r, imm
        }
        else if (form === 2)
        {
            code.push(...prefix, word ? 0xff : 0xfe, 0xc0 | pick(2) << 3 | dst); // inc / dec r
        }
        else
        {
            const op = [0x00, 0x08, 0x20, 0x28, 0x30][pick(5)]; // add or and sub xor
            code.push(...prefix, op | (word ? 1 : 0), 0xc0 | src << 3 | dst);
        }
        for (let n = pick(3); n > 0; n--)
        {
            // Between them: plain operations on any register, the one written too at times.
            const r = words[pick(words.length)];
            const t = words[pick(words.length)];
            const between = [
                [0xc1, 0xe8 | r, 1 + pick(31)], // shr r32, imm
                [0x01, 0xc0 | t << 3 | r], // add r32, r32
                [0x8d, 0x40 | r << 3 | t, pick(128)], // lea r32, [t + disp8]
                [0x39, 0xc0 | t << 3 | r], // cmp r32, r32
                [0xb8 + r, ...le(pick(1 << 30))], // mov r32, imm
            ];
            code.push(...between[pick(between.length)]);
        }
        if (pick(3) > 0)
        {
            // Widened: the register just written into itself mostly, another at times.
            const from = word ? dst : dst & 3;
            const into = pick(4) === 0 ? words[pick(words.length)] : from;
            const op = (pick(2) ? 0xb6 : 0xbe) | (word ? 1 : 0); // movzx / movsx
            // The source mostly the half just written, at times its other half
            // (al and ah), which the widening reads unmerged if taken for it.
            const half = [from, from, dst, dst ^ 4][pick(4)];
            code.push(0x0f, op, 0xc0 | into << 3 | (word ? from : half));
        }
    }
    for (const reg of words)
    {
        code.push(0x89, 0x05 | reg << 3, ...le(DATA + reg * 4)); // mov [DATA + reg*4], r32
    }
    code.push(0x4d, 0x0f, 0x85, ...le(outer - (code.length + 7)), 0xf4); // dec ebp; jnz outer; hlt
    return code;
}

test('a narrow write widened by the next instruction matches the interpreter', async()=>{
    for (let seed = 1; seed <= 200; seed++)
    {
        const code = narrow(seed * 104729);
        const interpreted = await runProgram(code, { translate: false });
        const ran = await runProgram(code, {});
        assert.deepEqual({ ...ran, translated: 0 }, interpreted, `seed ${seed}`);
        assert.ok(ran.translated > interpreted.stop.retired / 2, `seed ${seed} ran translated`);
    }
});
