/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * msvfw32 — Video for Windows: the installable-compressor manager (ICM,
 * `icm.js`) with the codecs Windows installs (`codecs.js`), DrawDib, which
 * draws a frame - decompressed first when it needs to be - on a DC, and the
 * MCIWnd window class that plays a clip through MCI.
 *
 * There is no MCI video device, so an MCIWnd is never made: creation answers
 * NULL, the documented failure, which a program that plays a film through
 * MCIWnd takes as "no film to play".
 */

import { createIcm } from './icm.js';
import { BI_RGB, BI_BITFIELDS, HEADER_SIZE, ICM_DECOMPRESS, ICM_DECOMPRESS_BEGIN, ICM_COMPRESS,
    readHeader, strideOf, ICERR_OK } from './codecs.js';
import { ICMODE_DECOMPRESS } from './icm.js';
import { wholeAddress } from '../common/pointers.js';

export { ICINFO_SIZE } from './codecs.js';

/** ICDECOMPRESS: dwFlags, lpbiInput, lpInput, lpbiOutput, lpOutput, ckid. */
const ICDECOMPRESS_SIZE = 24;
/** ICCOMPRESS's size. */
const ICCOMPRESS_SIZE = 48;
const DIB_RGB_COLORS = 0;
const SRCCOPY = 0x00cc0020;
/** The first HDRAWDIB handed out. */
const FIRST_DRAWDIB = 0x3000;

/**
 * @typedef {import('./icm.js').IcmHost & {
 *     stretchDIBits?: (args: number[]) => number,
 * }} MsvfwHost
 */

/**
 * @param {MsvfwHost} host
 */
