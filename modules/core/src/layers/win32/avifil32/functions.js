/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * avifil32 — the AVIFile library: reading and writing AVI files through the
 * file and stream handlers COM registers for them.
 *
 * This machine registers no AVI file handler, so no file is ever opened or
 * created: AVIFileOpen answers AVIERR_FILEOPEN with its out pointer cleared,
 * and the calls on a file or stream a caller can never hold answer as for a
 * handle that is not one. A program linked against the library at load time
 * (to record its own play as a film, say) only needs it present and failing
 * so.
 */

/** MAKE_AVIERR(n): SEVERITY_ERROR, FACILITY_ITF, 0x4000 + n. */
const avierr = (/** @type {number} */ n)=>(0x80044000 + n) >>> 0;
export const AVIERR_UNSUPPORTED = avierr(101);
export const AVIERR_BADHANDLE = avierr(108);
export const AVIERR_FILEOPEN = avierr(111);

/**
 * @typedef {Object} AvifilHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/**
 * @param {AvifilHost} host
 */
export function createAvifilFunctions(host){
    /** @param {number} at */
    const clear = at=>{
        if ((at >>> 0) !== 0)
            host.writeMemory(at >>> 0, new Uint8Array(4));
    };
    /** HRESULT AVIFileOpen(PAVIFILE *ppfile, LPCSTR szFile, UINT uMode, LPCLSID lpHandler) */
    const open = { argBytes: 16, handler: (/** @type {number[]} */ [out])=>{
        clear(out);
        return AVIERR_FILEOPEN;
    } };
    /** HRESULT AVIFileCreateStream(PAVIFILE pfile, PAVISTREAM *ppavi, AVISTREAMINFO *psi) */
    const createStream = { argBytes: 12, handler: (/** @type {number[]} */ [, out])=>{
        clear(out);
        return AVIERR_BADHANDLE;
    } };
    return {
        /** void AVIFileInit(void), void AVIFileExit(void): nothing to load or unload. */
        AVIFileInit: { argBytes: 0, handler: ()=>0 },
        AVIFileExit: { argBytes: 0, handler: ()=>0 },

        AVIFileOpenA: open,
        AVIFileOpenW: open,
        AVIFileCreateStreamA: createStream,
        AVIFileCreateStreamW: createStream,

        /**
         * ULONG AVIFileRelease(PAVIFILE pfile), ULONG AVIStreamRelease(PAVISTREAM pavi)
         *
         * The remaining reference count; nothing is held, so zero.
         */
        AVIFileRelease: { argBytes: 4, handler: ()=>0 },
        AVIStreamRelease: { argBytes: 4, handler: ()=>0 },

        /**
         * HRESULT AVIStreamWrite(PAVISTREAM pavi, LONG lStart, LONG lSamples,
         *     LPVOID lpBuffer, LONG cbBuffer, DWORD dwFlags,
         *     LONG *plSampWritten, LONG *plBytesWritten)
         *
         * No stream exists to write to; the counts written are zero.
         */
        AVIStreamWrite: { argBytes: 32, handler: (/** @type {number[]} */ args)=>{
            clear(args[6]);
            clear(args[7]);
            return AVIERR_BADHANDLE;
        } },

        /** HRESULT AVIStreamSetFormat(PAVISTREAM pavi, LONG lPos, LPVOID lpFormat, LONG cbFormat) */
        AVIStreamSetFormat: { argBytes: 16, handler: ()=>AVIERR_BADHANDLE },

        /**
         * HRESULT AVIMakeCompressedStream(PAVISTREAM *ppsCompressed,
         *     PAVISTREAM psSource, AVICOMPRESSOPTIONS *lpOptions, CLSID *pclsidHandler)
         *
         * There are no compressors to make one with.
         */
        AVIMakeCompressedStream: { argBytes: 16, handler: (/** @type {number[]} */ [out])=>{
            clear(out);
            return AVIERR_UNSUPPORTED;
        } },
    };
}
