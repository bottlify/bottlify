/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatGuid, parseGuid } from './guid.js';
import { createComObject } from './objects.js';
import {
    FMTID_DOC_SUMMARY_INFORMATION, FMTID_SUMMARY_INFORMATION, FMTID_USER_DEFINED_PROPERTIES,
    PID_FIRST_USABLE, VT, createPropertySetFunctions, decodePropertySet, formatOfName, nameOfFormat,
} from './propset.js';

const IID_IPROPERTYSETSTORAGE = '{0000013A-0000-0000-C000-000000000046}';

test('a property set is stored under its documented name or its FMTID in 26 characters', ()=>{
    // stg_prop.c testFmtId: the two summary sets by name, the user-defined
    // one beside the document summary, and any other FMTID five bits a
    // character, a capital where a byte begins.
    assert.equal(nameOfFormat(FMTID_SUMMARY_INFORMATION), '\x05SummaryInformation');
    assert.equal(nameOfFormat(FMTID_DOC_SUMMARY_INFORMATION), '\x05DocumentSummaryInformation');
    assert.equal(nameOfFormat(FMTID_USER_DEFINED_PROPERTIES), '\x05DocumentSummaryInformation');
    assert.equal(nameOfFormat(IID_IPROPERTYSETSTORAGE), '\x050jaaaaaaAaaaaadaAaaaaaaaGc');
    assert.equal(formatOfName('\x050jaaaaaaAaaaaadaAaaaaaaaGc'), IID_IPROPERTYSETSTORAGE);
    assert.equal(formatOfName('\x050JAAAAAAAAAAAADAAAAAAAAAGC'), IID_IPROPERTYSETSTORAGE,
        'letters of either case');
    assert.equal(formatOfName('\x05DOCUMENTSUMMARYINFORMATION'), FMTID_DOC_SUMMARY_INFORMATION);
    assert.equal(formatOfName('\x05short'), null);
    assert.equal(formatOfName('\x050jaaaaaaAaaaaadaAaaaaaaa!c'), null);
    for (const fmtid of ['{12345678-DEAD-BEEF-0001-020304050607}',
        '{FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF}'])
    {
        assert.equal(formatOfName(nameOfFormat(fmtid)), fmtid);
    }
});

test('FmtIdToPropStgName and PropStgNameToFmtId check their arguments as Windows does', ()=>{
    const { bytes, fns } = world();
    const FMTID = 0x100;
    const NAME = 0x200;
    const OUT = 0x300;
    bytes.set(/** @type {Uint8Array} */ (parseGuid(FMTID_SUMMARY_INFORMATION)), FMTID);
    assert.equal(fns.FmtIdToPropStgName.handler([0, NAME]) >>> 0, 0x80070057);
    assert.equal(fns.FmtIdToPropStgName.handler([FMTID, 0]) >>> 0, 0x80070057);
    assert.equal(fns.FmtIdToPropStgName.handler([FMTID, NAME]), 0);
    const units = [...new Uint16Array(bytes.buffer.slice(NAME, NAME + 40))];
    assert.equal(String.fromCharCode(...units.slice(0, units.indexOf(0))),
        '\x05SummaryInformation');

    assert.equal(fns.PropStgNameToFmtId.handler([0, 0]) >>> 0, 0x80070057);
    assert.equal(fns.PropStgNameToFmtId.handler([0, OUT]) >>> 0, 0x800300fc,
        'STG_E_INVALIDNAME');
    assert.equal(fns.PropStgNameToFmtId.handler([NAME, 0]) >>> 0, 0x80070057);
    assert.equal(fns.PropStgNameToFmtId.handler([NAME, OUT]), 0);
    assert.deepEqual(bytes.slice(OUT, OUT + 16), bytes.slice(FMTID, FMTID + 16));
});

