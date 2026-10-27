/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

// Where a case mirrors one of ole32's conformance tests (dlls/ole32/tests/
// ole2.c, compobj.c, storage32.c, dragdrop.c), its expectation is Windows'
// answer as that test records it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatGuid, parseGuid } from './guid.js';
import { createOle2Functions, decodeCompObj, encodeCompObj } from './ole2.js';
import { createOleUtil } from './oleutil.js';
import { createDataCaches } from './datacache.js';
import { createDefaultHandlers } from './defhandler.js';
import {
    E_INVALIDARG, IID_IUNKNOWN, REGDB_E_CLASSNOTREG, S_FALSE, S_OK, oleProcess,
} from './ole2.fixture.js';

const E_NOINTERFACE = 0x80004002 | 0;
const REGDB_E_KEYMISSING = 0x80040152 | 0;
const CO_E_NOTINITIALIZED = 0x800401f0 | 0;
const OLEOBJ_E_NOVERBS = 0x80040180 | 0;
const OLE_S_STATIC = 0x00040001;
const OLE_E_STATIC = 0x8004000b | 0;
const OLE_E_CANT_GETMONIKER = 0x80040009 | 0;
const DV_E_FORMATETC = 0x80040064 | 0;
const DV_E_CLIPFORMAT = 0x8004006a | 0;
const DV_E_NOIVIEWOBJECT = 0x80040073 | 0;
const STG_E_FILENOTFOUND = 0x80030002 | 0;
const DRAGDROP_S_CANCEL = 0x00040101;
const CONVERT10_E_OLESTREAM_FMT = 0x800401c2 | 0;
const CONVERT10_E_STG_NO_STD_STREAM = 0x800401c5 | 0;

const IID_IRUNNABLEOBJECT = '{00000126-0000-0000-C000-000000000046}';
const IID_IVIEWOBJECT = '{0000010D-0000-0000-C000-000000000046}';
const IID_IOLEOBJECT = '{00000112-0000-0000-C000-000000000046}';
const IID_IPERSISTSTORAGE = '{0000010A-0000-0000-C000-000000000046}';
const IID_IOLECACHE = '{0000011E-0000-0000-C000-000000000046}';
const IID_IDATAOBJECT = '{0000010E-0000-0000-C000-000000000046}';
const IID_IENUMFORMATETC = '{00000103-0000-0000-C000-000000000046}';

const CLSID_OLD = '{12345678-1234-1234-1234-123456789ABC}';
const CLSID_NEW = '{12345678-1234-1234-1234-123456789ABD}';
const CLSID_NONE = '{12345678-1234-1234-1234-123456789ABE}';

const CF_TEXT = 1;
const CF_BITMAP = 2;
const CF_METAFILEPICT = 3;
const CF_DIB = 8;
const WM_KEYDOWN = 0x100;
const WM_CHAR = 0x102;
const FVIRTKEY = 1;
const FCONTROL = 8;
const FALT = 0x10;

/**
 * An object of the program's with one vtable per interface, as a C++ class
 * with several bases has: QueryInterface finds the right one, the count is
 * the object's, and every call is logged by name.
 *
 * @param {ReturnType<typeof oleProcess>} p
 * @param {Record<string, Record<number, [string, (args: number[]) => any]>>} spec
 */
function composite(p, spec){
    /** @type {string[]} */
    const log = [];
    const shared = { refs: 1 };
    /** @type {Record<string, import('./ole2.fixture.js').GuestObject>} */
    const parts = {};
    const iids = Object.keys(spec);
    for (const iid of iids)
    {
        /** @type {Record<number, (args: number[]) => any>} */
        const slots = {
            0: ([iidAt, outAt])=>{
                const wanted = p.guidAt(iidAt);
                const part = wanted === IID_IUNKNOWN ? parts[iids[0]] : parts[wanted];
                p.put(outAt, part ? part.pointer : 0);
                if (!part)
                {
                    return E_NOINTERFACE;
                }
                shared.refs++;
                return S_OK;
            },
            1: ()=>++shared.refs,
            2: ()=>--shared.refs,
        };
        for (const [slot, [name, fn]] of Object.entries(spec[iid]))
        {
            slots[Number(slot)] = args=>{
                log.push(name);
                return fn(args);
            };
        }
        parts[iid] = p.guestObject([], slots);
    }
    return { unknown: parts[iids[0]].pointer, parts, log, refs: ()=>shared.refs };
}

/**
 * A data object of the program's offering `formats` through EnumFormatEtc.
 *
 * @param {ReturnType<typeof oleProcess>} p @param {number[]} formats
 */
function dataObject(p, formats){
    return composite(p, {
        [IID_IDATAOBJECT]: {
            8: ['EnumFormatEtc', ([, outAt])=>{
                let at = 0;
                const enumerator = composite(p, {
                    [IID_IENUMFORMATETC]: {
                        3: ['Next', ([celt, rgelt, fetched])=>{
                            const count = Math.min(celt, formats.length - at);
                            for (let index = 0; index < count; index++)
                            {
                                p.bytes.fill(0, rgelt + index * 20, rgelt + index * 20 + 20);
                                p.put(rgelt + index * 20, formats[at + index]);
                                p.put(rgelt + index * 20 + 8, 1);
                                p.put(rgelt + index * 20 + 12, -1);
                                p.put(rgelt + index * 20 + 16, 1);
                            }
                            at += count;
                            if (fetched)
                            {
                                p.put(fetched, count);
                            }
                            return count === celt ? S_OK : S_FALSE;
                        }],
                    },
                });
                p.put(outAt, enumerator.unknown);
                return S_OK;
            }],
        },
    });
}

