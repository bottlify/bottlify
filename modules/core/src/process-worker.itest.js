/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A child in a worker of its own (roadmap/v2, stage 2): its machine in that
 * worker, the run's registry, volume, windows and ids answered from the
 * parent's thread across a link. The compiled parent starts its child twice
 * and checks, one property per line, what each left: the exit code, the file
 * it wrote, the registry value it set, a wait for any of a set.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { READ_AHEAD_BYTES, createApp } from './app.js';
import { writeBundle } from './bundle-node.js';
import { Worker } from 'node:worker_threads';
import { buildExe } from '../../../tools/make-pe.mjs';
import { texturedFrames } from '../../../tools/d3d9-program.mjs';
import { waitingParent } from '../../../tools/spawn-program.mjs';
import { createFakeDevice } from './layers/graphics/webgpu/internal/fake-device.js';
import {
    SLOTS, SLOT_HEADER_INT32, STATE, STATE_OPEN, slotHeaderOffset,
} from './layers/audio/output/mix.js';

/** @param {number} value */
const u32 = value=>[0, 8, 16, 24].map(at=>(value >>> at) & 0xff);

/**
 * A window painted red through its DC (16x16 at its client's corner), then
 * its messages dispatched -- its WM_PAINT ends the pass the desktop is shown
 * after -- until a WM_KEYDOWN; ExitProcess(its virtual key).
 */
function paintsThenWaits(){
    return buildExe({
        imports: {
            'USER32.dll': ['RegisterClassA', 'CreateWindowExA', 'DefWindowProcA', 'GetMessageA',
                'DispatchMessageA', 'GetDC', 'ReleaseDC', 'FillRect'],
            'GDI32.dll': ['CreateSolidBrush'],
            'KERNEL32.dll': ['ExitProcess'],
        },
        data: {
            className: [...Buffer.from('BottlifyPaint'), 0],
            wndclass: new Array(40).fill(0),
            msg: new Array(28).fill(0),
            rect: [...u32(0), ...u32(0), ...u32(16), ...u32(16)],
        },
        codeSize: 0x100,
        code: ({ iat, at })=>{
            /** @param {number} value */
            const push = value=>[0x68, ...u32(value)];
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            const dispatch = [...push(at('msg')), ...call('DispatchMessageA')];
            const wait = [
                0x6a, 0, 0x6a, 0, 0x6a, 0, ...push(at('msg')), ...call('GetMessageA'),
                // cmp dword [msg.message], WM_KEYDOWN
                0x81, 0x3d, ...u32(at('msg') + 4), ...u32(0x100),
                0x0f, 0x84, ...u32(dispatch.length + 5), //  je done
                ...dispatch,
            ];
            return [
                0xa1, ...u32(iat('DefWindowProcA')), 0xa3, ...u32(at('wndclass') + 4),
                0xc7, 0x05, ...u32(at('wndclass') + 36), ...u32(at('className')),
                ...push(at('wndclass')), ...call('RegisterClassA'),
                0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, ...push(64), ...push(96), 0x6a, 0, 0x6a, 0,
                ...push(0x10cf0000), ...push(at('className')), ...push(at('className')),
                0x6a, 0, ...call('CreateWindowExA'),
                0x89, 0xc7, //                               mov edi, eax
                ...push(0x0000ff), ...call('CreateSolidBrush'),
                0x89, 0xc3, //                               mov ebx, eax
                0x57, ...call('GetDC'),
                0x89, 0xc6, //                               mov esi, eax
                0x53, ...push(at('rect')), 0x56, ...call('FillRect'),
                0x56, 0x57, ...call('ReleaseDC'),
                ...wait,
                0xe9, ...u32(-(wait.length + 5)), //         jmp wait
                0xff, 0x35, ...u32(at('msg') + 8), //        done: push [msg.wParam]
                ...call('ExitProcess'),
            ];
        },
    });
}

/** Whether any upload the fake device took holds an opaque red pixel. @param {any} gpu */
const sawRed = gpu=>gpu.of('writeTexture').some((/** @type {any} */ write)=>{
    const bytes = /** @type {Uint8Array} */ (write.bytes);
    for (let at = 0; at + 3 < bytes.length; at += 4)
    {
        if (bytes[at] === 0 && bytes[at + 1] === 0 && bytes[at + 2] === 0xff)
        {
            return true;
        }
    }
    return false;
});

