/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of a self-loop that only reads, hoisted as one (`emitReadLoop` in
 * region.js): its streams' reach for many turns tested against RAM, an
 * unchecked copy for the turns that cleared, the checked copy when the test
 * fails or the turns are spent. Seeded loops of every shape such a loop takes
 * -- a string's length, a scan for a value, a sum through a scaled index, a
 * byte hash to an end pointer, lods, scas and cmps with the direction flag
 * either way, two streams compared -- over strides of 1 to 12 bytes either
 * way, starting anywhere from mid-RAM to a few bytes short of RAM's end (the
 * test of many turns fails there, the loop itself stopping in RAM), some
 * running more turns than a test clears, under budgets from a few
 * instructions to a million a slice. Each runs translated and interpreted,
 * and the two must stop the same way with the same instruction count,
 * registers, flags and memory.
 *
 * Beside them, loops whose streams run off RAM's end, or below its start,
 * where the processor faults and an untested read wraps into RAM: translated
 * without `precise` against the model reading as the wrap does. A copy whose
 * reads went unwrapped past RAM would read cork's tables there, or leave the
 * memory. And a string instruction's read, tested where other reads wrap,
 * met by a page inside RAM that is not accessible: it faults at the element
 * the processor faults at, the copy's streams tested by their pages' flags.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from '../machine.js';
import { createTestMachine } from '../testing/machine.js';
import { decode } from '../decode/decoder.js';
import { createState, evaluate } from '../ir.js';
import { PageFlag } from '../runtime/pages.js';

const CODE = 0x401000;
const DATA = 0x500000;
const STACK = 0xf00000;
/** RAM's end. */
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
 * A program of `seed`: registers set, one read loop, what it left stored at
 * DATA, a halt; and the bytes it reads, by address.
 *
 * @param {number} seed
 * @returns {{ code: number[], bytes: Map<number, number[]>, chunk: number }}
 */
