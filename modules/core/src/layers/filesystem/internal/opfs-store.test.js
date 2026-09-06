/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * Node has no OPFS, so the store is exercised against a fake that implements
 * exactly the part of the File System standard the store depends on -- and,
 * most importantly, the part everything else gets wrong: a file carries one
 * exclusive lock, `createSyncAccessHandle` fails while it is held, and only
 * `close` gives it back.
 *
 * What the fake models: the create/no-create and kind-mismatch behaviour of
 * `getFileHandle` and `getDirectoryHandle`, `removeEntry` refusing a populated
 * directory and a locked file, asynchronous iteration of entries, and the
 * access handle's read/write/truncate/getSize/flush/close including the
 * standard's zero-fill when a write starts past the end of the file.
 *
 * What it does not model: quota, partial writes, `isSameEntry`, `resolve`,
 * writable streams, permissions, or the locks being shared across an origin
 * rather than a process.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpfsStore } from './opfs-store.js';

/** @param {string} text */
const bytes = text=>Uint8Array.from([...text].map(character=>character.charCodeAt(0)));

/** @param {Uint8Array} data */
const text = data=>[...data].map(byte=>String.fromCharCode(byte)).join('');

/**
 * @typedef {{ kind: 'file', data: Uint8Array, locked: boolean }} FileNode
 * @typedef {{ kind: 'directory', children: Map<string, FileNode | DirectoryNode> }} DirectoryNode
 */

/** @returns {DirectoryNode} */
const directoryNode = ()=>({ kind: 'directory', children: new Map() });

/**
 * @param {FileNode} node
 * @param {string} name
 * @returns {import('./opfs-store.js').OpfsAccess}
 */
function fakeAccess(node, name){
    let closed = false;
    const live = ()=>{
        if (closed)
        {
            throw new DOMException(`"${name}" is closed`, 'InvalidStateError');
        }
    };

    return {
        /** @param {Uint8Array} buffer @param {{ at?: number }} [options] */
        read(buffer, options){
            live();
            const at = options?.at ?? 0;
            const start = Math.min(at, node.data.length);
            const source = node.data.subarray(start, Math.min(start + buffer.length,
                node.data.length));
            buffer.set(source);
            return source.length;
        },

        /** @param {Uint8Array} buffer @param {{ at?: number }} [options] */
        write(buffer, options){
            live();
            const at = options?.at ?? 0;
            const end = at + buffer.length;
            if (end > node.data.length)
            {
                // The standard extends the file with 0x00 when `at` is beyond
                // its end, which is what the store relies on instead of
                // zero-filling for itself.
                const grown = new Uint8Array(end);
                grown.set(node.data);
                node.data = grown;
            }
            node.data.set(buffer, at);
            return buffer.length;
        },

        /** @param {number} size */
        truncate(size){
            live();
            const resized = new Uint8Array(size);
            resized.set(node.data.subarray(0, Math.min(size, node.data.length)));
            node.data = resized;
        },

        getSize(){
            live();
            return node.data.length;
        },

        flush(){
            live();
        },

        close(){
            closed = true;
            node.locked = false;
        },
    };
}

/**
 * @param {FileNode} node
 * @param {string} name
 * @returns {import('./opfs-store.js').OpfsFile}
 */
function fakeFile(node, name){
    return {
        kind: 'file',

        async getFile(){
            return { size: node.data.length };
        },

        async createSyncAccessHandle(){
            if (node.locked)
            {
                throw new DOMException(`"${name}" is in use`, 'NoModificationAllowedError');
            }
            node.locked = true;
            return fakeAccess(node, name);
        },
    };
}

/**
 * @param {DirectoryNode} node
 * @returns {import('./opfs-store.js').OpfsDirectory}
 */
