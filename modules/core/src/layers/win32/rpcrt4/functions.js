/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * rpcrt4, as far as a proxy/stub DLL's self-registration reaches it.
 *
 * A COM server ships a DLL whose DllRegisterServer hands its proxy table to
 * NdrDllRegisterProxy, which writes the class and interface keys marshaling
 * would later read. There is one apartment here and nothing is marshaled, so
 * the keys are never read; the registration is answered as done and said to
 * diverge, and the class-object entry points refuse the documented way, since
 * no proxy class exists to hand out.
 */

import { GUID_SIZE, parseGuid } from '../ole32/guid.js';

/** HRESULTs, and the RPC statuses that are not HRESULTs. */
const S_OK = 0;
const S_FALSE = 1;
const CLASS_E_CLASSNOTAVAILABLE = 0x80040111 | 0;
const RPC_S_OK = 0;
const RPC_S_INVALID_STRING_UUID = 1705;

/** A UUID's string form is 36 characters, without braces. */
const UUID_STRING_LENGTH = 36;

/**
 * @typedef {Object} RpcHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} [readCString]
 * @property {((api: string, detail: string) => void) | undefined} [divergence]
 */

/**
 * @param {RpcHost} host
 */
export function createRpcFunctions(host){
    const report = host.divergence ?? (()=>{});

    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address, bytes);
    };

    return {
        /**
         * HRESULT NdrDllRegisterProxy(HMODULE hDll, const ProxyFileInfo **pProxyFileList,
         *                             const CLSID *pclsid)
         * HRESULT NdrDllUnregisterProxy(HMODULE, const ProxyFileInfo **, const CLSID *)
         */
        NdrDllRegisterProxy: {
            argBytes: 12,
            handler: ()=>{
                report('NdrDllRegisterProxy',
                    'proxy and stub classes are not registered: nothing is marshaled here');
                return S_OK;
            },
        },
        NdrDllUnregisterProxy: {
            argBytes: 12,
            handler: ()=>S_OK,
        },

        /**
         * HRESULT NdrDllGetClassObject(REFCLSID rclsid, REFIID riid, void **ppv,
         *     const ProxyFileInfo **pProxyFileList, const CLSID *pclsid,
         *     CStdPSFactoryBuffer *pPSFactoryBuffer)
         * HRESULT NdrDllCanUnloadNow(CStdPSFactoryBuffer *pPSFactoryBuffer)
         */
        NdrDllGetClassObject: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([, , out])=>{
                if ((out >>> 0) !== 0)
                {
                    writeU32(out >>> 0, 0);
                }
                return CLASS_E_CLASSNOTAVAILABLE;
            },
        },
        NdrDllCanUnloadNow: {
            argBytes: 4,
            handler: ()=>S_FALSE,
        },

        /**
         * RPC_STATUS UuidCreate(UUID *Uuid)
         *
         * A version 4 UUID, the same one CoCreateGuid makes: the two fields a
         * reader inspects say it is random rather than a clock and an
         * address. Data3 is little-endian, so its high byte is the eighth.
         */
        UuidCreate: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                const bytes = new Uint8Array(GUID_SIZE);
                crypto.getRandomValues(bytes);
                bytes[7] = (bytes[7] & 0x0f) | 0x40;
                bytes[8] = (bytes[8] & 0x3f) | 0x80;
                host.writeMemory(out >>> 0, bytes);
                return RPC_S_OK;
            },
        },

        /**
         * RPC_STATUS UuidFromStringA(RPC_CSTR StringUuid, UUID *Uuid)
         *
         * The string form has no braces, unlike the one COM speaks; a NULL
         * string is the nil UUID.
         */
        UuidFromStringA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([text, out])=>{
                if ((text >>> 0) === 0)
                {
                    host.writeMemory(out >>> 0, new Uint8Array(GUID_SIZE));
                    return RPC_S_OK;
                }
                const spelled = host.readCString?.(text >>> 0, UUID_STRING_LENGTH + 1) ?? '';
                const bytes = spelled.length === UUID_STRING_LENGTH
                    ? parseGuid(`{${spelled}}`)
                    : null;
                if (bytes === null)
                {
                    return RPC_S_INVALID_STRING_UUID;
                }
                host.writeMemory(out >>> 0, bytes);
                return RPC_S_OK;
            },
        },
    };
}