test('a child in a worker of its own leaves its parent its file, its registry value and its code',
    { timeout: 120000 }, async t=>{
        const [parent, child] = await Promise.all([
            readFile(new URL('../test/fixtures/spawn.exe', import.meta.url)),
            readFile(new URL('../test/fixtures/spawn_child.exe', import.meta.url)),
        ]);
        const app = await createApp({
            executable: new Uint8Array(parent),
            imagePath: 'C:\\App\\spawn.exe',
            engine: 'cork',
            concurrency: 2,
            storage: { load: async()=>({
                files: [{ path: 'C:\\App\\spawn_child.exe', bytes: new Uint8Array(child) }],
            }) },
        });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        /** @type {any[]} */
        const started = [];
        app.on('process-started', (/** @type {any} */ event)=>started.push(event));
        /** @type {any[]} */
        const libraries = [];
        app.on('libraries', (/** @type {any} */ event)=>libraries.push(event));
        const code = await app.run({ timeoutMs: 60000 });
        const lines = output.join('').split('\r\n').filter(Boolean);
        assert.deepEqual(lines.filter(line=>line.startsWith('FAIL')), [], output.join(''));
        assert.equal(lines.filter(line=>line.startsWith('ok   ')).length, 10, output.join(''));
        assert.deepEqual(lines.filter(line=>!line.startsWith('ok   ')),
            ['child: first', 'child: second', 'parent: done'],
            'each child\'s output reached the run, before the parent went on');
        assert.equal(code, 0);
        assert.deepEqual(started.map(event=>[event.image, event.worker]),
            [['C:\\App\\spawn.exe', true], ['C:\\App\\spawn_child.exe', true],
                ['C:\\App\\spawn_child.exe', true]],
            'the program and both its children ran in workers of their own');
        assert.equal(libraries.length, 3, 'what each child\'s machine said reached the run\'s bus');
        assert.ok(libraries.every(event=>Array.isArray(event.loaded)));
    });

test('a child in a worker of its own reads what the run\'s bundle has not fetched yet',
    { timeout: 120000 }, async t=>{
        // CreateFileA("C:\\z\\data.bin", GENERIC_READ, FILE_SHARE_READ, 0, OPEN_EXISTING, 0, 0);
        // ReadFile(it, &byte, 1, &read, 0); ExitProcess(byte)
        const child = buildExe({
            imports: { 'KERNEL32.dll': ['CreateFileA', 'ReadFile', 'ExitProcess'] },
            data: { path: [...Buffer.from('C:\\z\\data.bin'), 0], byte: u32(0), read: u32(0) },
            code: ({ iat, at })=>[
                0x6a, 0, 0x6a, 0, 0x6a, 3, 0x6a, 0, 0x6a, 1, 0x68, ...u32(0x80000000),
                0x68, ...u32(at('path')), 0xff, 0x15, ...u32(iat('CreateFileA')),
                0x6a, 0, 0x68, ...u32(at('read')), 0x6a, 1, 0x68, ...u32(at('byte')), 0x50,
                0xff, 0x15, ...u32(iat('ReadFile')),
                0xff, 0x35, ...u32(at('byte')), 0xff, 0x15, ...u32(iat('ExitProcess')),
            ],
        });
        const parent = waitingParent();
        const root = await mkdtemp(join(tmpdir(), 'btl-src-'));
        const out = await mkdtemp(join(tmpdir(), 'btl-out-'));
        t.after(()=>rm(root, { recursive: true, force: true }));
        t.after(()=>rm(out, { recursive: true, force: true }));
        await writeFile(join(root, 'a.exe'), child);
        // Far enough past the image that fetching it does not bring the data.
        await mkdir(join(root, 'm'));
        await writeFile(join(root, 'm', 'big.bin'), randomBytes(4 * READ_AHEAD_BYTES));
        await mkdir(join(root, 'z'));
        await writeFile(join(root, 'z', 'data.bin'), Uint8Array.of(0x2a));
        const path = join(out, 'bundle.btl');
        await writeBundle({ root, output: path, blockSize: 64 * 1024 });
        const handle = await open(path, 'r');
        t.after(()=>handle.close());
        /** @type {[number, number][]} */
        const asked = [];
        const app = await createApp({
            executable: parent,
            imagePath: 'C:\\parent.exe',
            engine: 'cork',
            concurrency: 2,
            bundle: { prefix: '', store: null, fetch: async(offset, length)=>{
                asked.push([offset, length]);
                const buffer = Buffer.alloc(length);
                await handle.read(buffer, 0, length, offset);
                return new Uint8Array(buffer);
            } },
        });
        t.after(()=>app.dispose());
        /** @type {any[]} */
        const started = [];
        app.on('process-started', (/** @type {any} */ event)=>started.push(event.worker));
        const before = { count: 0 };
        app.on('process-started', ()=>{
            before.count = asked.length;
        });
        assert.equal(await app.run({ timeoutMs: 60000 }), 0x2a,
            'the child read its byte out of the bundle');
        assert.deepEqual(started, [true, true], 'the program and its child, each in a worker');
        assert.ok(asked.length > before.count,
            'and the read was a miss the run fetched for it, across the link');
    });

