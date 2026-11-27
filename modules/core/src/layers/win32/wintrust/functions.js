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

import { createCatalogFunctions } from './catalog.js';
import { DerError } from '../crypto/der.js';
import { parseCertificate } from '../crypto/x509.js';
import { TRUST, verifyAuthenticode } from './authenticode.js';
import { defaultTrustedRoots } from './roots.js';
import { msiSubject, readSubject } from './subject.js';
import { wholeAddress } from '../common/pointers.js';
import { fromBase64 } from '../../../system/base64.js';

/**
 * How far a name a program hands these is read: whole, as Windows reads it, up to
 * the 32 767 characters a path may have. A name cut shorter names another file.
 */
const WHOLE_NAME = 32767;

/** @typedef {import('../crypto/x509.js').Certificate} Certificate */
/** @typedef {import('../kernel32/files.js').FileSystem} FileSystem */

/** {00AAC56B-CD44-11D0-8CC2-00C04FC295EE}, as it lies in memory. */
const WINTRUST_ACTION_GENERIC_VERIFY_V2 = Uint8Array.of(0x6b, 0xc5, 0xaa, 0x00, 0x44, 0xcd,
    0xd0, 0x11, 0x8c, 0xc2, 0x00, 0xc0, 0x4f, 0xc2, 0x95, 0xee);

const TRUST_E_PROVIDER_UNKNOWN = 0x800b0001;
const CRYPT_E_FILE_ERROR = 0x80092003;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_FILE_NOT_FOUND = 2;

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
 * CRYPT_PROVIDER_DATA's signer count and array, CRYPT_PROVIDER_SGNR's
 * certificate chain and countersigners, and the two element sizes the
 * arrays are laid out in (the 32-bit structures, as wintrust.h declares them).
 */
const PROVIDER_DATA = Object.freeze({ SIGNERS: 64, SIGNER_ARRAY: 68 });
const PROVIDER_SIGNER = Object.freeze({
    CERTS: 12, CERT_ARRAY: 16, COUNTER_SIGNERS: 32, COUNTER_SIGNER_ARRAY: 36, SIZE: 44,
});
const PROVIDER_CERT_SIZE = 60;

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
 * @property {(name: string, args: number[]) => number} [crypt32]  a crypt32 export,
 *     called: the certificate contexts and chain a provider's data points at are its
 * @property {(bytes: number) => number} [allocate]  zeroed memory; 0 when none is left
 * @property {(address: number) => void} [free]
 */

/** CRYPT_PROVIDER_DATA, 32-bit: its size and the fields laid out here. */
const PROVIDER_DATA_SIZE = 136;
const PROVIDER_DATA_WINTRUST = 4;
const PROVIDER_DATA_FINAL_ERROR = 112;
/** CRYPT_PROVIDER_SGNR's error and chain context; CRYPT_PROVIDER_CERT's certificate. */
const SIGNER_ERROR = 28;
const SIGNER_CHAIN_CONTEXT = 40;
const CERT_POINTER = 4;
const CERT_TRUSTED_ROOT = 12;
const CERT_SELF_SIGNED = 16;
/** crypt32's memory store, an encoding, an add that keeps duplicates, CERT_CHAIN_PARA's size. */
const CERT_STORE_PROV_MEMORY = 2;
const X509_ASN_ENCODING = 1;
const CERT_STORE_ADD_ALWAYS = 4;
const CHAIN_PARA_SIZE = 16;

/**
 * @param {WintrustHost} host
 */