/** @param {{ system?: boolean }} [options] */
function setup(options){
    const p = oleProcess(options);
    // The data cache and the default handler, as ole32 gives them to these.
    const util = createOleUtil(p.env);
    p.env.dataCaches = createDataCaches({ ole: p.env, util });
    const fns = /** @type {Record<string, { argBytes: number, handler: Function }>} */ (
        createOle2Functions(p.env));
    p.env.defaultHandlers = createDefaultHandlers({ ole: p.env, util,
        caches: p.env.dataCaches,
        callExport: async(name, guids, args)=>(await fns[name].handler(
            args(guids.map(guid=>p.guid(guid))))) | 0 });
    /** @param {string} name @param {number[]} args */
    const run = async(name, args)=>(await fns[name].handler(args)) | 0;
    return { p, fns, run };
}

test('\\1CompObj is written as Windows writes it and read back from either half', ()=>{
    // ole2.c test_OleDoAutoConvert reads the header Windows writes: the
    // reserved word, version 0xa03, -1 and the class; an absent string a
    // length of zero; the Unicode marker between the halves.
    const clsid = /** @type {Uint8Array} */ (parseGuid(CLSID_OLD));
    const empty = encodeCompObj({ clsid, userType: null, format: null, progId: null });
    const view = new DataView(empty.buffer);
    assert.deepEqual([0, 4, 8].map(at=>view.getUint32(at, true)),
        [0xfffe0001, 0xa03, 0xffffffff]);
    assert.equal(formatGuid(empty.subarray(12, 28)), CLSID_OLD);
    assert.deepEqual([28, 32, 36, 40, 44, 48, 52].map(at=>view.getUint32(at, true)),
        [0, 0, 0, 0x71b239f4, 0, 0, 0]);
    assert.equal(empty.length, 56);

    const full = encodeCompObj({ clsid, userType: 'Thing', format: { name: 'Rich' },
        progId: 'App.Thing' });
    assert.deepEqual(decodeCompObj(full), { clsid, userType: 'Thing', format: { name: 'Rich' },
        progId: 'App.Thing' });
    const standard = encodeCompObj({ clsid, userType: null, format: { id: CF_TEXT },
        progId: null });
    assert.deepEqual(decodeCompObj(standard)?.format, { id: CF_TEXT });
    // A stream written before the Unicode half existed.
    assert.deepEqual(decodeCompObj(full.subarray(0, 28 + 10 + 9 + 14))?.userType, 'Thing');
    assert.equal(decodeCompObj(full.subarray(0, 20)), null);
});

test('OleRun, OleLockRunning and OleSetContainedObject go through IRunnableObject', async()=>{
    // ole2.c test_OleRun: an object without IRunnableObject runs already;
    // one with it answers Run's own HRESULT, called with no bind context.
    const { p, run, fns } = setup();
    assert.deepEqual(['OleRun', 'OleLockRunning', 'OleSetContainedObject']
        .map(name=>fns[name].argBytes), [4, 12, 8]);
    const plain = composite(p, { [IID_IUNKNOWN]: {} });
    assert.equal(await run('OleRun', [plain.unknown]), S_OK);
    assert.equal(await run('OleLockRunning', [plain.unknown, 1, 0]), S_OK);
    assert.equal(await run('OleSetContainedObject', [plain.unknown, 1]), S_OK);
    assert.equal(plain.refs(), 1);

    /** @type {number[][]} */
    const seen = [];
    const runnable = composite(p, { [IID_IRUNNABLEOBJECT]: {
        4: ['Run', args=>{
            seen.push(args);
            return 0xdeadc0de;
        }],
        6: ['LockRunning', args=>{
            seen.push(args);
            return 0x1234;
        }],
        7: ['SetContainedObject', args=>{
            seen.push(args);
            return S_OK;
        }],
    } });
    assert.equal(await run('OleRun', [runnable.unknown]), 0xdeadc0de | 0);
    assert.equal(await run('OleLockRunning', [runnable.unknown, 1, 0]), 0x1234);
    assert.equal(await run('OleSetContainedObject', [runnable.unknown, 1]), S_OK);
    assert.deepEqual(seen, [[0], [1, 0], [1]]);
    assert.equal(runnable.refs(), 1, 'every reference taken is given back');
    assert.equal(await run('OleRun', [0]), E_INVALIDARG);
});

test('OleIsRunning asks IRunnableObject, and an object without one is running', async()=>{
    // ole2.c test_runnable.
    const { p, run } = setup();
    assert.equal(await run('OleIsRunning', [0]), 0);
    let running = 1;
    const runnable = composite(p, { [IID_IOLEOBJECT]: {},
        [IID_IRUNNABLEOBJECT]: { 5: ['IsRunning', ()=>running] } });
    assert.equal(await run('OleIsRunning', [runnable.unknown]), 1);
    running = 0;
    assert.equal(await run('OleIsRunning', [runnable.unknown]), 0);
    assert.deepEqual(runnable.log, ['IsRunning', 'IsRunning']);
    assert.equal(runnable.refs(), 1);
    const plain = composite(p, { [IID_IOLEOBJECT]: {} });
    assert.equal(await run('OleIsRunning', [plain.unknown]), 1);
});

