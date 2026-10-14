/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Seeded programs for the gate of several translators: pieces of code -- a
 * loop each, with registers it leaves set -- noted hot in a seeded order and
 * translated until every start has an entry, each start then run from the same
 * registers. What a translator path publishes is judged by what those runs
 * observe, against the same program translated inline.
 */

import assert from 'node:assert/strict';
import { ownLayout, pagesFor, tablesSize } from '../runtime/layout.js';
import { createCorkRuntime } from '../runtime/runtime.js';

/** @param {Record<string, unknown>} config */
export function machine(config = {}){
    const layout = ownLayout({ ramSize: 4 << 20, hashSlots: 1 << 16 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, tablesSize(layout)) });
    const bytes = ()=>new Uint8Array(memory.buffer);
    const view = ()=>new DataView(memory.buffer);
    view().setUint8(layout.x87Empty, 0xff);
    view().setUint16(layout.x87Control, 0x37f, true);
    const runtime = createCorkRuntime({
        memory, layout, config,
        read: address=>bytes()[layout.ramBase + address],
        imports: { trap: ()=>0, getEflags: ()=>view().getUint32(layout.eflags, true),
            x87Read: ()=>0, rdtsc: ()=>0n },
    });
    return {
        runtime,
        /** @param {number} at @param {number[]} code */
        write(at, code){
            bytes().set(code, layout.ramBase + at);
        },
        /** @param {number} index @param {number} value */
        setReg(index, value){
            view().setUint32(layout.regs + index * 4, value >>> 0, true);
        },
        /** @param {number} index */
        reg(index){
            return view().getUint32(layout.regs + index * 4, true);
        },
    };
}

/** @param {ReturnType<typeof machine>} m @param {number} count */
export async function untilTranslatorsLoaded(m, count){
    for (let i = 0; i < 500; i++)
    {
        const d = m.runtime.diagnostics();
        if (/** @type {any} */ (d).translatorsReady === count)
        {
            return;
        }
        await new Promise(resolve=>setTimeout(resolve, 10));
    }
    assert.fail('the translators loaded');
}

/** @param {ReturnType<typeof machine>} m @param {() => boolean} done */
export async function translateUntil(m, done){
    for (let i = 0; i < 400 && !done(); i++)
    {
        await m.runtime.translatePending();
        await new Promise(resolve=>setTimeout(resolve, 5));
    }
}

/**
 * mov eax, a; mov ecx, n; L: add eax, k; xor ebx, eax; dec ecx; jnz L; hlt
 * @param {number} a @param {number} n @param {number} k
 * @returns {{ code: number[], loop: number }}  loop: the offset of L
 */
export function piece(a, n, k){
    const le = (/** @type {number} */ v)=>[v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff,
        (v >>> 24) & 0xff];
    const code = [0xb8, ...le(a), 0xb9, ...le(n), 0x05, ...le(k), 0x31, 0xc3, 0x49, 0x75, 0, 0xf4];
    // jnz back to L (offset 10): rel8 from the end of the jnz.
    code[code.length - 2] = (10 - (code.length - 1)) & 0xff;
    return { code, loop: 10 };
}

/** A small seeded generator (mulberry32). @param {number} seed */
export function random(seed){
    let state = seed >>> 0;
    return ()=>{
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * A seeded program of pieces, its starts and loop heads noted hot in a seeded
 * order and batch size, translated until every start has an entry; then each
 * start run from the same registers. What every run is observed to do.
 *
 * @param {number} seed @param {Record<string, unknown>} config
 * @param {(m: ReturnType<typeof machine>) => Promise<number>} [attach]  translators lent from
 *     outside (a host's pool), and how many: awaited before anything is noted
 * @returns {Promise<{ runs: string[], workerMs: number, formedInPart: number,
 *     publishedInPart: number, cacheHits: number, compiledApart: number,
 *     lookedUpInPart: number, relinked: number }>} each start's exit kind, retired count and
 *     registers, or 'untranslated'; the milliseconds translators emitted for it; the calls
 *     that formed or published part of a batch (`holdMs`); the store's hits, their modules
 *     compiled off the thread and the calls that left a batch's answers half read; and the
 *     regions relinks moved
 */
export async function observe(seed, config, attach = undefined){
    const next = random(seed);
    const size = 1 + Math.floor(next() * 6);
    const m = machine({ batchRegions: size, maxBatchRegions: size, ...config });
    /** @type {{ at: number, loop: number }[]} */
    const pieces = [];
    for (let i = 0; i < 24; i++)
    {
        const at = 0x2000 + i * 0x40;
        const { code, loop } = piece(Math.floor(next() * 1e9), 1 + Math.floor(next() * 300),
            Math.floor(next() * 1e9));
        m.write(at, code);
        pieces.push({ at, loop: at + loop });
    }
    try
    {
        if (attach !== undefined)
        {
            await untilTranslatorsLoaded(m, await attach(m));
        }
        else if (config.worker === true)
        {
            await untilTranslatorsLoaded(m, /** @type {number} */ (config.translators));
        }
        const noted = pieces.flatMap(({ at, loop })=>(next() < 0.5 ? [at, loop] : [at]))
            .sort(()=>next() - 0.5);
        for (const at of noted)
        {
            m.runtime.noteHot(at, 0, 2 + Math.floor(next() * 60));
            if (next() < 0.5)
            {
                await m.runtime.translatePending();
            }
        }
        await translateUntil(m, ()=>pieces.every(({ at })=>m.runtime.entryOf(at) >= 0));
        const runs = pieces.map(({ at })=>{
            if (m.runtime.entryOf(at) < 0)
            {
                return 'untranslated';
            }
            for (let r = 0; r < 8; r++)
            {
                m.setReg(r, r === 4 ? 0x80000 : 0);
            }
            const exit = m.runtime.run(m.runtime.entryOf(at), 1_000_000);
            return [exit.kind, exit.retired, m.reg(0), m.reg(1), m.reg(3)].join(',');
        });
        const d = /** @type {any} */ (m.runtime.diagnostics());
        return { runs, workerMs: d.workerMs ?? 0, formedInPart: d.formedInPart,
            publishedInPart: d.publishedInPart, cacheHits: d.cacheHits,
            compiledApart: d.compiledApart, lookedUpInPart: d.lookedUpInPart,
            relinked: d.relinked };
    }
    finally
    {
        await m.runtime.flush();
    }
}

