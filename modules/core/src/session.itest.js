/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Phase 4 acceptance, in the part that can be checked without a browser: a
 * program writes a file, the machine is thrown away, and a new one built from
 * the session it left behind finds the file there.
 *
 * The Master Plan words this as "reopened on another machine under the same
 * account". Everything between the two runs here is what would travel: the
 * session goes out through the same interface a cloud would upload, and comes
 * back in through the one it would restore from. What is not covered is the
 * transport itself, and it is named as such rather than pretended.
 *
 * The fixture reports what it read rather than being asked about it, so the
 * assertion is on the program's own behaviour: a first run prints nothing and
 * leaves a file, a second prints what the first wrote.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { opfsSession, packSession, unpackSession } from './storage.js';
import { fakeOpfs } from './layers/filesystem/internal/opfs.fixture.js';

const FIXTURE = new URL('../test/fixtures/session.exe', import.meta.url);

/** What the fixture writes; it must come back out of the second run verbatim. */
const PAYLOAD = 'SAVED-01';

/**
 * Runs the fixture once against a given session, and reports what it printed
 * and what it left behind.
 *
 * The save is coalesced (`coalescedSaver`) and settles on its own timer, but
 * `dispose` flushes it immediately -- "what the program wrote last is saved
 * now rather than after it settles" -- so `saved`/`announced` are read only
 * after `dispose`, which is what actually delivers them, not a wait of our
 * own. Disposed on the error path too: the machine is one per process, and
 * the first test below runs this twice in the same test body, so the second
 * `createApp` needs the first machine gone before it runs.
 *
 * @param {{ path: string, bytes: Uint8Array }[]} incoming
 */
async function runOnce(incoming){
    const exe = await readFile(FIXTURE);

    /** @type {{ path: string, bytes: Uint8Array }[]} */
    let saved = [];
    /** @type {any[][]} what each save was told changed */
    const announced = [];

    const app = await createApp({
        executable: new Uint8Array(exe),
        storage: {
            load: async()=>incoming,
            /** @param {{ files: any[] }} session @param {any[]} changes */
            save: (session, changes)=>{
                saved = session.files;
                announced.push(changes);
            },
        },
    });
    try
    {
        let printed = '';
        app.on('output', (/** @type {any} */ payload)=>{
            printed += payload.text;
        });

        const exitCode = await app.run({ maxTurns: 20000, timeoutMs: 20000 });
        const session = app.session.export();
        await app.dispose();
        return { printed, exitCode, saved, announced, session };
    }
    catch (e){
        await app.dispose();
        throw e;
    }
}

test('a program finds, on its second run, what it wrote on its first',
    { timeout: 30000 }, async()=>{
        const first = await runOnce([]);

        assert.equal(first.exitCode, 0);
        assert.equal(first.printed, '', 'nothing to read the first time round');
        assert.deepEqual(first.session.map((/** @type {any} */ file)=>file.path), ['C:\\save.dat'],
            'and it left exactly one file behind');

        // Everything between the runs is what a cloud would carry: out through
        // the interface an upload uses, back in through the one a restore uses.
        const travelled = await unpackSession(await packSession(first.session));
        const second = await runOnce(travelled.files);

        assert.equal(second.exitCode, 0);
        assert.equal(second.printed, PAYLOAD,
            'the second run read what the first wrote, through a packed session');
    });

test('a run announces what changed, once per file', { timeout: 15000 }, async()=>{
    const { announced, saved } = await runOnce([]);

    // The program writes its save in more than one call; what comes out is the
    // fact that the file is different now, not a log of every write. Said of
    // each save: how many saves a run makes follows the saver's settle on the
    // host's timer, which a busy machine lets run out between two turns of the
    // program, and each of those saves is right to name the file.
    assert.ok(announced.length >= 1, 'the run was saved');
    for (const changes of announced)
    {
        assert.deepEqual(changes, [{ path: 'C:\\save.dat', kind: 'written' }],
            'each save names the file once');
    }
    assert.equal(saved.length, 1, 'and the save was handed the whole session, not a delta');
});

test('a session arriving from outside is there before the first instruction',
    { timeout: 15000 }, async()=>{
        // Not a detail of ordering: a save that appears after the program has
        // looked for it is a save that was not there.
        const seeded = [{
            path: 'C:\\save.dat',
            bytes: new Uint8Array([...'RESTORED'].map(character=>character.charCodeAt(0))),
        }];

        const { printed } = await runOnce(seeded);
        assert.equal(printed, 'RESTORED');
    });

