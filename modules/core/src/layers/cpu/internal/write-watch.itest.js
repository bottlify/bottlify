/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The write watch's gate (`takeWrites`, `write-clock.js`): seeded programs
 * store into watched pages in every form a store takes -- one at a time,
 * several off one register in a block (one window test for the group), a
 * loop's stream (its pages tested once for many turns), `rep stos` and `rep
 * movs` (in bulk), x87 and SSE stores, locked and exchanging ones --
 * interpreted at first and translated once hot, on the process's own executor
 * and on another one over the same memory, and the host writes too. Every page
 * whose bytes changed is among the pages taken, and no page a store could not
 * reach is. And a copy kept by what the watch takes while another executor
 * stores is the memory's own once its program has ended: no store tested
 * before a look and made after it is lost.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from './cork-host.js';
import { createRemoteExecutor } from './executor.js';
import { createWriteClock } from './write-clock.js';
import * as engine from '../../../../../cork/src/index.js';

const ENGINE_URL = new URL('../../../../../cork/src/index.js', import.meta.url).href;
const CONFIG = {
    memorySize: 4 << 20, trapPort: 0xb077, entryVector: 0x7000, initialStack: 0x300000,
    closedBelow: 0x10000, cork: { hotThreshold: 4, wasmInterpreter: true },
};
const CODE = 0x20000;
const DATA = 0x100000;
const PAGES = 16;
const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** A seeded generator. @param {number} seed */
function random(seed){
    let s = seed >>> 0;
    return (/** @type {number} */ n)=>{
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        return (s >>> 8) % n;
    };
}

/**
 * A program: `rounds` turns of random stores into the watched pages, then
 * `hlt`, with every page a store of it can reach.
 *
 * @param {(n: number) => number} next
 * @returns {{ code: number[], reach: Set<number> }}
 */
function program(next){
    /** @type {Set<number>} */
    const reach = new Set();
    /** A store's displacement off ebx (DATA), and its pages. @param {number} size */
    const at = size=>{
        const page = next(PAGES);
        const offset = next(4096 - size + 1);
        const disp = page * 4096 + offset;
        reach.add(page);
        reach.add((disp + size - 1) >>> 12);
        return disp;
    };
    /** The pages a run of `bytes` from `disp` reaches. @param {number} disp @param {number} bytes */
    const run = (disp, bytes)=>{
        for (let page = disp >>> 12; page <= (disp + bytes - 1) >>> 12; page++)
        {
            reach.add(page);
        }
    };
    const body = [];
    const forms = 3 + next(6);
    for (let form = 0; form < forms; form++)
    {
        switch (next(12))
        {
            case 0: body.push(0x89, 0x83, ...u32(at(4))); break; // mov [ebx+d], eax
            case 1: body.push(0x88, 0x83, ...u32(at(1))); break; // mov [ebx+d], al
            case 2: body.push(0x66, 0x89, 0x83, ...u32(at(2))); break; // mov [ebx+d], ax
            case 3:
                // Two stores and a read off ebx: one window for the group.
                body.push(0x89, 0x83, ...u32(at(4)), 0x8b, 0x8b, ...u32(next(PAGES * 4096 - 4)),
                    0x89, 0x8b, ...u32(at(4)));
                break;
            case 4: body.push(0xd9, 0xe8, 0xd9, 0x9b, ...u32(at(4))); break; // fld1; fstp [ebx+d]
            case 5: body.push(0x0f, 0x11, 0x83, ...u32(at(16))); break; // movups [ebx+d], xmm0
            case 6: body.push(0xf0, 0x0f, 0xc1, 0x83, ...u32(at(4))); break; // lock xadd
            case 7: body.push(0x87, 0x83, ...u32(at(4))); break; // xchg [ebx+d], eax
            case 8:
            {
                // A loop's stream: mov edi, a; mov ecx, n; L: mov [edi], eax;
                // add edi, 4; dec ecx; jnz L
                const n = 1 + next(700);
                const disp = next(PAGES * 4096 - 4 * n + 1) & ~3;
                run(disp, 4 * n);
                body.push(0xbf, ...u32(DATA + disp), 0xb9, ...u32(n),
                    0x89, 0x07, 0x83, 0xc7, 0x04, 0x49, 0x75, 0xf8);
                break;
            }
            case 9:
            {
                // rep stosd
                const n = 1 + next(900);
                const disp = next(PAGES * 4096 - 4 * n + 1);
                run(disp, 4 * n);
                body.push(0xbf, ...u32(DATA + disp), 0xb9, ...u32(n), 0xf3, 0xab);
                break;
            }
            case 10:
            {
                // rep movsd, from anywhere in the pages (read only)
                const n = 1 + next(900);
                const disp = next(PAGES * 4096 - 4 * n + 1);
                run(disp, 4 * n);
                body.push(0xbe, ...u32(DATA + next(PAGES * 4096 - 4 * n + 1)),
                    0xbf, ...u32(DATA + disp), 0xb9, ...u32(n), 0xf3, 0xa5);
                break;
            }
            default:
                // lock cmpxchg [ebx+d], ecx
                body.push(0xf0, 0x0f, 0xb1, 0x8b, ...u32(at(4)));
                break;
        }
    }
    // mov edx, rounds; L0: body; inc eax; dec edx; jnz L0; hlt
    const loop = [...body, 0x40, 0x4a, 0x0f, 0x85, ...u32(-(body.length + 2 + 6))];
    return { code: [0xba, ...u32(4 + next(12)), ...loop, 0xf4], reach };
}

/** The pages whose bytes differ. @param {Uint8Array} was @param {Uint8Array} now */
function changedPages(was, now){
    /** @type {number[]} */
    const pages = [];
    for (let page = 0; page < PAGES; page++)
    {
        for (let at = page * 4096; at < (page + 1) * 4096; at++)
        {
            if (was[at] !== now[at])
            {
                pages.push(page);
                break;
            }
        }
    }
    return pages;
}

/** A turn of the event loop, in which a translation lands. */
const settle = ()=>new Promise(resolve=>setTimeout(resolve, 0));

/**
 * Runs `rounds` rounds of one program, on the process's own executor or on
 * `remote`, and checks what each took against what changed.
 *
 * @param {any} host @param {any} remote @param {{ code: number[], reach: Set<number> }} made
 * @param {(n: number) => number} next @param {string} name
 * @param {{ watch: (address: number, length: number) =>
 *     import('./write-clock.js').WriteWatch }} clock
 */
async function check(host, remote, made, next, name, clock){
    host.writePhysical(CODE, new Uint8Array(made.code));
    host.writePhysical(DATA, new Uint8Array(PAGES * 4096).map(()=>next(256)));
    const watch = clock.watch(DATA, PAGES * 4096);
    for (let round = 0; round < 4; round++)
    {
        const before = host.readPhysical(DATA, PAGES * 4096).slice();
        for (const reg of REGISTERS)
        {
            host.writeReg32(reg, next(1 << 30));
        }
        host.writeReg32('ebx', DATA);
        host.writeReg32('esp', 0x300000);
        host.writeReg32('eip', CODE);
        if (remote === null)
        {
            for (let turn = 0; turn < 100_000 && (turn === 0 || !host.halted()); turn++)
            {
                host.runSlice(1 + next(300));
                await host.cork().translatePending();
            }
        }
        else
        {
            remote.block().set(host.block());
            let slice = remote.runSlice(1 + next(300));
            for (let turn = 1; turn < 100_000 && !slice.halted; turn++)
            {
                await settle();
                slice = remote.runSlice(1 + next(300));
            }
            assert.equal(slice.fault, null, `${name} round ${round}: no fault`);
        }
        const changed = changedPages(before, host.readPhysical(DATA, PAGES * 4096));
        const taken = new Set(watch.take(DATA, PAGES * 4096)
            .map((/** @type {number} */ page)=>page - (DATA >>> 12)));
        for (const page of changed)
        {
            assert.ok(taken.has(page), `${name} round ${round}: page ${page} changed and was not `
                + `taken (${[...taken]}): ${made.code.map(b=>b.toString(16)).join(' ')}`);
        }
        for (const page of taken)
        {
            assert.ok(made.reach.has(page), `${name} round ${round}: page ${page} taken, which no `
                + `store reaches`);
        }
    }
    // The host's own write.
    const page = next(PAGES);
    host.writePhysical(DATA + page * 4096 + next(4000), new Uint8Array([1, 2, 3]));
    assert.deepEqual(watch.take(DATA, PAGES * 4096), [(DATA >>> 12) + page],
        `${name}: the host's write`);
}

