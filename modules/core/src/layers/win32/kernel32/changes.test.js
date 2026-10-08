/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Change notifications over the real filesystem layer and the volume adapter,
 * as kernel32's change tests drive them: each kind of change a filter names
 * signals the handle, the handle stays signalled until FindNext, and the
 * parameter checks answer what Windows answers. The kernel's events are a
 * stand-in that only records whether each is set.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesystemModule } from '../../filesystem/module.js';
import { createVolume } from './vfs.js';
import {
    createChangeNotifications, FILE_NOTIFY_CHANGE_ATTRIBUTES, FILE_NOTIFY_CHANGE_DIR_NAME,
    FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE,
} from './changes.js';

const INVALID_HANDLE_VALUE = 0xffffffff;

function fakeKernel(){
    /** @type {Map<number, { type: string, object: any }>} */
    const table = new Map();
    let next = 0x80;
    return {
        table,
        /** @param {any} options */
        createEvent: options=>({ kind: 'event', signalled: false, ...options }),
        /** @param {any} event */
        setEvent: event=>{
            event.signalled = true;
        },
        /** @param {any} event */
        resetEvent: event=>{
            event.signalled = false;
        },
        handles: {
            /** @param {string} type @param {any} object */
            open: (type, object)=>{
                const handle = next;
                next += 4;
                table.set(handle, { type, object });
                return handle;
            },
            /** @param {number} handle */
            resolve: handle=>table.get(handle)?.object ?? null,
            /** @param {number} handle */
            typeOf: handle=>table.get(handle)?.type,
            /** @param {number} handle */
            close: handle=>(table.delete(handle) ? true : null),
            /** @param {any} object */
            holds: object=>[...table.values()].some(held=>held.object === object),
        },
    };
}

async function setup(){
    const fs = await filesystemModule.create({});
    const volume = /** @type {any} */ (createVolume(fs));
    volume.mkdir('C:\\Saves');
    volume.mkdir('C:\\Saves\\Old');
    const kernel = fakeKernel();
    const memory = new Uint8Array(0x1000);
    /** @type {number[]} */
    const errors = [];
    /** @type {string[]} */
    const said = [];
    const fns = createChangeNotifications({
        kernel,
        volume,
        readMemory: (at, length)=>memory.slice(at, at + length),
        setLastError: code=>errors.push(code),
        divergence: api=>said.push(api),
    });
    /** @param {number} at @param {string} text */
    const ansi = (at, text)=>{
        memory.set([...text].map(c=>c.charCodeAt(0)).concat(0), at);
        return at;
    };
    /** @param {number} at @param {string} text */
    const wide = (at, text)=>{
        memory.set([...text, '\0'].flatMap(c=>[c.charCodeAt(0), 0]), at);
        return at;
    };
    /** @param {number} handle */
    const isSet = handle=>kernel.handles.resolve(handle).signalled === true;
    /** @param {string} path @param {number[]} bytes */
    const write = (path, bytes)=>{
        const node = volume.open(path, { read: true, write: true, create: true });
        volume.write(node, 0, new Uint8Array(bytes));
        volume.close(node);
    };
    return { fns, volume, kernel, errors, said, ansi, wide, isSet, write };
}

test('a file made, renamed and deleted signals a file-name watch, once until FindNext', async()=>{
    const { fns, volume, isSet, ansi, write } = await setup();
    assert.equal(fns.FindFirstChangeNotificationA.argBytes, 12);
    const handle = fns.FindFirstChangeNotificationA.handler(
        [ansi(0x100, 'C:\\Saves'), 0, FILE_NOTIFY_CHANGE_FILE_NAME]);
    assert.notEqual(handle, INVALID_HANDLE_VALUE);
    assert.equal(isSet(handle), false, 'nothing has changed yet');

    write('C:\\Saves\\slot1.sav', [1, 2, 3]);
    assert.equal(isSet(handle), true, 'a file made');
    assert.equal(isSet(handle), true, 'and still set: a wait does not reset it');
    assert.equal(fns.FindNextChangeNotification.handler([handle]), 1);
    assert.equal(isSet(handle), false, 'FindNext waits for the next one');

    volume.rename('C:\\Saves\\slot1.sav', 'C:\\Saves\\slot2.sav');
    assert.equal(isSet(handle), true, 'a file renamed');
    fns.FindNextChangeNotification.handler([handle]);
    volume.remove('C:\\Saves\\slot2.sav');
    assert.equal(isSet(handle), true, 'a file deleted');
    fns.FindNextChangeNotification.handler([handle]);

    volume.mkdir('C:\\Saves\\New');
    assert.equal(isSet(handle), false, 'a directory is not a file name');
    write('C:\\Other.txt', [1]);
    assert.equal(isSet(handle), false, 'nor is a file in another directory');
    write('C:\\Saves\\Old\\deep.sav', [1]);
    assert.equal(isSet(handle), false, 'nor one below, without the subtree');

    assert.equal(fns.FindCloseChangeNotification.handler([handle]), 1);
    assert.equal(fns.FindNextChangeNotification.handler([handle]), 0, 'closed');
});

