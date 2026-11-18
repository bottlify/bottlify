/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a guest routine hands the host on another executor is published with a
 * locked instruction, and read in order after it.
 *
 * On several executors the translated code's plain stores are the host's plain
 * stores, and a host that reorders them (arm64) may show another thread a store
 * before the ones made ahead of it. The routines publish with the two kinds of
 * access the engine makes atomic there, `xchg` with memory and a `lock` prefix:
 * the device's lock let go (`SHADOW.HELD`), and a command record's length, the
 * last word written of it. A `mov` in either place let the host find the lock
 * free or a record whole while the record, a buffer's block or the vertices the
 * program wrote before the call were not there yet: models of Call of Duty 4
 * drawn now and then from the bytes of the frame before, on an M4 with its
 * renderer on another executor, and never on one executor.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommandReader } from './shadow.js';
import { COMMAND, SHADOW } from './block.js';
import { I386, X64 } from './routines/assemble.js';
import { ROUTINE_AT, routinesFor } from './routines/catalog.fixture.js';
import { lockCode } from './routines/locks.js';
import { MODE_64, decode } from '../../../../../cork/src/decode/decoder.js';

const AT = ROUTINE_AT;
const TRAP = 0x105000;
const EAX = 0;
const EDI = 7;
/** The operations that only read their memory operand. */
const READS = new Set(['cmp', 'test', 'bt', 'push', 'lea', 'jmp', 'call']);

/**
 * Every instruction of `code` that writes memory, with its memory operand:
 * x86-64 under `MODE_64`, the routines a 64-bit process runs.
 *
 * @param {Uint8Array} code @param {typeof MODE_64} [mode]
 * @returns {{ op: string, lock: boolean, mem: any }[]}
 */
function stores(code, mode){
    /** @type {{ op: string, lock: boolean, mem: any }[]} */
    const found = [];
    for (let at = 0; at < code.length;)
    {
        const decoded = decode(address=>code[address - AT] ?? 0, AT + at, mode);
        assert.ok(!('reason' in decoded), `an instruction the decoder refuses at +${at}`);
        const instruction = /** @type {any} */ (decoded);
        /** @type {any[]} */
        const operands = instruction.operands ?? [];
        const mem = operands.find(operand=>operand?.kind === 'mem');
        const writes = mem !== undefined && !READS.has(instruction.op)
            && (instruction.op === 'xchg' || operands[0] === mem);
        if (writes)
        {
            found.push({ op: instruction.op, lock: instruction.prefixes?.lock === true, mem });
        }
        at += instruction.length;
    }
    return found;
}

/** Whether a store is published: `xchg` with memory, or `lock`-prefixed. @param {{ op: string, lock: boolean }} store */
const published = store=>store.op === 'xchg' || store.lock;

/**
 * Asserts that no store of `code` lets the device's lock go as a plain one.
 *
 * @param {string} name @param {Uint8Array} code @param {typeof MODE_64} [mode]
 */
function heldPublished(name, code, mode){
    for (const store of stores(code, mode))
    {
        if (store.mem.disp === SHADOW.HELD)
        {
            assert.ok(published(store), `${name}: ${store.op} [..+HELD] is not locked`);
        }
    }
}

/** Each width's routines with the decoder's mode for it. */
const WIDTHS = /** @type {const} */ ([['i386', I386, undefined], ['x86-64', X64, MODE_64]]);

test('the routines a 64-bit process runs are read as x86-64', ()=>{
    const names = routinesFor(X64).map(routine=>routine.name);
    assert.ok(names.includes('GetRenderState'), `built for 64 bits: ${names.join(', ')}`);
});

for (const [label, width, mode] of WIDTHS)
{
    test(`every routine lets the device's lock go with a locked store (${label})`, ()=>{
        const routines = routinesFor(width);
        let released = 0;
        for (const { name, code } of routines)
        {
            heldPublished(name, code, mode);
            released += stores(code, mode).filter(store=>store.mem.disp === SHADOW.HELD).length;
        }
        // The count says the rule read something: in the i386, every routine lets the
        // lock go; at 64 bits, the routines built for it so far.
        const holding = routines.filter(routine=>routine.command).length;
        assert.ok(released >= holding, `the lock let go in the routines: ${released} stores`);
        if (width === I386)
        {
            assert.ok(released > routines.length, `${released} stores`);
        }
    });

    test(`a command record's length is its last word, published with xchg (${label})`, ()=>{
        const routines = routinesFor(width).filter(routine=>routine.command);
        if (width === I386)
        {
            assert.ok(routines.length > 150,
                `every interface's command routines: ${routines.length}`);
        }
        for (const { name, code } of routines)
        {
            const lengths = stores(code, mode)
                .filter(store=>store.mem.base === EDI && store.mem.index < 0
                    && store.mem.disp === COMMAND.BYTES);
            assert.equal(lengths.length, 1, `${name}: one store of the record's length`);
            assert.equal(lengths[0].op, 'xchg', `${name}: the length is published with xchg`);
        }
    });
}

test('the record of a buffer\'s move is published with xchg', ()=>{
    const moved = stores(lockCode(AT, TRAP, 0x7f, AT + 0x1000))
        .filter(store=>store.mem.base === EAX && store.mem.index < 0
            && store.mem.disp === COMMAND.BYTES);
    assert.equal(moved.length, 1, 'the move writes its record\'s length once');
    assert.equal(moved[0].op, 'xchg', 'with xchg');
});

test('the host reads each record\'s length with the atomic read before its words', ()=>{
    // A ring of two records whose lengths a plain read sees only once each was
    // read atomically -- as a host that reorders stores shows them: before
    // that, a plain copy holds zeros where they are.
    const block = 0x1000;
    const ring = 0x2000;
    const lengths = new Map([[ring + COMMAND.BYTES, 16], [ring + 16 + COMMAND.BYTES, 12]]);
    /** @type {Uint8Array[]} */
    const taken = [];
    let atomicReads = 0;
    const reader = createCommandReader({
        block, ring, bytes: 4096,
        readWord: address=>(address === block + SHADOW.COMMAND_HEAD ? 28 : 0),
        readWords: (address, words)=>{
            const copy = new Uint32Array(words);
            for (let at = 0; at < words; at++)
            {
                copy[at] = atomicReads < lengths.size ? 0 : lengths.get(address + 4 * at) ?? 0;
            }
            return copy;
        },
        loadU32: address=>{
            atomicReads++;
            return lengths.get(address) ?? 0;
        },
        writeMemory: ()=>{},
        take: records=>{
            taken.push(records.slice());
            return 2;
        },
        refuse: detail=>assert.fail(detail),
    });
    reader.take();
    assert.equal(atomicReads, 2, 'each record\'s length read atomically');
    assert.equal(taken.length, 1, 'the two records taken');
    assert.equal(taken[0].length, 28, 'whole, the words copied after the lengths were read');
});
