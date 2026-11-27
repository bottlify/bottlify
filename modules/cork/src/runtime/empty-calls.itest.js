/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of calls to functions that do nothing (`emptyCalls`): seeded
 * programs whose loop calls functions through method tables (`call [reg+N]`), a register,
 * a fixed slot and directly -- empty ones (`ret`, `rep ret`, `ret 4`, `ret 8`) and ones
 * that are not (`ret 6`, `nop; ret`, work, a compare, a jump on through a register), each
 * reached through a chain of up to three thunks, with arguments pushed for the bytes its
 * `ret` pops, the flags set before and read after, the slot the call pushed into read back,
 * an x87 value held across, and stores that turn an empty function into one that is not
 * and back and point a thunk at another body -- run interpreted alone, then translated with
 * every call entering its callee's region and returned from in the transfer, with leaves
 * formed in and not and with indirect calls predicted.
 * Everything a program observes must come out the same: the registers, the flags, its data,
 * its stack and its code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from '../machine.js';

const MAIN = 0x1000;
const FUNCTIONS = 0x3000;
const SPAN = 0x40;
const THUNKS = 0x6000;
const OBJECTS = 0x80000;
const TABLES = 0x81000;
const SLOTS = 0x82000;
const DATA = 0x84000;
const STACK = 0xf0000;
const PROGRAMS = 80;

