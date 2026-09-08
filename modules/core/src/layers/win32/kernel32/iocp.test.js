/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIoCompletionPorts } from './iocp.js';
import { createFileFunctions } from './files.js';

const ERROR_SUCCESS = 0;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const WAIT_TIMEOUT = 258;
const ERROR_ABANDONED_WAIT_0 = 735;
const ERROR_IO_DEVICE = 1117;

const INFINITE = 0xffffffff;
const INVALID_HANDLE_VALUE = 0xffffffff;

/** The token a parked call answers with, standing in for the bridge's. */
const PARKED = Object.freeze({ parked: true });

/** Addresses the fixtures use; nothing about them matters but that they differ. */
const OUT_BYTES = 0x100;
const OUT_KEY = 0x104;
const OUT_OVERLAPPED = 0x108;
const OVERLAPPED = 0x200;
const BUFFER = 0x300;
const NAME = 0x400;
const OUT_COUNT = 0x420;

/** Guest memory as a flat array. */
function fakeMemory(size = 0x1000){
    const bytes = new Uint8Array(size);
    return {
        bytes,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /** @param {number} address @param {number} maxLength */
        readCString(address, maxLength){
            let text = '';
            for (let i = 0; i < maxLength && bytes[address + i] !== 0; i++)
            {
                text += String.fromCharCode(bytes[address + i]);
            }
            return text;
        },
        /** @param {number} address @param {string} text */
        putString(address, text){
            for (let i = 0; i < text.length; i++)
            {
                bytes[address + i] = text.charCodeAt(i) & 0xff;
            }
            bytes[address + text.length] = 0;
        },
        /** @param {number} address @param {number} value */
        putDword(address, value){
            for (let i = 0; i < 4; i++)
            {
                bytes[address + i] = (value >>> (i * 8)) & 0xff;
            }
        },
        /** @param {number} address */
        dword: address=>(bytes[address] | bytes[address + 1] << 8
            | bytes[address + 2] << 16 | bytes[address + 3] << 24) >>> 0,
    };
}

/**
 * The kernel's blocking, with the same shape the real scheduler has: a blocked
 * thread carries a deadline and the answer its wait gives when the deadline
 * passes, and whoever queued it is told when that happens.
 */
function fakeKernel(){
    /** @type {Map<number, { type: string, object: any }>} */
    const entries = new Map();
    let next = 8;
    /** @type {((thread: any) => void)[]} */
    const onTimeout = [];
    /** @type {any[]} */
    const threads = [];
    let time = 0;

    const kernel = {
        entries,
        threads,
        /** @param {string} name */
        thread(name){
            const thread = {
                name, blocked: false, reason: null, deadline: null,
                timeoutResult: 0, result: null, error: ERROR_SUCCESS,
            };
            threads.push(thread);
            return thread;
        },
        clock: { virtualTime: ()=>time },
        /** Moves guest time on and expires whatever was waiting for it. */
        /** @param {number} ms */
        advance(ms){
            time += ms;
            for (const thread of threads)
            {
                if (!thread.blocked || thread.deadline === null || thread.deadline > time)
                {
                    continue;
                }
                thread.blocked = false;
                thread.deadline = null;
                thread.result = thread.timeoutResult;
                for (const told of onTimeout)
                {
                    told(thread);
                }
            }
        },
        /** @param {(thread: any) => void} handler */
        onTimeout: handler=>onTimeout.push(handler),
        /**
         * @param {any} thread @param {string} reason
         * @param {{ deadline?: number, result?: number }} [timed]
         */
        block(thread, reason, timed){
            thread.blocked = true;
            thread.reason = reason;
            thread.deadline = timed?.deadline ?? null;
            thread.timeoutResult = timed?.result ?? 0;
        },
        /** @param {any} thread @param {number} [result] */
        wake(thread, result){
            if (!thread.blocked)
            {
                return false;
            }
            thread.blocked = false;
            thread.deadline = null;
            if (result !== undefined)
            {
                thread.result = result;
            }
            return true;
        },
        handles: {
            /** @param {string} type @param {any} object */
            open(type, object){
                const handle = next;
                next += 4;
                entries.set(handle, { type, object });
                return handle;
            },
            /** @param {number} handle @param {string} [type] */
            resolve(handle, type){
                const entry = entries.get(handle);
                if (!entry || (type && entry.type !== type))
                {
                    throw new Error(`bad handle ${handle}`);
                }
                return entry.object;
            },
            /** @param {number} handle */
            close(handle){
                const entry = entries.get(handle);
                entries.delete(handle);
                return entry ? entry.object : null;
            },
        },
    };
    return kernel;
}