export function createWintrustFunctions(host){
    /** @param {number} address */
    const readU32 = address=>{
        const bytes = host.readMemory(wholeAddress(address), 4);
        return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    };

    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(wholeAddress(address), bytes);
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

    /** Whether a program has been told once that no provider data is kept. */
    let saidNoProviderData = false;

    /**
     * A verification's provider data in guest memory, as Windows hands it to
     * a caller that kept the state (WTD_STATEACTION_VERIFY): the one signer,
     * its certificates as contexts from its own to the root, and the chain
     * context crypt32 builds over them. A setup engine checks the publisher
     * of what it downloads against the chain (WiX Burn's payload check); with
     * none it fails as a signature it could not read. Null where there is no
     * chain or no way to lay one out (a 64-bit process's layout is not here).
     *
     * The chain is built at the time the signature was judged at - its
     * timestamp's, when it has one - as the verdict was: a signer's certificate
     * that has run out since is still the one that signed in its time.
     *
     * @param {Uint8Array[]} chain @param {number} time  milliseconds since 1970
     * @param {number} data @param {number} code
     * @returns {{ address: number, release: () => void } | null}
     */
    const layProvider = (chain, time, data, code)=>{
        const crypt32 = host.crypt32;
        const allocate = host.allocate;
        const free = host.free;
        if (!crypt32 || !allocate || !free || chain.length === 0)
        {
            return null;
        }
        const store = crypt32('CertOpenStore', [CERT_STORE_PROV_MEMORY, 0, 0, 0, 0]) >>> 0;
        if (store === 0)
        {
            return null;
        }
        const scratch = allocate(CHAIN_PARA_SIZE + 4 + 8
            + Math.max(...chain.map(one=>one.length)));
        /** @type {number[]} */
        const contexts = [];
        let chainContext = 0;
        const block = scratch === 0 ? 0 : allocate(PROVIDER_DATA_SIZE + PROVIDER_SIGNER.SIZE
            + PROVIDER_CERT_SIZE * chain.length);
        const release = ()=>{
            if (chainContext !== 0)
            {
                crypt32('CertFreeCertificateChain', [chainContext]);
            }
            contexts.forEach(context=>crypt32('CertFreeCertificateContext', [context]));
            crypt32('CertCloseStore', [store, 0]);
            if (block !== 0)
            {
                free(block);
            }
        };
        try
        {
            if (block === 0)
            {
                release();
                return null;
            }
            const out = scratch + CHAIN_PARA_SIZE;
            const when = out + 4;
            const encoded = when + 8;
            for (const certificate of chain)
            {
                host.writeMemory(encoded, certificate);
                writeU32(out, 0);
                crypt32('CertAddEncodedCertificateToStore', [store, X509_ASN_ENCODING, encoded,
                    certificate.length, CERT_STORE_ADD_ALWAYS, out]);
                contexts.push(readU32(out));
            }
            if (contexts.some(context=>context === 0))
            {
                release();
                return null;
            }
            host.writeMemory(scratch, new Uint8Array(CHAIN_PARA_SIZE));
            writeU32(scratch, CHAIN_PARA_SIZE);
            writeU32(out, 0);
            // A FILETIME: 100 ns since 1601.
            const ticks = (BigInt(Math.round(time)) + 11644473600000n) * 10000n;
            writeU32(when, Number(ticks & 0xffffffffn));
            writeU32(when + 4, Number(ticks >> 32n));
            crypt32('CertGetCertificateChain', [0, contexts[0], when, store, scratch, 0, 0, out]);
            chainContext = readU32(out);
        }
        finally
        {
            if (scratch !== 0)
            {
                free(scratch);
            }
        }
        const signer = block + PROVIDER_DATA_SIZE;
        const certificates = signer + PROVIDER_SIGNER.SIZE;
        writeU32(block, PROVIDER_DATA_SIZE);
        writeU32(block + PROVIDER_DATA_WINTRUST, data);
        writeU32(block + PROVIDER_DATA.SIGNERS, 1);
        writeU32(block + PROVIDER_DATA.SIGNER_ARRAY, signer);
        writeU32(block + PROVIDER_DATA_FINAL_ERROR, code);
        writeU32(signer, PROVIDER_SIGNER.SIZE);
        writeU32(signer + PROVIDER_SIGNER.CERTS, chain.length);
        writeU32(signer + PROVIDER_SIGNER.CERT_ARRAY, certificates);
        writeU32(signer + SIGNER_ERROR, code);
        writeU32(signer + SIGNER_CHAIN_CONTEXT, chainContext);
        contexts.forEach((context, index)=>{
            const at = certificates + index * PROVIDER_CERT_SIZE;
            writeU32(at, PROVIDER_CERT_SIZE);
            writeU32(at + CERT_POINTER, context);
            const last = index === contexts.length - 1;
            writeU32(at + CERT_TRUSTED_ROOT, last && code === TRUST.OK ? 1 : 0);
            writeU32(at + CERT_SELF_SIGNED, last && roots().some(root=>root.encoded.length
                === chain[index].length && root.encoded.every((byte, i)=>byte
                === chain[index][i])) ? 1 : 0);
        });
        return { address: block, release };
    };

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
                    ? fromBase64(entry) : entry));
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
                host.handles.resolve(handle, 'wintrust-state').provider?.release();
                host.handles.close(handle);
            }
            writeU32(data + WTD.STATE_DATA, 0);
            return TRUST.OK;
        }
        const guid = host.readMemory(wholeAddress(action), 16);
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
        /** @param {Uint8Array | null} bytes @param {import('./subject.js').Subject | null} subject */
        const verdict = (bytes, subject)=>{
            /** @type {Uint8Array[]} */
            let chain = [];
            let judgedAt = host.now();
            const code = bytes ? verifyAuthenticode(bytes, {
                roots: roots(),
                now: host.now(),
                hashOnly: (flags & WTD_HASH_ONLY_FLAG) !== 0,
                lifetime: (flags & WTD_LIFETIME_SIGNING_FLAG) !== 0,
                signerChain: (found, time)=>{
                    chain = found;
                    judgedAt = time;
                },
            }, subject) : CRYPT_E_FILE_ERROR;
            if (state === WTD_STATEACTION_VERIFY)
            {
                const provider = layProvider(chain, judgedAt, wholeAddress(data), code);
                writeU32(data + WTD.STATE_DATA, host.handles.open('wintrust-state',
                    { code, provider }));
            }
            return answer(code);
        };
        /**
         * A cabinet or a PE image judged at once; an installer database once
         * its streams are read.
         *
         * @param {Uint8Array | null} bytes
         */
        const judge = bytes=>{
            const subject = bytes ? readSubject(bytes) : null;
            return bytes && !subject && bytes[0] === 0xd0 && bytes[1] === 0xcf
                ? msiSubject(bytes).then(database=>verdict(bytes, database))
                : verdict(bytes, subject);
        };
        const bytes = readWhole(host.fullPath(host.readWideString(pathPointer, WHOLE_NAME * 2)));
        return bytes instanceof Promise ? bytes.then(judge) : judge(bytes);
    };

    /**
     * Element `index` of an array of `size`-byte structures whose count and
     * pointer are at `countAt` and `arrayAt`: 0 past its end or when there
     * is no array, which is how the helpers below say "none".
     *
     * @param {number} countAt @param {number} arrayAt @param {number} index
     * @param {number} size
     */
    const element = (countAt, arrayAt, index, size)=>{
        const array = readU32(arrayAt);
        return (index >>> 0) < readU32(countAt) && array !== 0
            ? (array + (index >>> 0) * size) >>> 0 : 0;
    };

    return {
        // The catalog administrator hashes the file a handle is open on.
        ...createCatalogFunctions({ ...host,
            fileBytes: handle=>{
                let file;
                try
                {
                    file = host.handles.resolve(handle, 'file');
                }
                catch {
                    return null;
                }
                return file?.path ? readWhole(file.path) : null;
            } }),
        WinVerifyTrust: { argBytes: 12, handler: verifyTrust },

        /**
         * HRESULT WinVerifyTrustEx(HWND hwnd, GUID *pgActionID,
         *                          WINTRUST_DATA *pWinTrustData)
         *
         * The same verification, the answer read as an HRESULT.
         */
        WinVerifyTrustEx: { argBytes: 12, handler: verifyTrust },

        /**
         * HANDLE CryptCATOpen(LPCWSTR pwszFileName, DWORD fdwOpenFlags,
         *                     HCRYPTPROV hProv, DWORD dwPublicVersion,
         *                     DWORD dwEncodingType)
         *
         * Opens a catalog file, handing back a handle over it. The catalog is
         * opened as a file: a name that is not there fails with
         * ERROR_FILE_NOT_FOUND, and the handle is what CryptCATClose closes.
         * CRYPTCAT_OPEN_EXISTING's distinction -- a missing file is not created
         * -- is the one thing honoured, since nothing here enumerates the
         * members an opened catalog names.
         */
        CryptCATOpen: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([name, flags])=>{
                const path = host.fullPath(host.readWideString(wholeAddress(name), WHOLE_NAME * 2));
                const stat = host.files.stat(path);
                if (!stat || stat.isDirectory)
                {
                    host.setLastErrorFor(host.callerThread(), ERROR_FILE_NOT_FOUND);
                    return 0;
                }
                return host.handles.open('wintrust-catalog', { path, flags: flags >>> 0 });
            },
        },

        /**
         * CRYPT_PROVIDER_DATA *WTHelperProvDataFromStateData(HANDLE hStateData)
         *
         * The provider data the verification laid out: the signer, its
         * certificates and its chain (`layProvider`). Where none could be --
         * no signer's chain, a file that is not signed -- NULL, what a caller
         * is documented to check for, said once.
         */
        WTHelperProvDataFromStateData: {
            returns: 'pointer',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([state])=>{
                const provider = (state >>> 0) !== 0 && isState(state >>> 0)
                    ? host.handles.resolve(state >>> 0, 'wintrust-state').provider : null;
                if (provider)
                {
                    return provider.address;
                }
                if ((state >>> 0) !== 0 && isState(state >>> 0) && !saidNoProviderData)
                {
                    saidNoProviderData = true;
                    host.divergence?.('WTHelperProvDataFromStateData',
                        'verification keeps no provider data (signers, certificate chain); '
                        + 'NULL answered');
                }
                return 0;
            },
        },

        /**
         * CRYPT_PROVIDER_SGNR *WTHelperGetProvSignerFromChain(
         *     CRYPT_PROVIDER_DATA *pProvData, DWORD idxSigner, BOOL fCounterSigner,
         *     DWORD idxCounterSigner)
         *
         * The signer at idxSigner, or that signer's countersigner, read from
         * the structure the caller passes; NULL past either array's end. A
         * NULL pProvData -- what WTHelperProvDataFromStateData answers here
         * -- is NULL rather than the fault it would be on Windows.
         */
        WTHelperGetProvSignerFromChain: {
            returns: 'pointer',
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([data, index, counter, counterIndex])=>{
                if (wholeAddress(data) === 0)
                {
                    return 0;
                }
                const signer = element(wholeAddress(data) + PROVIDER_DATA.SIGNERS,
                    wholeAddress(data) + PROVIDER_DATA.SIGNER_ARRAY, index, PROVIDER_SIGNER.SIZE);
                if (signer === 0 || counter === 0)
                {
                    return signer;
                }
                return element(signer + PROVIDER_SIGNER.COUNTER_SIGNERS,
                    signer + PROVIDER_SIGNER.COUNTER_SIGNER_ARRAY, counterIndex,
                    PROVIDER_SIGNER.SIZE);
            },
        },

        /**
         * CRYPT_PROVIDER_CERT *WTHelperGetProvCertFromChain(
         *     CRYPT_PROVIDER_SGNR *pSgnr, DWORD idxCert)
         *
         * The certificate at idxCert of the signer's chain, the signer's own
         * first; NULL for no signer or past the chain's end.
         */
        WTHelperGetProvCertFromChain: {
            returns: 'pointer',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([signer, index])=>(wholeAddress(signer) === 0 ? 0
                : element(wholeAddress(signer) + PROVIDER_SIGNER.CERTS,
                    wholeAddress(signer) + PROVIDER_SIGNER.CERT_ARRAY, index, PROVIDER_CERT_SIZE)),
        },

        /** BOOL CryptCATClose(HANDLE hCatalog) */
        CryptCATClose: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                try
                {
                    host.handles.close(handle >>> 0);
                    return 1;
                }
                catch (e){
                    void e;
                    return 0;
                }
            },
        },
    };
}