/**
 * The origin's file system as a worker sees it, in memory: a folder of files,
 * each with a synchronous access handle and the page's own interface - a File
 * read in slices, a writable stream replaced on close. `files` is every file
 * made, by name; `written` every name a stream closed on; `read` the bytes
 * read of each entry of a session past its head (`opfsSession`).
 */
function originDirectory(){
    /** @type {Map<string, { bytes: Uint8Array, open: boolean }>} */
    const files = new Map();
    /** @type {string[]} */
    const written = [];
    /** @type {Map<string, number>} */
    const read = new Map();
    const folder = {
        /** @param {string} name */
        getFileHandle: async name=>{
            const file = files.get(name) ?? { bytes: new Uint8Array(0), open: false };
            files.set(name, file);
            return {
                getFile: async()=>{
                    const bytes = file.bytes;
                    const head = bytes.length >= 8 ? 8 + new DataView(bytes.buffer,
                        bytes.byteOffset).getUint32(4, true) : 0;
                    /** @param {number} start @param {number} end */
                    const part = (start, end)=>({
                        size: Math.max(0, Math.min(end, bytes.length) - start),
                        arrayBuffer: async()=>{
                            read.set(name, (read.get(name) ?? 0)
                                + Math.max(0, Math.min(end, bytes.length) - Math.max(start, head)));
                            return bytes.slice(start, end).buffer;
                        },
                    });
                    return { ...part(0, bytes.length), lastModified: 0,
                        slice: (start = 0, end = bytes.length)=>part(start, end) };
                },
                createWritable: async()=>{
                    /** @type {Uint8Array[]} */
                    const parts = [];
                    return {
                        write: async(/** @type {Uint8Array} */ chunk)=>{
                            parts.push(chunk.slice());
                        },
                        close: async()=>{
                            const whole = new Uint8Array(
                                parts.reduce((sum, one)=>sum + one.length, 0));
                            let at = 0;
                            for (const one of parts)
                            {
                                whole.set(one, at);
                                at += one.length;
                            }
                            file.bytes = whole;
                            written.push(name);
                        },
                    };
                },
                createSyncAccessHandle: async()=>{
                    file.open = true;
                    return {
                        getSize: ()=>file.bytes.length,
                        /** @param {Uint8Array} into @param {{ at: number }} where */
                        read: (into, { at })=>{
                            into.set(file.bytes.subarray(at, at + into.length));
                            return into.length;
                        },
                        /** @param {Uint8Array} from @param {{ at: number }} where */
                        write: (from, { at })=>{
                            if (at + from.length > file.bytes.length)
                            {
                                const grown = new Uint8Array(at + from.length);
                                grown.set(file.bytes);
                                file.bytes = grown;
                            }
                            file.bytes.set(from, at);
                            return from.length;
                        },
                        close: ()=>{
                            file.open = false;
                        },
                    };
                },
            };
        },
        async* entries(){
            for (const name of [...files.keys()])
            {
                yield [name, await folder.getFileHandle(name)];
            }
        },
        /** @param {string} name */
        removeEntry: async name=>{
            files.delete(name);
        },
    };
    return { files, written, read, root: { getDirectoryHandle: async()=>folder } };
}

test('on a page file, what the program wrote is saved, counted, and the run\'s folder goes with '
    + 'the run',
{ timeout: 30000 }, async()=>{
    const exe = await readFile(FIXTURE);
    const origin = fakeOpfs();
    const folder = ()=>{
        const [run] = origin.names('bottlify-runs');
        return run === undefined ? [] : origin.names(`bottlify-runs/${run}`);
    };
        /** @type {any[]} */
    let saved = [];
    const app = await createApp({
        executable: new Uint8Array(exe),
        pageFile: { root: origin.root },
        storage: {
            load: async()=>[],
            readsWithinSave: true,
            /** @param {{ files: any[] }} session */
            save: session=>{
                saved = session.files.map(file=>({ path: file.path,
                    bytes: file.bytes.slice() }));
            },
        },
    });
    try
    {
        assert.equal(await app.run({ maxTurns: 20000, timeoutMs: 20000 }), 0);
        const filesystem = app.diagnostics().find((/** @type {any} */ table)=>
            table.name === 'filesystem');
        assert.equal(filesystem.metrics.pageFile?.disk, true,
            'the run stands on its page file');
        assert.ok(filesystem.metrics.bytesHeld.heaps.writable >= PAYLOAD.length);
        assert.equal(typeof filesystem.metrics.bytesHeld.disk.pageFile, 'number');
        assert.deepEqual(folder(), ['cache', 'pages'],
            'the page file and the run cache\'s disk, in the run\'s own folder');
    }
    finally
    {
        await app.dispose();
    }
    assert.deepEqual(saved.map(file=>[file.path, String.fromCharCode(...file.bytes)]),
        [['C:\\save.dat', PAYLOAD]]);
    await new Promise(resolve=>setTimeout(resolve, 0));
    assert.deepEqual(origin.names('bottlify-runs'), [],
        'the run\'s folder is taken away with it');
});

