/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A loop's ways out beside the interpreter: the back edge that finds the
 * budget spent, the fault of a store, the end of the turns a hoisted loop's
 * test cleared. Seeded programs of loops of one block and of several -- store
 * streams moving by a stride (hoisted, `planLoop`), carry chains whose head
 * reads the flags the turn before left (`adc` after `add`), heads that write
 * them first -- run under budgets from a few instructions to a million a
 * turn, some streams running off the end of RAM into the fault. Each runs
 * translated and interpreted, and the two must stop the same way with the
 * same instruction count, registers and memory, and with the same flags
 * where the program halts. A way out to code that writes the flags before it
 * reads them leaves an empty record (`exitAt`), so the flags are compared
 * where the program ends, not at a fault, as a fault's handler is not
 * promised them. Beside them: a loop inside another entered at its head from
 * elsewhere with a record another region made (the outer head's way in), and a
 * narrow register write widened soon after (`widenedNext` in integer.js).
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
    const head = code.length;
    const kind = [0, 0, 1, 2, 3][pick(5)];
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
    else
    {
        // Two blocks, the head reading the carry of the turn before.
        code.push(0x83, 0xd2, 0x00); // adc edx, 0
        code.push(0x03, 0x06, 0x8d, 0x76, 0x04); // add eax, [esi]; lea esi, [esi+4]
        code.push(0x73, 0x02, 0x89, 0x17); // jnc +2; mov [edi], edx
        code.push(0x8d, 0x7f, stride & 0xff); // lea edi, [edi+stride]
    }
    code.push(0x49); // dec ecx
    const back = head - (code.length + 2);
    if (back >= -128)
    {
        code.push(0x75, back & 0xff);
    }
    else
    {
        code.push(0x0f, 0x85, ...le(head - (code.length + 6)));
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
        const stride = [1, 4, 4, 8, 12, -4, 64][pick(7)];
        // Some streams run off RAM's end, the rest stay in the data.
        const off = pick(3) === 0;
        const turns = 1 + pick(off ? 6000 : 300);
        const base = off ? END - 4 * pick(4096) - 64 : DATA + 0x8000 + pick(64) * 4;
        code.push(0xbf, ...le(stride < 0 && !off ? base + 0x4000 : base)); // mov edi, base
        code.push(0xbe, ...le(SOURCE + pick(64) * 4)); // mov esi, source
        code.push(0xb9, ...le(turns)); // mov ecx, turns
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

/** @param {number[]} code @param {Record<string, unknown>} config */
async function runProgram(code, config){
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
        const stop = await m.run({ maxInstructions: 5_000_000 });
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
 * A loop inside another entered at its head through the region's dispatch with
 * a record of another region's making: an indirect jump to it after an `add`
 * that carries, the inner loop's head an `adc` that reads that carry, or a head
 * that writes the flags first (the outer loop's way in leaves the record empty
 * only for heads that do).
 *
 * @param {number} seed
 */
function entered(seed){
    const pick = random(seed);
    const reads = pick(2) === 0;
    const turns = 1 + pick(40);
    const code = [0xbf, ...le(2 + pick(20))]; // mov edi, rounds
    code.push(0xbd, ...le(1 + pick(4))); // mov ebp, outer turns
    const outer = code.length;
    code.push(0xbe, ...le(SOURCE), 0xb9, ...le(turns), 0xf8); // mov esi, source; mov ecx, n; clc
    const head = code.length;
    code.push(...reads ? [0x13, 0x06] : [0x03, 0x06]); // adc / add eax, [esi]
    code.push(0x8d, 0x76, 0x04, 0x49); // lea esi, [esi+4]; dec ecx
    code.push(0x75, (head - (code.length + 2)) & 0xff); // jnz head
    code.push(0xa3, ...le(DATA)); // mov [DATA], eax
    code.push(0x4d, 0x0f, 0x85, ...le(outer - (code.length + 7))); // dec ebp; jnz outer
    // Again from the head, by an indirect jump, with the carry set.
    const again = [
        0xbd, ...le(1), 0xbe, ...le(SOURCE), 0xb9, ...le(turns), // mov ebp, esi, ecx
        0xbb, ...le(-1 >>> 0), 0x83, 0xc3, 0x01, // mov ebx, -1; add ebx, 1
        0xba, ...le(CODE + head), 0xff, 0xe2, // mov edx, head; jmp edx
    ];
    code.push(0x4f, 0x74, again.length, ...again); // dec edi; jz done
    code.push(0xf4); // done: hlt
    return code;
}

test('a loop inside another entered at its head by a jump from elsewhere matches the interpreter',
    async()=>{
        for (let seed = 1; seed <= 120; seed++)
        {
            const code = entered(seed * 31337);
            const interpreted = await runProgram(code, { translate: false });
            const ran = await runProgram(code, {});
            assert.deepEqual({ ...ran, translated: 0 }, interpreted, `seed ${seed}`);
            assert.equal(interpreted.stop.reason, 'halt');
        }
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
            code.push(0x0f, op, 0xc0 | into << 3 | (word || pick(4) > 0 ? from : dst));
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
