/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { TAKEN } from './named-objects.js';
import { nameToWalk, readObjectAttributes } from './object-attributes.js';
import { STATUS, toDosError } from '../ntdll/status.js';
import { mapImage } from '../../loader/internal/image.js';
import { imageKind, relocateImage } from '../../loader/internal/pe.js';
import { copyOnWrite, sectionRights, viewProtection } from './view-rights.js';
import { sectionProtection } from './image-protection.js';
import { askChild } from './cross-process.js';
import { PROCESS_VM_OPERATION } from './process-target.js';
import { wholeAddress } from '../common/pointers.js';

/**
 * How far a name a program hands these is read: whole, as Windows reads it, up to
 * the 32 767 characters a path may have. A name cut shorter names another file.
 */
const WHOLE_NAME = 32767;

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
 * An anonymous **pipe** is a byte queue with two handles onto it. That is all
 * an anonymous pipe is on Windows too, so this one is not a compromise; named
 * pipes are pipes.js's.
 */

/** Codes this surface reports. */
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NOT_ENOUGH_MEMORY = 8;
/** What a read that failed after the caller was parked answers. */
const ERROR_IO_DEVICE = 1117;
const ERROR_INVALID_ADDRESS = 487;
const ERROR_MAPPED_ALIGNMENT = 1132;
/** Where a view asked for at an address may start: on a 64 KB granule. */
const ALLOCATION_GRANULARITY = 0x10000;

/** INVALID_HANDLE_VALUE, which CreateFileMapping takes to mean "no file". */
const INVALID_HANDLE_VALUE = 0xffffffff;

/**
 * The PAGE_* half of flProtect, and the protections of it a view can be
 * written through. Everything else is read-only.
 */
const PAGE_MASK = 0xff;
const WRITABLE_PAGES = [0x04, 0x08, 0x40, 0x80];
/** The protections whose writes reach the file: the copy-on-write ones never do. */
const FILE_WRITING_PAGES = [0x04, 0x40];
const PAGE_SIZE = 0x1000;
/** What an image's view is mapped with: executed, its writes its own copies. */
const PAGE_EXECUTE_WRITECOPY = 0x80;

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

/** dwDesiredAccess for MapViewOfFile: a section's own rights, SECTION_* by another name. */
const FILE_MAP_COPY = 0x0001;
const FILE_MAP_WRITE = 0x0002;
const FILE_MAP_READ = 0x0004;
const FILE_MAP_EXECUTE = 0x0020;
const FILE_MAP_ALL_ACCESS = 0xf001f;
/**
 * The rights a view asks of its section: FILE_MAP_COPY is SECTION_QUERY, which
 * every one has, and SECTION_MAP_EXECUTE alone maps nothing executable -
 * FILE_MAP_EXECUTE does - so neither is asked.
 */
const VIEW_RIGHTS = FILE_MAP_WRITE | FILE_MAP_READ | FILE_MAP_EXECUTE;

/** A file handle's rights an executable section asks of it. */
const FILE_EXECUTE = 0x0020;
const GENERIC_EXECUTE = 0x20000000;
const GENERIC_ALL = 0x10000000;

/** The PAGE_* protections a section may be made with. */
const SECTION_PAGES = [0x02, 0x04, 0x08, 0x20, 0x40, 0x80];

/**
 * The access a page protection maps a view with, NtMapViewOfSection's
 * Win32Protect turned into MapViewOfFile's dwDesiredAccess.
 *
 * @param {number} page
 */
const accessFor = page=>{
    const base = page & PAGE_MASK;
    const execute = base >= 0x10 ? FILE_MAP_EXECUTE : 0;
    return execute | ([0x04, 0x40].includes(base) ? FILE_MAP_WRITE | FILE_MAP_READ
        : [0x02, 0x20].includes(base) ? FILE_MAP_READ
            : [0x08, 0x80].includes(base) ? FILE_MAP_COPY : 0);
};

/**
 * A mapping object: the file it is over (null for the page file's), whether a
 * view of it can be written back, its size, and its SEC_* attributes.
 *
 * @typedef {{ node: any, writable: boolean, size: number, attributes: number,
 *     writesFile?: boolean, protect?: number, maximum?: number,
 *     image?: { bytes: Uint8Array, file: Uint8Array,
 *         image: import('../../loader/internal/pe.js').PeImage } }}
 *     Section
 *     `writesFile`: its views' writes reach the file, as a copy-on-write one's do not.
 *     `maximum`: an image section's size as it was made, which NtQuerySection answers;
 *     its views are the whole image.
 *     `image`: a SEC_IMAGE section's file laid out as its image at its own base, and its
 *     headers: what every view shows, moved to where the view is.
 */

