/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { expand } from '../lz32/expand.js';

/**
 * version — what a file says about itself.
 *
 * The three calls are one operation split in three: ask how big the block is,
 * copy it into memory you own, then query fields out of the copy. The block is
 * a resource of type 16 in the file's own image, and the third call walks the
 * copy rather than the file -- which is why `VerQueryValueA` answers with a
 * pointer *into* the caller's buffer and never copies anything.
 *
 * The block is a tree of nodes that all share one shape, and the shape is the
 * only thing worth knowing here: a length, a value length, a type flag, a
 * null-terminated UTF-16 key, and then the value and the children, each aligned
 * up to the next dword. The alignment is where a reader goes wrong -- a key of
 * an even number of characters still needs a pad, and skipping it lands the
 * walk two bytes into the value it was looking for.
 *
 * One asymmetry has to be carried faithfully: `wValueLength` counts bytes for a
 * binary value and *characters* for a text one. A caller reading a string uses
 * the length this reports, so getting it wrong truncates every version string
 * by half or doubles it into whatever follows.
 */

/** The signature at the head of a VS_FIXEDFILEINFO, which the root's value is. */
const VS_FFI_SIGNATURE = 0xfeef04bd;

/** VS_FIXEDFILEINFO is this long, and a caller sizes its own copy from it. */
const FIXED_FILE_INFO_SIZE = 52;

/** VerInstallFile return flags; zero is success. */
const VIF_CANNOTCREATE = 0x00000004;
const VIF_CANNOTREADSRC = 0x00000040;

/**
 * @typedef {Object} VersionHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(code: number) => void} setLastError
 * @property {(path: string) => Uint8Array | null} [versionInfo]
 *           The raw version resource of the named file, or null when there is
 *           none. Absent in a build with no loader behind it, which then
 *           answers as a file that carries no version information -- a size of
 *           zero, which is exactly what a caller checks.
 * @property {import('../kernel32/files.js').FileSystem} [files]
 *           The volume VerInstallFile reads its source from and writes its
 *           destination to. Absent, VerInstallFile reports it cannot create
 *           the file (VIF_CANNOTCREATE), which is a documented failure.
 */

const ERROR_RESOURCE_TYPE_NOT_FOUND = 1813;

/** A path is at most this long; longer is a pointer that is not a string. */
const MAX_PATH = 260;

/** @param {Uint8Array} block @param {number} at */
const u16 = (block, at)=>block[at] | block[at + 1] << 8;

/** @param {number} value */
const dword = value=>new Uint8Array([
    value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
]);

/** Rounds up to the next dword, which every part of this structure sits on. */
const aligned = (/** @type {number} */ at)=>at + 3 & ~3;

/**
 * One node of the tree, and where its parts are.
 *
 * @param {Uint8Array} block
 * @param {number} at
 * @returns {{ length: number, valueLength: number, type: number, key: string,
 *             value: number, children: number, end: number } | null}
 */
function readNode(block, at){
    if (at + 6 > block.length)
    {
        return null;
    }
    const length = u16(block, at);
    const valueLength = u16(block, at + 2);
    const type = u16(block, at + 4);
    if (length < 6 || at + length > block.length)
    {
        return null;
    }

    let cursor = at + 6;
    let key = '';
    while (cursor + 1 < at + length)
    {
        const unit = u16(block, cursor);
        cursor += 2;
        if (unit === 0)
        {
            break;
        }
        key += String.fromCharCode(unit);
    }

    const value = aligned(cursor);
    // Text values count characters, binary ones count bytes. Everything after
    // the value is a child, so this asymmetry decides where the children start.
    const valueBytes = type === 1 ? valueLength * 2 : valueLength;
    return {
        length,
        valueLength,
        type,
        key,
        value,
        children: aligned(value + valueBytes),
        end: at + length,
    };
}

/**
 * Walks a path of keys down the tree.
 *
 * @param {Uint8Array} block
 * @param {string[]} path
 * @returns {ReturnType<typeof readNode>}
 */
function find(block, path){
    let node = readNode(block, 0);
    for (const step of path)
    {
        if (!node)
        {
            return null;
        }
        let at = node.children;
        /** @type {ReturnType<typeof readNode>} */
        let found = null;
        while (at < node.end)
        {
            const child = readNode(block, at);
            if (!child)
            {
                break;
            }
            if (child.key.toLowerCase() === step.toLowerCase())
            {
                found = child;
                break;
            }
            // A node of no length would make this loop for ever on a block that
            // is merely damaged rather than hostile.
            at = aligned(child.end);
            if (child.length === 0)
            {
                break;
            }
        }
        node = found;
    }
    return node;
}

/**
 * @param {VersionHost} host
 */