const IID_ISTREAM = '{0000000C-0000-0000-C000-000000000046}';
const IID_ISTORAGE = '{0000000B-0000-0000-C000-000000000046}';
const S_OK = 0;
const S_FALSE = 1;
const STG_E_INVALIDPARAMETER = 0x80030057 | 0;
const STG_E_INVALIDFLAG = 0x800300ff | 0;
const STG_E_FILENOTFOUND = 0x80030002 | 0;
const STGM_READWRITE_EXCLUSIVE = 0x12;
const STGM_CREATE = 0x1000;
const PROPSETFLAG_ANSI = 2;

/**
 * Memory, task memory, and a bridge between the two kinds of object a
 * property set meets: ours, called through their methods, and a storage
 * and its streams standing for the program's, kept as bytes by name.
 */
function world(){
    const bytes = new Uint8Array(0x80000);
    const view = new DataView(bytes.buffer);
    let next = 0x10000;
    /** @type {Map<number, number>} */
    const live = new Map();
    const heap = {
        live,
        /** @param {number} size */
        allocate(size){
            const at = next;
            next += (Math.max(size, 4) + 15) & ~15;
            live.set(at, size);
            return at;
        },
        /** @param {number} at */
        free: at=>live.delete(at),
    };
    /** @type {Map<number, { object?: any, iid?: string, slots?: ((args: number[]) => any)[] }>} */
    const pointers = new Map();
    let nextPointer = 0x70000;
    /** @param {any} object @param {string} iid */
    const publish = (object, iid)=>{
        for (const [pointer, entry] of pointers)
        {
            if (entry.object === object && entry.iid === iid)
            {
                return pointer;
            }
        }
        const pointer = nextPointer += 8;
        pointers.set(pointer, { object, iid });
        return pointer;
    };
    /** @param {number} pointer @param {number} slot @param {number[]} args */
    const callMethod = async(pointer, slot, args)=>{
        const entry = pointers.get(pointer);
        assert.ok(entry, `no object at 0x${pointer.toString(16)}`);
        if (entry.slots)
        {
            return entry.slots[slot](args);
        }
        const method = entry.object.interfaceFor(entry.iid).methods[slot];
        if (method.builtin === 'addRef')
        {
            return entry.object.addRef();
        }
        if (method.builtin === 'release')
        {
            if (entry.object.refCount === 1 && entry.object.lastRelease)
            {
                await entry.object.lastRelease();
            }
            return entry.object.release();
        }
        assert.ok(method.invoke, `${method.name} is ours to answer`);
        return method.invoke(entry.object, args);
    };
    /** @param {number} address */
    const wide = address=>{
        let text = '';
        for (let at = address; view.getUint16(at, true) !== 0; at += 2)
        {
            text += String.fromCharCode(view.getUint16(at, true));
        }
        return text;
    };

    /** The program's storage: its streams' bytes by name. @type {Map<string, Uint8Array>} */
    const files = new Map();
    /** @param {string} name */
    const streamOver = name=>{
        let position = 0;
        const pointer = nextPointer += 8;
        /** @param {Uint8Array} data */
        const set = data=>files.set(name, data);
        const get = ()=>/** @type {Uint8Array} */ (files.get(name));
        pointers.set(pointer, { slots: [
            ([iid, out])=>{
                const asked = formatGuid(bytes.slice(iid, iid + 16));
                view.setUint32(out, asked === IID_ISTREAM ? pointer : 0, true);
                return asked === IID_ISTREAM ? S_OK : 0x80004002 | 0;
            },
            ()=>2,
            ()=>{
                return 1;
            },
            ([buffer, count, read])=>{
                const data = get().subarray(position, position + count);
                bytes.set(data, buffer);
                position += data.length;
                if (read)
                {
                    view.setUint32(read, data.length, true);
                }
                return S_OK;
            },
            ([buffer, count])=>{
                const data = new Uint8Array(Math.max(get().length, position + count));
                data.set(get());
                data.set(bytes.slice(buffer, buffer + count), position);
                set(data);
                position += count;
                return S_OK;
            },
            ([low, , origin, out])=>{
                position = origin === 2 ? get().length + low : origin === 1 ? position + low : low;
                if (out)
                {
                    view.setUint32(out, position, true);
                    view.setUint32(out + 4, 0, true);
                }
                return S_OK;
            },
            ([size])=>{
                const data = new Uint8Array(size);
                data.set(get().subarray(0, size));
                set(data);
                return S_OK;
            },
            ()=>S_OK,
            ()=>S_OK,
        ] });
        return pointer;
    };
    const STORAGE = nextPointer += 8;
    /** @type {((args: number[]) => any)[]} */
    const storageSlots = [];
    storageSlots[0] = ([iid, out])=>{
        const asked = formatGuid(bytes.slice(iid, iid + 16));
        view.setUint32(out, asked === IID_ISTORAGE ? STORAGE : 0, true);
        return asked === IID_ISTORAGE ? S_OK : 0x80004002 | 0;
    };
    storageSlots[1] = ()=>2;
    storageSlots[2] = ()=>1;
    storageSlots[3] = ([name, , , , out])=>{
        files.set(wide(name), new Uint8Array(0));
        view.setUint32(out, streamOver(wide(name)), true);
        return S_OK;
    };
    storageSlots[4] = ([name, , , , out])=>{
        if (!files.has(wide(name)))
        {
            return STG_E_FILENOTFOUND;
        }
        view.setUint32(out, streamOver(wide(name)), true);
        return S_OK;
    };
    storageSlots[11] = ([, , , out])=>{
        const names = [...files.keys()];
        const enumerator = nextPointer += 8;
        pointers.set(enumerator, { slots: [()=>0, ()=>2, ()=>1, ([, item])=>{
            const name = names.shift();
            if (name === undefined)
            {
                return S_FALSE;
            }
            const block = heap.allocate((name.length + 1) * 2);
            for (let index = 0; index <= name.length; index++)
            {
                view.setUint16(block + index * 2, index < name.length ? name.charCodeAt(index) : 0,
                    true);
            }
            view.setUint32(item, block, true);
            view.setUint32(item + 4, 2, true);
            return S_OK;
        }] });
        view.setUint32(out, enumerator, true);
        return S_OK;
    };
    storageSlots[12] = ([name])=>(files.delete(wide(name)) ? S_OK : STG_E_FILENOTFOUND);
    pointers.set(STORAGE, { slots: storageSlots });

    const fns = createPropertySetFunctions({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        heap,
        callMethod,
        queryPointer: async(pointer, iid)=>{
            const out = heap.allocate(4);
            const at = heap.allocate(16);
            bytes.set(/** @type {Uint8Array} */ (parseGuid(iid)), at);
            const hr = await callMethod(pointer, 0, [at, out]);
            return hr < 0 ? 0 : view.getUint32(out, true);
        },
        callerThread: ()=>null,
        makeObject: (clsid, definition)=>createComObject(clsid, definition),
        publish,
    });
    let scratch = 0x1000;
    /** @param {number} size */
    const take = size=>{
        const at = scratch;
        scratch += (size + 15) & ~15;
        return at;
    };
    /** @param {string} value */
    const guid = value=>{
        const at = take(16);
        bytes.set(/** @type {Uint8Array} */ (parseGuid(value)), at);
        return at;
    };
    /** @param {string} value */
    const text = value=>{
        const at = take((value.length + 1) * 2);
        for (let index = 0; index <= value.length; index++)
        {
            view.setUint16(at + index * 2, index < value.length ? value.charCodeAt(index) : 0,
                true);
        }
        return at;
    };
    /** @param {string} value */
    const ansi = value=>{
        const at = take(value.length + 1);
        bytes.set([...value].map(character=>character.charCodeAt(0)), at);
        bytes[at + value.length] = 0;
        return at;
    };
    /** A PROPSPEC by identifier or by name. @param {number | string} id */
    const spec = id=>{
        const at = take(8);
        view.setUint32(at, typeof id === 'number' ? 1 : 0, true);
        view.setUint32(at + 4, typeof id === 'number' ? id : text(id), true);
        return at;
    };
    /** A PROPVARIANT. @param {number} vt @param {number} [value] */
    const variant = (vt, value = 0)=>{
        const at = take(16);
        view.setUint16(at, vt, true);
        view.setUint32(at + 8, value, true);
        return at;
    };
    const out = ()=>take(4);
    /** @param {number} at */
    const u32 = at=>view.getUint32(at, true);
    /** @param {number} pointer @param {number} slot @param {...number} args */
    const m = async(pointer, slot, ...args)=>(await callMethod(pointer, slot, args)) | 0;
    return { bytes, view, heap, fns, files, STORAGE, guid, text, ansi, spec, variant, out, u32, m,
        wide, publish, pointers };
}

