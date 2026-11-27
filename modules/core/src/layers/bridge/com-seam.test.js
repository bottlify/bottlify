/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The COM seam over the bridge's real vtable publisher, called by slot
 * number through guest memory -- the path a program takes -- so what is
 * checked is what a program sees: the HRESULT, the out pointer, the counts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createVtables } from './internal/vtable.js';
import {
    createComPublisher, countedByTheObject, methodTable, IID_IUNKNOWN, IUNKNOWN_METHODS,
} from './com-seam.js';

const IID_ONE = '{00000001-0000-0000-C000-000000000046}';
const IID_TWO = '{00000002-0000-0000-C000-000000000046}';
const IID_NONE = '{0000000F-0000-0000-C000-000000000046}';
const E_POINTER = 0x80004003;
const E_NOINTERFACE = 0x80004002;
const E_INVALIDARG = 0x80070057;

/** Where a test lays its GUIDs and out pointers. */
const AT = { iid: 0x100, out: 0x120 };

function machine(){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    /** @type {Map<number, any>} */
    const traps = new Map();
    /** @type {Map<number, string>} */
    const names = new Map();
    let nextTrap = 0x10;
    let heap = 0x1000;
    const vtables = createVtables({
        memory: {
            readBytes: (/** @type {number} */ at, /** @type {number} */ length)=>
                bytes.slice(at, at + length),
            writeBytes: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>
                bytes.set(value, at),
            readU32: (/** @type {number} */ at)=>view.getUint32(at, true),
            writeU32: (/** @type {number} */ at, /** @type {number} */ value)=>
                view.setUint32(at, value >>> 0, true),
            // A 32-bit process: every pointer is a dword.
            writePointer: (/** @type {number} */ at, /** @type {number} */ value)=>
                view.setUint32(at, value >>> 0, true),
        },
        register: (name, fn)=>{
            const trap = nextTrap++;
            traps.set(trap, fn);
            names.set(trap, name);
            return trap;
        },
        heap: {
            allocate: size=>{
                const at = heap;
                heap += (size + 3) & ~3;
                return at;
            },
        },
    });
    const u32 = (/** @type {number} */ at)=>view.getUint32(at, true);
    return {
        vtables,
        u32,
        names,
        /** @param {string} guid */
        writeGuid(guid){
            const hex = guid.replace(/[{}-]/g, '');
            view.setUint32(AT.iid, Number.parseInt(hex.slice(0, 8), 16), true);
            view.setUint16(AT.iid + 4, Number.parseInt(hex.slice(8, 12), 16), true);
            view.setUint16(AT.iid + 6, Number.parseInt(hex.slice(12, 16), 16), true);
            for (let i = 0; i < 8; i++)
            {
                bytes[AT.iid + 8 + i] = Number.parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16);
            }
        },
        /** The address in `pointer`'s vtable slot. @param {number} pointer @param {number} slot */
        slot: (pointer, slot)=>u32(u32(pointer) + slot * 4),
        /**
         * @param {number} pointer @param {number} slot @param {number[]} [args]
         * @returns {number}
         */
        call(pointer, slot, args = []){
            const fn = traps.get(u32(u32(pointer) + slot * 4));
            assert.ok(fn, `slot ${slot} of ${pointer} is a trap`);
            return fn.handler([pointer, ...args]) >>> 0;
        },
        poison: ()=>view.setUint32(AT.out, 0xdeadbeef, true),
        setU32: (/** @type {number} */ at, /** @type {number} */ value)=>
            view.setUint32(at, value >>> 0, true),
    };
}

/** A library object counting its own references, one count for all interfaces. */
function counted(){
    let references = 1;
    /** @type {string[]} */
    const seen = [];
    return {
        seen,
        addRef: ()=>++references,
        release: ()=>(references = Math.max(0, references - 1)),
        get destroyed(){
            return references === 0;
        },
        /** @param {number[]} args */
        Draw(args){
            seen.push(`Draw ${args.join(',')}`);
            return 7;
        },
    };
}

