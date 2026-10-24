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
import {
    COMMAND, SHADOW, commandCode, createCommandReader, getRenderStateCode, getSamplerStateCode,
    getShaderCode, getSurfaceDescCode, getSurfaceLevelCode, getTargetCode, getTextureStageStateCode,
    getTransformCode, getViewportCode, lock7Code, lockCode, lockLevelCode, moveCopyCode,
    unlockCode, unlockLevelCode,
} from './shadow.js';
import { COMMANDS as D3D9_COMMANDS, commandSlot as d3d9Slot } from '../d3d9/commands.js';
import { D3D8_COMMANDS } from '../d3d8/commands.js';
import { D3D7_COMMANDS } from '../d3d7/commands.js';
import { GL_COMMANDS } from '../opengl/commands.js';
import { decode } from '../../../../../cork/src/decode/decoder.js';

const AT = 0x20000;
const TRAP = 0x105000;
const EAX = 0;
const EDI = 7;
/** The operations that only read their memory operand. */
const READS = new Set(['cmp', 'test', 'bt', 'push', 'lea', 'jmp', 'call']);

/**
 * Every instruction of `code` that writes memory, with its memory operand.
 *
 * @param {Uint8Array} code
 * @returns {{ op: string, lock: boolean, mem: any }[]}
 */
function stores(code){
    /** @type {{ op: string, lock: boolean, mem: any }[]} */
    const found = [];
    for (let at = 0; at < code.length;)
    {
        const decoded = decode(address=>code[address - AT] ?? 0, AT + at);
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
 * @param {string} name @param {Uint8Array} code
 */
function heldPublished(name, code){
    for (const store of stores(code))
    {
        if (store.mem.disp === SHADOW.HELD)
        {
            assert.ok(published(store), `${name}: ${store.op} [..+HELD] is not locked`);
        }
    }
}

/** The command routines of every interface that records calls in the guest. */
function commandRoutines(){
    /** @type {[string, Uint8Array][]} */
    const routines = [];
    /**
     * @param {string} family @param {Record<string, any>} table
     * @param {(name: string) => number} slotOf @param {Record<string, any>} [more]
     */
    const add = (family, table, slotOf, more = {})=>{
        for (const [name, shape] of Object.entries(table))
        {
            routines.push([`${family} ${name}`,
                commandCode(AT, TRAP, { ...shape, slot: slotOf(name), ...more })]);
        }
    };
    add('d3d9', D3D9_COMMANDS, d3d9Slot);
    add('d3d8', D3D8_COMMANDS.COMMANDS, D3D8_COMMANDS.commandSlot);
    add('d3d7', D3D7_COMMANDS.COMMANDS, D3D7_COMMANDS.commandSlot);
    add('opengl', GL_COMMANDS.COMMANDS, GL_COMMANDS.commandSlot, { thread: true });
    return routines;
}

test('every routine lets the device\'s lock go with a locked store', ()=>{
    /** @type {[string, Uint8Array][]} */
    const routines = [
        ['lock', lockCode(AT, TRAP)],
        ['lock with moves', lockCode(AT, TRAP, 0x7f, AT + 0x1000)],
        ['the copy of a move', moveCopyCode()],
        ['lock7', lock7Code(AT, TRAP)],
        ['unlock', unlockCode(AT, TRAP)],
        ['texture LockRect', lockLevelCode(AT, TRAP, { find: 'texture' })],
        ['texture LockBox', lockLevelCode(AT, TRAP, { find: 'texture', box: true })],
        ['surface LockRect', lockLevelCode(AT, TRAP, { find: 'surface' })],
        ['texture UnlockRect', unlockLevelCode(AT, TRAP, { find: 'texture' })],
        ['surface UnlockRect', unlockLevelCode(AT, TRAP, { find: 'surface' })],
        ['GetRenderTarget', getTargetCode(AT, TRAP, { depth: false, indexed: true })],
        ['GetDepthStencilSurface', getTargetCode(AT, TRAP, { depth: true, indexed: false })],
        ['GetRenderState', getRenderStateCode(AT, TRAP)],
        ['GetTransform', getTransformCode(AT, TRAP)],
        ['GetTextureStageState', getTextureStageStateCode(AT, TRAP, 0xffffffff)],
        ['GetViewport', getViewportCode(AT, TRAP)],
        ['GetVertexShader', getShaderCode(AT, TRAP, 0)],
        ['GetPixelShader', getShaderCode(AT, TRAP, 1)],
        ['GetSurfaceDesc', getSurfaceDescCode(AT, TRAP)],
        ['GetSamplerState', getSamplerStateCode(AT, TRAP)],
        ['GetSurfaceLevel', getSurfaceLevelCode(AT, TRAP)],
        ...commandRoutines(),
    ];
    let released = 0;
    for (const [name, code] of routines)
    {
        heldPublished(name, code);
        released += stores(code).filter(store=>store.mem.disp === SHADOW.HELD).length;
    }
    assert.ok(released > routines.length, `the lock let go in the routines: ${released} stores`);
});

test('a command record\'s length is its last word, published with xchg', ()=>{
    const routines = commandRoutines();
    assert.ok(routines.length > 150, `every interface's command routines: ${routines.length}`);
    for (const [name, code] of routines)
    {
        const lengths = stores(code)
            .filter(store=>store.mem.base === EDI && store.mem.index < 0
                && store.mem.disp === COMMAND.BYTES);
        assert.equal(lengths.length, 1, `${name}: one store of the record's length`);
        assert.equal(lengths[0].op, 'xchg', `${name}: the length is published with xchg`);
    }
    // And the record of a buffer's move onto another of its storages.
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
