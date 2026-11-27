/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What an image holds that a process reads without running it: its resources
 * (strings, version, manifest) looked up where the image lies or in its file,
 * and the Windows its manifest says it knows (`compatibilityOf`).
 */

import {
    RT_STRING, findResource, listResources, loadString, stringInBundle,
} from '../layers/loader/internal/resources.js';
import { parsePe, rvaToFileOffset } from '../layers/loader/internal/pe.js';
import { programInPlaceOf } from '../layers/win32/programs/table.js';
import { RT_MANIFEST } from './libraries.js';
import { supportedOsOf } from '../layers/win32/kernel32/versions.js';

/**
 * How a program reaches a module's resources by the instance it holds.
 *
 * An HINSTANCE is the base a module was mapped at, and zero means the running
 * program -- which is what a program passes when it asks for its own strings,
 * dialogs and icons, which is nearly always. All three answers are made from
 * one lookup so that they cannot disagree about which module an instance
 * names: a resource found in one module and addressed relative to another's
 * base is a pointer into the wrong image.
 *
 * A library LoadLibraryEx mapped as data is no module, and its handle is its
 * base with a low bit set: one for a view of the file as it lies on disk, two
 * for one laid out as an image. The resource calls take that handle as they
 * take a module's, and in the file's own layout a resource lies at its file
 * offset from the base rather than at its RVA -- so that is the `rva` a data
 * file's lookup answers, since every caller adds it to the base.
 *
 * A mapped module's resources are read where it lies in memory, as Windows
 * reads them: a packed image's file names its string tables at addresses
 * that hold them only once its own code has unpacked them there. A module
 * keeps no copy of its file for them (`viewMemory`); one handed its file
 * (`file`) has its directory read from that.
 *
 * @param {() => any} main       The running program's module, once loaded.
 * @param {{ get: (base: number) => any }} byBase  Every mapped module by its base.
 * @param {Map<number, any>} [dataFiles]  Libraries mapped as data, by handle.
 * @param {(address: number, length: number) => Uint8Array} [readMemory]
 * @param {(address: number, length: number) => Uint8Array} [viewMemory]  Guest
 *     memory in place, for a walk done before anything else runs.
 */
export function resourceLookup(main, byBase, dataFiles = new Map(), readMemory, viewMemory){
    /** @param {number} instance */
    const moduleOf = instance=>{
        if (instance === 0)
        {
            return main();
        }
        return (instance & 3) !== 0
            ? dataFiles.get(instance >>> 0) ?? null
            : byBase.get(instance >>> 0) ?? null;
    };
    /**
     * Where a module's resource directory is read: its file when it kept
     * one, else its memory -- the file's own layout for a data file mapped
     * flat (`fileSize`), the image's for any other -- or nowhere.
     *
     * @param {any} module
     * @returns {Uint8Array | { mapped: Uint8Array } | null}
     */
    const sourceOf = module=>{
        if (module?.file)
        {
            return module.file;
        }
        if (!module?.image || !viewMemory)
        {
            return null;
        }
        try
        {
            const view = viewMemory(module.base,
                module.flat ? module.fileSize : module.image.sizeOfImage);
            return module.flat ? view : { mapped: view };
        }
        catch {
            // Its memory gone from under it: nothing mapped there now.
            return null;
        }
    };
    return {
        /** @param {number} instance @param {number} id */
        loadString: (instance, id)=>{
            const module = moduleOf(instance);
            const source = sourceOf(module);
            if (!module?.file || module.flat || !readMemory)
            {
                return source ? loadString(source, module.image, id) : null;
            }
            const found = findResource(module.file, module.image, RT_STRING,
                ((id >>> 0) >> 4) + 1);
            return found
                ? stringInBundle(readMemory(module.base + found.rva, found.size), id & 15)
                : null;
        },
        /**
         * Whether a module carries a resource, and where: what a cursor or
         * icon loaded out of the program's own image is checked against
         * before a handle to it is handed out.
         *
         * @param {number} instance @param {number} type @param {number | string} name
         * @param {number | null} [language]  Absent means the first language there is.
         */
        findResource: (instance, type, name, language = null)=>{
            const module = moduleOf(instance);
            const source = sourceOf(module);
            const found = source
                ? findResource(source, module.image, type, name, language)
                : null;
            if (!found || !module.flat)
            {
                return found;
            }
            try
            {
                return { ...found, rva: rvaToFileOffset(module.image, found.rva) };
            }
            catch {
                // Data outside every section: a file that describes a
                // resource it does not hold.
                return null;
            }
        },
        /**
         * Everything a module carries, for the enumerations: a program picks
         * its string table by language this way.
         *
         * @param {number} instance
         */
        listResources: instance=>{
            const module = moduleOf(instance);
            const source = sourceOf(module);
            return source ? listResources(source, module.image) : [];
        },
        /**
         * Where a module is mapped: the address a resource's RVA is relative
         * to. An instance that names no module is zero, and a caller adding
         * an RVA to that gets an address nothing is mapped at rather than one
         * inside the wrong module.
         *
         * @param {number} instance
         */
        moduleBase: instance=>moduleOf(instance)?.base ?? 0,
    };
}