function generate(seed){
    const pick = random(seed);
    const shape = pick(8);
    const strings = shape >= 4 && shape <= 6;
    const strides = [1, 1, 2, 4, 4, 8, 12];
    const stride = (strings ? 1 : strides[pick(strides.length)]) * (pick(3) === 0 ? -1 : 1);
    const scale = Math.abs(stride) >= 4 ? 4 : Math.abs(stride);
    // Turns, a few to past what one test clears (65536).
    const turns = [1, 2, 3, 5, 17, 300, 4000, 70000][pick(8)];
    const span = turns * Math.abs(stride) + 16;
    // Where the stream starts: mid-RAM, or so its last turn ends a few bytes
    // short of RAM's end, in a direction that runs towards it. A second
    // stream (cmps) lies 128 KiB below the first.
    const nearEnd = pick(3) === 0;
    const start = stride > 0
        ? (nearEnd ? END - span + pick(8) : 0x600000 + pick(0x1000) * 4)
        : (nearEnd ? END - 16 - pick(8) : 0x600000 + span + pick(0x1000) * 4);
    const last = start + (turns - 1) * stride;
    const lo = Math.min(start, last) - 16;
    // The stream's bytes: random and nonzero, so only a terminator ends a scan.
    const data = Array.from({ length: Math.abs(last - start) + 32 }, ()=>1 + pick(255));
    /** @param {number} at @param {number[]} values */
    const put = (at, values)=>values.forEach((value, k)=>{
        data[at - lo + k] = value;
    });
    /** @type {Map<number, number[]>} */
    const bytes = new Map([[lo, data]]);
    const prologue = [
        0xb8, ...le(pick(0x10000)),                    // mov eax, any
        0xba, ...le(0),                                // mov edx, 0
        0xbe, ...le(start),                            // mov esi, start
        0xbf, ...le(last),                             // mov edi, last
        0xb9, ...le(turns),                            // mov ecx, turns
    ];
    const step = stride < 0 ? [0x83, 0xee, -stride] : [0x83, 0xc6, stride]; // sub/add esi
    const body = [];
    let jump = 0x75;                                   // jne
    switch (shape)
    {
        case 0:
            // A string's length: bytes up to a zero, esi moved by the stride.
            put(last, [0]);
            // movzx ebx, byte [esi]; step; inc edx; test bl, bl
            body.push(0x0f, 0xb6, 0x1e, ...step, 0x42, 0x84, 0xdb);
            break;
        case 1:
            // A scan for a dword equal to the last one's.
            put(last, [0x5a, 0x5b, 0x5c, 0x5d]);
            prologue.push(0xbb, ...le(0x5d5c5b5a));    // mov ebx, the value
            body.push(0x3b, 0x1e, 0x8d, 0x76, stride & 0xff); // cmp ebx, [esi]; lea esi, [esi+s]
            break;
        case 2:
            // A sum through a scaled index: [edi + ecx*scale - scale], ecx down to zero.
            prologue.push(0xbf, ...le(Math.min(start, last)));
            body.push(0x03, 0x54, (scale === 4 ? 0x80 : scale === 2 ? 0x40 : 0) | 0x0f,
                -scale & 0xff, 0x49);                  // add edx, [edi + ecx*s - s]; dec ecx
            break;
        case 3:
            // A byte hash to an end pointer.
            body.push(0x0f, 0xb6, 0x1e, ...step, 0x31, 0xd8, 0x69, 0xc0, ...le(0x1000193),
                0x8d, 0x5f, stride & 0xff, 0x39, 0xde); // ...; lea ebx, [edi+s]; cmp esi, ebx
            break;
        case 4:
            // lods, the direction flag as the stride runs, counted.
            prologue.push(stride < 0 ? 0xfd : 0xfc);
            body.push(0xac, 0x01, 0xc2, 0x49);         // lodsb; add edx, eax; dec ecx
            break;
        case 5:
            // scas for a zero.
            put(last, [0]);
            // std or cld; mov edi, esi; mov al, 0
            prologue.push(stride < 0 ? 0xfd : 0xfc, 0x89, 0xf7, 0xb0, 0x00);
            body.push(0xae);                           // scasb
            break;
        case 6:
        {
            // cmps of two streams equal up to the last byte.
            const copy = data.slice();
            copy[last - lo] ^= 0xff;
            bytes.set(lo - 0x20000, copy);
            // std or cld; lea edi, [esi - 128 KiB]
            prologue.push(stride < 0 ? 0xfd : 0xfc, 0x8d, 0xbe, ...le(-0x20000));
            body.push(0xa6);                           // cmpsb
            jump = 0x74;                               // je
            break;
        }
        default:
            // Two dwords of one stream compared, the lesser kept, counted.
            body.push(0x8b, 0x1e, 0x3b, 0x5e, scale === 4 ? 4 : 0, 0x0f, 0x42, 0xd3, ...step, 0x49);
            break;
    }
    // The body, the jump back to its head, cld.
    const code = [...prologue, ...body, jump, -(body.length + 2) & 0xff, 0xfc];
    for (const [reg, at] of [[0, 0], [1, 4], [2, 8], [3, 12], [6, 16], [7, 20]])
    {
        code.push(0x89, 0x05 | reg << 3, ...le(DATA + at)); // mov [DATA + at], reg
    }
    code.push(0x9c, 0x58, 0xa3, ...le(DATA + 24));     // pushf; pop eax; mov [DATA+24], eax
    code.push(0xf4);
    return { code, bytes, chunk: CHUNKS[pick(CHUNKS.length)] };
}

/**
 * @param {{ code: number[], bytes: Map<number, number[]> }} program
 * @param {Record<string, unknown>} config
 */