test('a child in a worker of its own draws on the run\'s graphics worker, and the run shows it',
    { timeout: 120000 }, async t=>{
        const FRAMES = 3;
        const gpu = createFakeDevice();
        Object.assign(gpu.device, { queue: gpu.queue, features: new Set(),
            createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }) });
        const thread = new Worker(new URL('../../../tools/fake-graphics-worker.mjs',
            import.meta.url));
        t.after(()=>thread.terminate());
        thread.postMessage({ type: 'open', frames: 'pixels' });
        /** @type {any[]} */
        const fromWorker = [];
        thread.on('message', data=>fromWorker.push(data));
        /** @type {Map<Function, (data: any) => void>} */
        const listeners = new Map();
        const worker = {
            postMessage: (/** @type {any} */ message, /** @type {any} */ transfer)=>
                thread.postMessage(message, transfer),
            addEventListener: (/** @type {string} */ _type, /** @type {Function} */ listener)=>{
                const relay = (/** @type {any} */ data)=>listener({ data });
                listeners.set(listener, relay);
                thread.on('message', relay);
            },
            removeEventListener: (/** @type {string} */ _type, /** @type {Function} */ listener)=>{
                thread.off('message', /** @type {any} */ (listeners.get(listener)));
            },
        };
        const app = await createApp({
            executable: waitingParent(),
            imagePath: 'C:\\parent.exe',
            engine: 'cork',
            concurrency: 2,
            cork: /** @type {any} */ ({ config: { sharedMemory: true } }),
            device: { device: gpu.device, queue: gpu.queue, screen: gpu.screen,
                canvas: gpu.canvas, adapter: { vendor: 'fake', architecture: '',
                    description: 'a stand-in' }, worker },
            storage: { load: async()=>({
                files: [{ path: 'C:\\a.exe', bytes: texturedFrames(FRAMES) }],
            }) },
        });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const divergences = [];
        app.on('divergence', (/** @type {any} */ seen)=>divergences.push(seen.detail));
        /** @type {any[]} */
        const started = [];
        app.on('process-started', (/** @type {any} */ event)=>started.push(event.worker));
        assert.equal(await app.run({ timeoutMs: 60000 }), 0, divergences.join('\n'));
        assert.deepEqual(started, [true, true], 'the program and its child, each in a worker');
        assert.deepEqual(divergences, []);
        const frames = fromWorker.filter(message=>message.type === 'frame');
        assert.ok(frames.length >= 1, 'the child\'s device presented on the graphics worker');
        assert.deepEqual([frames[0].width, frames[0].height], [64, 32],
            'at the size of the child\'s back buffer');
        const shown = app.presenter().presented();
        assert.ok(shown.count >= frames.length,
            `and the run showed what came back: ${shown.count} of ${frames.length}`);
    });

