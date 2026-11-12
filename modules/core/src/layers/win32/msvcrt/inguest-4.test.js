/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Part 4 of msvcrt's guest code against its x86 (and its x86-64 against its
 * JavaScript); see `inguest.test.js`: memchr, strncat and the wide searches,
 * spans, comparisons and joins.
 */

import { test } from 'node:test';
import { COMPILED } from './inguest.x86.js';
import * as sources from './inguest.js';
import { DATA, equivalence, random } from '../../../../scripts/guest-code/equivalence.mjs';

const { same } = equivalence(COMPILED, sources);

/** Bytes of a text from a few letters, so spans and searches find each other. */
const letters = (/** @type {() => number} */ next)=>(/** @type {number} */ length)=>
    Array.from({ length }, ()=>[0x61, 0x62, 0x63, 0x41, 0xe9, 0x20][next() % 6]);

/** Units of a text, past a byte and past 0x7fff among them. */
const wideUnits = (/** @type {() => number} */ next)=>(/** @type {number} */ length)=>
    Array.from({ length }, ()=>[0x61, 0x62, 0x100, 0x3000, 0x8000, 0xffff][next() % 6]);

/** A wide text's bytes and its terminator. @param {number[]} list */
const wide = list=>[...list, 0].flatMap(u=>[u & 0xff, u >>> 8]);

test('memchr: found first, at the edges, past the count and not; any value\'s low byte', ()=>{
    const next = random(41);
    const text = letters(next);
    for (let i = 0; i < 200; i++)
    {
        const bytes = text(next() % 24);
        const value = [0x61, 0xe9, 0x20, 0x161, 0xffffff62, 0][next() % 6];
        same('memchr', { stack: [DATA, value, next() % (bytes.length + 2)],
            memory: [[DATA, [...bytes, 0]]] });
    }
});

test('strncat: cut at the count, short of it, a count of 0, and over itself either way', ()=>{
    const next = random(42);
    const text = letters(next);
    for (let i = 0; i < 70; i++)
    {
        const at = DATA + 0x10;
        const a = [...text(next() % 20), 0];
        const b = [...text(next() % 20), 0];
        const memory = /** @type {[number, number[]][]} */ ([[at, a], [at + 0x40, b]]);
        for (const count of [0, 1, b.length - 1, b.length + 3, 0xffffffff])
        {
            same('strncat', { stack: [at, at + 0x40, count], memory });
            same('strncat', { stack: [at + 0x40, at + 2, count], memory });
        }
    }
});

test('wcschr, wcsrchr, wcsstr, wcsspn, wcscspn and wcspbrk over units of every width', ()=>{
    const next = random(43);
    const units = wideUnits(next);
    for (let i = 0; i < 200; i++)
    {
        const text = units(next() % 20);
        const from = next() % (text.length + 1);
        const needle = next() % 3 === 0 ? units(next() % 4) : text.slice(from, from + next() % 5);
        const set = units(next() % 4);
        const memory = /** @type {[number, number[]][]} */ ([[DATA, wide(text)],
            [DATA + 0x100, wide(needle)], [DATA + 0x200, wide(set)]]);
        const c = [0x61, 0x3000, 0xffff, 0, 0x10061][next() % 5];
        same('wcschr', { stack: [DATA, c], memory });
        same('wcsrchr', { stack: [DATA, c], memory });
        same('wcsstr', { stack: [DATA, DATA + 0x100], memory });
        same('wcsspn', { stack: [DATA, DATA + 0x200], memory });
        same('wcscspn', { stack: [DATA, DATA + 0x200], memory });
        same('wcspbrk', { stack: [DATA, DATA + 0x200], memory });
    }
});

test('wcsncmp, wcscat and wcsncat: counts short, equal and past, joins over themselves', ()=>{
    const next = random(44);
    const units = wideUnits(next);
    for (let i = 0; i < 100; i++)
    {
        const a = units(next() % 12);
        const b = next() % 3 === 0 ? [...a] : units(next() % 12);
        if (b.length > 0 && next() % 2 === 0)
        {
            b[next() % b.length] = units(1)[0];
        }
        const at = DATA + 0x10;
        const memory = /** @type {[number, number[]][]} */ ([[at, wide(a)], [at + 0x80, wide(b)]]);
        for (const count of [0, 1, a.length, a.length + 2, 0xffffffff])
        {
            same('wcsncmp', { stack: [at, at + 0x80, count], memory });
            same('wcsncat', { stack: [at, at + 0x80, count], memory });
            same('wcsncat', { stack: [at + 0x80, at + 2, count], memory });
        }
        same('wcscat', { stack: [at, at + 0x80], memory });
        same('wcscat', { stack: [at + 0x80, at + 4], memory });
    }
});
