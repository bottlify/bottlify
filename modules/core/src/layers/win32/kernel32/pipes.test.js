/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Named pipes between processes: each process here is a pipes table of its
 * own -- its memory, its handles, its kernel, its completion port -- over one
 * shared namespace, as the run's processes on the engine's thread are. The
 * cases are the ones Wine's kernel32 pipe tests put to Windows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PIPE_CLIENT, createNamedPipes, isPipeName, pipeDeviceOf } from './pipes.js';

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_BROKEN_PIPE = 109;
const ERROR_SEM_TIMEOUT = 121;
const ERROR_INVALID_NAME = 123;
const ERROR_PIPE_BUSY = 231;
const ERROR_NO_DATA = 232;
const ERROR_PIPE_NOT_CONNECTED = 233;
const ERROR_MORE_DATA = 234;
const ERROR_PIPE_CONNECTED = 535;
const ERROR_PIPE_LISTENING = 536;
const ERROR_IO_PENDING = 997;
const ERROR_OPERATION_ABORTED = 995;
const ERROR_BAD_PIPE = 230;
const ERROR_PIPE_LOCAL = 229;
const ERROR_INSUFFICIENT_BUFFER = 122;

const PIPE_ACCESS_INBOUND = 0x1;
const PIPE_ACCESS_DUPLEX = 0x3;
const FILE_FLAG_OVERLAPPED = 0x40000000;
const FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
const PIPE_TYPE_MESSAGE = 0x4;
const PIPE_READMODE_MESSAGE = 0x2;
const PIPE_NOWAIT = 0x1;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const RW = (GENERIC_READ | GENERIC_WRITE) >>> 0;

const STATUS_PENDING = 0x103;
const STATUS_BUFFER_OVERFLOW = 0x80000005;
const STATUS_CANCELLED = 0xc0000120;

const NAME = '\\\\.\\pipe\\winetestpipe';
const NAME_AT = 0x100;
const BUFFER = 0x400;
const COUNT = 0x500;
const OVERLAPPED = 0x600;
const STATE = 0x700;

/**
 * One process: its memory, handles, kernel and port, over the run's table.
 *
 * @param {Map<string, any>} table @param {number} [id]
 * @param {Partial<import('./pipes.js').PipeHost>} [extra]  more of the host
 */