test('a child in a worker of its own is sent the page\'s input while it stands',
    { timeout: 120000 }, async t=>{
        // A window, then GetMessageA until a WM_KEYDOWN; ExitProcess(its virtual key).
        const child = buildExe({
            imports: {
                'USER32.dll': ['RegisterClassA', 'CreateWindowExA', 'DefWindowProcA',
                    'GetMessageA'],
                'KERNEL32.dll': ['ExitProcess'],
            },
            data: {
                className: [...Buffer.from('BottlifyKeys'), 0],
                wndclass: new Array(40).fill(0),
                msg: new Array(28).fill(0),
            },
            codeSize: 0x100,
            code: ({ iat, at })=>{
                /** @param {number} value */
                const push = value=>[0x68, ...u32(value)];
                const wait = [
                    0x6a, 0, 0x6a, 0, 0x6a, 0, ...push(at('msg')),
                    0xff, 0x15, ...u32(iat('GetMessageA')),
                    // cmp dword [msg.message], WM_KEYDOWN
                    0x81, 0x3d, ...u32(at('msg') + 4), ...u32(0x100),
                ];
                return [
                    0xa1, ...u32(iat('DefWindowProcA')), 0xa3, ...u32(at('wndclass') + 4),
                    0xc7, 0x05, ...u32(at('wndclass') + 36), ...u32(at('className')),
                    ...push(at('wndclass')), 0xff, 0x15, ...u32(iat('RegisterClassA')),
                    0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, ...push(32), ...push(64), 0x6a, 0, 0x6a, 0,
                    ...push(0x10cf0000), ...push(at('className')), ...push(at('className')),
                    0x6a, 0, 0xff, 0x15, ...u32(iat('CreateWindowExA')),
                    ...wait,
                    0x0f, 0x85, ...u32(-(wait.length + 6)), //   jne wait
                    0xff, 0x35, ...u32(at('msg') + 8), //        push [msg.wParam]
                    0xff, 0x15, ...u32(iat('ExitProcess')),
                ];
            },
        });
        const app = await createApp({
            executable: waitingParent(),
            imagePath: 'C:\\parent.exe',
            engine: 'cork',
            concurrency: 2,
            storage: { load: async()=>({ files: [{ path: 'C:\\a.exe', bytes: child }] }) },
        });
        t.after(()=>app.dispose());
        /** @type {ReturnType<typeof setInterval> | null} */
        let pressing = null;
        app.on('process-started', (/** @type {any} */ event)=>{
            if (event.worker && event.image === 'C:\\a.exe')
            {
                pressing = setInterval(()=>{
                    app.input.send({ kind: 'key', code: 'KeyA', down: true });
                    app.input.send({ kind: 'key', code: 'KeyA', down: false });
                }, 50);
            }
        });
        t.after(()=>clearInterval(/** @type {any} */ (pressing)));
        assert.equal(await app.run({ timeoutMs: 60000 }), 0x41,
            'the child read the A its window was sent');
        assert.ok(pressing, 'it ran in a worker of its own');
    });

/**
 * A parent that opens a wave device -- a track on its output, open until it
 * exits -- then starts `command`, waits for it and exits with its code.
 *
 * @param {string} command
 */