/**
 * A clock over `host`'s marks, with `remote`'s count of its runs.
 * @param {any} host @param {any} [remote]
 */
const clockOf = (host, remote)=>createWriteClock({ take: host.takeWrites,
    epochs: ()=>(remote ? [0, remote.epoch()] : []) });

test('every store to a watched page marks it, on every path and on another executor', {
    timeout: 300_000 }, async()=>{
    const next = random(0x3a7c);
    const local = createCorkHost({ ...CONFIG, engine });
    local.onTrap(()=>{});
    const clock = clockOf(local);
    for (let index = 0; index < 40; index++)
    {
        await check(local, null, program(next), next, `program ${index}`, clock);
    }
    assert.ok(local.cork().diagnostics().modules > 0, 'translated');

    const process = createCorkHost({ ...CONFIG, engine, executors: 2 });
    process.onTrap(()=>{});
    const remote = await createRemoteExecutor({ host: process, index: 1, engineUrl: ENGINE_URL,
        config: { ...CONFIG, executors: 2 } });
    try
    {
        const both = clockOf(process, remote);
        for (let index = 0; index < 20; index++)
        {
            await check(process, remote, program(next), next, `remote program ${index}`, both);
        }
        assert.ok((await remote.diagnostics())?.modules > 0, 'translated on the other executor');
    }
    finally
    {
        await remote.close();
    }
});