test('OleDraw draws through IViewObject, and refuses what has none', async()=>{
    // ole2.c test_OleDraw: NULL is E_INVALIDARG with or without bounds.
    const { p, run } = setup();
    /** @type {number[]} */
    let drawn = [];
    const view = composite(p, { [IID_IVIEWOBJECT]: { 3: ['Draw', args=>{
        drawn = args;
        return S_OK;
    }] } });
    const rect = p.out(0, 16);
    assert.equal(await run('OleDraw', [view.unknown, 1, 0x77, rect]), S_OK);
    assert.deepEqual(drawn, [1, 0xffffffff, 0, 0, 0, 0x77, rect, 0, 0, 0]);
    assert.equal(await run('OleDraw', [view.unknown, 0, 0x77, 0]), S_OK);
    assert.equal(view.refs(), 1);
    assert.equal(await run('OleDraw', [0, 0, 1, 0]), E_INVALIDARG);
    assert.equal(await run('OleDraw', [0, 0, 1, rect]), E_INVALIDARG);
    const plain = composite(p, { [IID_IUNKNOWN]: {} });
    assert.equal(await run('OleDraw', [plain.unknown, 1, 1, 0]), DV_E_NOIVIEWOBJECT);
});

test('OleSave writes the class into the storage, lets the object save, and commits', async()=>{
    const { p, run } = setup();
    const storage = p.docfile();
    /** @type {number[][]} */
    const saves = [];
    const persist = composite(p, { [IID_IPERSISTSTORAGE]: {
        3: ['GetClassID', ([at])=>{
            p.bytes.set(/** @type {Uint8Array} */ (parseGuid(CLSID_OLD)), at);
            return S_OK;
        }],
        7: ['Save', args=>{
            saves.push(args);
            return S_OK;
        }],
    } });
    assert.equal(await run('OleSave', [persist.unknown, storage, 1]), S_OK);
    assert.deepEqual(persist.log, ['GetClassID', 'Save']);
    assert.deepEqual(saves, [[storage, 1]]);
    const clsid = p.out(0, 16);
    assert.equal(p.storage.ReadClassStg.handler([storage, clsid]), S_OK);
    assert.equal(p.guidAt(clsid), CLSID_OLD);
    assert.equal(await run('OleSave', [0, storage, 1]), E_INVALIDARG);
});

/**
 * An embeddable object of the program's, as ole2.c's OleObject is: its
 * calls logged, GetMiscStatus answering `status`.
 *
 * @param {ReturnType<typeof oleProcess>} p @param {number} status
 */
function embeddable(p, status = 0){
    return composite(p, {
        [IID_IOLEOBJECT]: {
            3: ['OleObject_SetClientSite', ()=>S_OK],
            22: ['OleObject_GetMiscStatus', ([, at])=>{
                p.put(at, status);
                return S_OK;
            }],
        },
        [IID_IPERSISTSTORAGE]: {
            5: ['OleObjectPersistStg_InitNew', ()=>S_OK],
            6: ['OleObjectPersistStg_Load', ()=>S_OK],
        },
        [IID_IRUNNABLEOBJECT]: { 4: ['OleObjectRunnable_Run', ()=>S_OK] },
        [IID_IOLECACHE]: { 3: ['OleObjectCache_Cache', ()=>S_OK] },
    });
}

test('OleCreate makes the object in process and takes it through the steps ole2.c records',
    async()=>{
        const { p, run, fns } = setup();
        assert.equal(fns.OleCreate.argBytes, 28);
        const storage = p.docfile();
        const clsid = p.guid(CLSID_OLD);
        const iid = p.guid(IID_IOLEOBJECT);
        /** @type {ReturnType<typeof embeddable>[]} */
        const made = [];
        let status = 0;
        p.classes.set(CLSID_OLD, ()=>{
            const object = embeddable(p, status);
            made.push(object);
            return object.parts[IID_IOLEOBJECT];
        });
        const out = p.out();
        /** @param {number} render @param {number} site */
        const create = async(render, site)=>{
            p.put(out, 0xdeadbeef);
            assert.equal(await run('OleCreate', [clsid, iid, render, 0, site, storage, out]),
                S_OK);
            const object = /** @type {ReturnType<typeof embeddable>} */ (made.at(-1));
            assert.equal(p.u32(out), object.parts[IID_IOLEOBJECT].pointer);
            assert.equal(object.refs(), 1, 'the caller holds the one reference');
            return object.log;
        };
        assert.deepEqual(await create(0, 0), ['OleObjectPersistStg_InitNew']);
        const clsidOut = p.out(0, 16);
        assert.equal(p.storage.ReadClassStg.handler([storage, clsidOut]), S_OK);
        assert.equal(p.guidAt(clsidOut), CLSID_OLD, 'the storage is made the class\'s');
        assert.deepEqual(await create(1, 0), ['OleObjectPersistStg_InitNew',
            'OleObjectRunnable_Run', 'OleObjectCache_Cache']);
        assert.deepEqual(await create(1, 0xdeadbeef), ['OleObject_GetMiscStatus',
            'OleObjectPersistStg_InitNew', 'OleObject_SetClientSite', 'OleObjectRunnable_Run',
            'OleObjectCache_Cache']);
        assert.deepEqual(await create(3, 0), ['OleObjectPersistStg_InitNew']);
        status = 0x20000;
        assert.deepEqual(await create(0, 0xdeadbeef), ['OleObject_GetMiscStatus',
            'OleObject_SetClientSite', 'OleObjectPersistStg_InitNew'],
        'OLEMISC_SETCLIENTSITEFIRST');

        const none = p.guid(CLSID_NONE);
        p.put(out, 0xdeadbeef);
        assert.equal(await run('OleCreate', [none, iid, 0, 0, 0, storage, out]),
            REGDB_E_CLASSNOTREG);
        assert.equal(p.u32(out), 0);
        assert.equal(p.reported.length, 1, 'a class with no server here is said');
        assert.equal(await run('OleCreate', [clsid, iid, 2, 0, 0, storage, out]), E_INVALIDARG,
            'OLERENDER_FORMAT with no format');
        assert.equal(await run('OleCreate', [clsid, iid, 0, 0, 0, 0, out]), E_INVALIDARG);
    });

