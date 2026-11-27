/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Which callees of an indirect call are formed into its region
 * (`calleesWorth`), by the samples of where the call went.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calleesWorth } from './relink.js';

/** Callees 0x1000, 0x1004, ... with these counts. @param {number[]} counts */
const sampled = counts=>new Map(counts.map((times, k)=>[0x1000 + 4 * k, times]));
/** @param {number[]} counts */
const total = counts=>counts.reduce((sum, times)=>sum + times, 0);
/** How many of `counts`' callees are worth it, at most `most`.
 * @param {number[]} counts @param {number} [most] @param {number} [doubt] */
const worth = (counts, most = 32, doubt = 1)=>
    calleesWorth(sampled(counts), total(counts), most, doubt).length;

test('a call that goes to one callee, or to a few, has them all formed in', ()=>{
    assert.deepEqual(calleesWorth(sampled([48]), 48, 32), [0x1000]);
    assert.deepEqual(calleesWorth(sampled([21, 24, 3]), 48, 32), [0x1000, 0x1004, 0x1008]);
    assert.equal(worth(Array.from({ length: 8 }, ()=>6)), 8, 'eight, a sample in eight each');
});

test('callees are given by address, whichever had more samples', ()=>{
    // The same three methods a third of the calls each, as readings saw them, and two of
    // which one is called twice as often.
    for (const counts of [[21, 24, 19], [24, 19, 21], [19, 21, 24], [30, 16, 18], [13, 3, 0]])
    {
        const taken = calleesWorth(sampled(counts), total(counts), 32);
        assert.deepEqual(taken, [...taken].sort((a, b)=>a - b), `${counts}`);
    }
    assert.deepEqual(calleesWorth(sampled([16, 32]), 48, 32), [0x1000, 0x1004]);
    assert.deepEqual(calleesWorth(sampled([78, 6, 7, 5]), 96, 32),
        [0x1000, 0x1004, 0x1008, 0x100c]);
    // Evenly over twenty-four, every reading's samples a different draw: one order.
    let seed = 12345;
    const next = ()=>(seed = seed * 1103515245 + 12345 >>> 0) / 2 ** 32;
    for (let draw = 0; draw < 200; draw++)
    {
        const counts = Array.from({ length: 24 }, ()=>0);
        for (let i = 0; i < 24 * 8; i++)
        {
            counts[Math.floor(next() * 24)]++;
        }
        const taken = calleesWorth(sampled(counts), 24 * 8, 32);
        assert.deepEqual(taken, [...taken].sort((a, b)=>a - b), `draw ${draw}: ${counts}`);
    }
});

test('a call spread evenly over two dozen callees, or over as many as may be formed in, has'
    + ' them all', ()=>{
    assert.equal(worth(Array.from({ length: 24 }, ()=>8)), 24);
    assert.equal(worth(Array.from({ length: 32 }, ()=>8)), 32);
});

test('a call spread over more callees than pay for their compares has none', ()=>{
    // Sixty-four evenly, the thirty-two that may be formed in half the calls: a call to
    // one of them makes sixteen compares, and every other thirty-two before its wasm call.
    assert.equal(worth(Array.from({ length: 64 }, ()=>4)), 0);
    // Five hundred, as a hundred and twenty-eight samples show them: most once, a few
    // twice or three times by chance.
    assert.equal(worth([3, 3, 2, 2, 2, 2, 2, 2, ...Array.from({ length: 110 }, ()=>1)]), 0);
});

test('callees a little above the rest by chance are not formed in for an eighth of the'
    + ' calls between them', ()=>{
    // Sixty-four evenly at four samples each, three of them seen ten times.
    assert.equal(worth([10, 10, 10, ...Array.from({ length: 61 }, ()=>4)]), 0);
});

test('one callee that takes a share of a call spread over many others is formed in alone',
    ()=>{
        assert.deepEqual(calleesWorth(sampled([60, ...Array.from({ length: 196 }, ()=>1)]), 256,
            32), [0x1000]);
    });

test('no more callees than a call may have formed in, and none seen once unless nothing is'
    + ' doubted', ()=>{
    assert.equal(worth(Array.from({ length: 12 }, ()=>16), 8), 8);
    assert.equal(worth([1]), 0);
    assert.equal(worth([1], 32, 0), 1, 'a test that looks after one sample');
});
