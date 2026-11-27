/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * D3DX's thread pump as Wine's d3dx10 test puts it: loads on one IO thread in
 * turn, decompress and process on a processing thread of their own, the
 * device stage on the caller's, the queues counted as they stand, a failed
 * load finished at once, and a purge that lets running work end its stage.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThreadPumps, IID_ID3DX_THREAD_PUMP } from './pump.js';

const E_NOTIMPL = 0x80004001 | 0;
const E_FAIL = 0x80004005 | 0;

/** A gate a guest routine waits at until the test opens it. */
function gate(){
    /** @type {(value?: any) => void} */
    let open = ()=>{};
    const shut = new Promise(resolve=>{
        open = resolve;
    });
    return { shut, open };
}

/** Lets every queued job and promise run. */
const settle = async()=>{
    for (let round = 0; round < 20; round++)
    {
        await new Promise(resolve=>setImmediate(resolve));
    }
};

function setup(){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    let top = 0x1000;
    /** @type {Map<number, (thread: any, args: number[]) => any>} */
    const routines = new Map();
    let nextRoutine = 0x100;
    const main = { name: 'main' };
    /** @type {Map<number, any>} */
    const published = new Map();
    /** @type {string[]} */
    const threadsMade = [];
    const pumps = createThreadPumps({
        readMemory: (at, length)=>bytes.slice(at, at + length),
        writeMemory: (at, data)=>bytes.set(data, at),
        heap: { allocate: size=>{
            const at = top;
            top += (size + 15) & ~15;
            return at;
        }, free: ()=>{} },
        vtables: { publish: object=>{
            const at = top;
            top += 16;
            published.set(at, object);
            return at;
        } },
        callGuest: async({ entry, args, thread })=>{
            const routine = routines.get(entry);
            assert.ok(routine, `a routine at ${entry}`);
            return await routine(thread, args.slice(1));
        },
        currentThread: ()=>main,
        serviceThread: name=>{
            const thread = { name: `${name} ${threadsMade.length}` };
            threadsMade.push(thread.name);
            let tail = Promise.resolve();
            return { run: job=>{
                tail = tail.then(()=>job(thread));
            } };
        },
    }, 'D3DX10');
    /**
     * An object of routines in guest memory, as a loader or processor is:
     * its table, then the table's entries.
     *
     * @param {((thread: any, args: number[]) => any)[]} methods
     */
    const object = methods=>{
        const table = top;
        top += methods.length * 4;
        methods.forEach((routine, slot)=>{
            routines.set(nextRoutine, routine);
            view.setUint32(table + slot * 4, nextRoutine++, true);
        });
        const at = top;
        top += 16;
        view.setUint32(at, table, true);
        return at;
    };
    /** @param {number} pointer @param {string} name @param {number[]} args */
    const call = (pointer, name, args)=>{
        const methods = published.get(pointer).interfaceFor(IID_ID3DX_THREAD_PUMP).methods;
        return methods.find((/** @type {any} */ one)=>one.name === name)
            .invoke(published.get(pointer), args);
    };
    const out = top;
    top += 64;
    return { pumps, object, call, view, out, main, threadsMade, published };
}

/**
 * A loader and processor pair that records the threads it ran on and waits
 * at its gates.
 *
 * @param {ReturnType<typeof setup>} env @param {number} loadAnswer
 */
function work(env, loadAnswer){
    const loaded = gate();
    const decompressed = gate();
    /** @type {Record<string, any>} */
    const seen = { destroyed: 0 };
    const loader = env.object([
        async thread=>{
            seen.load = thread;
            await loaded.shut;
            return loadAnswer;
        },
        async(thread, [data, size])=>{
            seen.decompress = thread;
            env.view.setUint32(data, 0xdeadbeef, true);
            env.view.setUint32(size, 0xdead, true);
            await decompressed.shut;
            return 0;
        },
        ()=>{
            seen.destroyed++;
            return 0;
        },
    ]);
    const processor = env.object([
        (thread, [data, size])=>{
            seen.process = thread;
            seen.data = [data >>> 0, size >>> 0];
            return 0;
        },
        (thread, [into])=>{
            seen.create = thread;
            env.view.setUint32(into, 0xdeadf00d, true);
            return 0;
        },
        ()=>{
            seen.destroyed++;
            return 0;
        },
    ]);
    return { loader, processor, seen, loaded, decompressed };
}

