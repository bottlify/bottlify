/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSync, replaceWhole, writeAll, writeAt } from './opfs-file.js';

/**
 * A file as the origin's file system has it inside a worker: a synchronous
 * handle that is the file's exclusive lock until closed, and a stream that
 * writes a copy swapped in at close, holding the lock while open and letting
 * it go when aborted. `short`: writes through the handle take that many bytes
 * less; `failStream`: the stream's writes after so many are refused for room.
 *
 * @param {{ sync?: boolean, short?: number, failStream?: number }} [options]
 */
function fakeFile({ sync = true, short = 0, failStream = Infinity } = {}){
    const file = {
        bytes: new Uint8Array(0),
        locked: false,
        /** @param {Uint8Array} into @param {Uint8Array} from @param {number} at */
        put(into, from, at){
            const grown = new Uint8Array(Math.max(into.length, at + from.length));
            grown.set(into);
            grown.set(from, at);
            return grown;
        },
        take(){
            if (file.locked)
            {
                throw new DOMException('locked', 'NoModificationAllowedError');
            }
            file.locked = true;
        },
        /** @param {{ keepExistingData?: boolean }} [how] */
        async createWritable(how = {}){
            file.take();
            let draft = how.keepExistingData ? file.bytes.slice() : new Uint8Array(0);
            let writes = 0;
            return {
                /** @param {any} part */
                async write(part){
                    if (++writes > failStream)
                    {
                        throw new DOMException('full', 'QuotaExceededError');
                    }
                    draft = part instanceof Uint8Array ? file.put(draft, part, draft.length)
                        : file.put(draft, part.data, part.position);
                },
                async close(){
                    file.bytes = draft;
                    file.locked = false;
                },
                async abort(){
                    file.locked = false;
                },
            };
        },
        ...sync ? {
            /** @param {{ mode?: string }} [how] */
            async createSyncAccessHandle(how){
                file.mode = how?.mode;
                file.take();
                // A turn between taking the lock and writing, as a real disk has.
                await new Promise(resolve=>setTimeout(resolve, 1));
                return {
                    getSize: ()=>file.bytes.length,
                    /** @param {Uint8Array} into @param {{ at: number }} where */
                    read(into, { at }){
                        const chunk = file.bytes.subarray(at, at + into.length);
                        into.set(chunk);
                        return chunk.length;
                    },
                    /** @param {Uint8Array} from @param {{ at: number }} where */
                    write(from, { at }){
                        const taken = from.subarray(0, Math.max(0, from.length - short));
                        file.bytes = file.put(file.bytes, taken, at);
                        return taken.length;
                    },
                    /** @param {number} size */
                    truncate(size){
                        file.bytes = file.bytes.slice(0, size);
                    },
                    flush(){},
                    close(){
                        file.locked = false;
                    },
                };
            },
        } : {},
        /** @type {string | undefined} */
        mode: undefined,
    };
    return file;
}

/** A directory of one file. @param {ReturnType<typeof fakeFile>} file */
const directoryOf = file=>({ getFileHandle: async()=>file });

const text = (/** @type {string} */ s)=>new TextEncoder().encode(s);
const read = (/** @type {Uint8Array} */ b)=>new TextDecoder().decode(b);

test('a write the disk takes in part is no write: it throws', ()=>{
    const access = { write: (/** @type {Uint8Array} */ from)=>from.length - 1 };
    assert.throws(()=>writeAll(access, text('abc'), 0), /2 of 3 bytes written at 0/);
    assert.doesNotThrow(()=>writeAll({ write: from=>from.length }, text('abc'), 0));
});

test('a file replaced through a handle that takes writes in part is a failure, the lock let go',
    async()=>{
        const file = fakeFile({ short: 1 });
        await assert.rejects(replaceWhole(directoryOf(file), 'current', [text('12')]),
            /1 of 2 bytes/);
        assert.equal(file.locked, false, 'the handle was closed');
    });

test('two writers of one file go one after the other, the last one\'s bytes kept', async()=>{
    const file = fakeFile();
    const directory = directoryOf(file);
    await Promise.all([replaceWhole(directory, 'index', [text('first')]),
        replaceWhole(directory, 'index', [text('second'), text('!')])]);
    assert.equal(read(file.bytes), 'second!');
    await Promise.all([writeAt(file, [[6, text('?')]]), writeAt(file, [[7, text('.')]])]);
    assert.equal(read(file.bytes), 'second?.');
});

test('a replace that must not be lost goes through the stream, and one cut short for room '
    + 'leaves the old file whole and its lock let go', async()=>{
    const file = fakeFile({ failStream: 1 });
    file.bytes = text('saved game');
    const directory = directoryOf(file);
    await assert.rejects(replaceWhole(directory, 'entry', [text('new '), text('game')],
        { atomic: true }), { name: 'QuotaExceededError' });
    assert.equal(read(file.bytes), 'saved game');
    assert.equal(file.locked, false, 'the stream was aborted');
    await replaceWhole(directory, 'entry', [text('one')], { atomic: true });
    assert.equal(read(file.bytes), 'one');
});

test('parts may come from a generator, read as they are written', async()=>{
    const file = fakeFile();
    /** @type {string[]} */
    const seen = [];
    await replaceWhole(directoryOf(file), 'records', (async function* (){
        for (const part of ['a', 'bc', 'def'])
        {
            seen.push(read(file.bytes));
            yield text(part);
        }
    })());
    assert.equal(read(file.bytes), 'abcdef');
    assert.deepEqual(seen, ['', 'a', 'abc'], 'each part on the file before the next is made');
});

test('without a synchronous handle writes at places go through one stream, the rest kept',
    async()=>{
        const file = fakeFile({ sync: false });
        file.bytes = text('0123456789');
        await writeAt(file, [[2, text('ab')], [10, text('XY')]]);
        assert.equal(read(file.bytes), '01ab456789XY');
    });

test('a handle is none where the thread has none or its calls are promises, shared where asked',
    async()=>{
        assert.equal(await openSync(fakeFile({ sync: false })), null);
        let closed = false;
        const early = { createSyncAccessHandle: async()=>({
            getSize: async()=>0,
            close: async()=>{
                closed = true;
            },
        }) };
        assert.equal(await openSync(early), null);
        assert.ok(closed, 'the early handle was closed again');
        const file = fakeFile();
        (await openSync(file, { shared: true }))?.close();
        assert.equal(file.mode, 'readwrite-unsafe');
        (await openSync(file))?.close();
        assert.equal(file.mode, undefined);
    });
