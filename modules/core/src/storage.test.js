/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    coalescedSaver, inflateRaw,
    normaliseSession, opfsSession, packSession, resolveStorage, unpackSession,
} from './storage.js';

/** @param {number} size @param {number} fill */
const bytes = (size, fill)=>new Uint8Array(size).fill(fill);

test('a deflated block is inflated through the stream, with no Blob made for it', async()=>{
    const { deflateRawSync } = await import('node:zlib');
    const plain = new Uint8Array(300000).map((_, at)=>(at * 7) & 0xff);
    const packed = new Uint8Array(deflateRawSync(plain));
    const shared = new Uint8Array(new SharedArrayBuffer(packed.length));
    shared.set(packed);
    const Blob = globalThis.Blob;
    // WebKit keeps every Blob's bytes in a file on the disk: none may be made.
    globalThis.Blob = /** @type {any} */ (class { constructor(){
        throw new Error('a Blob was made');
    } });
    try
    {
        assert.deepEqual(await inflateRaw(packed), plain);
        assert.deepEqual(await inflateRaw(shared), plain, 'a view of shared memory');
        await assert.rejects(inflateRaw(new Uint8Array([1, 2, 3])), 'a broken stream is an error');
    }
    finally
    {
        globalThis.Blob = Blob;
    }
});

test('a session survives being packed and unpacked', async()=>{
    const files = [
        { path: 'C:\\Save\\game1.sav', bytes: bytes(4096, 0x41) },
        { path: 'C:\\Config.wtf', bytes: new Uint8Array([1, 2, 3]) },
        { path: 'C:\\empty.dat', bytes: new Uint8Array(0) },
    ];

    const back = await unpackSession(await packSession(files));
    assert.equal(back.files.length, 3);
    for (const [index, file] of files.entries())
    {
        assert.equal(back.files[index].path, file.path);
        assert.deepEqual([...back.files[index].bytes], [...file.bytes]);
    }
    assert.equal(back.registry, null, 'a bare list of files is a session with no registry');
});

test('the registry travels with the files and never becomes one of them', async()=>{
    // A program's settings and its name live in the registry as often as in a
    // file; a session that carried only the files forgot them on every start.
    const registry = { roots: [{ id: 0x80000001, key: { name: 'HKEY_CURRENT_USER', values: [
        { name: 'Player', type: 1, data: [65, 0] }], keys: [] } }] };
    const files = [{ path: 'C:\\Config.wtf', bytes: new Uint8Array([1]) }];

    const back = await unpackSession(await packSession({ files, registry }));
    assert.deepEqual(back.registry, registry);
    assert.deepEqual(back.files.map(file=>file.path), ['C:\\Config.wtf'],
        'the registry is not a file a caller could write to the volume');
    assert.deepEqual(normaliseSession(files), { files, registry: null });
    assert.deepEqual(normaliseSession(null), { files: [], registry: null });
});

/**
 * A directory handle's interface, and nothing more of it: a name that is not
 * there is an error on open, a write is a stream replaced on close, and every
 * entry written is counted.
 */
function fakeDirectory(){
    /** @type {Map<string, any>} */
    const entries = new Map();
    let writes = 0;
    /** @returns {any} */
    const folder = ()=>{
        /** @type {Map<string, any>} */
        const here = new Map();
        return {
            here,
            /** @param {string} name @param {{ create?: boolean }} [options] */
            async getFileHandle(name, options){
                if (!here.has(name))
                {
                    if (!options?.create)
                    {
                        throw new Error('NotFoundError');
                    }
                    here.set(name, new Uint8Array(0));
                }
                return {
                    getFile: async()=>new Blob([here.get(name)]),
                    createWritable: async()=>{
                        let written = new Uint8Array(0);
                        return {
                            /** @param {Uint8Array} chunk */
                            write: async chunk=>{
                                written = chunk.slice();
                            },
                            close: async()=>{
                                writes++;
                                here.set(name, written);
                            },
                        };
                    },
                };
            },
            /** @param {string} name @param {{ create?: boolean }} [options] */
            async getDirectoryHandle(name, options){
                if (!entries.has(name))
                {
                    if (!options?.create)
                    {
                        throw new Error('NotFoundError');
                    }
                    entries.set(name, folder());
                }
                return entries.get(name);
            },
            /** @param {string} name */
            async removeEntry(name){
                if (!here.delete(name) && !entries.delete(name))
                {
                    throw new Error('NotFoundError');
                }
            },
            async* entries(){
                for (const name of [...here.keys()])
                {
                    yield [name, await this.getFileHandle(name)];
                }
            },
        };
    };
    return { root: folder(), entries, writes: ()=>writes };
}

