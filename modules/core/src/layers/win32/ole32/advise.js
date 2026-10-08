/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The advise holders OLE gives an object to keep its sinks in:
 * CreateDataAdviseHolder's, which tells each sink a data object changed and
 * hands it the data in the format it asked for, and CreateOleAdviseHolder's,
 * which tells them the object was renamed, saved or closed.
 *
 * Each holds a reference on every sink until it is unadvised or the holder
 * goes, numbers connections from one, and sends to a snapshot of its sinks,
 * so a sink that unadvises itself while being told is told once and gone.
 */

import { publishEnumerator } from './enumerator.js';
import { FORMATETC_SIZE, STGMEDIUM_SIZE, SLOT, createOleUtil } from './oleutil.js';

const S_OK = 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const E_INVALIDARG = 0x80070057 | 0;
const OLE_E_NOCONNECTION = 0x80040004 | 0;

const IID_IDATAADVISEHOLDER = '{00000110-0000-0000-C000-000000000046}';
const IID_IOLEADVISEHOLDER = '{00000111-0000-0000-C000-000000000046}';
const IID_IENUMSTATDATA = '{00000105-0000-0000-C000-000000000046}';
/** This layer's classes of the two holders and their enumerator. */
const CLSID_DATA_ADVISE_HOLDER = '{7b5b0b8e-1f8c-4b36-9d1c-2a6d4e4b0030}';
const CLSID_OLE_ADVISE_HOLDER = '{7b5b0b8e-1f8c-4b36-9d1c-2a6d4e4b0031}';
const CLSID_STATDATA_ENUMERATOR = '{7b5b0b8e-1f8c-4b36-9d1c-2a6d4e4b0032}';

/** IAdviseSink's methods after IUnknown's. */
const SINK = Object.freeze({ ON_DATA_CHANGE: 3, ON_RENAME: 5, ON_SAVE: 6, ON_CLOSE: 7 });

/** ADVF_*: no data with the notice, only one notice, one at once. */
const ADVF_NODATA = 1;
const ADVF_PRIMEFIRST = 2;
const ADVF_ONLYONCE = 4;

/** STATDATA: the FORMATETC, advf, the sink, the connection. */
const STATDATA_SIZE = FORMATETC_SIZE + 12;

/**
 * @typedef {Object} Connection
 * @property {number} id
 * @property {number} sink
 * @property {number} advf
 * @property {Uint8Array} format  The FORMATETC, without a target device.
 */

