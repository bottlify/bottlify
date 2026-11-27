/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDLIST_ORDINALS, createIdListFunctions } from './idlist.js';
import { SHELL32_ORDINALS } from './functions.js';

/** Guest memory with a heap, and lists put in it item by item. */
function machine(){
    const memory = new Uint8Array(0x10000);
    let heap = 0x8000;
    /** @type {number[]} */
    const freed = [];
    const fns = createIdListFunctions({
        readMemory: (at, length)=>memory.subarray(at, at + length),
        writeMemory: (at, bytes)=>memory.set(bytes, at),
        allocate: bytes=>{
            const at = heap;
            heap += bytes + 8;
            return at;
        },
        free: at=>{
            freed.push(at);
        },
    });
    let next = 0x100;
    /**
     * A list of items whose data are the strings given.
     *
     * @param {...string} items
     */
    const list = (...items)=>{
        const at = next;
        for (const item of items)
        {
            memory[next] = (item.length + 2) & 0xff;
            memory[next + 1] = (item.length + 2) >>> 8;
            memory.set(Array.from(item, c=>c.charCodeAt(0)), next + 2);
            next += item.length + 2;
        }
        memory[next] = 0;
        memory[next + 1] = 0;
        next += 16;
        return at;
    };
    /** @param {number} at */
    const items = at=>{
        /** @type {string[]} */
        const out = [];
        for (let cb = memory[at] | memory[at + 1] << 8; cb !== 0;
            at += cb, cb = memory[at] | memory[at + 1] << 8)
        {
            out.push(String.fromCharCode(...memory.subarray(at + 2, at + cb)));
        }
        return out;
    };
    return { fns, memory, freed, list, items };
}

test('the item id functions are exported by their numbers', ()=>{
    for (const [ordinal, name] of IDLIST_ORDINALS)
    {
        assert.equal(SHELL32_ORDINALS[ordinal], name, `#${ordinal}`);
    }
    assert.equal(SHELL32_ORDINALS[155], 'ILFree');
    assert.equal(SHELL32_ORDINALS[16], 'ILFindLastID');
});

test('a list is walked by its items\' cb words, whatever they hold', ()=>{
    const m = machine();
    const abc = m.list('a', 'bb', 'ccc');
    assert.equal(m.fns.ILGetSize.handler([abc]), 3 + 4 + 5 + 2, 'the terminator counted');
    assert.equal(m.fns.ILGetSize.handler([0]), 0);
    assert.equal(m.fns.ILGetNext.handler([abc]), abc + 3);
    assert.equal(m.fns.ILGetNext.handler([abc + 7]), 0, 'none after the last');
    assert.equal(m.fns.ILFindLastID.handler([abc]), abc + 7);
    const empty = m.list();
    assert.equal(m.fns.ILFindLastID.handler([empty]), empty, 'the list itself when empty');
    assert.equal(m.fns.ILRemoveLastID.handler([abc]), 1);
    assert.deepEqual(m.items(abc), ['a', 'bb']);
    assert.equal(m.fns.ILRemoveLastID.handler([empty]), 0);
});

test('lists are copied, compared, joined and freed', ()=>{
    const m = machine();
    const ab = m.list('a', 'bb');
    const clone = m.fns.ILClone.handler([ab]);
    assert.notEqual(clone, ab);
    assert.deepEqual(m.items(clone), ['a', 'bb']);
    assert.equal(m.fns.ILIsEqual.handler([ab, clone]), 1);
    assert.equal(m.fns.ILIsEqual.handler([ab, m.list('a', 'bc')]), 0);
    assert.equal(m.fns.ILIsEqual.handler([ab, 0]), 0, 'never for a missing list');
    assert.deepEqual(m.items(m.fns.ILCloneFirst.handler([ab])), ['a']);
    const joined = m.fns.ILCombine.handler([ab, m.list('ccc')]);
    assert.deepEqual(m.items(joined), ['a', 'bb', 'ccc']);
    assert.deepEqual(m.items(m.fns.ILCombine.handler([0, ab])), ['a', 'bb'], 'one missing');
    assert.equal(m.fns.ILCombine.handler([0, 0]), 0);
    assert.equal(m.fns.ILIsParent.handler([ab, joined, 1]), 1);
    assert.equal(m.fns.ILIsParent.handler([m.list('a'), joined, 1]), 0, 'not the immediate parent');
    assert.equal(m.fns.ILIsParent.handler([m.list('a'), joined, 0]), 1);
    assert.equal(m.fns.ILIsParent.handler([ab, ab, 0]), 0, 'a list is not its own parent');
    assert.equal(m.fns.ILFindChild.handler([ab, joined]), joined + 7);
    assert.equal(m.fns.ILFindChild.handler([m.list('x'), joined]), 0);
    const appended = m.fns.ILAppendID.handler([clone, m.list('z'), 1]);
    assert.deepEqual(m.items(appended), ['a', 'bb', 'z']);
    assert.ok(m.freed.includes(clone), 'the old list freed');
    assert.deepEqual(m.items(m.fns.ILAppendID.handler([appended, m.list('y'), 0])),
        ['y', 'a', 'bb', 'z'], 'or put first');
    m.fns.ILFree.handler([0]);
    m.fns.ILFree.handler([joined]);
    assert.equal(m.freed.at(-1), joined);
});
