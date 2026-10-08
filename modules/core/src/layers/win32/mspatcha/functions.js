/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * mspatcha.dll, the Patch API's applying half: a delta patch (`pa19.js`)
 * applied to an old file by name, by handle or in memory, or only tested
 * against one, and a file's patch signature.
 *
 * Every entry point is stdcall. The calls by name and by handle answer BOOL
 * and leave their result in the last error even when they succeed, as
 * Windows does; the calls on buffers leave the last error alone when they
 * succeed. A progress callback is told the start and the end of a decode,
 * and stops it by answering FALSE.
 */

import { APPLY_OPTION, PATCH_ERROR, PATCH_OPTION, SIGNATURE_LENGTH, applyPatch, patchSignature,
    readPatchHeader } from './pa19.js';
import { createMd5 } from '../crypto/digest.js';
import { encodeAnsi } from '../kernel32/locale.js';

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_CALL_NOT_IMPLEMENTED = 120;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_CANCELLED = 1223;

const INVALID_HANDLE_VALUE = 0xffffffff;

/** The longest name read from the program: a `\\?\` path's. */
const MAX_NAME = 32767;

/** PATCH_IGNORE_RANGE's size, and PATCH_RETAIN_RANGE's. */
const IGNORE_RANGE_SIZE = 8;
const RETAIN_RANGE_SIZE = 12;

/** Seconds from 1601, where FILETIME counts from, to 1970. */
const EPOCH_1970 = 11644473600n;

/**
 * @typedef {Object} OpenFile  A kernel32 file handle's object.
 * @property {string} path
 * @property {any} node
 * @property {number} position
 */

/**
 * @typedef {Object} MspatchaHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(code: number) => void} setLastError
 * @property {(thread: any, code: number) => void} [setLastErrorFor]
 *           The last error of the thread a call answers, once it has awaited.
 * @property {any} files  The volume, as `vfs.js` speaks it.
 * @property {{ file: (handle: number) => OpenFile | null }} handles  kernel32's file handles.
 * @property {(bytes: number) => number} virtualAlloc
 *           Memory the program frees with VirtualFree; 0 when there is none.
 * @property {(entry: number, args: number[], thread?: any) => number | Promise<number>} call
 * @property {() => any} callerThread
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * @param {string} path
 */
const parentOf = path=>{
    const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
    return cut <= 0 ? '.' : path.slice(0, cut);
};

/**
 * @param {MspatchaHost} host
 */