test('OleLoad makes the storage\'s class and loads it, the site around the load', async()=>{
    // ole2.c test_OleLoad.
    const { p, run } = setup();
    const storage = p.docfile();
    assert.equal(p.storage.WriteClassStg.handler([storage, p.guid(CLSID_OLD)]), S_OK);
    /** @type {ReturnType<typeof embeddable> | null} */
    let made = null;
    p.classes.set(CLSID_OLD, ()=>{
        made = embeddable(p);
        return made.parts[IID_IOLEOBJECT];
    });
    const out = p.out();
    assert.equal(await run('OleLoad', [storage, p.guid(IID_IOLEOBJECT), 0xdeadbeef, out]), S_OK);
    const object = /** @type {ReturnType<typeof embeddable>} */ (/** @type {unknown} */ (made));
    assert.deepEqual(object.log, ['OleObject_GetMiscStatus', 'OleObjectPersistStg_Load',
        'OleObject_SetClientSite']);
    assert.equal(p.u32(out), object.parts[IID_IOLEOBJECT].pointer);
    assert.equal(object.refs(), 1);

    const other = p.docfile();
    assert.equal(p.storage.WriteClassStg.handler([other, p.guid(CLSID_NONE)]), S_OK);
    // A class with no server here is the default handler's to stand for
    // (ole2.c test_OleLoad's presentations of an unregistered class).
    assert.equal(await run('OleLoad', [other, p.guid(IID_IUNKNOWN), 0, out]), S_OK);
    assert.notEqual(p.u32(out), 0);
    const runnable = p.out();
    assert.equal(await p.callMethod(p.u32(out), 0, [p.guid(IID_IRUNNABLEOBJECT), runnable]),
        S_OK, 'a handler, not the object');
    assert.equal(await p.callMethod(p.u32(runnable), 5, []), 0, 'which is not running');
    assert.equal(await run('OleLoad', [0, p.guid(IID_IUNKNOWN), 0, out]), E_INVALIDARG);
});

test('OleRegGetUserType reads the class key and AuxUserType as compobj.c does', async()=>{
    const { p, run } = setup();
    p.setKey(`CLSID\\${CLSID_OLD}`, 'Default Name');
    for (const form of [0, 2, 3, 4])
    {
        p.setKey(`CLSID\\${CLSID_OLD}\\AuxUserType\\${form}`, `Aux Name ${form}`);
    }
    const clsid = p.guid(CLSID_OLD);
    const out = p.out();
    /** @param {number} form */
    const name = async form=>{
        assert.equal(await run('OleRegGetUserType', [clsid, form, out]), S_OK);
        const text = p.readWide(p.u32(out));
        assert.ok(p.heap.block(p.u32(out)), 'task memory');
        return text;
    };
    assert.equal(await name(0), 'Aux Name 0');
    assert.equal(await name(1), 'Default Name', 'USERCLASSTYPE_FULL');
    assert.equal(await name(2), 'Aux Name 2');
    assert.equal(await name(3), 'Aux Name 3');
    assert.equal(await name(4), 'Aux Name 4');
    assert.equal(await name(5), 'Default Name', 'no aux of that form');
    p.put(out, 0xdeadbeef);
    assert.equal(await run('OleRegGetUserType', [p.guid(CLSID_NONE), 1, out]),
        REGDB_E_CLASSNOTREG);
    assert.equal(p.u32(out), 0);
    assert.equal(await run('OleRegGetUserType', [clsid, 1, 0]), E_INVALIDARG);
});

test('OleRegGetMiscStatus reads MiscStatus by aspect, and none is zero', async()=>{
    const { p, run } = setup();
    p.setKey(`CLSID\\${CLSID_OLD}`, 'Thing');
    const clsid = p.guid(CLSID_OLD);
    const out = p.out();
    assert.equal(await run('OleRegGetMiscStatus', [clsid, 1, out]), S_OK);
    assert.equal(p.u32(out), 0);
    p.setKey(`CLSID\\${CLSID_OLD}\\MiscStatus`, '131473');
    p.setKey(`CLSID\\${CLSID_OLD}\\MiscStatus\\4`, '16');
    assert.equal(await run('OleRegGetMiscStatus', [clsid, 1, out]), S_OK);
    assert.equal(p.u32(out), 131473);
    assert.equal(await run('OleRegGetMiscStatus', [clsid, 4, out]), S_OK);
    assert.equal(p.u32(out), 16, 'the aspect\'s own');
    assert.equal(await run('OleRegGetMiscStatus', [p.guid(CLSID_NONE), 1, out]),
        REGDB_E_CLASSNOTREG);
    assert.equal(p.u32(out), 0);
});

