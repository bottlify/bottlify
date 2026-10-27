/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oleProcess } from './ole2.fixture.js';
import { createOleUtil } from './oleutil.js';
import { createOle2Functions } from './ole2.js';
import { createDataCaches, CLSID_PICTURE_DIB, IID_IOLECACHE2 } from './datacache.js';
import { createDefaultHandlers, IID_IOLEOBJECT } from './defhandler.js';

const S_OK = 0;
const S_FALSE = 1;
const GUID_NULL = '{00000000-0000-0000-0000-000000000000}';
const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';
const IID_IDATAOBJECT = '{0000010E-0000-0000-C000-000000000046}';
const IID_IVIEWOBJECT2 = '{00000127-0000-0000-C000-000000000046}';
const IID_IPERSISTSTORAGE = '{0000010A-0000-0000-C000-000000000046}';
const IID_IRUNNABLEOBJECT = '{00000126-0000-0000-C000-000000000046}';
const OLE_E_BLANK = 0x80040007 | 0;
const OLE_E_NOTRUNNING = 0x80040005 | 0;
const DV_E_FORMATETC = 0x80040064 | 0;
const DV_E_TYMED = 0x80040069 | 0;
const CACHE_S_FORMATETC_NOTSUPPORTED = 0x00040170;
const CACHE_S_SAMECACHE = 0x00040171;
const E_ABORT = 0x80004004 | 0;
const CF_BITMAP = 2;
const CF_METAFILEPICT = 3;
const CF_DIB = 8;
const CF_TEXT = 1;
const TYMED_HGLOBAL = 1;
const TYMED_GDI = 16;
const TYMED_MFPICT = 32;
const DVASPECT_CONTENT = 1;
const DVASPECT_ICON = 4;

/** IOleCache2's, IDataObject's, IViewObject2's and IPersistStorage's slots. */
const C = Object.freeze({ Cache: 3, Uncache: 4, EnumCache: 5, SetData: 7 });
const D = Object.freeze({ GetData: 3 });
const V = Object.freeze({ Draw: 3, GetExtent: 9 });
const P = Object.freeze({ IsDirty: 4, Save: 7, Load: 6, InitNew: 5 });

/** A 2x1 32-bit DIB at 200 by 400 pels per metre. */
const DIB = Uint8Array.from([
    0x28, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0xc8, 0, 0, 0, 0x90, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff,
]);

function setup(){
    const p = oleProcess();
    const util = createOleUtil(p.env);
    /** @type {number[][]} */
    const continued = [];
    let goOn = 1;
    const caches = createDataCaches({ ole: p.env, util,
        callFunction: async(_entry, args)=>{
            continued.push(args);
            return goOn;
        } });
    const ole2 = /** @type {Record<string, { handler: Function }>} */ (createOle2Functions(p.env));
    const handlers = createDefaultHandlers({ ole: p.env, util, caches,
        callExport: async(name, guids, args)=>(await ole2[name].handler(
            args(guids.map(guid=>p.guid(guid))))) | 0 });
    /** @param {string} clsid */
    const cache = clsid=>{
        const object = /** @type {any} */ (caches.create(0, clsid));
        return p.env.publish(object, caches.primary(object, IID_IOLECACHE2)) >>> 0;
    };
    /** @param {number} pointer @param {string} iid */
    const query = async(pointer, iid)=>{
        const found = await p.queryPointer(pointer, iid);
        assert.ok(found, `no ${iid}`);
        return found;
    };
    /** A FORMATETC. @param {number} format @param {number} aspect @param {number} tymed */
    const formatEtc = (format, aspect, tymed)=>{
        const at = p.out(0, 20);
        [format, 0, aspect, -1, tymed].forEach((word, index)=>p.put(at + index * 4, word));
        return at;
    };
    /** @param {number} pointer @param {number} slot @param {...number} args */
    const m = async(pointer, slot, ...args)=>(await p.callMethod(pointer, slot, args)) | 0;
    /** The cache's entries as EnumCache lists them: format, aspect, tymed, connection. */
    const listed = async(/** @type {number} */ pointer)=>{
        const out = p.out();
        assert.equal(await m(pointer, C.EnumCache, out), S_OK);
        const record = p.out(0, 32);
        /** @type {number[][]} */
        const items = [];
        while (await m(p.u32(out), 3, 1, record, 0) === S_OK)
        {
            items.push([p.u32(record), p.u32(record + 8), p.u32(record + 16), p.u32(record + 28)]);
        }
        await m(p.u32(out), 2);
        return items;
    };
    /** An HGLOBAL medium of these bytes. @param {Uint8Array} bytes */
    const hglobal = bytes=>{
        const block = p.heap.allocate(bytes.length);
        p.bytes.set(bytes, block);
        const medium = p.out(0, 12);
        p.put(medium, TYMED_HGLOBAL);
        p.put(medium + 4, block);
        return medium;
    };
    return { p, caches, handlers, cache, query, formatEtc, m, listed, hglobal, continued,
        /** @param {number} value */
        setContinue: value=>{
            goOn = value;
        } };
}

