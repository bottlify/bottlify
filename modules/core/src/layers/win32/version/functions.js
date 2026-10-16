/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { expand } from '../lz32/expand.js';
import { windowsVersion } from '../kernel32/versions.js';
import { DIRECTX_VERSION } from '../advapi32/registry.js';
import { encodeAnsi } from '../kernel32/locale.js';
import { verLanguageName } from '../kernel32/languages.js';

/**
 * version — what a file says about itself.
 *
 * The three calls are one operation split in three: ask how big the block is,
 * copy it into memory you own, then query fields out of the copy. The block is
 * a resource of type 16 in the file's own image, and the third call walks the
 * copy rather than the file -- which is why `VerQueryValue` answers with a
 * pointer *into* the caller's buffer.
 *
 * The block is UTF-16 whichever spelling copied it, and `VerQueryValueA` owes
 * its caller an ANSI string. That is what the size the first call reports
 * leaves room for: past the block itself, a four-byte mark and then scratch
 * space half the block's length, where each text value's ANSI form is written
 * at half its own offset -- so no two values' copies overlap, and asking for
 * one twice writes it to the same place. A caller that copied the block into
 * less room than that gets the conversion in place, over the UTF-16 value.
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
const VIF_SRCOLD = 0x00000004;
const VIF_CANNOTCREATE = 0x00000800;
const VIF_CANNOTREADSRC = 0x00010000;
/** And what it is asked with. */
const VIFF_FORCEINSTALL = 0x00000001;

/** VerFindFile: a shared file belongs in the system directory, not the program's. */
const VFFF_ISSHAREDFILE = 0x0001;
/** Its answers, or'd; zero is "put it where recommended". */
const VFF_CURNEDEST = 0x0001;
const VFF_BUFFTOOSMALL = 0x0004;

/** Where a shared file is looked for and recommended to go. */
const WINDOWS_DIRECTORY = 'C:\\WINDOWS';
const SYSTEM_DIRECTORY = 'C:\\WINDOWS\\system32';

/**
 * What `GetFileVersionInfoA` leaves after the block when the caller gave room
 * for the ANSI scratch space behind it -- "FE2X", as Windows marks it.
 */
const ROOM_MARK = new Uint8Array([0x46, 0x45, 0x32, 0x58]);

/** How much room past a block of `total` bytes its ANSI answers need. */
const scratchFor = (/** @type {number} */ total)=>ROOM_MARK.length + Math.ceil(total / 2);

/** Where the fixed information keeps the file's own version. */
const FIXED_FILE_VERSION_MS = 8;
const FIXED_FILE_VERSION_LS = 12;

/**
 * @typedef {Object} VersionHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} [readWideString]
 *           For the W spellings; without it they read an empty path.
 * @property {(code: number) => void} setLastError
 * @property {(thread: unknown, code: number) => void} [setLastErrorFor]
 *           The last error of a named thread: what a call answered after a
 *           wait sets, the thread on the processor then being somebody else.
 * @property {() => unknown} [currentThread]
 * @property {(path: string) => Uint8Array | null | Promise<Uint8Array | null>} [versionInfo]
 *           The raw version resource of the named file, or null when there is
 *           none; a promise while the file's bytes are still coming. Absent in
 *           a build with no loader behind it, which then answers as a file
 *           that carries no version information -- a size of zero, which is
 *           exactly what a caller checks.
 * @property {import('../kernel32/files.js').FileSystem} [files]
 *           The volume VerInstallFile reads its source from and writes its
 *           destination to. Absent, VerInstallFile reports it cannot create
 *           the file (VIF_CANNOTCREATE), which is a documented failure.
 * @property {(name: string) => boolean} [systemLibrary]
 *           Whether the engine answers for a library of this file name
 *           itself, with no file behind it. Absent, it answers for none, and
 *           such a library reads as a file that is not there.
 * @property {import('../kernel32/versions.js').WindowsVersion} [windows]
 * @property {string} [directx]  The DirectX version a DirectX library's file names.
 *           The Windows the machine is, whose version its own libraries carry
 *           -- the real one, even where GetVersionEx is told to answer an older
 *           one, since a file's version is the file's. Absent, the default.
 */

/**
 * The DirectX components, whose files carry DirectX's version rather than the
 * system's.
 */
