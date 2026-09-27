/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment } from './environ.js';
import { fakeMemory } from './harness.test.js';

/**
 * The environment over a fake memory, started with two variables, its
 * exports placed at addresses of their own.
 *
 * @param {{ exports?: boolean }} [options]
 */
const build = ({ exports = true } = {})=>{
    const memory = fakeMemory();
    /** @type {number[]} */
    const errno = [];
    /** @type {[string, string | null][]} */
    const told = [];
    /** @type {Map<string, number>} */
    const cells = new Map();
    const placed = new Map(['_environ', '_wenviron', '__initenv', '__winitenv']
        .map(name=>[name, memory.allocate(4)]));
    const environment = createEnvironment({
        ...memory,
        errno: code=>void errno.push(code),
        environment: ()=>({ Path: 'C:\\WINDOWS', APPDATA: 'C:\\Users\\a' }),
        setVariable: (name, value)=>void told.push([name, value]),
        ...exports ? { addressOf: name=>placed.get(name) ?? 0 } : {},
        cell: name=>{
            if (!cells.has(name))
            {
                cells.set(name, memory.allocate(4));
            }
            return /** @type {number} */ (cells.get(name));
        },
    });
    const table = /** @type {Record<string, any>} */ (environment.functions);
    const view = new DataView(memory.bytes.buffer);
    /** @param {number} address */
    const u32 = address=>view.getUint32(address, true);
    /** The strings an array points at. @param {number} list @param {boolean} [wide] */
    const strings = (list, wide = false)=>{
        const out = [];
        for (let at = list; u32(at) !== 0; at += 4)
        {
            out.push(wide ? memory.wide(u32(at)) : memory.text(u32(at)));
        }
        return out;
    };
    /** @param {string} name @param {number[]} args */
    const call = (name, ...args)=>table[name].handler(args);
    return { memory, environment, table, errno, told, placed, u32, strings, call };
};

test('getenv reads the copy taken at start, without regard to case, into its own string', ()=>{
    const { memory, environment, u32, strings, call } = build();
    const list = environment.narrow();
    assert.deepEqual(strings(list), ['Path=C:\\WINDOWS', 'APPDATA=C:\\Users\\a']);
    const value = call('getenv', memory.put('appdata'));
    assert.equal(memory.text(value), 'C:\\Users\\a');
    assert.equal(value, u32(list + 4) + 'APPDATA='.length, 'a pointer into _environ\'s string');
    assert.equal(call('getenv', memory.put('missing')), 0);
    assert.equal(call('getenv', 0), 0);
});

test('_putenv sets, changes in place and removes, and tells the process\'s block', ()=>{
    const { memory, environment, errno, told, placed, u32, strings, call } = build();
    const initial = environment.narrow();
    assert.equal(call('_putenv', memory.put('cat=dog')), 0);
    assert.notEqual(environment.narrow(), initial, 'the first change makes a new array');
    assert.equal(u32(/** @type {number} */ (placed.get('__initenv'))), initial,
        '__initenv keeps the one it started with');
    assert.equal(u32(/** @type {number} */ (placed.get('_environ'))), environment.narrow());
    assert.deepEqual(strings(initial), ['Path=C:\\WINDOWS', 'APPDATA=C:\\Users\\a']);
    assert.equal(call('_putenv', memory.put('dog=bark')), 0);
    const cat = u32(environment.narrow() + 8);
    assert.equal(call('_putenv', memory.put('PATH=D:\\')), 0);
    assert.deepEqual(strings(environment.narrow()),
        ['PATH=D:\\', 'APPDATA=C:\\Users\\a', 'cat=dog', 'dog=bark']);
    assert.equal(u32(environment.narrow() + 8), cat, 'an unchanged variable keeps its string');
    assert.equal(call('_putenv', memory.put('cat=')), 0);
    assert.equal(call('_putenv', memory.put('nothing=')), 0, 'removing what is not set');
    assert.deepEqual(strings(environment.narrow()), ['PATH=D:\\', 'APPDATA=C:\\Users\\a',
        'dog=bark']);
    assert.deepEqual(told, [['cat', 'dog'], ['dog', 'bark'], ['PATH', 'D:\\'], ['cat', null],
        ['nothing', null]]);
    assert.equal(call('_putenv', memory.put('=')), -1);
    assert.equal(call('_putenv', memory.put('=dog')), -1);
    assert.equal(call('_putenv', memory.put('noequals')), -1);
    assert.deepEqual(errno, [22, 22, 22]);
});