export function createMspatchaFunctions(host){
    const { files } = host;

    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>host.writeMemory(address >>> 0,
        new Uint8Array(Uint32Array.of(value >>> 0).buffer));

    /**
     * Records a call's result as its thread's last error and answers the
     * BOOL that goes with it. A call that awaited has let the processor go,
     * so the thread is the one it was made on, not whichever is running.
     *
     * @param {any} thread @param {number} code
     */
    const answer = (thread, code)=>{
        if (host.setLastErrorFor)
        {
            host.setLastErrorFor(thread, code);
        }
        else
        {
            host.setLastError(code);
        }
        return code === ERROR_SUCCESS ? 1 : 0;
    };

    /** Why a name could not be opened, as CreateFile would say it. @param {string} path */
    const missing = path=>{
        const parent = files.stat(parentOf(path));
        return parent?.exists && parent.isDirectory ? ERROR_FILE_NOT_FOUND : ERROR_PATH_NOT_FOUND;
    };

    /**
     * A file's bytes by name, or the error opening it gives.
     *
     * @param {string} path
     * @returns {Promise<{ bytes: Uint8Array } | { error: number }>}
     */
    const load = async path=>{
        const entry = files.stat(path);
        if (!entry?.exists || entry.isDirectory)
        {
            return { error: entry?.isDirectory ? ERROR_ACCESS_DENIED : missing(path) };
        }
        const node = files.open(path, { read: true });
        if (!node)
        {
            return { error: ERROR_ACCESS_DENIED };
        }
        try
        {
            return { bytes: await files.read(node, 0, entry.size) };
        }
        finally
        {
            files.close(node);
        }
    };

    /**
     * A file's bytes through a kernel32 handle, read from its start and
     * leaving the handle where it stood.
     *
     * @param {OpenFile} file
     */
    const loadHandle = async file=>await files.read(file.node, 0, files.stat(file.path)?.size ?? 0);

    /** @param {number} handle */
    const fileOf = handle=>(handle >>> 0 === INVALID_HANDLE_VALUE ? null
        : host.handles.file(handle));

    /**
     * Writes a FILETIME for the new file's time, or zero when the patch
     * carries none.
     *
     * @param {number} address @param {number | null | undefined} timestamp
     */
    const writeFileTime = (address, timestamp)=>{
        const ticks = timestamp == null ? 0n : (BigInt(timestamp) + EPOCH_1970) * 10000000n;
        writeU32(address, Number(ticks & 0xffffffffn));
        writeU32(address + 4, Number(ticks >> 32n));
    };

    /**
     * Applies or tests a patch with the program's progress callback told the
     * start and the end of the decode.
     *
     * @param {Uint8Array | null} old @param {Uint8Array} patch @param {number} flags
     * @param {{ headerOnly: boolean, progress?: number, context?: number, thread?: any }} how
     * @returns {Promise<import('./pa19.js').PatchResult>}
     */
    const run = async(old, patch, flags, { headerOnly, progress = 0, context = 0, thread })=>{
        if (headerOnly || progress === 0)
        {
            return applyPatch(old, patch, flags, { headerOnly });
        }
        const tested = applyPatch(old, patch, flags, { headerOnly: true });
        if (tested.code !== 0)
        {
            return tested;
        }
        const size = tested.size ?? 0;
        if (!(await host.call(progress, [context, 0, size], thread)))
        {
            return { code: ERROR_CANCELLED, size, timestamp: tested.timestamp };
        }
        const result = applyPatch(old, patch, flags);
        if (result.code === 0 && !(await host.call(progress, [context, size, size], thread)))
        {
            return { code: ERROR_CANCELLED, size, timestamp: result.timestamp };
        }
        return result;
    };

    /** @param {string} api @param {import('./pa19.js').PatchResult} result */
    const report = (api, result)=>{
        if (result.code === PATCH_ERROR.DECODE_FAILURE)
        {
            host.divergence?.(api, result.reason ?? 'the patch could not be decoded');
        }
    };

    /**
     * The calls by name: open the patch, the old file and the new file as
     * CreateFile would, apply, and leave no new file behind a failure.
     *
     * @param {string} api @param {(address: number) => string} readName
     * @param {number[]} args  The patch, old and new names, the flags, the progress
     *        callback and its context.
     * @param {boolean} test  TestApplyPatchToFile: the header only, and no new file.
     */
    const byName = async(api, readName, args, test)=>{
        const [patchName, oldName, newName, flags, progress, context] = args;
        const thread = host.callerThread();
        const patch = await load(readName(patchName));
        if ('error' in patch)
        {
            return answer(thread, patch.error);
        }
        let old = null;
        if (oldName !== 0)
        {
            const loaded = await load(readName(oldName));
            if ('error' in loaded)
            {
                return answer(thread, loaded.error);
            }
            old = loaded.bytes;
        }
        const writes = !test && (flags & APPLY_OPTION.TEST_ONLY) === 0;
        const target = writes ? readName(newName) : '';
        const node = writes ? files.open(target, { write: true, create: true, truncate: true })
            : null;
        if (writes && !node)
        {
            return answer(thread, files.stat(parentOf(target))?.isDirectory ? ERROR_ACCESS_DENIED
                : ERROR_PATH_NOT_FOUND);
        }
        const result = await run(old, patch.bytes, flags,
            { headerOnly: test, progress, context, thread });
        report(api, result);
        if (node)
        {
            if (result.code === 0 && result.bytes)
            {
                files.write(node, 0, result.bytes);
            }
            files.close(node);
            if (result.code !== 0)
            {
                files.remove(target);
            }
            else if (result.timestamp != null)
            {
                files.setModified?.(target, result.timestamp * 1000);
            }
        }
        return answer(thread, result.code);
    };

    /**
     * The calls by handle: the new file is cut to nothing first, written
     * from its start, and left positioned at its end.
     *
     * @param {string} api
     * @param {number[]} args  The patch, old and new handles, the flags, the
     *        progress callback and its context.
     * @param {boolean} test
     */
    const byHandles = async(api, args, test)=>{
        const [patchHandle, oldHandle, newHandle, flags, progress, context] = args;
        const thread = host.callerThread();
        const writes = !test && (flags & APPLY_OPTION.TEST_ONLY) === 0;
        const target = writes ? fileOf(newHandle) : null;
        if (writes && !target)
        {
            return answer(thread, ERROR_INVALID_HANDLE);
        }
        if (target)
        {
            files.truncate(target.node, 0);
            target.position = 0;
        }
        const patchFile = fileOf(patchHandle);
        const oldFile = oldHandle >>> 0 === INVALID_HANDLE_VALUE ? null : fileOf(oldHandle);
        if (!patchFile || (oldHandle >>> 0 !== INVALID_HANDLE_VALUE && !oldFile))
        {
            return answer(thread, ERROR_INVALID_HANDLE);
        }
        const patch = await loadHandle(patchFile);
        const old = oldFile ? await loadHandle(oldFile) : null;
        const result = await run(old, patch, flags,
            { headerOnly: test, progress, context, thread });
        report(api, result);
        if (target && result.code === 0 && result.bytes)
        {
            files.write(target.node, 0, result.bytes);
            target.position = result.bytes.length;
            if (result.timestamp != null)
            {
                files.setModified?.(target.path, result.timestamp * 1000);
            }
        }
        return answer(thread, result.code);
    };

    /**
     * The ranges a signature is taken without, from the program's arrays.
     *
     * @param {number} ignoreCount @param {number} ignoreArray
     * @param {number} retainCount @param {number} retainArray
     */
    const rangesOf = (ignoreCount, ignoreArray, retainCount, retainArray)=>{
        const ignore = [];
        for (let i = 0; i < ignoreCount; i++)
        {
            const view = new DataView(host.readMemory(ignoreArray + i * IGNORE_RANGE_SIZE,
                IGNORE_RANGE_SIZE).slice().buffer);
            ignore.push({ offset: view.getUint32(0, true), length: view.getUint32(4, true) });
        }
        const retain = [];
        for (let i = 0; i < retainCount; i++)
        {
            const view = new DataView(host.readMemory(retainArray + i * RETAIN_RANGE_SIZE,
                RETAIN_RANGE_SIZE).slice().buffer);
            retain.push({ offset: view.getUint32(0, true), length: view.getUint32(4, true) });
        }
        return { ignore, retain };
    };

    /**
     * Answers a signature request for bytes in hand.
     *
     * @param {string} api @param {Uint8Array} bytes
     * @param {number[]} args  The flags, option data, ranges, and the buffer and its size.
     * @param {boolean} wide  The buffer takes UTF-16.
     * @param {any} thread  Whose call this answers.
     */
    const sign = (api, bytes, args, wide, thread)=>{
        const [flags, , ignoreCount, ignoreArray, retainCount, retainArray, size, buffer] = args;
        const { ignore, retain } = rangesOf(ignoreCount >>> 0, ignoreArray >>> 0,
            retainCount >>> 0, retainArray >>> 0);
        const signature = patchSignature(bytes, flags >>> 0, ignore, retain, createMd5);
        if (signature === null)
        {
            host.divergence?.(api, 'the signature of a normalised 32-bit PE image');
            return answer(thread, ERROR_CALL_NOT_IMPLEMENTED);
        }
        const need = (flags & PATCH_OPTION.SIGNATURE_MD5) !== 0 ? SIGNATURE_LENGTH.md5
            : SIGNATURE_LENGTH.crc;
        if ((size >>> 0) < need)
        {
            return answer(thread, ERROR_INSUFFICIENT_BUFFER);
        }
        const text = `${signature}\0`;
        host.writeMemory(buffer >>> 0, wide
            ? new Uint8Array(Uint16Array.from(text, c=>c.charCodeAt(0)).buffer)
            : encodeAnsi(text));
        return 1;
    };

    /**
     * GetFilePatchSignatureA/W: the same, of a file by name.
     *
     * @param {string} api @param {(address: number) => string} readName
     * @param {number[]} args @param {boolean} wide
     */
    const signByName = async(api, readName, [name, ...rest], wide)=>{
        const thread = host.callerThread();
        const loaded = await load(readName(name));
        if ('error' in loaded)
        {
            return answer(thread, loaded.error);
        }
        return sign(api, loaded.bytes, rest, wide, thread);
    };

    /** @param {number} address */
    const ansi = address=>host.readCString(address >>> 0, MAX_NAME);
    /** @param {number} address */
    const wide = address=>host.readWideString(address >>> 0, MAX_NAME);

    /**
     * ApplyPatchToFileByBuffers and its test: the patch and the old file in
     * the program's memory, the new file into a buffer it gave or one
     * VirtualAlloc makes for it to free.
     *
     * @param {string} api @param {number[]} args @param {boolean} test
     */
    const byBuffers = async(api, args, test)=>{
        const [patchAt, patchSize, oldAt, oldSize, newBufferAt, newBufferSize, newSizeAt,
            newTimeAt, flags, progress, context] = args;
        const thread = host.callerThread();
        /** @param {number} code */
        const fail = code=>answer(thread, code);
        const writes = !test && (flags & APPLY_OPTION.TEST_ONLY) === 0;
        if (writes && newBufferAt === 0)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const patch = host.readMemory(patchAt >>> 0, patchSize >>> 0).slice();
        const old = oldAt === 0 ? null : host.readMemory(oldAt >>> 0, oldSize >>> 0).slice();
        const given = newBufferAt === 0 ? 0
            : new DataView(host.readMemory(newBufferAt >>> 0, 4).slice().buffer).getUint32(0, true);
        // The new size is told, and a buffer too small for it refused, as
        // soon as the header is read: before the old file is looked for.
        let header = null;
        try
        {
            header = readPatchHeader(patch);
        }
        catch (e){
            void e;
        }
        if (header && newSizeAt !== 0)
        {
            writeU32(newSizeAt, header.newSize);
        }
        if (header && given !== 0 && (newBufferSize >>> 0) < header.newSize)
        {
            return fail(ERROR_INSUFFICIENT_BUFFER);
        }
        const result = await run(old, patch, flags,
            { headerOnly: test, progress, context, thread });
        report(api, result);
        if (result.code !== 0)
        {
            return fail(result.code);
        }
        if (writes && result.bytes)
        {
            let into = given;
            if (into === 0)
            {
                into = host.virtualAlloc(Math.max(1, result.bytes.length)) >>> 0;
                if (into === 0)
                {
                    return fail(ERROR_NOT_ENOUGH_MEMORY);
                }
                writeU32(newBufferAt, into);
            }
            host.writeMemory(into, result.bytes);
        }
        if (newTimeAt !== 0)
        {
            writeFileTime(newTimeAt, result.timestamp);
        }
        return 1;
    };

    return {
        /** BOOL ApplyPatchToFileA(LPCSTR, LPCSTR, LPCSTR, ULONG) */
        ApplyPatchToFileA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>byName('ApplyPatchToFileA', ansi, [...args, 0, 0], false),
        },
        /** BOOL ApplyPatchToFileW(LPCWSTR, LPCWSTR, LPCWSTR, ULONG) */
        ApplyPatchToFileW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>byName('ApplyPatchToFileW', wide, [...args, 0, 0], false),
        },
        /**
         * BOOL ApplyPatchToFileExA(LPCSTR, LPCSTR, LPCSTR, ULONG,
         *     PPATCH_PROGRESS_CALLBACK, PVOID)
         */
        ApplyPatchToFileExA: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: args=>byName('ApplyPatchToFileExA', ansi, args, false),
        },
        /** BOOL ApplyPatchToFileExW(...) */
        ApplyPatchToFileExW: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: args=>byName('ApplyPatchToFileExW', wide, args, false),
        },
        /** BOOL ApplyPatchToFileByHandles(HANDLE, HANDLE, HANDLE, ULONG) */
        ApplyPatchToFileByHandles: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>byHandles('ApplyPatchToFileByHandles', [...args, 0, 0], false),
        },
        /**
         * BOOL ApplyPatchToFileByHandlesEx(HANDLE, HANDLE, HANDLE, ULONG,
         *     PPATCH_PROGRESS_CALLBACK, PVOID)
         */
        ApplyPatchToFileByHandlesEx: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: args=>byHandles('ApplyPatchToFileByHandlesEx', args, false),
        },
        /**
         * BOOL ApplyPatchToFileByBuffers(PBYTE, ULONG, PBYTE, ULONG, PBYTE *, ULONG,
         *     ULONG *, FILETIME *, ULONG, PPATCH_PROGRESS_CALLBACK, PVOID)
         */
        ApplyPatchToFileByBuffers: {
            argBytes: 44,
            /** @param {number[]} args */
            handler: args=>byBuffers('ApplyPatchToFileByBuffers', args, false),
        },
        /** BOOL TestApplyPatchToFileA(LPCSTR, LPCSTR, ULONG) */
        TestApplyPatchToFileA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([patch, old, flags])=>
                byName('TestApplyPatchToFileA', ansi, [patch, old, 0, flags, 0, 0], true),
        },
        /** BOOL TestApplyPatchToFileW(LPCWSTR, LPCWSTR, ULONG) */
        TestApplyPatchToFileW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([patch, old, flags])=>
                byName('TestApplyPatchToFileW', wide, [patch, old, 0, flags, 0, 0], true),
        },
        /** BOOL TestApplyPatchToFileByHandles(HANDLE, HANDLE, ULONG) */
        TestApplyPatchToFileByHandles: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([patch, old, flags])=>byHandles('TestApplyPatchToFileByHandles',
                [patch, old, INVALID_HANDLE_VALUE, flags, 0, 0], true),
        },
        /** BOOL TestApplyPatchToFileByBuffers(PBYTE, ULONG, PBYTE, ULONG, ULONG *, ULONG) */
        TestApplyPatchToFileByBuffers: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([patch, patchSize, old, oldSize, newSize, flags])=>
                byBuffers('TestApplyPatchToFileByBuffers',
                    [patch, patchSize, old, oldSize, 0, 0, newSize, 0, flags, 0, 0], true),
        },
        /**
         * BOOL GetFilePatchSignatureA(LPCSTR, ULONG, PVOID, ULONG, PPATCH_IGNORE_RANGE,
         *     ULONG, PPATCH_RETAIN_RANGE, ULONG, LPSTR)
         */
        GetFilePatchSignatureA: {
            argBytes: 36,
            /** @param {number[]} args */
            handler: args=>signByName('GetFilePatchSignatureA', ansi, args, false),
        },
        /** BOOL GetFilePatchSignatureW(LPCWSTR, ..., LPWSTR) */
        GetFilePatchSignatureW: {
            argBytes: 36,
            /** @param {number[]} args */
            handler: args=>signByName('GetFilePatchSignatureW', wide, args, true),
        },
        /** BOOL GetFilePatchSignatureByHandle(HANDLE, ULONG, PVOID, ..., LPSTR) */
        GetFilePatchSignatureByHandle: {
            argBytes: 36,
            /** @param {number[]} args */
            handler: async([handle, ...rest])=>{
                const thread = host.callerThread();
                const file = fileOf(handle);
                if (!file)
                {
                    return answer(thread, ERROR_INVALID_HANDLE);
                }
                return sign('GetFilePatchSignatureByHandle', await loadHandle(file), rest, false,
                    thread);
            },
        },
        /** BOOL GetFilePatchSignatureByBuffer(PBYTE, ULONG, ULONG, PVOID, ..., LPSTR) */
        GetFilePatchSignatureByBuffer: {
            argBytes: 40,
            /** @param {number[]} args */
            handler: ([address, size, ...rest])=>sign('GetFilePatchSignatureByBuffer',
                host.readMemory(address >>> 0, size >>> 0).slice(), rest, false,
                host.callerThread()),
        },
        /**
         * INT NormalizeFileForPatchSignature(PVOID, ULONG, ULONG, PATCH_OPTION_DATA *,
         *     ULONG, ULONG, ULONG, PPATCH_IGNORE_RANGE, ULONG, PPATCH_RETAIN_RANGE)
         *
         * What it answers for each outcome is not known here, so it answers
         * the failure every outcome but success shares.
         */
        NormalizeFileForPatchSignature: {
            argBytes: 40,
            handler: ()=>{
                host.divergence?.('NormalizeFileForPatchSignature', 'not implemented');
                host.setLastError(ERROR_CALL_NOT_IMPLEMENTED);
                return 0;
            },
        },
    };
}
