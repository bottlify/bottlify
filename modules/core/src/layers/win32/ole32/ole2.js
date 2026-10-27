/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The OLE 2 helpers a container calls around an embedded object: running
 * it, drawing it, saving and loading it, the registry's word on its class,
 * the format and user type its storage carries, the accelerators of an
 * in-place frame -- and the creation calls, which make an object only where
 * its class has a server in this process.
 *
 * Almost everything here is a sequence of calls on the object's own
 * interfaces, made in the order Windows makes them (as ole32's conformance
 * tests record it), because a server's implementation is the program's and
 * the order is what it sees. Where a call needs a server that is not here --
 * a class registered only as a local server, an object embedded from another
 * application's data, OLE's own static picture classes -- it fails the way
 * Windows fails for a class with no server: REGDB_E_CLASSNOTREG, and the
 * refusal is named once.
 */

import { GUID_NULL, GUID_SIZE, formatGuid, parseGuid } from './guid.js';
import { HKEY_CLASSES_ROOT, REG_SZ } from '../advapi32/registry.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { createRefusals } from '../common/refusal.js';
import { publishEnumerator } from './enumerator.js';
import { CF, DVASPECT_CONTENT, FORMATETC_SIZE, SLOT, createOleUtil } from './oleutil.js';

const S_OK = 0;
const S_FALSE = 1;
const E_NOINTERFACE = 0x80004002 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const E_INVALIDARG = 0x80070057 | 0;
const REGDB_E_KEYMISSING = 0x80040152 | 0;
const REGDB_E_CLASSNOTREG = 0x80040154 | 0;
const REGDB_E_WRITEREGDB = 0x80040151 | 0;
const GMEM_MOVEABLE = 0x0002;
const MM_ANISOTROPIC = 8;
const SM_CXICON = 11;
const SM_CYICON = 12;
const HIMETRIC_PER_INCH = 2540;
const CO_E_CLASSSTRING = 0x800401f3 | 0;
const CO_E_NOTINITIALIZED = 0x800401f0 | 0;
const OLE_S_STATIC = 0x00040001;
const OLE_E_CANT_GETMONIKER = 0x80040009 | 0;
const OLE_E_STATIC = 0x8004000b | 0;
const OLEOBJ_E_NOVERBS = 0x80040180 | 0;
const DV_E_FORMATETC = 0x80040064 | 0;
const DV_E_CLIPFORMAT = 0x8004006a | 0;
const DV_E_NOIVIEWOBJECT = 0x80040073 | 0;
const STG_E_FILENOTFOUND = 0x80030002 | 0;
const STG_E_READFAULT = 0x8003001e | 0;
const DRAGDROP_S_CANCEL = 0x00040101;
const CONVERT10_E_OLESTREAM_FMT = 0x800401c2 | 0;
const CONVERT10_E_STG_NO_STD_STREAM = 0x800401c5 | 0;

const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';
const IID_IVIEWOBJECT = '{0000010D-0000-0000-C000-000000000046}';
const IID_IPERSISTSTORAGE = '{0000010A-0000-0000-C000-000000000046}';
const IID_IOLEOBJECT = '{00000112-0000-0000-C000-000000000046}';
const IID_IOLECACHE = '{0000011E-0000-0000-C000-000000000046}';
const IID_IRUNNABLEOBJECT = '{00000126-0000-0000-C000-000000000046}';
const IID_IENUMOLEVERB = '{00000104-0000-0000-C000-000000000046}';
/** This layer's class of a verb enumerator. */
const CLSID_VERB_ENUMERATOR = '{7b5b0b8e-1f8c-4b36-9d1c-2a6d4e4b0033}';

/** IRunnableObject's methods after IUnknown's. */
const RUNNABLE = Object.freeze({ RUN: 4, IS_RUNNING: 5, LOCK_RUNNING: 6, SET_CONTAINED: 7 });
/** IOleObject's SetClientSite and GetMiscStatus; IPersistStorage's; IOleCache::Cache. */
const OLEOBJECT_SET_CLIENT_SITE = 3;
const OLEOBJECT_GET_MISC_STATUS = 22;
const PERSIST = Object.freeze({ GET_CLASS_ID: 3, INIT_NEW: 5, LOAD: 6, SAVE: 7 });
const OLECACHE_CACHE = 3;
const VIEWOBJECT_DRAW = 3;
/** IOleInPlaceFrame::TranslateAccelerator, after IOleWindow's and IOleInPlaceUIWindow's. */
const FRAME_TRANSLATE_ACCELERATOR = 14;

/** CLSCTX_INPROC_SERVER | CLSCTX_INPROC_HANDLER: where an embedding's object is made. */
const CLSCTX_INPROC = 3;
const OLEMISC_SETCLIENTSITEFIRST = 0x20000;
const OLERENDER = Object.freeze({ NONE: 0, DRAW: 1, FORMAT: 2, ASIS: 3 });
const ADVF_PRIMEFIRST = 2;
const USERCLASSTYPE_FULL = 1;

/** STGM_* of the streams OLE keeps in an object's storage. */
const STGM_READ = 0;
const STGM_READWRITE = 2;
const STGM_SHARE_EXCLUSIVE = 0x10;
const STGM_CREATE = 0x1000;
const COMP_OBJ_STREAM = '\u0001CompObj';
const OLE_STREAM = '\u0001Ole';
/** The \1Ole stream: its version, and the flag SetConvertStg sets. */
const OLE_STREAM_VERSION = 0x02000001;
const OLE_STREAM_HEADER = 20;
const OLESTREAM_CONVERT = 4;

/** OLEVERB: lVerb, lpszVerbName, fuFlags, grfAttribs. */
const OLEVERB_SIZE = 16;
/** OLEINPLACEFRAMEINFO's haccel and cAccelEntries. */
const FRAMEINFO_ACCEL = 12;
const FRAMEINFO_ACCEL_COUNT = 16;
/** OLEMENUGROUPWIDTHS, six LONGs; the descriptor is the menu and them. */
const MENU_WIDTHS_SIZE = 24;

/** The key messages an accelerator answers, and what an ACCEL entry is. */
const WM_KEYDOWN = 0x100;
const WM_CHAR = 0x102;
const WM_SYSKEYDOWN = 0x104;
const WM_SYSCHAR = 0x106;
const ACCEL_SIZE = 6;
const FVIRTKEY = 0x01;
const FSHIFT = 0x04;
const FCONTROL = 0x08;
const FALT = 0x10;
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
/** A key message's context code: Alt was down. */
const KF_ALTDOWN_BIT = 0x20000000;

/** The \1CompObj stream's header, and the mark the Unicode half starts with. */
const COMPOBJ_RESERVED = 0xfffe0001;
const COMPOBJ_VERSION = 0x00000a03;
const COMPOBJ_UNICODE_MARKER = 0x71b239f4;
const COMPOBJ_HEADER = 28;

/**
 * A clipboard format as the \1CompObj stream carries it: a predefined one by
 * number, a registered one by name.
 *
 * @typedef {{ id: number } | { name: string } | null} CompObjFormat
 */