test('the wide copy is made from the narrow one as it stands, when a wide call asks', ()=>{
    const { memory, environment, placed, u32, strings, call } = build();
    call('_putenv', memory.put('cat=dog'));
    assert.equal(u32(/** @type {number} */ (placed.get('_wenviron'))), 0);
    assert.equal(call('_wputenv', memory.putWide('cat=dog2')), 0);
    const winitenv = u32(/** @type {number} */ (placed.get('__winitenv')));
    assert.ok(strings(winitenv, true).includes('cat=dog'), '__winitenv before the change');
    assert.ok(strings(environment.wide(), true).includes('cat=dog2'));
    assert.equal(memory.text(call('getenv', memory.put('cat'))), 'dog2', 'both copies change');
    call('_wputenv', memory.putWide('__cat=\u263a'));
    assert.equal(memory.wide(call('_wgetenv', memory.putWide('__CAT'))), '\u263a');
    assert.equal(memory.text(call('getenv', memory.put('__cat'))), '?',
        'the narrow copy in the ANSI page');
    call('_wputenv', memory.putWide('__\u263a=bark'));
    assert.equal(memory.text(call('getenv', memory.put('__?'))), 'bark',
        'a narrow name is the narrow copy\'s');
    call('_wputenv', memory.putWide('__\u263a='));
    assert.equal(call('_wgetenv', memory.putWide('__\u263a')), 0);
});

test('getenv_s and _putenv_s answer and refuse as the secure calls do', ()=>{
    const { memory, errno, u32, call } = build();
    const length = memory.allocate(4);
    const buffer = memory.allocate(16);
    assert.equal(call('_putenv_s', memory.put('cat'), memory.put('a=b')), 0);
    assert.equal(call('getenv_s', length, buffer, 16, memory.put('cat')), 0);
    assert.deepEqual([u32(length), memory.text(buffer)], [4, 'a=b']);
    assert.equal(call('getenv_s', length, buffer, 2, memory.put('cat')), 34, 'ERANGE');
    memory.bytes[buffer] = 0x78;
    assert.equal(call('getenv_s', length, buffer, 16, memory.put('missing')), 0);
    assert.deepEqual([u32(length), memory.bytes[buffer]], [0, 0]);
    assert.equal(call('getenv_s', length, buffer, 16, 0), 0, 'no name is none set');
    assert.equal(call('_putenv_s', 0, memory.put('dog')), 22);
    assert.equal(call('_putenv_s', memory.put('cat'), 0), 22);
    assert.equal(call('_putenv_s', memory.put('a=b'), memory.put('x')), 22);
    assert.equal(call('_putenv_s', memory.put('cat'), memory.put('')), 0, 'an empty value removes');
    assert.equal(call('getenv', memory.put('cat')), 0);
    assert.deepEqual(errno, [34, 22, 22, 22]);
});

test('the accessors hand out the exports\' own addresses, or cells holding the same', ()=>{
    const { memory, environment, placed, u32, call } = build();
    assert.equal(call('__p__environ'), placed.get('_environ'));
    const out = memory.allocate(4);
    call('_get_environ', out);
    assert.equal(u32(out), environment.narrow());
    call('_get_wenviron', out);
    assert.equal(u32(out), 0, 'no wide copy yet');
    const bare = build({ exports: false });
    const cell = bare.call('__p__environ');
    bare.call('_putenv', bare.memory.put('x=1'));
    assert.equal(bare.u32(cell), bare.environment.narrow(), 'the cell follows the array');
    assert.equal(bare.environment.value('X'), '1');
});