function setup(){
    const memory = fakeMemory();
    const kernel = fakeKernel();
    const main = kernel.thread('main');
    /** @type {any} */
    let running = main;
    /** @type {number[]} */
    const signalled = [];
    /** @type {string[]} */
    const traced = [];
    let host = 0;

    const ports = createIoCompletionPorts({
        kernel,
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        /** @param {number} code */
        setLastError: code=>{
            running.error = code;
        },
        /** @param {any} thread @param {number} code */
        setLastErrorFor: (thread, code)=>{
            thread.error = code;
        },
        currentThread: ()=>running,
        park: ()=>PARKED,
        /** @param {number} handle */
        signalEvent: handle=>signalled.push(handle),
        /** @param {string} text */
        trace: text=>traced.push(text),
        hostTime: ()=>host,
    });

    return {
        memory, kernel, ports, main, signalled, traced,
        fns: ports.table,
        /** @param {any} thread */
        run(thread){
            running = thread;
        },
        /** Host time, which the hang report is measured in. @param {number} ms */
        elapse(ms){
            host += ms;
            ports.snapshot();
        },
        current: ()=>running,
    };
}

/** A port with nothing bound to it, which is how a work queue is made. */
/** @param {any} fns */
const makePort = fns=>fns.CreateIoCompletionPort.handler([INVALID_HANDLE_VALUE, 0, 0, 0]);

test('a packet posted to a port comes back exactly as it went in', ()=>{
    // The three values are opaque to the system: a pool uses the key to mean
    // whatever it likes, including "stop", and a value we normalise is one it
    // cannot recognise.
    const { fns, memory, main } = setup();
    const port = makePort(fns);

    assert.equal(fns.PostQueuedCompletionStatus.handler([port, 42, 0xabc, 0xdef]), 1);
    assert.equal(
        fns.GetQueuedCompletionStatus.handler([port, OUT_BYTES, OUT_KEY, OUT_OVERLAPPED, 0]), 1);

    assert.equal(memory.dword(OUT_BYTES), 42);
    assert.equal(memory.dword(OUT_KEY), 0xabc);
    assert.equal(memory.dword(OUT_OVERLAPPED), 0xdef);
    assert.equal(main.error, ERROR_SUCCESS);
});

test('a wait on an empty port parks, and a later post answers it', ()=>{
    // The whole point. A pool that is told "nothing yet" spins at full speed and
    // starves the thread that was about to give it work.
    const { fns, memory, kernel, main, run } = setup();
    const port = makePort(fns);

    assert.equal(
        fns.GetQueuedCompletionStatus.handler(
            [port, OUT_BYTES, OUT_KEY, OUT_OVERLAPPED, INFINITE]),
        PARKED);
    assert.equal(main.blocked, true);
    assert.equal(main.deadline, null, 'an infinite wait has no deadline to expire on');

    const worker = kernel.thread('worker');
    run(worker);
    fns.PostQueuedCompletionStatus.handler([port, 7, 0x1234, 0x5678]);

    assert.equal(main.blocked, false);
    assert.equal(main.result, 1, 'and its call answers TRUE');
    assert.equal(main.error, ERROR_SUCCESS, 'with the timeout it was told to expect cleared');
    assert.equal(memory.dword(OUT_BYTES), 7);
    assert.equal(memory.dword(OUT_KEY), 0x1234);
    assert.equal(memory.dword(OUT_OVERLAPPED), 0x5678);
});

test('a zero timeout is a poll rather than a wait', ()=>{
    const { fns, memory, main } = setup();
    const port = makePort(fns);
    memory.putDword(OUT_OVERLAPPED, 0xffffffff);

    assert.equal(
        fns.GetQueuedCompletionStatus.handler([port, OUT_BYTES, OUT_KEY, OUT_OVERLAPPED, 0]), 0);
    assert.equal(main.blocked, false);
    assert.equal(main.error, WAIT_TIMEOUT);
    // A caller reads lpOverlapped to tell a timeout from a failed operation, so
    // a stale pointer there is one it goes on to dereference.
    assert.equal(memory.dword(OUT_OVERLAPPED), 0);
});