test('the cache keeps the formats Windows keeps, numbered from 2, a DIB listed as a bitmap too',
    async()=>{
        // ole2.c test_data_cache and test_data_cache_cache.
        const t = setup();
        const cache = t.cache(GUID_NULL);
        const unknown = await t.query(cache, IID_IUNKNOWN);
        assert.equal(unknown, cache, 'one pointer for IUnknown and IOleCache2');
        await t.m(unknown, 2);
        const conn = t.p.out();
        assert.equal(await t.m(cache, C.Cache, t.formatEtc(CF_DIB, DVASPECT_CONTENT,
            TYMED_HGLOBAL), 0, conn), S_OK);
        assert.equal(t.p.u32(conn), 2);
        assert.deepEqual(await t.listed(cache), [[CF_DIB, 1, TYMED_HGLOBAL, 2],
            [CF_BITMAP, 1, TYMED_GDI, 2]]);
        assert.equal(await t.m(cache, C.Cache, t.formatEtc(CF_BITMAP, DVASPECT_CONTENT, TYMED_GDI),
            0, conn), CACHE_S_SAMECACHE);
        assert.equal(await t.m(cache, C.Cache, t.formatEtc(CF_TEXT, DVASPECT_CONTENT,
            TYMED_HGLOBAL), 0, conn), CACHE_S_FORMATETC_NOTSUPPORTED);
        assert.equal(await t.m(cache, C.Cache, t.formatEtc(CF_METAFILEPICT, DVASPECT_CONTENT,
            TYMED_HGLOBAL), 0, conn), CACHE_S_FORMATETC_NOTSUPPORTED);
        assert.equal(await t.m(cache, C.Cache, t.formatEtc(CF_METAFILEPICT, DVASPECT_CONTENT, 4),
            0, conn), DV_E_TYMED);
        assert.equal(await t.m(cache, C.Cache, t.formatEtc(CF_DIB, DVASPECT_ICON, TYMED_HGLOBAL),
            0, conn), DV_E_FORMATETC, 'the icon is a metafile picture or nothing');
        assert.equal(await t.m(cache, C.Cache, t.formatEtc(0, DVASPECT_ICON, TYMED_HGLOBAL), 0,
            conn), S_OK);
        assert.deepEqual((await t.listed(cache)).at(-1), [CF_METAFILEPICT, DVASPECT_ICON,
            TYMED_MFPICT, t.p.u32(conn)]);

        const picture = t.cache(CLSID_PICTURE_DIB);
        assert.deepEqual(await t.listed(picture), [[CF_DIB, 1, TYMED_HGLOBAL, 1],
            [CF_BITMAP, 1, TYMED_GDI, 1]], 'a static class has its own entry');
        assert.equal(await t.m(picture, C.Cache, t.formatEtc(CF_METAFILEPICT, DVASPECT_CONTENT,
            TYMED_MFPICT), 0, conn) < 0, true);
    });

test('a DIB set in the cache is handed back with a resolution, sized and drawn', async()=>{
    const t = setup();
    const cache = t.cache(GUID_NULL);
    const format = t.formatEtc(CF_DIB, DVASPECT_CONTENT, TYMED_HGLOBAL);
    const conn = t.p.out();
    await t.m(cache, C.Cache, format, 0, conn);
    const data = await t.query(cache, IID_IDATAOBJECT);
    const medium = t.p.out(0, 12);
    assert.equal(await t.m(data, D.GetData, format, medium), OLE_E_BLANK);
    const zero = DIB.slice();
    zero.fill(0, 24, 32);
    assert.equal(await t.m(cache, C.SetData, format, t.hglobal(zero), 0), S_OK);
    assert.equal(await t.m(data, D.GetData, format, medium), S_OK);
    const block = t.p.u32(medium + 4);
    assert.deepEqual([t.p.u32(block + 24), t.p.u32(block + 28)], [3780, 3780],
        'the screen\'s 96 DPI where it names none');

    const view = await t.query(cache, IID_IVIEWOBJECT2);
    const size = t.p.out(0, 8);
    assert.equal(await t.m(view, V.GetExtent, DVASPECT_CONTENT, -1, 0, size), S_OK);
    assert.deepEqual([t.p.u32(size), t.p.u32(size + 4)], [52, 26]);
    assert.equal(await t.m(cache, C.SetData, format, t.hglobal(DIB), 0), S_OK);
    assert.equal(await t.m(view, V.GetExtent, DVASPECT_CONTENT, -1, 0, size), S_OK);
    assert.deepEqual([t.p.u32(size), t.p.u32(size + 4)], [1000, 250]);

    const bounds = t.p.out(0, 16);
    t.p.put(bounds + 8, 100);
    t.p.put(bounds + 12, 100);
    assert.equal(await t.m(view, V.Draw, DVASPECT_ICON, -1, 0, 0, 0, 0x40, bounds, 0, 0x5000,
        7), OLE_E_BLANK);
    t.setContinue(0);
    assert.equal(await t.m(view, V.Draw, DVASPECT_CONTENT, -1, 0, 0, 0, 0x40, bounds, 0, 0x5000,
        7), E_ABORT, 'a continue callback that answers FALSE');
    assert.deepEqual(t.continued, [[7]]);
});