/**
 * A view of an image section: the image laid out at its own base, moved to
 * `address` - its fixups applied and its header's ImageBase made `address` -
 * as Windows' loader moves an image it cannot place at its base (one
 * mechanism with the loader's own images, `relocateImage`). An image that
 * carries no relocations is mapped there as it lies, nothing fixed up, as
 * Windows maps a section's view and answers STATUS_IMAGE_NOT_AT_BASE: the
 * view is the program's to read, and only a loader would refuse to run it.
 *
 * @param {{ bytes: Uint8Array, image: import('../../loader/internal/pe.js').PeImage }} laid
 * @param {number} address
 * @returns {Uint8Array}
 */
export function imageViewAt(laid, address){
    if (address === laid.image.imageBase || !laid.image.relocatable)
    {
        return laid.bytes.slice();
    }
    const bytes = laid.bytes.slice();
    relocateImage(bytes, laid.image, address);
    return bytes;
}

/**
 * An image's sections as a view of it holds them, each with the protection
 * its characteristics give it, as a loaded image's (`sectionProtection`).
 *
 * @param {import('../../loader/internal/pe.js').PeImage} image
 * @returns {{ start: number, end: number, protect: number }[]}
 */
export function imageSections(image){
    const alignment = image.sectionAlignment || PAGE_SIZE;
    return image.sections.map(section=>({
        start: section.virtualAddress,
        end: section.virtualAddress + Math.ceil((section.virtualSize || section.rawSize)
            / alignment) * alignment,
        protect: sectionProtection(section.characteristics),
    }));
}

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
 * @property {(handle: number, right: number) =>
 *     import('./process-target.js').ProcessTarget} [processTarget]
 *           The process a handle names, if it carries the right (`process-target.js`).
 * @property {import('./cross-process.js').AskHost['askChild']} [askChild]
 *           A call made in a child, where it runs.
 * @property {{ peek: (args: number[]) => number | null,
 *     anonymous?: (attributes: number, size: number) => { read: number, write: number } | null }}
 *     [pipes]  CreatePipe's pair as the named pipes make it, and PeekNamedPipe of a
 *           named pipe's end
 * @property {(api: string, detail: string, kind?: 'loss') => void} [divergence]
 * @property {{ shared: ReturnType<typeof import('./shared-views.js').createSharedViews>,
 *     process: number }} [sharedViews]
 *           The run's agreement between views of one page-file section, and
 *           this process's name in it (`shared-views.js`).
 * @property {Map<number, import('./heap.js').ViewRegion>} [viewRegions]
 *           Every view of this process by its address, for VirtualQuery and
 *           VirtualProtect.
 * @property {(address: number, length: number) =>
 *     ({ take: (address: number, length: number) => number[] } | null)} [watchWrites]
 *           The engine's watch over a range's writes (the memory layer's): a view
 *           with copy-on-write pages is watched from its mapping, so their first
 *           write is seen (`copies` in heap.js's ViewRegion).
 * @property {(handle: number) => number | null} [handleAccess]  The rights a handle
 *           was granted (a section's, FILE_MAP_*), which a view asks within.
 * @property {{ views: number, waited: number, failed: number }} [metrics]
 *           Counted in place: views mapped, views that waited for their
 *           bytes, views whose bytes never came.
 * @property {(bytes: number, options?: { alignment?: number }) => number} allocate  Guest
 *     memory, or 0.
 * @property {(ms: number, tick: () => void) => () => void} [every]
 *           Calls `tick` every `ms` of the guest's clock until the answer is
 *           called: how a service watching its section's views looks at them.
 * @property {(address: number, bytes: number) => void} [zero]  Zeroes a span the view
 *     was given, which recycled memory may not be: what a view holds past what its
 *     section delivers reads zero, as a page-file section's does on Windows.
 * @property {(address: number, bytes: number) => boolean} [allocateAt]
 *           Guest memory at exactly that address, when all of it is free.
 * @property {(address: number) => void} release
 * @property {boolean} [machine64]  The machine runs x86-64 images: an image section
 *           of one is taken, where a 32-bit Windows refuses it.
 * @property {4 | 8} [pointerSize]  The process's width, which a watched section's
 *           owner reads its fields by.
 * @property {{ open: (type: string, object: any) => number,
 *              resolve: (handle: number, type?: string) => any,
 *              close: (handle: number) => any }} handles
 * @property {{ read: (node: any, offset: number, length: number) =>
 *                  Uint8Array | Promise<Uint8Array>,
 *              write: (node: any, offset: number, bytes: Uint8Array) => number,
 *              size?: (node: any) => number,
 *              retain: (node: any) => void,
 *              close: (node: any) => void,
 *              section?: (node: any, kind: 'readonly' | 'readwrite' | 'image') => any }} files
 *           A promise when the bytes are not resident yet; the map then
 *           answers when they are, the caller parked meanwhile, as a read is.
 *           The size is what a mapping made without one is as large as.
 *           Every mapping handle and every view holds the file's node with
 *           `retain` and gives it back with `close`, which closes the node
 *           once nothing -- the file's own handle included -- holds it. A
 *           section over a file holds a node of its own where `section` gives
 *           one: the file held on the section's terms, not its handle's.
 */

/** SECTION_IMAGE_INFORMATION's ImageFlags. */
const IMAGE_FLAGS = { comPlusNativeReady: 0x1, comPlusIlOnly: 0x2, dynamicallyRelocated: 0x4,
    mappedFlat: 0x8, comPlusPrefer32bit: 0x20 };
/** The .NET header's flags this reads. */
const COMIMAGE_FLAGS = { ilOnly: 0x1, required32: 0x2, preferred32: 0x20000 };
/** The COM descriptor's data directory: a .NET image's header. */
const COM_DESCRIPTOR = 14;

/**
 * SECTION_IMAGE_INFORMATION of an image section, as NtQuerySection answers
 * it (32-bit layout): what the loader and a process's creator read of the
 * image before mapping it - its entry, stack, subsystem, versions,
 * characteristics, machine, whether it holds code and how it is mapped -
 * from the file's own headers.
 *
 * @param {{ bytes: Uint8Array, file: Uint8Array,
 *     image: import('../../loader/internal/pe.js').PeImage }} laid
 * @returns {Uint8Array}
 */
export function sectionImageInformation(laid){
    const { file, image, bytes } = laid;
    const header = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const coff = header.getUint32(0x3c, true) + 4;
    const optional = coff + 20;
    const u16 = (/** @type {number} */ at)=>(at + 2 <= file.length ? header.getUint16(at, true) : 0);
    const u32 = (/** @type {number} */ at)=>(at + 4 <= file.length ? header.getUint32(at, true) : 0);
    const wide = image.bits === 64;
    const sizeOfCode = u32(optional + 4);
    const flat = image.sectionAlignment % PAGE_SIZE !== 0;
    const dllCharacteristics = u16(optional + 70);
    // Truncated short of its directories, an optional header has no .NET one.
    const com = image.directories[COM_DESCRIPTOR];
    const cor = com && com.address !== 0 && com.size !== 0 ? com : null;
    const corAt = cor && cor.size >= 72 && cor.address + 72 <= bytes.length ? cor.address : -1;
    const corView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const corFlags = corAt >= 0 ? corView.getUint32(corAt + 16, true) : 0;
    const runtime = corAt >= 0
        ? corView.getUint16(corAt + 4, true) * 0x10000 + corView.getUint16(corAt + 6, true) : 0;
    const ilOnly = (corFlags & COMIMAGE_FLAGS.ilOnly) !== 0 && runtime >= 0x20005;
    const code = sizeOfCode !== 0 || image.entryPointRva !== 0 || flat
        || (image.sections.length === 1 && image.sections[0].executable);
    const flags = (ilOnly && !wide && (corFlags & COMIMAGE_FLAGS.required32) === 0
        ? IMAGE_FLAGS.comPlusNativeReady : 0)
        | (ilOnly ? IMAGE_FLAGS.comPlusIlOnly : 0)
        | (ilOnly && !wide && (corFlags & COMIMAGE_FLAGS.preferred32) !== 0
            ? IMAGE_FLAGS.comPlusPrefer32bit : 0)
        | ((dllCharacteristics & 0x40) !== 0 && code && !flat && !cor
            ? IMAGE_FLAGS.dynamicallyRelocated : 0)
        | (flat ? IMAGE_FLAGS.mappedFlat : 0);
    const info = new Uint8Array(48);
    const out = new DataView(info.buffer);
    out.setUint32(0, (image.imageBase + image.entryPointRva) >>> 0, true);
    out.setUint32(8, image.stackReserve >>> 0, true);
    out.setUint32(12, image.stackCommit >>> 0, true);
    out.setUint32(16, image.subsystem, true);
    out.setUint16(20, u16(optional + 50), true); // MinorSubsystemVersion
    out.setUint16(22, u16(optional + 48), true); // MajorSubsystemVersion
    out.setUint16(24, u16(optional + 40), true); // MajorOperatingSystemVersion
    out.setUint16(26, u16(optional + 42), true); // MinorOperatingSystemVersion
    out.setUint16(28, u16(coff + 18), true); // ImageCharacteristics
    out.setUint16(30, dllCharacteristics, true);
    out.setUint16(32, u16(coff), true); // Machine
    out.setUint8(34, code ? 1 : 0);
    out.setUint8(35, flags);
    out.setUint32(36, cor ? 1 : 0, true); // LoaderFlags
    out.setUint32(40, file.length, true);
    out.setUint32(44, u32(optional + 64), true); // CheckSum
    return info;
}

/** The image machines a section takes, by the width of the image. */
const IMAGE_MACHINES = { 32: 0x014c, 64: 0x8664 };

/**
 * What NtCreateSection(SEC_IMAGE) refuses a file with, by what its headers say
 * it is (`imageKind`), as Windows answers each kind; null for a PE image of a
 * machine this one runs, which the loader then lays out.
 *
 * @param {ReturnType<typeof imageKind>} kind
 * @param {boolean} machine64  the machine runs x86-64 images
 * @returns {number | null}
 */
export function imageRefusal(kind, machine64){
    switch (kind.kind)
    {
        case 'not-mz':
            return STATUS.INVALID_IMAGE_NOT_MZ;
        case 'unreadable':
            return STATUS.INVALID_IMAGE_PROTECT;
        case 'ne':
            // The NE header's target system: Windows 16-bit, and "Windows 386"
            // (a VxD), are told apart from the rest.
            return kind.system === 2 ? STATUS.INVALID_IMAGE_WIN_16
                : kind.system === 5 ? STATUS.INVALID_IMAGE_PROTECT : STATUS.INVALID_IMAGE_NE_FORMAT;
        default:
            // A PE32+ one on a 32-bit Windows is refused for its width before
            // its machine is read.
            if (kind.bits === 64 && !machine64)
            {
                return STATUS.INVALID_IMAGE_WIN_64;
            }
            return kind.bits === null || kind.machine !== IMAGE_MACHINES[kind.bits]
                ? STATUS.INVALID_IMAGE_FORMAT : null;
    }
}

/**
 * @param {MappingHost} host
 */
export function createMappingFunctions(host){
    /**
     * The watch a view's copy-on-write pages are written under (heap.js's
     * `ViewRegion.copies`): begun at the mapping when the view has such pages,
     * after its bytes are in, so only the program's writes are seen; else at
     * the first VirtualProtect that gives one.
     *
     * @param {number} address @param {number} length @param {boolean} now
     * @returns {import('./heap.js').ViewCopies}
     */
    const watchCopies = (address, length, now)=>({
        watch: now ? host.watchWrites?.(address, length) ?? null : undefined,
    });
    /**
     * Views handed out by MapViewOfFile, by the address the guest holds.
     *
     * Keyed by address because that is all UnmapViewOfFile is given -- it takes
     * no handle and no length, so everything needed to write the bytes back and
     * release the memory has to be findable from the pointer alone.
     *
     * @type {Map<number, { mapping: any, offset: number, length: number,
     *                      writable: boolean,
     *                      shared?: import('./shared-views.js').SharedView,
     *                      unwatch?: (() => void) | null }>}
     */
    const views = new Map();

    /**
     * The base of the view that holds an address, null for none: a native
     * unmap names a view by any address inside it.
     *
     * @param {number} address
     * @returns {number | null}
     */
    const viewHolding = address=>{
        if (views.has(address))
        {
            return address;
        }
        for (const [base, view] of views)
        {
            if (address > base && address < base + view.length)
            {
                return base;
            }
        }
        return null;
    };

    /**
     * The process a native call on a view names, by the handle it was given:
     * this one (the pseudo-handle, or a handle opened for its own id) or a
     * child; a handle naming no process, or one without PROCESS_VM_OPERATION,
     * answered as the status Windows gives.
     *
     * @param {number} process
     * @returns {number | { here: true } | { child: any }}
     */
    const processNamed = process=>{
        /** @type {import('./process-target.js').ProcessTarget} */
        const target = host.processTarget ? host.processTarget(process, PROCESS_VM_OPERATION)
            : (process >>> 0) === CURRENT_PROCESS ? { here: true } : { error: 6 };
        if ('error' in target)
        {
            return target.error === 5 ? STATUS.ACCESS_DENIED : STATUS.INVALID_HANDLE;
        }
        return target;
    };

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
        return (wide ? host.readWideString(wholeAddress(pointer), WHOLE_NAME * 2)
            : host.readCString(wholeAddress(pointer), WHOLE_NAME)) || null;
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
        if (!SECTION_PAGES.includes(page))
        {
            return { status: STATUS.INVALID_PAGE_PROTECTION };
        }
        const writable = WRITABLE_PAGES.includes(page);
        const asked = wholeAddress(sizeLow);
        if (!node)
        {
            // A mapping with no file must be told how big it is; there is
            // nothing else to derive a size from.
            return (flags & SEC_IMAGE) !== 0 ? { status: STATUS.INVALID_FILE_FOR_SECTION }
                : asked === 0 ? { status: STATUS.INVALID_PARAMETER }
                    : { node, writable, size: pageRound(asked),
                        attributes: (committing || SEC_COMMIT) | caching, protect: page };
        }
        const length = host.files.size?.(node) ?? 0;
        if ((flags & SEC_IMAGE) !== 0)
        {
            if (length < 2)
            {
                return { status: STATUS.INVALID_FILE_FOR_SECTION };
            }
            return settle(host.files.read(node, 0, length), file=>{
                const refused = imageRefusal(imageKind(file), host.machine64 === true);
                if (refused !== null)
                {
                    return { status: refused };
                }
                // Laid out by the loader, at the image's own base: each view
                // is moved to where it lands (`imageViewAt`).
                /** @type {{ bytes: Uint8Array, file: Uint8Array, image: any }} */
                let laid;
                try
                {
                    laid = mapImage(file, undefined, { wide: true });
                }
                catch {
                    return { status: STATUS.INVALID_IMAGE_FORMAT };
                }
                // A maximum size is the section's own, its views still the
                // whole image; one past the image is refused.
                if (asked > laid.bytes.length)
                {
                    return { status: STATUS.SECTION_TOO_BIG };
                }
                return { node, writable: false, size: laid.bytes.length,
                    ...asked !== 0 ? { maximum: asked } : {},
                    attributes: SEC_FILE | SEC_IMAGE, image: laid, protect: page };
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
        return { node, writable, size: asked || length, attributes: SEC_FILE | caching,
            writesFile: FILE_WRITING_PAGES.includes(page), protect: page };
    };

    /** @param {Section} section */
    const openSection = section=>{
        if (section.node)
        {
            // The section's own hold, taken now, is the hold its handle gives
            // back; without one it shares the file handle's node.
            const kind = (section.attributes & SEC_IMAGE) !== 0 ? 'image'
                : section.writesFile ? 'readwrite' : 'readonly';
            const own = host.files.section?.(section.node, kind) ?? null;
            if (own)
            {
                section.node = own;
            }
            else
            {
                host.files.retain(section.node);
            }
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
            // A directory has no bytes to map; a section asks no more of its
            // file than its handle was opened for: writing for a read-write
            // one, executing for an executable one.
            const page = protect & PAGE_MASK;
            const fileRights = opened ? host.handleAccess?.(file) ?? null : null;
            if (opened?.directory || (opened && opened.write === false
                    && FILE_WRITING_PAGES.includes(page))
                || (fileRights !== null && [0x20, 0x40, 0x80].includes(page)
                    && (fileRights & (FILE_EXECUTE | GENERIC_EXECUTE | GENERIC_ALL)) === 0))
            {
                return fail(ERROR_ACCESS_DENIED);
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
            return openNamed(found);
        },
    });

    /**
     * A handle of its own onto a section found by its name, which holds the
     * name and the file as long as it is open.
     *
     * @param {Section} found
     */
    const openNamed = found=>{
        host.namedObjects.reference(found);
        if (found.node)
        {
            host.files.retain(found.node);
        }
        return host.handles.open('mapping', found);
    };

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
                if ((attributes >>> 0) !== 0 && readDword(wholeAddress(attributes) + 8) !== 0)
                {
                    host.divergence?.('NtCreateSection',
                        'a named section is made without its name');
                }
                const size = (maximum >>> 0) === 0 ? [0, 0]
                    : [readDword(wholeAddress(maximum) + 4), readDword(wholeAddress(maximum))];
                return settle(makeSection(opened ? opened.node : null, page & PAGE_MASK,
                    flags || SEC_COMMIT, size[0], size[1]), made=>{
                    if ('status' in made)
                    {
                        return made.status;
                    }
                    writeDword(wholeAddress(out), openSection(made));
                    return STATUS.SUCCESS;
                });
            },
        },

        /**
         * NTSTATUS NtOpenSection(PHANDLE SectionHandle, ACCESS_MASK,
         *   POBJECT_ATTRIBUTES ObjectAttributes)
         *
         * A section made by name, as OpenFileMapping finds one: the name is
         * walked through the object namespace (`object-namespace.js`), and a
         * Win32 name found looked up as a Win32 call may have spelt it, bare
         * or after Global\ or Local\. \Device\PhysicalMemory, which a hardware
         * survey (Futuremark's SystemInfo) opens for the BIOS's tables, is
         * refused, as Windows has refused it to user mode since Server 2003
         * Service Pack 1.
         */
        NtOpenSection: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, , attributes])=>{
                if (wholeAddress(out) === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                const given = readObjectAttributes(host.readMemory, attributes);
                const walked = nameToWalk(given, true);
                if ('status' in walked || given === null || walked.name === null)
                {
                    return 'status' in walked ? walked.status : STATUS.INVALID_PARAMETER;
                }
                if (/^\\device\\physicalmemory$/i.test(walked.name))
                {
                    return STATUS.ACCESS_DENIED;
                }
                const name = host.namedObjects.keyOf(given, 'mapping');
                if (typeof name === 'number')
                {
                    return name;
                }
                for (const spelt of [name, `Global\\${name}`, `Local\\${name}`])
                {
                    const found = host.namedObjects.existing(spelt, 'mapping');
                    if (found === TAKEN)
                    {
                        return STATUS.OBJECT_TYPE_MISMATCH;
                    }
                    if (found)
                    {
                        writeDword(wholeAddress(out), openNamed(found));
                        return STATUS.SUCCESS;
                    }
                }
                return STATUS.OBJECT_NAME_NOT_FOUND;
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
            sizes: [3],
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
                if (wholeAddress(buffer) === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                const info = new Uint8Array(size);
                if (kind === SECTION_BASIC_INFORMATION)
                {
                    // BaseAddress, which only a based section has, Attributes, Size.
                    const fields = new DataView(info.buffer);
                    fields.setUint32(4, section.attributes >>> 0, true);
                    fields.setUint32(8, section.maximum ?? section.size, true);
                }
                else if (section.image)
                {
                    info.set(sectionImageInformation(section.image));
                }
                host.writeMemory(wholeAddress(buffer), info);
                writeDwordIf(wholeAddress(returned), size);
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
            sizes: [4],
            /** @param {number[]} args */
            handler: ([handle, process, base, , , offsetAt, sizeAt, , , page])=>{
                const section = sectionOf(handle);
                if (typeof section === 'number')
                {
                    return section;
                }
                const target = processNamed(process);
                if (typeof target === 'number')
                {
                    return target;
                }
                if (!('here' in target))
                {
                    host.divergence?.('NtMapViewOfSection',
                        'a view maps into this process only, not a child\'s');
                    return STATUS.NOT_SUPPORTED;
                }
                if (wholeAddress(base) === 0 || wholeAddress(sizeAt) === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                if (readDword(wholeAddress(base)) !== 0)
                {
                    host.divergence?.('NtMapViewOfSection',
                        'a view goes where there is room, not at the address asked for');
                }
                const offset = wholeAddress(offsetAt) === 0 ? 0 : readDword(wholeAddress(offsetAt));
                const length = readDword(wholeAddress(sizeAt)) || section.size - offset;
                if (length <= 0 || offset + length > section.size)
                {
                    return STATUS.INVALID_VIEW_SIZE;
                }
                return settle(table.MapViewOfFile.handler([handle, accessFor(page), 0, offset,
                    length]),
                /** @param {number} address */
                address=>{
                    if (address === 0)
                    {
                        return STATUS.NO_MEMORY;
                    }
                    writeDword(wholeAddress(base), address);
                    writeDword(wholeAddress(sizeAt), pageRound(length));
                    return section.image && address !== section.image.image.imageBase
                        ? STATUS.IMAGE_NOT_AT_BASE : STATUS.SUCCESS;
                });
            },
        },

        /**
         * NTSTATUS NtUnmapViewOfSection(HANDLE ProcessHandle, PVOID BaseAddress)
         *
         * Any address inside a view names it, not only its base. In a child
         * the call is made there, over its own views (`cross-process.js`).
         */
        NtUnmapViewOfSection: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([process, address])=>{
                const target = processNamed(process);
                if (typeof target === 'number')
                {
                    return target;
                }
                if (!('here' in target))
                {
                    const asked = askChild({ askChild: host.askChild, writeMemory: host.writeMemory,
                        currentThread: host.currentThread ?? (()=>null),
                        setLastErrorFor: host.setLastErrorFor ?? (()=>{}) },
                    target.child, { call: 'NtUnmapViewOfSection',
                        args: [CURRENT_PROCESS, wholeAddress(address)] }, []);
                    if (asked === null)
                    {
                        host.divergence?.('NtUnmapViewOfSection', 'a child the run cannot reach');
                        return STATUS.NOT_SUPPORTED;
                    }
                    return asked;
                }
                const base = viewHolding(wholeAddress(address));
                if (base === null)
                {
                    return STATUS.NOT_MAPPED_VIEW;
                }
                table.UnmapViewOfFile.handler([base]);
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
            returns: 'pointer',
            argBytes: 20,
            sizes: [4],
            /** @param {number[]} args */
            handler: ([handle, access, offsetHigh, offsetLow, length, base = 0])=>{
                if (offsetHigh !== 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const placed = wholeAddress(base);
                if (placed % ALLOCATION_GRANULARITY !== 0)
                {
                    return fail(ERROR_MAPPED_ALIGNMENT);
                }
                const mapping = object(handle, 'mapping');
                if (!mapping)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                // A view asks for no more than its section's protection allows
                // and its handle was granted; asking for nothing is reading.
                const needs = ((access >>> 0) & VIEW_RIGHTS) || FILE_MAP_READ;
                const granted = host.handleAccess?.(handle) ?? FILE_MAP_ALL_ACCESS;
                const rights = sectionRights(mapping.protect ?? 0x04)
                    & (granted | FILE_MAP_EXECUTE);
                if ((needs & rights) !== needs)
                {
                    return fail(ERROR_ACCESS_DENIED);
                }
                const offset = wholeAddress(offsetLow);
                const wanted = (length >>> 0) || Math.max(mapping.size - offset, 0);
                if (wanted === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }

                // At the address asked for, when one is and all of the view
                // fits there; anywhere on a granule, when none is -- Windows puts
                // every view on one, and a program that keeps its own windows over
                // a file unmaps at the granule it computed from the view's address
                // (a video encoder reading its input through views stopped after
                // two frames when its view began mid-granule).
                // An image's view goes to the image's own base when that is
                // free, as Windows places one - but for an image linked for
                // ASLR (DYNAMIC_BASE), which Windows moves wherever it likes:
                // the CLR maps an assembly so, then reserves the same base
                // for the native image it compiles of it.
                const preferred = placed === 0 && offset === 0 && !mapping.image?.image.dynamicBase
                    ? mapping.image?.image.imageBase ?? 0 : 0;
                const address = preferred !== 0 && host.allocateAt?.(preferred, wanted) ? preferred
                    : placed === 0 ? host.allocate(wanted, { alignment: ALLOCATION_GRANULARITY })
                        : host.allocateAt?.(placed, wanted) ? placed : 0;
                if (address === 0)
                {
                    return fail(placed === 0 ? ERROR_NOT_ENOUGH_MEMORY : ERROR_INVALID_ADDRESS);
                }

                // A copy-on-write section's view is written in memory alone:
                // its pages are the process's own copies, never the file's.
                const writable = (mapping.node ? mapping.writesFile === true : mapping.writable)
                    && ((access >>> 0) & (FILE_MAP_WRITE | FILE_MAP_ALL_ACCESS)) !== 0;
                const metrics = host.metrics;
                /** @param {Uint8Array} bytes */
                const deliver = bytes=>{
                    // Memory freed by an earlier view or block is handed out
                    // again as it was left: a page-file section's fresh view
                    // read an unmapped image's bytes, and the CLR took them for
                    // a code-page table another process had already filled.
                    if (bytes.length < wanted)
                    {
                        host.zero?.(address + bytes.length, wanted - bytes.length);
                    }
                    if (bytes.length > 0)
                    {
                        host.writeMemory(address, bytes);
                    }
                    /** @type {any} */
                    const view = { mapping, offset, length: wanted, writable };
                    // A page-file section's views see each other's writes,
                    // across processes as within one.
                    if (!mapping.node && host.sharedViews)
                    {
                        view.shared = { process: host.sharedViews.process, address,
                            offset, length: wanted, read: host.readMemory,
                            write: host.writeMemory };
                        host.sharedViews.shared.attach(mapping, mapping.size, view.shared);
                    }
                    // A section a service of the run owns (the Steam client's)
                    // is watched by it while the view stands.
                    view.unwatch = mapping.watch?.({
                        read: (/** @type {number} */ at, /** @type {number} */ count)=>
                            host.readMemory(address + at, count),
                        write: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>
                            host.writeMemory(address + at, data),
                        event: (/** @type {number} */ held)=>object(held, 'event'),
                        every: (/** @type {number} */ ms, /** @type {() => void} */ tick)=>
                            host.every?.(ms, tick) ?? (()=>{}),
                        pointerSize: host.pointerSize ?? 4,
                    }) ?? null;
                    views.set(address, view);
                    // An image's view is mapped PAGE_EXECUTE_WRITECOPY whatever
                    // was asked, each section with its own protection within it.
                    const image = mapping.image && offset === 0;
                    const protect = image ? PAGE_EXECUTE_WRITECOPY : viewProtection(access >>> 0);
                    const sections = image ? imageSections(mapping.image.image) : undefined;
                    host.viewRegions?.set(address, { length: wanted, writable, protect,
                        anonymous: !mapping.node, pages: new Map(),
                        copies: watchCopies(address, wanted,
                            sections ? sections.some(each=>copyOnWrite(each.protect))
                                : copyOnWrite(protect)),
                        ...sections ? { sections } : {} });
                    if (metrics)
                    {
                        metrics.views++;
                    }
                    return address;
                };

                // Read through to the file now. An anonymous mapping starts as
                // zeroes, which is what the allocator already gives, or as its
                // owner says it stands.
                if (!mapping.node)
                {
                    return deliver(mapping.contents?.().subarray(offset, offset + wanted)
                        ?? new Uint8Array(0));
                }
                if (mapping.image)
                {
                    // Held as a view of the file is, and given back at its unmap.
                    // The image moved to where its view starts.
                    const image = imageViewAt(mapping.image, address - offset);
                    host.files.retain(mapping.node);
                    return deliver(image.subarray(offset, offset + wanted));
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
                return /** @type {any} */ (arriving.then(deliver, reason=>{
                    const why = /** @type {any} */ (reason)?.message ?? String(reason);
                    host.divergence?.('MapViewOfFile',
                        `${wanted} bytes at ${offset} of the file did not arrive: ${why}`, 'loss');
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
         * LPVOID MapViewOfFileEx(HANDLE, DWORD dwDesiredAccess, DWORD dwFileOffsetHigh,
         *   DWORD dwFileOffsetLow, SIZE_T dwNumberOfBytesToMap, LPVOID lpBaseAddress)
         *
         * MapViewOfFile with the address the view is to start at: on an
         * allocation granule, else ERROR_MAPPED_ALIGNMENT, and refused with
         * ERROR_INVALID_ADDRESS when any of the range is taken. A null address
         * is anywhere.
         */
        MapViewOfFileEx: {
            returns: 'pointer',
            argBytes: 24,
            sizes: [4],
            /** @param {number[]} args */
            handler: args=>table.MapViewOfFile.handler(args),
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
                const view = views.get(wholeAddress(address));
                if (!view)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (view.writable && view.mapping.node)
                {
                    host.files.write(view.mapping.node, view.offset,
                        host.readMemory(wholeAddress(address), view.length));
                }
                if (view.mapping.node)
                {
                    host.files.close(view.mapping.node);
                }
                if (view.shared)
                {
                    host.sharedViews?.shared.detach(view.shared);
                }
                view.unwatch?.();
                views.delete(wholeAddress(address));
                host.viewRegions?.delete(wholeAddress(address));
                host.release(wholeAddress(address));
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
            sizes: [1],
            /** @param {number[]} args */
            handler: ([address, count])=>{
                const at = wholeAddress(address);
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
            handler: ([readHandle, writeHandle, attributes, size])=>{
                if (readHandle === 0 || writeHandle === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                // A named pipe nobody can name, as Windows makes one: it reads,
                // writes and breaks as the run's named pipes do.
                const made = host.pipes?.anonymous?.(wholeAddress(attributes),
                    (size >>> 0) || 4096);
                if (made)
                {
                    writeDword(wholeAddress(readHandle), made.read);
                    writeDword(wholeAddress(writeHandle), made.write);
                    return 1;
                }
                /** @type {{ buffered: number[], writersOpen: boolean }} */
                const pipe = { buffered: [], writersOpen: true };
                writeDword(wholeAddress(readHandle), host.handles.open('pipe-read', pipe));
                writeDword(wholeAddress(writeHandle), host.handles.open('pipe-write', pipe));
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
                // A named pipe's end is the pipes' to look into.
                const named = host.pipes?.peek([handle, buffer, size, read, available, left]);
                if (named !== undefined && named !== null)
                {
                    return named;
                }
                const pipe = object(handle, 'pipe-read');
                if (!pipe)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const total = pipe.buffered.length;
                const copied = Math.min(total, size >>> 0);
                if (buffer !== 0 && copied > 0)
                {
                    host.writeMemory(wholeAddress(buffer),
                        new Uint8Array(pipe.buffered.slice(0, copied)));
                }
                writeDwordIf(wholeAddress(read), copied);
                writeDwordIf(wholeAddress(available), total);
                // An anonymous pipe is a byte stream with no messages in it, so
                // there is never anything left of one.
                writeDwordIf(wholeAddress(left), 0);
                return 1;
            },
        },
    };
    return table;
}