test('a wait with a timeout really expires, and finds its answer already written', ()=>{
    // Nothing runs on the thread's behalf when a deadline passes: what it reads
    // has to have been true since before it parked.
    const { fns, memory, kernel, main } = setup();
    const port = makePort(fns);
    memory.putDword(OUT_BYTES, 0xdeadbeef);

    fns.GetQueuedCompletionStatus.handler([port, OUT_BYTES, OUT_KEY, OUT_OVERLAPPED, 500]);
    assert.equal(main.blocked, true);
    assert.equal(main.deadline, 500);

    kernel.advance(499);
    assert.equal(main.blocked, true, 'and not a moment before its time');

    kernel.advance(1);
    assert.equal(main.blocked, false);
    assert.equal(main.result, 0, 'a timeout is FALSE');
    assert.equal(main.error, WAIT_TIMEOUT);
    assert.equal(memory.dword(OUT_BYTES), 0);
});

test('a thread whose wait timed out is off the queue, and spends no packet', ()=>{
    const { fns, kernel, main, run } = setup();
    const port = makePort(fns);

    fns.GetQueuedCompletionStatus.handler([port, OUT_BYTES, OUT_KEY, OUT_OVERLAPPED, 10]);
    kernel.advance(10);

    const worker = kernel.thread('worker');
    run(worker);
    fns.PostQueuedCompletionStatus.handler([port, 1, 2, 3]);

    // Handed to the thread that had given up, the packet would be consumed by a
    // call that has already answered and read by nobody.
    assert.equal(main.result, 0);
    run(main);
    assert.equal(
        fns.GetQueuedCompletionStatus.handler([port, OUT_BYTES, OUT_KEY, OUT_OVERLAPPED, 0]), 1,
        'the packet is still there for whoever asks next');
});

test('closing a port wakes what is waiting on it, abandoned rather than timed out', ()=>{
    // A timeout says "ask again", and asking again about a closed handle is a
    // loop that cannot end.
    const { fns, ports, kernel, main, run } = setup();
    const port = makePort(fns);

    fns.GetQueuedCompletionStatus.handler(
        [port, OUT_BYTES, OUT_KEY, OUT_OVERLAPPED, INFINITE]);
    assert.equal(main.blocked, true);

    const closer = kernel.thread('closer');
    run(closer);
    ports.closed(port, kernel.handles.close(port));

    assert.equal(main.blocked, false);
    assert.equal(main.result, 0);
    assert.equal(main.error, ERROR_ABANDONED_WAIT_0);
});

test('a finished operation fills its OVERLAPPED and signals its event', ()=>{
    const { fns, ports, memory, signalled } = setup();
    const port = makePort(fns);
    const file = 0x40;
    fns.CreateIoCompletionPort.handler([file, port, 0xfeed, 0]);
    // OVERLAPPED: Internal, InternalHigh, Offset, OffsetHigh, hEvent.
    memory.putDword(OVERLAPPED + 16, 0x99);

    assert.equal(ports.completed(file, 128, OVERLAPPED), true);
    assert.equal(memory.dword(OVERLAPPED), 0, 'Internal is the operation\'s status');
    assert.equal(memory.dword(OVERLAPPED + 4), 128, 'InternalHigh is what it transferred');
    assert.deepEqual(signalled, [0x99]);

    assert.equal(
        fns.GetQueuedCompletionStatus.handler([port, OUT_BYTES, OUT_KEY, OUT_OVERLAPPED, 0]), 1);
    assert.equal(memory.dword(OUT_KEY), 0xfeed, 'and the packet carries the port\'s own key');
    assert.equal(memory.dword(OUT_OVERLAPPED), OVERLAPPED);
});

test('an operation on a handle bound to nothing posts nothing, and is not an error', ()=>{
    const { ports, memory } = setup();
    assert.equal(ports.completed(0x40, 8, OVERLAPPED), false);
    assert.equal(memory.dword(OVERLAPPED + 4), 8, 'the OVERLAPPED is still finished');
});