test("a session kept in the origin's storage is read where the program reads it, announced"
    + ' nowhere, and saved where the program changed it', { timeout: 30000 }, async()=>{
    const exe = await readFile(FIXTURE);
    const origin = originDirectory();
    const store = opfsSession('session', async()=>origin.root);
    const SAVE = 'C:\\save.dat';
    const GONE = 'C:\\Setup\\part7.cab';
    /** @type {{ path: string, bytes: Uint8Array }[]} */
    const files = [{ path: SAVE,
        bytes: new Uint8Array([...'RESTORED'].map(character=>character.charCodeAt(0))) }];
    for (let at = 0; at < 300; at++)
    {
        files.push({ path: `C:\\Setup\\part${at}.cab`,
            bytes: new Uint8Array(64 << 10).fill(at & 0xff) });
    }
    await store.save({ files, registry: null });
    origin.written.length = 0;
    origin.read.clear();

    /** @type {any[]} */
    const announced = [];
    const app = await createApp({
        executable: new Uint8Array(exe),
        storage: { load: ()=>store.load({ lazy: true }), save: store.save, readsWithinSave: true },
    });
    let printed = '';
    try
    {
        app.on('output', (/** @type {any} */ payload)=>{
            printed += payload.text;
        });
        app.on('session', (/** @type {any} */ payload)=>announced.push(...payload.changes));
        assert.equal(await app.run({ maxTurns: 20000, timeoutMs: 20000 }), 0);
        assert.equal(printed, 'RESTORED', 'the saved file is there before the first instruction');
        // The piece read is a body of the run's cache, in the session's space,
        // and the session holds nothing of the heap itself.
        const appTable = app.diagnostics().find((/** @type {any} */ table)=>table.name === 'app');
        assert.deepEqual(appTable.metrics.bundle.session,
            { fetches: 1, pieces: 1, bytes: 'RESTORED'.length, unkept: 0 });
        const space = app.runCache().spaces.session;
        assert.equal(space?.bodies, 1, 'counted under the run cache\'s space `session`');
        assert.equal(space?.bytes, 'RESTORED'.length);

        const kept = app.session.export();
        assert.equal(kept.length, 301, "the whole session is the volume's");
        assert.ok(kept.filter((/** @type {any} */ file)=>!('bytes' in file)).length === 300,
            'the files the program left alone, as the session handed them');
        // The program deletes one of them, as DeleteFile would.
        app.session.apply([{ path: GONE, delete: true }]);
    }
    finally
    {
        await app.dispose();
    }
    // The save the machine's going asked for, written.
    const listed = await store.list();

    const readOf = new Map([...origin.read].filter(([, bytes])=>bytes > 0));
    assert.equal(readOf.size, 1, 'nothing of the session read but the file the program read');
    assert.equal([...readOf.values()][0], 'RESTORED'.length);
    assert.deepEqual([...new Set(announced.map(change=>change.path))].sort(),
        [GONE, SAVE], 'restoring announced nothing');
    const writtenPaths = origin.written.map(name=>{
        const entry = /** @type {Uint8Array} */ (origin.files.get(name)?.bytes);
        const end = 8 + new DataView(entry.buffer, entry.byteOffset).getUint32(4, true);
        return new TextDecoder().decode(entry.subarray(8, end));
    });
    assert.ok(writtenPaths.includes(SAVE), 'the save wrote the file the program wrote');
    assert.deepEqual(writtenPaths.filter(path=>path.startsWith('C:\\')), [SAVE],
        'and nothing of what it left alone');
    assert.equal(listed.length, 300);

    const back = await opfsSession('session', async()=>origin.root).load();
    assert.equal(back.files.length, 300, 'the deleted file is gone, every other kept');
    assert.equal(String.fromCharCode(...back.files.find(file=>file.path === SAVE)
        ?.bytes ?? []), PAYLOAD);
    assert.ok(!back.files.some(file=>file.path === GONE));
});
