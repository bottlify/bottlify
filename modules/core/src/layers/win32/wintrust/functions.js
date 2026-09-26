/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * wintrust.dll: WinVerifyTrust and WinVerifyTrustEx under the one action a
 * program asks for to learn whether a file is signed by someone it may trust,
 * WINTRUST_ACTION_GENERIC_VERIFY_V2, over a file named by a WINTRUST_FILE_INFO.
 *
 * The verdict is authenticode.js's, against a root store that is this
 * machine's configuration: `trustedRoots` when given, Microsoft's root
 * otherwise (roots.js). Its time is the machine's clock.
 */

import { DerError } from '../crypto/der.js';
import { parseCertificate } from '../crypto/x509.js';
import { TRUST, verifyAuthenticode } from './authenticode.js';
import { defaultTrustedRoots } from './roots.js';

/** @typedef {import('../crypto/x509.js').Certificate} Certificate */
/** @typedef {import('../kernel32/files.js').FileSystem} FileSystem */

/** {00AAC56B-CD44-11D0-8CC2-00C04FC295EE}, as it lies in memory. */
const WINTRUST_ACTION_GENERIC_VERIFY_V2 = Uint8Array.of(0x6b, 0xc5, 0xaa, 0x00, 0x44, 0xcd,
    0xd0, 0x11, 0x8c, 0xc2, 0x00, 0xc0, 0x4f, 0xc2, 0x95, 0xee);

const TRUST_E_PROVIDER_UNKNOWN = 0x800b0001;
const CRYPT_E_FILE_ERROR = 0x80092003;
const ERROR_INVALID_PARAMETER = 87;

/** WINTRUST_DATA's fields that matter here, by offset. */
const WTD = Object.freeze({
    REVOCATION_CHECKS: 16,
    UNION_CHOICE: 20,
    FILE: 24,
    STATE_ACTION: 28,
    STATE_DATA: 32,
    PROVIDER_FLAGS: 40,
    MINIMUM_SIZE: 44,
});

const WTD_CHOICE_FILE = 1;
const WTD_REVOKE_NONE = 0;
const WTD_STATEACTION_VERIFY = 1;
const WTD_STATEACTION_CLOSE = 2;
const WTD_HASH_ONLY_FLAG = 0x200;
const WTD_LIFETIME_SIGNING_FLAG = 0x800;

/**
 * @typedef {Object} WintrustHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(thread: any, code: number) => void} setLastErrorFor
 * @property {() => any} callerThread
 * @property {FileSystem} files
 * @property {(path: string) => string} fullPath
 * @property {{ open: (type: string, object: any) => number,
 *              resolve: (handle: number, type?: string) => any,
 *              close: (handle: number) => any }} handles
 * @property {() => (Uint8Array | string)[] | undefined} [trustedRoots]
 *   The configured root store, DER bytes or base64 each; absent for the default.
 * @property {() => number} now  The machine's time, in milliseconds since 1970.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * @param {WintrustHost} host
 */