/** IPropertyStorage's slots, and IPropertySetStorage's. */
const P = Object.freeze({ Release: 2, ReadMultiple: 3, WriteMultiple: 4, DeleteMultiple: 5,
    ReadPropertyNames: 6, WritePropertyNames: 7, Commit: 9, Revert: 10, Enum: 11, Stat: 14 });
const SET = Object.freeze({ Release: 2, Create: 3, Open: 4, Delete: 5, Enum: 6 });

test('a property set keeps what is written to it, and refuses its own identifiers', async()=>{
    // stg_prop.c testProps, through IPropertySetStorage.
    const w = world();
    const setOut = w.out();
    assert.equal(await w.fns.StgCreatePropSetStg.handler([w.STORAGE, 0, setOut]), S_OK);
    const sets = w.u32(setOut);
    const out = w.out();
    const summary = w.guid(FMTID_SUMMARY_INFORMATION);
    assert.equal(await w.m(sets, SET.Create, summary, 0, PROPSETFLAG_ANSI, 0x10, out),
        STG_E_INVALIDFLAG, 'read-write and exclusive or nothing');
    assert.equal(await w.m(sets, SET.Create, summary, 0, PROPSETFLAG_ANSI,
        STGM_CREATE | STGM_READWRITE_EXCLUSIVE, out), S_OK);
    const storage = w.u32(out);
    assert.ok(w.files.has('\x05SummaryInformation'), 'the stream is there at once');

    assert.equal(await w.m(storage, P.WriteMultiple, 0, 0, 0, 0), S_OK);
    assert.equal(await w.m(storage, P.WriteMultiple, 1, 0, 0, 0), 0x80070057 | 0);
    assert.equal(await w.m(storage, P.WriteMultiple, 1, w.spec(0), w.variant(VT.I4, 1), 0),
        STG_E_INVALIDPARAMETER, 'the dictionary');
    assert.equal(await w.m(storage, P.WriteMultiple, 1, w.spec('prop'), w.variant(VT.I4, 1), 0),
        STG_E_INVALIDPARAMETER, 'a name from identifier zero');
    assert.equal(await w.m(storage, P.WriteMultiple, 1, w.spec(0x80000003), w.variant(VT.I4, 1),
        0), STG_E_INVALIDPARAMETER, 'the behaviour');
    assert.equal(await w.m(storage, P.WriteMultiple, 1, w.spec(PID_FIRST_USABLE),
        w.variant(VT.I4, 1), 0), S_OK);
    assert.equal(await w.m(storage, P.WriteMultiple, 1, w.spec('prop'), w.variant(VT.I4, 2),
        PID_FIRST_USABLE), S_OK);
    assert.equal(await w.m(storage, P.WriteMultiple, 1, w.spec(4), w.variant(VT.LPSTR,
        w.ansi('val')), 0), S_OK);

    const read = w.variant(0);
    assert.equal(await w.m(storage, P.ReadMultiple, 0, 0, 0), S_FALSE);
    assert.equal(await w.m(storage, P.ReadMultiple, 1, w.spec(PID_FIRST_USABLE), read), S_OK);
    assert.deepEqual([w.view.getUint16(read, true), w.u32(read + 8)], [VT.I4, 1]);
    assert.equal(await w.m(storage, P.ReadMultiple, 1, w.spec('PROP'), read), S_OK,
        'a name is found whatever its case');
    assert.deepEqual([w.view.getUint16(read, true), w.u32(read + 8)], [VT.I4, 2]);
    const names = w.out();
    const ids = w.out();
    w.view.setUint32(ids, 3, true);
    assert.equal(await w.m(storage, P.ReadPropertyNames, 1, ids, names), S_OK,
        'it took the first free identifier from the one named');
    assert.equal(w.wide(w.u32(names)), 'prop');
    assert.equal(await w.m(storage, P.ReadMultiple, 1, w.spec(4), read), S_OK);
    assert.equal(w.view.getUint16(read, true), VT.LPSTR);
    const at = w.u32(read + 8);
    assert.equal(String.fromCharCode(...w.bytes.slice(at, at + 3)), 'val');
    assert.equal(await w.m(storage, P.ReadMultiple, 1, w.spec(0xdead), read), S_FALSE);
    assert.equal(w.view.getUint16(read, true), VT.EMPTY);

    assert.equal(await w.m(storage, P.DeleteMultiple, 1, w.spec(0)), STG_E_INVALIDPARAMETER);
    assert.equal(await w.m(storage, P.DeleteMultiple, 1, w.spec(PID_FIRST_USABLE)), S_OK);
    assert.equal(await w.m(storage, P.ReadMultiple, 1, w.spec(PID_FIRST_USABLE), read), S_FALSE);
    assert.equal(await w.m(storage, P.Commit, 0), S_OK);
    assert.equal(await w.m(storage, P.WriteMultiple, 1, w.spec(PID_FIRST_USABLE),
        w.variant(VT.I4, 9), 0), S_OK);
    assert.equal(await w.m(storage, P.Revert), S_OK);
    assert.equal(await w.m(storage, P.ReadMultiple, 1, w.spec(PID_FIRST_USABLE), read), S_FALSE,
        'reverted to what was committed');
    assert.equal(await w.m(storage, P.WriteMultiple, 1, w.spec(5), w.variant(VT.I4, 5), 0), S_OK);
    await w.m(storage, P.Release);

    const set = decodePropertySet(/** @type {Uint8Array} */ (w.files.get('\x05SummaryInformation')));
    assert.ok(set, 'the last Release wrote what was uncommitted');
    assert.deepEqual([...set.sections[0].properties.keys()].sort(), [3, 4, 5]);
    assert.deepEqual([...set.sections[0].names], [[3, 'prop']]);

    assert.equal(await w.m(sets, SET.Open, summary, STGM_CREATE | STGM_READWRITE_EXCLUSIVE, out),
        STG_E_INVALIDFLAG);
    assert.equal(await w.m(sets, SET.Open, w.guid('{11111111-2222-3333-4444-555555555555}'),
        STGM_READWRITE_EXCLUSIVE, out), STG_E_FILENOTFOUND);
    assert.equal(await w.m(sets, SET.Open, summary, 0x10, out), S_OK);
    const again = w.u32(out);
    assert.equal(await w.m(again, P.ReadMultiple, 1, w.spec('prop'), read), S_OK);
    assert.deepEqual([w.view.getUint16(read, true), w.u32(read + 8)], [VT.I4, 2]);
    assert.equal(await w.m(again, P.WriteMultiple, 1, w.spec(6), w.variant(VT.I4, 1), 0),
        0x80030005 | 0, 'opened to read: STG_E_ACCESSDENIED');
    await w.m(again, P.Release);
    assert.equal(await w.m(sets, SET.Delete, summary), S_OK);
    assert.equal(await w.m(sets, SET.Delete, summary), STG_E_FILENOTFOUND);
});