test('each kind a filter names is the change that signals it', async()=>{
    const { fns, volume, isSet, ansi, write } = await setup();
    write('C:\\Saves\\a.sav', [1]);
    /** @param {number} filter @param {boolean} [subtree] */
    const watch = (filter, subtree = false)=>fns.FindFirstChangeNotificationA.handler(
        [ansi(0x100, 'C:\\Saves'), subtree ? 1 : 0, filter]);

    const directories = watch(FILE_NOTIFY_CHANGE_DIR_NAME);
    const attributes = watch(FILE_NOTIFY_CHANGE_ATTRIBUTES);
    const size = watch(FILE_NOTIFY_CHANGE_SIZE);
    const lastWrite = watch(FILE_NOTIFY_CHANGE_LAST_WRITE);
    const subtree = watch(FILE_NOTIFY_CHANGE_FILE_NAME, true);

    volume.setAttributes('C:\\Saves\\a.sav', 1);
    assert.deepEqual([directories, attributes, size, lastWrite].map(isSet),
        [false, true, false, false], 'an attribute set');
    write('C:\\Saves\\a.sav', [1, 2, 3, 4]);
    assert.deepEqual([directories, size, lastWrite].map(isSet), [false, true, true],
        'a write is size and last write');
    volume.mkdir('C:\\Saves\\Fresh');
    assert.equal(isSet(directories), true, 'a directory made');
    write('C:\\Saves\\Old\\deep.sav', [1]);
    assert.equal(isSet(subtree), true, 'a file below, for the subtree');
});

test('a change while already signalled signals again at once after FindNext', async()=>{
    const { fns, isSet, ansi, write } = await setup();
    const handle = fns.FindFirstChangeNotificationA.handler(
        [ansi(0x100, 'C:\\Saves'), 0, FILE_NOTIFY_CHANGE_FILE_NAME]);
    write('C:\\Saves\\one.sav', [1]);
    write('C:\\Saves\\two.sav', [1]);
    fns.FindNextChangeNotification.handler([handle]);
    assert.equal(isSet(handle), true, 'the second change was kept');
    fns.FindNextChangeNotification.handler([handle]);
    assert.equal(isSet(handle), false);
});

test('the wide form watches the same, and the watched directory\'s removal is told', async()=>{
    const { fns, volume, isSet, wide } = await setup();
    const handle = fns.FindFirstChangeNotificationW.handler(
        [wide(0x100, 'C:\\Saves\\Old'), 0, FILE_NOTIFY_CHANGE_DIR_NAME]);
    assert.notEqual(handle, INVALID_HANDLE_VALUE);
    volume.remove('C:\\Saves\\Old');
    assert.equal(isSet(handle), true);
});

test('a handle closed by CloseHandle drops its watch at the next change', async()=>{
    const { fns, kernel, ansi, write } = await setup();
    const handle = fns.FindFirstChangeNotificationA.handler(
        [ansi(0x100, 'C:\\Saves'), 0, FILE_NOTIFY_CHANGE_FILE_NAME]);
    const event = kernel.handles.resolve(handle);
    kernel.handles.close(handle);
    write('C:\\Saves\\late.sav', [1]);
    assert.equal(event.signalled, false, 'nobody holds it, so nobody is told');
});

test('the parameter checks answer what Windows answers', async()=>{
    const { fns, errors, ansi, write } = await setup();
    write('C:\\Saves\\file.sav', [1]);
    const first = fns.FindFirstChangeNotificationA;
    /** @param {number} path @param {number} filter */
    const refused = (path, filter)=>first.handler([path, 0, filter]);
    assert.equal(refused(ansi(0x100, 'not-a-file'), 1), INVALID_HANDLE_VALUE);
    assert.equal(errors.at(-1), 2, 'ERROR_FILE_NOT_FOUND');
    assert.equal(refused(ansi(0x100, 'C:\\Nowhere\\Deeper'), 1), INVALID_HANDLE_VALUE);
    assert.equal(errors.at(-1), 3, 'ERROR_PATH_NOT_FOUND');
    assert.equal(refused(0, 1), INVALID_HANDLE_VALUE);
    assert.equal(errors.at(-1), 3, 'a NULL path: ERROR_PATH_NOT_FOUND');
    assert.equal(refused(ansi(0x100, 'C:\\Saves\\file.sav'), 1), INVALID_HANDLE_VALUE);
    assert.equal(errors.at(-1), 267, 'a file is not a directory: ERROR_DIRECTORY');
    assert.equal(refused(ansi(0x100, 'C:\\Saves'), 0), INVALID_HANDLE_VALUE);
    assert.equal(refused(ansi(0x100, 'C:\\Saves'), 0x200), INVALID_HANDLE_VALUE);
    assert.deepEqual(errors.slice(-2), [87, 87], 'no filter, or one past the flags');

    assert.equal(fns.FindNextChangeNotification.argBytes, 4);
    assert.equal(fns.FindCloseChangeNotification.argBytes, 4);
    assert.equal(fns.FindNextChangeNotification.handler([0]), 0);
    assert.equal(fns.FindCloseChangeNotification.handler([0]), 0);
    assert.deepEqual(errors.slice(-2), [6, 6], 'ERROR_INVALID_HANDLE');
});

test('with no volume handed over, the watch is refused and said', ()=>{
    /** @type {number[]} */
    const errors = [];
    /** @type {string[]} */
    const said = [];
    const fns = createChangeNotifications({
        kernel: fakeKernel(),
        readMemory: ()=>new Uint8Array([0x43, 0]),
        setLastError: code=>errors.push(code),
        divergence: api=>said.push(api),
    });
    assert.equal(fns.FindFirstChangeNotificationA.handler([0x100, 0, 1]), INVALID_HANDLE_VALUE);
    assert.deepEqual(errors, [50]);
    assert.deepEqual(said, ['FindFirstChangeNotification']);
});