export function createWintrustFunctions(host){
    /** @param {number} address */
    const readU32 = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    };

    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };

    /**
     * Whether a handle is state a verification handed out; a stale one is not.
     *
     * @param {number} handle
     */
    const isState = handle=>{
        try
        {
            return !!host.handles.resolve(handle, 'wintrust-state');
        }
        catch {
            return false;
        }
    };

    /** @type {{ from: any, roots: Certificate[] } | null} */
    let parsedRoots = null;

    /** The root store as certificates, parsed once per configuration. */
    const roots = ()=>{
        const configured = host.trustedRoots?.();
        if (parsedRoots && parsedRoots.from === configured)
        {
            return parsedRoots.roots;
        }
        /** @type {Certificate[]} */
        const out = [];
        for (const entry of configured ?? defaultTrustedRoots())
        {
            try
            {
                out.push(parseCertificate(typeof entry === 'string'
                    ? Uint8Array.from(atob(entry), ch=>ch.charCodeAt(0)) : entry));
            }
            catch (e){
                if (!(e instanceof DerError) && !(e instanceof DOMException))
                {
                    throw e;
                }
                host.divergence?.('WinVerifyTrust', 'a configured root is not a certificate');
            }
        }
        parsedRoots = { from: configured, roots: out };
        return out;
    };

    /**
     * The whole file, or null when it cannot be read.
     *
     * @param {string} path
     * @returns {Uint8Array | null | Promise<Uint8Array | null>}
     */
    const readWhole = path=>{
        const stat = host.files.stat(path);
        const node = stat && !stat.isDirectory ? host.files.open(path, { read: true }) : null;
        if (!stat || !node)
        {
            return null;
        }
        const read = host.files.read(node, 0, stat.size);
        if (read instanceof Uint8Array)
        {
            host.files.close(node);
            return read;
        }
        return read.then(bytes=>{
            host.files.close(node);
            return bytes;
        });
    };

    /**
     * LONG WinVerifyTrust(HWND hwnd, GUID *pgActionID, LPVOID pWVTData)
     *
     * The last error is the answer on every verification, as Wine's
     * wintrust tests (test_wintrust) see it; WTD_STATEACTION_CLOSE answers
     * zero and leaves it alone.
     *
     * @param {number[]} args
     * @returns {number | Promise<number>}
     */
    const verifyTrust = ([, action, data])=>{
        const thread = host.callerThread();
        /** @param {number} code */
        const answer = code=>{
            host.setLastErrorFor(thread, code);
            return code;
        };
        if ((action >>> 0) === 0 || (data >>> 0) === 0)
        {
            return answer(ERROR_INVALID_PARAMETER);
        }
        const state = readU32(data + WTD.STATE_ACTION);
        if (state === WTD_STATEACTION_CLOSE)
        {
            const handle = readU32(data + WTD.STATE_DATA);
            if (handle !== 0 && isState(handle))
            {
                host.handles.close(handle);
            }
            writeU32(data + WTD.STATE_DATA, 0);
            return TRUST.OK;
        }
        const guid = host.readMemory(action >>> 0, 16);
        if (!guid.every((byte, i)=>byte === WINTRUST_ACTION_GENERIC_VERIFY_V2[i]))
        {
            host.divergence?.('WinVerifyTrust',
                'an action other than WINTRUST_ACTION_GENERIC_VERIFY_V2');
            return answer(TRUST_E_PROVIDER_UNKNOWN);
        }
        if (readU32(data) < WTD.MINIMUM_SIZE)
        {
            return answer(ERROR_INVALID_PARAMETER);
        }
        if (readU32(data + WTD.UNION_CHOICE) !== WTD_CHOICE_FILE)
        {
            host.divergence?.('WinVerifyTrust', 'a subject other than a file (a catalog member, '
                + 'a blob, a signer or a certificate)');
            return answer(TRUST.TRUST_E_SUBJECT_FORM_UNKNOWN);
        }
        if (readU32(data + WTD.REVOCATION_CHECKS) !== WTD_REVOKE_NONE)
        {
            host.divergence?.('WinVerifyTrust', 'revocation is not checked');
        }
        const file = readU32(data + WTD.FILE);
        const pathPointer = file === 0 ? 0 : readU32(file + 4);
        if (pathPointer === 0)
        {
            return answer(ERROR_INVALID_PARAMETER);
        }
        const flags = readU32(data + WTD.PROVIDER_FLAGS);
        /** @param {Uint8Array | null} bytes */
        const judge = bytes=>{
            const code = bytes ? verifyAuthenticode(bytes, {
                roots: roots(),
                now: host.now(),
                hashOnly: (flags & WTD_HASH_ONLY_FLAG) !== 0,
                lifetime: (flags & WTD_LIFETIME_SIGNING_FLAG) !== 0,
            }) : CRYPT_E_FILE_ERROR;
            if (state === WTD_STATEACTION_VERIFY)
            {
                writeU32(data + WTD.STATE_DATA, host.handles.open('wintrust-state', { code }));
            }
            return answer(code);
        };
        const bytes = readWhole(host.fullPath(host.readWideString(pathPointer, 260)));
        return bytes instanceof Promise ? bytes.then(judge) : judge(bytes);
    };

    return {
        WinVerifyTrust: { argBytes: 12, handler: verifyTrust },

        /**
         * HRESULT WinVerifyTrustEx(HWND hwnd, GUID *pgActionID,
         *                          WINTRUST_DATA *pWinTrustData)
         *
         * The same verification, the answer read as an HRESULT.
         */
        WinVerifyTrustEx: { argBytes: 12, handler: verifyTrust },
    };
}
