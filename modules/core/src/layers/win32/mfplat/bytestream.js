/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * IMFByteStream over a file: what MFCreateFile and MFCreateTempFile hand
 * out, and what a source reader reads a film from.
 *
 * The file is kernel32's, opened and read through its own calls, so a
 * sharing violation, a missing file or a full disk answers as it does for
 * CreateFile, as an HRESULT. The stream keeps its own position, as Windows'
 * does: each read and write goes to that position and moves it, and a
 * position past the end is kept, reads there answering nothing.
 *
 * The stream answers IMFAttributes beside IMFByteStream with the file's name
 * (MF_BYTESTREAM_ORIGIN_NAME) and its last write time as a FILETIME
 * (MF_BYTESTREAM_LAST_MODIFIED_TIME), and IMFGetService, which offers no
 * service (Wine's test_file_stream holds these as Windows answers).
 * BeginRead and BeginWrite need a work queue to call the program back from,
 * which this build does not have; they refuse, said once.
 */

import { E_INVALIDARG, E_NOTIMPL, E_POINTER, S_OK, drive } from './kit.js';
import { IID_IMFATTRIBUTES, TYPE } from './attributes.js';

export const IID_IMFBYTESTREAM = '{AD4C1B00-4BF7-422F-9175-756693D9130D}';
export const IID_IMFGETSERVICE = '{FA993888-4383-415A-A930-DD472A8CF6F7}';
const MF_BYTESTREAM_ORIGIN_NAME = '{FC358288-3CB6-460C-A424-B6681260375A}';
const MF_BYTESTREAM_LAST_MODIFIED_TIME = '{FC35828B-3CB6-460C-A424-B6681260375A}';
const MF_E_UNSUPPORTED_SERVICE = 0xc00d36ba | 0;
const E_ACCESSDENIED = 0x80070005 | 0;

/** MFBYTESTREAM_* capabilities. */
const READABLE = 0x1;
const WRITABLE = 0x2;
const SEEKABLE = 0x4;

/** MF_FILE_ACCESSMODE. */
export const ACCESS = Object.freeze({ READ: 1, WRITE: 2, READWRITE: 3 });
/** MF_FILE_OPENMODE, as CreateFile's dispositions. */
// OPEN_EXISTING, CREATE_NEW, TRUNCATE_EXISTING, OPEN_ALWAYS, CREATE_ALWAYS.
const DISPOSITION = [3, 1, 5, 4, 2];
const APPEND_IF_EXIST = 3;
/** MF_FILE_FLAGS. */
const ALLOW_WRITE_SHARING = 0x1;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const FILE_SHARE_READ = 1;
const FILE_SHARE_WRITE = 2;
const FILE_SHARE_DELETE = 4;
const FILE_FLAG_DELETE_ON_CLOSE = 0x04000000;
/** MFBYTESTREAM_SEEK_ORIGIN. */
const SEEK_CURRENT = 1;

/**
 * The file calls a stream is made of, kernel32's own.
 *
 * @typedef {Object} FileCalls
 * @property {(path: string, access: number, share: number, disposition: number,
 *     flags: number) => Promise<{ handle: number } | { error: number }>} open
 *     CreateFileW, or the Win32 error it failed with.
 * @property {(handle: number, position: bigint, buffer: number, length: number,
 *     write: boolean) => Promise<{ done: number } | { error: number }>} transfer
 *     ReadFile or WriteFile at a position, into or out of guest memory.
 * @property {(handle: number) => Promise<bigint>} size
 * @property {(handle: number, size: bigint) => Promise<boolean>} setSize
 * @property {(handle: number) => Promise<boolean>} flush
 * @property {(handle: number) => Promise<Uint8Array>} modified  the last write's FILETIME
 * @property {(handle: number) => void} close
 */

/** @param {number} error @returns {number} HRESULT_FROM_WIN32 */
const fromWin32 = error=>(error === 0 ? S_OK : (0x80070000 | (error & 0xffff)) | 0);

/**
 * @param {import('./kit.js').MfKit} kit
 * @param {import('./kit.js').MfHost} host
 * @param {ReturnType<typeof import('./attributes.js').createAttributes>} attributes
 * @param {FileCalls | undefined} files
 */
export function createByteStreams(kit, host, attributes, files){
    const { putU32s, putU64 } = kit;

    /** @param {any} object @returns {any} */
    const stateOf = object=>object.state;

    /** @param {number} out @param {bigint} value */
    const writeQword = (out, value)=>{
        if ((out >>> 0) === 0)
        {
            return E_INVALIDARG;
        }
        putU64(out, value);
        return S_OK;
    };

    /**
     * Read or Write at the stream's position, the position moved by what moved.
     *
     * @param {any} object @param {number} buffer @param {number} length @param {number} out
     * @param {boolean} write
     */
    const transfer = (object, buffer, length, out, write)=>{
        const state = stateOf(object);
        if (state.closed)
        {
            return E_ACCESSDENIED;
        }
        if ((buffer >>> 0) === 0 && (length >>> 0) !== 0)
        {
            return E_INVALIDARG;
        }
        return drive((function* (){
            const result = yield /** @type {FileCalls} */ (files).transfer(state.handle,
                state.position, buffer >>> 0, length >>> 0, write);
            if ('error' in result)
            {
                return fromWin32(result.error);
            }
            state.position += BigInt(result.done);
            if ((out >>> 0) !== 0)
            {
                putU32s(out, [result.done]);
            }
            return S_OK;
        })());
    };

    /** @param {string} api */
    const noQueue = api=>()=>{
        kit.sayOnce(`IMFByteStream::${api}`,
            'no work queue calls the program back: refused with E_NOTIMPL');
        return E_NOTIMPL;
    };

    /** @type {import('../ole32/objects.js').ComMethod[]} */
    const streamMethods = [
        { name: 'GetCapabilities', argBytes: 8, invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const { access } = stateOf(object);
            putU32s(out, [SEEKABLE | ((access & ACCESS.READ) !== 0 ? READABLE : 0)
                    | ((access & ACCESS.WRITE) !== 0 ? WRITABLE : 0)]);
            return S_OK;
        } },
        { name: 'GetLength', argBytes: 8, invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            return drive((function* (){
                return writeQword(out,
                    yield /** @type {FileCalls} */ (files).size(stateOf(object).handle));
            })());
        } },
        { name: 'SetLength', argBytes: 12, invoke: (object, [low, high])=>drive((function* (){
            const ok = yield /** @type {FileCalls} */ (files).setSize(stateOf(object).handle,
                kit.wide(low, high));
            return ok ? S_OK : E_ACCESSDENIED;
        })()) },
        { name: 'GetCurrentPosition', argBytes: 8,
            invoke: (object, [out])=>writeQword(out, stateOf(object).position) },
        { name: 'SetCurrentPosition', argBytes: 12, invoke: (object, [low, high])=>{
            stateOf(object).position = kit.wide(low, high);
            return S_OK;
        } },
        { name: 'IsEndOfStream', argBytes: 8, invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const state = stateOf(object);
            return drive((function* (){
                const size = yield /** @type {FileCalls} */ (files).size(state.handle);
                putU32s(out, [state.position >= size ? 1 : 0]);
                return S_OK;
            })());
        } },
        { name: 'Read', argBytes: 16, invoke: (object, [buffer, length, out])=>
            transfer(object, buffer, length, out, false) },
        { name: 'BeginRead', argBytes: 20, invoke: noQueue('BeginRead') },
        { name: 'EndRead', argBytes: 12, invoke: noQueue('EndRead') },
        { name: 'Write', argBytes: 16, invoke: (object, [buffer, length, out])=>
            transfer(object, buffer, length, out, true) },
        { name: 'BeginWrite', argBytes: 20, invoke: noQueue('BeginWrite') },
        { name: 'EndWrite', argBytes: 12, invoke: noQueue('EndWrite') },
        /** HRESULT Seek(MFBYTESTREAM_SEEK_ORIGIN origin, LONGLONG offset, DWORD flags, QWORD *current) */
        { name: 'Seek', argBytes: 24, invoke: (object, [origin, low, high, , out])=>{
            const state = stateOf(object);
            const offset = BigInt.asIntN(64, kit.wide(low, high));
            const position = (origin >>> 0) === SEEK_CURRENT ? state.position + offset : offset;
            if (position < 0n)
            {
                return E_INVALIDARG;
            }
            state.position = position;
            if ((out >>> 0) !== 0)
            {
                putU64(out, position);
            }
            return S_OK;
        } },
        { name: 'Flush', argBytes: 4, invoke: object=>drive((function* (){
            const ok = yield /** @type {FileCalls} */ (files).flush(stateOf(object).handle);
            return ok ? S_OK : E_ACCESSDENIED;
        })()) },
        { name: 'Close', argBytes: 4, invoke: object=>{
            const state = stateOf(object);
            if (!state.closed)
            {
                state.closed = true;
                files?.close(state.handle);
            }
            return S_OK;
        } },
    ];
    const byteStream = { id: IID_IMFBYTESTREAM, methods: streamMethods };

    /** @type {import('../ole32/objects.js').ComInterfaceDescriptor} */
    const getService = {
        id: IID_IMFGETSERVICE,
        methods: /** @type {import('../ole32/objects.js').ComMethod[]} */ ([
            /** HRESULT GetService(REFGUID service, REFIID riid, LPVOID *object) */
            { name: 'GetService', argBytes: 16, invoke: (object, [, , out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                putU32s(out, [0]);
                return MF_E_UNSUPPORTED_SERVICE;
            } },
        ]),
    };

    /**
     * MFCreateFile's work: CreateFile with the access and sharing Media
     * Foundation asks for - a reader shares reading and deleting, and writing
     * too when MF_FILEFLAGS_ALLOW_WRITE_SHARING says so; a writer shares
     * nothing - and
     * a stream over the handle.
     *
     * @param {number} access @param {number} openMode @param {number} flags
     * @param {string} path @param {boolean} [temporary]  deleted when closed
     * @returns {Promise<any | number>} the stream, or a failing HRESULT
     */
    const createFile = async(access, openMode, flags, path, temporary = false)=>{
        if (!files)
        {
            return E_NOTIMPL;
        }
        if ((access & ACCESS.READWRITE) === 0 || openMode >= DISPOSITION.length)
        {
            return E_INVALIDARG;
        }
        // A URL is the source resolver's to read, not a file's name.
        if (/^[a-z][a-z0-9+.-]+:\/\//i.test(path))
        {
            return fromWin32(123); // ERROR_INVALID_NAME
        }
        const share = access === ACCESS.READ
            ? FILE_SHARE_READ | FILE_SHARE_DELETE
                | ((flags & ALLOW_WRITE_SHARING) !== 0 ? FILE_SHARE_WRITE : 0)
            : 0;
        const opened = await files.open(path,
            ((access & ACCESS.READ) !== 0 ? GENERIC_READ : 0)
                | ((access & ACCESS.WRITE) !== 0 ? GENERIC_WRITE : 0),
            share, DISPOSITION[openMode], temporary ? FILE_FLAG_DELETE_ON_CLOSE : 0);
        if ('error' in opened)
        {
            return fromWin32(opened.error);
        }
        const position = openMode === APPEND_IF_EXIST ? await files.size(opened.handle) : 0n;
        const modified = await files.modified(opened.handle);
        const state = { handle: opened.handle, access, position, closed: false,
            items: new Map() };
        state.items.set(MF_BYTESTREAM_ORIGIN_NAME, { vt: TYPE.STRING, value: path });
        state.items.set(MF_BYTESTREAM_LAST_MODIFIED_TIME, { vt: TYPE.BLOB, value: modified });
        return kit.make({
            primary: byteStream,
            extras: [{ descriptor: { id: IID_IMFATTRIBUTES, methods: attributes.methods } },
                { descriptor: getService }],
            state,
            destroy: ()=>{
                attributes.clear(state.items);
                if (!state.closed)
                {
                    state.closed = true;
                    files.close(state.handle);
                }
            },
        });
    };

    return { createFile };
}