test('a session in the origin file system is kept a file to each file and read back', async()=>{
    const disk = fakeDirectory();
    const store = opfsSession('a game/with:odd chars', async()=>disk.root);
    assert.deepEqual(await store.load(), { files: [], registry: null },
        'nothing yet, not an error');

    const session = { files: [{ path: 'C:\\save.dat', bytes: new Uint8Array([7, 7]) },
        { path: 'C:\\Dir\\Ünïcode.cfg', bytes: new Uint8Array([1]) }],
    registry: { roots: [] } };
    await store.save(session);
    assert.deepEqual([...disk.entries.keys()], ['a_game_with_odd_chars.files'], 'a safe name');
    assert.equal(disk.entries.get('a_game_with_odd_chars.files').here.size, 3,
        'two files and the registry');
    const back = await store.load();
    assert.deepEqual(back.registry, { roots: [] });
    assert.deepEqual(back.files.map(file=>[file.path, [...file.bytes]]).sort(),
        [['C:\\Dir\\Ünïcode.cfg', [1]], ['C:\\save.dat', [7, 7]]]);
});

test('a session cleared is gone whole, saved games and registry, and a clear of none is no error',
    async()=>{
        const disk = fakeDirectory();
        const store = opfsSession('game', async()=>disk.root);
        await store.save({ files: [{ path: 'C:\\save.dat', bytes: new Uint8Array([7]) }],
            registry: { roots: [] } });
        await store.clear();
        assert.deepEqual([...disk.entries.keys()], [], 'nothing of it left');
        assert.deepEqual(await opfsSession('game', async()=>disk.root).load(),
            { files: [], registry: null });
        await store.clear();
    });

test("a session read while another holder saves into it passes over a save's swap file",
    async()=>{
        // A process the run started reads the session while its parent saves:
        // the parent's open stream keeps a swap file beside the entry, listed
        // and gone by the time it is read, and it is not one of the session's
        // files either way. Read, its absence stopped the run.
        const disk = fakeDirectory();
        const store = opfsSession('game', async()=>disk.root);
        await store.save({ files: [{ path: 'C:\\a.cfg', bytes: new Uint8Array([5]) }],
            registry: null });
        const folder = disk.entries.get('game.files');
        const [entry] = [...folder.here.keys()];
        folder.here.set(`${entry}.crswap`, folder.here.get(entry));
        const listed = folder.entries.bind(folder);
        folder.entries = async function* (){
            for await (const [name, handle] of listed())
            {
                yield [name, name.endsWith('.crswap')
                    ? { getFile: async()=>{
                        throw new DOMException('gone', 'NotFoundError');
                    } }
                    : handle];
            }
        };
        const other = opfsSession('game', async()=>disk.root);
        assert.deepEqual((await other.load()).files.map(file=>file.path), ['C:\\a.cfg']);
        assert.deepEqual((await other.list()).map(file=>file.path), ['C:\\a.cfg']);
    });

test('a save after the first writes only what changed, and drops what was removed', async()=>{
    const disk = fakeDirectory();
    const store = opfsSession('game', async()=>disk.root);
    const big = { path: 'C:\\big.save', bytes: bytes(1 << 20, 3) };
    const config = { path: 'C:\\config.cfg', bytes: new Uint8Array([1]) };
    await store.save({ files: [big, config], registry: { a: 1 } }, [{ kind: 'written',
        path: config.path }]);
    assert.equal(disk.writes(), 3, 'the first save of a run writes everything');

    const config2 = { path: config.path, bytes: new Uint8Array([2]) };
    await store.save({ files: [big, config2], registry: { a: 1 } },
        [{ kind: 'written', path: config.path }]);
    assert.equal(disk.writes(), 4, 'the next writes the one file that changed');

    await store.save({ files: [config2], registry: { a: 2 } },
        [{ kind: 'removed', path: big.path }, { kind: 'registry' }]);
    assert.equal(disk.writes(), 5, 'a removal writes nothing; the registry is one entry');
    const back = await store.load();
    assert.deepEqual(back.files.map(file=>[file.path, [...file.bytes]]),
        [[config.path, [2]]]);
    assert.deepEqual(back.registry, { a: 2 });
});

test('a session left as one packed file is read, and gone after the first save', async()=>{
    const disk = fakeDirectory();
    const old = await packSession({ files: [{ path: 'C:\\old.sav', bytes: new Uint8Array([9]) }],
        registry: { r: 1 } });
    const handle = await disk.root.getFileHandle('game.session', { create: true });
    const stream = await handle.createWritable();
    await stream.write(old);
    await stream.close();
    const store = opfsSession('game', async()=>disk.root);
    const loaded = await store.load();
    assert.deepEqual(loaded.files.map(file=>file.path), ['C:\\old.sav']);
    await store.save(loaded, [{ kind: 'registry' }]);
    assert.equal(disk.root.here.has('game.session'), false, 'the packed file is gone');
    const back = await store.load();
    assert.deepEqual(back.files.map(file=>[file.path, [...file.bytes]]), [['C:\\old.sav', [9]]]);
    assert.deepEqual(back.registry, { r: 1 });
});