test('a page never armed is taken as written, and one on a stack while its stores go '
    + 'untested always is', ()=>{
    const host = createCorkHost({ ...CONFIG, engine });
    assert.deepEqual(host.takeWrites(DATA, 2 * 4096), [DATA >>> 12, (DATA >>> 12) + 1],
        'never armed: either may differ');
    assert.deepEqual(host.takeWrites(DATA, 2 * 4096), [], 'armed since');
    host.noteStack(DATA, 4096);
    assert.deepEqual(host.takeWrites(DATA, 2 * 4096), [DATA >>> 12], 'the stack\'s page');
    assert.deepEqual(host.takeWrites(DATA, 2 * 4096), [DATA >>> 12], 'every time');
});

/** Pages the stores in flight are watched over: one a round, each written in one round only. */
const WIDE = 256;

/**
 * `edx` rounds, each over a page of its own from `edi`: stores that mark the
 * page and the three after it, then a loop's stream over the whole page --
 * tested once for its thousand turns against pages all marked written, so
 * its turns run untested -- then `ebp` turns of a wait in registers, for the
 * process to look. The code is the same for every run, so that its
 * translation stays; a page's last stores are its own round's stream.
 */
const ROUNDS = (()=>{
    // L0: mov [edi], eax; mov [edi+4096], eax; mov [edi+8192], eax;
    //     mov [edi+12288], eax; mov ecx, 1024; mov esi, edi
    //   L1: mov [esi], eax; add esi, 4; dec ecx; jnz L1
    //   mov ecx, ebp; L2: dec ecx; jnz L2
    //   add edi, 4096; inc eax; dec edx; jnz L0
    const body = [0x89, 0x07, 0x89, 0x87, ...u32(4096), 0x89, 0x87, ...u32(8192),
        0x89, 0x87, ...u32(12288), 0xb9, ...u32(1024), 0x89, 0xfe,
        0x89, 0x06, 0x83, 0xc6, 0x04, 0x49, 0x75, 0xf8,
        0x89, 0xe9, 0x49, 0x75, 0xfd,
        0x81, 0xc7, ...u32(4096), 0x40, 0x4a];
    return [...body, 0x0f, 0x85, ...u32(-(body.length + 6)), 0xf4];
})();

