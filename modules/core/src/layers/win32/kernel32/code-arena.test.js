/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGE, createCodeArena } from './code-arena.js';

/** A heap that hands out spans back to back from an odd start, as a free list does. */
function heap(){
    let next = 0x100008;
    /** @type {[number, number][]} */
    const given = [];
    return {
        given,
        /** @param {number} bytes */
        allocate(bytes){
            const at = next;
            next += bytes;
            given.push([at, bytes]);
            return at;
        },
    };
}

test('code placed in the arena never shares a page with anything else the heap handed out', ()=>{
    const memory = heap();
    const placeCode = createCodeArena(bytes=>memory.allocate(bytes));
    /** @type {[number, number][]} */
    const code = [];
    /** @type {[number, number][]} */
    const data = [];
    // Code and data asked for in turn, as the engine and a program would.
    for (let i = 0; i < 400; i++)
    {
        const bytes = 20 + i % 90;
        code.push([placeCode(bytes), bytes]);
        data.push([memory.allocate(8), 8]);
    }
    const pagesOf = (/** @type {[number, number][]} */ list)=>new Set(list.flatMap(([at, bytes])=>{
        const pages = [];
        for (let page = Math.floor(at / PAGE); page <= Math.floor((at + bytes - 1) / PAGE); page++)
        {
            pages.push(page);
        }
        return pages;
    }));
    const codePages = pagesOf(code);
    for (const page of pagesOf(data))
    {
        assert.equal(codePages.has(page), false, `data on code page ${page.toString(16)}`);
    }
    // Pieces of code do not overlap one another.
    const sorted = [...code].sort((a, b)=>a[0] - b[0]);
    for (let i = 1; i < sorted.length; i++)
    {
        assert.ok(sorted[i][0] >= sorted[i - 1][0] + sorted[i - 1][1]);
    }
});

test('code larger than a page gets pages enough, and an empty heap answers 0', ()=>{
    const memory = heap();
    const placeCode = createCodeArena(bytes=>memory.allocate(bytes));
    const at = placeCode(PAGE + 100);
    assert.equal(at % PAGE, 0);
    const [span, bytes] = memory.given[0];
    assert.ok(at >= span && at + PAGE + 100 <= span + bytes);
    assert.equal(createCodeArena(()=>0)(64), 0);
});