const ONE = { id: IID_ONE, methods: [
    { name: 'Draw', argBytes: 8, invoke: (/** @type {any} */ api, /** @type {number[]} */ args)=>
        api.Draw(args) },
    { name: 'Nothing', argBytes: 4 },
] };
const TWO = { id: IID_TWO, methods: [{ name: 'Other', argBytes: 4, invoke: ()=>undefined }] };

/** @param {ReturnType<typeof machine>} m @param {any} [options] */
const publisherOn = (m, options = {})=>createComPublisher({
    publishInterface: (object, id)=>m.vtables.publish(object, id),
    unpublishInterface: (object, id)=>m.vtables.unpublish(object, id),
    ...options,
});

test('a vtable is IUnknown\'s three, then the interface\'s own, run on the library object', ()=>{
    const m = machine();
    const seam = publisherOn(m);
    const api = counted();
    const pointer = seam.publish(api, [ONE], IID_ONE);
    assert.notEqual(pointer, 0);
    assert.deepEqual([0, 1, 2, 3, 4].map(slot=>m.names.get(m.slot(pointer, slot))), [
        `${IID_ONE}::QueryInterface`, `${IID_ONE}::AddRef`, `${IID_ONE}::Release`,
        `${IID_ONE}::Draw`, `${IID_ONE}::Nothing`]);
    assert.equal(m.call(pointer, 3, [42]), 7);
    assert.deepEqual(api.seen, ['Draw 42'], 'the library object, with `this` taken off');
    assert.equal(m.call(pointer, 4), 0x80004001, 'a method with no body is E_NOTIMPL');
    assert.equal(seam.objectAt(pointer), api);
    assert.equal(seam.objectAt(0), null);
});

test('QueryInterface answers what is declared, and refuses the rest with E_NOINTERFACE', ()=>{
    const m = machine();
    const seam = publisherOn(m);
    const api = counted();
    const one = seam.publish(api, [ONE, TWO], IID_ONE);

    m.writeGuid(IID_TWO);
    m.poison();
    assert.equal(m.call(one, 0, [AT.iid, AT.out]), 0);
    const two = m.u32(AT.out);
    assert.notEqual(two, 0);
    assert.notEqual(two, one, 'a second interface is a second pointer');
    assert.equal(m.call(two, 2), 1, 'the query took a reference');
    assert.equal(m.names.get(m.slot(two, 3)), `${IID_TWO}::Other`, 'with its own table');

    m.writeGuid(IID_NONE);
    m.poison();
    assert.equal(m.call(one, 0, [AT.iid, AT.out]), E_NOINTERFACE);
    assert.equal(m.u32(AT.out), 0, 'the out pointer is cleared');
    assert.equal(m.call(one, 0, [AT.iid, 0]), E_POINTER, 'nowhere to answer is E_POINTER');
    m.poison();
    assert.equal(m.call(one, 0, [0, AT.out]), E_INVALIDARG, 'no interface named');
    assert.equal(m.u32(AT.out), 0);
    assert.deepEqual(seam.refused(), { [IID_NONE]: 1 }, 'what was refused is counted');
    assert.equal(m.call(one, 2), 0, 'and the refusals took no reference');
});

test('IUnknown is one pointer whichever interface it is asked through', ()=>{
    const m = machine();
    const seam = publisherOn(m);
    const api = counted();
    const one = seam.publish(api, [ONE, TWO], IID_ONE);
    const two = seam.publish(api, [ONE, TWO], IID_TWO);
    m.writeGuid(IID_IUNKNOWN);
    assert.equal(m.call(one, 0, [AT.iid, AT.out]), 0);
    const first = m.u32(AT.out);
    assert.equal(m.call(two, 0, [AT.iid, AT.out]), 0);
    assert.equal(m.u32(AT.out), first);
    assert.notEqual(first, one);
    assert.equal(m.names.get(m.slot(first, 0)), `${IID_IUNKNOWN}::QueryInterface`);
});