test('a closed file handle takes its port association with it', ()=>{
    // Handle numbers are recycled: an association that outlives its handle sends
    // the next file's completions into somebody else's port.
    const { fns, ports, kernel } = setup();
    const port = makePort(fns);
    const file = kernel.handles.open('file', { path: 'C:\\A' });
    fns.CreateIoCompletionPort.handler([file, port, 1, 0]);

    ports.closed(file, kernel.handles.close(file));
    assert.equal(ports.completed(file, 4, OVERLAPPED), false);
});

test('a closed port takes the associations that named it', ()=>{
    const { fns, ports, kernel } = setup();
    const port = makePort(fns);
    const file = kernel.handles.open('file', { path: 'C:\\A' });
    fns.CreateIoCompletionPort.handler([file, port, 1, 0]);

    ports.closed(port, kernel.handles.close(port));
    assert.equal(ports.completed(file, 4, OVERLAPPED), false);
});

test('a port that is not one, and a binding of nothing, are refused', ()=>{
    const { fns, main } = setup();
    assert.equal(fns.GetQueuedCompletionStatus.handler([0x1234, 0, 0, 0, 0]), 0);
    assert.equal(main.error, ERROR_INVALID_HANDLE);

    const port = makePort(fns);
    assert.equal(fns.CreateIoCompletionPort.handler([INVALID_HANDLE_VALUE, port, 0, 0]), 0);
    assert.equal(main.error, ERROR_INVALID_PARAMETER);
});

test('a wait long enough to be a hang says so, once, and only then', ()=>{
    // Parked threads and a quiet machine look exactly like work being done. The
    // clock is the host's on purpose: a machine whose every thread is on a port
    // has no deadline to move the guest's clock to, so guest time stops at
    // precisely the moment the report becomes worth having.
    const { fns, ports, traced, elapse } = setup();
    const port = makePort(fns);
    fns.GetQueuedCompletionStatus.handler(
        [port, OUT_BYTES, OUT_KEY, OUT_OVERLAPPED, INFINITE]);
    assert.deepEqual(ports.snapshot().map(wait=>wait.thread), ['main']);
    assert.deepEqual(traced, [], 'a wait of its own is not news');

    elapse(10_000);
    assert.equal(ports.snapshot().length, 1);
    assert.equal(traced.length, 1);
    assert.match(traced[0], /main.*completion port/);

    elapse(10_000);
    assert.equal(traced.length, 1, 'and it is said once, not on every look');
});

/**
 * The file surface with a port beside it: what an overlapped read or write owes
 * when it finishes, which is where the packet a pool waits on comes from.
 *
 * @param {{ read?: (offset: number, length: number) => any }} [behaviour]
 */
function fileSetup(behaviour = {}){
    const base = setup();
    const { memory, kernel, ports } = base;
    /** @type {Map<string, Uint8Array>} */
    const contents = new Map([['C:\\GAME\\DATA', Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])]]);

    const files = {
        /** @param {string} path */
        stat: path=>contents.has(path)
            ? { exists: true, isDirectory: false, size: /** @type {any} */ (contents.get(path)).length }
            : (path === 'C:\\GAME' ? { exists: true, isDirectory: true, size: 0 } : null),
        /** @param {string} path @param {any} mode */
        open(path, mode){
            if (!contents.has(path) && !mode.create)
            {
                return null;
            }
            if (!contents.has(path))
            {
                contents.set(path, new Uint8Array(0));
            }
            return { path };
        },
        /** @param {{ path: string }} node @param {number} offset @param {number} length */
        read: (node, offset, length)=>behaviour.read
            ? behaviour.read(offset, length)
            : /** @type {any} */ (contents.get(node.path)).slice(offset, offset + length),
        /** @param {{ path: string }} node @param {number} offset @param {Uint8Array} bytes */
        write(node, offset, bytes){
            const held = /** @type {any} */ (contents.get(node.path));
            const grown = new Uint8Array(Math.max(held.length, offset + bytes.length));
            grown.set(held);
            grown.set(bytes, offset);
            contents.set(node.path, grown);
            return bytes.length;
        },
        truncate: ()=>{},
        close: ()=>{},
        remove: ()=>true,
        mkdir: ()=>true,
        rename: ()=>true,
        list: ()=>[],
        currentDirectory: ()=>'C:\\GAME',
        setCurrentDirectory: ()=>{},
    };

    const fns = createFileFunctions({
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        readCString: (address, maxLength)=>memory.readCString(address, maxLength),
        readWideString: ()=>'',
        files: /** @type {any} */ (files),
        /** @param {number} code */
        setLastError: code=>{
            base.current().error = code;
        },
        writeConsole: ()=>{},
        handles: kernel.handles,
        currentThread: ()=>base.current(),
        /** @param {any} thread @param {number} code */
        setLastErrorFor: (thread, code)=>{
            thread.error = code;
        },
        ports: {
            /** @param {number} overlapped */
            offsetOf: overlapped=>ports.offsetOf(overlapped),
            /** @param {number} file @param {number} n @param {number} overlapped */
            completed: (file, n, overlapped)=>ports.completed(file, n, overlapped),
            /** @param {number} handle @param {any} object */
            closed: (handle, object)=>ports.closed(handle, object),
        },
    });

    memory.putString(NAME, 'C:\\GAME\\DATA');
    // GENERIC_READ | GENERIC_WRITE, OPEN_ALWAYS.
    const file = fns.CreateFileA.handler([NAME, 0xc0000000, 0, 0, 4, 0, 0]);
    return { ...base, files: fns, contents, file };
}

