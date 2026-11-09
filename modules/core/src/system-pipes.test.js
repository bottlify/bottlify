/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A child in a worker of its own with its parent's pipe ends as its standard
 * handles: the parent's reads are answered by the child's writes and the
 * child's by the parent's, a read on either side waits for the other's write,
 * and the pipe breaks when the child's handles go -- closed, or with it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNamedPipes, pipeStandIn } from './layers/win32/kernel32/pipes.js';
import { pipeHandlers } from './system-pipes.js';

const ERROR_BROKEN_PIPE = 109;
const ERROR_OPERATION_ABORTED = 995;
const BUFFER = 0x400;
const COUNT = 0x500;

/**
 * One process's pipes: its memory and handles, over the run's table or,
 * across a link, the parent's ends asked through `across`.
 *
 * @param {{ table?: Map<string, any>, id: number, across?: any }} options
 */
function processOf({ table, id, across }){
    const bytes = new Uint8Array(0x1000);
    const view = new DataView(bytes.buffer);
    /** @type {Map<number, { type: string, object: any }>} */
    const handles = new Map();
    let next = 0x100;
    /** @type {Map<any, number>} */
    const lastError = new Map();
    /** @type {{ thread: any, result: number }[]} */
    const woken = [];
    const pipes = createNamedPipes({
        kernel: {
            block(){},
            wake: (/** @type {any} */ thread, /** @type {number} */ result)=>{
                woken.push({ thread, result });
                return true;
            },
            clock: { virtualTime: ()=>0 },
        },
        handles: {
            open: (type, object)=>{
                next += 4;
                handles.set(next, { type, object });
                return next;
            },
            resolve: (handle, type)=>{
                const entry = handles.get(handle);
                if (!entry || (type && entry.type !== type))
                {
                    throw new Error('Invalid handle');
                }
                return entry.object;
            },
            typeOf: handle=>handles.get(handle)?.type ?? null,
        },
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        readCString: ()=>'',
        readWideString: ()=>'',
        setLastError: code=>lastError.set('main', code),
        setLastErrorFor: (thread, code)=>lastError.set(thread, code),
        currentThread: ()=>'main',
        park: ()=>'parked',
        table: table ?? null,
        remote: Boolean(across),
        across: across ?? null,
        processId: id,
    });
    return {
        pipes, handles, woken,
        error: ()=>lastError.get('main'),
        /** @param {number} handle @param {string} text */
        write(handle, text){
            bytes.set([...text].map(ch=>ch.charCodeAt(0)), BUFFER);
            return pipes.write(handle, BUFFER, text.length, COUNT);
        },
        /** @param {number} handle @param {number} length */
        read: (handle, length)=>pipes.read(handle, BUFFER, length, COUNT),
        /** @param {number} length */
        text: length=>String.fromCharCode(...bytes.subarray(BUFFER, BUFFER + length)),
        count: ()=>view.getUint32(COUNT, true),
        /** A handle adopted onto an object under the parent's number. @param {number} handle @param {any} object */
        adopt(handle, object){
            handles.set(handle, { type: 'pipe', object });
            pipes.adopted(handle, object);
        },
    };
}

/**
 * A parent with an inbound pipe for the child's output and an outbound one
 * for its input, and the child across a link with the ends it inherits.
 */
function launched(){
    const table = new Map();
    const parent = processOf({ table, id: 1 });
    const output = /** @type {{ read: number, write: number }} */ (
        parent.pipes.anonymous(0, 4096));
    const input = /** @type {{ read: number, write: number }} */ (
        parent.pipes.anonymous(0, 4096));
    // What CreateProcess hands down: the child's sides of the two pipes.
    const inherited = [
        { handle: output.write, type: 'pipe', object: parent.handles.get(output.write)?.object },
        { handle: input.read, type: 'pipe', object: parent.handles.get(input.read)?.object },
    ];
    const served = pipeHandlers(inherited);
    const child = processOf({ id: 2, across: served.pipes });
    for (const end of served.described)
    {
        child.adopt(end.handle, pipeStandIn(end.handle, end));
    }
    // The parent lets go of the child's sides, as a launcher does once the
    // child has them.
    parent.pipes.closed(output.write, parent.handles.get(output.write)?.object);
    parent.pipes.closed(input.read, parent.handles.get(input.read)?.object);
    return { parent, child, served, output, input };
}

test('each side\'s write ends the other side\'s waiting read', async()=>{
    const { parent, child, output, input } = launched();
    assert.equal(parent.read(output.read, 64), 'parked');
    assert.equal(child.write(output.write, '1 Ready\r\n'), 1);
    assert.deepEqual(parent.woken.map(one=>one.result), [1]);
    assert.equal(parent.text(9), '1 Ready\r\n');
    assert.equal(parent.count(), 9);

    const waiting = child.read(input.read, 64);
    assert.equal(typeof waiting?.then, 'function', 'a read with nothing there waits');
    assert.equal(parent.write(input.write, 'run\n'), 1);
    assert.equal(await waiting, 1);
    assert.equal(child.text(4), 'run\n');
    assert.equal(child.count(), 4);
    // Bytes already there are read at once.
    parent.write(input.write, 'more');
    assert.equal(child.read(input.read, 2), 1);
    assert.equal(child.text(2), 'mo');
    assert.equal(child.pipes.isPipe(input.read), true);
});

test('the child closing its handle breaks the pipe for the parent, as on one thread', ()=>{
    const { parent, child, output } = launched();
    child.write(output.write, 'bye');
    child.pipes.closed(output.write, child.handles.get(output.write)?.object);
    assert.equal(parent.read(output.read, 64), 1, 'what was written before is still read');
    assert.equal(parent.text(3), 'bye');
    assert.equal(parent.read(output.read, 64), 0);
    assert.equal(parent.error(), ERROR_BROKEN_PIPE);
});

test('a child that ends lets its ends go and its waiting read is cancelled', async()=>{
    const { parent, child, served, output, input } = launched();
    assert.equal(parent.read(output.read, 64), 'parked');
    const waiting = child.read(input.read, 64);
    served.dispose();
    assert.equal(await waiting, 0);
    assert.equal(child.error(), ERROR_OPERATION_ABORTED);
    assert.equal(parent.woken.at(-1)?.result, 0, 'the parent\'s read finds the pipe broken');
    // What the parent writes afterwards reaches no process that is gone.
    assert.equal(parent.write(input.write, 'late'), 0);
});

test('a child that ends while its parent still holds the end gives up its waiting read', async()=>{
    const table = new Map();
    const parent = processOf({ table, id: 1 });
    const input = /** @type {{ read: number, write: number }} */ (
        parent.pipes.anonymous(0, 4096));
    const end = parent.handles.get(input.read)?.object;
    const served = pipeHandlers([{ handle: input.read, type: 'pipe', object: end }]);
    const child = processOf({ id: 2, across: served.pipes });
    child.adopt(input.read, pipeStandIn(input.read, served.described[0]));
    const waiting = child.read(input.read, 64);
    served.dispose();
    assert.equal(await waiting, 0);
    assert.equal(child.error(), ERROR_OPERATION_ABORTED);
    // The parent's own handle keeps the end: what it writes is there for it.
    assert.equal(parent.write(input.write, 'kept'), 1);
    assert.equal(parent.read(input.read, 64), 1);
    assert.equal(parent.text(4), 'kept');
});