test('OleRegEnumVerbs enumerates the Verb keys, and a class without them has no verbs',
    async()=>{
        const { p, run } = setup();
        const clsid = p.guid(CLSID_OLD);
        const out = p.out();
        assert.equal(await run('OleRegEnumVerbs', [clsid, out]), REGDB_E_CLASSNOTREG);
        p.setKey(`CLSID\\${CLSID_OLD}`, 'Thing');
        assert.equal(await run('OleRegEnumVerbs', [clsid, out]), OLEOBJ_E_NOVERBS);
        p.setKey(`CLSID\\${CLSID_OLD}\\Verb`);
        assert.equal(await run('OleRegEnumVerbs', [clsid, out]), OLEOBJ_E_NOVERBS);
        p.setKey(`CLSID\\${CLSID_OLD}\\Verb\\1`, '&Open,0,2');
        p.setKey(`CLSID\\${CLSID_OLD}\\Verb\\0`, '&Edit,0,2');
        p.setKey(`CLSID\\${CLSID_OLD}\\Verb\\-1`, 'Show,0,1');
        assert.equal(await run('OleRegEnumVerbs', [clsid, out]), S_OK);
        const enumerator = p.u32(out);
        const verbs = p.out(0, 64);
        const fetched = p.out();
        assert.equal(await p.callMethod(enumerator, 3, [2, verbs, fetched]), S_OK);
        assert.equal(p.u32(fetched), 2);
        assert.deepEqual([p.u32(verbs) | 0, p.readWide(p.u32(verbs + 4)), p.u32(verbs + 8),
            p.u32(verbs + 12)], [-1, 'Show', 0, 1]);
        assert.deepEqual([p.u32(verbs + 16), p.readWide(p.u32(verbs + 20))], [0, '&Edit']);
        assert.equal(await p.callMethod(enumerator, 3, [2, verbs, fetched]), S_FALSE);
        assert.equal(p.u32(fetched), 1);
        assert.equal(p.readWide(p.u32(verbs + 4)), '&Open');
        assert.equal(await p.callMethod(enumerator, 3, [2, verbs, 0]), E_INVALIDARG,
            'no count for more than one');
        assert.equal(await p.callMethod(enumerator, 5, []), S_OK, 'Reset');
        assert.equal(await p.callMethod(enumerator, 4, [5]), S_FALSE, 'Skip past the end');
        const clone = p.out();
        assert.equal(await p.callMethod(enumerator, 6, [clone]), S_OK);
        assert.notEqual(p.u32(clone), enumerator);
        assert.equal(await p.callMethod(p.u32(clone), 2, []), 0);
        assert.equal(await p.callMethod(enumerator, 2, []), 0);
    });

test('OleGetAutoConvert and OleDoAutoConvert convert a storage as ole2.c records', async()=>{
    const { p, run } = setup();
    const out = p.out(0, 16);
    const old = p.guid(CLSID_OLD);
    assert.equal(await run('OleGetAutoConvert', [old, out]), REGDB_E_CLASSNOTREG);
    assert.equal(p.guidAt(out), '{00000000-0000-0000-0000-000000000000}');

    const storage = p.docfile();
    assert.equal(p.storage.WriteClassStg.handler([storage, old]), S_OK);
    assert.equal(await run('OleDoAutoConvert', [storage, out]), REGDB_E_CLASSNOTREG);
    assert.equal(p.guidAt(out), CLSID_OLD, 'the old class, though nothing converted');
    p.setKey(`CLSID\\${CLSID_OLD}`, 'Old');
    assert.equal(await run('OleDoAutoConvert', [storage, out]), REGDB_E_KEYMISSING);
    assert.equal(await run('OleGetAutoConvert', [old, out]), REGDB_E_KEYMISSING);
    // ole2.c: OleSetAutoConvert writes what OleGetAutoConvert reads.
    assert.equal(await run('OleSetAutoConvert', [p.guid(CLSID_NEW), old]), REGDB_E_CLASSNOTREG,
        'a class with no key of its own');
    assert.equal(await run('OleSetAutoConvert', [old, p.guid(CLSID_NEW)]), S_OK);
    p.setKey(`CLSID\\${CLSID_NEW}`, 'New Thing');
    assert.equal(await run('OleGetAutoConvert', [old, out]), S_OK);
    assert.equal(p.guidAt(out), CLSID_NEW);

    assert.equal(await run('OleDoAutoConvert', [storage, out]), S_OK);
    assert.equal(p.guidAt(out), CLSID_NEW);
    const clsid = p.out(0, 16);
    assert.equal(p.storage.ReadClassStg.handler([storage, clsid]), S_OK);
    assert.equal(p.guidAt(clsid), CLSID_NEW, 'the storage is the new class');
    const user = p.out();
    assert.equal(await run('ReadFmtUserTypeStg', [storage, 0, user]), S_OK);
    assert.equal(p.readWide(p.u32(user)), 'New Thing');
    assert.equal(await run('GetConvertStg', [storage]), S_OK, 'marked converted');

    assert.equal(await run('OleDoAutoConvert', [0, out]), E_INVALIDARG);
    assert.equal(p.guidAt(out), '{00000000-0000-0000-0000-000000000000}');
});