test('an interface marked `identity` is the IUnknown, a `sharedWith` one what it shares', ()=>{
    const m = machine();
    const seam = publisherOn(m);
    const api = counted();
    const whole = { ...ONE, identity: true };
    const front = { id: IID_TWO, sharedWith: IID_ONE, methods: [] };
    const one = seam.publish(api, [front, whole], IID_ONE);
    assert.equal(seam.publish(api, [front, whole], IID_TWO), one, 'the front part is the whole');
    m.writeGuid(IID_IUNKNOWN);
    assert.equal(m.call(one, 0, [AT.iid, AT.out]), 0);
    assert.equal(m.u32(AT.out), one);
    m.writeGuid(IID_TWO);
    assert.equal(m.call(one, 0, [AT.iid, AT.out]), 0);
    assert.equal(m.u32(AT.out), one);
});

test('AddRef and Release answer the object\'s count, and the last ends every pointer', ()=>{
    const m = machine();
    const seam = publisherOn(m);
    const api = counted();
    const one = seam.publish(api, [ONE, TWO], IID_ONE);
    const two = seam.publish(api, [ONE, TWO], IID_TWO);
    assert.equal(m.call(one, 1), 2);
    assert.equal(m.call(two, 2), 1);
    assert.equal(seam.count(), 2);
    assert.equal(m.call(one, 2), 0);
    assert.equal(seam.objectAt(one), null, 'the way back is gone');
    assert.equal(seam.objectAt(two), null, 'from every interface');
    assert.equal(seam.count(), 0);
    assert.equal(m.vtables.objectAt(two), null, 'and the bridge let both pointers go');
});

test('a counting of the library\'s own decides the answers and when the object is over', ()=>{
    const m = machine();
    /** @type {string[]} */
    const told = [];
    const seam = publisherOn(m, {
        counting: (/** @type {import('./com-seam.js').ComSeat} */ seat, /** @type {any} */ context)=>{
            let count = 1;
            return {
                addRef: (/** @type {string | undefined} */ id)=>{
                    told.push(`addRef ${id} ${context}`);
                    if (id !== undefined)
                    {
                        seat.remember(id);
                    }
                    return ++count + 100;
                },
                release: (/** @type {string | undefined} */ id)=>{
                    told.push(`release ${id}`);
                    count--;
                    if (count === 0)
                    {
                        told.push(`gone with ${seat.pointers.size} pointers`);
                        seat.forgetAll();
                    }
                    return count;
                },
                destroyed: ()=>count === 0,
                // The bridge keeps the pointers: only `forgetAll` ends the
                // way back from them.
                reachable: ()=>true,
            };
        },
    });
    const api = {};
    const one = seam.publish(api, [ONE, TWO], IID_ONE, 'made');
    m.writeGuid(IID_TWO);
    assert.equal(m.call(one, 0, [AT.iid, AT.out]), 0);
    const two = m.u32(AT.out);
    assert.equal(seam.objectAt(two), api, 'a query\'s answer the counting remembered');
    assert.equal(m.call(two, 2), 1);
    assert.equal(m.call(one, 2), 0);
    assert.deepEqual(told, [`addRef ${IID_TWO} made`, `release ${IID_TWO}`, `release ${IID_ONE}`,
        'gone with 2 pointers']);
    assert.equal(seam.objectAt(one), null);
    assert.equal(seam.objectAt(two), null);
    assert.notEqual(m.vtables.objectAt(one), null, 'what the bridge keeps is the bridge\'s');
});