function fakeDirectory(node){
    /** @param {string} name @param {FileNode | DirectoryNode | undefined} child */
    const wrap = (name, child)=>(child?.kind === 'directory'
        ? fakeDirectory(child)
        : fakeFile(/** @type {FileNode} */ (child), name));

    return {
        kind: 'directory',

        /** @param {string} name @param {{ create?: boolean }} [options] */
        async getDirectoryHandle(name, options){
            const existing = node.children.get(name);
            if (existing && existing.kind !== 'directory')
            {
                throw new DOMException(`"${name}" is a file`, 'TypeMismatchError');
            }
            if (!existing && !options?.create)
            {
                throw new DOMException(`"${name}" does not exist`, 'NotFoundError');
            }
            const child = existing ?? directoryNode();
            node.children.set(name, child);
            return fakeDirectory(child);
        },

        /** @param {string} name @param {{ create?: boolean }} [options] */
        async getFileHandle(name, options){
            const existing = node.children.get(name);
            if (existing && existing.kind !== 'file')
            {
                throw new DOMException(`"${name}" is a directory`, 'TypeMismatchError');
            }
            if (!existing && !options?.create)
            {
                throw new DOMException(`"${name}" does not exist`, 'NotFoundError');
            }
            /** @type {FileNode} */
            const child = existing ?? { kind: 'file', data: new Uint8Array(0), locked: false };
            node.children.set(name, child);
            return fakeFile(child, name);
        },

        /** @param {string} name @param {{ recursive?: boolean }} [options] */
        async removeEntry(name, options){
            const child = node.children.get(name);
            if (!child)
            {
                throw new DOMException(`"${name}" does not exist`, 'NotFoundError');
            }
            if (child.kind === 'directory' && child.children.size > 0 && !options?.recursive)
            {
                throw new DOMException(`"${name}" is not empty`, 'InvalidModificationError');
            }
            if (child.kind === 'file' && child.locked)
            {
                throw new DOMException(`"${name}" is in use`, 'NoModificationAllowedError');
            }
            node.children.delete(name);
        },

        async *entries(){
            for (const [name, child] of [...node.children])
            {
                yield /** @type {[string, any]} */ ([name, wrap(name, child)]);
            }
        },
    };
}

/**
 * Builds a tree the way the memory store's seed does: a path maps to its
 * contents, `null` makes a directory, and the directories a path implies are
 * created for it.
 *
 * @param {Record<string, string | null>} [seed]
 */
function fakeRoot(seed = {}){
    const root = directoryNode();
    for (const [path, content] of Object.entries(seed))
    {
        const segments = path.split('\\');
        let node = root;
        for (const segment of segments.slice(0, -1))
        {
            const child = node.children.get(segment);
            if (child?.kind === 'directory')
            {
                node = child;
                continue;
            }
            const created = directoryNode();
            node.children.set(segment, created);
            node = created;
        }
        const name = segments[segments.length - 1];
        node.children.set(name, content === null
            ? directoryNode()
            : { kind: 'file', data: bytes(content), locked: false });
    }
    return fakeDirectory(root);
}

test('a mount walks the whole tree, directories and all', async()=>{
    const store = await createOpfsStore({ root: fakeRoot({
        'Game\\Data\\Config.WTF': 'source',
        'Game\\Setup.EXE': 'binary',
        'Empty': null,
    }) });

    const listed = store.list().map(entry=>`${entry.path}:${entry.directory}:${entry.size}`).sort();
    assert.deepEqual(listed, [
        'Empty:true:0',
        'Game:true:0',
        'Game\\Data:true:0',
        'Game\\Data\\Config.WTF:false:6',
        'Game\\Setup.EXE:false:6',
    ]);
    assert.deepEqual(store.stat('Game\\Data'), { directory: true, size: 0 });
    assert.equal(store.stat('game\\data'), null,
        'the store is a plain key/value map, case and all');
});

test('an opened file reads and writes back without awaiting anything', async()=>{
    const store = await createOpfsStore({ root: fakeRoot({ 'Save\\slot.dat': 'old' }) });

    await store.open('Save\\slot.dat');
    store.write('Save\\slot.dat', 0, bytes('new'));

    assert.equal(text(store.read('Save\\slot.dat', 0, 32)), 'new');
    assert.equal(store.stat('Save\\slot.dat')?.size, 3);
    assert.deepEqual([...store.read('Save\\slot.dat', 99, 4)], [],
        'a read that starts past the end is a length of zero, not a failure');
});

test('a write past the end grows the file with zeroes', async()=>{
    const store = await createOpfsStore({ root: fakeRoot({ 'a.dat': '' }) });

    await store.open('a.dat');
    store.write('a.dat', 4, Uint8Array.from([1, 2, 3]));

    assert.equal(store.stat('a.dat')?.size, 7);
    assert.deepEqual([...store.read('a.dat', 0, 7)], [0, 0, 0, 0, 1, 2, 3]);
});

test('truncation cuts and extends from the same call', async()=>{
    const store = await createOpfsStore({ root: fakeRoot({ 'a.dat': 'abc' }) });

    await store.open('a.dat');

    store.truncate('a.dat', 2);
    assert.deepEqual([...store.read('a.dat', 0, 8)], [0x61, 0x62]);
    store.truncate('a.dat', 4);
    assert.deepEqual([...store.read('a.dat', 0, 8)], [0x61, 0x62, 0, 0]);
    assert.equal(store.stat('a.dat')?.size, 4);
});