test('WriteFmtUserTypeStg writes \\1CompObj, which ReadFmtUserTypeStg reads back', async()=>{
    // storage32.c test_fmtusertypestg: written twice, one stream.
    const { p, run } = setup();
    const storage = p.docfile();
    assert.equal(p.storage.WriteClassStg.handler([storage, p.guid(CLSID_OLD)]), S_OK);
    p.setKey(`CLSID\\${CLSID_OLD}\\ProgID`, 'App.Thing');
    const userType = p.wide('StgUsrType');
    assert.equal(await run('WriteFmtUserTypeStg', [storage, CF_TEXT, userType]), S_OK);
    assert.equal(await run('WriteFmtUserTypeStg', [storage, CF_TEXT, userType]), S_OK);
    const cf = p.out();
    const user = p.out();
    assert.equal(await run('ReadFmtUserTypeStg', [storage, cf, user]), S_OK);
    assert.equal(p.u16(cf), CF_TEXT);
    assert.equal(p.readWide(p.u32(user)), 'StgUsrType');

    // A registered format goes by name, and comes back registered.
    const name = p.wide('Rich Text Format');
    const rich = /** @type {number} */ (p.env.system?.('USER32.dll',
        'RegisterClipboardFormatW', [name]));
    assert.equal(await run('WriteFmtUserTypeStg', [storage, rich, 0]), S_OK);
    p.user32.names.clear();
    assert.equal(await run('ReadFmtUserTypeStg', [storage, cf, user]), S_OK);
    assert.equal(p.user32.names.get(p.u16(cf)), 'Rich Text Format');
    assert.equal(p.u32(user), 0, 'no user type written, none read');

    const bare = p.docfile();
    p.put(user, 0xdeadbeef);
    assert.equal(await run('ReadFmtUserTypeStg', [bare, cf, user]), STG_E_FILENOTFOUND);
    assert.equal(p.u32(user), 0);
    assert.equal(await run('WriteFmtUserTypeStg', [0, 0, 0]), E_INVALIDARG);
});

test('SetConvertStg and GetConvertStg keep the flag in \\1Ole', async()=>{
    // storage32.c test_convert.
    const { p, run } = setup();
    assert.equal(await run('GetConvertStg', [0]), E_INVALIDARG);
    const storage = p.docfile();
    assert.equal(await run('GetConvertStg', [storage]), STG_E_FILENOTFOUND);
    assert.equal(await run('SetConvertStg', [storage, 1]), S_OK);
    assert.equal(await run('SetConvertStg', [storage, 1]), S_OK);
    assert.equal(await run('GetConvertStg', [storage]), S_OK);
    assert.equal(await run('SetConvertStg', [storage, 0]), S_OK);
    assert.equal(await run('GetConvertStg', [storage]), S_FALSE);
    assert.equal(await run('SetConvertStg', [0, 1]), E_INVALIDARG);
});

test('IsAccelerator matches a key message against the table, modifiers and all', async()=>{
    const { p, run, fns } = setup();
    assert.equal(fns.IsAccelerator.argBytes, 16);
    p.user32.accelerators.set(0x700, [
        { flags: FVIRTKEY, key: 0x70, command: 101 },
        { flags: FVIRTKEY | FCONTROL, key: 0x53, command: 102 },
        { flags: 0, key: 'q'.charCodeAt(0), command: 103 },
        { flags: FALT, key: 'x'.charCodeAt(0), command: 104 },
    ]);
    const message = p.out(0, 28);
    const command = p.out();
    /** @param {number} kind @param {number} key @param {number} [lParam] */
    const is = async(kind, key, lParam = 0)=>{
        p.put(message + 4, kind);
        p.put(message + 8, key);
        p.put(message + 12, lParam);
        p.put(command, 0xffff);
        return run('IsAccelerator', [0x700, 4, message, command]);
    };
    assert.equal(await is(WM_KEYDOWN, 0x70), 1);
    assert.equal(p.u16(command), 101);
    assert.equal(await is(WM_KEYDOWN, 0x53), 0, 'Ctrl is not down');
    p.user32.keysDown.add(0x11);
    assert.equal(await is(WM_KEYDOWN, 0x53), 1);
    assert.equal(p.u16(command), 102);
    assert.equal(await is(WM_KEYDOWN, 0x70), 0, 'with Ctrl down the bare key is not it');
    p.user32.keysDown.clear();
    assert.equal(await is(WM_CHAR, 'q'.charCodeAt(0)), 1);
    assert.equal(p.u16(command), 103);
    assert.equal(await is(WM_CHAR, 'x'.charCodeAt(0)), 0, 'FALT without Alt');
    assert.equal(await is(0x106, 'x'.charCodeAt(0), 0x20000000), 1, 'WM_SYSCHAR with Alt');
    assert.equal(await is(0x200, 0x70), 0, 'not a key message');
    assert.equal(await run('IsAccelerator', [0x700, 0, message, command]), 0, 'no entries');
    assert.equal(await run('IsAccelerator', [0, 4, message, command]), 0);
});

test('OleTranslateAccelerator hands a match to the frame and answers S_FALSE otherwise',
    async()=>{
        const { p, run } = setup();
        p.user32.accelerators.set(0x700, [{ flags: FVIRTKEY, key: 0x70, command: 101 }]);
        /** @type {number[][]} */
        const translated = [];
        const frame = composite(p, { '{00000116-0000-0000-C000-000000000046}': {
            14: ['TranslateAccelerator', args=>{
                translated.push(args);
                return S_OK;
            }],
        } });
        const info = p.out(0, 20);
        p.put(info + 12, 0x700);
        p.put(info + 16, 1);
        const message = p.out(0, 28);
        p.put(message + 4, WM_KEYDOWN);
        p.put(message + 8, 0x70);
        assert.equal(await run('OleTranslateAccelerator', [frame.unknown, info, message]), S_OK);
        assert.deepEqual(translated, [[message, 101]]);
        p.put(message + 8, 0x71);
        assert.equal(await run('OleTranslateAccelerator', [frame.unknown, info, message]),
            S_FALSE);
        assert.equal(await run('OleTranslateAccelerator', [frame.unknown, 0, message]),
            E_INVALIDARG);
    });

