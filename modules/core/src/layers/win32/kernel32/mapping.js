/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { TAKEN } from './named-objects.js';

/**
 * The two things kernel32 lets a program treat as memory instead of as a
 * stream: a file mapping and a pipe.
 *
 * They sit together because both are handle-shaped objects with no bytes of
 * their own.
 *
 * A **file mapping** here is a copy, not a mapping. The bytes are read into
 * guest memory when the view is made and written back when it is closed, so one
 * view behaves exactly like the real thing and two views of one file do not see
 * each other's writes. That is the ceiling, and it is the right trade: the
 * common use -- an archive reader mapping a file to walk its index -- is a
 * single read-only view, and refusing it outright would stop a program that
 * would otherwise work.
 *
 * A **pipe** is a byte queue with two handles onto it. That is all an anonymous
 * pipe is on Windows too, so this one is not a compromise.
 */

/** Codes this surface reports. */
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NOT_ENOUGH_MEMORY = 8;
/** What CreateNamedPipe answers where there are no named pipes, as on Windows 9x. */
const ERROR_CALL_NOT_IMPLEMENTED = 120;
/** What a mapping of an empty file is refused with, as documented. */
const ERROR_FILE_INVALID = 1006;
/** What a read that failed after the caller was parked answers. */
const ERROR_IO_DEVICE = 1117;

/** INVALID_HANDLE_VALUE, which CreateFileMapping takes to mean "no file". */
const INVALID_HANDLE_VALUE = 0xffffffff;

/** A name is at most this long; longer is a pointer that is not a string. */
const MAX_NAME = 260;

/** flProtect values we distinguish. Everything else is read-only. */
const PAGE_READWRITE = 0x04;
const PAGE_WRITECOPY = 0x08;

/** dwDesiredAccess for MapViewOfFile. */
const FILE_MAP_WRITE = 0x0002;
const FILE_MAP_ALL_ACCESS = 0xf001f;

/**
 * @typedef {Object} MappingHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(code: number) => void} setLastError
 * @property {ReturnType<typeof import('./named-objects.js').createNamedObjects>} namedObjects
 *           The table a named mapping shares with a named mutex, event,
 *           semaphore and timer -- Windows keeps one namespace across every
 *           kind of kernel object, not one per kind.
 * @property {(thread: any, code: number) => void} [setLastErrorFor]
 *           The error of a thread that is not the one running: a map that
 *           waited for its bytes answers on somebody else's turn.
 * @property {() => any} [currentThread]
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {{ views: number, waited: number, failed: number }} [metrics]
 *           Counted in place: views mapped, views that waited for their
 *           bytes, views whose bytes never came.
 * @property {(bytes: number) => number} allocate  Guest memory, or 0.
 * @property {(address: number) => void} release
 * @property {{ open: (type: string, object: any) => number,
 *              resolve: (handle: number, type?: string) => any,
 *              close: (handle: number) => any }} handles
 * @property {{ read: (node: any, offset: number, length: number) =>
 *                  Uint8Array | Promise<Uint8Array>,
 *              write: (node: any, offset: number, bytes: Uint8Array) => number,
 *              size?: (node: any) => number,
 *              retain: (node: any) => void,
 *              close: (node: any) => void }} files
 *           A promise when the bytes are not resident yet; the map then
 *           answers when they are, the caller parked meanwhile, as a read is.
 *           The size is what a mapping made without one is as large as.
 *           Every mapping handle and every view holds the file's node with
 *           `retain` and gives it back with `close`, which closes the node
 *           once nothing -- the file's own handle included -- holds it.
 */

/**
 * @param {MappingHost} host
 */