function soundingParent(command){
    return buildExe({
        imports: {
            'WINMM.dll': ['waveOutOpen'],
            'KERNEL32.dll': ['CreateProcessA', 'WaitForSingleObject', 'GetExitCodeProcess',
                'ExitProcess'],
        },
        data: {
            command: [...Buffer.from(command), 0],
            // WAVEFORMATEX: PCM, two channels, 44100 Hz, 16 bits.
            format: [1, 0, 2, 0, ...u32(44100), ...u32(44100 * 4), 4, 0, 16, 0, 0, 0],
            wave: u32(0),
            startup: [...u32(68), ...new Array(64).fill(0)],
            info: new Array(16).fill(0),
            code: u32(0),
        },
        codeSize: 0xa0,
        code: ({ iat, at })=>[
            0x6a, 0, 0x6a, 0, 0x6a, 0, 0x68, ...u32(at('format')), 0x6a, 0xff,
            0x68, ...u32(at('wave')), 0xff, 0x15, ...u32(iat('waveOutOpen')),
            0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
            0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
            0x68, ...u32(at('command')), 0x6a, 0,
            0xff, 0x15, ...u32(iat('CreateProcessA')),
            0x6a, 0xff, 0xff, 0x35, ...u32(at('info')),
            0xff, 0x15, ...u32(iat('WaitForSingleObject')),
            0x68, ...u32(at('code')), 0xff, 0x35, ...u32(at('info')),
            0xff, 0x15, ...u32(iat('GetExitCodeProcess')),
            0xff, 0x35, ...u32(at('code')),
            0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
}

/** How many of a track table's slots are open. @param {SharedArrayBuffer} table */
const openSlots = table=>Array.from({ length: SLOTS }, (_, slot)=>
    Atomics.load(new Int32Array(table, slotHeaderOffset(slot), SLOT_HEADER_INT32), STATE))
    .filter(state=>state === STATE_OPEN).length;

for (const [where, programs] of /** @type {[string, string[]][]} */ ([
    ['beside its parent', ['C:\\a.exe']],
    // A grandchild past the run's concurrency, in its parent's worker: its
    // table is named across the worker's channel as the worker's own is.
    ['with a child of its own in its worker', ['C:\\a.exe', 'C:\\b.exe']],
]))
{
    test(`a child in a worker of its own ${where} plays into a table of its own, named to the page`
        + ' and let go of as it exits, and the first process\'s track stays open',
    { timeout: 120000 }, async t=>{
        const exits = buildExe({
            imports: { 'KERNEL32.dll': ['ExitProcess'] },
            code: ({ iat })=>[0x6a, 7, 0xff, 0x15, ...u32(iat('ExitProcess'))],
        });
        const files = programs.length === 1
            ? [{ path: 'C:\\a.exe', bytes: exits }]
            : [{ path: 'C:\\a.exe', bytes: waitingParent('C:\\b.exe') },
                { path: 'C:\\b.exe', bytes: exits }];
        const app = await createApp({
            executable: soundingParent('C:\\a.exe'),
            imagePath: 'C:\\parent.exe',
            engine: 'cork',
            concurrency: 2,
            storage: { load: async()=>({ files }) },
            // As a page with a worklet says: a wave device opens a track only
            // where something plays the output.
            audio: { drained: true },
        });
        t.after(()=>app.dispose());
        const run = app.audio.memory().table;
        assert.ok(run instanceof SharedArrayBuffer);
        /** @type {{ id: number, table: SharedArrayBuffer }[]} */
        const tables = [];
        /** @type {number[]} */
        const closed = [];
        /** What the run's first process's table held open as each was named. @type {number[]} */
        const firstOpen = [];
        app.on('sound-table', (/** @type {any} */ event)=>{
            tables.push(event);
            firstOpen.push(openSlots(tables[0].table));
        });
        app.on('sound-table-closed', (/** @type {any} */ event)=>closed.push(event.id));

        assert.equal(await app.run({ timeoutMs: 60000 }), 7);
        // The run's own program is in a worker of its own too: the first
        // named is its.
        assert.equal(tables.length, programs.length + 1,
            'a table for each process in a worker, and for each beside one there');
        assert.ok(tables.every(one=>one.table instanceof SharedArrayBuffer && one.table !== run),
            'each its own shared memory, not the run\'s');
        assert.equal(new Set(tables.map(one=>one.table)).size, tables.length, 'no two the same');
        assert.equal(firstOpen.at(-1), 1,
            'the first process\'s track still open in its own table as the last process came');
        assert.deepEqual([...closed].sort(), tables.map(one=>one.id).sort(),
            'each let go of once its process was gone');
        assert.equal(openSlots(run), 0, 'and nothing of theirs on the run\'s table');
    });
}

for (const where of ['in its own place', 'in a worker of its own'])
{
    test(`a program ${where} paints its window and the run shows it, while it waits idle`,
        { timeout: 120000 }, async t=>{
            const gpu = createFakeDevice();
            Object.assign(gpu.device, { queue: gpu.queue, features: new Set(),
                createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }) });
            const across = where !== 'in its own place';
            const app = await createApp({
                executable: across ? waitingParent() : paintsThenWaits(),
                imagePath: 'C:\\parent.exe',
                engine: 'cork',
                ...across ? { concurrency: 2 } : {},
                device: { device: gpu.device, queue: gpu.queue, screen: gpu.screen,
                    canvas: gpu.canvas },
                storage: { load: async()=>({
                    files: [{ path: 'C:\\a.exe', bytes: paintsThenWaits() }],
                }) },
            });
            t.after(()=>app.dispose());
            let red = false;
            const looking = setInterval(()=>{
                red ||= sawRed(gpu);
                if (red)
                {
                    // Only once its picture is up is it told to go.
                    app.input.send({ kind: 'key', code: 'KeyA', down: true });
                }
            }, 50);
            t.after(()=>clearInterval(looking));
            assert.equal(await app.run({ timeoutMs: 60000 }), 0x41);
            assert.ok(red, 'the red it painted reached the GPU');
        });
}

test('a child in a worker of its own is among the processes standing, with its own diagnostics',
    { timeout: 120000 }, async t=>{
        const app = await createApp({
            executable: waitingParent(),
            imagePath: 'C:\\parent.exe',
            engine: 'cork',
            concurrency: 2,
            storage: { load: async()=>({
                files: [{ path: 'C:\\a.exe', bytes: paintsThenWaits() }],
            }) },
        });
        t.after(()=>app.dispose());
        /** @type {any[]} */
        let standing = [];
        /** @type {ReturnType<typeof setInterval> | null} */
        let pressing = null;
        const asking = setInterval(async()=>{
            const now = await app.standing();
            if (!pressing && now.length === 2 && now[1].diagnostics)
            {
                standing = now;
                // Asked while it stood; now it may go.
                pressing = setInterval(()=>app.input.send({ kind: 'key', code: 'KeyA',
                    down: true }), 50);
            }
        }, 100);
        t.after(()=>{
            clearInterval(asking);
            clearInterval(/** @type {any} */ (pressing));
        });
        assert.equal(await app.run({ timeoutMs: 60000 }), 0x41);
        assert.deepEqual(standing.map(process=>process.image), ['C:\\parent.exe', 'C:\\a.exe']);
        const child = standing[1].diagnostics;
        assert.ok(child.find((/** @type {any} */ layer)=>layer.name === 'win32'),
            'its layers, as it reports them');
    });

test('where processes run at once, the run\'s own program runs in a worker of its own: this'
    + ' thread keeps the system, and asks the program for what only it has',
{ timeout: 120000 }, async t=>{
    const exe = await readFile(new URL('../test/fixtures/hello.exe', import.meta.url));
    const app = await createApp({
        executable: new Uint8Array(exe),
        imagePath: 'C:\\hello.exe',
        engine: 'cork',
        concurrency: 2,
        storage: { load: async()=>({ files: [{ path: 'C:\\note.txt',
            bytes: new TextEncoder().encode('kept') }] }) },
    });
    t.after(()=>app.dispose());
    /** @type {string[]} */
    const output = [];
    app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>output.push(text));
    /** @type {any[]} */
    const started = [];
    app.on('process-started', (/** @type {any} */ event)=>{
        started.push(event);
    });
    const running = app.run({ timeoutMs: 30000 });
    assert.equal(await running, 0);
    assert.equal(output.join(''), 'Hello from Bottlify\r\n');
    assert.deepEqual(started.map(event=>[event.image, event.worker]), [['C:\\hello.exe', true]],
        'the program started in a worker of its own');
    assert.equal(new TextDecoder().decode(app.files.read('C:\\note.txt')), 'kept',
        'the session\'s files are on the run\'s volume, here');
    assert.ok(app.registry().root, 'the registry is the run\'s, here');
    const tables = app.diagnostics();
    /** @param {string} name */
    const table = name=>tables.find((/** @type {any} */ layer)=>layer.name === name);
    assert.ok(table('cpu')?.metrics.instructions > 0,
        'the run\'s processor table is the program\'s, as it ended in its worker');
    // The program's journal -- its phases and frames -- and its sound are what
    // a reader wants under their names, as where it runs on the engine thread;
    // this thread's journal and sound output are beside them.
    assert.ok(Array.isArray(table('log')?.metrics.topPhases)
        && table('log').metrics.topPhases.some((/** @type {string} */ phase)=>
            phase.startsWith('guest ')), 'the program\'s phases are the run\'s log');
    assert.ok(table('system-log'), 'this thread\'s journal is beside it');
    assert.ok(table('audio') && table('system-audio'), 'and so is each one\'s sound');
});