test('a menu descriptor holds the menu and its widths until it is destroyed', async()=>{
    const { p, run } = setup();
    const widths = p.out(0, 24);
    [1, 0, 2, 0, 1, 0].forEach((width, index)=>p.put(widths + index * 4, width));
    const descriptor = await run('OleCreateMenuDescriptor', [0x1234, widths]);
    assert.notEqual(descriptor, 0);
    assert.equal(p.u32(descriptor), 0x1234);
    assert.equal(p.u32(descriptor + 12), 2);
    assert.equal(await run('OleCreateMenuDescriptor', [0, widths]), 0, 'no menu, no descriptor');
    assert.equal(await run('OleDestroyMenuDescriptor', [descriptor]), S_OK);
    assert.equal(p.heap.block(descriptor), null);
    assert.equal(await run('OleDestroyMenuDescriptor', [0]), S_OK);
});

test('DoDragDrop ends as a cancelled drop, after dragdrop.c\'s argument checks', async()=>{
    const { p, run } = setup();
    const data = composite(p, { [IID_IDATAOBJECT]: {} });
    const source = composite(p, { '{00000121-0000-0000-C000-000000000046}': {} });
    const effect = p.out(0xdeadbeef);
    p.thread.ole32.oleDepth = 0;
    assert.equal(await run('DoDragDrop', [0, 0, 0, 0]), CO_E_NOTINITIALIZED);
    p.thread.ole32.oleDepth = 1;
    for (const args of [[0, 0, 0, 0], [0, source.unknown, 0, 0], [data.unknown, 0, 0, 0],
        [0, 0, 0, effect], [data.unknown, source.unknown, 0, 0]])
    {
        assert.equal(await run('DoDragDrop', args), E_INVALIDARG);
    }
    assert.equal(await run('DoDragDrop', [data.unknown, source.unknown, 1, effect]),
        DRAGDROP_S_CANCEL);
    assert.equal(p.u32(effect), 0, 'DROPEFFECT_NONE');
    assert.deepEqual([...data.log, ...source.log], [], 'the source is not run');
    assert.equal(p.reported.length, 1);
});

test('what a data object can be made into is read from its formats', async()=>{
    const { p, run } = setup();
    const embed = p.env.system?.('USER32.dll', 'RegisterClipboardFormatW',
        [p.wide('Embed Source')]);
    const link = p.env.system?.('USER32.dll', 'RegisterClipboardFormatW',
        [p.wide('Link Source')]);
    const text = dataObject(p, [CF_TEXT]);
    const picture = dataObject(p, [CF_TEXT, CF_METAFILEPICT]);
    const embedded = dataObject(p, [Number(embed), CF_TEXT]);
    const linked = dataObject(p, [Number(link)]);
    assert.equal(await run('OleQueryCreateFromData', [text.unknown]), S_FALSE);
    assert.equal(await run('OleQueryCreateFromData', [picture.unknown]), OLE_S_STATIC);
    assert.equal(await run('OleQueryCreateFromData', [embedded.unknown]), S_OK);
    assert.equal(await run('OleQueryLinkFromData', [embedded.unknown]), S_FALSE);
    assert.equal(await run('OleQueryLinkFromData', [linked.unknown]), S_OK);
    assert.equal(text.refs(), 1, 'the enumerator and its references given back');

    const storage = p.docfile();
    const out = p.out();
    const iid = p.guid(IID_IOLEOBJECT);
    assert.equal(await run('OleCreateFromData', [text.unknown, iid, 1, 0, 0, storage, out]),
        DV_E_FORMATETC);
    assert.equal(p.u32(out), 0);
    assert.equal(await run('OleCreateFromData', [picture.unknown, iid, 1, 0, 0, storage, out]),
        OLE_E_STATIC);
    assert.equal(await run('OleCreateFromData', [embedded.unknown, iid, 1, 0, 0, storage, out]),
        REGDB_E_CLASSNOTREG);
    assert.equal(await run('OleCreateLinkFromData', [text.unknown, iid, 1, 0, 0, storage, out]),
        OLE_E_CANT_GETMONIKER);
    assert.equal(await run('OleCreateLinkFromData',
        [linked.unknown, iid, 1, 0, 0, storage, out]), REGDB_E_CLASSNOTREG);
    assert.equal(await run('OleCreateFromData', [text.unknown, iid, 1, 0, 0, 0, out]),
        E_INVALIDARG);
});

