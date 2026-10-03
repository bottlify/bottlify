/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { TAKEN } from './named-objects.js';
import { STATUS, toDosError } from '../ntdll/status.js';

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
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NOT_ENOUGH_MEMORY = 8;
/** What CreateNamedPipe answers where there are no named pipes, as on Windows 9x. */
const ERROR_CALL_NOT_IMPLEMENTED = 120;
/** What a read that failed after the caller was parked answers. */
const ERROR_IO_DEVICE = 1117;

/** INVALID_HANDLE_VALUE, which CreateFileMapping takes to mean "no file". */
const INVALID_HANDLE_VALUE = 0xffffffff;

/** A name is at most this long; longer is a pointer that is not a string. */
const MAX_NAME = 260;

/**
 * The PAGE_* half of flProtect, and the protections of it a view can be
 * written through. Everything else is read-only.
 */
const PAGE_MASK = 0xff;
const WRITABLE_PAGES = [0x04, 0x08, 0x40, 0x80];
const PAGE_SIZE = 0x1000;

/**
 * The SEC_* half: what a section is made as, and the attributes
 * NtQuerySection reports of it.
 */
const SEC_FILE = 0x800000;
const SEC_IMAGE = 0x1000000;
const SEC_RESERVE = 0x4000000;
const SEC_COMMIT = 0x8000000;
const SEC_NOCACHE = 0x10000000;
const SEC_WRITECOMBINE = 0x40000000;
const SEC_LARGE_PAGES = 0x80000000;

/** NtQuerySection's classes, by number, and the size of each answer. */
const SECTION_BASIC_INFORMATION = 0;
const SECTION_IMAGE_INFORMATION = 1;
const SECTION_INFORMATION_SIZES = [16, 48];

/** GetCurrentProcess(): the one process a view is mapped into here. */
const CURRENT_PROCESS = 0xffffffff;

/** dwDesiredAccess for MapViewOfFile. */
const FILE_MAP_WRITE = 0x0002;
const FILE_MAP_READ = 0x0004;
const FILE_MAP_ALL_ACCESS = 0xf001f;

/**
 * A mapping object: the file it is over (null for the page file's), whether a
 * view of it can be written back, its size, and its SEC_* attributes.
 *
 * @typedef {{ node: any, writable: boolean, size: number, attributes: number }} Section
 */

/**
 * Runs `then` on a value now, or on a promise's when it comes.
 *
 * @template T, R
 * @param {T | Promise<T>} value @param {(value: T) => R} then
 * @returns {R | Promise<R>}
 */
const settle = (value, then)=>(typeof (/** @type {any} */ (value))?.then === 'function'
    ? /** @type {Promise<T>} */ (value).then(then) : then(/** @type {T} */ (value)));