test('a copy kept by what the watch takes while another executor stores is the memory once the '
    + 'stores end', { timeout: 300_000 }, async()=>{
    // A stream tests its page once for a thousand turns, the page marked
    // written; a look takes the page and arms it again; the turns left land
    // unmarked, and the look after them found the page clean unless the clock
    // still held it -- and the page, written in no later round, kept them from
    // the copy for good.
    const next = random(0x51ce);
    const process = createCorkHost({ ...CONFIG, engine, executors: 2 });
    process.onTrap(()=>{});
    const remote = await createRemoteExecutor({ host: process, index: 1, engineUrl: ENGINE_URL,
        config: { ...CONFIG, executors: 2 } });
    const clock = clockOf(process, remote);
    process.writePhysical(CODE, new Uint8Array(ROUNDS));
    let held = 0;
    /**
     * A run of `rounds` rounds from the start of the watched pages, the copy
     * kept by looking all the while; answers the pages of it left stale.
     *
     * @param {number} rounds
     */
    const run = async rounds=>{
        const watch = clock.watch(DATA, WIDE * 4096);
        const copy = process.readPhysical(DATA, WIDE * 4096).slice();
        const look = ()=>{
            for (const page of watch.take(DATA, WIDE * 4096))
            {
                copy.set(process.readPhysical(page << 12, 4096), (page << 12) - DATA);
            }
            held = Math.max(held, clock.unsettled());
        };
        process.writeReg32('eax', next(1 << 30));
        process.writeReg32('edi', DATA);
        process.writeReg32('edx', rounds);
        process.writeReg32('ebp', 2000 + next(20_000));
        process.writeReg32('esp', 0x300000);
        process.writeReg32('eip', CODE);
        remote.block().set(process.block());
        remote.start(1 + next(200_000));
        for (let turn = 0; ; turn++)
        {
            look();
            const slice = remote.step();
            if (slice !== null)
            {
                assert.equal(slice.fault, null);
                if (slice.halted)
                {
                    break;
                }
                remote.start(1 + next(200_000));
            }
            if (turn % 256 === 255)
            {
                await settle();
            }
        }
        look();
        const now = process.readPhysical(DATA, WIDE * 4096);
        /** @type {number[]} */
        const stale = [];
        for (let page = 0; page < WIDE; page++)
        {
            if (Buffer.compare(copy.subarray(page * 4096, (page + 1) * 4096),
                now.subarray(page * 4096, (page + 1) * 4096)) !== 0)
            {
                stale.push(page);
            }
        }
        return stale;
    };
    try
    {
        // Until the loop runs translated on the other executor.
        for (let warm = 0; warm < 200 && ((await remote.diagnostics())?.modules ?? 0) === 0;
            warm++)
        {
            await run(16);
            await new Promise(resolve=>setTimeout(resolve, 5));
        }
        assert.ok(((await remote.diagnostics())?.modules ?? 0) > 0, 'translated there');
        for (let index = 0; index < 8; index++)
        {
            assert.deepEqual(await run(WIDE - 3), [], `run ${index}: no page of the copy is stale`);
        }
        assert.ok(held > 0, 'pages were held for a run in flight');
    }
    finally
    {
        await remote.close();
    }
});
