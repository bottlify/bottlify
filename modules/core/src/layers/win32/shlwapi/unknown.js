/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * shlwapi's helpers over a program's own COM objects, exported by number
 * alone: each is a few method calls through the object's vtable, made as
 * guest calls on the thread that asked.
 */

const S_OK = 0;
const E_FAIL = 0x80004005 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;

/** The vtable slots these call: IUnknown's three, then IServiceProvider's one. */
const SLOT_QUERY_INTERFACE = 0;
const SLOT_RELEASE = 2;
const SLOT_QUERY_SERVICE = 3;

/** IID_IServiceProvider, {6d5140c1-7436-11ce-8034-00aa006009fa}, as the structure holds it. */
const IID_ISERVICEPROVIDER = Uint8Array.from([
    0xc1, 0x40, 0x51, 0x6d, 0x36, 0x74, 0xce, 0x11,
    0x80, 0x34, 0x00, 0xaa, 0x00, 0x60, 0x09, 0xfa,
]);

/** The ordinals these are exported by (Wine's shlwapi.spec). */
export const UNKNOWN_ORDINALS = Object.freeze({ 176: 'IUnknown_QueryService' });

/**
 * @typedef {Object} UnknownHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => void} free
 * @property {(entry: number, args: number[], thread: unknown) => Promise<number> | number} call
 *           A guest function called with these arguments on that thread.
 * @property {() => unknown} callerThread  The thread whose call this is.
 */

/** @param {Uint8Array} bytes */
const u32 = bytes=>(bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;

/** @param {number} value */
const dword = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

/** @param {UnknownHost} host */
export function createUnknownFunctions(host){
    /**
     * A method of an object, `this` first, as a COM method takes it.
     *
     * @param {number} object @param {number} slot @param {number[]} args @param {unknown} thread
     */
    const callMethod = async(object, slot, args, thread)=>{
        const entry = u32(host.readMemory(u32(host.readMemory(object, 4)) + slot * 4, 4));
        return (await host.call(entry, [object, ...args], thread)) | 0;
    };

    return {
        /**
         * HRESULT IUnknown_QueryService(IUnknown *punk, REFGUID guidService,
         *   REFIID riid, void **ppvOut)
         *
         * The object's IServiceProvider asked for the service, and let go
         * after: whatever QueryInterface or QueryService answers is the
         * answer, and E_FAIL with no object or nowhere to put one, NULL
         * written first wherever there is somewhere, as Wine's conformance
         * tests have it.
         */
        IUnknown_QueryService: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: async([object, service, interfaceId, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_FAIL;
                }
                host.writeMemory(out >>> 0, dword(0));
                if ((object >>> 0) === 0)
                {
                    return E_FAIL;
                }
                const thread = host.callerThread();
                const block = host.allocate(IID_ISERVICEPROVIDER.length + 4);
                if (block === 0)
                {
                    return E_OUTOFMEMORY;
                }
                try
                {
                    host.writeMemory(block, IID_ISERVICEPROVIDER);
                    const slot = block + IID_ISERVICEPROVIDER.length;
                    host.writeMemory(slot, dword(0));
                    const asked = await callMethod(object >>> 0, SLOT_QUERY_INTERFACE,
                        [block, slot], thread);
                    const provider = u32(host.readMemory(slot, 4));
                    if (asked !== S_OK || provider === 0)
                    {
                        return asked;
                    }
                    const answer = await callMethod(provider, SLOT_QUERY_SERVICE,
                        [service >>> 0, interfaceId >>> 0, out >>> 0], thread);
                    await callMethod(provider, SLOT_RELEASE, [], thread);
                    return answer;
                }
                finally
                {
                    host.free(block);
                }
            },
        },
    };
}