test('a program in a worker of its own is built from a library of the bundle no block of which'
    + ' was fetched yet', { timeout: 120000 }, async t=>{
    // Seven: mov eax, 7; ret. DllMain: mov eax, TRUE; ret 12.
    const library = buildExe({
        dll: true,
        imageBase: 0x01000000,
        imports: { 'KERNEL32.dll': ['GetStdHandle'] },
        exports: [{ name: 'Seven', offset: 8 }],
        code: ()=>[0xb8, ...u32(1), 0xc2, 0x0c, 0x00, 0x90, 0xb8, ...u32(7), 0xc3],
    });
    const program = buildExe({
        imports: { 'probe.dll': ['Seven'], 'KERNEL32.dll': ['ExitProcess'] },
        code: ({ iat })=>[0xff, 0x15, ...u32(iat('Seven')), 0x50,
            0xff, 0x15, ...u32(iat('ExitProcess'))],
    });
    const root = await mkdtemp(join(tmpdir(), 'btl-src-'));
    const out = await mkdtemp(join(tmpdir(), 'btl-out-'));
    t.after(()=>rm(root, { recursive: true, force: true }));
    t.after(()=>rm(out, { recursive: true, force: true }));
    await mkdir(join(root, 'm'));
    await writeFile(join(root, 'm', 'big.bin'), randomBytes(4 * READ_AHEAD_BYTES));
    await mkdir(join(root, 'z'));
    await writeFile(join(root, 'z', 'probe.dll'), library);
    const path = join(out, 'bundle.btl');
    await writeBundle({ root, output: path, blockSize: 64 * 1024 });
    const handle = await open(path, 'r');
    t.after(()=>handle.close());
    const app = await createApp({
        executable: program,
        imagePath: 'C:\\z\\program.exe',
        engine: 'cork',
        concurrency: 2,
        bundle: { prefix: '', store: null, fetch: async(offset, length)=>{
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, offset);
            return new Uint8Array(buffer);
        } },
    });
    t.after(()=>app.dispose());
    assert.equal(await app.run({ timeoutMs: 60000 }), 7,
        'the library was read across the link while the program\'s machine was built');
});