const DIRECTX_LIBRARY =
    /^(ddraw|d3d\w*|dsound|dinput8?|dplay\w*|dpn\w*|dm\w+|dswave|dxdiag\w*|xinput\w*|dsetup)\.dll$/i;

/**
 * The 16-bit subsystem's modules, in the system directory of every 32-bit
 * Windows. Nothing here runs them, but their version block is there to read,
 * and a setup takes the system's language from user.exe's.
 */
const WIN16_SYSTEM_FILE = /^(user|gdi|krnl386)\.exe$/i;

/** VS_FIXEDFILEINFO's constants: its version, the flags it may set, NT, a DLL. */
const VS_FFI_STRUCVERSION = 0x00010000;
const VS_FFI_FILEFLAGSMASK = 0x0000003f;
const VOS_NT_WINDOWS32 = 0x00040004;
const VFT_DLL = 2;

/** US English in UTF-16, the one translation the block carries. */
const TRANSLATION = '040904B0';

/** @param {string} text */
const utf16 = text=>{
    const bytes = new Uint8Array(text.length * 2);
    for (let at = 0; at < text.length; at++)
    {
        bytes[at * 2] = text.charCodeAt(at) & 0xff;
        bytes[at * 2 + 1] = text.charCodeAt(at) >>> 8;
    }
    return bytes;
};

/**
 * One node of a version block, laid out as `readNode` walks one: a text value
 * counted in characters, a binary one in bytes, and every part on a dword.
 *
 * @param {string} key @param {Uint8Array | string | null} value
 * @param {Uint8Array[]} [children]
 * @returns {Uint8Array}
 */
function buildNode(key, value, children = []){
    const text = typeof value === 'string';
    const bytes = text ? utf16(`${value}\0`) : value ?? new Uint8Array(0);
    const valueAt = aligned(6 + (key.length + 1) * 2);
    let end = valueAt + bytes.length;
    const offsets = children.map(child=>{
        const at = aligned(end);
        end = at + child.length;
        return at;
    });
    const node = new Uint8Array(end);
    const view = new DataView(node.buffer);
    view.setUint16(0, end, true);
    view.setUint16(2, text ? value.length + 1 : bytes.length, true);
    view.setUint16(4, text ? 1 : 0, true);
    node.set(utf16(key), 6);
    node.set(bytes, valueAt);
    children.forEach((child, index)=>node.set(child, offsets[index]));
    return node;
}

/**
 * The version block of a library the engine answers for: the system's version
 * for a system library, the release's own for a file it describes -- XP's
 * DirectX among them -- and for any other DirectX component the DirectX the
 * registry says is installed, as on a system the redistributable installed it.
 *
 * @param {string} name  The file name, extension included.
 * @param {import('../kernel32/versions.js').WindowsVersion} [windows]  The system.
 * @param {string} [directx]  The DirectX version the bottle reports.
 * @returns {Uint8Array}
 */
export function systemVersionResource(
    name, windows = windowsVersion(), directx = DIRECTX_VERSION,
)
{
    const directX = DIRECTX_LIBRARY.test(name);
    const component = windows.components?.files[name.toLowerCase()] ?? null;
    const system = [windows.major, windows.minor, windows.build, 0];
    // A file the release describes carries its version there -- on XP, the
    // DirectX that is part of the system -- and any other DirectX library the
    // DirectX the bottle reports, as Windows 2000's redistributable left it.
    const own = component ?? (directX ? directx : null);
    const quad = own !== null ? own.split('.').map(part=>Number(part)) : system;
    const spelled = own ?? system.join('.');
    const fixed = new Uint8Array(FIXED_FILE_INFO_SIZE);
    const view = new DataView(fixed.buffer);
    const most = (quad[0] << 16 | quad[1]) >>> 0;
    const least = (quad[2] << 16 | quad[3]) >>> 0;
    [VS_FFI_SIGNATURE, VS_FFI_STRUCVERSION, most, least, most, least, VS_FFI_FILEFLAGSMASK, 0,
        VOS_NT_WINDOWS32, VFT_DLL].forEach((field, index)=>view.setUint32(index * 4, field, true));
    return buildNode('VS_VERSION_INFO', fixed, [
        buildNode('StringFileInfo', null, [buildNode(TRANSLATION, null, [
            buildNode('FileVersion', spelled),
            buildNode('InternalName', name.replace(/\.[^.]*$/, '')),
            buildNode('OriginalFilename', name),
            buildNode('ProductVersion', spelled),
        ])]),
        buildNode('VarFileInfo', null, [
            buildNode('Translation', Uint8Array.of(0x09, 0x04, 0xb0, 0x04)),
        ]),
    ]);
}

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_RESOURCE_DATA_NOT_FOUND = 1812;
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
 * The file version a block carries, as one comparable number, or null when
 * the block has no fixed information to read it from.
 *
 * @param {Uint8Array | null} block
 */
