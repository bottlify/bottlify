/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * C++ exceptions in a 64-bit process, through `createApp`
 * (`test/fixtures/src/cxxeh64.cpp` says which properties): the same program
 * with the tables `__CxxFrameHandler3` reads and with the compressed ones
 * `__CxxFrameHandler4` reads, its frames found through the images' unwind
 * tables, some of them through a language handler of the program's own.
 *
 * Each also with its relocations stripped at 0x140000000 over a wide window:
 * the throw information, the catch funclets, the continuation a catch block
 * answers in RAX and every frame's address then lie past 4 GiB.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { allowMemory64 } from '../../cork/src/testing/memory64.js';
import { createApp } from './app.js';
import { fixedPastFourGiB } from './fixed-base.fixture.js';

/** Every property the fixture checks, in the order it prints them. */
const PROPERTIES = [
    'catch (int)',
    'every local is destroyed before the catch block runs',
    'catch by reference',
    'the thrown object is destroyed after the catch block',
    'catch by value copies once',
    'catch (...) takes what nothing before it did',
    'a derived object is caught as its second base',
    'throw; reaches the enclosing catch',
    'and the object is destroyed once',
    'throw; from a callee\'s catch block reaches its caller',
    'with every object destroyed once',
    'a try inside a catch block',
    'a throw out of a catch block reaches the try around it',
    'past the catch block\'s own object',
    'a throw out of a callback the system made',
    'two hundred throws in a row',
    'a catch (...) lets a structured exception pass',
    'frames whose handler is guest code catch and destroy',
    'and their handler was called',
    'two threads throwing at once, each catching its own',
];

/**
 * @param {import('node:test').TestContext} t @param {string} name
 * @param {boolean} wide  the image at its own base past 4 GiB
 */
async function run(t, name, wide){
    const bytes = new Uint8Array(await readFile(
        new URL(`../test/fixtures/${name}.exe`, import.meta.url)));
    if (wide)
    {
        allowMemory64();
    }
    const app = await createApp({ executable: wide ? fixedPastFourGiB(bytes) : bytes,
        commandLine: `"C:\\${name}.exe"`, ...wide ? { memorySize: 8 * 2 ** 30 } : {} });
    t.after(()=>app.dispose());
    /** @type {string[]} */
    const output = [];
    app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>output.push(text));
    /** @type {number | null} */
    let code = null;
    /** @type {string | null} */
    let stopped = null;
    try
    {
        code = await app.run({ timeoutMs: 100000 });
    }
    catch (e){
        stopped = /** @type {Error} */ (e).message;
    }
    const bridge = app.diagnostics().find((/** @type {any} */ entry)=>entry.name === 'bridge');
    return { code, stopped, text: output.join(''), suspended: bridge?.metrics?.suspended };
}

for (const [name, handler, wide] of /** @type {[string, string, boolean][]} */ ([
    ['cxxeh64', '__CxxFrameHandler3', false], ['cxxeh64fh4', '__CxxFrameHandler4', false],
    ['cxxeh64', '__CxxFrameHandler3', true], ['cxxeh64fh4', '__CxxFrameHandler4', true]]))
{
    test(`64-bit C++ exceptions through ${handler}'s tables${wide ? ', the image past 4 GiB' : ''}`,
        { timeout: 120000 }, async t=>{
            const { code, stopped, text, suspended } = await run(t, name, wide);
            const lines = text.split('\r\n').filter(Boolean);
            assert.deepEqual(lines.filter(line=>!line.startsWith('ok   ')), [], text);
            assert.equal(stopped, null);
            assert.deepEqual(lines.map(line=>line.slice(5)), PROPERTIES, 'every one was reached');
            assert.equal(code, 0, text);
            assert.equal(suspended, 0,
                'no host call is left waiting: each catch let go of the stack below it');
        });
}