test('a session is edited while no machine holds it: listed, read, written, removed', async()=>{
    // The launcher's file editor, before a run: a setting the game saved, taken away
    // so it asks again, and a file put where the game will find it.
    const disk = fakeDirectory();
    const old = await packSession({ files: [{ path: 'C:\\Profile\\Options.ini',
        bytes: new Uint8Array([1, 2, 3]) }], registry: { r: 1 } });
    const handle = await disk.root.getFileHandle('game.session', { create: true });
    const stream = await handle.createWritable();
    await stream.write(old);
    await stream.close();
    const store = opfsSession('game', async()=>disk.root);
    assert.deepEqual(await store.list(), [{ path: 'C:\\Profile\\Options.ini', size: 3 }],
        'a session in the one-file form is listed too');
    await store.write('C:\\App\\added.txt', new Uint8Array([7]));
    assert.equal(disk.root.here.has('game.session'), false, 'moved into the folder by an edit');
    assert.deepEqual((await store.list()).map(file=>[file.path, file.size]).sort(),
        [['C:\\App\\added.txt', 1], ['C:\\Profile\\Options.ini', 3]]);
    assert.deepEqual([...await store.read('C:\\Profile\\Options.ini') ?? []], [1, 2, 3]);
    await store.remove('C:\\Profile\\Options.ini');
    assert.equal(await store.read('C:\\Profile\\Options.ini'), null);
    const loaded = await store.load();
    assert.deepEqual(loaded.files.map(file=>file.path), ['C:\\App\\added.txt']);
    assert.deepEqual(loaded.registry, { r: 1 }, 'the registry kept through the move');
});

test('a session is compressed, and as one stream', async()=>{
    // Saves and configuration are exactly the kind of data that compresses, and
    // a session travels whole -- so it is one stream rather than the blocks a
    // bundle needs, which would only cost ratio here.
    const packed = await packSession([{ path: 'C:\\big.sav', bytes: bytes(64 * 1024, 0x7a) }]);
    assert.ok(packed.length < 2000, `64 KiB of one byte packed to ${packed.length}`);
});

test('an empty session is empty, not an error', async()=>{
    assert.deepEqual(await unpackSession(new Uint8Array(0)), { files: [], registry: null });
    assert.deepEqual(await unpackSession(await packSession([])), { files: [], registry: null });
});

test('something that is not a session says so', async()=>{
    const { deflateRawSync } = await import('node:zlib');
    const nonsense = new Uint8Array(deflateRawSync(Buffer.from('hello there')));
    await assert.rejects(()=>unpackSession(nonsense), /not a packed session/);
});

test('a path with characters outside ASCII comes back intact', async()=>{
    // A save named by the user is named in whatever language they use, and the
    // frame counts bytes rather than characters.
    const files = [{ path: 'C:\\Сохранения\\игра.sav', bytes: new Uint8Array([9]) }];
    const back = await unpackSession(await packSession(files));
    assert.equal(back.files[0].path, files[0].path);
});

test('storage takes a provider, a bare function, or nothing', async()=>{
    const nothing = resolveStorage(null, 'x');
    assert.deepEqual(await nothing.load(), { files: [], registry: null });
    assert.equal(nothing.save, null, 'nothing in means nothing out');

    const loader = resolveStorage(async()=>[{ path: 'C:\\a', bytes: new Uint8Array([1]) }], 'x');
    assert.equal((await loader.load()).files.length, 1, 'a bare list is taken as the files');
    assert.equal(loader.save, null, 'a function that only loads does not save');

    /** @type {any[][]} */
    const saved = [];
    const provider = resolveStorage({
        load: async()=>[{ path: 'C:\\b', bytes: new Uint8Array([2]) }],
        /** @param {any[]} files @param {any[]} changes */
        save: (files, changes)=>saved.push([files, changes]),
    }, 'x');

    assert.equal((await provider.load())[0].path, 'C:\\b');
    provider.save?.({ files: [{ path: 'C:\\b', bytes: new Uint8Array(0) }], registry: null },
        [{ path: 'C:\\b', kind: 'written' }]);
    assert.equal(saved.length, 1);
    assert.equal(saved[0][1][0].kind, 'written');
});

test('the local option says plainly where it does not work', async()=>{
    const local = resolveStorage('local', 'game');

    // There is no localStorage in a worker, which is where the engine runs. A
    // caller reaching for the convenient option deserves to be told why rather
    // than to find an empty session.
    if (!globalThis.localStorage)
    {
        await assert.rejects(()=>local.load(), /does not exist here/);
    }
});