/**
 * A library the engine synthesised, read out of guest memory as its file
 * would hold it: every page of its image, those nothing maps as zeros.
 *
 * @param {{ readBytes: (address: number, length: number) => Uint8Array }} memory
 * @param {{ base: number, size: number }} module
 * @returns {Uint8Array}
 */
export function imageInMemory(memory, module){
    const PAGE = 0x1000;
    const image = new Uint8Array(module.size);
    // A page at a time: a synthesised library is several regions (its code,
    // its .data), and one read across them runs off the first.
    for (let at = 0; at < module.size; at += PAGE)
    {
        try
        {
            image.set(memory.readBytes(module.base + at, Math.min(PAGE, module.size - at)), at);
        }
        catch (e){
            // A page the image reserves and nothing maps stays zeros, as its file has.
            if (/** @type {{ code?: unknown }} */ (e)?.code !== 'GUEST_ACCESS')
            {
                throw e;
            }
        }
    }
    return image;
}

/**
 * The version resource of a file on the volume, or null: for a file that is
 * not there, is not an image or carries none. A file of a bundle whose bytes
 * have not arrived answers with a promise: the blocks the read missed are
 * fetched and the walk made again, as ReadFile waits for its own, so the guest
 * call is parked until they are here. Without `blocks` such a file is null.
 *
 * Only the headers, the resource directory and the block itself are read: an
 * installer asks after every file it puts down, a gigabyte archive among them.
 *
 * @param {any} filesystem
 * @param {string} path
 * @param {{ fetch: (blocks: any) => Promise<unknown> } | null} [blocks]
 * @param {number} [tries]  Walks left: each of its reads may miss once.
 * @returns {Uint8Array | null | Promise<Uint8Array | null>}
 */