/** @param {number} bytes */
const pageRound = bytes=>Math.ceil(bytes / PAGE_SIZE) * PAGE_SIZE;

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

    /** @param {number} handle @param {string} [type] */
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
    /** @param {string} api */
    const refusePipeCall = api=>{
        host.divergence?.(api, 'there are no named pipes; refused as Windows 9x refuses it');
        return fail(ERROR_CALL_NOT_IMPLEMENTED, 0);
    };

    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        host.writeMemory(address, new Uint8Array([
            value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
        ]));
    };

    /** @param {number} address */
    const readDword = address=>{
        const bytes = host.readMemory(address, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
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
     * A new section, or the status it is refused with: the checks
     * CreateFileMapping and NtCreateSection share. A section over a file is
     * SEC_FILE whatever was asked, keeping only its caching; the page file's
     * keeps what was asked, and is whole pages.
     *
     * @param {any} node  the file's, or null for the page file's
     * @param {number} page  the PAGE_* protection
     * @param {number} flags  the SEC_* attributes asked for
     * @param {number} sizeHigh @param {number} sizeLow  zero for the file's own size
     * @returns {Section | { status: number } | Promise<Section | { status: number }>}
     */
    const makeSection = (node, page, flags, sizeHigh, sizeLow)=>{
        const caching = flags & (SEC_NOCACHE | SEC_WRITECOMBINE);
        const committing = flags & (SEC_RESERVE | SEC_COMMIT);
        if ((flags & (SEC_FILE | SEC_LARGE_PAGES)) !== 0
            || committing === (SEC_RESERVE | SEC_COMMIT)
            || ((flags & SEC_IMAGE) !== 0
                ? committing !== 0 || (flags & SEC_WRITECOMBINE) !== 0
                : caching !== 0 && committing === 0))
        {
            return { status: STATUS.INVALID_PARAMETER };
        }
        if (sizeHigh !== 0)
        {
            // A mapping larger than 4 GiB has nowhere to go: a view of it
            // would not fit in the address space it is mapped into.
            return { status: STATUS.SECTION_TOO_BIG };
        }
        const writable = WRITABLE_PAGES.includes(page);
        const asked = sizeLow >>> 0;
        if (!node)
        {
            // A mapping with no file must be told how big it is; there is
            // nothing else to derive a size from.
            return (flags & SEC_IMAGE) !== 0 ? { status: STATUS.INVALID_FILE_FOR_SECTION }
                : asked === 0 ? { status: STATUS.INVALID_PARAMETER }
                    : { node, writable, size: pageRound(asked),
                        attributes: (committing || SEC_COMMIT) | caching };
        }
        const length = host.files.size?.(node) ?? 0;
        if ((flags & SEC_IMAGE) !== 0)
        {
            if (length < 2)
            {
                return { status: STATUS.INVALID_FILE_FOR_SECTION };
            }
            return settle(host.files.read(node, 0, 2), head=>{
                if (head[0] !== 0x4d || head[1] !== 0x5a)
                {
                    return { status: STATUS.INVALID_IMAGE_NOT_MZ };
                }
                host.divergence?.('NtCreateSection',
                    'a SEC_IMAGE view holds the file as it lies, not laid out as an image');
                return { node, writable: false, size: length, attributes: SEC_FILE | SEC_IMAGE };
            });
        }
        if (asked === 0 && length === 0)
        {
            return { status: STATUS.MAPPED_FILE_SIZE_ZERO };
        }
        if (asked > length && !writable && host.files.size)
        {
            // Only a section that may be written grows its file to its size.
            return { status: STATUS.SECTION_TOO_BIG };
        }
        // A size of zero over a file means the file's own size, which is
        // how a program maps a file whole without asking first.
        return { node, writable, size: asked || length, attributes: SEC_FILE | caching };
    };

    /** @param {Section} section */
    const openSection = section=>{
        if (section.node)
        {
            host.files.retain(section.node);
        }
        return host.handles.open('mapping', section);
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
            if (!found && name !== null && /^global\\/i.test(name))
            {
                // Making a section in the global namespace takes
                // SeCreateGlobalPrivilege, which a program started the usual
                // way -- not elevated -- does not hold; opening one that a
                // service made is allowed.
                return fail(ERROR_ACCESS_DENIED);
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
            // An image's header is read to check it, and may not be here yet:
            // the answer is then the asking thread's, on somebody else's turn.
            const owner = host.currentThread?.() ?? null;
            let waited = false;
            const answer = settle(makeSection(opened ? opened.node : null,
                protect & PAGE_MASK, (protect & ~PAGE_MASK) || SEC_COMMIT, sizeHigh, sizeLow),
            made=>{
                /** @param {number} code */
                const setError = code=>(waited && host.setLastErrorFor
                    ? host.setLastErrorFor(owner, code) : host.setLastError(code));
                if ('status' in made)
                {
                    setError(toDosError(made.status));
                    return 0;
                }
                host.namedObjects.remember(name, 'mapping', made, false, setError);
                return openSection(made);
            });
            waited = true;
            return /** @type {any} */ (answer);
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

    /**
     * @param {number} handle
     * @returns {Section | number} the section, or the status a handle that
     *          names none is answered with
     */
    const sectionOf = handle=>object(handle, 'mapping')
        ?? (object(handle) ? STATUS.OBJECT_TYPE_MISMATCH : STATUS.INVALID_HANDLE);

    /**
     * The native calls over the same sections, which ntdll publishes. The
     * table keeps no access rights with a handle, so one opened without
     * SECTION_QUERY is answered as one with it.
     */
    const natives = {
        /**
         * NTSTATUS NtCreateSection(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
         *   PLARGE_INTEGER MaximumSize, ULONG SectionPageProtection,
         *   ULONG AllocationAttributes, HANDLE FileHandle)
         */
        NtCreateSection: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([out, , attributes, maximum, page, flags, file])=>{
                if ((out >>> 0) === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                const opened = (file >>> 0) === 0 ? null : object(file, 'file');
                if ((file >>> 0) !== 0 && !opened)
                {
                    return STATUS.INVALID_HANDLE;
                }
                if ((attributes >>> 0) !== 0 && readDword((attributes >>> 0) + 8) !== 0)
                {
                    host.divergence?.('NtCreateSection',
                        'a named section is made without its name');
                }
                const size = (maximum >>> 0) === 0 ? [0, 0]
                    : [readDword((maximum >>> 0) + 4), readDword(maximum >>> 0)];
                return settle(makeSection(opened ? opened.node : null, page & PAGE_MASK,
                    flags || SEC_COMMIT, size[0], size[1]), made=>{
                    if ('status' in made)
                    {
                        return made.status;
                    }
                    writeDword(out >>> 0, openSection(made));
                    return STATUS.SUCCESS;
                });
            },
        },

        /**
         * NTSTATUS NtQuerySection(HANDLE, SECTION_INFORMATION_CLASS, PVOID,
         *                         SIZE_T Length, PSIZE_T ResultLength)
         *
         * What a section was made as. An image section's image information
         * is not kept, and is answered as zeros.
         */
        NtQuerySection: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, kind, buffer, length, returned])=>{
                const section = sectionOf(handle);
                if (typeof section === 'number')
                {
                    return section;
                }
                const size = SECTION_INFORMATION_SIZES[kind];
                if (size === undefined)
                {
                    return STATUS.INVALID_INFO_CLASS;
                }
                if ((length >>> 0) < size)
                {
                    return STATUS.INFO_LENGTH_MISMATCH;
                }
                if (kind === SECTION_IMAGE_INFORMATION && (section.attributes & SEC_IMAGE) === 0)
                {
                    return STATUS.SECTION_NOT_IMAGE;
                }
                if ((buffer >>> 0) === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                const info = new Uint8Array(size);
                if (kind === SECTION_BASIC_INFORMATION)
                {
                    // BaseAddress, which only a based section has, Attributes, Size.
                    const fields = new DataView(info.buffer);
                    fields.setUint32(4, section.attributes >>> 0, true);
                    fields.setUint32(8, section.size, true);
                }
                else
                {
                    host.divergence?.('NtQuerySection', 'image information is answered as zeros');
                }
                host.writeMemory(buffer >>> 0, info);
                writeDwordIf(returned >>> 0, size);
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS NtMapViewOfSection(HANDLE SectionHandle, HANDLE ProcessHandle,
         *   PVOID *BaseAddress, ULONG_PTR ZeroBits, SIZE_T CommitSize,
         *   PLARGE_INTEGER SectionOffset, PSIZE_T ViewSize, SECTION_INHERIT,
         *   ULONG AllocationType, ULONG Win32Protect)
         *
         * MapViewOfFile's view, in this process; one that would reach past
         * the section's end is refused rather than cut short.
         */
        NtMapViewOfSection: {
            argBytes: 40,
            /** @param {number[]} args */
            handler: ([handle, process, base, , , offsetAt, sizeAt, , , page])=>{
                const section = sectionOf(handle);
                if (typeof section === 'number')
                {
                    return section;
                }
                if ((process >>> 0) !== CURRENT_PROCESS)
                {
                    host.divergence?.('NtMapViewOfSection', 'a view maps into this process only');
                    return STATUS.NOT_SUPPORTED;
                }
                if ((base >>> 0) === 0 || (sizeAt >>> 0) === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                if (readDword(base >>> 0) !== 0)
                {
                    host.divergence?.('NtMapViewOfSection',
                        'a view goes where there is room, not at the address asked for');
                }
                const offset = (offsetAt >>> 0) === 0 ? 0 : readDword(offsetAt >>> 0);
                const length = readDword(sizeAt >>> 0) || section.size - offset;
                if (length <= 0 || offset + length > section.size)
                {
                    return STATUS.INVALID_VIEW_SIZE;
                }
                const access = WRITABLE_PAGES.includes(page & PAGE_MASK) ? FILE_MAP_WRITE
                    : FILE_MAP_READ;
                return settle(table.MapViewOfFile.handler([handle, access, 0, offset, length]),
                    /** @param {number} address */
                    address=>{
                        if (address === 0)
                        {
                            return STATUS.NO_MEMORY;
                        }
                        writeDword(base >>> 0, address);
                        writeDword(sizeAt >>> 0, pageRound(length));
                        return STATUS.SUCCESS;
                    });
            },
        },

        /** NTSTATUS NtUnmapViewOfSection(HANDLE ProcessHandle, PVOID BaseAddress) */
        NtUnmapViewOfSection: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([process, address])=>{
                if ((process >>> 0) !== CURRENT_PROCESS)
                {
                    host.divergence?.('NtUnmapViewOfSection', 'a view maps into this process only');
                    return STATUS.NOT_SUPPORTED;
                }
                if (!views.has(address >>> 0))
                {
                    return STATUS.NOT_MAPPED_VIEW;
                }
                table.UnmapViewOfFile.handler([address]);
                return STATUS.SUCCESS;
            },
        },
    };

    const table = {
        CreateFileMappingA: createFileMapping(false),
        CreateFileMappingW: { ...createFileMapping(true), natives },
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
         * BOOL FlushViewOfFile(LPCVOID lpBaseAddress, SIZE_T dwNumberOfBytesToFlush)
         *
         * What UnmapViewOfFile writes back, written back now and the view left
         * in place: from the address to as many bytes on, or to the view's end
         * for none. An address in no view is refused (ERROR_INVALID_PARAMETER,
         * as Wine's kernelbase answers it); a view of no file, or one that
         * cannot be written through, has nothing to write and succeeds.
         */
        FlushViewOfFile: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([address, count])=>{
                const at = address >>> 0;
                for (const [base, view] of views)
                {
                    if (at < base || at >= base + view.length)
                    {
                        continue;
                    }
                    const end = (count >>> 0) === 0
                        ? base + view.length
                        : Math.min(base + view.length, at + (count >>> 0));
                    if (view.writable && view.mapping.node)
                    {
                        host.files.write(view.mapping.node, view.offset + (at - base),
                            host.readMemory(at, end - at));
                    }
                    return 1;
                }
                return fail(ERROR_INVALID_PARAMETER);
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
         * The rest of the named-pipe calls, refused the same way, since no
         * handle can be a named pipe's:
         *
         *   BOOL ConnectNamedPipe(HANDLE, LPOVERLAPPED)
         *   BOOL DisconnectNamedPipe(HANDLE)
         *   BOOL WaitNamedPipeA/W(LPCTSTR lpNamedPipeName, DWORD nTimeOut)
         *   BOOL TransactNamedPipe(HANDLE, LPVOID, DWORD, LPVOID, DWORD, LPDWORD, LPOVERLAPPED)
         *   BOOL GetNamedPipeInfo(HANDLE, LPDWORD, LPDWORD, LPDWORD, LPDWORD)
         *   BOOL GetNamedPipeHandleStateA(HANDLE, LPDWORD, LPDWORD, LPDWORD, LPDWORD,
         *                                 LPSTR, DWORD)
         *   BOOL SetNamedPipeHandleState(HANDLE, LPDWORD, LPDWORD, LPDWORD)
         */
        ConnectNamedPipe: { argBytes: 8, handler: ()=>refusePipeCall('ConnectNamedPipe') },
        DisconnectNamedPipe: { argBytes: 4, handler: ()=>refusePipeCall('DisconnectNamedPipe') },
        WaitNamedPipeA: { argBytes: 8, handler: ()=>refusePipeCall('WaitNamedPipeA') },
        WaitNamedPipeW: { argBytes: 8, handler: ()=>refusePipeCall('WaitNamedPipeW') },
        TransactNamedPipe: { argBytes: 28, handler: ()=>refusePipeCall('TransactNamedPipe') },
        GetNamedPipeInfo: { argBytes: 20, handler: ()=>refusePipeCall('GetNamedPipeInfo') },
        GetNamedPipeHandleStateA: {
            argBytes: 28,
            handler: ()=>refusePipeCall('GetNamedPipeHandleStateA'),
        },
        SetNamedPipeHandleState: {
            argBytes: 16,
            handler: ()=>refusePipeCall('SetNamedPipeHandleState'),
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
    return table;
}