export function fileVersionOf(block){
    const root = block ? readNode(block, 0) : null;
    if (!block || !root || root.value + FIXED_FILE_INFO_SIZE > block.length)
    {
        return null;
    }
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    if (view.getUint32(root.value, true) !== VS_FFI_SIGNATURE)
    {
        return null;
    }
    return view.getUint32(root.value + FIXED_FILE_VERSION_MS, true) * 0x1_0000_0000
        + view.getUint32(root.value + FIXED_FILE_VERSION_LS, true);
}

/**
 * A text the block's first string table holds under a key -- `CompanyName`,
 * `OriginalFilename` -- whatever language that table is in; null when there
 * is none.
 *
 * @param {Uint8Array} block @param {string} key
 */
export function versionStringOf(block, key){
    const tables = find(block, ['StringFileInfo']);
    const table = tables && tables.children < tables.end ? readNode(block, tables.children) : null;
    const entry = table && find(block, ['StringFileInfo', table.key, key]);
    if (!entry || entry.type !== 1)
    {
        return null;
    }
    let text = '';
    for (let at = entry.value; at + 1 < entry.end; at += 2)
    {
        const unit = u16(block, at);
        if (unit === 0)
        {
            break;
        }
        text += String.fromCharCode(unit);
    }
    return text;
}

/**
 * @param {VersionHost} host
 */
