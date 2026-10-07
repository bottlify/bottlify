/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishAsync, runCustomAction } from './custom.js';

const DLL_BINARY = 1;
const ASYNC = 0x80;
const CONTINUE = 0x40;

/**
 * An engine over a session that holds one Binary stream, with a host that
 * records what it was asked to do: a library action is started, or called, and
 * answers when the test lets it.
 *
 * @param {{ start?: (path: string, entry: string, args: number[]) => any }} [options]
 */
function engineWith(options = {}){
    /** @type {string[]} */
    const events = [];
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    const engine = /** @type {any} */ ({
        session: {
            db: { readStream: async()=>Uint8Array.of(1, 2, 3) },
            getProperty: ()=>'',
            mode: { scheduled: false },
            formatText: (/** @type {string} */ text)=>text,
        },
        ran: new Set(),
        commit: [],
        async: [],
        host: {
            files: {
                open: (/** @type {string} */ path)=>{
                    files.set(path, new Uint8Array());
                    return path;
                },
                /** @param {string} node @param {number} offset @param {Uint8Array} bytes */
                write: (node, offset, bytes)=>{
                    void offset;
                    files.set(node, bytes);
                },
                close: ()=>{},
                remove: (/** @type {string} */ path)=>{
                    files.delete(path);
                    events.push(`remove ${path}`);
                },
            },
            openHandle: ()=>{
                events.push('open handle');
                return 5;
            },
            closeHandle: (/** @type {number} */ handle)=>{
                events.push(`close handle ${handle}`);
            },
            /** @param {string} path @param {string} entry */
            callDll: async(path, entry)=>{
                void path;
                events.push(`call ${entry}`);
                return 0;
            },
            /** @param {string} path @param {string} entry @param {number[]} args */
            startDll: options.start ?? (async(path, entry, args)=>{
                void path;
                events.push(`start ${entry} ${args}`);
                return null;
            }),
            log: (/** @type {string} */ text)=>{
                events.push(`log ${text}`);
            },
        },
    });
    return { engine, events, files };
}

/**
 * An action that has been started and finishes when `finish` is called; its
 * library's freeing goes into `events`.
 *
 * @param {string[]} [events]
 */
function running(events = []){
    /** @type {(code: number | null) => void} */
    let finish = ()=>{};
    const done = new Promise(resolve=>{
        finish = resolve;
    });
    let stopped = 0;
    return {
        /** @param {number | null} code */
        finish: code=>finish(code),
        started: { done, stop: ()=>{
            stopped++;
            finish(null);
        }, free: async()=>{
            events.push('free library');
        } },
        stopped: ()=>stopped,
        events,
    };
}

const ROW = (/** @type {number} */ type)=>({ action: 'ISMsiServerStartup', type,
    source: 'ISScriptBridge.dll', target: 'MsiServerStartup' });

test('a library action that runs in parallel and is not waited for starts, and the sequence goes'
    + ' on while it runs', async()=>{
    const action = running();
    const { engine, events } = engineWith({ start: async()=>action.started });
    assert.equal(await runCustomAction(engine, ROW(DLL_BINARY | ASYNC | CONTINUE)), 0);
    assert.equal(engine.async.length, 1);
    assert.equal(engine.async[0].wait, false);
    assert.ok(!events.some(line=>line.startsWith('close handle')),
        'the session handle stays open while the action may use it');
    assert.ok(!events.some(line=>line.startsWith('remove')), 'and so does its library');

    // At the end of the installation it is told to stop, and what it held is given back.
    assert.equal(await finishAsync(engine), 0);
    assert.equal(action.stopped(), 1);
    assert.ok(events.includes('close handle 5'));
    assert.ok(events.some(line=>line.startsWith('remove')), 'its library is removed');
    assert.equal(engine.async.length, 0);
});

test('one that finished on its own is not stopped, and its answer is not the installation\'s'
    + ' when it is not waited for', async()=>{
    /** @type {string[]} */
    const freed = [];
    const action = running(freed);
    const { engine, events } = engineWith({ start: async()=>action.started });
    await runCustomAction(engine, ROW(DLL_BINARY | ASYNC | CONTINUE));
    action.finish(1603);
    await new Promise(resolve=>setImmediate(resolve));
    // Its thread is over, but its library and handle are the installation's
    // to give back, from the installation's own thread: a DllMain run when the
    // thread ended would run on whichever thread was on the processor then.
    assert.deepEqual(freed, [], 'the library is not freed when its thread ends');
    assert.ok(!events.includes('close handle 5'));
    assert.equal(await finishAsync(engine), 0);
    assert.equal(action.stopped(), 0);
    assert.deepEqual(freed, ['free library'], 'but at the end');
    assert.ok(events.includes('close handle 5'), 'and then what it was given');
});

test('a library action run in parallel that is waited for is waited for at the end, and its'
    + ' failure is the installation\'s', async()=>{
    const action = running();
    const { engine } = engineWith({ start: async()=>action.started });
    assert.equal(await runCustomAction(engine, ROW(DLL_BINARY | ASYNC)), 0);
    assert.equal(engine.async[0].wait, true);
    let over = false;
    const finishing = finishAsync(engine).then(code=>{
        over = true;
        return code;
    });
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(over, false, 'it is waited for');
    action.finish(1603);
    assert.equal(await finishing, 1603);
    assert.equal(action.stopped(), 0);

    const good = running();
    const other = engineWith({ start: async()=>good.started });
    await runCustomAction(other.engine, ROW(DLL_BINARY | ASYNC));
    good.finish(0);
    assert.equal(await finishAsync(other.engine), 0);
});

test('a library action that cannot be started fails as one that cannot be called does', async()=>{
    const { engine } = engineWith({ start: async()=>null });
    assert.equal(await runCustomAction(engine, ROW(DLL_BINARY | ASYNC)), 1603);
    assert.equal(engine.async.length, 0);
    const ignored = engineWith({ start: async()=>null });
    assert.equal(await runCustomAction(ignored.engine, ROW(DLL_BINARY | ASYNC | CONTINUE)), 0,
        'unless its answer is ignored');
});

test('a library action that is not run in parallel is called and waited for, as before', async()=>{
    const { engine, events } = engineWith();
    assert.equal(await runCustomAction(engine, ROW(DLL_BINARY)), 0);
    assert.ok(events.includes('call MsiServerStartup'));
    assert.equal(engine.async.length, 0);
    assert.equal(await finishAsync(engine), 0, 'nothing is left to wait for');
});