test('the cache saves to numbered presentation streams and loads them back', async()=>{
    const t = setup();
    const storage = t.p.docfile();
    const cache = t.cache(GUID_NULL);
    const format = t.formatEtc(CF_DIB, DVASPECT_CONTENT, TYMED_HGLOBAL);
    await t.m(cache, C.Cache, format, 0, t.p.out());
    await t.m(cache, C.SetData, format, t.hglobal(DIB), 0);
    const persist = await t.query(cache, IID_IPERSISTSTORAGE);
    assert.equal(await t.m(persist, P.InitNew, storage), S_OK);
    assert.equal(await t.m(persist, P.IsDirty), S_OK);
    assert.equal(await t.m(persist, P.Save, storage, 1), S_OK);

    const again = t.cache(GUID_NULL);
    const loader = await t.query(again, IID_IPERSISTSTORAGE);
    assert.equal(await t.m(loader, P.Load, storage), S_OK);
    assert.equal(await t.m(loader, P.IsDirty), S_FALSE);
    assert.deepEqual(await t.listed(again), [[CF_DIB, 1, TYMED_HGLOBAL, 2],
        [CF_BITMAP, 1, TYMED_GDI, 2]]);
    const data = await t.query(again, IID_IDATAOBJECT);
    const medium = t.p.out(0, 12);
    assert.equal(await t.m(data, D.GetData, format, medium), S_OK);
    assert.deepEqual([...t.p.bytes.slice(t.p.u32(medium + 4), t.p.u32(medium + 4) + DIB.length)],
        [...DIB]);
});

test('the default handler answers for a server that is not running, and writes \\1Ole', async()=>{
    // ole2.c test_default_handler, defaulthandler.c test_olestream.
    const t = setup();
    const out = t.p.out();
    const clsid = '{9474BA1A-258B-490B-BC13-516E9239ACE0}';
    assert.equal(await t.handlers.create(clsid, 0, 0, 0, IID_IOLEOBJECT, out, t.p.thread), S_OK);
    const object = t.p.u32(out);
    assert.equal(await t.m(object, 9, 0, 1, 0), OLE_E_NOTRUNNING, 'InitFromData');
    assert.equal(await t.m(object, 14), OLE_E_NOTRUNNING, 'IsUpToDate');
    assert.equal(await t.m(object, 17, 1, t.p.out(0, 8)), OLE_E_NOTRUNNING, 'SetExtent');
    assert.equal(await t.m(object, 18, 1, t.p.out(0, 8)), OLE_E_BLANK, 'GetExtent: nothing cached');
    const moniker = t.p.out();
    assert.equal(await t.m(object, 8, 1, 2, moniker), 0x80004005 | 0, 'no site, no moniker');
    const runnable = await t.query(object, IID_IRUNNABLEOBJECT);
    assert.equal(await t.m(runnable, 4), 0x80040154 | 0, 'Run: the class is not registered');
    assert.equal(await t.m(runnable, 5), 0, 'IsRunning');

    const storage = t.p.docfile();
    const persist = await t.query(object, IID_IPERSISTSTORAGE);
    assert.equal(await t.m(persist, P.InitNew, storage), S_OK);
    const name = t.p.wide('\x01Ole');
    const stream = t.p.out();
    assert.equal(await t.m(storage, 4, name, 0, 0x10, 0, stream), S_OK);
    const header = t.p.out(0, 20);
    await t.m(t.p.u32(stream), 3, header, 20, 0);
    assert.deepEqual([0, 4, 8, 12, 16].map(offset=>t.p.u32(header + offset)),
        [0x02000001, 0, 0, 0, 0]);
});

test('an embedding helper passes what it lacks to its server, whatever the server answers',
    async()=>{
        // ole2.c test_default_handler: the delegate's failure is the answer.
        const t = setup();
        const server = t.p.guestObject([], {
            0: (/** @type {number[]} */ [, out])=>{
                t.p.put(out, 0);
                return 0x87654321 | 0;
            },
        });
        const factory = t.p.guestObject([], {
            3: (/** @type {number[]} */ [, , out])=>{
                t.p.put(out, server.pointer);
                server.refs++;
                return S_OK;
            },
        });
        const out = t.p.out();
        assert.equal(await t.handlers.create('{9474BA1A-258B-490B-BC13-516E9239ACE0}', 0, 1,
            factory.pointer, IID_IOLEOBJECT, out, t.p.thread), S_OK);
        const wanted = t.p.guid('{12345678-1111-2222-3333-444444444444}');
        assert.equal(await t.m(t.p.u32(out), 0, wanted, t.p.out()), 0x87654321 | 0);
        assert.equal(await t.m(t.p.u32(out), 0, t.p.guid(IID_IPERSISTSTORAGE), t.p.out()), S_OK,
            'what the handler has itself is its own');
    });
