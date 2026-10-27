/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The OLE clipboard over user32's: a data object a program puts there with
 * OleSetClipboard, and the data object OleGetClipboard hands any reader.
 *
 * Windows puts the source's formats on the clipboard for rendering later,
 * each rendered when someone pastes it, through a hidden window that takes
 * WM_RENDERFORMAT. Nothing here sends that message, so the formats that are
 * global memory are rendered at once, as OleFlushClipboard would render
 * them: a program reading the clipboard through user32 sees them, and the
 * source is still asked for everything else through OleGetClipboard's
 * object while it is on the clipboard. That object is one per clipboard
 * state (clipboard.c test_consumer_refs): asked again before the clipboard
 * changes, it is the same object; it reaches the source only while the
 * source is the clipboard's, holding a reference from its first such call.
 */

import { publishEnumerator } from './enumerator.js';
import {
    DATADIR_GET, DVASPECT_CONTENT, FORMATETC_SIZE, SLOT, STGMEDIUM_SIZE, TYMED, createOleUtil,
} from './oleutil.js';

const S_OK = 0;
const S_FALSE = 1;
const E_NOTIMPL = 0x80004001 | 0;
const E_FAIL = 0x80004005 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const E_INVALIDARG = 0x80070057 | 0;
const CO_E_NOTINITIALIZED = 0x800401f0 | 0;
const CLIPBRD_E_CANT_OPEN = 0x800401d0 | 0;
const CLIPBRD_E_CANT_EMPTY = 0x800401d1 | 0;
const CLIPBRD_E_CANT_CLOSE = 0x800401d4 | 0;
const DV_E_FORMATETC = 0x80040064 | 0;
const DV_E_TYMED = 0x80040069 | 0;
const DV_E_CLIPFORMAT = 0x8004006a | 0;
const OLE_E_ADVISENOTSUPPORTED = 0x80040003 | 0;
const DATA_S_SAMEFORMATETC = 0x00040130;
const STG_E_MEDIUMFULL = 0x80030070 | 0;

const IID_IDATAOBJECT = '{0000010E-0000-0000-C000-000000000046}';
const IID_IENUMFORMATETC = '{00000103-0000-0000-C000-000000000046}';
/** This layer's classes of the clipboard's data object and its format enumerator. */
const CLSID_CLIPBOARD_DATA = '{7b5b0b8e-1f8c-4b36-9d1c-2a6d4e4b0035}';
const CLSID_FORMAT_ENUMERATOR = '{7b5b0b8e-1f8c-4b36-9d1c-2a6d4e4b0034}';

/** How many formats user32's clipboard is read for, at most. */
const MAX_FORMATS = 256;
/**
 * The two formats OLE adds to user32's clipboard beside the rendered ones:
 * the window of the clipboard's owner, and the source's format list, which
 * clipboard.c test_cf_dataobject lays out -- a header of six DWORDs (0, the
 * block's size, 1, the count, 0, 0), then per format its FORMATETC, whether
 * it is the first with its clipboard format, and two zeros.
 */
const CF_NAME_DATA_OBJECT = 'DataObject';
const CF_NAME_PRIVATE_DATA = 'Ole Private Data';
const PRIVATE_HEADER = 24;
const PRIVATE_ENTRY = 32;

/** @typedef {import('./oleutil.js').FormatEtc} FormatEtc */

