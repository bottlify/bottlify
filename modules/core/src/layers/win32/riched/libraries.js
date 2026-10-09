/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * riched32 and riched20 as libraries a program can load.
 *
 * The rich edit classes are registered with the rest of the controls, so a
 * dialog that names one gets it whether or not its library was asked for. But
 * a program asks first: it calls LoadLibrary("RICHED32.DLL") before making a
 * dialog with a RichEdit in it, as the documentation tells it to, and takes a
 * NULL as "no rich edit on this machine" and gives up on the dialog. So the
 * libraries exist, holding the classes, and export what the text-services
 * side of riched20 offers as a documented refusal: windowless text services
 * are not provided.
 */

const E_INVALIDARG = 0x80070057;
const E_NOTIMPL = 0x80004001;

/**
 * @typedef {Object} RichedHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/** @param {RichedHost} host */
export function createRichedLibraries(host){
    return {
        'RICHED32.DLL': {},
        'RICHED20.DLL': {
            /**
             * HRESULT CreateTextServices(IUnknown *punkOuter, ITextHost *pITextHost,
             *                            IUnknown **ppUnk)
             *
             * The out pointer is cleared, so a caller that checks it rather
             * than the HRESULT sees nothing made.
             */
            CreateTextServices: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([, , out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_INVALIDARG;
                    }
                    host.writeMemory(out >>> 0, new Uint8Array(4));
                    return E_NOTIMPL;
                },
            },
        },
    };
}