test('an overlapped read posts a packet carrying the port key and the OVERLAPPED', ()=>{
    const { files, fns, memory, file } = fileSetup();
    const port = makePort(fns);
    fns.CreateIoCompletionPort.handler([file, port, 0x1111, 0]);
    memory.putDword(OVERLAPPED + 8, 4);   // Offset: where the read is to start.

    assert.equal(files.ReadFile.handler([file, BUFFER, 4, OUT_COUNT, OVERLAPPED]), 1);
    assert.deepEqual([...memory.bytes.slice(BUFFER, BUFFER + 4)], [5, 6, 7, 8],
        'the position comes out of the OVERLAPPED, not the file pointer');
    assert.equal(memory.dword(OUT_COUNT), 4);

    assert.equal(
        fns.GetQueuedCompletionStatus.handler([port, OUT_BYTES, OUT_KEY, OUT_OVERLAPPED, 0]), 1);
    assert.equal(memory.dword(OUT_BYTES), 4);
    assert.equal(memory.dword(OUT_KEY), 0x1111);
    assert.equal(memory.dword(OUT_OVERLAPPED), OVERLAPPED);
});

test('an overlapped write owes the same packet', ()=>{
    // A save written through a pool hangs just as hard as a read: the worker
    // waits on the packet, whatever the operation was.
    const { files, fns, memory, contents, file } = fileSetup();
    const port = makePort(fns);
    fns.CreateIoCompletionPort.handler([file, port, 0x2222, 0]);
    memory.bytes.set([0xaa, 0xbb], BUFFER);
    memory.putDword(OVERLAPPED + 8, 2);

    assert.equal(files.WriteFile.handler([file, BUFFER, 2, OUT_COUNT, OVERLAPPED]), 1);
    assert.deepEqual([...(/** @type {any} */ (contents.get('C:\\GAME\\DATA')).slice(2, 4))],
        [0xaa, 0xbb]);
    assert.equal(
        fns.GetQueuedCompletionStatus.handler([port, OUT_BYTES, OUT_KEY, OUT_OVERLAPPED, 0]), 1);
    assert.equal(memory.dword(OUT_KEY), 0x2222);
    assert.equal(memory.dword(OUT_OVERLAPPED), OVERLAPPED);
});

test('a read that fails after parking answers with an error of its own', async()=>{
    // FALSE over whatever code the slot happened to hold is an answer the caller
    // cannot read -- and by the time the read fails, the running thread is
    // somebody else and the ordinary slot names the wrong one.
    const { files, main, file, run, kernel } = fileSetup({
        read: ()=>Promise.reject(new Error('the block never arrived')),
    });
    main.error = 997;   // ERROR_IO_PENDING, the code that reads as "wait for it".

    const answer = files.ReadFile.handler([file, BUFFER, 4, OUT_COUNT, 0]);
    run(kernel.thread('somebody-else'));
    assert.equal(await answer, 0);
    assert.equal(main.error, ERROR_IO_DEVICE, 'on the thread that asked, not the one running');
});

test('a read on a handle bound to no port still reads', ()=>{
    const { files, memory, file } = fileSetup();
    assert.equal(files.ReadFile.handler([file, BUFFER, 3, OUT_COUNT, 0]), 1);
    assert.equal(memory.dword(OUT_COUNT), 3);
});