async function runProgram({ code, bytes }, config){
    const m = createMachine({ ramSize: END, config: { hotThreshold: 2, ...config } });
    try
    {
        m.load(CODE, code);
        for (const [at, values] of bytes)
        {
            m.load(at, Uint8Array.from(values.slice(0, Math.max(0, END - at))));
        }
        m.setReg('esp', STACK);
        m.setReg('eip', CODE);
        const stop = await m.run({ maxInstructions: 5_000_000 });
        return {
            stop: { reason: stop.reason, vector: stop.vector, retired: stop.retired },
            data: [...m.read(DATA, 32)],
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

test('loops that only read, hoisted as such, match the interpreter', async()=>{
    let translated = 0;
    let halted = 0;
    for (let seed = 1; seed <= 240; seed++)
    {
        const program = generate(seed * 7919);
        const interpreted = await runProgram(program, { translate: false });
        const ran = await runProgram(program, { yieldChunk: program.chunk });
        assert.deepEqual({ ...ran, translated: 0 }, interpreted, `seed ${seed}`);
        halted += interpreted.stop.reason === 'halt' ? 1 : 0;
        translated += ran.translated > interpreted.stop.retired / 2 ? 1 : 0;
    }
    assert.ok(halted > 200, `${halted} programs halt`);
    assert.ok(translated > 100, `${translated} programs ran mostly translated code`);
});

/** The RAM of the loops that run past its end. */
const SMALL = 1 << 20;
/** Their code and what they store, mid-RAM, where no stream reaches. */
const AT = 0x80000;

/**
 * A loop of `seed` whose stream runs past RAM's end, or below its start, by
 * up to 256 KiB, and the RAM it runs over: every byte nonzero but the
 * terminator a scan stops at, at its last turn's address wrapped into RAM. A
 * dword stream stays aligned, so what wraps into RAM lies inside it whole.
 *
 * @param {number} seed
 * @returns {{ code: number[], ram: Uint8Array }}
 */
function past(seed){
    const pick = random(seed);
    // No string instruction: its read is tested, and faults past RAM.
    const shape = pick(3);
    const magnitude = shape === 1 ? [4, 8, 12][pick(3)] : [1, 4, 8, 12][pick(4)];
    const stride = magnitude * (pick(2) === 0 ? -1 : 1);
    // Half of them at the edge of the reach one test clears: as the emitter
    // makes it, every turn of 64 Ki, or as many as a quarter of RAM holds,
    // RAM's end a few bytes inside or outside it.
    const size = shape === 1 ? 4 : 1;
    const many = Math.min(1 << 16, Math.floor((SMALL / 4 - size) / magnitude));
    const edge = pick(2) === 0;
    const turns = edge ? many + 16 : [3, 17, 300, 4000, 20000, 70000][pick(6)];
    const beyond = edge ? [0, 1, 1, 2, 3, 1 + pick(64)][pick(6)] * (magnitude >= 4 ? 4 : 1)
        : Math.floor(turns * magnitude * (1 + pick(3)) / 4);
    const reach = (many - 1) * magnitude + size;
    const start = (edge
        ? (stride > 0 ? SMALL - reach + beyond : (many - 1) * magnitude - beyond)
        : (stride > 0 ? SMALL - turns * magnitude + beyond : turns * magnitude - beyond))
        & ~(magnitude >= 4 ? 3 : 0);
    const last = (start + (turns - 1) * stride) >>> 0;
    const ram = new Uint8Array(SMALL);
    for (let i = 0; i < SMALL; i++)
    {
        ram[i] = 1 + ((i * 2654435761 >>> 24) ^ i) % 255;
    }
    const wrapped = last & SMALL - 1;
    const code = [
        0xb8, ...le(pick(0x10000)), 0xba, ...le(0), 0xbe, ...le(start >>> 0),
        0xbf, ...le(last), 0xb9, ...le(turns),
    ];
    const step = stride < 0 ? [0x83, 0xee, -stride] : [0x83, 0xc6, stride];
    const body = [];
    switch (shape)
    {
        case 0:
            ram[wrapped] = 0;
            body.push(0x0f, 0xb6, 0x1e, ...step, 0x42, 0x84, 0xdb);
            break;
        case 1:
            ram.set([0x5a, 0x5b, 0x5c, 0x5d], wrapped);
            code.push(0xbb, ...le(0x5d5c5b5a));
            body.push(0x3b, 0x1e, 0x8d, 0x76, stride & 0xff);
            break;
        default:
            body.push(0x0f, 0xb6, 0x1e, ...step, 0x31, 0xd8, 0x69, 0xc0, ...le(0x1000193),
                0x8d, 0x5f, stride & 0xff, 0x39, 0xde);
            break;
    }
    code.push(...body, 0x75, -(body.length + 2) & 0xff, 0xfc);
    for (const [reg, at] of [[0, 0], [1, 4], [2, 8], [3, 12], [6, 16], [7, 20]])
    {
        code.push(0x89, 0x05 | reg << 3, ...le(AT + 0x800 + at));
    }
    code.push(0xf4);
    return { code, ram };
}

test('loops that only read past RAM\'s end read what the wrap into RAM reads', ()=>{
    for (let seed = 1; seed <= 120; seed++)
    {
        const { code, ram } = past(seed * 104729);
        const m = createTestMachine({ precise: false, ramSize: SMALL });
        m.write(0, ram);
        m.write(AT, code);
        m.setReg('esp', AT + 0x10000);
        m.setEflags(2);
        const exit = m.runProgram(AT);
        const model = ram.slice();
        model.set(code, AT);
        const view = new DataView(model.buffer);
        const state = createState({
            read: (address, size)=>{
                const at = address & SMALL - 1;
                return size === 1 ? model[at] : size === 2 ? view.getUint16(at, true)
                    : view.getUint32(at, true);
            },
            write: (address, size, value)=>{
                view.setUint32(address, value, true);
            },
        }, { eip: AT, esp: AT + 0x10000, fsBase: 0 });
        state.eflags = 2;
        while (!state.halted && state.retired < 1_000_000)
        {
            const decoded = decode(address=>model[address], state.eip);
            if ('refused' in decoded)
            {
                break;
            }
            evaluate(decoded, state);
        }
        assert.ok(state.halted, `seed ${seed}: the model halted`);
        assert.equal(exit.kind, 3, `seed ${seed}: halted`);
        assert.deepEqual([...m.read(AT + 0x800, 24)], [...model.subarray(AT + 0x800, AT + 0x818)],
            `seed ${seed}: what the loop left`);
    }
});

test('a loop of string reads that meets a page it cannot read faults where the model does', ()=>{
    let faults = 0;
    for (let seed = 1; seed <= 150; seed++)
    {
        const pick = random(seed * 15485863);
        const shape = pick(3);
        const down = pick(2) === 0;
        const turns = [5, 300, 4000, 9000][pick(4)];
        const start = 0x20000 + pick(0x1000);
        const last = down ? start - turns + 1 : start + turns - 1;
        // The page that cannot be read: on the stream's way, or past its end.
        const bad = (down ? last - pick(turns + 0x2000) : last + pick(0x2000) - turns) >>> 12;
        const ram = new Uint8Array(SMALL);
        for (let i = 0; i < SMALL; i++)
        {
            ram[i] = 1 + ((i * 2654435761 >>> 24) ^ i) % 255;
        }
        const code = [0xb8, ...le(0), 0xba, ...le(0), 0xbe, ...le(start), 0xb9, ...le(turns),
            down ? 0xfd : 0xfc];
        let jump = 0x75;
        if (shape === 0)
        {
            code.push(0xac, 0x01, 0xc2, 0x49);           // lodsb; add edx, eax; dec ecx
        }
        else if (shape === 1)
        {
            ram[last] = 0;
            code.splice(code.length - 1, 0, 0x89, 0xf7); // mov edi, esi
            code.push(0xae);                             // scasb for al = 0
        }
        else
        {
            code.splice(code.length - 1, 0, 0x8d, 0xbe, ...le(0x40000)); // lea edi, [esi + 256 KiB]
            ram.copyWithin(start + 0x40000 - turns, start - turns, start + turns);
            ram[last + 0x40000] ^= 0xff;
            code.push(0xa6);                             // cmpsb
            jump = 0x74;
        }
        const back = code.length - (shape === 0 ? 4 : 1);
        code.push(jump, (back - (code.length + 2)) & 0xff, 0xfc, 0xf4);
        const m = createTestMachine({ precise: false, ramSize: SMALL });
        m.write(0, ram);
        m.write(AT, code);
        m.pages.set(bad, PageFlag.INACCESSIBLE);
        m.setReg('esp', AT + 0x10000);
        m.setEflags(2);
        const exit = m.runProgram(AT);
        const model = ram.slice();
        model.set(code, AT);
        const state = createState({
            read: address=>{
                if (address >>> 12 === bad)
                {
                    throw new Error('#GP');
                }
                return model[address];
            },
            write: ()=>{
                throw new Error('the program stores nothing');
            },
        }, { eip: AT, esp: AT + 0x10000, fsBase: 0 });
        state.eflags = 2;
        let fault = false;
        /** The instruction the model is at: where a fault leaves EIP. */
        let at = state.eip;
        try
        {
            while (!state.halted && state.retired < 1_000_000)
            {
                at = state.eip;
                const decoded = decode(address=>model[address], state.eip);
                if ('refused' in decoded)
                {
                    break;
                }
                evaluate(decoded, state);
            }
        }
        catch {
            fault = true;
        }
        faults += fault ? 1 : 0;
        assert.equal(exit.kind, fault ? 4 : 3, `seed ${seed}: ${fault ? 'faulted' : 'halted'}`);
        assert.equal(m.eip(), fault ? at : state.eip, `seed ${seed}: eip`);
        for (const [r, name] of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'].entries())
        {
            assert.equal(m.reg(name), state.reg[r], `seed ${seed}: ${name}`);
        }
    }
    assert.ok(faults > 40, `${faults} loops meet the page`);
});