test('a launcher in a worker of its own that starts its game and exits leaves the game running',
    { timeout: 120000 }, async t=>{
    // CreateProcessA(NULL, "C:\\game.exe", ...); ExitProcess(0)
        const launcher = buildExe({
            imports: { 'KERNEL32.dll': ['CreateProcessA', 'ExitProcess'] },
            data: {
                command: [...Buffer.from('C:\\game.exe'), 0],
                startup: [...u32(68), ...new Array(64).fill(0)],
                info: new Array(16).fill(0),
            },
            codeSize: 0x60,
            code: ({ iat, at })=>[
                0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
                0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
                0x68, ...u32(at('command')), 0x6a, 0,
                0xff, 0x15, ...u32(iat('CreateProcessA')),
                0x6a, 0, 0xff, 0x15, ...u32(iat('ExitProcess')),
            ],
        });
        // Sleep(300); ExitProcess(9)
        const game = buildExe({
            imports: { 'KERNEL32.dll': ['Sleep', 'ExitProcess'] },
            code: ({ iat })=>[0x68, ...u32(300), 0xff, 0x15, ...u32(iat('Sleep')),
                0x6a, 9, 0xff, 0x15, ...u32(iat('ExitProcess'))],
        });
        const app = await createApp({
            executable: launcher,
            imagePath: 'C:\\launcher.exe',
            engine: 'cork',
            concurrency: 2,
            storage: { load: async()=>({ files: [{ path: 'C:\\game.exe', bytes: game }] }) },
        });
        t.after(()=>app.dispose());
        /** @type {[string, boolean][]} */
        const started = [];
        app.on('process-started', (/** @type {any} */ event)=>
            started.push([event.image, event.worker === true]));
        assert.equal(await app.run({ timeoutMs: 60000 }), 9, 'the run\'s code is the game\'s');
        assert.deepEqual(started, [['C:\\launcher.exe', true], ['C:\\game.exe', true]]);
    });

test('a program in a worker of its own that is stopped leaves the run its tables as they stood',
    { timeout: 120000 }, async t=>{
        // jmp $: it never ends by itself.
        const program = buildExe({
            imports: { 'KERNEL32.dll': ['ExitProcess'] },
            code: ()=>[0xeb, 0xfe],
        });
        const app = await createApp({
            executable: program,
            imagePath: 'C:\\spin.exe',
            engine: 'cork',
            concurrency: 2,
        });
        t.after(()=>app.dispose());
        /** @type {any[]} */
        const errors = [];
        app.on('error', (/** @type {any} */ payload)=>errors.push(payload));
        assert.equal(await app.run({ timeoutMs: 2000 }), -1);
        assert.ok(errors.some(payload=>payload.reason === 'process'), 'the stop was said');
        const cpu = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'cpu');
        assert.ok(cpu?.metrics.instructions > 0, 'what it ran is still read');
    });