test('a set\'s code page changes only while it holds nothing', async()=>{
    // stg_prop.c testCodepage: Unicode unless made ANSI; an LPSTR is the
    // ANSI page's whatever the set's code page is.
    const w = world();
    const out = w.out();
    const stream = w.out();
    w.files.set('s', new Uint8Array(0));
    assert.equal(w.pointers.size > 0, true);
    await w.m(w.STORAGE, 4, w.text('s'), 0, 0x12, 0, stream);
    assert.equal(await w.fns.StgCreatePropStg.handler([w.u32(stream),
        w.guid(FMTID_SUMMARY_INFORMATION), 0, 0, 0, out]), S_OK);
    const storage = w.u32(out);
    const read = w.variant(0);
    assert.equal(await w.m(storage, P.ReadMultiple, 1, w.spec(1), read), S_OK);
    assert.deepEqual([w.view.getUint16(read, true), w.view.getUint16(read + 8, true)],
        [VT.I2, 1200]);
    assert.equal(await w.m(storage, P.WriteMultiple, 1, w.spec(1), w.variant(VT.I2, 1252), 0),
        S_OK);
    assert.equal(await w.m(storage, P.WriteMultiple, 1, w.spec(1), w.variant(VT.I2, 1200), 0),
        S_OK);
    // "hi" in UTF-16 read as an ANSI string is "h".
    assert.equal(await w.m(storage, P.WriteMultiple, 1, w.spec(2), w.variant(VT.LPSTR,
        w.text('hi')), 0), S_OK);
    assert.equal(await w.m(storage, P.ReadMultiple, 1, w.spec(2), read), S_OK);
    assert.deepEqual([...w.bytes.slice(w.u32(read + 8), w.u32(read + 8) + 2)], [0x68, 0]);
    assert.equal(await w.m(storage, P.WriteMultiple, 1, w.spec(1), w.variant(VT.I2, 1252), 0),
        STG_E_INVALIDPARAMETER, 'not once a property is set');
    await w.m(storage, P.Release);
});