test('OleCreateStaticFromData checks as ole2.c does, and makes a static picture', async()=>{
    const { p, run } = setup();
    // A data object whose GetData hands out a 1x1 DIB.
    const data = composite(p, { [IID_IDATAOBJECT]: {
        3: ['GetData', ([, medium])=>{
            const dib = p.heap.allocate(44);
            p.bytes.fill(0, dib, dib + 44);
            [40, 1, 1].forEach((word, index)=>p.put(dib + index * 4, word));
            p.bytes[dib + 12] = 1;
            p.bytes[dib + 14] = 32;
            p.put(medium, 1);
            p.put(medium + 4, dib);
            p.put(medium + 8, 0);
            return S_OK;
        }],
    } });
    const storage = p.docfile();
    const out = p.out();
    const iid = p.guid(IID_IOLEOBJECT);
    const format = p.out(0, 20);
    p.put(format, CF_DIB);
    assert.equal(await run('OleCreateStaticFromData', [data.unknown, iid, 2, format, 0, 0, out]),
        E_INVALIDARG, 'no storage');
    assert.equal(await run('OleCreateStaticFromData',
        [data.unknown, iid, 2, format, 0, storage, 0]), E_INVALIDARG, 'nowhere to put it');
    p.put(format, CF_TEXT);
    assert.equal(await run('OleCreateStaticFromData',
        [data.unknown, iid, 2, format, 0, storage, out]), DV_E_CLIPFORMAT);
    p.put(format, CF_DIB);
    [1, -1, 1].forEach((word, index)=>p.put(format + 8 + index * 4, word));
    assert.equal(await run('OleCreateStaticFromData',
        [data.parts[IID_IDATAOBJECT].pointer, iid, 2, format, 0, storage, out]), S_OK);
    assert.notEqual(p.u32(out), 0);
    // ole2.c test_OleCreateStaticFromData: the storage is the static class's,
    // with \1Ole, \1CompObj and the picture in CONTENTS behind its file header.
    const clsid = p.out(0, 16);
    assert.equal(p.storage.ReadClassStg.handler([storage, clsid]), S_OK);
    assert.equal(p.guidAt(clsid), '{00000316-0000-0000-C000-000000000046}');
    for (const name of ['\x01Ole', '\x01CompObj', 'CONTENTS'])
    {
        const stream = p.out();
        assert.equal(await p.callMethod(storage, 4, [p.wide(name), 0, 0x10, 0, stream]), S_OK,
            name);
        if (name === 'CONTENTS')
        {
            const head = p.out(0, 2);
            await p.callMethod(p.u32(stream), 3, [head, 2, 0]);
            assert.equal(p.u16(head), 0x4d42, 'BM');
        }
        await p.callMethod(p.u32(stream), 2, []);
    }
});

test('OleDuplicateData copies a global block and a metafile picture, not a GDI object',
    async()=>{
        const { p, run, fns } = setup();
        assert.equal(fns.OleDuplicateData.argBytes, 12);
        const block = p.heap.allocate(5);
        p.bytes.set([1, 2, 3, 4, 5], block);
        const copy = await run('OleDuplicateData', [block, CF_TEXT, 0]);
        assert.ok(copy !== 0 && copy !== block);
        assert.deepEqual([...p.bytes.subarray(copy, copy + 5)], [1, 2, 3, 4, 5]);
        assert.equal(p.heap.block(copy)?.size, 5);

        const picture = p.heap.allocate(16);
        p.put(picture, 8);
        p.put(picture + 12, 0x4000);
        p.metafiles.add(0x4000);
        const copied = await run('OleDuplicateData', [picture, CF_METAFILEPICT, 0]);
        assert.ok(copied !== 0 && copied !== picture);
        assert.equal(p.u32(copied), 8);
        assert.equal(p.u32(copied + 12), 0x5000, 'its own metafile');

        assert.equal(await run('OleDuplicateData', [0x6000, CF_BITMAP, 0]), 0);
        assert.equal(p.reported.length, 1);
        assert.equal(await run('OleDuplicateData', [0, CF_TEXT, 0]), 0);
    });

test('the creation calls with no server here are refused as an unregistered class', async()=>{
    const { p, fns, run } = setup();
    const expected = {
        OleCreateFromFile: [32, 7, REGDB_E_CLASSNOTREG],
        OleCreateLinkToFile: [28, 6, REGDB_E_CLASSNOTREG],
        OleCreateLink: [28, 6, REGDB_E_CLASSNOTREG],
    };
    for (const [name, [argBytes, outAt, answer]] of Object.entries(expected))
    {
        assert.equal(fns[name].argBytes, argBytes, name);
        const out = p.out();
        const args = new Array(argBytes / 4).fill(0x1000);
        args[outAt] = out;
        assert.equal(await run(name, args), answer, name);
        assert.equal(p.u32(out), 0, `${name} zeroes its out-parameter`);
    }
    assert.equal(await run('OleGetIconOfClass', [0x1000, 0, 1]), 0);
    assert.equal(await run('OleConvertIStorageToOLESTREAM', [0x1000, 0x1000]),
        CONVERT10_E_STG_NO_STD_STREAM);
    assert.equal(await run('OleConvertOLESTREAMToIStorage', [0x1000, 0x1000, 0]),
        CONVERT10_E_OLESTREAM_FMT);
    assert.equal(p.reported.length, 6, 'each named once');
    await run('OleCreateFromFile', new Array(8).fill(0x1000));
    assert.equal(p.reported.length, 6);
});

test('without user32, accelerators and registered formats are not reached, and that is said',
    async()=>{
        const { p, run } = setup({ system: false });
        const message = p.out(0, 28);
        p.put(message + 4, WM_KEYDOWN);
        assert.equal(await run('IsAccelerator', [0x700, 1, message, 0]), 0);
        assert.equal(p.reported.length, 1);
        const embedded = dataObject(p, [0xc000]);
        assert.equal(await run('OleQueryCreateFromData', [embedded.unknown]), S_FALSE);
    });