/** @param {import('./oleutil.js').OleEnv} env */
export function createClipboardFunctions(env){
    const util = createOleUtil(env);
    const { readU32, writeU32, release } = util;

    /** @param {string} name @param {number[]} args @param {unknown} thread */
    const user32 = (name, args, thread)=>util.system('USER32.dll', name, args, thread);

    /**
     * The clipboard as OLE keeps it: the source on it, the formats it
     * offered, the thread that put it there, and which state it is in.
     */
    const board = {
        source: 0,
        /** @type {FormatEtc[]} */
        formats: [],
        /** @type {any} */
        owner: null,
        version: 0,
        /** @type {{ object: import('./objects.js').ComObject, version: number } | null} */
        reader: null,
    };

    /**
     * The formats on user32's clipboard, each in the medium it comes in.
     *
     * @param {unknown} thread
     * @returns {Promise<FormatEtc[]>}
     */
    const clipboardFormats = async thread=>{
        if (((await user32('OpenClipboard', [0], thread)) ?? 0) === 0)
        {
            return [];
        }
        // OLE's own formats describe the others, and are not offered.
        const own = [await util.registerFormat(CF_NAME_DATA_OBJECT, thread),
            await util.registerFormat(CF_NAME_PRIVATE_DATA, thread)];
        /** @type {FormatEtc[]} */
        const formats = [];
        let format = 0;
        while (formats.length < MAX_FORMATS)
        {
            format = ((await user32('EnumClipboardFormats', [format], thread)) ?? 0) >>> 0;
            if (format === 0)
            {
                break;
            }
            if (own.includes(format))
            {
                continue;
            }
            formats.push({ format, aspect: DVASPECT_CONTENT, lindex: -1,
                tymed: util.tymedOf(format) });
        }
        await user32('CloseClipboard', [], thread);
        return formats;
    };

    /**
     * Renders the source's global-memory formats onto the open clipboard,
     * each a block of its own the clipboard then owns.
     *
     * @param {number} data @param {FormatEtc[]} formats @param {unknown} thread
     */
    const render = async(data, formats, thread)=>{
        for (const format of formats)
        {
            if (util.tymedOf(format.format) !== TYMED.HGLOBAL
                || (format.tymed & TYMED.HGLOBAL) === 0 || format.aspect !== DVASPECT_CONTENT)
            {
                continue;
            }
            await util.withScratch(FORMATETC_SIZE + STGMEDIUM_SIZE, async block=>{
                const medium = block + FORMATETC_SIZE;
                util.writeFormat(block, { format: format.format, aspect: DVASPECT_CONTENT,
                    lindex: -1, tymed: TYMED.HGLOBAL });
                const hr = (await env.callMethod(data, SLOT.DATA_GET, [block, medium], thread)) | 0;
                if (hr < 0)
                {
                    return;
                }
                let handle = 0;
                if (readU32(medium) === TYMED.HGLOBAL)
                {
                    // A medium someone else releases is theirs: the clipboard
                    // takes a copy.
                    handle = readU32(medium + 8) === 0 ? readU32(medium + 4)
                        : util.copyGlobal(readU32(medium + 4));
                }
                if (readU32(medium + 8) !== 0 || handle === 0)
                {
                    await env.releaseMedium(medium);
                }
                if (handle !== 0
                    && ((await user32('SetClipboardData', [format.format, handle], thread)) ?? 0)
                        === 0)
                {
                    env.heap.free(handle);
                }
            });
        }
    };

    /**
     * Puts OLE's own formats on the open clipboard: the owner's window --
     * none, the clipboard being opened without one -- and the list of the
     * source's formats.
     *
     * @param {FormatEtc[]} formats @param {unknown} thread
     */
    const publishOwn = async(formats, thread)=>{
        const owner = await util.registerFormat(CF_NAME_DATA_OBJECT, thread);
        const listed = await util.registerFormat(CF_NAME_PRIVATE_DATA, thread);
        const size = PRIVATE_HEADER + formats.length * PRIVATE_ENTRY;
        /** @type {[number, Uint8Array][]} */
        const blocks = [[owner, new Uint8Array(4)], [listed, new Uint8Array(size)]];
        const words = new DataView(blocks[1][1].buffer);
        [0, size, 1, formats.length, 0, 0].forEach((value, index)=>
            words.setUint32(index * 4, value, true));
        formats.forEach((format, index)=>{
            const at = PRIVATE_HEADER + index * PRIVATE_ENTRY;
            words.setUint32(at, format.format & 0xffff, true);
            words.setUint32(at + 8, format.aspect, true);
            words.setInt32(at + 12, format.lindex, true);
            words.setUint32(at + 16, format.tymed, true);
            const first = formats.findIndex(other=>other.format === format.format) === index;
            words.setUint32(at + 20, first ? 1 : 0, true);
        });
        for (const [format, bytes] of blocks)
        {
            const handle = format === 0 ? 0 : util.lend(bytes);
            if (handle !== 0
                && ((await user32('SetClipboardData', [format, handle], thread)) ?? 0) === 0)
            {
                env.heap.free(handle);
            }
        }
    };

    /**
     * Lets go of the source, as a flush or a new clipboard does; the reader
     * of the old state keeps what it took.
     *
     * @param {unknown} thread
     */
    const drop = async thread=>{
        const previous = board.source;
        board.source = 0;
        board.formats = [];
        board.owner = null;
        board.version++;
        if (previous !== 0)
        {
            await release(previous, thread);
        }
    };

    /**
     * The clipboard's data object for the state it is in now.
     *
     * @param {FormatEtc[]} formats @param {number} source
     */
    const makeReader = (formats, source)=>{
        const state = { source, held: 0 };
        /** The source while it is the clipboard's, held from the first call that needs it. */
        const delegate = async(/** @type {unknown} */ thread)=>{
            if (state.held !== 0)
            {
                return state.held;
            }
            if (state.source !== 0 && state.source === board.source)
            {
                await env.callMethod(state.source, SLOT.ADD_REF, [], thread);
                state.held = state.source;
                return state.held;
            }
            state.source = 0;
            return 0;
        };
        /**
         * A format checked as QueryGetData checks it, against what this state
         * offers: the answer, and the format found. The medium is not
         * looked at (clipboard.c test_get_clipboard: TYMED_FILE of a global
         * format is S_OK); GetData looks at it.
         *
         * @param {number} at
         * @returns {{ hr: number, wanted: FormatEtc, offered?: FormatEtc }}
         */
        const check = at=>{
            const wanted = util.readFormat(at);
            const offered = formats.find(format=>format.format === wanted.format);
            if (wanted.lindex !== -1 || wanted.aspect !== DVASPECT_CONTENT)
            {
                return { hr: DV_E_FORMATETC, wanted };
            }
            if (wanted.format === 0 || !offered)
            {
                return { hr: DV_E_CLIPFORMAT, wanted };
            }
            return { hr: S_OK, wanted, offered };
        };
        /**
         * GetData's and GetDataHere's check: QueryGetData's, a format not
         * offered being DV_E_FORMATETC, then the medium.
         *
         * @param {number} at
         */
        const checkMedium = at=>{
            const { hr, wanted, offered } = check(at);
            if (hr < 0 || !offered)
            {
                return { hr: hr === DV_E_CLIPFORMAT ? DV_E_FORMATETC : hr, wanted };
            }
            return { hr: (offered.tymed & wanted.tymed) === 0 ? DV_E_TYMED : S_OK, wanted };
        };
        /**
         * The clipboard's own handle of a format, read through user32.
         *
         * @param {number} format @param {unknown} thread
         * @returns {Promise<number>} the handle, or a failure below zero
         */
        const clipboardHandle = async(format, thread)=>{
            const opened = await user32('OpenClipboard', [0], thread);
            if (opened === null)
            {
                return DV_E_FORMATETC;
            }
            if (opened === 0)
            {
                return CLIPBRD_E_CANT_OPEN;
            }
            const handle = ((await user32('GetClipboardData', [format], thread)) ?? 0) >>> 0;
            await user32('CloseClipboard', [], thread);
            return handle === 0 ? DV_E_FORMATETC : handle;
        };
        return env.makeObject(CLSID_CLIPBOARD_DATA, {
            interfaces: [{
                id: IID_IDATAOBJECT,
                methods: [
                    {
                        name: 'GetData', argBytes: 12,
                        invoke: async(_self, [format, medium])=>{
                            if ((format >>> 0) === 0 || (medium >>> 0) === 0)
                            {
                                return E_INVALIDARG;
                            }
                            util.writeWords(medium, [0, 0, 0]);
                            const thread = env.callerThread();
                            const source_ = await delegate(thread);
                            if (source_ !== 0)
                            {
                                // The source is asked whatever the format; what
                                // it refuses is answered as the formats it
                                // offered say (clipboard.c test_get_clipboard:
                                // CF_RIFF, TYMED_FILE), and otherwise as it did.
                                const hr = (await env.callMethod(source_, SLOT.DATA_GET,
                                    [format, medium], thread)) | 0;
                                const offered = hr < 0 ? checkMedium(format >>> 0).hr : S_OK;
                                return offered < 0 ? offered : hr;
                            }
                            const { hr, wanted } = checkMedium(format >>> 0);
                            if (hr < 0)
                            {
                                return hr;
                            }
                            const handle = await clipboardHandle(wanted.format, thread);
                            if (handle < 0)
                            {
                                return handle;
                            }
                            const copy = await util.duplicate(handle, wanted.format, thread);
                            if (copy === 0)
                            {
                                const tymed = util.tymedOf(wanted.format);
                                return tymed === TYMED.HGLOBAL ? E_OUTOFMEMORY : DV_E_FORMATETC;
                            }
                            util.writeWords(medium, [util.tymedOf(wanted.format), copy, 0]);
                            return S_OK;
                        },
                    },
                    {
                        name: 'GetDataHere', argBytes: 12,
                        invoke: async(_self, [format, medium])=>{
                            if ((format >>> 0) === 0 || (medium >>> 0) === 0)
                            {
                                return E_INVALIDARG;
                            }
                            const thread = env.callerThread();
                            const source_ = await delegate(thread);
                            if (source_ !== 0)
                            {
                                return (await env.callMethod(source_, SLOT.DATA_GET_HERE,
                                    [format, medium], thread)) | 0;
                            }
                            const { hr, wanted } = checkMedium(format >>> 0);
                            if (hr < 0)
                            {
                                return hr;
                            }
                            const target = readU32(medium + 4);
                            if (readU32(medium) !== TYMED.HGLOBAL
                                || util.tymedOf(wanted.format) !== TYMED.HGLOBAL)
                            {
                                return DV_E_TYMED;
                            }
                            const handle = await clipboardHandle(wanted.format, thread);
                            if (handle < 0)
                            {
                                return handle;
                            }
                            const from = env.heap.block(handle)?.size ?? 0;
                            const room = env.heap.block(target)?.size ?? 0;
                            if (from > room)
                            {
                                return STG_E_MEDIUMFULL;
                            }
                            env.writeMemory(target, env.readMemory(handle, from).slice());
                            return S_OK;
                        },
                    },
                    {
                        name: 'QueryGetData', argBytes: 8,
                        invoke: (_self, [format])=>((format >>> 0) === 0 ? E_INVALIDARG
                            : check(format >>> 0).hr),
                    },
                    {
                        name: 'GetCanonicalFormatEtc', argBytes: 12,
                        invoke: (_self, [format, out])=>{
                            if ((format >>> 0) === 0 || (out >>> 0) === 0)
                            {
                                return E_INVALIDARG;
                            }
                            const copy = env.readMemory(format >>> 0, FORMATETC_SIZE).slice();
                            copy.fill(0, 4, 8);
                            env.writeMemory(out >>> 0, copy);
                            return DATA_S_SAMEFORMATETC;
                        },
                    },
                    { name: 'SetData', argBytes: 16, invoke: ()=>E_NOTIMPL },
                    {
                        name: 'EnumFormatEtc', argBytes: 12,
                        invoke: (_self, [direction, out])=>{
                            if ((out >>> 0) === 0)
                            {
                                return E_INVALIDARG;
                            }
                            writeU32(out, 0);
                            if ((direction >>> 0) !== DATADIR_GET)
                            {
                                return E_NOTIMPL;
                            }
                            return publishEnumerator(env, { clsid: CLSID_FORMAT_ENUMERATOR,
                                iid: IID_IENUMFORMATETC, size: FORMATETC_SIZE }, {
                                items: formats,
                                write: (at, item)=>{
                                    util.writeFormat(at, item);
                                    return true;
                                },
                            }, out >>> 0);
                        },
                    },
                    { name: 'DAdvise', argBytes: 20, invoke: ()=>OLE_E_ADVISENOTSUPPORTED },
                    { name: 'DUnadvise', argBytes: 8, invoke: ()=>OLE_E_ADVISENOTSUPPORTED },
                    { name: 'EnumDAdvise', argBytes: 8, invoke: ()=>OLE_E_ADVISENOTSUPPORTED },
                ],
            }],
            // The source is let go of inside the last Release, waited for.
            lastRelease: async()=>{
                const held = state.held;
                state.held = 0;
                if (held !== 0)
                {
                    await release(held, env.callerThread());
                }
            },
            destroy: ()=>{
                if (state.held !== 0)
                {
                    void release(state.held, env.callerThread());
                }
            },
        });
    };

    const table = {
        /**
         * HRESULT OleSetClipboard(LPDATAOBJECT pDataObj)
         *
         * Only inside OleInitialize (clipboard.c test_set_clipboard). The
         * clipboard is emptied and the source, held with a reference, put on
         * it with its global-memory formats rendered; NULL leaves it empty.
         */
        OleSetClipboard: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: async([data])=>{
                if (!env.oleInitialized(env.currentThread()))
                {
                    return CO_E_NOTINITIALIZED;
                }
                const thread = env.callerThread();
                const opened = await user32('OpenClipboard', [0], thread);
                if (opened === 0)
                {
                    return CLIPBRD_E_CANT_OPEN;
                }
                if (opened === null)
                {
                    util.sayOnce('OleSetClipboard', 'no user32 clipboard: the data object is'
                        + ' this process\'s alone');
                }
                else if (((await user32('EmptyClipboard', [], thread)) ?? 0) === 0)
                {
                    await user32('CloseClipboard', [], thread);
                    return CLIPBRD_E_CANT_EMPTY;
                }
                await drop(thread);
                if ((data >>> 0) !== 0)
                {
                    await env.callMethod(data >>> 0, SLOT.ADD_REF, [], thread);
                    board.source = data >>> 0;
                    board.owner = thread;
                    board.formats = await util.formatsOf(data >>> 0, thread);
                    if (opened !== null)
                    {
                        await render(data >>> 0, board.formats, thread);
                        await publishOwn(board.formats, thread);
                    }
                }
                if (opened !== null && ((await user32('CloseClipboard', [], thread)) ?? 0) === 0)
                {
                    return CLIPBRD_E_CANT_CLOSE;
                }
                return S_OK;
            },
        },

        /**
         * HRESULT OleGetClipboard(LPDATAOBJECT *ppDataObj)
         *
         * The clipboard's data object, whether COM is initialised or not
         * (test_get_clipboard_uninitialized); the same one until the
         * clipboard changes.
         */
        OleGetClipboard: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: async([out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                let object = board.reader?.version === board.version
                    && !board.reader.object.destroyed ? board.reader.object : null;
                if (object)
                {
                    object.addRef();
                }
                else
                {
                    const formats = board.source !== 0 ? [...board.formats]
                        : await clipboardFormats(env.callerThread());
                    object = makeReader(formats, board.source);
                    if (!object)
                    {
                        return E_OUTOFMEMORY;
                    }
                    board.reader = { object, version: board.version };
                }
                const pointer = env.publish(object, IID_IDATAOBJECT) >>> 0;
                if (pointer === 0)
                {
                    object.release();
                    return E_OUTOFMEMORY;
                }
                writeU32(out, pointer);
                return S_OK;
            },
        },

        /**
         * HRESULT OleFlushClipboard(void)
         *
         * The source's formats stay on the clipboard as they were rendered
         * and the source is let go of; a thread outside any apartment is
         * refused (test_get_clipboard_uninitialized).
         */
        OleFlushClipboard: {
            argBytes: 0,
            handler: async()=>{
                if (!env.currentThread()?.ole32)
                {
                    return E_FAIL;
                }
                if (board.source !== 0)
                {
                    await drop(env.callerThread());
                }
                return S_OK;
            },
        },

        /** HRESULT OleIsCurrentClipboard(LPDATAOBJECT pDataObject) */
        OleIsCurrentClipboard: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([data])=>((data >>> 0) !== 0 && (data >>> 0) === board.source
                ? S_OK : S_FALSE),
        },
    };

    return {
        table,
        /**
         * The last OleUninitialize of the thread that put the source on the
         * clipboard: the source goes, its rendered formats stay.
         *
         * @param {any} thread
         * @returns {Promise<unknown> | null}
         */
        uninitialize: thread=>(board.source !== 0 && board.owner === thread
            ? drop(env.callerThread()) : null),
    };
}