test('an object kept by something else is still called through its pointer at zero', ()=>{
    const m = machine();
    const seam = publisherOn(m);
    let kept = true;
    const api = Object.assign(counted(), { reachable: ()=>kept });
    const one = seam.publish(api, [ONE], IID_ONE);
    assert.equal(m.call(one, 2), 0);
    assert.equal(m.call(one, 3, [1]), 7, 'still answers');
    kept = false;
    const other = counted();
    const elsewhere = seam.publish(other, [ONE], IID_ONE);
    assert.equal(m.call(elsewhere, 2), 0, 'any release asks again');
    assert.equal(m.vtables.objectAt(one), null);
});

test('one method list per description, whichever object it serves', ()=>{
    const m = machine();
    const seam = publisherOn(m);
    const a = seam.publish(counted(), [ONE], IID_ONE);
    const b = seam.publish(counted(), [ONE], IID_ONE);
    assert.notEqual(a, b, 'two objects, two identities');
    assert.equal(m.u32(a), m.u32(b), 'one vtable');
    assert.equal(methodTable(ONE), methodTable(ONE));
    assert.deepEqual(methodTable(ONE).slice(0, 3), IUNKNOWN_METHODS);
    assert.deepEqual(methodTable({ bare: true, methods: ONE.methods }), ONE.methods,
        'a bare interface has no IUnknown');
});

test('a method that runs in the guest keeps its slot, and its trap is the bridge\'s', ()=>{
    const m = machine();
    const seam = publisherOn(m);
    /** @type {number[]} */
    const fallbacks = [];
    const guest = { id: IID_ONE, methods: [{ name: 'Fast', argBytes: 4,
        guest: (/** @type {{ trap: number }} */ { trap })=>{
            fallbacks.push(trap);
            return 0xabc0;
        },
        invoke: ()=>3 }] };
    const pointer = seam.publish(counted(), [guest], IID_ONE);
    assert.equal(m.slot(pointer, 3), 0xabc0);
    assert.equal(m.names.get(fallbacks[0]), `${IID_ONE}::Fast`);
});

test('`offers` narrows a declared list per object, and `nullInterface` keeps the out pointer', ()=>{
    const m = machine();
    const seam = publisherOn(m, {
        offers: (/** @type {any} */ api, /** @type {string} */ id)=>api.answers.includes(id),
        nullInterface: 'pointer',
    });
    const api = Object.assign(counted(), { answers: [IID_ONE] });
    const one = seam.publish(api, [ONE, TWO], IID_ONE);
    m.writeGuid(IID_TWO);
    assert.equal(m.call(one, 0, [AT.iid, AT.out]), E_NOINTERFACE);
    m.writeGuid(IID_IUNKNOWN);
    assert.equal(m.call(one, 0, [AT.iid, AT.out]), 0, 'IUnknown is not narrowed');
    m.poison();
    assert.equal(m.call(one, 0, [0, AT.out]), E_POINTER);
    assert.equal(m.u32(AT.out), 0xdeadbeef);
});

test('unpublish gives back every interface of an object the program cannot release', ()=>{
    const m = machine();
    const seam = publisherOn(m);
    const api = counted();
    const bare = { id: IID_ONE, bare: true, methods: ONE.methods };
    const pointer = seam.publish(api, [bare], IID_ONE);
    assert.equal(m.names.get(m.slot(pointer, 0)), `${IID_ONE}::Draw`);
    seam.unpublish(api);
    assert.equal(seam.objectAt(pointer), null);
    assert.equal(m.vtables.objectAt(pointer), null);
});

test('the default counting forwards to the object, with the interface it came through', ()=>{
    /** @type {any[]} */
    const calls = [];
    const counting = countedByTheObject(/** @type {any} */ ({ api: {
        addRef: (/** @type {string} */ id)=>calls.push(['addRef', id]) && 5,
        release: (/** @type {string} */ id)=>calls.push(['release', id]) && 4,
    } }));
    assert.equal(counting.addRef(IID_ONE), 5);
    assert.equal(counting.release(IID_ONE), 4);
    assert.equal(counting.destroyed(), false);
    assert.deepEqual(calls, [['addRef', IID_ONE], ['release', IID_ONE]]);
    const silent = countedByTheObject(/** @type {any} */ ({ api: {} }));
    assert.equal(silent.addRef(undefined), 1, 'an object that keeps no count answers one');
    assert.equal(silent.release(undefined), 0);
});

