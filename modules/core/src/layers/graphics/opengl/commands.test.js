/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A call the command ring carries is made on the context exactly as its
 * entry point would make it: for every call in the table, the same arguments
 * through the export's handler and through a record give the same calls on
 * the context, with the same values -- and the record takes the words the
 * export pops.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpengl } from './exports.js';
import { GL_COMMANDS } from './commands.js';
import { GL } from './constants.js';

const DATA = 0x2000;

/** @param {unknown} value */
const plain = value=>(ArrayBuffer.isView(value)
    ? [...(/** @type {any} */ (value))]
    : Array.isArray(value) ? [...value] : value);

/** A library whose context logs every gl* call made on it. */
function logged(){
    const bytes = new Uint8Array(0x40000);
    let next = 0x8000;
    /** @type {any[][]} */
    const log = [];
    /** @type {any} */
    let context = null;
    const opengl = createOpengl({
        readMemory: (at, length)=>bytes.subarray(at, at + length),
        writeMemory: (at, value)=>bytes.set(value, at),
        screen: ()=>({ width: 4, height: 4 }),
        scratch: { allocate: size=>{
            const at = next;
            next += size + 16 & ~15;
            return at;
        } },
        remote: (factory, services)=>{
            const root = factory(services);
            const create = root.CreateContext.bind(root);
            root.CreateContext = (/** @type {any} */ options)=>{
                const made = create(options);
                context = new Proxy(made, {
                    get(target, key){
                        const value = /** @type {any} */ (target)[key];
                        if (typeof value !== 'function' || typeof key !== 'string'
                            || !key.startsWith('gl'))
                        {
                            return value;
                        }
                        return (/** @type {any[]} */ ...args)=>{
                            log.push([key, ...args.map(plain)]);
                            return value.apply(target, args);
                        };
                    },
                });
                return context;
            };
            return root;
        },
    });
    const table = /** @type {Record<string, { argBytes: number, handler: Function }>} */ (
        opengl.table);
    const hdc = 0x900d;
    assert.equal(table.wglSetPixelFormat.handler([hdc, 1, 0]), 1);
    assert.equal(table.wglMakeCurrent.handler([hdc, table.wglCreateContext.handler([hdc])]), 1);
    return { bytes, log, table, context: ()=>context };
}

/** Words that decode as ordinary values whatever they are taken for. @param {number} i */
const WORDS = [GL.TEXTURE_2D, 0xfffffffd, 0x3f800000, 1, 0x40000000, GL.LESS, 0xbf000000, 7];
/** @param {number} i */
const word = i=>WORDS[i % WORDS.length];

test('every call the ring carries is made as its entry point makes it', ()=>{
    const { bytes, log, table, context } = logged();
    const floats = new Float32Array(16).map((unused, i)=>i * 0.5 + 0.25);
    bytes.set(new Uint8Array(floats.buffer), DATA);
    for (const [name, entry] of Object.entries(GL_COMMANDS.COMMANDS))
    {
        assert.ok(table[name], `${name} is an export`);
        assert.equal(table[name].argBytes, entry.args * 4, `${name} pops what its record holds`);
        // A parameter vector is tried with a parameter of each size it takes,
        // and data counted in bytes with a count that is not whole dwords --
        // and, where the pointer may be null, with none.
        const { choose, count } = entry;
        const choices = choose
            ? [...choose.cases.map(([value])=>value), GL.OBJECT_PLANE]
            : entry.nullable ? [DATA, 0] : [undefined];
        for (const choice of choices)
        {
            const args = Array.from({ length: entry.args }, (unused, i)=>(i === entry.pointer
                ? (entry.nullable ? /** @type {number} */ (choice) : DATA)
                : choose && i === choose.arg ? /** @type {number} */ (choice)
                    : count && i === count.arg ? 10 : word(i)));
            const copied = choose
                ? choose.cases.find(([value])=>value === choice)?.[1] ?? choose.otherwise
                : count ? (args[entry.pointer ?? 0] === 0 ? 0 : args[count.arg] << count.shift)
                    : entry.bytes ?? 0;
            log.length = 0;
            table[name].handler(args);
            // The entry point hands the context the program's address, the
            // record its bytes: the same bytes.
            const direct = log.splice(0).map(made=>(count
                ? made.map(arg=>(arg === DATA ? [...bytes.subarray(DATA, DATA + copied)] : arg))
                : made));

            const record = new Uint32Array(2 + entry.args + Math.ceil(copied / 4));
            record.set([GL_COMMANDS.commandSlot(name), record.byteLength, ...args]);
            new Uint8Array(record.buffer).set(bytes.subarray(DATA, DATA + copied),
                (2 + entry.args) * 4);
            assert.equal(GL_COMMANDS.runCommands(context(), new Uint8Array(record.buffer), [],
                ()=>{}), 1);
            assert.deepEqual(log.splice(0), direct, `${name}${choice ? ` (${choice})` : ''}`);
            assert.ok(direct.length > 0, `${name} reached the context`);
        }
    }
});