export function createVersionFunctions(host){
    /**
     * Continues with an answer that may still be on its way, as a file's
     * version is while its bytes are.
     *
     * @template T
     * @param {T | Promise<T>} value @param {(answer: T) => any} next
     * @returns {any}
     */
    const after = (value, next)=>(typeof (/** @type {any} */ (value))?.then === 'function'
        ? /** @type {Promise<T>} */ (value).then(next)
        : next(/** @type {T} */ (value)));

    /**
     * The last-error setter of the call being answered, named before anything
     * is awaited: once a file's bytes have come, the thread that asked is no
     * longer the one on the processor.
     *
     * @returns {(code: number) => void}
     */
    const errorSetter = ()=>{
        const owner = host.currentThread?.() ?? null;
        return code=>(host.setLastErrorFor
            ? host.setLastErrorFor(owner, code)
            : host.setLastError(code));
    };

    /**
     * The file name of a library the engine answers for, when the path would
     * find it there -- a bare name, or one in the system directory -- or
     * null. A name with no extension is a DLL, as LoadLibrary takes it.
     *
     * @param {string} path
     */
    const systemName = path=>{
        const slash = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
        const directory = slash < 0 ? '' : path.slice(0, slash);
        const file = path.slice(slash + 1);
        const name = file.includes('.') ? file : `${file}.dll`;
        return (directory === '' || directory.toLowerCase() === SYSTEM_DIRECTORY.toLowerCase())
            && file !== '' && (host.systemLibrary?.(name) || WIN16_SYSTEM_FILE.test(name)
                || (host.windows ?? windowsVersion()).components?.files[name.toLowerCase()]
                    !== undefined)
            ? name : null;
    };

    /**
     * The file's version resource, or null with the last error already set --
     * ERROR_FILE_NOT_FOUND when the file itself is not there (what
     * GetFileAttributes reports, which real GetFileVersionInfoSize falls back
     * to once loading the path as a module fails), ERROR_RESOURCE_DATA_NOT_FOUND
     * when the file exists but carries no VS_VERSION_INFO resource. Without a
     * filesystem behind this build there is no way to tell the two apart, so a
     * missing resource reads as an ordinary file with no version information.
     *
     * @param {string} path @param {(code: number) => void} fail
     * @returns {Uint8Array | null | Promise<Uint8Array | null>}
     */
    const resourceFor = (path, fail)=>after(host.versionInfo?.(path) ?? null, resource=>{
        if (resource)
        {
            return resource;
        }
        const exists = host.files ? (host.files.stat(path)?.exists ?? false) : true;
        const library = exists ? null : systemName(path);
        if (library !== null)
        {
            return systemVersionResource(library, host.windows, host.directx);
        }
        fail(exists ? ERROR_RESOURCE_DATA_NOT_FOUND : ERROR_FILE_NOT_FOUND);
        return null;
    });

    /** @param {number} address */
    const narrow = address=>host.readCString(address >>> 0, MAX_PATH);
    /** @param {number} address */
    const wide = address=>host.readWideString?.(address >>> 0, MAX_PATH) ?? '';

    /**
     * GetFileVersionInfoSize, for either spelling: the block and the room its
     * ANSI answers take behind it, which is the same for both.
     *
     * @param {string} path @param {number} handle
     */
    const sizeOf = (path, handle)=>{
        if ((handle >>> 0) !== 0)
        {
            // Documented as always zero, and a caller passes it back to
            // GetFileVersionInfo, so leaving it unwritten leaves it whatever
            // the caller's stack happened to hold.
            host.writeMemory(handle >>> 0, dword(0));
        }
        return after(resourceFor(path, errorSetter()), resource=>
            (resource ? resource.length + scratchFor(resource.length) : 0));
    };

    /**
     * GetFileVersionInfo, for either spelling. The block goes in as it is; the
     * mark behind it says whether there is room for ANSI answers, and only
     * the ANSI spelling needs them.
     *
     * @param {string} path @param {number} length @param {number} data
     * @param {boolean} ansi
     */
    const copyInto = (path, length, data, ansi)=>{
        const fail = errorSetter();
        return after(resourceFor(path, fail), resource=>{
            if (!resource)
            {
                return 0;
            }
            if ((length >>> 0) < resource.length)
            {
                fail(ERROR_RESOURCE_TYPE_NOT_FOUND);
                return 0;
            }
            host.writeMemory(data >>> 0, resource);
            if (ansi && (length >>> 0) >= resource.length + scratchFor(resource.length))
            {
                host.writeMemory((data >>> 0) + resource.length, ROOM_MARK);
            }
            return 1;
        });
    };

    /**
     * VerQueryValue, for either spelling: walks the caller's block for the
     * path and answers with where the value is and how long.
     *
     * @param {number} blockAddress @param {string} subBlock
     * @param {number} buffer @param {number} length @param {boolean} ansi
     */
    const query = (blockAddress, subBlock, buffer, length, ansi)=>{
        // The head says how long the block is, and the block has to be read
        // whole before it can be walked -- reading the head alone and asking
        // it to parse itself fails its own bounds check.
        const base = blockAddress >>> 0;
        const head = host.readMemory(base, 2);
        const total = head[0] | head[1] << 8;
        if (total < 6)
        {
            return 0;
        }
        const block = host.readMemory(base, total);

        const path = subBlock.split('\\').filter(step=>step.length > 0);
        const node = find(block, path);
        if (!node || node.valueLength === 0)
        {
            return 0;
        }

        // The root's value is the fixed information, and its length is the
        // structure's rather than whatever the block claims -- a caller copies
        // exactly this many bytes out of it.
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

        let answer = base + node.value;
        if (ansi && node.type === 1)
        {
            // In the ANSI page, as WideCharToMultiByte(CP_ACP) writes it, a
            // character the page has no byte for as the default character.
            let units = '';
            for (let index = 0; index < node.valueLength; index++)
            {
                const unit = u16(block, node.value + index * 2);
                if (unit === 0)
                {
                    break;
                }
                units += String.fromCharCode(unit);
            }
            const text = new Uint8Array(node.valueLength);
            text.set(encodeAnsi(units));
            const mark = host.readMemory(base + total, ROOM_MARK.length);
            const roomy = mark.every((byte, index)=>byte === ROOM_MARK[index]);
            answer = roomy ? base + total + ROOM_MARK.length + (node.value >>> 1) : answer;
            host.writeMemory(answer, text);
        }
        host.writeMemory(buffer >>> 0, dword(answer));
        host.writeMemory(length >>> 0, dword(isRoot ? FIXED_FILE_INFO_SIZE : node.valueLength));
        return 1;
    };

    /** @param {string} base @param {string} leaf */
    const joinPath = (base, leaf)=>
        base === '' ? leaf : `${base.replace(/[\\/]+$/, '')}\\${leaf}`;

    /**
     * Writes a directory answer the way VerFindFile does: the text as far as
     * the buffer holds, and the length the buffer needed, terminator included,
     * where the caller passed its own length in.
     * @param {number} buffer @param {number} lengthAt @param {string} text
     * @returns {number} VFF_BUFFTOOSMALL when the buffer was short, else 0
     */
    const writeDirectory = (buffer, lengthAt, text)=>{
        if ((lengthAt >>> 0) === 0)
        {
            return 0;
        }
        const room = host.readMemory(lengthAt >>> 0, 4);
        const have = (room[0] | room[1] << 8 | room[2] << 16 | room[3] << 24) >>> 0;
        const needed = text.length + 1;
        if ((buffer >>> 0) !== 0 && have > 0)
        {
            host.writeMemory(buffer >>> 0, encodeAnsi(`${text.slice(0, have - 1)}\0`));
        }
        host.writeMemory(lengthAt >>> 0, dword(needed));
        return needed > have ? VFF_BUFFTOOSMALL : 0;
    };

    return {
        /**
         * DWORD VerLanguageNameA/W(DWORD wLang, LPSTR szLang, DWORD cchLang):
         * the same answer as kernel32's call of the name, from the same table
         * (`kernel32/languages.js`) -- the language a VerQueryValue
         * translation names, spelled for the user.
         */
        VerLanguageNameA: verLanguageName((address, text)=>
            host.writeMemory(address, encodeAnsi(text))),
        VerLanguageNameW: verLanguageName((address, text)=>{
            const bytes = new Uint8Array(text.length * 2);
            for (let at = 0; at < text.length; at++)
            {
                bytes[at * 2] = text.charCodeAt(at) & 0xff;
                bytes[at * 2 + 1] = text.charCodeAt(at) >> 8;
            }
            host.writeMemory(address, bytes);
        }),

        /**
         * DWORD VerFindFileA(DWORD uFlags, LPCSTR szFileName, LPCSTR szWinDir,
         *   LPCSTR szAppDir, LPSTR szCurDir, PUINT puCurDirLen,
         *   LPSTR szDestDir, PUINT puDestDirLen)
         *
         * Where a file should go and where it already is. The recommended
         * destination is the program's own directory, or the system directory
         * for a file marked shared; the current directory is wherever a copy
         * is found -- the destination first, then the Windows directory for a
         * shared file -- and empty when there is none, which is what an
         * installer of a fresh program reads. Zero means "install where
         * recommended"; VFF_CURNEDEST says a copy lives somewhere else.
         *
         * Nothing here can tell whether a file is in use, so VFF_FILEINUSE is
         * never reported: the installer then copies over it, which is what the
         * volume permits anyway.
         */
        VerFindFileA: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([flags, fileName, , appDir, curDir, curDirLen, destDir, destDirLen])=>{
                const leaf = host.readCString(fileName >>> 0, MAX_PATH);
                const shared = ((flags >>> 0) & VFFF_ISSHAREDFILE) !== 0;
                const destination = shared
                    ? SYSTEM_DIRECTORY
                    : host.readCString(appDir >>> 0, MAX_PATH);
                const candidates = shared ? [destination, WINDOWS_DIRECTORY] : [destination];
                const current = candidates.find(
                    dir=>host.files?.stat(joinPath(dir, leaf))?.exists) ?? '';

                let result = current !== '' && current !== destination ? VFF_CURNEDEST : 0;
                result |= writeDirectory(curDir, curDirLen, current);
                result |= writeDirectory(destDir, destDirLen, destination);
                return result;
            },
        },

        /**
         * DWORD GetFileVersionInfoSizeA(LPCSTR lptstrFilename, LPDWORD lpdwHandle)
         *
         * Zero means the file carries no version information, which is a fact
         * about plenty of real files and something every caller checks.
         */
        GetFileVersionInfoSizeA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([filename, handle])=>sizeOf(narrow(filename), handle),
        },

        /** DWORD GetFileVersionInfoSizeW(LPCWSTR lptstrFilename, LPDWORD lpdwHandle) */
        GetFileVersionInfoSizeW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([filename, handle])=>sizeOf(wide(filename), handle),
        },

        /**
         * BOOL GetFileVersionInfoA(LPCSTR lptstrFilename, DWORD dwHandle,
         *                          DWORD dwLen, LPVOID lpData)
         */
        GetFileVersionInfoA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([filename, , length, data])=>copyInto(narrow(filename), length, data, true),
        },

        /**
         * BOOL GetFileVersionInfoW(LPCWSTR lptstrFilename, DWORD dwHandle,
         *                          DWORD dwLen, LPVOID lpData)
         */
        GetFileVersionInfoW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([filename, , length, data])=>copyInto(wide(filename), length, data, false),
        },

        /**
         * BOOL VerQueryValueA(LPCVOID pBlock, LPCSTR lpSubBlock,
         *                     LPVOID *lplpBuffer, PUINT puLen)
         *
         * Answers with a pointer into the caller's own block rather than a
         * separate allocation, which is why the block has to stay alive for
         * as long as the answer is used -- the caller's problem, and the
         * documented contract. A text value is answered in ANSI, in the room
         * behind the block; the length is in characters either way.
         */
        VerQueryValueA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([block, subBlock, buffer, length])=>
                query(block, narrow(subBlock), buffer, length, true),
        },

        /**
         * BOOL VerQueryValueW(LPCVOID pBlock, LPCWSTR lpSubBlock,
         *                     LPVOID *lplpBuffer, PUINT puLen)
         *
         * The block's own UTF-16, where it lies.
         */
        VerQueryValueW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([block, subBlock, buffer, length])=>
                query(block, wide(subBlock), buffer, length, false),
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
         * A destination already there and newer than the source is kept and
         * reported (VIF_SRCOLD), unless the caller forces the install -- which
         * is what it does next, having asked. The temp-file handshake is
         * skipped -- the file is put at its final name and no temp is left for
         * the caller to rename -- which is the branch a caller takes when the
         * return is zero.
         */
        VerInstallFileA: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([flags, srcName, destName, srcDir, destDir, , tmpFile, tmpLen])=>{
                if (!host.files)
                {
                    return VIF_CANNOTCREATE;
                }
                /** @param {number} dir @param {number} name */
                const join = (dir, name)=>joinPath(
                    host.readCString(dir >>> 0, MAX_PATH), host.readCString(name >>> 0, MAX_PATH));
                const source = join(srcDir, srcName);
                const destination = join(destDir, destName);

                const stat = host.files.stat(source);
                if (!stat || !stat.exists || stat.isDirectory)
                {
                    return VIF_CANNOTREADSRC;
                }
                const files = host.files;
                const install = ()=>{
                    const input = files.open(source, { read: true });
                    if (!input)
                    {
                        return VIF_CANNOTREADSRC;
                    }
                    const raw = files.read(input, 0, stat.size);
                    files.close(input);
                    // A temp file the installer copied in is always resident, so
                    // a promise here would be a source on a bundle -- which
                    // VerInstallFile is never asked to expand. Refuse rather than
                    // guess at a partial read.
                    if (typeof (/** @type {any} */ (raw))?.then === 'function')
                    {
                        return VIF_CANNOTREADSRC;
                    }
                    const expanded = expand(/** @type {Uint8Array} */ (raw));

                    const output = files.open(destination,
                        { write: true, create: true, truncate: true });
                    if (!output)
                    {
                        return VIF_CANNOTCREATE;
                    }
                    files.write(output, 0, expanded);
                    files.close(output);

                    // The temp-file out-parameters name no temp file, because
                    // none was left: an empty string and a length of zero, which
                    // is what a caller reads when the install completed on its own.
                    if ((tmpFile >>> 0) !== 0)
                    {
                        host.writeMemory(tmpFile >>> 0, new Uint8Array([0]));
                    }
                    if ((tmpLen >>> 0) !== 0)
                    {
                        host.writeMemory(tmpLen >>> 0, dword(0));
                    }
                    return 0;
                };
                if (!files.stat(destination)?.exists
                    || ((flags >>> 0) & VIFF_FORCEINSTALL) !== 0)
                {
                    return install();
                }
                // Each version may wait for its file's bytes.
                return after(host.versionInfo?.(destination) ?? null, theirs=>
                    after(host.versionInfo?.(source) ?? null, ours=>{
                        const older = fileVersionOf(ours);
                        const newer = fileVersionOf(theirs);
                        return newer !== null && older !== null && newer > older
                            ? VIF_SRCOLD : install();
                    }));
            },
        },
    };
}