export function createMsvfwFunctions(host){
    const icm = createIcm(host);
    /** @type {Map<number, { hic: number, format: number, bits: number, bitsSize: number }>} */
    const drawdibs = new Map();
    let nextDrawdib = FIRST_DRAWDIB;

    /**
     * Decompresses one frame into a 32-bit DIB of the frame's size, which
     * DrawDib keeps and draws from: the codec located for the stream once,
     * the buffer made once for its size.
     *
     * @param {{ hic: number, format: number, bits: number, bitsSize: number }} state
     * @param {number} info @param {number} data
     * @param {import('./codecs.js').Header} header
     */
    const decompressFor = async(state, info, data, header)=>{
        const size = strideOf(header.width, 32) * Math.abs(header.height);
        if (!state.format)
        {
            state.format = host.allocate(HEADER_SIZE);
        }
        const bytes = new Uint8Array(HEADER_SIZE);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, HEADER_SIZE, true);
        view.setInt32(4, header.width, true);
        view.setInt32(8, Math.abs(header.height), true);
        view.setUint16(12, 1, true);
        view.setUint16(14, 32, true);
        view.setUint32(20, size, true);
        host.writeMemory(state.format, bytes);
        if (state.bitsSize < size)
        {
            if (state.bits)
            {
                host.free(state.bits);
            }
            state.bits = host.allocate(size);
            state.bitsSize = size;
        }
        if (!state.hic)
        {
            state.hic = await icm.icLocate(0x63646976, 0, info, state.format, ICMODE_DECOMPRESS);
            if (!state.hic || await icm.send(state.hic, ICM_DECOMPRESS_BEGIN, info,
                state.format) !== ICERR_OK)
            {
                return false;
            }
        }
        const call = host.allocate(ICDECOMPRESS_SIZE);
        const record = new Uint8Array(ICDECOMPRESS_SIZE);
        const fields = new DataView(record.buffer);
        fields.setUint32(4, info >>> 0, true);
        fields.setUint32(8, data >>> 0, true);
        fields.setUint32(12, state.format, true);
        fields.setUint32(16, state.bits, true);
        host.writeMemory(call, record);
        const answer = await icm.send(state.hic, ICM_DECOMPRESS, call, ICDECOMPRESS_SIZE);
        host.free(call);
        return answer === ICERR_OK;
    };

    return {
        /** BOOL ICInfo(DWORD fccType, DWORD fccHandler, ICINFO *lpicinfo) */
        ICInfo: { argBytes: 12, handler: (/** @type {number[]} */ [type, handler, info])=>
            icm.icInfo(type, handler, info) },

        /**
         * BOOL ICInstall(DWORD fccType, DWORD fccHandler, LPARAM lParam, LPSTR szDesc, UINT wFlags)
         */
        ICInstall: { argBytes: 20, handler: (/** @type {number[]} */ [type, handler, param, ,
            flags])=>
            icm.install(type, handler, param, flags) },

        /** BOOL ICRemove(DWORD fccType, DWORD fccHandler, UINT wFlags) */
        ICRemove: { argBytes: 12, handler: (/** @type {number[]} */ [type, handler])=>
            icm.remove(type, handler) },

        /** HIC ICOpen(DWORD fccType, DWORD fccHandler, UINT wMode) */
        ICOpen: { argBytes: 12, handler: (/** @type {number[]} */ [type, handler, mode])=>
            icm.icOpen(type, handler, mode) },

        /**
         * HIC ICOpenFunction(DWORD fccType, DWORD fccHandler, UINT wMode, FARPROC lpfnHandler):
         * the function installed for the pair, then opened.
         */
        ICOpenFunction: { argBytes: 16, handler: (/** @type {number[]} */ [type, handler, mode,
            proc])=>{
            icm.install(type, handler, proc, 1);
            return icm.icOpen(type, handler, mode);
        } },

        /** LRESULT ICClose(HIC hic): ICERR_BADHANDLE for a handle never given out. */
        ICClose: { argBytes: 4, handler: (/** @type {number[]} */ [hic = 0])=>
            Promise.resolve(icm.close(hic)).then(answer=>answer >>> 0) },

        /** LRESULT ICSendMessage(HIC hic, UINT msg, DWORD_PTR dw1, DWORD_PTR dw2) */
        ICSendMessage: { argBytes: 16, handler: (/** @type {number[]} */ [hic, message, first,
            second])=>
            icm.send(hic, message, first, second).then(answer=>answer >>> 0) },

        /** LRESULT ICGetInfo(HIC hic, ICINFO *picinfo, DWORD cb): the bytes written. */
        ICGetInfo: { argBytes: 12, handler: (/** @type {number[]} */ [hic, info, size])=>
            icm.icGetInfo(hic, info, size) },

        /**
         * HIC ICLocate(DWORD fccType, DWORD fccHandler, BITMAPINFOHEADER *in, BITMAPINFOHEADER
         *     *out, WORD wFlags)
         */
        ICLocate: { argBytes: 20, handler: (/** @type {number[]} */ [type, handler, input, output,
            mode])=>
            icm.icLocate(type, handler, input, output, mode & 0xffff) },

        /**
         * HIC ICGetDisplayFormat(HIC hic, BITMAPINFOHEADER *in, BITMAPINFOHEADER *out, int
         *     BitDepth, int dx, int dy)
         */
        ICGetDisplayFormat: { argBytes: 24,
            handler: (/** @type {number[]} */ [hic, input, output, depth, width, height])=>
                icm.icGetDisplayFormat(hic, input, output, depth, width, height) },

        /**
         * DWORD ICDecompress(HIC hic, DWORD dwFlags, BITMAPINFOHEADER *lpbiFormat, LPVOID lpData,
         *     BITMAPINFOHEADER *lpbi, LPVOID lpBits): ICM_DECOMPRESS with its arguments as an
         * ICDECOMPRESS. A VFWAPIV function, cdecl.
         */
        ICDecompress: { convention: 'cdecl', argBytes: 24,
            handler: async(/** @type {number[]} */ [hic, flags, format, data, out, bits])=>{
                const call = host.allocate(ICDECOMPRESS_SIZE);
                const record = new Uint8Array(ICDECOMPRESS_SIZE);
                const fields = new DataView(record.buffer);
                [flags, format, data, out, bits].forEach((value, i)=>fields.setUint32(i * 4,
                    value >>> 0, true));
                host.writeMemory(call, record);
                const answer = await icm.send(hic, ICM_DECOMPRESS, call, ICDECOMPRESS_SIZE);
                host.free(call);
                return answer >>> 0;
            } },

        /**
         * DWORD ICCompress(HIC hic, DWORD dwFlags, BITMAPINFOHEADER *lpbiOutput, LPVOID lpData,
         *     BITMAPINFOHEADER *lpbiInput, LPVOID lpBits, DWORD *lpckid, DWORD *lpdwFlags,
         *     LONG lFrameNum, DWORD dwFrameSize, DWORD dwQuality, BITMAPINFOHEADER *lpbiPrev,
         *     LPVOID lpPrev): ICM_COMPRESS with its arguments as an ICCOMPRESS. cdecl.
         */
        ICCompress: { convention: 'cdecl', argBytes: 52,
            handler: async(/** @type {number[]} */ args)=>{
                const call = host.allocate(ICCOMPRESS_SIZE);
                const record = new Uint8Array(ICCOMPRESS_SIZE);
                const fields = new DataView(record.buffer);
                args.slice(1, 13).forEach((value, i)=>fields.setUint32(i * 4, value >>> 0, true));
                host.writeMemory(call, record);
                const answer = await icm.send(args[0], ICM_COMPRESS, call, ICCOMPRESS_SIZE);
                host.free(call);
                return answer >>> 0;
            } },

        /** BOOL ICSeqCompressFrameStart(PCOMPVARS pc, LPBITMAPINFO lpbiIn) */
        ICSeqCompressFrameStart: { argBytes: 8, handler: (/** @type {number[]} */ [pc, info])=>
            icm.seqStart(pc, info) },

        /**
         * LPVOID ICSeqCompressFrame(PCOMPVARS pc, UINT uiFlags, LPVOID lpBits, BOOL *pfKey, LONG
         *     *plSize)
         */
        ICSeqCompressFrame: { returns: 'pointer', argBytes: 20, handler: (/** @type {number[]} */ [pc, , bits, key,
            size])=>
            icm.seqFrame(pc, bits, key, size) },

        /** void ICSeqCompressFrameEnd(PCOMPVARS pc) */
        ICSeqCompressFrameEnd: { argBytes: 4, handler: (/** @type {number[]} */ [pc])=>
            icm.seqEnd(pc).then(()=>0) },

        /** void ICCompressorFree(PCOMPVARS pc) */
        ICCompressorFree: { argBytes: 4, handler: (/** @type {number[]} */ [pc])=>
            icm.compressorFree(pc).then(()=>0) },

        /** HDRAWDIB DrawDibOpen(void) */
        DrawDibOpen: { argBytes: 0, handler: ()=>{
            const handle = nextDrawdib;
            nextDrawdib += 4;
            drawdibs.set(handle, { hic: 0, format: 0, bits: 0, bitsSize: 0 });
            return handle;
        } },

        /** BOOL DrawDibClose(HDRAWDIB hdd): closes its codec and frees its frame. */
        DrawDibClose: { argBytes: 4, handler: async(/** @type {number[]} */ [handle])=>{
            const state = drawdibs.get(handle >>> 0);
            if (!state)
            {
                return 0;
            }
            drawdibs.delete(handle >>> 0);
            if (state.hic)
            {
                await icm.close(state.hic);
            }
            if (state.format)
            {
                host.free(state.format);
            }
            if (state.bits)
            {
                host.free(state.bits);
            }
            return 1;
        } },

        /**
         * BOOL DrawDibDraw(HDRAWDIB hdd, HDC hdc, int xDst, int yDst, int dxDst, int dyDst,
         *     BITMAPINFOHEADER *lpbi, LPVOID lpBits, int xSrc, int ySrc, int dxSrc, int dySrc,
         *     UINT wFlags)
         *
         * A frame of a positive size is drawn by StretchDIBits, decompressed
         * through the ICM first when it is compressed; a destination size of -1
         * is the source's. A negative width or height, or none, is refused: the
         * frame's rows run from the bottom, as a DIB's do.
         */
        DrawDibDraw: { argBytes: 52, handler: async(/** @type {number[]} */ args)=>{
            const [handle, dc, xDst, yDst, dxDst, dyDst, info, data, xSrc, ySrc, dxSrc,
                dySrc] = args;
            const state = drawdibs.get(handle >>> 0);
            const header = readHeader(host, info);
            if (!state || !header || header.width <= 0 || header.height <= 0 || !host.stretchDIBits)
            {
                return 0;
            }
            let format = wholeAddress(info);
            let bits = wholeAddress(data);
            if (header.compression !== BI_RGB && header.compression !== BI_BITFIELDS)
            {
                if (!await decompressFor(state, info, data, header))
                {
                    return 0;
                }
                format = state.format;
                bits = state.bits;
            }
            const width = (dxDst | 0) < 0 ? dxSrc | 0 : dxDst | 0;
            const height = (dyDst | 0) < 0 ? dySrc | 0 : dyDst | 0;
            const drawn = host.stretchDIBits([dc, xDst, yDst, width, height, xSrc, ySrc, dxSrc,
                dySrc,
                bits, format, DIB_RGB_COLORS, SRCCOPY]);
            return drawn !== 0 ? 1 : 0;
        } },

        /** BOOL DrawDibBegin(...): the format is read at each DrawDibDraw; nothing to set up. */
        DrawDibBegin: { argBytes: 32, handler: (/** @type {number[]} */ [handle])=>
            (drawdibs.has(handle >>> 0) ? 1 : 0) },
        /** BOOL DrawDibEnd(HDRAWDIB hdd) */
        DrawDibEnd: { argBytes: 4, handler: (/** @type {number[]} */ [handle])=>
            (drawdibs.has(handle >>> 0) ? 1 : 0) },
        /** BOOL DrawDibStart(HDRAWDIB hdd, DWORD rate) */
        DrawDibStart: { argBytes: 8, handler: (/** @type {number[]} */ [handle])=>
            (drawdibs.has(handle >>> 0) ? 1 : 0) },
        /** BOOL DrawDibStop(HDRAWDIB hdd) */
        DrawDibStop: { argBytes: 4, handler: (/** @type {number[]} */ [handle])=>
            (drawdibs.has(handle >>> 0) ? 1 : 0) },
        /**
         * UINT DrawDibRealize(HDRAWDIB hdd, HDC hdc, BOOL fBackground): the
         * colours that changed in the system palette - none, the display is
         * true colour.
         */
        DrawDibRealize: { argBytes: 12, handler: ()=>0 },
        /** BOOL DrawDibSetPalette(HDRAWDIB hdd, HPALETTE hpal): a true-colour display takes any. */
        DrawDibSetPalette: { argBytes: 8, handler: (/** @type {number[]} */ [handle])=>
            (drawdibs.has(handle >>> 0) ? 1 : 0) },
        /** HPALETTE DrawDibGetPalette(HDRAWDIB hdd): none, on a true-colour display. */
        DrawDibGetPalette: { argBytes: 4, handler: ()=>0 },

        /**
         * HWND MCIWndCreateA(HWND hwndParent, HINSTANCE hInstance, DWORD dwStyle,
         *                    LPCSTR szFile)
         *
         * Zero when the window cannot be made; there is no MCI video device
         * to open the clip on.
         */
        MCIWndCreateA: { argBytes: 16, handler: ()=>0 },
        MCIWndCreateW: { argBytes: 16, handler: ()=>0 },

        /**
         * BOOL MCIWndRegisterClass(void)
         *
         * The class is not provided, and saying so keeps a caller from making
         * a window of a class that does not exist.
         */
        MCIWndRegisterClass: { argBytes: 0, handler: ()=>0 },
    };
}