export function createMappingFunctions(host){
    /**
     * Views handed out by MapViewOfFile, by the address the guest holds.
     *
     * Keyed by address because that is all UnmapViewOfFile is given -- it takes
     * no handle and no length, so everything needed to write the bytes back and
     * release the memory has to be findable from the pointer alone.
     *
     * @type {Map<number, { mapping: any, offset: number, length: number,
     *                      writable: boolean }>}
     */
    const views = new Map();

    /** @param {number} handle @param {string} type */
    const object = (handle, type)=>{
        try
        {
            return host.handles.resolve(handle >>> 0, type);
        }
        catch (e){
            void e;
            return null;
        }
    };

    /** @param {number} code @param {number} [result] */
    const fail = (code, result = 0)=>{
        host.setLastError(code);
        return result;
    };

    /** @param {string} api */
    const refuseNamedPipe = api=>{
        host.divergence?.(api, 'there are no named pipes; refused as Windows 9x refuses it');
        return fail(ERROR_CALL_NOT_IMPLEMENTED, INVALID_HANDLE_VALUE);
    };

    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        host.writeMemory(address, new Uint8Array([
            value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
        ]));
    };

    /** @param {number} address @param {number} value */
    const writeDwordIf = (address, value)=>{
        if (address !== 0)
        {
            writeDword(address, value);
        }
    };

    /** @param {number} pointer @param {boolean} wide @returns {string | null} */
    const nameOf = (pointer, wide)=>{
        if ((pointer >>> 0) === 0)
        {
            return null;
        }
        return (wide ? host.readWideString(pointer >>> 0, MAX_NAME * 2)
            : host.readCString(pointer >>> 0, MAX_NAME)) || null;
    };

    /**
     * HANDLE CreateFileMappingA/W(HANDLE hFile, LPSECURITY_ATTRIBUTES,
     *   DWORD flProtect, DWORD dwMaximumSizeHigh, DWORD dwMaximumSizeLow,
     *   LPCSTR/LPCWSTR lpName)
     *
     * Nothing is read here for a fresh mapping. A mapping is a description of
     * what a later view would hold; the bytes move when MapViewOfFile is
     * called, which is also when Windows first touches them.
     *
     * A named mapping already made by this process is found rather than
     * remade, the same as a named mutex or event: the protection and size a
     * second create passes are ignored, and the handle is a second one onto
     * the object the first create made, with ERROR_ALREADY_EXISTS to say so.
     *
     * @param {boolean} wide
     */
    const createFileMapping = wide=>({
        argBytes: 24,
        /** @param {number[]} args */
        handler: ([file, , protect, sizeHigh, sizeLow, namePointer])=>{
            const name = nameOf(namePointer, wide);
            const found = host.namedObjects.existing(name, 'mapping');
            if (found === TAKEN)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            if (found)
            {
                host.namedObjects.remember(name, 'mapping', found, true, host.setLastError);
                if (found.node)
                {
                    host.files.retain(found.node);
                }
                return host.handles.open('mapping', found);
            }
            if (sizeHigh !== 0)
            {
                // A mapping larger than 4 GiB has nowhere to go: a view of it
                // would not fit in the address space it is mapped into.
                return fail(ERROR_NOT_ENOUGH_MEMORY);
            }
            const anonymous = (file >>> 0) === INVALID_HANDLE_VALUE || file === 0;
            const opened = anonymous ? null : object(file, 'file');
            if (!anonymous && !opened)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            // What a file handle resolves to is the open-file record -- path,
            // position, access -- and the volume's node is a field of it. The
            // mapping keeps the node, because the record's position is the
            // handle's and a view has its own offset.
            const node = opened ? opened.node : null;
            const writable = (protect >>> 0) === PAGE_READWRITE
                || (protect >>> 0) === PAGE_WRITECOPY;
            if (anonymous && (sizeLow >>> 0) === 0)
            {
                // A mapping with no file must be told how big it is; there is
                // nothing else to derive a size from.
                return fail(ERROR_INVALID_PARAMETER);
            }
            // A size of zero over a file means the file's own size, which is
            // how a program maps a file whole without asking first.
            const size = (sizeLow >>> 0) || (node ? host.files.size?.(node) ?? 0 : 0);
            if (size === 0)
            {
                return fail(ERROR_FILE_INVALID);
            }
            const mapping = { node, writable, size };
            if (node)
            {
                host.files.retain(node);
            }
            host.namedObjects.remember(name, 'mapping', mapping, false, host.setLastError);
            return host.handles.open('mapping', mapping);
        },
    });

    /**
     * HANDLE OpenFileMappingA/W(DWORD dwDesiredAccess, BOOL bInheritHandle,
     *   LPCSTR/LPCWSTR lpName)
     *
     * A second handle onto a mapping made by name, as a second create would
     * give but without making one: no name is a bad parameter, a name nothing
     * holds is "no such thing", and a name another kind holds is a bad handle.
     *
     * @param {boolean} wide
     */
    const openFileMapping = wide=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([, , namePointer])=>{
            const name = nameOf(namePointer, wide);
            if (name === null)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const found = host.namedObjects.existing(name, 'mapping');
            if (found === TAKEN)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            if (!found)
            {
                return fail(ERROR_FILE_NOT_FOUND);
            }
            host.namedObjects.reference(found);
            if (found.node)
            {
                host.files.retain(found.node);
            }
            return host.handles.open('mapping', found);
        },
    });

    return {
        CreateFileMappingA: createFileMapping(false),
        CreateFileMappingW: createFileMapping(true),
        OpenFileMappingA: openFileMapping(false),
        OpenFileMappingW: openFileMapping(true),

        /**
         * LPVOID MapViewOfFile(HANDLE hFileMappingObject, DWORD dwDesiredAccess,
         *   DWORD dwFileOffsetHigh, DWORD dwFileOffsetLow, SIZE_T dwNumberOfBytesToMap)
         *
         * A length of zero means "to the end of the mapping", which for an
         * anonymous mapping is the size it was created with and for a file is
         * whatever is left of it.
         */
        MapViewOfFile: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, access, offsetHigh, offsetLow, length])=>{
                if (offsetHigh !== 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const mapping = object(handle, 'mapping');
                if (!mapping)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const offset = offsetLow >>> 0;
                const wanted = (length >>> 0) || Math.max(mapping.size - offset, 0);
                if (wanted === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }

                const address = host.allocate(wanted);
                if (address === 0)
                {
                    return fail(ERROR_NOT_ENOUGH_MEMORY);
                }

                const writable = mapping.writable
                    && ((access >>> 0) & (FILE_MAP_WRITE | FILE_MAP_ALL_ACCESS)) !== 0;
                const metrics = host.metrics;
                /** @param {Uint8Array} bytes */
                const deliver = bytes=>{
                    if (bytes.length > 0)
                    {
                        host.writeMemory(address, bytes);
                    }
                    views.set(address, { mapping, offset, length: wanted, writable });
                    if (metrics)
                    {
                        metrics.views++;
                    }
                    return address;
                };

                // Read through to the file now. An anonymous mapping starts as
                // zeroes, which is what the allocator already gives.
                if (!mapping.node)
                {
                    return deliver(new Uint8Array(0));
                }
                // The view holds the file from here to its unmap, so closing the
                // mapping and the file handle first leaves it a file to be
                // written back to.
                host.files.retain(mapping.node);
                let bytes;
                try
                {
                    bytes = host.files.read(mapping.node, offset, wanted);
                }
                catch (e){
                    host.files.close(mapping.node);
                    host.release(address);
                    throw e;
                }
                if (typeof (/** @type {any} */ (bytes))?.then !== 'function')
                {
                    return deliver(/** @type {Uint8Array} */ (bytes));
                }
                // The bytes are not here yet. The caller is parked until they
                // are, the way a read parks it: a program that maps an archive
                // it has just opened is not told it has run out of memory
                // because the archive had not finished arriving.
                const owner = host.currentThread?.() ?? null;
                if (metrics)
                {
                    metrics.waited++;
                }
                const arriving = /** @type {Promise<Uint8Array>} */ (bytes);
                return /** @type {any} */ (arriving.then(deliver, ()=>{
                    host.files.close(mapping.node);
                    host.release(address);
                    host.setLastErrorFor?.(owner, ERROR_IO_DEVICE);
                    if (metrics)
                    {
                        metrics.failed++;
                    }
                    return 0;
                }));
            },
        },

        /**
         * BOOL UnmapViewOfFile(LPCVOID lpBaseAddress)
         *
         * Where a writable view's bytes go back to the file. On Windows they are
         * written when the system feels like it and certainly by here; doing it
         * only here is the difference a second reader would notice, and there is
         * no second reader.
         */
        UnmapViewOfFile: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([address])=>{
                const view = views.get(address >>> 0);
                if (!view)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (view.writable && view.mapping.node)
                {
                    host.files.write(view.mapping.node, view.offset,
                        host.readMemory(address >>> 0, view.length));
                }
                if (view.mapping.node)
                {
                    host.files.close(view.mapping.node);
                }
                views.delete(address >>> 0);
                host.release(address >>> 0);
                return 1;
            },
        },

        /**
         * BOOL CreatePipe(PHANDLE hReadPipe, PHANDLE hWritePipe,
         *   LPSECURITY_ATTRIBUTES, DWORD nSize)
         *
         * The two handles name one queue. The size is advisory even on Windows
         * -- it is a hint about buffering, not a limit a caller can rely on --
         * so nothing here bounds the queue by it.
         */
        CreatePipe: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([readHandle, writeHandle])=>{
                if (readHandle === 0 || writeHandle === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                /** @type {{ buffered: number[], writersOpen: boolean }} */
                const pipe = { buffered: [], writersOpen: true };
                writeDword(readHandle >>> 0, host.handles.open('pipe-read', pipe));
                writeDword(writeHandle >>> 0, host.handles.open('pipe-write', pipe));
                return 1;
            },
        },

        /**
         * HANDLE CreateNamedPipeA(LPCSTR lpName, DWORD dwOpenMode, DWORD dwPipeMode,
         *   DWORD nMaxInstances, DWORD nOutBufferSize, DWORD nInBufferSize,
         *   DWORD nDefaultTimeOut, LPSECURITY_ATTRIBUTES lpSecurityAttributes)
         * HANDLE CreateNamedPipeW(LPCWSTR, ...): the same in wide text
         *
         * There is no pipe namespace a client could open the other end in, so
         * the server end is refused the way Windows 9x refuses it, which a
         * caller of the era already handles; NT would create it, so the
         * refusal is reported.
         */
        CreateNamedPipeA: {
            argBytes: 32,
            handler: ()=>refuseNamedPipe('CreateNamedPipeA'),
        },
        CreateNamedPipeW: {
            argBytes: 32,
            handler: ()=>refuseNamedPipe('CreateNamedPipeW'),
        },

        /**
         * HANDLE CreateMailslotA(LPCSTR lpName, DWORD nMaxMessageSize,
         *   DWORD lReadTimeout, LPSECURITY_ATTRIBUTES lpSecurityAttributes)
         * HANDLE CreateMailslotW(LPCWSTR, ...): the same in wide text
         *
         * No other process could open the slot to write to it, so it is
         * refused as a pipe is, and the refusal reported.
         */
        CreateMailslotA: {
            argBytes: 16,
            handler: ()=>{
                host.divergence?.('CreateMailslotA', 'there are no mailslots; refused');
                return fail(ERROR_CALL_NOT_IMPLEMENTED, INVALID_HANDLE_VALUE);
            },
        },
        CreateMailslotW: {
            argBytes: 16,
            handler: ()=>{
                host.divergence?.('CreateMailslotW', 'there are no mailslots; refused');
                return fail(ERROR_CALL_NOT_IMPLEMENTED, INVALID_HANDLE_VALUE);
            },
        },

        /**
         * BOOL PeekNamedPipe(HANDLE hNamedPipe, LPVOID lpBuffer, DWORD nBufferSize,
         *   LPDWORD lpBytesRead, LPDWORD lpTotalBytesAvail, LPDWORD lpBytesLeftThisMessage)
         *
         * Looks without consuming, which is the whole point of it: a program
         * calls this to find out whether a read would block before committing to
         * one.
         */
        PeekNamedPipe: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([handle, buffer, size, read, available, left])=>{
                const pipe = object(handle, 'pipe-read');
                if (!pipe)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const total = pipe.buffered.length;
                const copied = Math.min(total, size >>> 0);
                if (buffer !== 0 && copied > 0)
                {
                    host.writeMemory(buffer >>> 0,
                        new Uint8Array(pipe.buffered.slice(0, copied)));
                }
                writeDwordIf(read >>> 0, copied);
                writeDwordIf(available >>> 0, total);
                // An anonymous pipe is a byte stream with no messages in it, so
                // there is never anything left of one.
                writeDwordIf(left >>> 0, 0);
                return 1;
            },
        },
    };
}
