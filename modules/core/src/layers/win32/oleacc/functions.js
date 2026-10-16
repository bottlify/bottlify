/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * oleacc — Active Accessibility, as far as a framework links it: MFC imports
 * the two calls a window answers WM_GETOBJECT with, and a library that does
 * not load stops every program built on it before its first window.
 *
 * Nothing here asks a window for an accessible object -- no screen reader
 * sends WM_GETOBJECT -- so neither call is reached in the ordinary course.
 * One that is reached says it was, and fails the documented way: an error
 * HRESULT, and a null where an interface would have been.
 */

const E_NOTIMPL = 0x80004001 | 0;
const E_INVALIDARG = 0x80070057 | 0;

/**
 * @typedef {Object} OleaccHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(api: string, detail: string) => void} [divergence]
 */

/** @param {OleaccHost} host */
export function createOleaccFunctions(host){
    const said = (/** @type {string} */ name)=>host.divergence?.(name,
        'no accessible object is made: the call fails with E_NOTIMPL');
    return {
        /**
         * HRESULT CreateStdAccessibleObject(HWND hwnd, LONG idObject, REFIID riid,
         *                                   void **ppvObject)
         */
        CreateStdAccessibleObject: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, , , out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                host.writeMemory(out >>> 0, new Uint8Array(4));
                said('CreateStdAccessibleObject');
                return E_NOTIMPL;
            },
        },
        /** LRESULT LresultFromObject(REFIID riid, WPARAM wParam, LPUNKNOWN punk) */
        LresultFromObject: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([riid])=>{
                if ((riid >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                said('LresultFromObject');
                return E_NOTIMPL;
            },
        },
    };
}