function processOn(table, id = 1, extra = {}){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    /** @type {Map<number, { type: string, object: any, access?: number | null }>} */
    const handles = new Map();
    let next = 0x100;
    let now = 0;
    /** @type {Map<any, number>} */
    const lastError = new Map();
    /** @type {any[]} */
    const blocked = [];
    /** @type {{ thread: any, result: number }[]} */
    const woken = [];
    /** @type {((thread: any) => void)[]} */
    const timeouts = [];
    /** @type {{ timer: any, due: number, fired: () => void }[]} */
    const timers = [];
    /** @type {number[]} */
    const events = [];
    /** @type {number[]} */
    const resets = [];
    /** @type {{ file: number, transferred: number, overlapped: number, status: number }[]} */
    const packets = [];
    /** @type {Set<number>} */
    const bound = new Set();
    /** @type {{ thread: any, routine: number, args: number[] }[]} */
    const apcs = [];
    let current = `p${id}:main`;
    const pipes = createNamedPipes({
        kernel: {
            block: (/** @type {any} */ thread, /** @type {string} */ reason,
                /** @type {any} */ timed)=>blocked.push({ thread, reason, timed }),
            wake: (/** @type {any} */ thread, /** @type {number} */ result)=>{
                woken.push({ thread, result });
                return true;
            },
            onTimeout: (/** @type {(thread: any) => void} */ handler)=>timeouts.push(handler),
            clock: { virtualTime: ()=>now },
            createEvent: (/** @type {any} */ options)=>({ ...options }),
            createTimer: ()=>({}),
            armTimer: (/** @type {any} */ timer, /** @type {number} */ due,
                /** @type {number} */ period, /** @type {() => void} */ fired)=>
            {
                void period;
                timers.push({ timer, due, fired });
                return true;
            },
            cancelTimer: (/** @type {any} */ timer)=>{
                const at = timers.findIndex(one=>one.timer === timer);
                if (at !== -1)
                {
                    timers.splice(at, 1);
                }
            },
            setEvent: (/** @type {any} */ event)=>{
                event.signalled = true;
            },
            resetEvent: (/** @type {any} */ event)=>{
                event.signalled = false;
            },
        },
        handles: {
            open: (type, object, access = null)=>{
                next += 4;
                handles.set(next, { type, object, access });
                return next;
            },
            access: handle=>handles.get(handle)?.access ?? null,
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
        readCString: (address, max)=>{
            let text = '';
            for (let at = address; at < address + max && bytes[at] !== 0; at++)
            {
                text += String.fromCharCode(bytes[at]);
            }
            return text;
        },
        readWideString: (address, max)=>{
            let text = '';
            for (let at = address; at < address + max && view.getUint16(at, true) !== 0;
                at += 2)
            {
                text += String.fromCharCode(view.getUint16(at, true));
            }
            return text;
        },
        setLastError: code=>lastError.set(current, code),
        setLastErrorFor: (thread, code)=>lastError.set(thread, code),
        currentThread: ()=>current,
        park: ()=>'parked',
        table,
        processId: id,
        completed: (file, transferred, overlapped, status = 0, skip = {})=>{
            view.setUint32(overlapped, status, true);
            view.setUint32(overlapped + 4, transferred, true);
            const event = view.getUint32(overlapped + 16, true);
            if (event !== 0 && !skip.event)
            {
                events.push(event);
            }
            if (bound.has(file) && !skip.port)
            {
                packets.push({ file, transferred, overlapped, status });
                return true;
            }
            return false;
        },
        posted: (file, transferred, status, value)=>{
            if (!bound.has(file))
            {
                return false;
            }
            packets.push({ file, transferred, overlapped: value, status });
            return true;
        },
        setEvent: (/** @type {number} */ event)=>events.push(event),
        resetEvent: (/** @type {number} */ event)=>resets.push(event),
        queueApc: (thread, routine, args)=>apcs.push({ thread, routine, args }),
        ...extra,
    });
    const fns = /** @type {Record<string, { handler: (args: number[]) => any }>} */ (
        /** @type {unknown} */ (pipes.functions));
    /** @param {number} at @param {string} text */
    const putString = (at, text)=>{
        bytes.set([...text, '\0'].map(ch=>ch.charCodeAt(0)), at);
        return at;
    };
    /** @param {number} at @param {string} text */
    const putWide = (at, text)=>{
        [...text, '\0'].forEach((ch, i)=>view.setUint16(at + i * 2, ch.charCodeAt(0), true));
        return at;
    };
    const u32 = (/** @type {number} */ at)=>view.getUint32(at, true);
    return {
        pipes, fns, bytes, view, u32, putString, putWide, blocked, woken, timeouts, timers, events,
        resets, packets, bound, handles, apcs,
        error: ()=>lastError.get(current),
        errorOf: (/** @type {any} */ thread)=>lastError.get(thread),
        /** @param {string} thread */
        as: thread=>{
            current = thread;
        },
        /** @param {number} ms */
        advance: ms=>{
            now += ms;
        },
        /**
         * A server instance of NAME, by the narrow name.
         *
         * @param {number} [openMode] @param {number} [pipeMode] @param {number} [max]
         * @param {number} [timeout]
         */
        server: (openMode = PIPE_ACCESS_DUPLEX, pipeMode = 0, max = 1, timeout = 0)=>
            fns.CreateNamedPipeA.handler([putString(NAME_AT, NAME), openMode, pipeMode, max,
                1024, 1024, timeout, 0]) >>> 0,
        /** @param {string} name */
        query: name=>pipes.query(name),
        /** A client end of NAME. @param {number} [access] @param {number} [flags] */
        client: (access = RW, flags = 0)=>{
            const opened = pipes.open(NAME, access, flags);
            return 'handle' in opened ? opened.handle : -opened.error;
        },
        /** @param {number} handle @param {string} text @param {number} [overlapped] */
        write: (handle, text, overlapped = 0)=>{
            bytes.set([...text].map(ch=>ch.charCodeAt(0)), BUFFER + 0x800);
            return pipes.write(handle, BUFFER + 0x800, text.length, COUNT + 4, false,
                overlapped);
        },
        /** @param {number} handle @param {number} length @param {number} [overlapped] */
        read: (handle, length, overlapped = 0)=>pipes.read(handle, BUFFER, length, COUNT, false,
            overlapped),
        /** @param {number} length */
        text: length=>String.fromCharCode(...bytes.subarray(BUFFER, BUFFER + length)),
    };
}

test('a pipe\'s name is under \\\\.\\pipe\\, whatever its case', ()=>{
    assert.ok(isPipeName('\\\\.\\PIPE\\x'));
    assert.ok(isPipeName('\\\\?\\pipe\\x'));
    assert.ok(!isPipeName('\\\\.\\pipe\\'));
    assert.ok(!isPipeName('C:\\pipe\\x'));
});

test('a byte pipe carries bytes both ways, reads coalescing writes', ()=>{
    const p = processOn(new Map());
    const server = p.server();
    assert.notEqual(server, 0xffffffff);
    const client = p.client();
    assert.ok(client > 0);
    assert.equal(p.fns.ConnectNamedPipe.handler([server, 0]), 0);
    assert.equal(p.error(), ERROR_PIPE_CONNECTED, 'the client came first: a good connection');

    assert.equal(p.write(client, 'abc'), 1);
    assert.equal(p.write(client, 'de'), 1);
    assert.equal(p.u32(COUNT + 4), 2);
    assert.equal(p.read(server, 100), 1);
    assert.equal(p.u32(COUNT), 5, 'a byte read takes both writes');
    assert.equal(p.text(5), 'abcde');

    assert.equal(p.write(server, 'xyz'), 1);
    assert.equal(p.read(client, 2), 1);
    assert.equal(p.text(2), 'xy');
    assert.equal(p.read(client, 2), 1);
    assert.equal(p.u32(COUNT), 1);
    assert.equal(p.text(1), 'z');
});

test('a write or a read that goes through leaves the last error as it was', ()=>{
    // A program reads it after an overlapped read that pends and a write
    // that went through, and finds the pending one's ERROR_IO_PENDING.
    const p = processOn(new Map());
    const server = p.server();
    p.as('p1:reader');
    assert.equal(p.read(server, 10), 0);
    assert.equal(p.error(), ERROR_PIPE_LISTENING);
    p.as('p1:writer');
    assert.equal(p.read(server, 10), 0);
    const client = p.client();
    assert.equal(p.write(client, 'ab'), 1);
    assert.equal(p.error(), ERROR_PIPE_LISTENING, 'the write');
    p.as('p1:reader');
    assert.equal(p.read(server, 2), 1);
    assert.equal(p.error(), ERROR_PIPE_LISTENING, 'the read');
    // A reader that waited and was given its bytes, the same.
    assert.equal(p.read(server, 2), 'parked');
    p.as('p1:writer');
    p.write(client, 'cd');
    assert.deepEqual(p.woken.at(-1), { thread: 'p1:reader', result: 1 });
    assert.equal(p.errorOf('p1:reader'), ERROR_PIPE_LISTENING, 'the read that waited');
});

test('a message pipe reads a message whole, or in parts with ERROR_MORE_DATA', ()=>{
    const p = processOn(new Map());
    const server = p.server(PIPE_ACCESS_DUPLEX, PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE);
    const client = p.client();
    p.view.setUint32(STATE, PIPE_READMODE_MESSAGE, true);
    assert.equal(p.fns.SetNamedPipeHandleState.handler([client, STATE, 0, 0]), 1);

    p.write(client, 'hello');
    p.write(client, 'wo');
    assert.equal(p.read(server, 3), 0);
    assert.equal(p.error(), ERROR_MORE_DATA);
    assert.equal(p.u32(COUNT), 3);
    assert.equal(p.text(3), 'hel');
    assert.equal(p.pipes.peek([server, BUFFER, 100, COUNT, COUNT + 4, COUNT + 8]), 1);
    assert.deepEqual([p.u32(COUNT), p.u32(COUNT + 4), p.u32(COUNT + 8)], [2, 4, 0],
        'what a read would see: the rest of the message, two of four bytes waiting');
    assert.equal(p.read(server, 100), 1);
    assert.equal(p.text(2), 'lo', 'the rest of the first message, and no more');
    assert.equal(p.read(server, 100), 1);
    assert.equal(p.text(2), 'wo');

    assert.equal(p.fns.GetNamedPipeHandleStateA.handler([client, STATE, STATE + 4, 0, 0, 0, 0]),
        1);
    assert.deepEqual([p.u32(STATE), p.u32(STATE + 4)], [PIPE_READMODE_MESSAGE, 1]);
    assert.equal(p.fns.GetNamedPipeInfo.handler([server, STATE, STATE + 4, STATE + 8,
        STATE + 12]), 1);
    assert.deepEqual([p.u32(STATE), p.u32(STATE + 12)], [PIPE_TYPE_MESSAGE | 1, 1],
        'the server end of a message pipe, one instance at most');
});

test('a query of the name takes an instance that listens and lets it go, as Windows\' does',
    ()=>{
        // Wine's msvcp120 test_tr2_sys__Stat: a stat of a pipe's name is a
        // regular file, and a second finds the instance busy until the
        // server makes another.
        const p = processOn(new Map());
        assert.equal(p.query(NAME), ERROR_FILE_NOT_FOUND);
        p.server();
        assert.equal(p.query(NAME), 0);
        assert.equal(p.query(NAME), ERROR_PIPE_BUSY, 'the one instance\'s client is gone');
        assert.equal(p.client(), -ERROR_PIPE_BUSY, 'and CreateFile finds it so too');
    });

test('creation refuses a bad name, a busy pipe and a second first instance', ()=>{
    const p = processOn(new Map());
    p.putString(0x200, '\\\\.\\mailslot\\x');
    assert.equal(p.fns.CreateNamedPipeA.handler([0x200, 3, 0, 1, 0, 0, 0, 0]) >>> 0, 0xffffffff);
    assert.equal(p.error(), ERROR_INVALID_NAME);
    assert.equal(p.server(PIPE_ACCESS_DUPLEX, PIPE_READMODE_MESSAGE) >>> 0, 0xffffffff);
    assert.equal(p.error(), ERROR_INVALID_PARAMETER, 'message reading of a byte pipe');
    p.server(PIPE_ACCESS_DUPLEX, 0, 2);
    p.server(PIPE_ACCESS_DUPLEX, 0, 2);
    assert.equal(p.server(PIPE_ACCESS_DUPLEX, 0, 2) >>> 0, 0xffffffff);
    assert.equal(p.error(), ERROR_PIPE_BUSY, 'a third instance of two');
    // The count refuses first: a first instance asked of a full pipe is busy
    // (ntdll's om test, NtCreateNamedPipeFile with FILE_CREATE, which
    // FILE_FLAG_FIRST_PIPE_INSTANCE is spelt as).
    assert.equal(p.server(PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE, 0, 2) >>> 0,
        0xffffffff);
    assert.equal(p.error(), ERROR_PIPE_BUSY);
    const roomy = processOn(new Map());
    roomy.server(PIPE_ACCESS_DUPLEX, 0, 2);
    assert.equal(roomy.server(PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE, 0, 2) >>> 0,
        0xffffffff);
    assert.equal(roomy.error(), ERROR_ACCESS_DENIED, 'a first instance of a pipe already there');

    const q = processOn(new Map());
    assert.equal(q.client(), -ERROR_FILE_NOT_FOUND);
    q.server();
    assert.ok(q.client() > 0);
    assert.equal(q.client(), -ERROR_PIPE_BUSY, 'the one instance is taken');
    const r = processOn(new Map());
    r.server(PIPE_ACCESS_INBOUND);
    assert.equal(r.client(GENERIC_READ), -ERROR_ACCESS_DENIED, 'an inbound pipe is not read');
    assert.ok(r.client(GENERIC_WRITE) > 0);
});

test('a waiting connect and a waiting read are finished by the other side', ()=>{
    const p = processOn(new Map());
    const server = p.server();
    assert.equal(p.read(server, 10), 0);
    assert.equal(p.error(), ERROR_PIPE_LISTENING, 'nothing to read before a client');
    assert.equal(p.fns.ConnectNamedPipe.handler([server, 0]), 'parked');
    const client = p.client();
    assert.deepEqual(p.woken.at(-1), { thread: 'p1:main', result: 1 });

    p.as('p1:reader');
    assert.equal(p.read(server, 10), 'parked');
    p.as('p1:writer');
    p.write(client, 'ping');
    assert.deepEqual(p.woken.at(-1), { thread: 'p1:reader', result: 1 });
    assert.equal(p.u32(COUNT), 4);
    assert.equal(p.text(4), 'ping');
});

test('overlapped: a connect and a read pend, then complete through the event and the port',
    ()=>{
        const p = processOn(new Map());
        const server = p.server(PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED);
        p.bound.add(server);
        p.view.setUint32(OVERLAPPED + 16, 0x88, true);
        assert.equal(p.fns.ConnectNamedPipe.handler([server, OVERLAPPED]), 0);
        assert.equal(p.error(), ERROR_IO_PENDING);
        assert.equal(p.u32(OVERLAPPED), STATUS_PENDING);
        const client = p.client(RW, FILE_FLAG_OVERLAPPED);
        assert.equal(p.u32(OVERLAPPED), 0);
        assert.deepEqual(p.events, [0x88]);
        assert.equal(p.packets.length, 1);

        assert.equal(p.read(server, 10, OVERLAPPED), 0);
        assert.equal(p.error(), ERROR_IO_PENDING);
        p.write(client, 'data');
        assert.deepEqual([p.u32(OVERLAPPED), p.u32(OVERLAPPED + 4)], [0, 4]);
        assert.equal(p.text(4), 'data');
        assert.deepEqual(p.packets.at(-1), { file: server, transferred: 4,
            overlapped: OVERLAPPED, status: 0 });

        // Bytes already there: TRUE at once, and the packet all the same...
        p.write(client, 'more');
        assert.equal(p.read(server, 10, OVERLAPPED), 1);
        assert.equal(p.packets.length, 3);
        // ...unless the handle asked to skip it.
        assert.equal(p.fns.SetFileCompletionNotificationModes.handler([server, 1]), 1);
        p.write(client, 'again');
        assert.equal(p.read(server, 10, OVERLAPPED), 1);
        assert.equal(p.packets.length, 3, 'FILE_SKIP_COMPLETION_PORT_ON_SUCCESS');
        assert.equal(p.pipes.skipsPortOnSuccess(server), true, 'which winsock asks too');
        assert.equal(p.pipes.skipsPortOnSuccess(client), false);
    });

test('an overlapped part of a message completes with STATUS_BUFFER_OVERFLOW', ()=>{
    const p = processOn(new Map());
    const server = p.server(PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
        PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE);
    p.bound.add(server);
    const client = p.client();
    assert.equal(p.read(server, 2, OVERLAPPED), 0);
    p.write(client, 'abcd');
    assert.deepEqual([p.u32(OVERLAPPED), p.u32(OVERLAPPED + 4)], [STATUS_BUFFER_OVERFLOW, 2]);
    assert.equal(p.read(server, 2, 0), 1, 'the rest, whole');
    assert.equal(p.text(2), 'cd');
});

test('a closed end breaks the pipe both ways, after what it wrote is read', ()=>{
    const p = processOn(new Map());
    const server = p.server();
    const client = p.client();
    p.write(client, 'last');
    p.pipes.closed(client, p.handles.get(client)?.object);
    assert.equal(p.read(server, 10), 1, 'what was written before the close is read');
    assert.equal(p.read(server, 10), 0);
    assert.equal(p.error(), ERROR_BROKEN_PIPE);
    assert.equal(p.write(server, 'x'), 0);
    assert.equal(p.error(), ERROR_NO_DATA);
    assert.equal(p.fns.ConnectNamedPipe.handler([server, 0]), 0);
    assert.equal(p.error(), ERROR_NO_DATA, 'the client came and went');

    const q = processOn(new Map());
    const second = q.server();
    const other = q.client();
    q.as('q:reader');
    assert.equal(q.read(other, 10), 'parked');
    q.pipes.closed(second, q.handles.get(second)?.object);
    assert.deepEqual(q.woken.at(-1), { thread: 'q:reader', result: 0 });
    assert.equal(q.errorOf('q:reader'), ERROR_BROKEN_PIPE, 'a waiting read learns it');
});

test('DisconnectNamedPipe cuts the client off and listens again', ()=>{
    const p = processOn(new Map());
    const server = p.server();
    const client = p.client();
    p.write(client, 'dropped');
    assert.equal(p.fns.DisconnectNamedPipe.handler([client]), 0, 'the server\'s call');
    assert.equal(p.fns.DisconnectNamedPipe.handler([server]), 1);
    assert.equal(p.read(client, 10), 0);
    assert.equal(p.error(), ERROR_PIPE_NOT_CONNECTED);
    assert.equal(p.client(), -ERROR_PIPE_BUSY, 'not listening until connected again');
    assert.equal(p.fns.ConnectNamedPipe.handler([server, 0]), 'parked');
    const again = p.client();
    assert.ok(again > 0);
    assert.equal(p.read(server, 10, 0), 'parked', 'what the first client wrote is gone');
});

test('WaitNamedPipe finds a listening instance, waits for one, and times out', ()=>{
    const p = processOn(new Map());
    p.putString(0x200, NAME);
    assert.equal(p.fns.WaitNamedPipeA.handler([0x200, 0]), 0);
    assert.equal(p.error(), ERROR_FILE_NOT_FOUND);
    const server = p.server(PIPE_ACCESS_DUPLEX, 0, 1, 500);
    assert.equal(p.fns.WaitNamedPipeA.handler([0x200, 0]), 1);
    p.client();
    assert.equal(p.fns.WaitNamedPipeA.handler([0x200, 0]), 'parked');
    assert.equal(p.blocked.at(-1).timed.deadline, 500, 'the pipe\'s default wait');
    p.fns.DisconnectNamedPipe.handler([server]);
    p.fns.ConnectNamedPipe.handler([server, OVERLAPPED]);
    assert.deepEqual(p.woken.at(-1), { thread: 'p1:main', result: 1 }, 'an instance listens');
    p.client();
    assert.equal(p.fns.WaitNamedPipeA.handler([0x200, 10]), 'parked');
    assert.equal(p.blocked.at(-1).timed.result, 0);
    assert.equal(p.error(), ERROR_SEM_TIMEOUT, 'what a wait that runs out answers');
});

test('two processes talk through one namespace, each answered in its own memory', ()=>{
    const table = new Map();
    const parent = processOn(table, 1);
    const child = processOn(table, 2);
    const server = parent.server(PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED);
    parent.bound.add(server);
    assert.equal(parent.read(server, 10, OVERLAPPED), 0);
    assert.equal(parent.error(), ERROR_PIPE_LISTENING);
    const client = child.client();
    assert.ok(client > 0);
    assert.equal(parent.read(server, 20, OVERLAPPED), 0);
    assert.equal(parent.error(), ERROR_IO_PENDING);
    child.write(client, 'from the child');
    assert.equal(parent.text(14), 'from the child', 'in the parent\'s memory');
    assert.equal(parent.packets.length, 1, 'on the parent\'s port');
    assert.equal(child.packets.length, 0);

    child.as('p2:reader');
    assert.equal(child.read(client, 10), 'parked');
    parent.write(server, 'reply');
    assert.deepEqual(child.woken.at(-1), { thread: 'p2:reader', result: 1 },
        'the child\'s kernel wakes the child\'s thread');
    assert.equal(child.text(5), 'reply');
    assert.equal(parent.fns.GetNamedPipeClientProcessId.handler([server, STATE]), 1);
    assert.equal(parent.u32(STATE), 2);
});

test('cancelled: a pending read ends ERROR_OPERATION_ABORTED; a closing handle\'s breaks the pipe',
    ()=>{
        const p = processOn(new Map());
        const server = p.server(PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED);
        p.bound.add(server);
        p.client();
        assert.equal(p.read(server, 10, OVERLAPPED), 0);
        assert.equal(p.pipes.cancel(server, {}), 1);
        assert.equal(p.u32(OVERLAPPED), STATUS_CANCELLED);
        assert.equal(p.packets.at(-1)?.status, STATUS_CANCELLED);
        assert.equal(p.pipes.cancel(server, {}), 0, 'nothing left');
        assert.equal(p.pipes.cancel(0x9999, {}), null, 'no pipe at all');

        p.as('p1:reader');
        assert.equal(p.read(server, 10), 'parked');
        // The pipe driver completes what is pending on the end being closed
        // as the pipe broken (Wine's ntdll:file test_iocp_fileio, recorded
        // on Windows), not as cancelled.
        p.pipes.closed(server, p.handles.get(server)?.object);
        assert.equal(p.errorOf('p1:reader'), ERROR_BROKEN_PIPE);
    });

test('NtReadFile on an end opened for overlapped I/O does not wait: block, event, APC, port',
    ()=>{
        const p = processOn(new Map());
        const server = p.server(PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED);
        p.bound.add(server);
        const client = p.client();
        const BLOCK = COUNT + 0x40;
        const io = { event: 0x77, apc: 0x401000, context: 0xc0de };
        p.view.setUint32(BLOCK, 0xdeadbeef, true);
        assert.equal(p.pipes.read(server, BUFFER, 10, BLOCK, true, 0, io), STATUS_PENDING);
        assert.equal(p.u32(BLOCK), 0xdeadbeef, 'the block is written when the read is done');
        assert.equal(p.blocked.length, 0, 'nothing waits');

        assert.equal(p.write(client, 'hey'), 1);
        assert.deepEqual([p.u32(BLOCK), p.u32(BLOCK + 4)], [0, 3]);
        assert.equal(p.text(3), 'hey');
        assert.ok(p.events.includes(0x77), 'its event is set');
        assert.deepEqual(p.apcs.at(-1)?.args, [0xc0de, BLOCK, 0], 'its APC is queued');
        assert.deepEqual(p.packets.at(-1), { file: server, transferred: 3, overlapped: 0xc0de,
            status: 0 }, 'the port is handed the ApcContext');

        // On an end opened without FILE_FLAG_OVERLAPPED the same call waits.
        const p2 = processOn(new Map());
        const plain = p2.server(PIPE_ACCESS_DUPLEX);
        p2.client();
        assert.equal(p2.pipes.read(plain, BUFFER, 10, BLOCK, true, 0, io), 'parked');
    });

test('a nowait end answers at once, and an end held twice breaks with its last handle', ()=>{
    const p = processOn(new Map());
    const server = p.server(PIPE_ACCESS_DUPLEX, PIPE_NOWAIT);
    const client = p.client();
    assert.equal(p.read(server, 10), 0);
    assert.equal(p.error(), ERROR_NO_DATA);
    const end = p.handles.get(client)?.object;
    end.retain();
    p.pipes.closed(client, end);
    assert.equal(p.write(server, 'x'), 1, 'one handle still holds the client end');
    p.pipes.closed(client, end);
    assert.equal(p.write(server, 'x'), 0);
    assert.equal(p.error(), ERROR_NO_DATA);
});

test('a handle made inheritable is one a child gets, and only those the list names', ()=>{
    const p = processOn(new Map());
    p.putString(NAME_AT, NAME);
    p.view.setUint32(0x300, 12, true);
    p.view.setUint32(0x308, 1, true);
    const server = p.fns.CreateNamedPipeA.handler([NAME_AT, 3, 0, 2, 0, 0, 0, 0x300]);
    const kept = p.server(PIPE_ACCESS_DUPLEX, 0, 2);
    assert.deepEqual(p.pipes.inherited(null).map(one=>one.handle), [server]);
    p.pipes.setInheritable(kept, true);
    assert.deepEqual(p.pipes.inherited(null).map(one=>one.handle), [server, kept]);
    assert.deepEqual(p.pipes.inherited([kept]).map(one=>one.handle), [kept]);

    const child = processOn(new Map(), 2);
    const entry = p.pipes.inherited([kept])[0];
    child.handles.set(entry.handle, { type: 'pipe', object: entry.object });
    child.pipes.adopted(entry.handle, entry.object);
    p.pipes.closed(kept, entry.object);
    const client = p.client();
    assert.ok(client > 0, 'the instance the child holds still listens');
});

test('a child\'s inherited end closes when the child ends: its reader reads to the end', ()=>{
    // .NET's Process reads a redirected child's output until the pipe breaks,
    // which is when the last write handle -- the child's -- is gone.
    const p = processOn(new Map());
    const server = p.server(PIPE_ACCESS_DUPLEX);
    const client = p.client();
    p.pipes.setInheritable(client, true);
    const child = processOn(new Map(), 2);
    const entry = p.pipes.inherited([client])[0];
    child.handles.set(entry.handle, { type: 'pipe', object: entry.object });
    child.pipes.adopted(entry.handle, entry.object);
    p.pipes.closed(client, entry.object);
    assert.equal(child.write(entry.handle, 'out'), 1);
    child.pipes.processEnded();
    assert.equal(p.read(server, 10), 1, 'what the child wrote is still read');
    assert.equal(p.read(server, 10), 0);
    assert.equal(p.error(), ERROR_BROKEN_PIPE, 'and then the end of it');
});

test('a wait on an end\'s handle is a wait on its pending operations, as on a file', ()=>{
    const p = processOn(new Map());
    const server = p.server(PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED);
    const signal = p.pipes.waitable(server);
    assert.equal(signal.signalled, true, 'nothing pending yet');
    assert.equal(p.fns.ConnectNamedPipe.handler([server, OVERLAPPED]), 0);
    assert.equal(signal.signalled, false, 'a connect is pending');
    const client = p.client(RW, FILE_FLAG_OVERLAPPED);
    assert.equal(signal.signalled, true, 'the connect is done');
    assert.equal(p.read(server, 10, OVERLAPPED), 0);
    assert.equal(signal.signalled, false, 'a read is pending');
    p.write(client, 'x');
    assert.equal(signal.signalled, true, 'and done');
    assert.equal(p.pipes.waitable(0x9999), null);
});

test('an operation with an event of its own leaves the handle unsignalled; a cancel through'
    + ' another handle onto the end ends it', ()=>{
    const p = processOn(new Map());
    const server = p.server(PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED);
    const client = p.client(RW, FILE_FLAG_OVERLAPPED);
    const signal = p.pipes.waitable(server);
    p.view.setUint32(OVERLAPPED + 16, 0x88, true);
    assert.equal(p.read(server, 10, OVERLAPPED), 0);
    assert.equal(signal.signalled, false, 'pending');
    p.write(client, 'x');
    assert.equal(signal.signalled, false, 'done, but the OVERLAPPED had its event to set');
    assert.ok(p.events.includes(0x88));

    // A second handle onto the server end: I/O is the end's, not the number's.
    const other = p.handles.size + 0x1000;
    p.handles.set(other, { type: 'pipe', object: p.handles.get(server)?.object, access: null });
    const BLOCK = COUNT + 0x40;
    const io = { event: 0, apc: 0x401000, context: 7 };
    assert.equal(p.pipes.read(server, BUFFER, 10, BLOCK, true, 0, io), STATUS_PENDING);
    assert.equal(p.pipes.cancel(other, {}), 1, 'cancelled through the other handle');
    assert.deepEqual([p.u32(BLOCK), p.u32(BLOCK + 4)], [STATUS_CANCELLED, 0]);
    assert.deepEqual(p.apcs.at(-1)?.args, [7, BLOCK, 0], 'its APC queued');
});

test('NtFlushBuffersFile waits for the reader to take everything; a cut client is refused, a'
    + ' server with nothing to wait for is done', ()=>{
    const STATUS_PIPE_DISCONNECTED = 0xc00000b0;
    const BLOCK = COUNT + 0x40;
    const p = processOn(new Map());
    const server = p.server();
    assert.equal(p.pipes.flushNative(server, BLOCK), 0, 'listening: nothing to flush');
    const client = p.client();
    p.write(client, 'abc');
    const signal = p.pipes.waitable(client);
    assert.deepEqual(p.pipes.flushNative(client, BLOCK), { parked: 'parked' });
    assert.equal(signal.signalled, false, 'a pending flush holds the handle down');
    assert.equal(p.read(server, 3), 1);
    assert.deepEqual([p.u32(BLOCK), p.u32(BLOCK + 4)], [0, 0], 'read: the flush is done');
    assert.deepEqual(p.woken.at(-1)?.result, 0);
    assert.equal(p.fns.DisconnectNamedPipe.handler([server]), 1);
    assert.equal(p.pipes.flushNative(client, BLOCK), STATUS_PIPE_DISCONNECTED);
    assert.equal(p.pipes.flushNative(server, BLOCK), 0, 'the server end is done');
    assert.equal(p.pipes.flushNative(0x9999, BLOCK), null);
});

test('a synchronous native read that waited signals its event and queues its APC after waking',
    ()=>{
        const p = processOn(new Map());
        const server = p.server(PIPE_ACCESS_DUPLEX);
        const client = p.client();
        const BLOCK = COUNT + 0x40;
        const io = { event: 0x77, apc: 0x401000, context: 9 };
        assert.equal(p.pipes.read(server, BUFFER, 10, BLOCK, true, 0, io), 'parked');
        assert.equal(p.write(client, 'hi'), 1);
        assert.deepEqual(p.woken.at(-1), { thread: 'p1:main', result: 0 });
        assert.ok(p.events.includes(0x77));
        assert.deepEqual(p.apcs.at(-1)?.args, [9, BLOCK, 0]);
    });

test('describe says of each handle what is at the other end, and when it is gone', ()=>{
    const p = processOn(new Map());
    const server = p.server();
    const client = p.client();
    p.write(client, 'abc');
    p.as('p:reader');
    assert.deepEqual(p.pipes.describe(), [
        `${server} ${NAME} server refs=1 peer=1 state=connected readers=0 unread=3`,
        `${client} ${NAME} client refs=1 peer=1 state=connected readers=0 unread=0`]);
    p.read(server, 3);
    assert.equal(p.read(client, 1), 'parked');
    p.pipes.closed(server, p.handles.get(server)?.object);
    assert.deepEqual(p.pipes.describe(), [
        `${client} ${NAME} client refs=1 peer=0 closed state=connected readers=0 unread=0`],
    'the server gone, the waiting read woken with the pipe broken');
});

test('a handle opened without FILE_FLAG_OVERLAPPED reads as a synchronous call, OVERLAPPED or not',
    ()=>{
        // An OVERLAPPED on a synchronous handle gives its offset and takes its
        // status: the read waits for the bytes and says the count where the
        // call asked, which a program that polls that count waits on.
        const p = processOn(new Map());
        const server = p.server();
        const client = p.client();
        const overlapped = 0x6000;
        p.as('p:reader');
        assert.equal(p.read(server, 1, overlapped), 'parked', 'it waits, not pending');
        p.write(client, 'x');
        assert.deepEqual(p.woken.at(-1), { thread: 'p:reader', result: 1 });
        assert.equal(p.u32(COUNT), 1, 'the count, where the call asked');
        assert.deepEqual([p.u32(overlapped), p.u32(overlapped + 4)], [0, 1],
            'the status and the count in the OVERLAPPED');
        assert.equal(p.text(1), 'x');
    });

/**
 * A process whose CallNamedPipe makes its steps on this module: the client
 * end opened by name, the read mode set, the end closed - each step named, on
 * the caller's thread, as the export a program would call.
 */
function calling(){
    /** @type {string[]} */
    const steps = [];
    let error = 0;
    /** @type {any} */
    let p = null;
    p = processOn(new Map(), 1, {
        call: async(/** @type {string} */ name, /** @type {number[]} */ args,
            /** @type {any} */ thread)=>
        {
            assert.equal(thread, 'p1:main', 'every step on the caller\'s thread');
            steps.push(name);
            switch (name)
            {
                case 'CreateFileA': {
                    const opened = p.pipes.open(NAME, args[1], 0);
                    error = 'handle' in opened ? 0 : opened.error;
                    if ('handle' in opened)
                    {
                        return opened.handle;
                    }
                    return 0xffffffff;
                }
                case 'GetLastError':
                // The open's own refusal, else what the module left the thread.
                    return error || (p.errorOf(thread) ?? 0);
                case 'LocalAlloc':
                    return 0x900;
                case 'LocalFree':
                    return 0;
                case 'CloseHandle':
                    p.pipes.closed(args[0], p.handles.get(args[0])?.object);
                    return 1;
                default:
                    return p.fns[name].handler(args);
            }
        },
    });
    p.putString(NAME_AT, NAME);
    return { p, steps };
}

/** A turn for the steps CallNamedPipe awaits. */
const turn = ()=>new Promise(resolve=>setImmediate(resolve));

test('CallNamedPipe writes its message and waits for the answer, then closes, never parked',
    async()=>{
        // A thread waiting on a host call is no thread a step may park: the
        // transaction's read that waits answers the call when it ends.
        const { p, steps } = calling();
        const server = p.server(PIPE_ACCESS_DUPLEX, PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE);
        p.bytes.set([1, 2, 3, 4], BUFFER + 0x100);
        const answered = p.fns.CallNamedPipeA.handler(
            [NAME_AT, BUFFER + 0x100, 4, BUFFER + 0x200, 4, COUNT, 500]);
        await turn();
        assert.deepEqual(steps, ['CreateFileA', 'LocalAlloc', 'SetNamedPipeHandleState']);
        assert.equal(p.read(server, 4), 1, 'the server reads the message');
        assert.deepEqual([...p.bytes.subarray(BUFFER, BUFFER + 4)], [1, 2, 3, 4]);
        assert.equal(p.write(server, 'wxyz'), 1);
        assert.equal(await answered, 1);
        assert.equal(p.u32(COUNT), 4);
        assert.equal(String.fromCharCode(...p.bytes.subarray(BUFFER + 0x200, BUFFER + 0x204)),
            'wxyz');
        assert.deepEqual(steps.slice(3), ['LocalFree', 'CloseHandle']);
        assert.equal(p.blocked.length, 0, 'never parked');
        assert.equal(p.woken.length, 0, 'nothing wakes a thread the call holds');
    });

test('CallNamedPipe waits for a busy pipe until an instance listens, or its time-out',
    async()=>{
        const { p, steps } = calling();
        const server = p.server(PIPE_ACCESS_DUPLEX, PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE);
        p.client();
        const late = p.fns.CallNamedPipeA.handler([NAME_AT, BUFFER, 1, BUFFER + 8, 4, COUNT, 50]);
        await turn();
        assert.deepEqual(steps, ['CreateFileA', 'GetLastError']);
        assert.equal(p.timers.at(-1)?.due, 50, 'its own time-out, on the guest\'s clock');
        /** @type {any} */ (p.timers.at(-1)).fired();
        assert.equal(await late, 0, 'no instance listened in time');
        assert.equal(p.errorOf('p1:main'), ERROR_SEM_TIMEOUT);

        const listens = p.fns.CallNamedPipeA.handler([NAME_AT, BUFFER, 1, BUFFER + 8, 4, COUNT,
            50]);
        await turn();
        p.fns.DisconnectNamedPipe.handler([server]);
        p.fns.ConnectNamedPipe.handler([server, OVERLAPPED]);
        await turn();
        assert.equal(p.timers.length, 1, 'the second time-out disarmed once an instance listened');
        assert.equal(p.read(server, 1), 1, 'the message came once the client got in');
        assert.equal(p.write(server, 'a'), 1);
        assert.equal(await listens, 1);
        assert.equal(p.blocked.length, 0, 'never parked');
    });

test('a CallNamedPipe step that fails ends it with that step\'s error, the end closed',
    async()=>{
        const { p, steps } = calling();
        assert.equal(await p.fns.CallNamedPipeA.handler([NAME_AT, 0, 0, 0, 0, COUNT, 0]), 0);
        assert.deepEqual(steps, ['CreateFileA', 'GetLastError'], 'no pipe: nothing to close');
        const server = p.server(PIPE_ACCESS_DUPLEX, PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE);
        steps.length = 0;
        // An answer longer than the buffer: the transaction's error, after the close.
        const long = p.fns.CallNamedPipeA.handler([NAME_AT, BUFFER, 1, BUFFER + 8, 2, COUNT, 0]);
        await turn();
        assert.equal(p.read(server, 1), 1);
        assert.equal(p.write(server, 'abc'), 1);
        assert.equal(await long, 0);
        assert.deepEqual(steps.slice(-2), ['LocalFree', 'CloseHandle']);
        assert.equal(p.errorOf('p1:main'), ERROR_MORE_DATA);
    });

test('NtCreateNamedPipeFile makes the instance CreateNamedPipe makes, by its native name', ()=>{
    const STATUS_SUCCESS = 0;
    const STATUS_INSTANCE_NOT_AVAILABLE = 0xc00000ab;
    const STATUS_OBJECT_NAME_NOT_FOUND = 0xc0000034;
    const STATUS_OBJECT_PATH_NOT_FOUND = 0xc000003a;
    const FILE_OPEN = 1;
    const FILE_CREATE = 2;
    const FILE_SYNCHRONOUS_IO_NONALERT = 0x20;
    const OUT = 0x800;
    const IOSB = 0x810;
    const ATTRIBUTES = 0x820;
    const STRING = 0x840;
    const TEXT = 0x880;
    const TIMEOUT = 0x8f0;
    const p = processOn(new Map());
    const create = /** @type {any} */ (p.fns.CreateNamedPipeW).natives.NtCreateNamedPipeFile;
    /** @param {string} name */
    const attributes = name=>{
        p.putWide(TEXT, name);
        p.view.setUint16(STRING, name.length * 2, true);
        p.view.setUint16(STRING + 2, name.length * 2 + 2, true);
        p.view.setUint32(STRING + 4, TEXT, true);
        p.view.setUint32(ATTRIBUTES, 24, true);
        p.view.setUint32(ATTRIBUTES + 8, STRING, true);
        return ATTRIBUTES;
    };
    // -10000 hundred-nanosecond units: a millisecond.
    p.view.setBigInt64(TIMEOUT, -10000n, true);
    /** @param {string} name @param {number} disposition @param {number} [options] */
    const make = (name, disposition, options = 0)=>{
        p.view.setUint32(OUT, 0xdeadbeef, true);
        return create.handler([OUT, RW, attributes(name), IOSB, 3, disposition, options, 0, 0,
            0, 1, 256, 256, TIMEOUT]) >>> 0;
    };

    assert.equal(make('\\??\\PIPE\\test\\pipe', FILE_OPEN), STATUS_OBJECT_NAME_NOT_FOUND,
        'FILE_OPEN asks for a pipe already there');
    assert.equal(p.u32(OUT), 0, 'a refused call leaves no handle');
    assert.equal(make('\\??\\PIPE\\test\\pipe', FILE_CREATE, FILE_SYNCHRONOUS_IO_NONALERT),
        STATUS_SUCCESS);
    const server = p.u32(OUT);
    const entry = p.handles.get(server);
    assert.equal(entry?.type, 'pipe');
    assert.deepEqual([p.u32(IOSB), p.u32(IOSB + 4)], [STATUS_SUCCESS, 2], 'FILE_CREATED');
    assert.equal(entry?.object.overlapped, false, 'a synchronous option makes a synchronous end');
    assert.equal(make('\\??\\PIPE\\TEST\\PIPE', FILE_CREATE), STATUS_INSTANCE_NOT_AVAILABLE,
        'the one instance is made, in any case of the name');
    assert.equal(make('\\Device\\NamedPipe\\test\\pipe', FILE_CREATE),
        STATUS_INSTANCE_NOT_AVAILABLE, 'the device\'s own name is the same pipe');
    assert.equal(make('\\??\\C:\\pipe', FILE_CREATE), STATUS_OBJECT_PATH_NOT_FOUND);

    const opened = p.pipes.open('\\\\.\\pipe\\test\\pipe', GENERIC_READ, 0);
    assert.ok('handle' in opened, 'CreateFile finds it by the Win32 name');
});

test('the pipe device: itself, and its root under which pipes are named and waited for', ()=>{
    const STATUS = { SUCCESS: 0, INVALID_PARAMETER: 0xc000000d, NAME_INVALID: 0xc0000033,
        NAME_NOT_FOUND: 0xc0000034, PIPE_NOT_AVAILABLE: 0xc00000ac,
        ILLEGAL_FUNCTION: 0xc00000af, PIPE_DISCONNECTED: 0xc00000b0,
        NOT_SUPPORTED: 0xc00000bb, IO_TIMEOUT: 0xc00000b5 };
    const FILE_OPEN = 1;
    const FILE_CREATE = 2;
    const FILE_SYNCHRONOUS_IO_NONALERT = 0x20;
    const OUT = 0x800;
    const ATTRIBUTES = 0x820;
    const STRING = 0x840;
    const TEXT = 0x880;
    const WAIT = 0x900;
    assert.equal(pipeDeviceOf('\\Device\\NamedPipe'), 'device');
    assert.equal(pipeDeviceOf('\\??\\PIPE'), 'device', 'its link');
    assert.equal(pipeDeviceOf('\\Device\\NamedPipe\\'), 'root');
    assert.equal(pipeDeviceOf('\\??\\pipe\\'), 'root');
    assert.equal(pipeDeviceOf('\\Device\\NamedPipe\\a'), null, 'a pipe\'s name');

    const p = processOn(new Map());
    const create = /** @type {any} */ (p.fns.CreateNamedPipeW).natives.NtCreateNamedPipeFile;
    /** @param {number} root @param {string} name */
    const attributes = (root, name)=>{
        p.putWide(TEXT, name);
        p.view.setUint16(STRING, name.length * 2, true);
        p.view.setUint16(STRING + 2, name.length * 2 + 2, true);
        p.view.setUint32(STRING + 4, name === '' ? 0 : TEXT, true);
        p.view.setUint32(ATTRIBUTES, 24, true);
        p.view.setUint32(ATTRIBUTES + 4, root, true);
        p.view.setUint32(ATTRIBUTES + 8, STRING, true);
        return ATTRIBUTES;
    };
    /** @param {number} root @param {string} name @param {number} [disposition] */
    const make = (root, name, disposition = FILE_CREATE)=>{
        const status = create.handler([OUT, RW, attributes(root, name), 0, 3, disposition,
            FILE_SYNCHRONOUS_IO_NONALERT, 0, 0, 0, 3, 256, 256, 0]) >>> 0;
        return { status, handle: p.u32(OUT) };
    };
    /** @param {number} root @param {string} name */
    const open = (root, name)=>/** @type {any} */ (p.pipes.nativeOpen({ root, name }, RW, 0x20,
        FILE_OPEN));

    const device = /** @type {any} */ (open(0, '\\Device\\NamedPipe')).handle;
    const root = /** @type {any} */ (open(0, '\\Device\\NamedPipe\\')).handle;
    assert.ok(device && root, 'both open as handles of their own');
    assert.equal(make(device, 'test3\\pipe').status, STATUS.NAME_INVALID,
        'the device names nothing under it');
    assert.equal(/** @type {any} */ (p.pipes.nativeOpen({ root: device, name: '' }, RW, 0x20,
        FILE_CREATE))?.status, STATUS.INVALID_PARAMETER, 'only an open of what is there');

    // Under the root a name is a pipe's, the Win32 name's pipe.
    const named = make(root, 'test3\\pipe');
    assert.equal(named.status, STATUS.SUCCESS);
    assert.ok('handle' in p.pipes.open('\\\\.\\pipe\\test3\\pipe', GENERIC_READ, 0));
    assert.equal(p.pipes.objectName(named.handle), '\\Device\\NamedPipe\\test3\\pipe');

    // No name under the root is a pipe of its own: none opens it by name, and
    // its server's own empty name opens its client, once.
    const unnamed = make(root, '');
    assert.equal(unnamed.status, STATUS.SUCCESS);
    assert.equal(p.pipes.objectName(unnamed.handle), null, 'no name to spell');
    assert.equal(make(root, '', FILE_OPEN).status, STATUS.NAME_NOT_FOUND);
    assert.ok('handle' in /** @type {any} */ (open(unnamed.handle, '')), 'its own client');
    assert.equal(open(unnamed.handle, '')?.status, STATUS.PIPE_NOT_AVAILABLE, 'taken');
    assert.equal(open(unnamed.handle, 'a')?.status, STATUS.NAME_INVALID);

    // The device carries no bytes, and its controls are none of an end's.
    assert.equal(p.pipes.read(device, 0x1000, 4, 0, true), STATUS.INVALID_PARAMETER);
    assert.equal(p.pipes.write(root, 0x1000, 4, 0, true), STATUS.INVALID_PARAMETER);
    /** @param {number} handle @param {number} code */
    const control = (handle, code)=>/** @type {any} */ (p.pipes.control(handle, code, 0, 0))
        .status >>> 0;
    assert.equal(control(device, 0x110000), STATUS.NOT_SUPPORTED, 'FSCTL_PIPE_ASSIGN_EVENT');
    assert.equal(control(device, 0x110004), STATUS.PIPE_DISCONNECTED, 'FSCTL_PIPE_DISCONNECT');
    assert.equal(control(root, 0x110008), STATUS.ILLEGAL_FUNCTION, 'FSCTL_PIPE_LISTEN');
    assert.equal(control(device, 0x11400c), STATUS.INVALID_PARAMETER, 'FSCTL_PIPE_PEEK');

    // FSCTL_PIPE_WAIT: no function of the device; under the root, by name.
    /** @param {number} handle @param {string} name */
    const wait = (handle, name)=>{
        p.view.setBigInt64(WAIT, 0n, true);
        p.view.setUint32(WAIT + 8, name.length * 2, true);
        p.view.setUint8(WAIT + 12, 1);
        p.putWide(WAIT + 14, name);
        return /** @type {any} */ (p.pipes.control(handle, 0x110018, 0, 0, 0, undefined, WAIT,
            14 + name.length * 2)).status >>> 0;
    };
    assert.equal(wait(device, 'nonexistent_pipe'), STATUS.ILLEGAL_FUNCTION);
    assert.equal(wait(root, 'nonexistent_pipe'), STATUS.NAME_NOT_FOUND);
    assert.equal(wait(root, 'test3\\pipe'), STATUS.IO_TIMEOUT, 'none listens, no time to wait');
    assert.equal(make(root, 'test3\\pipe', FILE_OPEN).status, STATUS.SUCCESS);
    assert.equal(wait(root, 'TEST3\\PIPE'), STATUS.SUCCESS, 'an instance listens, in any case');
});

test('NtCreateNamedPipeFile: the sharing is the direction, the access the server\'s rights', ()=>{
    const STATUS_INVALID_PARAMETER = 0xc000000d;
    const FILE_CREATE = 2;
    const FILE_SHARE_READ = 1;
    const FILE_SHARE_WRITE = 2;
    const FILE_READ_ATTRIBUTES = 0x80;
    const SYNCHRONIZE = 0x00100000;
    const OUT = 0x800;
    const ATTRIBUTES = 0x820;
    const STRING = 0x840;
    const TEXT = 0x880;
    const p = processOn(new Map());
    const create = /** @type {any} */ (p.fns.CreateNamedPipeW).natives.NtCreateNamedPipeFile;
    const name = '\\??\\pipe\\winetestpipe';
    p.putWide(TEXT, name);
    p.view.setUint16(STRING, name.length * 2, true);
    p.view.setUint32(STRING + 4, TEXT, true);
    p.view.setUint32(ATTRIBUTES, 24, true);
    p.view.setUint32(ATTRIBUTES + 8, STRING, true);
    /** @param {number} access @param {number} share */
    const make = (access, share)=>create.handler([OUT, access, ATTRIBUTES, 0, share,
        FILE_CREATE, 0, 0, 0, 0, 1, 500, 500, 0]) >>> 0;

    assert.equal(make(FILE_READ_ATTRIBUTES, 0), STATUS_INVALID_PARAMETER,
        'no sharing: no way for bytes to go');
    // Clients may read: an outbound pipe, made by a server asking no data rights.
    assert.equal(make(FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_SHARE_READ), 0);
    const server = p.u32(OUT);
    assert.equal(p.handles.get(server)?.access, FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        'the server handle holds what it asked, mapped');
    assert.equal(p.client(GENERIC_WRITE), -5, 'a client may not write an outbound pipe');
    assert.ok(p.client(GENERIC_READ) > 0);
    p.fns.CloseHandle?.handler([server]);

    const inbound = processOn(new Map());
    const inboundCreate = /** @type {any} */ (inbound.fns.CreateNamedPipeW).natives
        .NtCreateNamedPipeFile;
    inbound.putWide(TEXT, name);
    inbound.view.setUint16(STRING, name.length * 2, true);
    inbound.view.setUint32(STRING + 4, TEXT, true);
    inbound.view.setUint32(ATTRIBUTES, 24, true);
    inbound.view.setUint32(ATTRIBUTES + 8, STRING, true);
    assert.equal(inboundCreate.handler([OUT, GENERIC_READ, ATTRIBUTES, 0, FILE_SHARE_WRITE,
        FILE_CREATE, 0, 0, 0, 0, 1, 500, 500, 0]) >>> 0, 0);
    assert.equal(inbound.client(GENERIC_READ), -5, 'a client may not read an inbound pipe');
    assert.ok(inbound.client(GENERIC_WRITE) > 0);
});

test('a pipe end answers its information classes, and FilePipeInformation is set', ()=>{
    const STATUS_ACCESS_DENIED = 0xc0000022;
    const STATUS_INVALID_PARAMETER = 0xc000000d;
    const STATUS_PIPE_DISCONNECTED = 0xc00000b0;
    const FILE_NAME_INFORMATION = 9;
    const FILE_PIPE_INFORMATION = 23;
    const FILE_PIPE_LOCAL_INFORMATION = 24;
    const FILE_READ_ATTRIBUTES = 0x80;
    const FILE_WRITE_ATTRIBUTES = 0x100;
    const p = processOn(new Map());
    // CreateNamedPipe's server end: outbound and inbound, so GENERIC_READ and _WRITE.
    const server = p.fns.CreateNamedPipeA.handler([p.putString(NAME_AT, NAME),
        PIPE_ACCESS_DUPLEX, PIPE_TYPE_MESSAGE, 1, 200, 100, 0, 0]) >>> 0;
    /** @param {Uint8Array | { status: number } | null} got */
    const words = got=>{
        assert.ok(got instanceof Uint8Array);
        const view = new DataView(got.buffer);
        return Array.from({ length: got.length / 4 }, (_, at)=>view.getUint32(at * 4, true));
    };
    // Type, configuration, instances, current, inbound quota, readable,
    // outbound quota, room to write, state (listening), the server end.
    assert.deepEqual(words(p.pipes.information(server, FILE_PIPE_LOCAL_INFORMATION)),
        [1, 2, 1, 1, 100, 0, 200, 200, 2, 1]);
    const client = p.client(RW);
    p.write(client, 'abc');
    assert.deepEqual(words(p.pipes.information(client, FILE_PIPE_LOCAL_INFORMATION)),
        [1, 2, 1, 1, 100, 0, 200, 97, 3, 0], 'connected; the client\'s write takes room');
    assert.deepEqual(words(p.pipes.information(server, FILE_PIPE_LOCAL_INFORMATION)).slice(5, 6),
        [3], 'the server may read it');
    const name = /** @type {Uint8Array} */ (p.pipes.information(client, FILE_NAME_INFORMATION));
    assert.equal(new DataView(name.buffer).getUint32(0, true), '\\winetestpipe'.length * 2);
    assert.equal(String.fromCharCode(...new Uint16Array(name.buffer.slice(4))), '\\winetestpipe');

    // FILE_PIPE_INFORMATION: read mode, completion mode.
    p.view.setUint32(BUFFER, 1, true);
    p.view.setUint32(BUFFER + 4, 1, true);
    assert.equal(p.pipes.setInformation(client, FILE_PIPE_INFORMATION, BUFFER, 8), 0);
    assert.deepEqual(words(p.pipes.information(client, FILE_PIPE_INFORMATION)), [1, 1]);
    p.view.setUint32(BUFFER, 2, true);
    assert.equal(p.pipes.setInformation(client, FILE_PIPE_INFORMATION, BUFFER, 8),
        STATUS_INVALID_PARAMETER, 'a mode past 1');

    // An end without the attribute rights is refused them; a byte pipe reads no messages.
    const bytes = processOn(new Map());
    const reader = bytes.fns.CreateNamedPipeA.handler([bytes.putString(NAME_AT, NAME),
        PIPE_ACCESS_DUPLEX, 0, 1, 0, 0, 0, 0]) >>> 0;
    const bare = bytes.pipes.open(NAME, 0x00100000, 0);
    assert.ok('handle' in bare);
    assert.deepEqual(bytes.pipes.information(bare.handle, FILE_PIPE_LOCAL_INFORMATION),
        { status: STATUS_ACCESS_DENIED }, 'no FILE_READ_ATTRIBUTES');
    assert.ok(bytes.pipes.information(bare.handle, FILE_NAME_INFORMATION) instanceof Uint8Array,
        'the name needs no right');
    bytes.view.setUint32(BUFFER, 0, true);
    assert.equal(bytes.fns.SetNamedPipeHandleState.handler([bare.handle, BUFFER, 0, 0]), 0,
        'the Win32 set needs FILE_WRITE_ATTRIBUTES as the native one does');
    assert.equal(bytes.error(), 5, 'ERROR_ACCESS_DENIED');
    const allowed = bytes.handles.get(reader);
    assert.ok(allowed && (allowed.access ?? 0xffffffff) & FILE_WRITE_ATTRIBUTES);
    bytes.view.setUint32(BUFFER, 1, true);
    bytes.view.setUint32(BUFFER + 4, 0, true);
    assert.equal(bytes.pipes.setInformation(reader, FILE_PIPE_INFORMATION, BUFFER, 8),
        STATUS_INVALID_PARAMETER, 'message reading of a byte pipe');
    assert.equal(bytes.fns.DisconnectNamedPipe.handler([reader]), 1);
    assert.equal(bytes.fns.ConnectNamedPipe.handler([reader, 0]), 'parked');
    const asked = bytes.pipes.open(NAME, FILE_READ_ATTRIBUTES, 0);
    assert.ok('handle' in asked);
    assert.equal(bytes.fns.DisconnectNamedPipe.handler([reader]), 1);
    assert.deepEqual(bytes.pipes.information(asked.handle, FILE_PIPE_INFORMATION),
        { status: STATUS_PIPE_DISCONNECTED }, 'a client cut off');
    assert.equal(bytes.pipes.information(0x7777, FILE_PIPE_INFORMATION), null, 'no pipe end');
});

test('an OVERLAPPED\'s event is reset as each operation on it begins', ()=>{
    // One manual-reset event for a connect, a read and a write (Wine's
    // serverThreadMain3): the wait after the read found it still set by the
    // connect and went on before the read had finished.
    const p = processOn(new Map());
    const server = p.server(PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED);
    p.view.setUint32(OVERLAPPED + 16, 0x88, true);
    assert.equal(p.fns.ConnectNamedPipe.handler([server, OVERLAPPED]), 0);
    assert.deepEqual(p.resets, [0x88], 'the connect');
    const client = p.client();
    assert.equal(p.read(server, 10, OVERLAPPED), 0);
    assert.equal(p.error(), ERROR_IO_PENDING);
    assert.deepEqual(p.resets, [0x88, 0x88], 'and the read');
    p.write(client, 'ping');
    p.view.setUint32(OVERLAPPED + 0x40 + 16, 0x8c, true);
    assert.equal(p.write(server, 'pong', OVERLAPPED + 0x40), 1);
    assert.deepEqual(p.resets, [0x88, 0x88, 0x8c], 'and the write, done at once and set after');
    assert.equal(p.events.at(-1), 0x8c);
});

test('a server cut from its client: a second disconnect and a peek are refused', ()=>{
    const p = processOn(new Map());
    const server = p.server();
    const client = p.client();
    p.write(client, 'waiting');
    assert.equal(p.fns.DisconnectNamedPipe.handler([server]), 1);
    assert.equal(p.fns.DisconnectNamedPipe.handler([server]), 0);
    assert.equal(p.error(), ERROR_PIPE_NOT_CONNECTED, 'no client to cut off again');
    assert.equal(p.pipes.peek([server, 0, 0, 0, COUNT, 0]), 0);
    assert.equal(p.error(), ERROR_BAD_PIPE, 'the server end is in no state to peek');
    assert.equal(p.pipes.peek([client, 0, 0, 0, COUNT, 0]), 0);
    assert.equal(p.error(), ERROR_PIPE_NOT_CONNECTED, 'the client end merely not connected');
});

test('a second instance takes the pipe\'s type and count; only its direction must agree', ()=>{
    const p = processOn(new Map());
    const first = p.server(PIPE_ACCESS_DUPLEX, 0, 4);
    assert.ok(first > 0);
    assert.notEqual(p.server(PIPE_ACCESS_DUPLEX, PIPE_TYPE_MESSAGE, 3), 0xffffffff,
        'a message instance of a byte pipe, three of four');
    assert.equal(p.server(PIPE_ACCESS_INBOUND, 0, 4), 0xffffffff);
    assert.equal(p.error(), ERROR_ACCESS_DENIED);
});

test('ReadFileEx and WriteFileEx on a pipe queue their routine, at once or when the bytes come',
    ()=>{
        const p = processOn(new Map());
        const server = p.server(PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED);
        const client = p.client(RW, FILE_FLAG_OVERLAPPED);
        p.view.setUint32(OVERLAPPED + 16, 0x88, true);
        assert.equal(p.pipes.readEx(server, BUFFER, 10, OVERLAPPED, 0x4000), 1, 'begun');
        assert.equal(p.u32(OVERLAPPED), STATUS_PENDING);
        assert.deepEqual(p.apcs, [], 'nothing yet');
        p.write(client, 'ping');
        assert.deepEqual(p.apcs,
            [{ thread: 'p1:main', routine: 0x4000, args: [0, 4, OVERLAPPED] }]);
        assert.equal(p.text(4), 'ping');
        assert.deepEqual(p.events, [], 'the event is the program\'s own');
        assert.deepEqual(p.resets, [], 'and left alone');

        p.bytes.set([0x61, 0x62], BUFFER + 0x800);
        assert.equal(p.pipes.writeEx(client, BUFFER + 0x800, 2, OVERLAPPED + 0x40, 0x4004), 1);
        assert.deepEqual(p.apcs.at(-1),
            { thread: 'p1:main', routine: 0x4004, args: [0, 2, OVERLAPPED + 0x40] },
            'a write done at once still queues its routine');
        assert.equal(p.pipes.readEx(server, BUFFER, 10, OVERLAPPED, 0x4000), 1);
        assert.deepEqual(/** @type {any} */ (p.apcs.at(-1))?.args, [0, 2, OVERLAPPED],
            'bytes there: queued at once');
        assert.equal(p.pipes.readEx(0x9999, BUFFER, 10, OVERLAPPED, 0x4000), null, 'no pipe');
    });

test('CancelSynchronousIo ends the read or connect a thread waits in, not an overlapped one',
    ()=>{
        const p = processOn(new Map());
        const server = p.server();
        p.as('p1:connecting');
        assert.equal(p.fns.ConnectNamedPipe.handler([server, 0]), 'parked');
        assert.equal(p.pipes.cancelSynchronous('p1:other'), 0, 'another thread waits in nothing');
        assert.equal(p.pipes.cancelSynchronous('p1:connecting'), 1);
        assert.equal(p.errorOf('p1:connecting'), ERROR_OPERATION_ABORTED);

        const async = processOn(new Map());
        const pending = async.server(PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED);
        assert.equal(async.fns.ConnectNamedPipe.handler([pending, OVERLAPPED]), 0);
        assert.equal(async.pipes.cancelSynchronous('p1:main'), 0, 'an overlapped wait is not');
    });

test('a server end knows its client once it has read from it; its computer name is local',
    ()=>{
        const p = processOn(new Map());
        const server = p.server();
        const clientOf = /** @type {any} */ (p.pipes.functions)[PIPE_CLIENT];
        assert.equal(clientOf(server), 'unknown', 'no client yet');
        const client = p.client();
        assert.equal(clientOf(client), 'none', 'a client end has no client');
        p.write(client, 'hello');
        assert.equal(clientOf(server), 'unknown', 'written, not yet read');
        assert.equal(p.read(server, 10), 1);
        assert.equal(clientOf(server), 'client');

        assert.equal(p.fns.GetNamedPipeClientComputerNameA.handler([server, 0, 0]), 0);
        assert.equal(p.error(), ERROR_INSUFFICIENT_BUFFER);
        assert.equal(p.fns.GetNamedPipeClientComputerNameW.handler([server, BUFFER, 10]), 0);
        assert.equal(p.error(), ERROR_PIPE_LOCAL);
        assert.equal(p.fns.GetNamedPipeServerSessionId.handler([client, COUNT]), 1);
        assert.equal(p.u32(COUNT), 1, 'the interactive session');
    });

/**
 * A pipe made as Wine's test_blocking_rw makes it: the server's output 5000
 * bytes, its input 6000, overlapped ends - and calls with buffers of their own,
 * clear of the harness's.
 *
 * @param {number} [pipeMode]
 */
function bounded(pipeMode = 0){
    const p = processOn(new Map());
    const server = p.fns.CreateNamedPipeA.handler([p.putString(NAME_AT, NAME),
        PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED, pipeMode, 1, 5000, 6000, 0, 0]) >>> 0;
    const client = p.client(RW, FILE_FLAG_OVERLAPPED);
    const DATA = 0x3000;
    const READ = 0x8000;
    return {
        p, server, client,
        /** @param {number} handle @param {number} count @param {number} [overlapped] */
        write: (handle, count, overlapped = 0)=>p.pipes.write(handle, DATA, count, COUNT + 4,
            false, overlapped),
        /** @param {number} handle @param {number} count @param {number} [overlapped] */
        read: (handle, count, overlapped = 0)=>p.pipes.read(handle, READ, count, COUNT, false,
            overlapped),
        /** What a peek at an end sees waiting. @param {number} handle */
        waiting: handle=>{
            p.pipes.peek([handle, 0, 0, 0, STATE, 0]);
            return p.u32(STATE);
        },
        /** An OVERLAPPED's status and count. @param {number} at */
        result: at=>[p.u32(at), p.u32(at + 4)],
    };
}

const W1 = 0x2a00;
const W2 = 0x2a40;
const R1 = 0x2a80;
const STATUS_PIPE_BROKEN = 0xc000014b;
const STATUS_PIPE_DISCONNECTED = 0xc00000b0;

test('FSCTL_PIPE_TRANSCEIVE writes a message and reads the answer through its block', ()=>{
    const TRANSCEIVE = 0x11c017;
    const STATUS_INVALID_PIPE_STATE = 0xc00000ad;
    const STATUS_PIPE_BUSY = 0xc00000ae;
    const STATUS_INVALID_READ_MODE = 0xc00000b4;
    const BLOCK = 0x9000;
    const { p, server, client, write, read } = bounded(PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE);
    p.view.setUint32(STATE, PIPE_READMODE_MESSAGE, true);
    assert.equal(p.fns.SetNamedPipeHandleState.handler([client, STATE, 0, 0]), 1);
    const io = { event: 0, apc: 0, context: 0 };
    /** @param {number} handle */
    const transceive = handle=>p.pipes.control(handle, TRANSCEIVE, 0x8100, 64, BLOCK, io,
        0x3000, 4);
    // The client's end is overlapped: no answer yet, the request pends.
    assert.deepEqual(transceive(client), { status: STATUS_PENDING, information: 0 });
    assert.equal(read(server, 10), 1);
    assert.equal(p.u32(COUNT), 4, 'the message went whole');
    assert.equal(write(server, 2), 1);
    assert.deepEqual([p.u32(BLOCK), p.u32(BLOCK + 4)], [0, 2], 'the answer, through the block');

    // An answer already waiting makes the pipe busy, before anything is written.
    assert.equal(write(server, 1), 1);
    assert.deepEqual(transceive(client), { status: STATUS_PIPE_BUSY, information: 0 });
    // A pipe read as bytes has no transaction.
    const bytes = bounded(PIPE_TYPE_MESSAGE);
    assert.equal(/** @type {any} */ (bytes.p.pipes.control(bytes.client, TRANSCEIVE, 0x8100, 64,
        BLOCK, io, 0x3000, 4)).status, STATUS_INVALID_READ_MODE);
    // A server whose client is gone is in no state for one.
    const lone = bounded(PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE);
    lone.p.pipes.closed(lone.client, lone.p.handles.get(lone.client)?.object);
    assert.equal(/** @type {any} */ (lone.p.pipes.control(lone.server, TRANSCEIVE, 0x8100, 64,
        BLOCK, io, 0x3000, 4)).status, STATUS_INVALID_PIPE_STATE);
});

test('a pipe end\'s FileStandardInformation: its quotas, what it may read, a deletion pending;'
    + ' a listening server is in no state to be peeked at', ()=>{
    const { p, server, client, write } = bounded();
    assert.equal(write(server, 7), 1);
    const record = /** @type {Uint8Array} */ (p.pipes.information(client, 5));
    const view = new DataView(record.buffer);
    assert.equal(Number(view.getBigUint64(0, true)), 5000 + 6000, 'the two quotas');
    assert.equal(Number(view.getBigUint64(8, true)), 7, 'the bytes waiting for it');
    assert.deepEqual([view.getUint32(16, true), record[20], record[21]], [1, 1, 0]);

    const fresh = processOn(new Map());
    const listening = fresh.fns.CreateNamedPipeA.handler([fresh.putString(NAME_AT, NAME),
        PIPE_ACCESS_DUPLEX, 0, 1, 512, 512, 0, 0]) >>> 0;
    assert.deepEqual(fresh.pipes.control(listening, 0x11400c, 0x9000, 64),
        { status: 0xc00000ad, information: 0 }, 'STATUS_INVALID_PIPE_STATE');
});

test('a write waits until what is queued up to its end fits the pipe\'s buffer, in order', ()=>{
    const { p, server, client, write, read, waiting, result } = bounded();
    // A read waiting takes its part, and the rest of the write fits.
    assert.equal(read(client, 1000, R1), 0);
    assert.equal(write(server, 4000, W1), 1);
    assert.deepEqual(result(R1), [0, 1000]);
    assert.equal(waiting(client), 3000);

    // 3000 queued and 5000 more do not fit the server's 5000: it pends, a
    // peek sees its bytes all the same, and a write behind it waits too.
    assert.equal(write(server, 5000, W1), 0);
    assert.equal(p.error(), ERROR_IO_PENDING);
    assert.equal(write(server, 1, W2), 0);
    assert.equal(waiting(client), 8001);
    assert.equal(write(server, 0, 0x2ac0), 1, 'a write of nothing does not wait');

    // Read the first write's rest: the second fits now, the third not yet.
    assert.equal(read(client, 3000), 1);
    assert.deepEqual(result(W1), [0, 5000]);
    assert.equal(p.u32(W2), STATUS_PENDING);
    assert.equal(read(client, 1), 1);
    assert.deepEqual(result(W2), [0, 1]);
    assert.equal(waiting(client), 5000);
    assert.equal(read(client, 5000), 1);

    // The client's writes are held to the server's input size, 6000.
    assert.equal(write(client, 6000, W1), 1);
    assert.equal(write(client, 1, W2), 0);
    assert.equal(read(server, 6000), 1);
    assert.deepEqual(result(W2), [0, 1]);
});

test('a write too big for the buffer finishes when what is left of it fits; a synchronous one'
    + ' parks', ()=>{
    const { p, server, client, write, read, result } = bounded();
    assert.equal(write(server, 7000, W1), 0);
    assert.equal(read(client, 1999), 1);
    assert.equal(p.u32(W1), STATUS_PENDING, '5001 left');
    assert.equal(read(client, 1), 1);
    assert.deepEqual(result(W1), [0, 7000]);
    assert.equal(read(client, 5000), 1);

    p.as('p1:writer');
    assert.equal(write(server, 6000), 'parked');
    assert.equal(p.blocked.at(-1).reason, 'pipe write');
    p.as('p1:reader');
    assert.equal(read(client, 1000), 1);
    assert.deepEqual(p.woken.at(-1), { thread: 'p1:writer', result: 1 });
    assert.equal(p.u32(COUNT + 4), 6000, 'the count where the parked write asked it');
});

test('a waiting write is cancelled with what was not read of it; the next one fits', ()=>{
    const { p, server, client, write, read, waiting, result } = bounded();
    assert.equal(write(server, 7000, W1), 0);
    assert.equal(write(server, 1, W2), 0);
    assert.equal(read(client, 10), 1);
    assert.equal(p.pipes.cancel(server, { overlapped: W1 }), 1);
    assert.deepEqual(result(W1), [STATUS_CANCELLED, 10]);
    assert.deepEqual(result(W2), [0, 1], 'what is behind it fits now');
    assert.equal(waiting(client), 1);
});

test('a flush waits for the reader to take everything; a closed or cut reader fails what waits',
    ()=>{
        const { p, server, client, write, read } = bounded();
        assert.equal(p.pipes.flush(server), 1, 'nothing written, nothing to wait for');
        assert.equal(write(server, 100), 1);
        p.as('p1:flusher');
        assert.equal(p.pipes.flush(server), 'parked');
        p.as('p1:main');
        assert.equal(read(client, 50), 1);
        assert.equal(p.woken.some(one=>one.thread === 'p1:flusher'), false);
        assert.equal(read(client, 50), 1);
        assert.deepEqual(p.woken.at(-1), { thread: 'p1:flusher', result: 1 });

        // The reader closes: the write waiting for it finds the pipe broken.
        assert.equal(write(server, 7000, W1), 0);
        p.pipes.closed(client, p.handles.get(client)?.object);
        assert.equal(p.u32(W1), STATUS_PIPE_BROKEN);

        // Disconnected: both ways' waiting writes are not connected.
        const again = bounded();
        assert.equal(again.write(again.client, 7000, W1), 0);
        assert.equal(again.write(again.server, 7000, W2), 0);
        assert.equal(again.p.fns.DisconnectNamedPipe.handler([again.server]), 1);
        assert.equal(again.p.u32(W1), STATUS_PIPE_DISCONNECTED);
        assert.equal(again.p.u32(W2), STATUS_PIPE_DISCONNECTED);
    });

test('a handle that does not wait never waits to write: whole, what a reader takes, or nothing',
    ()=>{
        for (const messages of [false, true])
        {
            const p = processOn(new Map());
            const server = p.fns.CreateNamedPipeA.handler([p.putString(NAME_AT, NAME),
                PIPE_ACCESS_DUPLEX, PIPE_NOWAIT | (messages ? PIPE_TYPE_MESSAGE : 0), 1, 512,
                512, 0, 0]) >>> 0;
            const client = p.client(GENERIC_READ, FILE_FLAG_OVERLAPPED);
            /** @param {number} count */
            const write = count=>{
                assert.equal(p.pipes.write(server, 0x3000, count, COUNT + 4, false, 0), 1);
                return p.u32(COUNT + 4);
            };
            assert.equal(write(513), 0, 'one byte past the buffer: nothing');
            assert.equal(write(512), 512, 'the buffer whole');
            assert.equal(p.pipes.read(client, 0x8000, 1000, COUNT, false, 0), 1);
            assert.equal(p.pipes.read(client, 0x8000, 1, COUNT, false, R1), 0, 'a reader waits');
            assert.equal(write(513), 513, 'the reader takes one, the rest fits');
            assert.equal(p.pipes.read(client, 0x8000, 1000, COUNT, false, 0), 1);
            assert.equal(p.pipes.read(client, 0x8000, 1, COUNT, false, R1), 0);
            assert.equal(write(514), messages ? 0 : 1,
                'a byte pipe writes what the reader took; a message goes whole or not at all');
        }
    });

test('a transaction with an answer already waiting is refused before it writes', ()=>{
    const { p, server, client, write } = bounded(PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE);
    p.view.setUint32(STATE, PIPE_READMODE_MESSAGE, true);
    assert.equal(p.fns.SetNamedPipeHandleState.handler([client, STATE, 0, 0]), 1);
    assert.equal(write(server, 1), 1);
    assert.equal(p.fns.TransactNamedPipe.handler([client, 0x3000, 2, 0x8000, 1, COUNT, R1]), 0);
    assert.equal(p.error(), ERROR_PIPE_BUSY);
    assert.equal(p.pipes.read(server, 0x8000, 10, COUNT, false, R1), 0, 'nothing was written');
});

test('a process that ends takes its waiting write out of the pipe, unanswered', ()=>{
    const table = new Map();
    const parent = processOn(table, 1);
    const server = parent.fns.CreateNamedPipeA.handler([parent.putString(NAME_AT, NAME),
        PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED, 0, 1, 512, 512, 0, 0]) >>> 0;
    const child = processOn(table, 2);
    const client = child.client();
    assert.equal(child.pipes.write(client, 0x3000, 2000, COUNT + 4, false, 0), 'parked');
    assert.equal(parent.pipes.read(server, 0x8000, 10, COUNT, false, 0), 1);
    child.pipes.processEnded();
    assert.equal(child.woken.length, 0, 'nobody is left to answer');
    assert.equal(parent.pipes.read(server, 0x8000, 10, COUNT, false, OVERLAPPED), 0,
        'the rest of its write is gone');
});

test('a peek sees a message pipe\'s front message whatever the end reads in; FSCTL_PIPE_PEEK'
    + ' says the same', ()=>{
    const PEEK = 0x9000;
    for (const messages of [false, true])
    {
        const { p, server, client, write } = bounded(messages ? PIPE_TYPE_MESSAGE : 0);
        assert.equal(write(server, 20), 1);
        assert.equal(write(server, 15), 1);
        assert.equal(p.pipes.peek([client, 0x8000, 1000, COUNT, STATE, R1]), 1);
        assert.equal(p.u32(COUNT), messages ? 20 : 35, 'a byte read still peeks one message');
        assert.equal(p.u32(STATE), 35);
        // What is left of the message: its length less the copy, below zero
        // on a byte pipe, as Windows' PeekNamedPipe computes it.
        assert.equal(p.u32(R1), messages ? 0 : (-35 >>> 0));

        const answer = p.pipes.control(client, 0x11400c, PEEK, 16 + 1000);
        assert.deepEqual(answer, { status: 0, information: 16 + (messages ? 20 : 35) });
        assert.deepEqual([p.u32(PEEK), p.u32(PEEK + 4), p.u32(PEEK + 8), p.u32(PEEK + 12)],
            [3, 35, messages ? 2 : 0, messages ? 20 : 0]);
        assert.deepEqual(p.pipes.control(client, 0x11400c, PEEK, 16 + 1),
            { status: messages ? STATUS_BUFFER_OVERFLOW : 0, information: 17 },
            'a message cut short overflows; a byte pipe\'s peek takes what fits');
        assert.deepEqual(p.pipes.control(client, 0x11400c, PEEK, 15),
            { status: 0xc0000023, information: 0 },
            'no room for the head: STATUS_BUFFER_TOO_SMALL');
    }
});

test('a pipe made with buffer sizes of 0 holds the default, 4096 bytes, each way', ()=>{
    const p = processOn(new Map());
    const server = p.fns.CreateNamedPipeA.handler([p.putString(NAME_AT, NAME),
        PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED, 0, 1, 0, 0, 0, 0]) >>> 0;
    const client = p.client(RW, FILE_FLAG_OVERLAPPED);
    assert.equal(p.pipes.write(client, 0x3000, 4096, COUNT, false, W1), 1);
    assert.equal(p.pipes.write(client, 0x3000, 1, COUNT, false, W2), 0, 'the 4097th waits');
    assert.equal(p.pipes.write(server, 0x3000, 4096, COUNT, false, R1), 1);
    assert.equal(p.fns.GetNamedPipeInfo.handler([server, 0, STATE, STATE + 4, 0]), 1);
    assert.deepEqual([p.u32(STATE), p.u32(STATE + 4)], [0, 0], 'the sizes asked are answered');
});

test('FSCTL_PIPE_LISTEN is ConnectNamedPipe, native: pending on an overlapped end, cancelled by'
    + ' its block', ()=>{
    const FSCTL_PIPE_LISTEN = 0x110008;
    const FSCTL_PIPE_DISCONNECT = 0x110004;
    const IOSB = 0x2b00;
    const p = processOn(new Map());
    const server = p.server(PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED);
    const io = { event: 0x77, apc: 0, context: 0x55 };
    assert.deepEqual(p.pipes.control(server, FSCTL_PIPE_LISTEN, 0, 0, IOSB, io),
        { status: STATUS_PENDING, information: 0 });
    assert.equal(p.pipes.cancel(server, { block: 0x9999 }), 0, 'another block: nothing');
    assert.equal(p.pipes.cancel(server, { block: IOSB }), 1);
    assert.deepEqual([p.u32(IOSB), p.u32(IOSB + 4)], [STATUS_CANCELLED, 0]);
    assert.ok(p.events.includes(0x77), 'its event set');

    assert.deepEqual(p.pipes.control(server, FSCTL_PIPE_LISTEN, 0, 0, IOSB, io),
        { status: STATUS_PENDING, information: 0 });
    p.client();
    assert.deepEqual([p.u32(IOSB), p.u32(IOSB + 4)], [0, 0], 'the client came: connected');
    assert.deepEqual(p.pipes.control(server, FSCTL_PIPE_LISTEN, 0, 0, IOSB, io),
        { status: 0xc00000b2, information: 0 }, 'STATUS_PIPE_CONNECTED');
    assert.deepEqual(p.pipes.control(server, FSCTL_PIPE_DISCONNECT, 0, 0, IOSB, io),
        { status: 0, information: 0 });
    assert.deepEqual(p.pipes.control(server, FSCTL_PIPE_DISCONNECT, 0, 0, IOSB, io),
        { status: 0xc00000b0, information: 0 }, 'cut off already: STATUS_PIPE_DISCONNECTED');
});

test('a listen on an alerting synchronous end is cancelled by a routine queued to the thread;'
    + ' a client end may not listen', ()=>{
    const STATUS_ILLEGAL_FUNCTION = 0xc00000af;
    const FILE_CREATE = 2;
    const FILE_SYNCHRONOUS_IO_ALERT = 0x10;
    const FILE_READ_ATTRIBUTES = 0x80;
    const IOSB = 0x2b00;
    const ATTRIBUTES = 0x820;
    const STRING = 0x840;
    const TEXT = 0x880;
    let pending = true;
    const p = processOn(new Map(), 1, {
        // A routine already queued: it runs, and the wait is answered at once.
        alertably: (alertable, wait, answer)=>(alertable && pending ? answer() : wait()),
    });
    const create = /** @type {any} */ (p.fns.CreateNamedPipeW).natives.NtCreateNamedPipeFile;
    const name = '\\??\\pipe\\winetestpipe';
    p.putWide(TEXT, name);
    p.view.setUint16(STRING, name.length * 2, true);
    p.view.setUint32(STRING + 4, TEXT, true);
    p.view.setUint32(ATTRIBUTES, 24, true);
    p.view.setUint32(ATTRIBUTES + 8, STRING, true);
    assert.equal(create.handler([0x800, FILE_READ_ATTRIBUTES, ATTRIBUTES, 0, 3, FILE_CREATE,
        FILE_SYNCHRONOUS_IO_ALERT, 0, 0, 0, 1, 500, 500, 0]) >>> 0, 0);
    const server = p.u32(0x800);
    p.view.setUint32(IOSB, 0x55555555, true);
    assert.deepEqual(p.pipes.control(server, 0x110008, 0, 0, IOSB, undefined),
        { status: STATUS_CANCELLED, information: 0 });
    assert.equal(p.u32(IOSB), 0x55555555, 'the block is left alone');
    pending = false;
    assert.deepEqual(p.pipes.control(server, 0x110008, 0, 0, IOSB, undefined),
        { parked: 'parked' }, 'with nothing queued it waits');
    const client = p.client();
    assert.deepEqual(p.pipes.control(client, 0x110008, 0, 0, IOSB, undefined),
        { status: STATUS_ILLEGAL_FUNCTION, information: 0 });
});

test('a synchronous listen parks; CancelSynchronousIo by its block ends it cancelled', ()=>{
    const IOSB = 0x2b00;
    const p = processOn(new Map());
    const server = p.server();
    p.as('p1:listener');
    assert.deepEqual(p.pipes.control(server, 0x110008, 0, 0, IOSB, undefined),
        { parked: 'parked' });
    assert.equal(p.pipes.cancelSynchronous('p1:listener', 0x9999), 0);
    assert.equal(p.pipes.cancelSynchronous('p1:listener', IOSB), 1);
    assert.equal(p.u32(IOSB), STATUS_CANCELLED);
    assert.deepEqual(p.woken.at(-1), { thread: 'p1:listener', result: STATUS_CANCELLED });
});