/** A small seeded generator (mulberry32). @param {number} seed */
function random(seed){
    let state = seed >>> 0;
    return ()=>{
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** @param {number} value */
const le32 = value=>[value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24];

/**
 * The kinds of function: its bytes (`at` its address, `empty` an empty function's address
 * for the ones that jump on) and what its callers push for its `ret`, in bytes.
 *
 * @type {Record<string, { pushes: number, bytes: (pick: (n: number) => number, at: number,
 *     empty: number) => number[] }>}
 */
const KINDS = {
    // `c3 c3`: its first byte is the one a store turns into `inc eax` and back.
    ret: { pushes: 0, bytes: ()=>[0xc3, 0xc3] },
    rep: { pushes: 0, bytes: ()=>[0xf3, 0xc3] },
    ret4: { pushes: 4, bytes: ()=>[0xc2, 0x04, 0x00] },
    ret8: { pushes: 8, bytes: ()=>[0xc2, 0x08, 0x00] },
    ret6: { pushes: 6, bytes: ()=>[0xc2, 0x06, 0x00] },
    nop: { pushes: 0, bytes: ()=>[0x90, 0xc3] },
    // add ebx, imm8; ret
    work: { pushes: 0, bytes: pick=>[0x83, 0xc3, pick(256), 0xc3] },
    // xor ebx, eax; ret 4
    work4: { pushes: 4, bytes: ()=>[0x31, 0xc3, 0xc2, 0x04, 0x00] },
    // cmp eax, imm8; ret -- the flags it leaves are its own
    flags: { pushes: 0, bytes: pick=>[0x83, 0xf8, pick(256), 0xc3] },
    // add ebx, 1; mov edx, f; jmp edx -- on to an empty function, whose `ret` returns from it
    on: { pushes: 0,
        bytes: (pick, at, empty)=>[0x83, 0xc3, 0x01, 0xba, ...le32(empty), 0xff, 0xe2] },
};

/**
 * A program: functions of the kinds above at `FUNCTIONS`, each `SPAN` apart, each called
 * through a chain of thunks at `THUNKS` or at its own address, and a loop at `MAIN`.
 *
 * @param {number} seed
 * @returns {[number, number[]][]}
 */
function program(seed){
    const next = random(seed);
    const pick = (/** @type {number} */ n)=>Math.floor(next() * n);
    const names = Object.keys(KINDS);
    const count = 4 + pick(7);
    // The first is an empty `ret`, which the jumps on and the stores have to aim at.
    const kinds = [KINDS.ret,
        ...Array.from({ length: count - 1 }, ()=>KINDS[names[pick(names.length)]])];
    /** @type {[number, number[]][]} */
    const code = [];
    const bodies = kinds.map((kind, index)=>FUNCTIONS + index * SPAN);
    kinds.forEach((kind, index)=>code.push(
        [bodies[index], kind.bytes(pick, bodies[index], bodies[0])]));
    // Each function's address as its callers see it: its own, or a chain of thunks to it.
    let thunkAt = THUNKS;
    /** @type {number[]} */
    const heads = [];
    /** @type {number[]} */
    const retargetable = [];
    for (const body of bodies)
    {
        const jumps = pick(4);
        let target = body;
        for (let jump = 0; jump < jumps; jump++)
        {
            const at = thunkAt;
            thunkAt += 0x10;
            const distance = target - (at + 2);
            if (distance >= -128 && distance < 128 && pick(2) === 0)
            {
                code.push([at, [0xeb, distance & 0xff]]);
            }
            else
            {
                code.push([at, [0xe9, ...le32(target - (at + 5))]]);
                if (jump === 0)
                {
                    retargetable.push(at);
                }
            }
            target = at;
        }
        heads.push(target);
    }
    /** @type {[number, number[]][]} */
    const data = [[DATA, [0x00, 0x00, 0xc0, 0x3f]]]; // 1.5f
    /** @type {number[]} */
    const loop = [];
    const ops = 2 + pick(7);
    let tables = 0;
    let slots = 0;
    for (let op = 0; op < ops; op++)
    {
        const kind = pick(10);
        if (kind === 8)
        {
            // mov byte [f], 0x40 or 0xc3: an empty `ret` made `inc eax; ret`, or empty again.
            const target = kinds.map((one, index)=>(one === KINDS.ret ? index : -1))
                .filter(index=>index >= 0);
            loop.push(0xc6, 0x05, ...le32(bodies[target[pick(target.length)]]),
                pick(2) === 0 ? 0x40 : 0xc3);
            continue;
        }
        if (kind === 9 && retargetable.length > 0)
        {
            // mov dword [thunk+1], rel: a thunk pointed at another body its callers push for.
            const thunk = retargetable[pick(retargetable.length)];
            const [, bytes] = /** @type {[number, number[]]} */ (code.find(([at])=>at === thunk));
            const from = thunk + 5 + bytes[1] + bytes[2] * 0x100 + bytes[3] * 0x10000
                + bytes[4] * 0x1000000;
            const reach = (from >>> 0) - FUNCTIONS;
            const pushes = reach >= 0 && reach < count * SPAN
                ? kinds[Math.floor(reach / SPAN)].pushes : -1;
            const same = bodies.filter((body, index)=>kinds[index].pushes === pushes);
            if (same.length > 0)
            {
                loop.push(0xc7, 0x05, ...le32(thunk + 1),
                    ...le32(same[pick(same.length)] - (thunk + 5)));
            }
            continue;
        }
        const callee = pick(count);
        const { pushes } = kinds[callee];
        const head = heads[callee];
        const x87 = pick(5) === 0;
        if (x87)
        {
            loop.push(0xd9, 0x05, ...le32(DATA)); // fld dword [DATA]
        }
        if (pushes >= 4)
        {
            loop.push(0x6a, pick(128));
        }
        if (pushes >= 8)
        {
            loop.push(0x50);
        }
        if (pushes === 6)
        {
            loop.push(0x66, 0x6a, pick(128)); // push word
        }
        loop.push(0x83, 0xff, pick(128)); // cmp edi, imm8: flags the loop's count decides
        switch (kind % 4)
        {
            case 0:
            {
                // mov ecx, object; mov eax, [ecx]; call [eax+4*slot]
                const object = OBJECTS + tables * 16;
                const table = TABLES + tables * 64;
                const slot = pick(16);
                data.push([object, le32(table)], [table + slot * 4, le32(head)]);
                tables++;
                loop.splice(loop.length - 3, 0, 0xb9, ...le32(object), 0x8b, 0x01);
                loop.push(0xff, 0x50, slot * 4);
                break;
            }
            case 1:
                // mov edx, f; call edx
                loop.splice(loop.length - 3, 0, 0xba, ...le32(head));
                loop.push(0xff, 0xd2);
                break;
            case 2:
            {
                // call [slot]
                const slot = SLOTS + slots * 4;
                slots++;
                data.push([slot, le32(head)]);
                loop.push(0xff, 0x15, ...le32(slot));
                break;
            }
            default:
            {
                const after = MAIN + 5 + loop.length + 5;
                loop.push(0xe8, ...le32(head - after));
            }
        }
        const look = pick(4);
        if (look === 0)
        {
            // pushfd; pop edx; and edx, 0x8d5; add esi, edx
            loop.push(0x9c, 0x5a, 0x81, 0xe2, ...le32(0x8d5), 0x01, 0xd6);
        }
        else if (look === 1)
        {
            // mov edx, [esp-4]; add ebp, edx -- the slot the call pushed into
            loop.push(0x8b, 0x54, 0x24, 0xfc, 0x01, 0xd5);
        }
        else if (look === 2)
        {
            loop.push(0x83, 0xd3, 0x00); // adc ebx, 0
        }
        if (x87)
        {
            loop.push(0xd9, 0x1d, ...le32(DATA + 8)); // fstp dword [DATA + 8]
        }
    }
    // mov edi, turns; L: ...; dec edi; jnz L; hlt
    loop.push(0x4f);
    const main = [0xbf, ...le32(20 + pick(80)), ...loop];
    main.push(0x0f, 0x85, ...le32(-(loop.length + 6)), 0xf4);
    code.push([MAIN, main]);
    return [...code, ...data];
}

/**
 * What a program observes, run on a machine of `config`.
 *
 * @param {[number, number[]][]} pieces @param {Record<string, unknown>} config
 */
async function run(pieces, config){
    const m = createMachine({ ramSize: 1 << 20, config: { hashSlots: 1 << 12, ...config } });
    try
    {
        for (const [at, bytes] of pieces)
        {
            m.load(at, bytes);
        }
        m.setReg('esp', STACK);
        m.setReg('eip', MAIN);
        const stop = await m.run({ maxInstructions: 2_000_000 });
        const diagnostics = m.diagnostics();
        const mechanisms = /** @type {Record<string, number>} */ (diagnostics.mechanisms ?? {});
        return {
            observed: {
                stop: stop.reason,
                registers: ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip']
                    .map(name=>m.reg(name)),
                flags: m.reg('eflags') & 0x8d5,
                data: [...m.read(DATA, 16)],
                stack: [...m.read(STACK - 64, 64)],
                code: pieces.map(([at, bytes])=>[...m.read(at, bytes.length)]),
            },
            translated: stop.translated,
            inTransfer: mechanisms.EMPTY_RETURN ?? 0,
        };
    }
    finally
    {
        m.dispose();
    }
}

test('calls to functions that do nothing, returned from early, run as the interpreter runs them',
    async()=>{
        const paths = {
            'entered': { emptyCalls: false, hotThreshold: 2 },
            'in the transfer': { hotThreshold: 2 },
            'in the transfer, no leaves': { leafCalls: false, hotThreshold: 2 },
            'in the transfer, predicted': { hotThreshold: 2, callTargets: true, predictAfter: 1 },
            // Counted, which is other code: the short way is taken.
            'in the transfer, counted': { leafCalls: false, hotThreshold: 2, blockProfile: true },
        };
        let translated = 0;
        let inTransfer = 0;
        for (let seed = 1; seed <= PROGRAMS; seed++)
        {
            const pieces = program(seed);
            const reference = await run(pieces, { hotThreshold: 1e9 });
            assert.equal(reference.translated, 0, 'the reference ran interpreted');
            assert.equal(reference.observed.stop, 'halt', `seed ${seed}: the program ends`);
            for (const [name, config] of Object.entries(paths))
            {
                const got = await run(pieces, config);
                assert.deepEqual(got.observed, reference.observed, `seed ${seed}, ${name}`);
                translated += got.translated;
                inTransfer += name === 'in the transfer, counted' ? got.inTransfer : 0;
            }
        }
        assert.ok(translated > 0, 'the translated paths ran translated code');
        assert.ok(inTransfer > 0, 'the transfer returned from empty functions');
    });
