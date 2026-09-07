/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The three things kernel32 lets a program treat as memory instead of as a
 * stream: a file mapping, a pipe, and a completion port.
 *
 * They sit together because all three are handle-shaped objects with no bytes
 * of their own, and because each is somewhere this build has to be honest about
 * a limit rather than pretend.
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
 *
 * A **completion port** is a queue of completed operations. Posting and getting
 * are real. What is missing is anything that completes on its own: no overlapped
 * file or socket operation in this build ever queues to a port, so a program
 * that starts an asynchronous read and waits for its completion waits for
 * something nobody will post. A program that posts its own -- which is how a
 * port is used as a work queue, and the more common of the two -- works.
 */

/** Codes this surface reports. */
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const WAIT_TIMEOUT = 258;

/** INVALID_HANDLE_VALUE, which CreateFileMapping takes to mean "no file". */
const INVALID_HANDLE_VALUE = 0xffffffff;

/** Waits with this timeout never give up. */
const INFINITE = 0xffffffff;

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
 * @property {(bytes: number) => number} allocate  Guest memory, or 0.
 * @property {(address: number) => void} release
 * @property {(milliseconds: number) => void} advanceClock
 * @property {{ open: (type: string, object: any) => number,
 *              resolve: (handle: number, type?: string) => any,
 *              close: (handle: number) => any }} handles
 * @property {{ read: (node: any, offset: number, length: number) => Uint8Array | null,
 *              write: (node: any, offset: number, bytes: Uint8Array) => number }} files
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

                // Read through to the file now. An anonymous mapping starts as
                // zeroes, which is what the allocator already gives.
                if (mapping.node)
                {
                    const bytes = host.files.read(mapping.node, offset, wanted);
                    if (bytes === null)
                    {
                        // The file cannot be read without waiting, and this call
                        // has nowhere to wait. Refused rather than mapped as
                        // zeroes, which a caller would read as a file of nulls
                        // and never question.
                        host.release(address);
                        return fail(ERROR_NOT_ENOUGH_MEMORY);
                    }
                    if (bytes.length > 0)
                    {
                        host.writeMemory(address, bytes);
                    }
                }

                const writable = mapping.writable
                    && ((access >>> 0) & (FILE_MAP_WRITE | FILE_MAP_ALL_ACCESS)) !== 0;
                views.set(address, { mapping, offset, length: wanted, writable });
                return address;
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

        /**
         * HANDLE CreateIoCompletionPort(HANDLE FileHandle, HANDLE ExistingCompletionPort,
         *   ULONG_PTR CompletionKey, DWORD NumberOfConcurrentThreads)
         *
         * Associating a file with a port is accepted and records the key, but
         * nothing in this build ever completes an operation into a port -- see
         * the note at the top. A program using a port as its own work queue is
         * fully served; one waiting for an overlapped read is not.
         */
        CreateIoCompletionPort: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([file, existing, key])=>{
                if ((existing >>> 0) !== 0)
                {
                    const port = object(existing, 'iocp');
                    if (!port)
                    {
                        return fail(ERROR_INVALID_HANDLE);
                    }
                    port.associated.set(file >>> 0, key >>> 0);
                    return existing >>> 0;
                }
                if ((file >>> 0) !== INVALID_HANDLE_VALUE && file !== 0)
                {
                    // A port created around a file still needs its key recorded,
                    // because a completion would carry it.
                    const port = { queue: [], associated: new Map([[file >>> 0, key >>> 0]]) };
                    return host.handles.open('iocp', port);
                }
                return host.handles.open('iocp', { queue: [], associated: new Map() });
            },
        },

        /**
         * BOOL PostQueuedCompletionStatus(HANDLE CompletionPort,
         *   DWORD dwNumberOfBytesTransferred, ULONG_PTR dwCompletionKey,
         *   LPOVERLAPPED lpOverlapped)
         */
        PostQueuedCompletionStatus: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, transferred, key, overlapped])=>{
                const port = object(handle, 'iocp');
                if (!port)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                port.queue.push({
                    transferred: transferred >>> 0,
                    key: key >>> 0,
                    overlapped: overlapped >>> 0,
                });
                return 1;
            },
        },

        /**
         * BOOL GetQueuedCompletionStatus(HANDLE CompletionPort,
         *   LPDWORD lpNumberOfBytes, PULONG_PTR lpCompletionKey,
         *   LPOVERLAPPED *lpOverlapped, DWORD dwMilliseconds)
         *
         * A wait on an empty queue does not block. There is no timer in the
         * scheduler to wake it and nothing that would post while it slept, so a
         * real wait would be a hang; the clock is credited and the timeout is
         * reported, which sends the caller round its loop instead. A caller with
         * an infinite timeout is told the same thing, which is the one place
         * this departs from Windows and is why it is written down here.
         */
        GetQueuedCompletionStatus: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, bytes, key, overlapped, timeout])=>{
                const port = object(handle, 'iocp');
                if (!port)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const completion = port.queue.shift();
                if (!completion)
                {
                    const waited = (timeout >>> 0) === INFINITE ? 0 : timeout >>> 0;
                    host.advanceClock(waited);
                    // The out-parameters are cleared: a caller reads lpOverlapped
                    // to tell a timeout from a failed operation, and a stale
                    // pointer there is one it would go on to dereference.
                    writeDwordIf(bytes >>> 0, 0);
                    writeDwordIf(key >>> 0, 0);
                    writeDwordIf(overlapped >>> 0, 0);
                    return fail(WAIT_TIMEOUT);
                }
                writeDwordIf(bytes >>> 0, completion.transferred);
                writeDwordIf(key >>> 0, completion.key);
                writeDwordIf(overlapped >>> 0, completion.overlapped);
                return 1;
            },
        },
    };
}