/**
 * @typedef {Object} CompObj
 * @property {Uint8Array} clsid
 * @property {string | null} userType
 * @property {CompObjFormat} format
 * @property {string | null} progId
 */

/**
 * The \1CompObj stream ([MS-OLEDS] CompObjStream): the header with the
 * class, the user type, the clipboard format and the ProgID in the ANSI
 * page, then the marker and the same three in UTF-16. An absent string is
 * a length of zero.
 *
 * @param {CompObj} record
 * @returns {Uint8Array}
 */
export function encodeCompObj(record){
    /** @type {number[]} */
    const bytes = [];
    /** @param {number} value */
    const word = value=>{
        bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff,
            (value >>> 24) & 0xff);
    };
    /** @param {string | null} text */
    const ansi = text=>{
        if (text === null)
        {
            word(0);
            return;
        }
        const encoded = encodeAnsi(text);
        word(encoded.length + 1);
        bytes.push(...encoded, 0);
    };
    /** @param {string | null} text */
    const wide = text=>{
        if (text === null)
        {
            word(0);
            return;
        }
        word(text.length + 1);
        for (const unit of `${text}\0`)
        {
            bytes.push(unit.charCodeAt(0) & 0xff, unit.charCodeAt(0) >>> 8);
        }
    };
    /** @param {(text: string | null) => void} named */
    const format = named=>{
        if (record.format === null)
        {
            word(0);
        }
        else if ('id' in record.format)
        {
            word(0xffffffff);
            word(record.format.id);
        }
        else
        {
            named(record.format.name);
        }
    };
    word(COMPOBJ_RESERVED);
    word(COMPOBJ_VERSION);
    word(0xffffffff);
    bytes.push(...record.clsid);
    ansi(record.userType);
    format(ansi);
    ansi(record.progId);
    word(COMPOBJ_UNICODE_MARKER);
    wide(record.userType);
    format(wide);
    wide(record.progId);
    return Uint8Array.from(bytes);
}

/**
 * Reads a \1CompObj stream back; the Unicode half, where there is one, is
 * what is believed. Null for a stream too short to be one.
 *
 * @param {Uint8Array} bytes
 * @returns {CompObj | null}
 */
