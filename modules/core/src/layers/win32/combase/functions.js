/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * combase: the Windows Runtime's start, its strings and its activation, as
 * much of it as a desktop program asks before falling back to the Win32 way.
 *
 * A browser asks the runtime for a class (a notification manager, a UI
 * settings object) and does without it when there is none. So the runtime
 * starts and stops, its strings are made and read, and every class is not
 * registered -- the answer of a machine without that component, which the
 * caller already handles. An HSTRING is a block of guest memory: a header
 * (flags, length, padding, the buffer's address) and the UTF-16 text after
 * it, terminated; a reference string is the caller's own header, made over
 * its text.
 */

const S_OK = 0;
const S_FALSE = 1;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const E_POINTER = 0x80004003 | 0;
const REGDB_E_CLASSNOTREG = 0x80040154 | 0;
/** RO_INIT_TYPE: RO_INIT_SINGLETHREADED 0, RO_INIT_MULTITHREADED 1. */
const RO_INIT_MULTITHREADED = 1;
const RPC_E_CHANGED_MODE = 0x80010106 | 0;
/** HSTRING_HEADER is twenty bytes on x86; the reference flag in its first word. */
const HEADER_SIZE = 20;
const REFERENCE = 0x1;
const MAX_TEXT = 0x7fffffff;

/**
 * @typedef {Object} CombaseHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} allocate  0 when none can be had
 * @property {(address: number) => void} free
 * @property {(api: string, detail: string) => void} [divergence]
 */

/** @param {CombaseHost} host */
export function createCombaseFunctions(host){
    /** @param {number} address */
    const dword = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    };
    /** @param {number} address @param {number} value */
    const setDword = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };
    /** The runtime's apartment, once started: 'single' or 'multi'. @type {string | null} */
    let apartment = null;
    let starts = 0;
    /** Strings made here, by address, so a deleted one is freed once. @type {Set<number>} */
    const made = new Set();
    const said = new Set();
    /** The empty string's text, which NULL's raw buffer is: made when first asked. */
    let emptyText = 0;

    /**
     * A string's header, for an HSTRING of either kind; null for NULL, the empty string.
     *
     * @param {number} string
     */
    const headerOf = string=>((string >>> 0) === 0 ? null : string >>> 0);

    return {
        /** HRESULT RoInitialize(RO_INIT_TYPE initType) */
        RoInitialize: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([type])=>{
                const wanted = (type >>> 0) === RO_INIT_MULTITHREADED ? 'multi' : 'single';
                if (apartment !== null && apartment !== wanted)
                {
                    return RPC_E_CHANGED_MODE;
                }
                apartment = wanted;
                starts++;
                return starts === 1 ? S_OK : S_FALSE;
            },
        },

        /** void RoUninitialize(void) */
        RoUninitialize: {
            argBytes: 0,
            handler: ()=>{
                if (starts > 0 && --starts === 0)
                {
                    apartment = null;
                }
                return 0;
            },
        },

        /**
         * HRESULT RoGetActivationFactory(HSTRING activatableClassId, REFIID iid,
         *     void **factory), and RoActivateInstance(HSTRING, IInspectable **)
         *
         * No class of the runtime is registered here.
         */
        RoGetActivationFactory: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, , out])=>{
                if ((out >>> 0) !== 0)
                {
                    setDword(out, 0);
                }
                if (!said.has('activation'))
                {
                    said.add('activation');
                    host.divergence?.('RoGetActivationFactory',
                        'no Windows Runtime class is registered');
                }
                return REGDB_E_CLASSNOTREG;
            },
        },
        RoActivateInstance: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, out])=>{
                if ((out >>> 0) !== 0)
                {
                    setDword(out, 0);
                }
                return REGDB_E_CLASSNOTREG;
            },
        },

        /**
         * HRESULT WindowsCreateString(PCNZWCH sourceString, UINT32 length, HSTRING *string)
         *
         * A copy of the text, terminated; no text is the empty string, NULL.
         */
        WindowsCreateString: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([source, length, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const count = length >>> 0;
                if ((source >>> 0) === 0 && count !== 0)
                {
                    return E_POINTER;
                }
                if (count === 0)
                {
                    setDword(out, 0);
                    return S_OK;
                }
                if (count > MAX_TEXT / 2)
                {
                    return E_OUTOFMEMORY;
                }
                const block = host.allocate(HEADER_SIZE + (count + 1) * 2);
                if (block === 0)
                {
                    return E_OUTOFMEMORY;
                }
                const bytes = new Uint8Array(HEADER_SIZE + (count + 1) * 2);
                const view = new DataView(bytes.buffer);
                view.setUint32(4, count, true);
                view.setUint32(16, block + HEADER_SIZE, true);
                bytes.set(host.readMemory(source >>> 0, count * 2), HEADER_SIZE);
                host.writeMemory(block, bytes);
                made.add(block);
                setDword(out, block);
                return S_OK;
            },
        },

        /**
         * HRESULT WindowsCreateStringReference(PCWSTR sourceString, UINT32 length,
         *     HSTRING_HEADER *hstringHeader, HSTRING *string)
         *
         * The caller's header over the caller's text, which must be terminated.
         */
        WindowsCreateStringReference: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([source, length, header, out])=>{
                if ((out >>> 0) === 0 || (header >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const count = length >>> 0;
                if (count === 0)
                {
                    setDword(out, 0);
                    return S_OK;
                }
                if ((source >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const terminator = host.readMemory((source >>> 0) + count * 2, 2);
                if (terminator[0] !== 0 || terminator[1] !== 0)
                {
                    return E_INVALIDARG;
                }
                const bytes = new Uint8Array(HEADER_SIZE);
                const view = new DataView(bytes.buffer);
                view.setUint32(0, REFERENCE, true);
                view.setUint32(4, count, true);
                view.setUint32(16, source >>> 0, true);
                host.writeMemory(header >>> 0, bytes);
                setDword(out, header >>> 0);
                return S_OK;
            },
        },

        /** HRESULT WindowsDeleteString(HSTRING string): a reference is the caller's to keep. */
        WindowsDeleteString: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([string])=>{
                const at = headerOf(string);
                if (at !== null && made.delete(at))
                {
                    host.free(at);
                }
                return S_OK;
            },
        },

        /** PCWSTR WindowsGetStringRawBuffer(HSTRING string, UINT32 *length) */
        WindowsGetStringRawBuffer: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([string, length])=>{
                const at = headerOf(string);
                if ((length >>> 0) !== 0)
                {
                    setDword(length, at === null ? 0 : dword(at + 4));
                }
                // The empty string's text is an empty terminated string, never NULL.
                if (at === null)
                {
                    emptyText ||= host.allocate(2);
                    return emptyText;
                }
                return dword(at + 16);
            },
        },

        /** UINT32 WindowsGetStringLen(HSTRING string) */
        WindowsGetStringLen: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([string])=>{
                const at = headerOf(string);
                return at === null ? 0 : dword(at + 4);
            },
        },

        /** BOOL WindowsIsStringEmpty(HSTRING string) */
        WindowsIsStringEmpty: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([string])=>{
                const at = headerOf(string);
                return at === null || dword(at + 4) === 0 ? 1 : 0;
            },
        },
    };
}
