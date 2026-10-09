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

        /** HRESULT AVIFileGetStream(PAVIFILE pfile, PAVISTREAM *ppavi, DWORD fccType, LONG lParam) */
        AVIFileGetStream: { argBytes: 16, handler: (/** @type {number[]} */ [, out])=>{
            clear(out);
            return AVIERR_BADHANDLE;
        } },
        /**
         * HRESULT AVIFileInfoA(PAVIFILE pfile, AVIFILEINFOA *pfi, LONG lSize),
         * HRESULT AVIStreamInfoA(PAVISTREAM pavi, AVISTREAMINFOA *psi, LONG lSize)
         */
        AVIFileInfoA: { argBytes: 12, handler: ()=>AVIERR_BADHANDLE },
        AVIStreamInfoA: { argBytes: 12, handler: ()=>AVIERR_BADHANDLE },

        /**
         * HRESULT AVIStreamRead(PAVISTREAM pavi, LONG lStart, LONG lSamples,
         *     LPVOID lpBuffer, LONG cbBuffer, LONG *plBytes, LONG *plSamples)
         */
        AVIStreamRead: { argBytes: 28, handler: (/** @type {number[]} */ args)=>{
            clear(args[5]);
            clear(args[6]);
            return AVIERR_BADHANDLE;
        } },
        /** HRESULT AVIStreamReadFormat(PAVISTREAM pavi, LONG lPos, LPVOID lpFormat, LONG *lpcbFormat) */
        AVIStreamReadFormat: { argBytes: 16, handler: ()=>AVIERR_BADHANDLE },

        /**
         * LONG AVIStreamStart(PAVISTREAM pavi), LONG AVIStreamLength(PAVISTREAM pavi)
         *
         * -1 is the documented answer when the stream cannot say.
         */
        AVIStreamStart: { argBytes: 4, handler: ()=>-1 },
        AVIStreamLength: { argBytes: 4, handler: ()=>-1 },

        /**
         * PGETFRAME AVIStreamGetFrameOpen(PAVISTREAM pavi, LPBITMAPINFOHEADER lpbiWanted),
         * LPVOID AVIStreamGetFrame(PGETFRAME pg, LONG lPos),
         * HRESULT AVIStreamGetFrameClose(PGETFRAME pg)
         *
         * No decompressor to open one with: NULL, and NULL is not a frame object.
         */
        AVIStreamGetFrameOpen: { argBytes: 8, handler: ()=>0 },
        AVIStreamGetFrame: { argBytes: 8, handler: ()=>0 },
        AVIStreamGetFrameClose: { argBytes: 4, handler: ()=>AVIERR_BADHANDLE },

        /**
         * BOOL AVISaveOptions(HWND hwnd, UINT uiFlags, int nStreams,
         *     PAVISTREAM *ppavi, LPAVICOMPRESSOPTIONS *plpOptions)
         *
         * FALSE, as when the person cancels the dialog: there is nothing to choose from.
         */
        AVISaveOptions: { argBytes: 20, handler: ()=>0 },

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