test('the user-defined set lives in the document summary\'s stream, as its second section',
    async()=>{
        // stg_prop.c test_propertyset_storage_enum.
        const w = world();
        const setOut = w.out();
        await w.fns.StgCreatePropSetStg.handler([w.STORAGE, 0, setOut]);
        const sets = w.u32(setOut);
        const out = w.out();
        assert.equal(await w.m(sets, SET.Create, w.guid(FMTID_USER_DEFINED_PROPERTIES), 0,
            PROPSETFLAG_ANSI, STGM_CREATE | STGM_READWRITE_EXCLUSIVE, out), S_OK);
        await w.m(w.u32(out), P.WriteMultiple, 1, w.spec(0x10), w.variant(VT.I4, 10), 0x10);
        await w.m(w.u32(out), P.Release);
        assert.equal(await w.m(sets, SET.Open, w.guid(FMTID_DOC_SUMMARY_INFORMATION),
            STGM_READWRITE_EXCLUSIVE, out), S_OK);
        await w.m(w.u32(out), P.WriteMultiple, 1, w.spec(0x10), w.variant(VT.UI4, 11), 0x10);
        await w.m(w.u32(out), P.Release);

        const set = decodePropertySet(/** @type {Uint8Array} */ (
            w.files.get('\x05DocumentSummaryInformation')));
        assert.deepEqual(set?.sections.map(section=>[section.fmtid,
            section.properties.get(0x10)?.vt]), [[FMTID_DOC_SUMMARY_INFORMATION, VT.UI4],
            [FMTID_USER_DEFINED_PROPERTIES, VT.I4]]);

        const enumerator = w.out();
        assert.equal(await w.m(sets, SET.Enum, enumerator), S_OK);
        const item = w.out() && w.variant(0) && w.guid('{00000000-0000-0000-0000-000000000000}');
        const record = w.heap.allocate(64);
        assert.equal(await w.m(w.u32(enumerator), 3, 1, record, item), S_OK);
        assert.equal(formatGuid(w.bytes.slice(record, record + 16)), FMTID_DOC_SUMMARY_INFORMATION);
        assert.equal(await w.m(w.u32(enumerator), 3, 1, record, item), S_FALSE, 'the stream once');
        await w.m(w.u32(enumerator), 2);
        await w.m(sets, SET.Release);
    });