test('a flat path with backslashes becomes real nested directories', async()=>{
    const root = fakeRoot();
    const store = await createOpfsStore({ root });

    store.mkdir('Save');
    store.mkdir('Save\\Profile');
    await store.open('Save\\Profile\\slot.dat');
    store.write('Save\\Profile\\slot.dat', 0, bytes('kept'));
    await store.close();

    // A second mount sees only what actually reached the directory tree, which
    // is the point: the index is not allowed to be the only place it exists.
    const remounted = await createOpfsStore({ root });
    assert.deepEqual(remounted.list().map(entry=>entry.path).sort(),
        ['Save', 'Save\\Profile', 'Save\\Profile\\slot.dat']);
    assert.equal(remounted.stat('Save\\Profile\\slot.dat')?.size, 4);

    await remounted.open('Save\\Profile\\slot.dat');
    assert.equal(text(remounted.read('Save\\Profile\\slot.dat', 0, 32)), 'kept');
});

test('the pool drops the least recently used handle and can take it back', async()=>{
    const store = await createOpfsStore({
        root: fakeRoot({ 'a.dat': 'aaa', 'b.dat': 'bbb', 'c.dat': 'ccc' }),
        maxOpenHandles: 2,
    });

    await store.open('a.dat');
    await store.open('b.dat');
    store.write('a.dat', 0, bytes('AAA'));
    await store.open('c.dat');

    assert.equal(store.diagnostics().open, 2);
    assert.throws(()=>store.read('b.dat', 0, 3), { code: 'INVALID_HANDLE' },
        'b was the least recently used once a was written to');
    assert.equal(text(store.read('a.dat', 0, 3)), 'AAA');

    await store.open('b.dat');
    assert.equal(text(store.read('b.dat', 0, 3)), 'bbb', 'an evicted handle is reacquirable');
    assert.equal(store.diagnostics().open, 2);
});

test('the exclusive lock on a file is respected in both directions', async()=>{
    const root = fakeRoot({ 'a.dat': 'abc' });
    const first = await createOpfsStore({ root });
    const second = await createOpfsStore({ root });

    await first.open('a.dat');
    await assert.rejects(second.open('a.dat'), { code: 'SHARING_VIOLATION' },
        'one sync access handle per file, whoever is asking');

    await first.close();
    await second.open('a.dat');
    assert.equal(text(second.read('a.dat', 0, 3)), 'abc');
});

test('remove takes out a file and an empty directory, and nothing else', async()=>{
    const root = fakeRoot({ 'Game\\Setup.EXE': 'binary', 'Empty': null });
    const store = await createOpfsStore({ root });

    assert.throws(()=>store.remove('Game'), { code: 'DIRECTORY_NOT_EMPTY' });
    assert.throws(()=>store.remove('Nothing'), { code: 'NOT_FOUND' });

    store.remove('Game\\Setup.EXE');
    store.remove('Empty');
    await store.flush();

    const remounted = await createOpfsStore({ root });
    assert.deepEqual(remounted.list().map(entry=>entry.path), ['Game']);
});

test('a byte operation on a path nobody opened is a caller error', async()=>{
    const store = await createOpfsStore({ root: fakeRoot({ 'Game\\Setup.EXE': 'binary' }) });

    assert.throws(()=>store.read('Game\\Setup.EXE', 0, 1), { code: 'INVALID_HANDLE' });
    assert.throws(()=>store.write('Game\\Setup.EXE', 0, bytes('x')), { code: 'INVALID_HANDLE' });
    assert.throws(()=>store.write('Game', 0, bytes('x')), { code: 'IS_A_DIRECTORY' });
    assert.throws(()=>store.write('Missing\\slot.dat', 0, bytes('x')), { code: 'PATH_NOT_FOUND' });
    assert.throws(()=>store.write('Game\\Setup.EXE', -1, bytes('x')),
        { code: 'INVALID_PARAMETER' });
    assert.throws(()=>store.mkdir('Game'), { code: 'ALREADY_EXISTS' });

    await assert.rejects(store.open('Game'), { code: 'IS_A_DIRECTORY' });
    await assert.rejects(store.open('Missing\\slot.dat'), { code: 'PATH_NOT_FOUND' });
});

test('a build without synchronous access says so instead of hanging', async()=>{
    const root = fakeRoot({ 'a.dat': 'abc' });
    /** @param {import('./opfs-store.js').OpfsFile} handle */
    const stripped = handle=>({ kind: handle.kind, getFile: handle.getFile });

    // What a file handle looks like on the main thread: everything except the
    // one method the store cannot do without.
    /** @type {import('./opfs-store.js').OpfsDirectory} */
    const mainThread = {
        ...root,
        async getFileHandle(name, options){
            return stripped(await root.getFileHandle(name, options));
        },
        async *entries(){
            for await (const [name, handle] of root.entries())
            {
                yield [name, handle.kind === 'file' ? stripped(handle) : handle];
            }
        },
    };
    const store = await createOpfsStore({ root: mainThread });

    await assert.rejects(store.open('a.dat'), { code: 'ACCESS_DENIED' });
});
