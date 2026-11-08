/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MONO_DIRECTORY, createMscoreeFunctions } from './functions.js';

/**
 * A host whose Mono exports are numbered by name, whose guest calls are
 * recorded with their string arguments read back, and whose heap is a bump.
 *
 * @param {{ runtime?: boolean, missing?: string, domain?: number, assembly?: number,
 *     debug?: string }} [shape]
 */
function machine(shape = {}){
    const memory = new Uint8Array(0x10000);
    let next = 0x100;
    /** @type {Record<string, number>} */
    const exports = Object.fromEntries(['mono_set_dirs', 'mono_config_parse',
        'mono_jit_init_version', 'mono_domain_assembly_open', 'mono_jit_exec', 'mono_thread_attach',
        'mono_get_corlib', 'mono_class_from_name', 'mono_class_get_method_from_name',
        'mono_runtime_invoke', 'mono_object_unbox', 'mono_string_new', 'mono_object_new',
        'mono_runtime_object_init', 'mono_assembly_get_image', 'mono_gchandle_new',
        'mono_gchandle_free', 'mono_domain_get_by_id', 'mono_domain_set',
        'mono_object_get_virtual_method'].map((name, i)=>[name, i + 1]));
    const names = Object.fromEntries(Object.entries(exports).map(([name, at])=>[at, name]));
    /** @type {any[]} */
    const calls = [];
    /** @type {number[]} */
    const exits = [];
    /** @type {string[]} */
    const said = [];
    /** @type {Map<string, string>} */
    const environment = new Map(shape.debug ? [['MONO_DEBUG', shape.debug]] : []);
    /** @param {number} at */
    const text = at=>new TextDecoder().decode(memory.subarray(at, memory.indexOf(0, at)));
    /** @param {number} at */
    const word = at=>new DataView(memory.buffer).getUint32(at, true);
    /** @type {import('./functions.js').MscoreeHost} */
    const host = {
        exists: path=>shape.runtime !== false && path.startsWith(MONO_DIRECTORY),
        loadLibrary: async path=>(path.endsWith('libmono-2.0-x86.dll') ? 0x7000 : 0),
        procAddress: async(module, name)=>(module === 0x7000 && name !== shape.missing
            ? exports[name] ?? 0 : 0),
        callGuest: async({ entry, args, thread })=>{
            const name = names[entry];
            calls.push({ name, thread,
                args: name === 'mono_set_dirs' ? args.map(text)
                    : name === 'mono_jit_init_version' ? args.map(text)
                        : name === 'mono_domain_assembly_open' ? [args[0], text(args[1])]
                            : name === 'mono_jit_exec' ? [args[0], args[1], args[2],
                                Array.from({ length: args[2] + 1 },
                                    (_, i)=>(word(args[3] + i * 4) ? text(word(args[3] + i * 4))
                                        : null))]
                                : args });
            return name === 'mono_jit_init_version' ? shape.domain ?? 0xd0
                : name === 'mono_domain_assembly_open' ? shape.assembly ?? 0xa0
                    : name === 'mono_jit_exec' ? 42 : 0;
        },
        currentThread: ()=>'main',
        heap: { allocate: bytes=>{
            const at = next;
            next += (bytes + 7) & ~7;
            return at;
        }, free: ()=>{} },
        writeMemory: (at, bytes)=>memory.set(bytes, at),
        imagePath: ()=>'C:\\Games\\Swap.exe',
        arguments: ()=>['Swap.exe', '-windowed', 'ä'],
        exitProcess: code=>exits.push(code),
        getEnvironment: async name=>environment.get(name) ?? null,
        setEnvironment: async(name, value)=>{
            calls.push({ name: 'setEnvironment', args: [name, value] });
            environment.set(name, value);
        },
        divergence: (api, detail, kind)=>said.push(`${api} ${kind ?? ''}: ${detail}`),
    };
    return { host, calls, exits, said, environment };
}

test('_CorExeMain runs the process\'s assembly under the bottle\'s Mono, ends with Main\'s code',
    async()=>{
        const { host, calls, exits, said } = machine();
        const fns = createMscoreeFunctions(host);
        assert.equal(fns._CorExeMain.argBytes, 0);
        assert.equal(await fns._CorExeMain.handler(), 42);
        assert.deepEqual(calls.shift(), { name: 'setEnvironment',
            args: ['MONO_DEBUG', 'explicit-null-checks'] }, 'before Mono reads it');
        assert.deepEqual(calls.map(call=>call.name), ['mono_set_dirs', 'mono_config_parse',
            'mono_jit_init_version', 'mono_thread_attach', 'mono_domain_assembly_open',
            'mono_jit_exec']);
        assert.ok(calls.every(call=>call.thread === 'main'), 'on the thread that called it');
        assert.deepEqual(calls[0].args, [`${MONO_DIRECTORY}\\lib`, `${MONO_DIRECTORY}\\etc`]);
        assert.deepEqual(calls[1].args, [0], 'the runtime\'s own configuration');
        assert.deepEqual(calls[2].args, ['C:\\Games\\Swap.exe', 'v4.0.30319']);
        assert.deepEqual(calls[3].args, [0xd0], 'the thread attached to the root domain');
        assert.deepEqual(calls[4].args, [0xd0, 'C:\\Games\\Swap.exe']);
        assert.deepEqual(calls[5].args, [0xd0, 0xa0, 3,
            ['C:\\Games\\Swap.exe', '-windowed', 'ä', null]],
        'the executable\'s own path first, then the arguments, in UTF-8, null-ended');
        assert.deepEqual(exits, [42]);
        assert.deepEqual(said, []);
    });

test('without the runtime, or with a runtime that will not start, the program does not run'
    + ' and that is said as a loss', async()=>{
    for (const [shape, reason] of /** @type {const} */ ([
        [{ runtime: false }, /no \.NET runtime in this bottle/],
        [{ missing: 'mono_jit_exec' }, /exports no mono_jit_exec/],
        [{ domain: 0 }, /made no domain/],
        [{ assembly: 0 }, /did not open C:\\Games\\Swap\.exe/],
    ]))
    {
        const { host, exits, said } = machine(shape);
        const code = await createMscoreeFunctions(host)._CorExeMain.handler();
        assert.equal(code, 0xc0000135, JSON.stringify(shape));
        assert.deepEqual(exits, [0xc0000135]);
        assert.equal(said.length, 1);
        assert.match(said[0], /^_CorExeMain loss: /);
        assert.match(said[0], reason);
    }
});

test('MONO_DEBUG keeps what it held, the null checks added once', async()=>{
    for (const [debug, after] of [['casts', 'casts,explicit-null-checks'],
        ['explicit-null-checks,casts', 'explicit-null-checks,casts']])
    {
        const { host, environment } = machine({ debug });
        await createMscoreeFunctions(host)._CorExeMain.handler();
        assert.equal(environment.get('MONO_DEBUG'), after);
    }
});

test('_CorDllMain lets every managed library the runtime maps load', ()=>{
    const fns = createMscoreeFunctions(machine().host);
    assert.equal(fns._CorDllMain.argBytes, 12);
    assert.equal(fns._CorDllMain.handler(), 1, 'TRUE for attach and detach alike');
});