export function createVersionFunctions(host){
    /** @param {number} address */
    const resourceFor = address=>{
        const path = host.readCString(address >>> 0, MAX_PATH);
        return host.versionInfo?.(path) ?? null;
    };

    return {
        /**
         * DWORD GetFileVersionInfoSizeA(LPCSTR lptstrFilename, LPDWORD lpdwHandle)
         *
         * Zero means the file carries no version information, which is a fact
         * about plenty of real files and something every caller checks.
         */
        GetFileVersionInfoSizeA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([filename, handle])=>{
                if ((handle >>> 0) !== 0)
                {
                    // Documented as always zero, and a caller passes it back to
                    // GetFileVersionInfo, so leaving it unwritten leaves it
                    // whatever the caller's stack happened to hold.
                    host.writeMemory(handle >>> 0, dword(0));
                }
                const resource = resourceFor(filename);
                if (!resource)
                {
                    host.setLastError(ERROR_RESOURCE_TYPE_NOT_FOUND);
                    return 0;
                }
                return resource.length;
            },
        },

        /**
         * BOOL GetFileVersionInfoA(LPCSTR lptstrFilename, DWORD dwHandle,
         *                          DWORD dwLen, LPVOID lpData)
         */
        GetFileVersionInfoA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([filename, , length, data])=>{
                const resource = resourceFor(filename);
                if (!resource)
                {
                    host.setLastError(ERROR_RESOURCE_TYPE_NOT_FOUND);
                    return 0;
                }
                if ((length >>> 0) < resource.length)
                {
                    host.setLastError(ERROR_RESOURCE_TYPE_NOT_FOUND);
                    return 0;
                }
                host.writeMemory(data >>> 0, resource);
                return 1;
            },
        },

        /**
         * BOOL VerQueryValueA(LPCVOID pBlock, LPCSTR lpSubBlock,
         *                     LPVOID *lplpBuffer, PUINT puLen)
         *
         * Answers with a pointer into the caller's own block rather than a copy,
         * which is why the block has to stay alive for as long as the answer is
         * used -- the caller's problem, and the documented contract.
         */
        VerQueryValueA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([blockAddress, subBlock, buffer, length])=>{
                const query = host.readCString(subBlock >>> 0, MAX_PATH);
                // The head says how long the block is, and the block has to be
                // read whole before it can be walked -- reading the head alone
                // and asking it to parse itself fails its own bounds check.
                const head = host.readMemory(blockAddress >>> 0, 2);
                const total = head[0] | head[1] << 8;
                if (total < 6)
                {
                    return 0;
                }
                const block = host.readMemory(blockAddress >>> 0, total);

                const path = query.split('\\').filter(step=>step.length > 0);
                const node = find(block, path);
                if (!node || node.valueLength === 0)
                {
                    return 0;
                }

                // The root's value is the fixed information, and its length is
                // the structure's rather than whatever the block claims -- a
                // caller copies exactly this many bytes out of it.
                const isRoot = path.length === 0;
                if (isRoot && node.value + 4 <= block.length)
                {
                    const signature = block[node.value] | block[node.value + 1] << 8
                        | block[node.value + 2] << 16 | block[node.value + 3] << 24;
                    if ((signature >>> 0) !== VS_FFI_SIGNATURE)
                    {
                        return 0;
                    }
                }

                host.writeMemory(buffer >>> 0,
                    dword((blockAddress >>> 0) + node.value));
                host.writeMemory(length >>> 0, dword(
                    isRoot ? FIXED_FILE_INFO_SIZE : node.valueLength));
                return 1;
            },
        },

        /**
         * DWORD VerInstallFileA(DWORD uFlags, LPCSTR szSrcFileName,
         *   LPCSTR szDestFileName, LPCSTR szSrcDir, LPCSTR szDestDir,
         *   LPCSTR szCurDir, LPSTR szTmpFile, PUINT lpuTmpFileLen)
         *
         * Installs a file, expanding it if the COMPRESS tool packed it: the
         * source is read from szSrcDir, LZ-expanded when it carries the SZDD
         * header, and written to szDestDir under szDestFileName. Zero is
         * success, and the flags a caller acts on are the failures -- it could
         * not be read (VIF_CANNOTREADSRC) or could not be written
         * (VIF_CANNOTCREATE).
         *
         * The version checks the full API performs (comparing an existing
         * destination's version, forcing or refusing) are not made: there is
         * one user installing into an empty prefix, so the file is always
         * installed. The temp-file handshake is likewise skipped -- the file
         * is put at its final name and no temp is left for the caller to
         * rename -- which is the branch a caller takes when the return is zero.
         */
        VerInstallFileA: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([, srcName, destName, srcDir, destDir, , tmpFile, tmpLen])=>{
                if (!host.files)
                {
                    return VIF_CANNOTCREATE;
                }
                /** @param {number} dir @param {number} name */
                const join = (dir, name)=>{
                    const base = host.readCString(dir >>> 0, MAX_PATH);
                    const leaf = host.readCString(name >>> 0, MAX_PATH);
                    return base === '' ? leaf : `${base.replace(/[\\/]+$/, '')}\\${leaf}`;
                };
                const source = join(srcDir, srcName);
                const destination = join(destDir, destName);

                const stat = host.files.stat(source);
                if (!stat || !stat.exists || stat.isDirectory)
                {
                    return VIF_CANNOTREADSRC;
                }
                const input = host.files.open(source, { read: true });
                if (!input)
                {
                    return VIF_CANNOTREADSRC;
                }
                const raw = host.files.read(input, 0, stat.size);
                host.files.close(input);
                // A temp file the installer copied in is always resident, so a
                // promise here would be a source on a bundle -- which
                // VerInstallFile is never asked to expand. Refuse rather than
                // guess at a partial read.
                if (typeof (/** @type {any} */ (raw))?.then === 'function')
                {
                    return VIF_CANNOTREADSRC;
                }
                const expanded = expand(/** @type {Uint8Array} */ (raw));

                const output = host.files.open(destination,
                    { write: true, create: true, truncate: true });
                if (!output)
                {
                    return VIF_CANNOTCREATE;
                }
                host.files.write(output, 0, expanded);
                host.files.close(output);

                // The temp-file out-parameters name no temp file, because none
                // was left: an empty string and a length of zero, which is what
                // a caller reads when the install completed on its own.
                if ((tmpFile >>> 0) !== 0)
                {
                    host.writeMemory(tmpFile >>> 0, new Uint8Array([0]));
                }
                if ((tmpLen >>> 0) !== 0)
                {
                    host.writeMemory(tmpLen >>> 0, dword(0));
                }
                return 0;
            },
        },
    };
}
