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
import { createNamedPipes, isPipeName } from './pipes.js';

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
 */
function processOn(table, id = 1){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    /** @type {Map<number, { type: string, object: any }>} */
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
    /** @type {number[]} */
    const events = [];
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
            setEvent: (/** @type {any} */ event)=>{
                event.signalled = true;
            },
            resetEvent: (/** @type {any} */ event)=>{
                event.signalled = false;
            },
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
        queueApc: (thread, routine, args)=>apcs.push({ thread, routine, args }),
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
        pipes, fns, bytes, view, u32, putString, putWide, blocked, woken, timeouts, events,
        packets, bound, handles, apcs,
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
