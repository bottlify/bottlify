/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The three-byte maps' forms (SSSE3, SSE4.1, SSE4.2 and movbe) in a translated
 * loop: every form of the maps once a turn, on registers and on memory, two
 * hundred turns. The runtime runs it translated whole -- no way out to the
 * interpreter, where an untranslated form cost an exit a run -- and it leaves
 * what the interpreter leaves. What each form computes is the hardware
 * corpus's to say (`x86-corpus.json.gz`, the cases of `tools/generators/x86-corpus.mjs`'s
 * sse4 family).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownLayout, pagesFor, tablesSize } from './layout.js';
import { createCorkRuntime } from './runtime.js';
import { blockState, interpret } from '../interp.js';
import { eflagsOf } from '../emit/flags.js';

const CODE = 0x401000;
const DATA = 0x500000;

/**
 * mov ebp, 200; mov esi, DATA; L: pshufb ... (every form of the maps); paddd xmm0, xmm1;
 * dec ebp; jnz L; hlt -- assembled from the Intel syntax by llvm-mc.
 */
const LOOP = [
    'bdc8000000be00005000660f3800c1660f3801ca660f3802d3660f3803dc660f3805e5660f3806ee660f3807',
    'f7660f3804f8660f3808c2660f3809cb660f380ad4660f380bdd660f381ce6660f381def660f381ef0660f3a',
    '0ff9050f3800c10f3801ca0f3a0fd3030f381edc0f77660f3810ca660f3814d3660f3815dc660f3a0ce50566',
    '0f3a0dee01660f3a0ef73c660f3817ca0f94c00f92c4660f3820ca660f383116660f38225e04660f38336608',
    '660f3824ee660f3835f7660f3828ca660f3829d3660f382bdc660f3838e5660f3839ee660f383af7660f383b',
    'f9660f383cca660f383dd3660f383edc660f383fe5660f3840ee660f3841f7660f3837f9660f382a4e10660f',
    '3a08d301660f3a09dc02660f3a0ae503660f3a0b6e2004660f3a40f7f1660f3a41f931660f3a42ca05660f3a',
    '14d203660f3a155e3005660f3a16663402660f3a17ef01660f3a20f209660f3a227e3803660f3a21ca9ab807',
    '000000ba09000000660f3a61d30c660f3a60dc44660f3a63664018660f3a62ee00f20f38f05e0366f20f38f1',
    'daf20f38f1df0f38f0563c660f38f15650660ffec14d0f8562fefffff4',
].join('');

/**
 * Runs the loop to its hlt, translated or on the interpreter alone.
 *
 * @param {boolean} translate
 * @returns {Promise<{ state: Uint8Array, diagnostics: any }>}
 */
async function run(translate){
    const layout = ownLayout({ ramSize: 16 << 20, hashSlots: 1 << 16 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, tablesSize(layout)) });
    const bytes = ()=>new Uint8Array(memory.buffer);
    const view = ()=>new DataView(memory.buffer);
    view().setUint8(layout.x87Empty, 0xff);
    view().setUint16(layout.x87Control, 0x37f, true);
    view().setUint32(layout.mxcsr, 0x1f80, true);
    const runtime = createCorkRuntime({
        memory, layout, config: { precise: true },
        read: address=>bytes()[layout.ramBase + address],
        imports: { trap: ()=>0, rdtsc: ()=>0n },
    });
    const code = Uint8Array.from(LOOP.match(/../g) ?? [], pair=>parseInt(pair, 16));
    bytes().set(code, layout.ramBase + CODE);
    for (let i = 0; i < 128; i++)
    {
        bytes()[layout.ramBase + DATA + i] = (i * 37 + 11) & 0xff;
    }
    for (let i = 0; i < 32; i++)
    {
        view().setUint32(layout.xmm + i * 4, Math.imul(i + 1, 0x9e3779b1) >>> 0, true);
    }
    view().setUint32(layout.regs + 16, 0x800000, true);
    view().setUint32(layout.eip, CODE, true);
    const eip = ()=>view().getUint32(layout.eip, true);
    for (let turn = 0; turn < 10_000; turn++)
    {
        let entry = -1;
        if (translate)
        {
            if (runtime.entryOf(eip(), 8) < 0)
            {
                runtime.noteHot(eip(), 8);
                await runtime.translatePending();
            }
            entry = runtime.entryOf(eip(), view().getUint8(layout.x87Top));
        }
        if (entry < 0)
        {
            const state = blockState({ memory, layout });
            state.syncIn();
            interpret(state, translate ? 1 : 1_000_000, { force: true });
            state.syncOut();
            if (state.halted)
            {
                break;
            }
        }
        else if (runtime.run(entry, 10_000_000).kind === 'halt')
        {
            break;
        }
    }
    // The general registers, EFLAGS' status flags, the XMM registers and the data.
    const state = new Uint8Array(32 + 4 + 128 + 128);
    state.set(bytes().slice(layout.regs, layout.regs + 32), 0);
    new DataView(state.buffer).setUint32(32, eflagsOf(view(), layout) & 0x8d5, true);
    state.set(bytes().slice(layout.xmm, layout.xmm + 128), 36);
    state.set(bytes().slice(layout.ramBase + DATA, layout.ramBase + DATA + 128), 164);
    return { state, diagnostics: runtime.diagnostics() };
}

test('a loop of the three-byte maps\' forms runs translated whole and leaves what the'
    + ' interpreter leaves', async()=>{
    const translated = await run(true);
    const interpreted = await run(false);
    assert.deepEqual(translated.diagnostics.refused, {}, 'no form refused');
    assert.equal(translated.diagnostics.exits.untranslated, 0, 'no way out to the interpreter');
    assert.ok(translated.diagnostics.regions > 0);
    assert.equal(new DataView(translated.state.buffer).getUint32(20, true), 0,
        'ebp counted down to zero: all two hundred turns ran');
    assert.deepEqual(translated.state, interpreted.state);
});