export function decodeCompObj(bytes){
    if (bytes.length < COMPOBJ_HEADER)
    {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    let at = COMPOBJ_HEADER;
    let broken = false;
    const word = ()=>{
        if (at + 4 > bytes.length)
        {
            broken = true;
            return 0;
        }
        at += 4;
        return view.getUint32(at - 4, true);
    };
    /** @param {number} unit @returns {string | null} */
    const string = unit=>{
        const length = word();
        if (length === 0 || broken)
        {
            return null;
        }
        if (at + length * unit > bytes.length)
        {
            broken = true;
            return null;
        }
        let text = '';
        if (unit === 1)
        {
            text = decodeAnsi(bytes.subarray(at, at + length));
        }
        else
        {
            for (let index = 0; index < length; index++)
            {
                text += String.fromCharCode(view.getUint16(at + index * 2, true));
            }
        }
        at += length * unit;
        return text.replace(/\0+$/, '');
    };
    /** @param {number} unit @returns {CompObjFormat} */
    const format = unit=>{
        const marker = word();
        if (marker === 0 || broken)
        {
            return null;
        }
        if (marker === 0xffffffff || marker === 0xfffffffe)
        {
            return { id: word() & 0xffff };
        }
        at -= 4;
        const name = string(unit);
        return name === null ? null : { name };
    };
    const record = {
        clsid: bytes.slice(12, 12 + GUID_SIZE),
        userType: string(1),
        format: format(1),
        progId: string(1),
    };
    if (broken)
    {
        return null;
    }
    if (word() === COMPOBJ_UNICODE_MARKER && !broken)
    {
        const userType = string(2);
        const wideFormat = format(2);
        const progId = string(2);
        if (!broken)
        {
            return { clsid: record.clsid, userType, format: wideFormat, progId };
        }
    }
    return record;
}

/**
 * Builds the table: name -> { argBytes, handler }.
 *
 * @param {import('./oleutil.js').OleEnv} env
 */
export function createOle2Functions(env){
    const util = createOleUtil(env);
    const { readU32, writeU32, writeU16, withScratch, release } = util;
    const refuse = createRefusals({ divergence: env.divergence });

    /** @param {number} address */
    const guidAt = address=>formatGuid(env.readMemory(address >>> 0, GUID_SIZE));
    /** @param {number} address @param {string} guid */
    const writeGuid = (address, guid)=>env.writeMemory(address >>> 0,
        /** @type {Uint8Array} */ (parseGuid(guid)));

    /**
     * A key under HKEY_CLASSES_ROOT, or null.
     *
     * @param {string} path
     */
    const classesKey = path=>{
        const root = env.hive?.root(HKEY_CLASSES_ROOT);
        return root ? env.hive?.open(root, path) ?? null : null;
    };
    /**
     * A string value, as the hive keeps it in the ANSI page; null when absent.
     *
     * @param {any} key @param {string} [name]
     */
    const stringOf = (key, name = '')=>{
        const value = key ? env.hive?.getValue(key, name) : null;
        if (!value)
        {
            return null;
        }
        const end = value.data.indexOf(0);
        return decodeAnsi(end < 0 ? value.data : value.data.subarray(0, end));
    };

    /**
     * The registry's user type of a class in one of its forms: the full
     * name is the class key's own value, the others AuxUserType\<form>,
     * falling back to the full name -- as compobj.c's test_OleRegGetUserType
     * reads them. Null for a class with no key or no name.
     *
     * @param {string} clsid @param {number} form
     */
    const userTypeOf = (clsid, form)=>{
        const key = classesKey(`CLSID\\${clsid}`);
        if (!key)
        {
            return null;
        }
        const aux = form === USERCLASSTYPE_FULL ? null
            : stringOf(classesKey(`CLSID\\${clsid}\\AuxUserType\\${form}`));
        return aux ?? stringOf(key);
    };

    /**
     * The class a class converts to: AutoConvertTo under its key.
     *
     * @param {string} clsid
     * @returns {{ hr: number, guid: string }}
     */
    const autoConvertOf = clsid=>{
        if (!classesKey(`CLSID\\${clsid}`))
        {
            return { hr: REGDB_E_CLASSNOTREG, guid: GUID_NULL };
        }
        const text = stringOf(classesKey(`CLSID\\${clsid}\\AutoConvertTo`));
        if (text === null)
        {
            return { hr: REGDB_E_KEYMISSING, guid: GUID_NULL };
        }
        const bytes = parseGuid(text);
        return bytes ? { hr: S_OK, guid: formatGuid(bytes) } : { hr: CO_E_CLASSSTRING,
            guid: GUID_NULL };
    };

    /**
     * QueryInterface for IRunnableObject, then one of its methods; what an
     * object without one answers otherwise.
     *
     * @param {number} unknown @param {number} slot @param {number[]} args
     * @param {number} without
     */
    const throughRunnable = async(unknown, slot, args, without)=>{
        const thread = env.callerThread();
        const runnable = await env.queryPointer(unknown, IID_IRUNNABLEOBJECT, thread);
        if (runnable === 0)
        {
            return without;
        }
        const answer = (await env.callMethod(runnable, slot, args, thread)) | 0;
        await release(runnable, thread);
        return answer;
    };

    /**
     * \1CompObj written through the storage: its class as Stat says it, the
     * ProgID the registry gives that class, and the rest as asked.
     *
     * @param {number} storage @param {CompObjFormat} format
     * @param {string | null} userType @param {unknown} thread
     */
    const writeCompObj = async(storage, format, userType, thread)=>{
        const stat = await util.storageClass(storage, thread);
        if (stat.hr < 0)
        {
            return stat.hr;
        }
        const progId = stringOf(classesKey(`CLSID\\${formatGuid(stat.clsid)}\\ProgID`));
        const opened = await util.openStream(storage, COMP_OBJ_STREAM,
            STGM_CREATE | STGM_SHARE_EXCLUSIVE | STGM_READWRITE, true, thread);
        if (opened.hr < 0)
        {
            return opened.hr;
        }
        const hr = await util.writeStream(opened.stream,
            encodeCompObj({ clsid: stat.clsid, userType, format, progId }), thread);
        await release(opened.stream, thread);
        return hr < 0 ? hr : S_OK;
    };

    /**
     * \1CompObj read through the storage.
     *
     * @param {number} storage @param {unknown} thread
     * @returns {Promise<{ hr: number, record: CompObj | null }>}
     */
    const readCompObj = async(storage, thread)=>{
        const opened = await util.openStream(storage, COMP_OBJ_STREAM,
            STGM_SHARE_EXCLUSIVE | STGM_READ, false, thread);
        if (opened.hr < 0)
        {
            return { hr: opened.hr, record: null };
        }
        const read = await util.readStream(opened.stream, thread);
        await release(opened.stream, thread);
        if (read.hr < 0)
        {
            return { hr: read.hr, record: null };
        }
        const record = decodeCompObj(read.bytes);
        return { hr: record ? S_OK : STG_E_READFAULT, record };
    };

    /**
     * The \1Ole stream's flags word; the stream made with only the header
     * when it is not there, as SetConvertStg makes it.
     *
     * @param {number} storage @param {boolean} convert @param {unknown} thread
     */
    const setConvert = async(storage, convert, thread)=>{
        const opened = await util.openStream(storage, OLE_STREAM,
            STGM_SHARE_EXCLUSIVE | STGM_READWRITE, false, thread);
        if (opened.hr === STG_E_FILENOTFOUND)
        {
            const made = await util.openStream(storage, OLE_STREAM,
                STGM_CREATE | STGM_SHARE_EXCLUSIVE | STGM_READWRITE, true, thread);
            if (made.hr < 0)
            {
                return made.hr;
            }
            const header = new Uint8Array(OLE_STREAM_HEADER);
            new DataView(header.buffer).setUint32(0, OLE_STREAM_VERSION, true);
            new DataView(header.buffer).setUint32(4, convert ? OLESTREAM_CONVERT : 0, true);
            const hr = await util.writeStream(made.stream, header, thread);
            await release(made.stream, thread);
            return hr < 0 ? hr : S_OK;
        }
        if (opened.hr < 0)
        {
            return opened.hr;
        }
        const read = await util.readStream(opened.stream, thread);
        let hr = read.hr;
        if (hr >= 0)
        {
            const flags = read.bytes.length >= 8
                ? new DataView(read.bytes.buffer).getUint32(4, true) : 0;
            const wanted = convert ? (flags | OLESTREAM_CONVERT) >>> 0
                : (flags & ~OLESTREAM_CONVERT) >>> 0;
            if (wanted !== flags || read.bytes.length < 8)
            {
                await env.callMethod(opened.stream, SLOT.STREAM_SEEK, [4, 0, 0, 0], thread);
                const word = new Uint8Array(4);
                new DataView(word.buffer).setUint32(0, wanted, true);
                hr = await util.writeStream(opened.stream, word, thread);
            }
        }
        await release(opened.stream, thread);
        return hr < 0 ? hr : S_OK;
    };

    /**
     * The steps OLE takes on an object it has just made, before it hands it
     * out: asked its status when there is a client site, given the site first
     * if it says OLEMISC_SETCLIENTSITEFIRST, its storage initialised or
     * loaded through IPersistStorage, then given the site.
     *
     * @param {number} unknown @param {number} site
     * @param {(persist: number) => Promise<number>} initialise
     * @param {unknown} thread
     */
    const prepare = async(unknown, site, initialise, thread)=>{
        const object = site !== 0 ? await env.queryPointer(unknown, IID_IOLEOBJECT, thread) : 0;
        try
        {
            let first = false;
            if (object !== 0)
            {
                const status = await withScratch(4, async block=>{
                    const hr = (await env.callMethod(object, OLEOBJECT_GET_MISC_STATUS,
                        [DVASPECT_CONTENT, block], thread)) | 0;
                    return hr < 0 ? 0 : readU32(block);
                });
                first = ((status ?? 0) & OLEMISC_SETCLIENTSITEFIRST) !== 0;
                if (first)
                {
                    await env.callMethod(object, OLEOBJECT_SET_CLIENT_SITE, [site], thread);
                }
            }
            const persist = await env.queryPointer(unknown, IID_IPERSISTSTORAGE, thread);
            if (persist === 0)
            {
                return E_NOINTERFACE;
            }
            const hr = await initialise(persist);
            await release(persist, thread);
            if (hr < 0)
            {
                return hr;
            }
            if (object !== 0 && !first)
            {
                await env.callMethod(object, OLEOBJECT_SET_CLIENT_SITE, [site], thread);
            }
            return S_OK;
        }
        finally
        {
            if (object !== 0)
            {
                await release(object, thread);
            }
        }
    };

    /**
     * Makes an object of a class in process, as IUnknown: its pointer or the
     * failure, a class with no server here said once.
     *
     * @param {string} clsid @param {string} api
     * @returns {Promise<{ hr: number, unknown: number }>}
     */
    const makeObject = async(clsid, api)=>(await withScratch(4, async block=>{
        const hr = (await env.createInstance(clsid, 0, CLSCTX_INPROC, IID_IUNKNOWN, block)) | 0;
        if (hr === REGDB_E_CLASSNOTREG)
        {
            util.sayOnce(api, `class ${clsid} has no server in this process`);
        }
        return { hr, unknown: hr < 0 ? 0 : readU32(block) };
    })) ?? { hr: E_OUTOFMEMORY, unknown: 0 };

    /**
     * The object handed out as the interface the caller asked for, and the
     * reference the steps above held let go of.
     *
     * @param {number} unknown @param {number} riid @param {number} out
     * @param {number} hr  How the steps went.
     * @param {unknown} thread
     */
    const handOut = async(unknown, riid, out, hr, thread)=>{
        let answer = hr;
        if (hr >= 0)
        {
            answer = (await env.callMethod(unknown, SLOT.QUERY_INTERFACE, [riid, out], thread)) | 0;
        }
        await release(unknown, thread);
        if (answer < 0)
        {
            writeU32(out, 0);
        }
        return answer;
    };

    /**
     * The registered numbers of the named formats; none with no user32.
     *
     * @param {string[]} names @param {unknown} thread
     */
    const registered = async(names, thread)=>{
        const numbers = new Set();
        for (const name of names)
        {
            const format = await util.registerFormat(name, thread);
            if (format !== 0)
            {
                numbers.add(format);
            }
        }
        return numbers;
    };

    /** The formats a static object can be made of. */
    /** @type {Set<number>} */
    const STATIC_FORMATS = new Set([CF.METAFILEPICT, CF.BITMAP, CF.DIB, CF.ENHMETAFILE]);

    /**
     * OleQueryCreateFromData's answer: S_OK for data an embedding comes
     * from, OLE_S_STATIC for a picture only, S_FALSE for neither.
     *
     * @param {number} data @param {unknown} thread
     */
    const creatableFrom = async(data, thread)=>{
        const formats = (await util.formatsOf(data, thread)).map(format=>format.format);
        const embeddable = await registered(['Embedded Object', 'Embed Source', 'FileName'],
            thread);
        if (formats.some(format=>embeddable.has(format)))
        {
            return S_OK;
        }
        return formats.some(format=>STATIC_FORMATS.has(format)) ? OLE_S_STATIC : S_FALSE;
    };

    /** @param {number} data @param {unknown} thread */
    const linkableFrom = async(data, thread)=>{
        const formats = (await util.formatsOf(data, thread)).map(format=>format.format);
        const link = await registered(['Link Source'], thread);
        return formats.some(format=>link.has(format)) ? S_OK : S_FALSE;
    };

    /**
     * The command an accelerator table gives a key message, or null: a
     * virtual-key entry for WM_KEYDOWN and WM_SYSKEYDOWN with exactly its
     * Shift, Ctrl and Alt down, a character entry for WM_CHAR and
     * WM_SYSCHAR, Alt as its FALT says.
     *
     * @param {number} table @param {number} count @param {number} message
     * @param {unknown} thread
     * @returns {Promise<number | null>}
     */
    const acceleratorFor = async(table, count, message, thread)=>{
        if (table === 0 || message === 0 || (count | 0) <= 0)
        {
            return null;
        }
        const kind = readU32(message + 4);
        const keyMessage = kind === WM_KEYDOWN || kind === WM_SYSKEYDOWN;
        if (!keyMessage && kind !== WM_CHAR && kind !== WM_SYSCHAR)
        {
            return null;
        }
        const key = readU32(message + 8) & 0xffff;
        const alt = (readU32(message + 12) & KF_ALTDOWN_BIT) !== 0;
        const entries = await withScratch((count | 0) * ACCEL_SIZE, async block=>{
            const copied = await util.system('USER32.dll', 'CopyAcceleratorTableW',
                [table, block, count | 0], thread);
            if (copied === null)
            {
                util.sayOnce('IsAccelerator', 'no accelerator table can be read here');
            }
            return env.readMemory(block, Math.max(copied ?? 0, 0) * ACCEL_SIZE).slice();
        });
        if (!entries || entries.length === 0)
        {
            return null;
        }
        /** @param {number} virtualKey */
        const down = async virtualKey=>(((await util.system('USER32.dll', 'GetKeyState',
            [virtualKey], thread)) ?? 0) & 0x8000) !== 0;
        const modifiers = keyMessage
            ? ((await down(VK_SHIFT)) ? FSHIFT : 0) | ((await down(VK_CONTROL)) ? FCONTROL : 0)
                | (alt ? FALT : 0)
            : 0;
        for (let at = 0; at + ACCEL_SIZE <= entries.length; at += ACCEL_SIZE)
        {
            const flags = entries[at];
            const entryKey = entries[at + 2] | (entries[at + 3] << 8);
            const command = entries[at + 4] | (entries[at + 5] << 8);
            if (entryKey !== key)
            {
                continue;
            }
            if ((flags & FVIRTKEY) !== 0)
            {
                if (keyMessage && (flags & (FSHIFT | FCONTROL | FALT)) === modifiers)
                {
                    return command;
                }
            }
            else if (!keyMessage && ((flags & FALT) !== 0) === alt)
            {
                return command;
            }
        }
        return null;
    };

    /**
     * A refusal whose out-parameter, at `out` among the arguments, is zeroed
     * first: a program reads the pointer as often as the answer.
     *
     * @param {string} name @param {number} argBytes @param {number} out
     * @param {number} answer @param {string} why
     */
    const refuseWithOut = (name, argBytes, out, answer, why)=>{
        const refusal = refuse(name, { argBytes, answer, why });
        return {
            argBytes,
            /** @param {number[]} args */
            handler: args=>{
                if ((args[out] >>> 0) !== 0)
                {
                    writeU32(args[out], 0);
                }
                return refusal.handler();
            },
        };
    };

    const table = {
        /**
         * HRESULT OleRun(LPUNKNOWN pUnknown)
         *
         * IRunnableObject::Run with no bind context; an object without one
         * is running already (ole2.c test_OleRun).
         */
        OleRun: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([unknown])=>((unknown >>> 0) === 0 ? E_INVALIDARG
                : throughRunnable(unknown >>> 0, RUNNABLE.RUN, [0], S_OK)),
        },

        /**
         * BOOL OleIsRunning(LPOLEOBJECT pObject)
         *
         * NULL is not running; an object without IRunnableObject is (ole2.c
         * test_runnable).
         */
        OleIsRunning: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: async([object])=>((object >>> 0) === 0 ? 0
                : ((await throughRunnable(object >>> 0, RUNNABLE.IS_RUNNING, [], 1)) !== 0
                    ? 1 : 0)),
        },

        /** HRESULT OleLockRunning(LPUNKNOWN pUnknown, BOOL fLock, BOOL fLastUnlockCloses) */
        OleLockRunning: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([unknown, lock, closes])=>((unknown >>> 0) === 0 ? E_INVALIDARG
                : throughRunnable(unknown >>> 0, RUNNABLE.LOCK_RUNNING, [lock, closes], S_OK)),
        },

        /**
         * HRESULT OleSetContainedObject(LPUNKNOWN pUnknown, BOOL fContained)
         *
         * IRunnableObject::SetContainedObject, as documented; nothing to tell
         * an object without one.
         */
        OleSetContainedObject: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([unknown, contained])=>((unknown >>> 0) === 0 ? E_INVALIDARG
                : throughRunnable(unknown >>> 0, RUNNABLE.SET_CONTAINED, [contained], S_OK)),
        },

        /**
         * HRESULT OleDraw(LPUNKNOWN pUnk, DWORD dwAspect, HDC hdcDraw, LPCRECT lprcBounds)
         *
         * IViewObject::Draw of the whole object, no target device; a RECT is
         * a RECTL here, so the bounds go as they came (ole2.c test_OleDraw).
         */
        OleDraw: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: async([unknown, aspect, hdc, bounds])=>{
                if ((unknown >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const thread = env.callerThread();
                const view = await env.queryPointer(unknown >>> 0, IID_IVIEWOBJECT, thread);
                if (view === 0)
                {
                    return DV_E_NOIVIEWOBJECT;
                }
                const hr = (await env.callMethod(view, VIEWOBJECT_DRAW,
                    [aspect, -1 >>> 0, 0, 0, 0, hdc, bounds, 0, 0, 0], thread)) | 0;
                await release(view, thread);
                return hr;
            },
        },

        /**
         * HRESULT OleSave(LPPERSISTSTORAGE pPS, LPSTORAGE pStg, BOOL fSameAsLoad)
         *
         * The object's class into the storage, then its own Save, then the
         * storage committed; SaveCompleted is the caller's.
         */
        OleSave: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: async([persist, storage, same])=>{
                if ((persist >>> 0) === 0 || (storage >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const thread = env.callerThread();
                const classed = await withScratch(GUID_SIZE, async block=>{
                    const hr = (await env.callMethod(persist >>> 0, PERSIST.GET_CLASS_ID,
                        [block], thread)) | 0;
                    return hr < 0 ? hr
                        : (await env.callMethod(storage >>> 0, SLOT.STORAGE_SET_CLASS, [block],
                            thread)) | 0;
                }) ?? E_OUTOFMEMORY;
                if (classed < 0)
                {
                    return classed;
                }
                const saved = (await env.callMethod(persist >>> 0, PERSIST.SAVE,
                    [storage, same], thread)) | 0;
                if (saved < 0)
                {
                    return saved;
                }
                return (await env.callMethod(storage >>> 0, SLOT.STORAGE_COMMIT, [0], thread)) | 0;
            },
        },

        /**
         * HRESULT OleCreate(REFCLSID rclsid, REFIID riid, DWORD renderopt,
         *   LPFORMATETC pFormatEtc, LPOLECLIENTSITE pClientSite, LPSTORAGE pStg,
         *   LPVOID *ppvObj)
         *
         * The object made in process, its storage initialised new, the site
         * given, and -- to draw or for a format -- run and its cache asked
         * for the presentation, in the order ole2.c test_OleCreate records.
         * A class whose server is not in process has no default handler to
         * stand in for it here, and is refused as unregistered.
         */
        OleCreate: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: async([rclsid, riid, renderopt, formatEtc, site, storage, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                const render = renderopt >>> 0;
                if ((rclsid >>> 0) === 0 || (riid >>> 0) === 0 || (storage >>> 0) === 0
                    || (render === OLERENDER.FORMAT && (formatEtc >>> 0) === 0))
                {
                    return E_INVALIDARG;
                }
                const thread = env.callerThread();
                const made = await makeObject(guidAt(rclsid), 'OleCreate');
                if (made.hr < 0)
                {
                    return made.hr;
                }
                let hr = await prepare(made.unknown, site >>> 0, async persist=>
                    (await env.callMethod(persist, PERSIST.INIT_NEW, [storage], thread)) | 0,
                thread);
                if (hr >= 0 && (render === OLERENDER.DRAW || render === OLERENDER.FORMAT))
                {
                    hr = await throughRunnable(made.unknown, RUNNABLE.RUN, [0], S_OK);
                    const cache = hr < 0 ? 0
                        : await env.queryPointer(made.unknown, IID_IOLECACHE, thread);
                    if (cache !== 0)
                    {
                        hr = await withScratch(FORMATETC_SIZE + 4, async block=>{
                            util.writeWords(block, [0, 0, DVASPECT_CONTENT, -1, 0]);
                            const format = render === OLERENDER.FORMAT ? formatEtc >>> 0 : block;
                            return (await env.callMethod(cache, OLECACHE_CACHE,
                                [format, ADVF_PRIMEFIRST, block + FORMATETC_SIZE], thread)) | 0;
                        }) ?? E_OUTOFMEMORY;
                        await release(cache, thread);
                    }
                }
                return handOut(made.unknown, riid >>> 0, out >>> 0, hr, thread);
            },
        },

        /**
         * HRESULT OleLoad(LPSTORAGE pStg, REFIID riid, LPOLECLIENTSITE pClientSite,
         *   LPVOID *ppvObj)
         *
         * The storage's class made in process, then loaded from it with the
         * site given around the load as OleCreate gives it (ole2.c
         * test_OleLoad). Windows would put an object of a class with no
         * server in its default handler; here that is the unregistered class.
         */
        OleLoad: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: async([storage, riid, site, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                if ((storage >>> 0) === 0 || (riid >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const thread = env.callerThread();
                const stat = await util.storageClass(storage >>> 0, thread);
                if (stat.hr < 0)
                {
                    return stat.hr;
                }
                const made = await makeObject(formatGuid(stat.clsid), 'OleLoad');
                if (made.hr < 0)
                {
                    return made.hr;
                }
                const hr = await prepare(made.unknown, site >>> 0, async persist=>
                    (await env.callMethod(persist, PERSIST.LOAD, [storage], thread)) | 0, thread);
                return handOut(made.unknown, riid >>> 0, out >>> 0, hr, thread);
            },
        },

        /**
         * HRESULT OleRegGetUserType(REFCLSID clsid, DWORD dwFormOfType, LPOLESTR *pszUserType)
         *
         * The class's name in the form asked for, in task memory; a class
         * with no key is not registered, whatever the form (compobj.c
         * test_OleRegGetUserType).
         */
        OleRegGetUserType: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([rclsid, form, out])=>{
                if ((out >>> 0) === 0 || (rclsid >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                const text = userTypeOf(guidAt(rclsid), form >>> 0);
                if (text === null)
                {
                    return REGDB_E_CLASSNOTREG;
                }
                const block = util.lendWide(text);
                if (block === 0)
                {
                    return E_OUTOFMEMORY;
                }
                writeU32(out, block);
                return S_OK;
            },
        },

        /**
         * HRESULT OleRegGetMiscStatus(REFCLSID clsid, DWORD dwAspect, DWORD *pdwStatus)
         *
         * MiscStatus\<aspect> under the class's key, or MiscStatus itself, a
         * decimal number; none is zero.
         */
        OleRegGetMiscStatus: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([rclsid, aspect, out])=>{
                if ((out >>> 0) === 0 || (rclsid >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                const clsid = guidAt(rclsid);
                if (!classesKey(`CLSID\\${clsid}`))
                {
                    return REGDB_E_CLASSNOTREG;
                }
                const text = stringOf(classesKey(`CLSID\\${clsid}\\MiscStatus\\${aspect >>> 0}`))
                    ?? stringOf(classesKey(`CLSID\\${clsid}\\MiscStatus`));
                writeU32(out, Number.parseInt(text ?? '0', 10) || 0);
                return S_OK;
            },
        },

        /**
         * HRESULT OleRegEnumVerbs(REFCLSID clsid, LPENUMOLEVERB *ppenum)
         *
         * The class's Verb\<n> keys, each "name,menu flags,verb attributes",
         * in the order the registry enumerates them; each name is handed out
         * in task memory for the caller to free.
         */
        OleRegEnumVerbs: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([rclsid, out])=>{
                if ((out >>> 0) === 0 || (rclsid >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                const clsid = guidAt(rclsid);
                if (!classesKey(`CLSID\\${clsid}`))
                {
                    return REGDB_E_CLASSNOTREG;
                }
                const verbs = classesKey(`CLSID\\${clsid}\\Verb`);
                const names = verbs ? [...(env.hive?.subkeys?.(verbs) ?? [])] : [];
                if (names.length === 0)
                {
                    return OLEOBJ_E_NOVERBS;
                }
                names.sort((left, right)=>left.toUpperCase().localeCompare(right.toUpperCase()));
                const items = names.map(name=>{
                    const [text = '', flags = '0', attributes = '0'] =
                        (stringOf(classesKey(`CLSID\\${clsid}\\Verb\\${name}`)) ?? '').split(',');
                    return { verb: Number.parseInt(name, 10) | 0, text,
                        flags: Number.parseInt(flags, 10) | 0,
                        attributes: Number.parseInt(attributes, 10) | 0 };
                });
                return publishEnumerator(env,
                    { clsid: CLSID_VERB_ENUMERATOR, iid: IID_IENUMOLEVERB, size: OLEVERB_SIZE },
                    {
                        items,
                        write: (at, item)=>{
                            const name = util.lendWide(item.text);
                            if (name === 0)
                            {
                                return false;
                            }
                            util.writeWords(at, [item.verb, name, item.flags, item.attributes]);
                            return true;
                        },
                    }, out >>> 0);
            },
        },

        /**
         * HRESULT OleGetAutoConvert(REFCLSID clsidOld, LPCLSID pClsidNew)
         *
         * AutoConvertTo under the old class's key: REGDB_E_KEYMISSING when it
         * has none, and CLSID_NULL written on any failure.
         */
        OleGetAutoConvert: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([old, out])=>{
                if ((out >>> 0) === 0 || (old >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const found = autoConvertOf(guidAt(old));
                writeGuid(out, found.guid);
                return found.hr;
            },
        },

        /**
         * HRESULT OleSetAutoConvert(REFCLSID clsidOld, REFCLSID clsidNew)
         *
         * The old class's AutoConvertTo value names the new one, which
         * OleGetAutoConvert and OleDoAutoConvert read; a class with no key
         * of its own is not registered.
         */
        OleSetAutoConvert: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([old, replacement])=>{
                if ((old >>> 0) === 0 || (replacement >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const key = classesKey(`CLSID\\${guidAt(old)}`);
                if (!key)
                {
                    return REGDB_E_CLASSNOTREG;
                }
                if (!env.hive?.create || !env.hive.setValue)
                {
                    return REGDB_E_WRITEREGDB;
                }
                const made = env.hive.create(key, 'AutoConvertTo').key;
                env.hive.setValue(made, '', REG_SZ, encodeAnsi(`${guidAt(replacement)}\0`));
                return S_OK;
            },
        },

        /**
         * HGLOBAL OleMetafilePictFromIconAndLabel(HICON hIcon, LPOLESTR lpszLabel,
         *     LPOLESTR lpszSourceFile, UINT iIconIndex)
         *
         * A METAFILEPICT in movable global memory, anisotropic, over a
         * metafile of the icon. NULL for no icon. The metafile is gdi32's,
         * and the extent is the icon's own size in HIMETRIC at 96 DPI: the
         * label is neither drawn nor measured here, which is said once.
         */
        OleMetafilePictFromIconAndLabel: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: async([icon])=>{
                if ((icon >>> 0) === 0)
                {
                    return 0;
                }
                const thread = env.callerThread();
                /** @param {string} library @param {string} name @param {number[]} args */
                const system = async(library, name, args)=>
                    (await util.system(library, name, args, thread)) ?? 0;
                const dc = await system('GDI32.dll', 'CreateMetaFileW', [0]);
                if (!dc)
                {
                    return 0;
                }
                await system('USER32.dll', 'DrawIcon', [dc, 0, 0, icon >>> 0]);
                const metafile = await system('GDI32.dll', 'CloseMetaFile', [dc]);
                const block = metafile
                    ? await system('KERNEL32.dll', 'GlobalAlloc', [GMEM_MOVEABLE, 16]) : 0;
                const at = block ? await system('KERNEL32.dll', 'GlobalLock', [block]) : 0;
                if (!at)
                {
                    if (metafile)
                    {
                        await system('GDI32.dll', 'DeleteMetaFile', [metafile]);
                    }
                    if (block)
                    {
                        await system('KERNEL32.dll', 'GlobalFree', [block]);
                    }
                    return 0;
                }
                const cx = (await system('USER32.dll', 'GetSystemMetrics', [SM_CXICON])) || 32;
                const cy = (await system('USER32.dll', 'GetSystemMetrics', [SM_CYICON])) || 32;
                writeU32(at, MM_ANISOTROPIC);
                writeU32(at + 4, Math.round(cx * HIMETRIC_PER_INCH / 96));
                writeU32(at + 8, Math.round(cy * HIMETRIC_PER_INCH / 96));
                writeU32(at + 12, metafile >>> 0);
                await system('KERNEL32.dll', 'GlobalUnlock', [block]);
                util.sayOnce('OleMetafilePictFromIconAndLabel',
                    'the label is not drawn, and the extent is the icon\'s alone');
                return block >>> 0;
            },
        },

        /**
         * HRESULT OleDoAutoConvert(LPSTORAGE pStg, LPCLSID pClsidNew)
         *
         * The storage's class converted to the one the registry names for it:
         * the class set, \1CompObj written again with the new class's user
         * type and the old format, and the convert flag set in \1Ole. The
         * out-parameter holds the old class until the conversion is made
         * (ole2.c test_OleDoAutoConvert).
         */
        OleDoAutoConvert: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: async([storage, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                if ((storage >>> 0) === 0)
                {
                    writeGuid(out, GUID_NULL);
                    return E_INVALIDARG;
                }
                const thread = env.callerThread();
                const stat = await util.storageClass(storage >>> 0, thread);
                if (stat.hr < 0)
                {
                    return stat.hr;
                }
                env.writeMemory(out >>> 0, stat.clsid);
                const target = autoConvertOf(formatGuid(stat.clsid));
                if (target.hr < 0)
                {
                    return target.hr;
                }
                const old = await readCompObj(storage >>> 0, thread);
                const set = await withScratch(GUID_SIZE, async block=>{
                    writeGuid(block, target.guid);
                    return (await env.callMethod(storage >>> 0, SLOT.STORAGE_SET_CLASS, [block],
                        thread)) | 0;
                }) ?? E_OUTOFMEMORY;
                if (set < 0)
                {
                    return set;
                }
                const written = await writeCompObj(storage >>> 0, old.record?.format ?? null,
                    userTypeOf(target.guid, USERCLASSTYPE_FULL), thread);
                if (written < 0)
                {
                    return written;
                }
                const converted = await setConvert(storage >>> 0, true, thread);
                if (converted < 0)
                {
                    return converted;
                }
                writeGuid(out, target.guid);
                return S_OK;
            },
        },

        /**
         * HRESULT WriteFmtUserTypeStg(LPSTORAGE pstg, CLIPFORMAT cf, LPOLESTR lpszUserType)
         *
         * \1CompObj, made anew each time (storage32.c test_fmtusertypestg):
         * the storage's class, the user type, the format -- a registered one
         * by its name -- and the class's ProgID.
         */
        WriteFmtUserTypeStg: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: async([storage, cf, userType])=>{
                if ((storage >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const thread = env.callerThread();
                const id = cf & 0xffff;
                const name = await util.formatName(id, thread);
                /** @type {CompObjFormat} */
                const format = id === 0 ? null : name !== null ? { name } : { id };
                return writeCompObj(storage >>> 0, format,
                    (userType >>> 0) === 0 ? null : util.readWide(userType >>> 0), thread);
            },
        },

        /**
         * HRESULT ReadFmtUserTypeStg(LPSTORAGE pstg, CLIPFORMAT *pcf, LPOLESTR *lplpszUserType)
         *
         * What WriteFmtUserTypeStg wrote: a registered format registered
         * again by its name, the user type in task memory, NULL for none.
         * A storage without \1CompObj answers what OpenStream answered.
         */
        ReadFmtUserTypeStg: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: async([storage, pcf, out])=>{
                if ((pcf >>> 0) !== 0)
                {
                    writeU16(pcf, 0);
                }
                if ((out >>> 0) !== 0)
                {
                    writeU32(out, 0);
                }
                if ((storage >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const thread = env.callerThread();
                const read = await readCompObj(storage >>> 0, thread);
                if (!read.record)
                {
                    return read.hr;
                }
                const { format, userType } = read.record;
                if ((pcf >>> 0) !== 0 && format !== null)
                {
                    writeU16(pcf, 'id' in format ? format.id
                        : await util.registerFormat(format.name, thread));
                }
                if ((out >>> 0) !== 0 && userType !== null)
                {
                    const block = util.lendWide(userType);
                    if (block === 0)
                    {
                        return E_OUTOFMEMORY;
                    }
                    writeU32(out, block);
                }
                return S_OK;
            },
        },

        /**
         * HRESULT SetConvertStg(LPSTORAGE pStg, BOOL fConvert)
         *
         * The convert flag in \1Ole, the stream made with its header when the
         * storage has none (storage32.c test_convert).
         */
        SetConvertStg: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([storage, convert])=>((storage >>> 0) === 0 ? E_INVALIDARG
                : setConvert(storage >>> 0, convert !== 0, env.callerThread())),
        },

        /**
         * HRESULT GetConvertStg(LPSTORAGE pStg)
         *
         * S_OK with the convert flag set, S_FALSE without it, and what
         * OpenStream answered for a storage with no \1Ole.
         */
        GetConvertStg: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: async([storage])=>{
                if ((storage >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const thread = env.callerThread();
                const opened = await util.openStream(storage >>> 0, OLE_STREAM,
                    STGM_SHARE_EXCLUSIVE | STGM_READ, false, thread);
                if (opened.hr < 0)
                {
                    return opened.hr;
                }
                const read = await util.readStream(opened.stream, thread);
                await release(opened.stream, thread);
                if (read.hr < 0 || read.bytes.length < 8)
                {
                    return read.hr < 0 ? read.hr : STG_E_READFAULT;
                }
                const flags = new DataView(read.bytes.buffer).getUint32(4, true);
                return (flags & OLESTREAM_CONVERT) !== 0 ? S_OK : S_FALSE;
            },
        },

        /**
         * BOOL IsAccelerator(HACCEL hAccel, int cAccelEntries, LPMSG lpMsg, WORD *lpwCmd)
         *
         * Whether the message is one of the table's accelerators, its command
         * written where asked; the table read through user32's
         * CopyAcceleratorTableW, the modifiers through GetKeyState.
         */
        IsAccelerator: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: async([accel, count, message, out])=>{
                const command = await acceleratorFor(accel >>> 0, count | 0, message >>> 0,
                    env.callerThread());
                if (command === null)
                {
                    return 0;
                }
                if ((out >>> 0) !== 0)
                {
                    writeU16(out, command);
                }
                return 1;
            },
        },

        /**
         * HRESULT OleTranslateAccelerator(LPOLEINPLACEFRAME lpFrame,
         *   LPOLEINPLACEFRAMEINFO lpFrameInfo, LPMSG lpmsg)
         *
         * An accelerator of the frame's table goes to the frame's own
         * TranslateAccelerator, whose answer this is; anything else is S_FALSE.
         */
        OleTranslateAccelerator: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: async([frame, info, message])=>{
                if ((info >>> 0) === 0 || (message >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const thread = env.callerThread();
                const command = await acceleratorFor(readU32((info >>> 0) + FRAMEINFO_ACCEL),
                    readU32((info >>> 0) + FRAMEINFO_ACCEL_COUNT), message >>> 0, thread);
                if (command === null || (frame >>> 0) === 0)
                {
                    return S_FALSE;
                }
                return (await env.callMethod(frame >>> 0, FRAME_TRANSLATE_ACCELERATOR,
                    [message, command], thread)) | 0;
            },
        },

        /**
         * HOLEMENU OleCreateMenuDescriptor(HMENU hmenuCombined,
         *   LPOLEMENUGROUPWIDTHS lpMenuWidths)
         *
         * A global block holding the composite menu and its six group widths,
         * which OleSetMenuDescriptor is handed; NULL for no menu.
         */
        OleCreateMenuDescriptor: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([menu, widths])=>{
                if ((menu >>> 0) === 0)
                {
                    return 0;
                }
                const bytes = new Uint8Array(4 + MENU_WIDTHS_SIZE);
                new DataView(bytes.buffer).setUint32(0, menu >>> 0, true);
                if ((widths >>> 0) !== 0)
                {
                    bytes.set(env.readMemory(widths >>> 0, MENU_WIDTHS_SIZE), 4);
                }
                return util.lend(bytes);
            },
        },

        /** HRESULT OleDestroyMenuDescriptor(HOLEMENU holemenu) */
        OleDestroyMenuDescriptor: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([descriptor])=>{
                if ((descriptor >>> 0) !== 0 && env.heap.block(descriptor >>> 0))
                {
                    env.heap.free(descriptor >>> 0);
                }
                return S_OK;
            },
        },

        /**
         * HRESULT DoDragDrop(LPDATAOBJECT pDataObj, LPDROPSOURCE pDropSource,
         *   DWORD dwOKEffects, LPDWORD pdwEffect)
         *
         * A drag runs while a person holds a mouse button down and moves it,
         * and no person drives one here: the drag ends as one cancelled
         * before it began, with no effect, the answer a source already
         * handles. The source is not called. Outside OleInitialize, and with
         * any argument missing, the answers are dragdrop.c test_DoDragDrop's.
         */
        DoDragDrop: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([data, source, , effect])=>{
                if (!env.oleInitialized(env.currentThread()))
                {
                    return CO_E_NOTINITIALIZED;
                }
                if ((data >>> 0) === 0 || (source >>> 0) === 0 || (effect >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(effect, 0);
                util.sayOnce('DoDragDrop', 'no drag is carried out; answered as cancelled');
                return DRAGDROP_S_CANCEL;
            },
        },

        /**
         * HRESULT OleQueryCreateFromData(LPDATAOBJECT pSrcDataObject)
         * HRESULT OleQueryLinkFromData(LPDATAOBJECT pSrcDataObject)
         *
         * What the data object's formats allow: an embedding ("Embedded
         * Object", "Embed Source", "FileName"), only a static picture, a link
         * ("Link Source"), or nothing.
         */
        OleQueryCreateFromData: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([data])=>((data >>> 0) === 0 ? E_INVALIDARG
                : creatableFrom(data >>> 0, env.callerThread())),
        },
        OleQueryLinkFromData: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([data])=>((data >>> 0) === 0 ? E_INVALIDARG
                : linkableFrom(data >>> 0, env.callerThread())),
        },

        /**
         * HRESULT OleCreateFromData(LPDATAOBJECT pSrcDataObj, REFIID riid,
         *   DWORD renderopt, LPFORMATETC pFormatEtc, LPOLECLIENTSITE pClientSite,
         *   LPSTORAGE pStg, LPVOID *ppvObj)
         *
         * Data with nothing to embed is refused for its formats (DV_E_FORMATETC),
         * a picture as only static (OLE_E_STATIC); an embedding names another
         * application's server, which is not run here.
         */
        OleCreateFromData: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: async([data, , , , , storage, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                if ((data >>> 0) === 0 || (storage >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const query = await creatableFrom(data >>> 0, env.callerThread());
                if (query === S_FALSE)
                {
                    return DV_E_FORMATETC;
                }
                if (query === OLE_S_STATIC)
                {
                    return OLE_E_STATIC;
                }
                util.sayOnce('OleCreateFromData', 'an embedded object\'s server is not run here');
                return REGDB_E_CLASSNOTREG;
            },
        },

        /**
         * HRESULT OleCreateLinkFromData(LPDATAOBJECT pSrcDataObj, REFIID riid,
         *   DWORD renderopt, LPFORMATETC pFormatEtc, LPOLECLIENTSITE pClientSite,
         *   LPSTORAGE pStg, LPVOID *ppvObj)
         *
         * Without "Link Source" there is no moniker to link through; with it,
         * the link's server is another application's.
         */
        OleCreateLinkFromData: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: async([data, , , , , storage, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                if ((data >>> 0) === 0 || (storage >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                if ((await linkableFrom(data >>> 0, env.callerThread())) !== S_OK)
                {
                    return OLE_E_CANT_GETMONIKER;
                }
                util.sayOnce('OleCreateLinkFromData', 'a linked object\'s server is not run here');
                return REGDB_E_CLASSNOTREG;
            },
        },

        /**
         * HRESULT OleCreateStaticFromData(LPDATAOBJECT pSrcDataObj, REFIID iid,
         *   DWORD renderopt, LPFORMATETC pFormatEtc, LPOLECLIENTSITE pClientSite,
         *   LPSTORAGE pStg, LPVOID *ppvObj)
         *
         * The arguments and the format checked as ole2.c
         * test_OleCreateStaticFromData checks them; the static picture
         * objects themselves (a DIB, a metafile) are OLE's data cache, which
         * this layer does not have.
         */
        OleCreateStaticFromData: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([data, , renderopt, formatEtc, , storage, out])=>{
                if ((out >>> 0) !== 0)
                {
                    writeU32(out, 0);
                }
                if ((out >>> 0) === 0 || (storage >>> 0) === 0 || (data >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                if ((renderopt >>> 0) === OLERENDER.FORMAT)
                {
                    if ((formatEtc >>> 0) === 0)
                    {
                        return E_INVALIDARG;
                    }
                    if (!STATIC_FORMATS.has(util.readU16(formatEtc >>> 0)))
                    {
                        return DV_E_CLIPFORMAT;
                    }
                }
                util.sayOnce('OleCreateStaticFromData', 'no static picture object is made here');
                return REGDB_E_CLASSNOTREG;
            },
        },

        /**
         * HGLOBAL OleDuplicateData(HANDLE hSrc, CLIPFORMAT cfFormat, UINT uiFlags)
         *
         * A copy of a clipboard handle in its format: the bytes of a global
         * block, a metafile picture with its metafile, an enhanced metafile.
         */
        OleDuplicateData: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, format])=>util.duplicate(handle >>> 0, format & 0xffff,
                env.callerThread()),
        },

        // HRESULT OleCreateFromFile(REFCLSID, LPCOLESTR, REFIID, DWORD, LPFORMATETC,
        //   LPOLECLIENTSITE, LPSTORAGE, LPVOID *)
        OleCreateFromFile: refuseWithOut('OleCreateFromFile', 32, 7, REGDB_E_CLASSNOTREG,
            'an object embedded from a file needs its class\'s server or the packager'),
        // HRESULT OleCreateLinkToFile(LPCOLESTR, REFIID, DWORD, LPFORMATETC,
        //   LPOLECLIENTSITE, LPSTORAGE, LPVOID *)
        OleCreateLinkToFile: refuseWithOut('OleCreateLinkToFile', 28, 6, REGDB_E_CLASSNOTREG,
            'a linked object needs its source\'s server'),
        // HRESULT OleCreateLink(LPMONIKER, REFIID, DWORD, LPFORMATETC, LPOLECLIENTSITE,
        //   LPSTORAGE, LPVOID *)
        OleCreateLink: refuseWithOut('OleCreateLink', 28, 6, REGDB_E_CLASSNOTREG,
            'a linked object needs its source\'s server'),
        // HRESULT CreateDataCache(LPUNKNOWN, REFCLSID, REFIID, LPVOID *): OLE's
        // presentation cache, which this layer does not have.
        CreateDataCache: refuseWithOut('CreateDataCache', 16, 3, E_OUTOFMEMORY,
            'OLE\'s data cache is not here'),
        // HGLOBAL OleGetIconOfClass(REFCLSID, LPOLESTR, BOOL): NULL on failure.
        OleGetIconOfClass: refuse('OleGetIconOfClass', { argBytes: 12,
            why: 'no metafile of a class\'s icon is drawn here' }),
        // HRESULT OleConvertIStorageToOLESTREAM(LPSTORAGE, LPOLESTREAM)
        OleConvertIStorageToOLESTREAM: refuse('OleConvertIStorageToOLESTREAM', { argBytes: 8,
            answer: CONVERT10_E_STG_NO_STD_STREAM,
            why: 'no OLE 1 stream is written from a storage' }),
        // HRESULT OleConvertOLESTREAMToIStorage(LPOLESTREAM, LPSTORAGE, const DVTARGETDEVICE *)
        OleConvertOLESTREAMToIStorage: refuse('OleConvertOLESTREAMToIStorage', { argBytes: 12,
            answer: CONVERT10_E_OLESTREAM_FMT, why: 'no OLE 1 stream is read into a storage' }),
    };
    return table;
}
