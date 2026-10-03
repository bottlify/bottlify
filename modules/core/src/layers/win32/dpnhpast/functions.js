/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * dpnhpast — DirectPlay's NAT helper for Internet Connection Sharing, which
 * DirectX 8.1 installs and every Windows from XP on carries.
 *
 * It is an in-process COM server whose class only a DirectPlay 8 session
 * asks for, and there is no DirectPlay 8 here, so no class is made. What
 * matters is that the library is there: the version check the DirectX SDK's
 * samples taught programs takes a d3d8.dll with a dpnhpast.dll beside it for
 * DirectX 8.1, and a d3d8.dll alone for 8.0.
 */

const S_OK = 0;
const CLASS_E_CLASSNOTAVAILABLE = 0x80040111;

/**
 * @typedef {Object} DpnhpastHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * @param {DpnhpastHost} host
 */
export function createDpnhpastFunctions(host){
    return {
        /** HRESULT DllCanUnloadNow(void): nothing it made is held. */
        DllCanUnloadNow: {
            argBytes: 0,
            handler: ()=>S_OK,
        },

        /** HRESULT DllGetClassObject(REFCLSID rclsid, REFIID riid, LPVOID *ppv) */
        DllGetClassObject: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, , out])=>{
                host.divergence?.('DllGetClassObject', 'dpnhpast.dll makes no NAT helper: '
                    + 'there is no DirectPlay 8 to use one');
                if ((out >>> 0) !== 0)
                {
                    host.writeMemory(out >>> 0, new Uint8Array(4));
                }
                return CLASS_E_CLASSNOTAVAILABLE;
            },
        },

        /** HRESULT DllRegisterServer(void) */
        DllRegisterServer: {
            argBytes: 0,
            handler: ()=>S_OK,
        },

        /** HRESULT DllUnregisterServer(void) */
        DllUnregisterServer: {
            argBytes: 0,
            handler: ()=>S_OK,
        },
    };
}