export function versionResourceOf(filesystem, path, blocks = null, tries = 4){
    const RT_VERSION = 16;
    const DIR_RESOURCE = 2;
    const HEADER_BYTES = 0x1000;
    let handle;
    try
    {
        handle = filesystem.open(path, { create: false });
    }
    catch {
        return null;
    }
    try
    {
        const size = filesystem.size(handle);
        /** @param {number} offset @param {number} length */
        const readAt = (offset, length)=>{
            filesystem.seek(handle, offset);
            return filesystem.read(handle, Math.max(0, Math.min(length, size - offset)));
        };
        /** @param {Uint8Array} bytes */
        const viewOf = bytes=>new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let head = readAt(0, HEADER_BYTES);
        const peOffset = head.length >= 0x40 ? viewOf(head).getUint32(0x3c, true) : 0;
        if (peOffset + 24 > head.length && head.length < size)
        {
            head = readAt(0, peOffset + HEADER_BYTES);
        }
        // The section table ends the headers: the file header's counts say where.
        if (peOffset + 24 <= head.length)
        {
            const end = peOffset + 24 + viewOf(head).getUint16(peOffset + 20, true)
                + viewOf(head).getUint16(peOffset + 6, true) * 40;
            if (end > head.length && head.length < size)
            {
                head = readAt(0, end);
            }
        }
        const image = parsePe(head, { wide: true });
        const directory = image.directories[DIR_RESOURCE];
        if (!directory || directory.size === 0)
        {
            return null;
        }
        // The directory alone, as a section of its own starting at its first
        // byte: every offset the walk follows is inside it, and the leaf it
        // ends at names the block's place in the file.
        const tree = readAt(rvaToFileOffset(image, directory.address), directory.size);
        const found = findResource(tree, {
            ...image,
            sizeOfHeaders: 0,
            sections: [{ name: '.rsrc', virtualAddress: directory.address,
                virtualSize: directory.size, rawSize: directory.size, rawOffset: 0,
                readable: true, writable: false, executable: false, characteristics: 0x40000040 }],
        }, RT_VERSION, 1);
        if (!found)
        {
            return null;
        }
        const block = readAt(rvaToFileOffset(image, found.rva), found.size);
        return block.length === found.size ? block : null;
    }
    catch (e){
        const miss = /** @type {any} */ (e);
        if (miss?.code === 'BLOCK_MISS' && blocks && tries > 0)
        {
            return blocks.fetch(miss.blocks)
                .then(()=>versionResourceOf(filesystem, path, blocks, tries - 1), ()=>null);
        }
        return null;
    }
    finally
    {
        filesystem.close(handle);
    }
}

/**
 * What a program's own image says about the Windows it was written for: the
 * supportedOS elements of its manifest (RT_MANIFEST 1, the one CreateProcess
 * reads) and the operating system version its PE header names. Windows 10
 * answers the program's version calls from these.
 *
 * @param {Uint8Array} executable
 * @returns {import('../layers/win32/kernel32/versions.js').ProgramCompatibility}
 */
export function compatibilityOf(executable){
    const image = parsePe(executable, { wide: true });
    const view = new DataView(executable.buffer, executable.byteOffset, executable.byteLength);
    // MajorOperatingSystemVersion and its minor, forty bytes into the optional
    // header that follows the signature and the file header.
    const optional = view.getUint32(0x3c, true) + 24;
    const imageVersion = {
        major: view.getUint16(optional + 40, true),
        minor: view.getUint16(optional + 42, true),
    };
    const found = findResource(executable, image, RT_MANIFEST, 1);
    if (!found)
    {
        return { supportedOS: [], imageVersion };
    }
    const at = rvaToFileOffset(image, found.rva);
    const bytes = executable.subarray(at, at + found.size);
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : 'utf-8';
    return { supportedOS: supportedOsOf(new TextDecoder(encoding).decode(bytes)), imageVersion };
}

/**
 * A child's image as it stands when CreateProcess is called, read at once, or
 * null when any of it is not here yet (it is then read when the child starts,
 * from a volume nothing of the run changes it on). Windows maps the image then:
 * a setup that copies itself to a temporary file opened delete-on-close,
 * starts the copy and exits has the file gone by the time a later read looks.
 *
 * @param {any} filesystem @param {string} path
 * @returns {Uint8Array | null}
 */
export function readImageNow(filesystem, path){
    let handle;
    try
    {
        handle = filesystem.open(path, { create: false });
    }
    catch {
        return null;
    }
    try
    {
        const size = filesystem.size(handle);
        const bytes = new Uint8Array(size);
        for (let at = 0; at < size;)
        {
            const chunk = filesystem.read(handle, size - at);
            if (chunk.length === 0)
            {
                return bytes.subarray(0, at);
            }
            bytes.set(chunk, at);
            at += chunk.length;
        }
        return programInPlaceOf(bytes) ?? bytes;
    }
    catch {
        return null;
    }
    finally
    {
        filesystem.close(handle);
    }
}