/** @param {import('./oleutil.js').OleEnv} env */
export function createAdviseFunctions(env){
    const util = createOleUtil(env);
    const { writeU32, release } = util;

    /**
     * IEnumSTATDATA over a holder's connections as they are now. The
     * snapshot holds a reference on each sink, and each one it hands out
     * carries one more, which the caller releases.
     *
     * @param {Connection[]} connections @param {number} out
     */
    const enumerate = async(connections, out)=>{
        const thread = env.callerThread();
        const items = [...connections];
        for (const item of items)
        {
            await env.callMethod(item.sink, SLOT.ADD_REF, [], thread);
        }
        return publishEnumerator(env,
            { clsid: CLSID_STATDATA_ENUMERATOR, iid: IID_IENUMSTATDATA, size: STATDATA_SIZE },
            {
                items,
                write: async(at, item, caller)=>{
                    env.writeMemory(at, item.format);
                    util.writeWords(at + FORMATETC_SIZE, [item.advf, item.sink, item.id]);
                    await env.callMethod(item.sink, SLOT.ADD_REF, [], caller);
                    return true;
                },
                release: ()=>{
                    const caller = env.callerThread();
                    for (const item of items)
                    {
                        void release(item.sink, caller);
                    }
                },
            }, out);
    };

    /**
     * A holder's book of sinks: Advise, Unadvise and EnumAdvise, the same
     * for both kinds.
     *
     * @param {Connection[]} connections
     */
    const book = connections=>{
        let next = 1;
        return {
            /** @param {number} sink @param {number} advf @param {Uint8Array} format */
            add: async(sink, advf, format)=>{
                await env.callMethod(sink, SLOT.ADD_REF, [], env.callerThread());
                const connection = { id: next++, sink, advf, format };
                connections.push(connection);
                return connection;
            },
            /** @param {number} id */
            remove: async id=>{
                const at = connections.findIndex(connection=>connection.id === (id >>> 0));
                if (at < 0)
                {
                    return OLE_E_NOCONNECTION;
                }
                const [gone] = connections.splice(at, 1);
                await release(gone.sink, env.callerThread());
                return S_OK;
            },
            /** Every sink let go of, as the holder goes. */
            clear: ()=>{
                const caller = env.callerThread();
                for (const connection of connections.splice(0))
                {
                    void release(connection.sink, caller);
                }
            },
        };
    };

    /**
     * Tells one sink the data changed: the data in its format unless it
     * asked for none, then the medium released.
     *
     * @param {number} data @param {Connection} connection @param {unknown} thread
     */
    const tell = async(data, connection, thread)=>{
        await util.withScratch(FORMATETC_SIZE + STGMEDIUM_SIZE, async block=>{
            env.writeMemory(block, connection.format);
            const medium = block + FORMATETC_SIZE;
            let hr = -1;
            if ((connection.advf & ADVF_NODATA) === 0 && data !== 0)
            {
                hr = (await env.callMethod(data, SLOT.DATA_GET, [block, medium], thread)) | 0;
            }
            await env.callMethod(connection.sink, SINK.ON_DATA_CHANGE, [block, medium], thread);
            if (hr === S_OK)
            {
                await env.releaseMedium(medium);
            }
        });
    };

    /** @param {string} clsid @param {string} iid @param {import('./objects.js').ComClassDefinition} definition @param {number} out */
    const publish = (clsid, iid, definition, out)=>{
        const object = env.makeObject(clsid, definition);
        if (!object)
        {
            return E_OUTOFMEMORY;
        }
        const pointer = env.publish(object, iid) >>> 0;
        if (pointer === 0)
        {
            object.release();
            return E_OUTOFMEMORY;
        }
        writeU32(out, pointer);
        return S_OK;
    };

    return {
        /**
         * HRESULT CreateDataAdviseHolder(LPDATAADVISEHOLDER *ppDAHolder)
         *
         * IDataAdviseHolder: Advise (with ADVF_PRIMEFIRST the sink is told
         * at once), Unadvise, EnumAdvise and SendOnDataChange, which honours
         * each sink's ADVF_NODATA and ADVF_ONLYONCE.
         */
        CreateDataAdviseHolder: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                /** @type {Connection[]} */
                const connections = [];
                const sinks = book(connections);
                /** @param {number} data @param {number} advf @param {unknown} thread */
                const send = async(data, advf, thread)=>{
                    for (const connection of [...connections])
                    {
                        if (!connections.includes(connection))
                        {
                            continue;
                        }
                        await tell(data, connection, thread);
                        if (((connection.advf | advf) & ADVF_ONLYONCE) !== 0)
                        {
                            await sinks.remove(connection.id);
                        }
                    }
                    return S_OK;
                };
                return publish(CLSID_DATA_ADVISE_HOLDER, IID_IDATAADVISEHOLDER, {
                    interfaces: [{
                        id: IID_IDATAADVISEHOLDER,
                        methods: [
                            {
                                name: 'Advise', argBytes: 24,
                                invoke: async(_self, [data, format, advf, sink, out_])=>{
                                    if ((out_ >>> 0) !== 0)
                                    {
                                        writeU32(out_, 0);
                                    }
                                    if ((sink >>> 0) === 0 || (format >>> 0) === 0)
                                    {
                                        return E_INVALIDARG;
                                    }
                                    const copy = env.readMemory(format >>> 0, FORMATETC_SIZE)
                                        .slice();
                                    // The target device is the caller's; the copy keeps none.
                                    copy.fill(0, 4, 8);
                                    const connection = await sinks.add(sink >>> 0, advf >>> 0,
                                        copy);
                                    if ((out_ >>> 0) !== 0)
                                    {
                                        writeU32(out_, connection.id);
                                    }
                                    if ((advf & ADVF_PRIMEFIRST) !== 0 && (data >>> 0) !== 0)
                                    {
                                        const thread = env.callerThread();
                                        await tell(data >>> 0, connection, thread);
                                        if ((advf & ADVF_ONLYONCE) !== 0)
                                        {
                                            await sinks.remove(connection.id);
                                        }
                                    }
                                    return S_OK;
                                },
                            },
                            { name: 'Unadvise', argBytes: 8,
                                invoke: (_self, [id])=>sinks.remove(id) },
                            {
                                name: 'EnumAdvise', argBytes: 8,
                                invoke: (_self, [out_])=>{
                                    if ((out_ >>> 0) === 0)
                                    {
                                        return E_INVALIDARG;
                                    }
                                    writeU32(out_, 0);
                                    return enumerate(connections, out_ >>> 0);
                                },
                            },
                            {
                                name: 'SendOnDataChange', argBytes: 16,
                                invoke: (_self, [data, , advf])=>
                                    send(data >>> 0, advf >>> 0, env.callerThread()),
                            },
                        ],
                    }],
                    destroy: ()=>sinks.clear(),
                }, out >>> 0);
            },
        },

        /**
         * HRESULT CreateOleAdviseHolder(LPOLEADVISEHOLDER *ppOAHolder)
         *
         * IOleAdviseHolder: Advise, Unadvise, EnumAdvise, and the three
         * notices sent to every sink -- renamed, saved, closed.
         */
        CreateOleAdviseHolder: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                /** @type {Connection[]} */
                const connections = [];
                const sinks = book(connections);
                /** @param {number} slot @param {number[]} args */
                const notify = async(slot, args)=>{
                    const thread = env.callerThread();
                    for (const connection of [...connections])
                    {
                        await env.callMethod(connection.sink, slot, args, thread);
                    }
                    return S_OK;
                };
                // What EnumAdvise reports of a sink here: no format, as
                // Windows reports it -- the notices are not by format.
                const noFormat = new Uint8Array(FORMATETC_SIZE);
                new DataView(noFormat.buffer).setInt32(12, -1, true);
                return publish(CLSID_OLE_ADVISE_HOLDER, IID_IOLEADVISEHOLDER, {
                    interfaces: [{
                        id: IID_IOLEADVISEHOLDER,
                        methods: [
                            {
                                name: 'Advise', argBytes: 12,
                                invoke: async(_self, [sink, out_])=>{
                                    if ((out_ >>> 0) === 0 || (sink >>> 0) === 0)
                                    {
                                        if ((out_ >>> 0) !== 0)
                                        {
                                            writeU32(out_, 0);
                                        }
                                        return E_INVALIDARG;
                                    }
                                    const connection = await sinks.add(sink >>> 0, 0, noFormat);
                                    writeU32(out_, connection.id);
                                    return S_OK;
                                },
                            },
                            { name: 'Unadvise', argBytes: 8,
                                invoke: (_self, [id])=>sinks.remove(id) },
                            {
                                name: 'EnumAdvise', argBytes: 8,
                                invoke: (_self, [out_])=>{
                                    if ((out_ >>> 0) === 0)
                                    {
                                        return E_INVALIDARG;
                                    }
                                    writeU32(out_, 0);
                                    return enumerate(connections, out_ >>> 0);
                                },
                            },
                            { name: 'SendOnRename', argBytes: 8,
                                invoke: (_self, [moniker])=>notify(SINK.ON_RENAME, [moniker]) },
                            { name: 'SendOnSave', argBytes: 4,
                                invoke: ()=>notify(SINK.ON_SAVE, []) },
                            { name: 'SendOnClose', argBytes: 4,
                                invoke: ()=>notify(SINK.ON_CLOSE, []) },
                        ],
                    }],
                    destroy: ()=>sinks.clear(),
                }, out >>> 0);
            },
        },
    };
}