test('a description may refuse with a word of its own, and an object may answer less', ()=>{
    const m = machine();
    const E_REFUSED = 0x88760096;
    const seam = publisherOn(m, {
        answers: (/** @type {any} */ api, /** @type {string} */ id)=>id !== IID_ONE || api.self,
        refusal: ()=>0x80000001,
    });
    const api = Object.assign(counted(), { self: false });
    const refusing = { ...TWO, refuses: ()=>E_REFUSED };
    const one = seam.publish(api, [ONE, refusing], IID_ONE);
    m.writeGuid(IID_TWO);
    m.poison();
    assert.equal(m.call(one, 0, [AT.iid, AT.out]), E_REFUSED, 'the description\'s word');
    assert.equal(m.u32(AT.out), 0);
    assert.equal(seam.publish(api, [ONE, refusing], IID_TWO), 0, 'nor published');
    m.writeGuid(IID_ONE);
    assert.equal(m.call(one, 0, [AT.iid, AT.out]), 0x80000001,
        'published as it and not answered for it: the object\'s word');
    api.self = true;
    assert.equal(m.call(one, 0, [AT.iid, AT.out]), 0);
    assert.equal(m.u32(AT.out), one);
});

test('an interface counted in the host keeps IUnknown at its traps, and answers strangers', ()=>{
    const m = machine();
    const seam = publisherOn(m);
    const hosted = { ...ONE, countedInHost: true, stranger: 0x88760091 };
    const pointer = seam.publish(counted(), [hosted], IID_ONE);
    assert.equal(m.names.get(m.slot(pointer, 1)), `${IID_ONE}::AddRef`, 'the trap, not guest code');
    assert.equal(m.names.get(m.slot(pointer, 2)), `${IID_ONE}::Release`);
    // A pointer that never was one of its objects, with its table word.
    const stranger = 0x200;
    m.setU32(stranger, m.u32(pointer));
    assert.equal(m.call(stranger, 3, [1]), 0x88760091);
    assert.equal(m.call(stranger, 2), 0, 'and counts nothing');
    assert.equal(m.call(pointer, 3, [1]), 7, 'its own objects answer as ever');
});

test('the way back knows which interface a pointer is, and forwards what a release owes', ()=>{
    const m = machine();
    let owed = 0;
    const seam = publisherOn(m, {
        counting: (/** @type {import('./com-seam.js').ComSeat} */ seat)=>({
            ...countedByTheObject(seat),
            afterRelease: ()=>{
                owed++;
            },
        }),
    });
    const api = counted();
    const one = seam.publish(api, [ONE, TWO], IID_ONE);
    const two = seam.publish(api, [ONE, TWO], IID_TWO);
    assert.equal(seam.interfaceAt(one), IID_ONE);
    assert.equal(seam.interfaceAt(two), IID_TWO);
    assert.equal(seam.interfaceAt(0x7777), null);
    m.call(two, 1);
    m.call(two, 2);
    assert.equal(owed, 1, 'the bridge asked after the release');
});

test('a table can have a head of its own, one list per head and description', ()=>{
    const head = Object.freeze([{ name: 'QueryInterface', argBytes: 12 },
        { name: 'AddRef', argBytes: 4 }, { name: 'Release', argBytes: 4 }]);
    const own = methodTable(ONE, head);
    assert.equal(own[0], head[0]);
    assert.equal(methodTable(ONE, head), own);
    assert.notEqual(methodTable(ONE), own);
    assert.equal(methodTable(ONE)[0], IUNKNOWN_METHODS[0]);
});
