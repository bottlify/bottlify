/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGdiObjects } from './objects.js';

/** The kernel's handle table, reduced to what a GDI object needs from it. */
function fakeHandles(){
    /** @type {Map<number, { type: string, object: any }>} */
    const entries = new Map();
    let next = 0x20;
    return {
        entries,
        /** @param {string} type @param {any} object */
        open(type, object){
            const handle = next;
            next += 4;
            entries.set(handle, { type, object });
            return handle;
        },
        /** @param {number} handle */
        close(handle){
            if (!entries.delete(handle))
            {
                throw new Error('Invalid handle');
            }
        },
    };
}

function setup(){
    const handles = fakeHandles();
    return { handles, objects: createGdiObjects(handles) };
}

test('a created object remembers its type and what it was made of', ()=>{
    const { objects, handles } = setup();

    const pen = objects.create('pen', { style: 0, width: 2, color: 0xff0000 });

    assert.ok(pen > 0, 'a GDI object is named by a handle');
    assert.equal(handles.entries.get(pen)?.type, 'gdi');
    const record = objects.get(pen);
    assert.equal(record?.type, 'pen');
    assert.equal(record?.attributes.width, 2);
    assert.equal(record?.stock, false);
    assert.equal(record?.selectCount, 0);
});

test('two objects never share a handle, and a deleted one is gone', ()=>{
    const { objects } = setup();

    const first = objects.create('brush', {});
    const second = objects.create('brush', {});
    assert.notEqual(first, second);

    assert.equal(objects.remove(first), true);
    assert.equal(objects.get(first), null, 'a deleted handle names nothing');
    assert.equal(objects.remove(first), false, 'and deleting it again fails');
    assert.equal(objects.get(second)?.type, 'brush', 'its neighbour is untouched');
});

test('an object selected into a DC cannot be deleted', ()=>{
    const { objects, handles } = setup();
    const pen = objects.create('pen', {});

    objects.retain(pen);
    assert.equal(objects.remove(pen), false,
        'deleting a selected object would leave a DC pointing at nothing');
    assert.ok(objects.get(pen), 'and it survives the attempt intact');
    assert.ok(handles.entries.has(pen), 'the handle is not released either');

    objects.release(pen);
    assert.equal(objects.remove(pen), true, 'once nothing refers to it, it goes');
    assert.equal(handles.entries.has(pen), false);
});

test('the reference count is a count, not a flag', ()=>{
    const { objects } = setup();
    const brush = objects.create('brush', {});

    objects.retain(brush);
    objects.retain(brush);
    objects.release(brush);

    assert.equal(objects.get(brush)?.selectCount, 1);
    assert.equal(objects.remove(brush), false,
        'a second DC -- or a saved state -- still has it');
    objects.release(brush);
    assert.equal(objects.remove(brush), true);
});

test('a stock object is never deleted, and says so with success', ()=>{
    const { objects, handles } = setup();
    const stock = objects.defineStock('brush', { color: 0xffffff });

    assert.equal(objects.get(stock)?.stock, true);
    assert.equal(objects.remove(stock), true,
        'the documented answer is TRUE: deleting a stock object is harmless');
    assert.ok(objects.get(stock), 'harmless because nothing happened');
    assert.ok(handles.entries.has(stock));
});

test('a handle that was never issued resolves to nothing', ()=>{
    const { objects } = setup();

    assert.equal(objects.get(0), null);
    assert.equal(objects.get(0x9999), null);
    assert.equal(objects.remove(0x9999), false);
    // Retaining or releasing junk is what a bad HGDIOBJ from the guest looks
    // like; it must not throw its way out through the trap handler.
    objects.retain(0x9999);
    objects.release(0x9999);
});

test('releasing an object nobody holds does not go negative', ()=>{
    const { objects } = setup();
    const font = objects.create('font', {});

    objects.release(font);
    assert.equal(objects.get(font)?.selectCount, 0);
    assert.equal(objects.remove(font), true);
});

test('the table reports how many objects are alive', ()=>{
    const { objects } = setup();
    assert.equal(objects.count(), 0);

    const pen = objects.create('pen', {});
    objects.defineStock('brush', {});
    assert.equal(objects.count(), 2);

    objects.remove(pen);
    assert.equal(objects.count(), 1, 'stock objects are the ones that stay');
});