test('a burst of changes is saved once, after it settles, and never two at a time', async()=>{
    /** @type {(() => void)[]} */
    const timers = [];
    /** @type {{ resolve: (value?: unknown) => void }[]} */
    const stores = [];
    /** @type {{ files: number, changes: number }[]} */
    const saved = [];
    let version = 0;
    const saver = coalescedSaver({
        snapshot: ()=>({
            files: Array.from({ length: ++version }, ()=>({ path: 'f', bytes: new Uint8Array(0) })),
            registry: null,
        }),
        persist: (session, changes)=>new Promise(resolve=>{
            saved.push({ files: session.files.length, changes: changes.length });
            stores.push({ resolve });
        }),
        schedule: fn=>timers.push(fn),
    });

    saver.note([{ kind: 'written', path: 'f' }]);
    saver.note([{ kind: 'written', path: 'f' }]);
    saver.note([{ kind: 'registry' }]);
    assert.equal(timers.length, 1, 'one wait for the burst to settle');
    assert.equal(saved.length, 0, 'nothing saved before it does');

    timers.shift()?.();
    assert.deepEqual(saved, [{ files: 1, changes: 2 }],
        'one save carrying every change, a file written twice named once');

    // Changes that arrive while the store is busy wait for it, then go as one.
    saver.note([{ kind: 'written', path: 'g' }]);
    saver.note([{ kind: 'written', path: 'g' }]);
    assert.equal(timers.length, 0, 'no wait is set while a save is under way');
    stores.shift()?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(timers.length, 1, 'the next save waits its turn once the first is done');
    timers.shift()?.();
    assert.deepEqual(saved.at(-1), { files: 2, changes: 1 }, 'the snapshot is taken at save time');
    assert.equal(saver.pending, 0);

    // A flush saves what is pending now, without the wait.
    stores.shift()?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    saver.note([{ kind: 'registry' }]);
    const flushed = saver.flush();
    assert.equal(saved.length, 3, 'saved at once, without the wait');
    assert.equal(saved.at(-1)?.changes, 1);
    stores.shift()?.resolve();
    await flushed;
});

test('a save names each file once, by its last change, however many turns noted it', async()=>{
    // The filesystem collapses a file's writes only within one turn of the
    // machine; a save written over several turns arrives as several notes, and
    // the store puts every file it is told of whole.
    /** @type {(() => void)[]} */
    const timers = [];
    /** @type {any[][]} */
    const saved = [];
    const saver = coalescedSaver({
        snapshot: ()=>({ files: [], registry: null }),
        persist: (session, changes)=>saved.push(changes),
        schedule: fn=>timers.push(fn),
    });
    saver.note([{ kind: 'written', path: 'a' }]);
    saver.note([{ kind: 'registry' }, { kind: 'written', path: 'b' }]);
    saver.note([{ kind: 'removed', path: 'a' }, { kind: 'registry' }]);
    saver.note([{ kind: 'written', path: 'b' }]);
    assert.equal(saver.pending, 3);
    timers.shift()?.();
    await Promise.resolve();
    assert.deepEqual(saved, [[{ kind: 'removed', path: 'a' }, { kind: 'registry' },
        { kind: 'written', path: 'b' }]]);
});

test('the origin\'s storage is asked to be kept once, and a refusal keeps the session working',
    async()=>{
        // Best-effort storage is cleared whole when the disk runs low, saved
        // games with it: the store asks the browser to keep it, once.
        const disk = fakeDirectory();
        const was = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
        let asked = 0;
        let grant = true;
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
            storage: { getDirectory: async()=>disk.root, persist: async()=>{
                asked++;
                return grant;
            } } } });
        try
        {
            const store = opfsSession('game');
            assert.equal(await store.persisted(), null, 'not asked before the store is opened');
            await store.save({ files: [{ path: 'save.dat', bytes: Uint8Array.of(1) }],
                registry: null });
            await store.save({ files: [{ path: 'save.dat', bytes: Uint8Array.of(2) }],
                registry: null });
            assert.equal(asked, 1);
            assert.equal(await store.persisted(), true);
            grant = false;
            const refused = opfsSession('other');
            await refused.save({ files: [{ path: 'a', bytes: Uint8Array.of(3) }], registry: null });
            assert.equal(await refused.persisted(), false);
            assert.deepEqual([...(await refused.read('a')) ?? []], [3], 'kept all the same');
        }
        finally
        {
            if (was)
            {
                Object.defineProperty(globalThis, 'navigator', was);
            }
            else
            {
                delete (/** @type {any} */ (globalThis)).navigator;
            }
        }
    });