test('a pump does each stage on its kind of thread and counts its queues', async()=>{
    const env = setup();
    const create = env.pumps.D3DX10CreateThreadPump;
    assert.equal(create.handler([1024, 0, env.out]), E_FAIL);
    assert.equal(create.handler([0, 1024, env.out]), E_FAIL);
    assert.equal(create.handler([0, 0, env.out]), 0);
    const pump = env.view.getUint32(env.out, true);
    const status = ()=>{
        env.call(pump, 'GetQueueStatus', [env.out + 8, env.out + 12, env.out + 16]);
        return [8, 12, 16].map(at=>env.view.getUint32(env.out + at, true));
    };
    assert.equal(env.call(pump, 'GetWorkItemCount', []), 0);
    assert.deepEqual(status(), [0, 0, 0]);

    const first = work(env, E_NOTIMPL);
    const second = work(env, 0);
    const result = env.out + 20;
    env.view.setUint32(result, 0x12345678, true);
    assert.equal(env.call(pump, 'AddWorkItem', [first.loader, first.processor, result, 0]), 0);
    await settle();
    assert.ok(first.seen.load && first.seen.load !== env.main, 'loaded off the caller');
    assert.equal(env.call(pump, 'GetWorkItemCount', []), 1);
    assert.deepEqual(status(), [0, 0, 0], 'a load running is in no queue');

    const object = env.out + 24;
    assert.equal(env.call(pump, 'AddWorkItem', [second.loader, second.processor, 0, object]),
        0);
    await settle();
    assert.equal(second.seen.load, undefined, 'one IO thread: the second load waits');
    assert.equal(env.call(pump, 'GetWorkItemCount', []), 2);
    assert.deepEqual(status(), [1, 0, 0]);

    first.loaded.open();
    await settle();
    assert.equal(env.view.getInt32(result, true), E_NOTIMPL, 'a failed load ends its work');
    assert.equal(first.seen.destroyed, 2);
    assert.equal(second.seen.load, first.seen.load, 'the same IO thread');

    second.loaded.open();
    second.decompressed.open();
    const waited = env.call(pump, 'WaitForAllItems', []);
    assert.equal(await waited, 0);
    assert.notEqual(second.seen.decompress, second.seen.load, 'decompressed off the IO thread');
    assert.equal(second.seen.process, second.seen.decompress, 'processed where decompressed');
    assert.deepEqual(second.seen.data, [0xdeadbeef, 0xdead]);
    assert.equal(second.seen.create, env.main, 'the device stage is the caller\'s');
    assert.equal(env.view.getUint32(object, true), 0xdeadf00d);
    assert.equal(second.seen.destroyed, 2);
    assert.equal(env.call(pump, 'GetWorkItemCount', []), 0);
});

test('one decompress waiting holds up no other work; the device stage waits for its call',
    async()=>{
        const env = setup();
        env.pumps.D3DX10CreateThreadPump.handler([0, 0, env.out]);
        const pump = env.view.getUint32(env.out, true);
        const status = ()=>{
            env.call(pump, 'GetQueueStatus', [env.out + 8, env.out + 12, env.out + 16]);
            return [8, 12, 16].map(at=>env.view.getUint32(env.out + at, true));
        };
        const stuck = work(env, 0);
        const free = work(env, 0);
        stuck.loaded.open();
        free.loaded.open();
        free.decompressed.open();
        env.call(pump, 'AddWorkItem', [stuck.loader, stuck.processor, 0, env.out + 24]);
        env.call(pump, 'AddWorkItem', [free.loader, free.processor, 0, env.out + 28]);
        await settle();
        assert.deepEqual(status(), [0, 0, 1]);
        assert.equal(await env.call(pump, 'ProcessDeviceWorkItems', [0]), 0);
        assert.deepEqual(status(), [0, 0, 1], 'none asked for, none made');
        assert.equal(await env.call(pump, 'ProcessDeviceWorkItems', [1]), 0);
        assert.deepEqual(status(), [0, 0, 0]);
        assert.equal(free.seen.destroyed, 2);

        // A purge lets the decompress that runs end, then destroys its work
        // without making its object.
        const purged = env.call(pump, 'PurgeAllItems', []);
        stuck.decompressed.open();
        assert.equal(await purged, 0);
        assert.equal(stuck.seen.destroyed, 2);
        assert.equal(stuck.seen.create, undefined);
        assert.equal(env.call(pump, 'GetWorkItemCount', []), 0);
    });
