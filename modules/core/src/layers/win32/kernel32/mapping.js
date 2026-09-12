/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

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
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NOT_ENOUGH_MEMORY = 8;
/** What a read that failed after the caller was parked answers. */
const ERROR_IO_DEVICE = 1117;

/** INVALID_HANDLE_VALUE, which CreateFileMapping takes to mean "no file". */
const INVALID_HANDLE_VALUE = 0xffffffff;

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
 * @property {(code: number) => void} setLastError
 * @property {(thread: any, code: number) => void} [setLastErrorFor]
 *           The error of a thread that is not the one running: a map that
 *           waited for its bytes answers on somebody else's turn.
 * @property {() => any} [currentThread]
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
 *              write: (node: any, offset: number, bytes: Uint8Array) => number }} files
 *           A promise when the bytes are not resident yet; the map then
 *           answers when they are, the caller parked meanwhile, as a read is.
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

    return {
        /**
         * HANDLE CreateFileMappingA(HANDLE hFile, LPSECURITY_ATTRIBUTES,
         *   DWORD flProtect, DWORD dwMaximumSizeHigh, DWORD dwMaximumSizeLow,
         *   LPCSTR lpName)
         *
         * Nothing is read here. A mapping is a description of what a later view
         * would hold; the bytes move when MapViewOfFile is called, which is also
         * when Windows first touches them.
         */
        CreateFileMappingA: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([file, , protect, sizeHigh, sizeLow])=>{
                if (sizeHigh !== 0)
                {
                    // A mapping larger than 4 GiB has nowhere to go: a view of it
                    // would not fit in the address space it is mapped into.
                    return fail(ERROR_NOT_ENOUGH_MEMORY);
                }
                const anonymous = (file >>> 0) === INVALID_HANDLE_VALUE || file === 0;
                const node = anonymous ? null : object(file, 'file');
                if (!anonymous && !node)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const writable = (protect >>> 0) === PAGE_READWRITE
                    || (protect >>> 0) === PAGE_WRITECOPY;
                if (anonymous && (sizeLow >>> 0) === 0)
                {
                    // A mapping with no file must be told how big it is; there
                    // is nothing else to derive a size from.
                    return fail(ERROR_INVALID_PARAMETER);
                }
                return host.handles.open('mapping', {
                    node, writable, size: sizeLow >>> 0,
                });
            },
        },

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
                const bytes = host.files.read(mapping.node, offset, wanted);
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
