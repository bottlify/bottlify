/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Shell links: the `.lnk` file of [MS-SHLLINK], written and read.
 *
 * Two callers put links on the volume -- shell32's link object, which a setup
 * program drives through IShellLink and IPersistFile, and the installer
 * engine's CreateShortcuts, which works from a table -- and a program reads
 * either kind back through the same IShellLink. One encoder and one decoder
 * means a shortcut answers the same questions whoever made it, and a link
 * some other writer of the format left on a disc reads the same way.
 *
 * What is written is what an ordinary link on a local drive holds: the header,
 * an item id list in the shapes the shell itself writes for a file-system path
 * (the computer, the drive, one item per name), the LinkInfo that names the
 * same path as text, the strings, and the environment blocks for a target or
 * an icon given with %VARIABLES%. Reading accepts every section the format
 * defines in either string width; sections nothing here interprets are kept
 * as bytes so a link loaded and saved again does not lose them.
 */

import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { fileAttributes, msToDosDateTime, msToFileTime } from '../kernel32/filetime.js';
import { formatGuid, parseGuid } from '../ole32/guid.js';

/** The class a link's header names, and the COM class that reads and writes one. */
export const CLSID_SHELL_LINK = '{00021401-0000-0000-C000-000000000046}';
/** The root item of a path on a drive: the computer. */
const CLSID_MY_COMPUTER = '{20D04FE0-3AEA-1069-A2D8-08002B30309D}';

const HEADER_SIZE = 0x4c;

/** LinkFlags, [MS-SHLLINK] 2.1.1. */
export const LINK_FLAGS = Object.freeze({
    HAS_LINK_TARGET_ID_LIST: 0x00000001,
    HAS_LINK_INFO: 0x00000002,
    HAS_NAME: 0x00000004,
    HAS_RELATIVE_PATH: 0x00000008,
    HAS_WORKING_DIR: 0x00000010,
    HAS_ARGUMENTS: 0x00000020,
    HAS_ICON_LOCATION: 0x00000040,
    IS_UNICODE: 0x00000080,
    FORCE_NO_LINK_INFO: 0x00000100,
    HAS_EXP_STRING: 0x00000200,
    HAS_DARWIN_ID: 0x00001000,
    HAS_EXP_ICON: 0x00004000,
});

/** ExtraData block signatures, [MS-SHLLINK] 2.5. */
export const BLOCK_SIGNATURES = Object.freeze({
    ENVIRONMENT: 0xa0000001,
    CONSOLE: 0xa0000002,
    TRACKER: 0xa0000003,
    CONSOLE_FE: 0xa0000004,
    SPECIAL_FOLDER: 0xa0000005,
    DARWIN: 0xa0000006,
    ICON_ENVIRONMENT: 0xa0000007,
    SHIM: 0xa0000008,
    PROPERTY_STORE: 0xa0000009,
    KNOWN_FOLDER: 0xa000000b,
    VISTA_AND_ABOVE_ID_LIST: 0xa000000c,
});

/** The three show commands a header may hold; any other reads as the first. */
export const SW_SHOWNORMAL = 1;
export const SW_SHOWMAXIMIZED = 3;
export const SW_SHOWMINNOACTIVE = 7;

/** LinkInfoFlags. */
const VOLUME_ID_AND_LOCAL_BASE_PATH = 0x1;
const COMMON_NETWORK_RELATIVE_LINK_AND_PATH_SUFFIX = 0x2;

/** The LinkInfo header without, and with, the two Unicode offsets. */
const LINK_INFO_HEADER = 0x1c;
const LINK_INFO_HEADER_UNICODE = 0x24;

/** DRIVE_FIXED: what a volume nobody said otherwise about is. */
const DRIVE_FIXED = 3;

/** An environment block: header, 260 ANSI bytes, 260 wide characters. */
const ENVIRONMENT_BLOCK_SIZE = 0x314;
const ENVIRONMENT_ANSI = 8;
const ENVIRONMENT_UNICODE = 268;
const ENVIRONMENT_CHARS = 260;

/** The extension block a file entry item carries its long name in. */
const FILE_ENTRY_EXTENSION = 0xbeef0004;

/** Item types: a root folder by class, a volume, and the file entries. */
const ROOT_FOLDER_ITEM = 0x1f;
const ROOT_SORT_MY_COMPUTER = 0x50;
const VOLUME_ITEM = 0x2f;
const VOLUME_ITEM_SIZE = 0x19;
const FILE_ENTRY_DIRECTORY = 0x31;
const FILE_ENTRY_FILE = 0x32;
const FILE_ENTRY_UNICODE = 0x04;

const FILE_ATTRIBUTE_DIRECTORY = 0x10;

/**
 * What a link is written from. Every field is optional: an empty link is a
 * header and a terminal block, which is what Windows saves for a link nobody
 * set anything on.
 *
 * @typedef {Object} ShellLinkFields
 * @property {string} [target]  The path the link points at, as given: with
 *           %VARIABLES% it goes into an environment block as it is, and the
 *           id list and LinkInfo are made from its expansion.
 * @property {Uint8Array | null} [idList]  An id list to write as it is, items
 *           and the terminating zero word, in place of the one made from the
 *           target.
 * @property {string} [description]
 * @property {string} [relativePath]
 * @property {string} [workingDirectory]
 * @property {string} [arguments]
 * @property {string} [iconLocation]  Given with %VARIABLES%, it goes into an
 *           icon environment block as well.
 * @property {number} [iconIndex]
 * @property {number} [showCommand]
 * @property {number} [hotkey]  The virtual key in the low byte, HOTKEYF_ bits
 *           in the high one.
 * @property {boolean} [unicode]  Strings as UTF-16, the default, or ANSI.
 * @property {{ driveType?: number, serialNumber?: number, label?: string }} [volume]
 *           What the LinkInfo says of the target's volume.
 * @property {(text: string) => string} [expand]
 *           Expands %VARIABLES%; without it a target that has them is written
 *           only into its environment block.
 * @property {{ signature: number, bytes: Uint8Array }[]} [blocks]  Extra data
 *           to carry as it is, each a whole block; one of a signature written
 *           here from the fields is left out.
 */

/**
 * What the volume says about a name, as much as a link records.
 *
 * @typedef {{ exists?: boolean, isDirectory: boolean, size?: number,
 *     modified?: number, readOnly?: boolean, hidden?: boolean,
 *     attributes?: number }} LinkTargetStat
 */

/** @typedef {(path: string) => LinkTargetStat | null | undefined} LinkStat */

/**
 * A LinkInfo as read: the volume or network share, and the path they make.
 *
 * @typedef {Object} LinkInfo
 * @property {string} path  The base and the suffix joined: the target.
 * @property {string | null} localBasePath
 * @property {string} commonPathSuffix
 * @property {{ driveType: number, serialNumber: number, label: string } | null} volume
 * @property {{ netName: string, deviceName: string | null,
 *     providerType: number | null } | null} network
 */

/**
 * A link as read.
 *
 * @typedef {Object} ShellLink
 * @property {number} flags
 * @property {number} fileAttributes
 * @property {bigint} creationTime
 * @property {bigint} accessTime
 * @property {bigint} writeTime
 * @property {number} fileSize
 * @property {number} iconIndex
 * @property {number} showCommand
 * @property {number} hotkey
 * @property {Uint8Array | null} idList  Items and the terminating zero word.
 * @property {string | null} idListPath  The path the id list names, or null
 *           for one that names no place on a drive.
 * @property {LinkInfo | null} linkInfo
 * @property {string} description
 * @property {string} relativePath
 * @property {string} workingDirectory
 * @property {string} arguments
 * @property {string} iconLocation
 * @property {string | null} environmentTarget
 * @property {string | null} environmentIcon
 * @property {string | null} darwinId
 * @property {{ signature: number, bytes: Uint8Array }[]} blocks  Every extra
 *           data block, whole, in file order.
 * @property {string} target  The target as the link gives it: the environment
 *           block's, else the path the id list names -- which is what the
 *           shell reads a link's target from -- else the LinkInfo's, else empty.
 */

/** @param {string} text */
const ansiRoundTrips = text=>decodeAnsi(encodeAnsi(text)) === text;

/** @param {string} text @returns {Uint8Array} */
const ansiZ = text=>encodeAnsi(`${text}\0`);

/** @param {string} text @returns {Uint8Array} */
function utf16(text){
    const bytes = new Uint8Array(text.length * 2);
    for (let at = 0; at < text.length; at++)
    {
        const unit = text.charCodeAt(at);
        bytes[at * 2] = unit & 0xff;
        bytes[at * 2 + 1] = unit >>> 8;
    }
    return bytes;
}

/** @param {string} text */
const utf16Z = text=>utf16(`${text}\0`);

/** @param {Uint8Array[]} parts */
function concat(parts){
    const bytes = new Uint8Array(parts.reduce((sum, part)=>sum + part.length, 0));
    let at = 0;
    for (const part of parts)
    {
        bytes.set(part, at);
        at += part.length;
    }
    return bytes;
}

/** @param {number} value */
const u16 = value=>new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
/** @param {number} value */
const u32 = value=>new Uint8Array([
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
]);

/** @param {string} text */
const hasVariables = text=>/%[^%\\]+%/.test(text);

/** @param {string} path */
const isDrivePath = path=>/^[A-Za-z]:(\\|$)/.test(path);
/** @param {string} path */
const isUncPath = path=>/^\\\\[^\\]+\\[^\\]+/.test(path);

/**
 * The trailing separators off a path, but for a drive's root, which is named
 * by its separator.
 *
 * @param {string} path
 */
const trimSeparators = path=>(/^[A-Za-z]:\\?$/.test(path)
    ? `${path.slice(0, 2)}\\` : path.replace(/\\+$/, ''));

/**
 * A file entry item: the type, a zero byte, the size, the DOS date and time,
 * the attributes in a word, and the name -- ANSI when the page holds it,
 * otherwise UTF-16 with the type saying so -- padded to an even length.
 *
 * @param {string} name @param {boolean} directory @param {LinkTargetStat | null} entry
 */
function fileEntryItem(name, directory, entry){
    const wide = !ansiRoundTrips(name);
    const text = wide ? utf16Z(name) : ansiZ(name);
    const fixed = 14;
    const size = fixed + text.length + ((fixed + text.length) & 1);
    const item = new Uint8Array(size);
    const view = new DataView(item.buffer);
    view.setUint16(0, size, true);
    item[2] = (directory ? FILE_ENTRY_DIRECTORY : FILE_ENTRY_FILE)
        | (wide ? FILE_ENTRY_UNICODE : 0);
    const exists = entry && entry.exists !== false;
    view.setUint32(4, exists && !directory ? Math.min(entry.size ?? 0, 0xffffffff) >>> 0 : 0, true);
    const stamp = exists && entry.modified !== undefined ? msToDosDateTime(entry.modified) : null;
    view.setUint16(8, stamp?.date ?? 0, true);
    view.setUint16(10, stamp?.time ?? 0, true);
    view.setUint16(12, exists ? fileAttributes(entry) & 0xffff
        : directory ? FILE_ATTRIBUTE_DIRECTORY : 0, true);
    item.set(text, fixed);
    return item;
}

/**
 * The id list the shell makes for a path on a drive: the computer, the drive,
 * then an item for each name. Null for a path on no drive, which an id list
 * of these shapes cannot name.
 *
 * Each name's item records what the volume knows of it, when `stat` is given;
 * a name the volume does not have is still an item, as the shell writes one
 * for a target that is not there yet.
 *
 * @param {string} path
 * @param {LinkStat} [stat]
 * @returns {Uint8Array | null}  The items and the terminating zero word.
 */
export function idListForPath(path, stat = ()=>null){
    if (!isDrivePath(path))
    {
        return null;
    }
    const root = new Uint8Array(0x14);
    root[0] = 0x14;
    root[2] = ROOT_FOLDER_ITEM;
    root[3] = ROOT_SORT_MY_COMPUTER;
    root.set(/** @type {Uint8Array} */ (parseGuid(CLSID_MY_COMPUTER)), 4);

    const drive = new Uint8Array(VOLUME_ITEM_SIZE);
    drive[0] = VOLUME_ITEM_SIZE;
    drive[2] = VOLUME_ITEM;
    drive.set(encodeAnsi(`${path[0].toUpperCase()}:\\`), 3);

    const items = [root, drive];
    const names = trimSeparators(path).slice(3).split('\\').filter(name=>name !== '');
    let at = `${path[0].toUpperCase()}:\\`;
    names.forEach((name, index)=>{
        at = at.endsWith('\\') ? at + name : `${at}\\${name}`;
        const entry = stat(at) ?? null;
        const directory = index < names.length - 1 || Boolean(entry?.isDirectory);
        items.push(fileEntryItem(name, directory, entry));
    });
    items.push(u16(0));
    return concat(items);
}

/**
 * A NUL-terminated ANSI string at `at`, or null when no NUL comes before `end`.
 *
 * @param {Uint8Array} bytes @param {number} at @param {number} [end]
 */
function readAnsiZ(bytes, at, end = bytes.length){
    for (let n = at; n < end; n++)
    {
        if (bytes[n] === 0)
        {
            return decodeAnsi(bytes.subarray(at, n));
        }
    }
    return null;
}

/**
 * A NUL-terminated UTF-16 string at `at`, or null when no NUL comes before `end`.
 *
 * @param {Uint8Array} bytes @param {number} at @param {number} [end]
 */
function readUtf16Z(bytes, at, end = bytes.length){
    let text = '';
    for (let n = at; n + 1 < end; n += 2)
    {
        const unit = bytes[n] | (bytes[n + 1] << 8);
        if (unit === 0)
        {
            return text;
        }
        text += String.fromCharCode(unit);
    }
    return null;
}

/**
 * The long name a file entry item's extension block carries, or null. The
 * block is found by the word that ends the item, which is its offset; where
 * the name sits in it depends on the block's version.
 *
 * @param {Uint8Array} item
 */
function longNameOf(item){
    if (item.length < 4)
    {
        return null;
    }
    const view = new DataView(item.buffer, item.byteOffset, item.length);
    const offset = view.getUint16(item.length - 2, true);
    if (offset < 14 || offset + 20 > item.length - 2
        || view.getUint32(offset + 4, true) !== FILE_ENTRY_EXTENSION)
    {
        return null;
    }
    const version = view.getUint16(offset + 2, true);
    const end = Math.min(offset + view.getUint16(offset, true), item.length - 2);
    // Windows XP's blocks (version 3) put the name straight after the
    // identifier word; Vista's (7) put a file reference and a size first,
    // Windows 7's (8) four bytes more, and Windows 8's (9) four more again.
    const start = version >= 9 ? 46 : version === 8 ? 42 : version === 7 ? 38 : 18;
    const name = readUtf16Z(item, offset + start, end);
    if (name)
    {
        return name;
    }
    return null;
}

/**
 * The path an id list names, when it is one of the shapes a path on a drive
 * has: the computer, a drive, then file entries. Null for anything else.
 *
 * @param {Uint8Array} list
 * @returns {string | null}
 */
export function pathOfIdList(list){
    const view = new DataView(list.buffer, list.byteOffset, list.length);
    /** @type {string | null} */
    let path = null;
    let at = 0;
    while (at + 2 <= list.length)
    {
        const size = view.getUint16(at, true);
        if (size === 0)
        {
            return path;
        }
        if (size < 3 || at + size > list.length)
        {
            return null;
        }
        const item = list.subarray(at, at + size);
        const type = item[2];
        if (type === ROOT_FOLDER_ITEM)
        {
            // Only the computer leads to a drive; any other root names a
            // place in the shell that is no path.
            if (path !== null || size < 20
                || formatGuid(item.subarray(4, 20)).toUpperCase() !== CLSID_MY_COMPUTER)
            {
                return null;
            }
        }
        else if ((type & 0x70) === 0x20)
        {
            const name = readAnsiZ(item, 3) ?? '';
            if (path !== null || !/^[A-Za-z]:\\?$/.test(name))
            {
                return null;
            }
            path = `${name.slice(0, 2)}\\`;
        }
        else if ((type & 0x70) === 0x30)
        {
            if (path === null || size < 15)
            {
                return null;
            }
            const primary = (type & FILE_ENTRY_UNICODE) !== 0
                ? readUtf16Z(item, 14) : readAnsiZ(item, 14);
            const name = longNameOf(item) ?? primary;
            if (!name)
            {
                return null;
            }
            path = path.endsWith('\\') ? path + name : `${path}\\${name}`;
        }
        else
        {
            return null;
        }
        at += size;
    }
    return null;
}

/**
 * A string in two widths: the ANSI bytes always, the UTF-16 ones only when
 * the ANSI page cannot hold the text.
 *
 * @param {string} text
 */
const bothWidths = text=>({
    ansi: ansiZ(text),
    unicode: ansiRoundTrips(text) ? null : utf16Z(text),
});

/**
 * The VolumeID of a local link.
 *
 * @param {{ driveType?: number, serialNumber?: number, label?: string }} volume
 */
function volumeId(volume){
    const label = volume.label ?? '';
    const wide = !ansiRoundTrips(label);
    const head = wide ? 0x14 : 0x10;
    const text = wide ? utf16Z(label) : ansiZ(label);
    return concat([
        u32(head + text.length),
        u32(volume.driveType ?? DRIVE_FIXED),
        u32(volume.serialNumber ?? 0),
        // An offset of 0x14 says the label is the Unicode one, at the offset
        // the next field gives.
        u32(wide ? 0x14 : 0x10),
        ...wide ? [u32(0x14)] : [],
        text,
    ]);
}

/**
 * The CommonNetworkRelativeLink of a share: its name, with no device and no
 * provider claimed. A name the ANSI page cannot hold is written again in
 * UTF-16, which the two extra offsets after the fixed fields point at.
 *
 * @param {string} netName  `\\server\share`
 */
function networkLink(netName){
    const name = bothWidths(netName);
    const head = name.unicode ? 0x1c : 0x14;
    const unicodeAt = head + name.ansi.length + ((head + name.ansi.length) & 1);
    const size = name.unicode ? unicodeAt + name.unicode.length : head + name.ansi.length;
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, size, true);
    view.setUint32(8, head, true);
    if (name.unicode)
    {
        view.setUint32(0x14, unicodeAt, true);
        bytes.set(name.unicode, unicodeAt);
    }
    bytes.set(name.ansi, head);
    return bytes;
}

/**
 * The LinkInfo for a target on a drive -- the volume and the whole path as
 * the base, with an empty suffix -- or on a share, as the share's name and
 * the rest as the suffix. Null for a target that is neither.
 *
 * @param {string} target
 * @param {{ driveType?: number, serialNumber?: number, label?: string }} volume
 * @returns {Uint8Array | null}
 */
function encodeLinkInfo(target, volume){
    const local = isDrivePath(target);
    if (!local && !isUncPath(target))
    {
        return null;
    }
    /** @type {{ ansi: Uint8Array, unicode: Uint8Array | null }} */
    let base;
    /** @type {{ ansi: Uint8Array, unicode: Uint8Array | null }} */
    let suffix;
    /** @type {Uint8Array} */
    let location;
    if (local)
    {
        base = bothWidths(target);
        suffix = bothWidths('');
        location = volumeId(volume);
    }
    else
    {
        const share = /^(\\\\[^\\]+\\[^\\]+)\\?(.*)$/.exec(target);
        base = { ansi: new Uint8Array(0), unicode: null };
        suffix = bothWidths(share?.[2] ?? '');
        location = networkLink(share?.[1] ?? target);
    }
    const wide = base.unicode !== null || suffix.unicode !== null;
    const head = wide ? LINK_INFO_HEADER_UNICODE : LINK_INFO_HEADER;
    const locationAt = head;
    const baseAt = locationAt + location.length;
    const suffixAt = baseAt + base.ansi.length;
    let end = suffixAt + suffix.ansi.length;
    end += end & 1;
    const baseUnicode = local && wide ? base.unicode ?? utf16Z(target) : null;
    const baseUnicodeAt = baseUnicode ? end : 0;
    if (baseUnicode)
    {
        end += baseUnicode.length;
    }
    const suffixUnicode = wide ? suffix.unicode ?? utf16Z('') : null;
    const suffixUnicodeAt = suffixUnicode ? end : 0;
    if (suffixUnicode)
    {
        end += suffixUnicode.length;
    }
    const bytes = new Uint8Array(end);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, end, true);
    view.setUint32(4, head, true);
    view.setUint32(8, local ? VOLUME_ID_AND_LOCAL_BASE_PATH
        : COMMON_NETWORK_RELATIVE_LINK_AND_PATH_SUFFIX, true);
    view.setUint32(12, local ? locationAt : 0, true);
    view.setUint32(16, local ? baseAt : 0, true);
    view.setUint32(20, local ? 0 : locationAt, true);
    view.setUint32(24, suffixAt, true);
    if (wide)
    {
        view.setUint32(28, baseUnicodeAt, true);
        view.setUint32(32, suffixUnicodeAt, true);
    }
    bytes.set(location, locationAt);
    bytes.set(base.ansi, baseAt);
    bytes.set(suffix.ansi, suffixAt);
    if (baseUnicode)
    {
        bytes.set(baseUnicode, baseUnicodeAt);
    }
    if (suffixUnicode)
    {
        bytes.set(suffixUnicode, suffixUnicodeAt);
    }
    return bytes;
}

/**
 * An environment block -- the target's or the icon's -- with the text in both
 * widths, each cut to the 260 characters the block holds with its NUL.
 *
 * @param {number} signature @param {string} text
 */
function environmentBlock(signature, text){
    const bytes = new Uint8Array(ENVIRONMENT_BLOCK_SIZE);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, ENVIRONMENT_BLOCK_SIZE, true);
    view.setUint32(4, signature, true);
    const kept = text.slice(0, ENVIRONMENT_CHARS - 1);
    bytes.set(encodeAnsi(kept), ENVIRONMENT_ANSI);
    bytes.set(utf16(kept), ENVIRONMENT_UNICODE);
    return bytes;
}

/**
 * A StringData entry: the count of characters, then the characters, with no
 * terminator. The count is a word, so a longer string is cut to fit.
 *
 * @param {string} text @param {boolean} unicode
 */
function stringData(text, unicode){
    const kept = text.slice(0, 0xffff);
    return concat([u16(kept.length), unicode ? utf16(kept) : encodeAnsi(kept)]);
}

/**
 * The bytes of a link.
 *
 * `stat` is how the target's facts reach the header and the id list -- its
 * attributes, size and time -- as the shell records them when it saves; a
 * target the volume does not have leaves them zero.
 *
 * @param {ShellLinkFields} fields
 * @param {LinkStat} [stat]
 * @returns {Uint8Array}
 */
export function encodeShellLink(fields, stat = ()=>null){
    const unicode = fields.unicode !== false;
    const target = fields.target ?? '';
    const variables = hasVariables(target);
    const expanded = variables ? fields.expand?.(target) ?? null : target;
    const resolved = expanded !== null && !hasVariables(expanded) && expanded !== ''
        ? trimSeparators(expanded) : null;
    const entry = resolved === null ? null : stat(resolved) ?? null;
    const exists = Boolean(entry && entry.exists !== false);

    const idList = fields.idList ?? (resolved === null ? null : idListForPath(resolved, stat));
    const linkInfo = resolved === null ? null : encodeLinkInfo(resolved, fields.volume ?? {});

    /** @type {[number, string | undefined][]} */
    const strings = [
        [LINK_FLAGS.HAS_NAME, fields.description],
        [LINK_FLAGS.HAS_RELATIVE_PATH, fields.relativePath],
        [LINK_FLAGS.HAS_WORKING_DIR, fields.workingDirectory],
        [LINK_FLAGS.HAS_ARGUMENTS, fields.arguments],
        [LINK_FLAGS.HAS_ICON_LOCATION, fields.iconLocation],
    ];
    const iconLocation = fields.iconLocation ?? '';

    /** @type {Uint8Array[]} */
    const extra = [];
    let flags = unicode ? LINK_FLAGS.IS_UNICODE : 0;
    if (variables)
    {
        flags |= LINK_FLAGS.HAS_EXP_STRING;
        extra.push(environmentBlock(BLOCK_SIGNATURES.ENVIRONMENT, target));
    }
    if (hasVariables(iconLocation))
    {
        flags |= LINK_FLAGS.HAS_EXP_ICON;
        extra.push(environmentBlock(BLOCK_SIGNATURES.ICON_ENVIRONMENT, iconLocation));
    }
    /** @type {Set<number>} */
    const written = new Set([BLOCK_SIGNATURES.ENVIRONMENT, BLOCK_SIGNATURES.ICON_ENVIRONMENT]);
    for (const block of fields.blocks ?? [])
    {
        if (block.bytes.length >= 8 && !written.has(block.signature >>> 0))
        {
            extra.push(block.bytes);
            if ((block.signature >>> 0) === BLOCK_SIGNATURES.DARWIN)
            {
                flags |= LINK_FLAGS.HAS_DARWIN_ID;
            }
        }
    }

    if (idList)
    {
        flags |= LINK_FLAGS.HAS_LINK_TARGET_ID_LIST;
    }
    if (linkInfo)
    {
        flags |= LINK_FLAGS.HAS_LINK_INFO;
    }
    /** @type {Uint8Array[]} */
    const texts = [];
    for (const [flag, text] of strings)
    {
        if (text)
        {
            flags |= flag;
            texts.push(stringData(text, unicode));
        }
    }

    const header = new Uint8Array(HEADER_SIZE);
    const view = new DataView(header.buffer);
    view.setUint32(0, HEADER_SIZE, true);
    header.set(/** @type {Uint8Array} */ (parseGuid(CLSID_SHELL_LINK)), 4);
    view.setUint32(0x14, flags >>> 0, true);
    view.setUint32(0x18, exists ? fileAttributes(entry) : 0, true);
    // The volume records when a name was last written and nothing else; the
    // three times are that one, as the file calls report them.
    const time = exists && entry?.modified !== undefined ? msToFileTime(entry.modified) : 0n;
    view.setBigUint64(0x1c, time, true);
    view.setBigUint64(0x24, time, true);
    view.setBigUint64(0x2c, time, true);
    view.setUint32(0x34, exists && !entry?.isDirectory
        ? Math.min(entry?.size ?? 0, 0xffffffff) >>> 0 : 0, true);
    view.setInt32(0x38, fields.iconIndex ?? 0, true);
    view.setUint32(0x3c, fields.showCommand ?? SW_SHOWNORMAL, true);
    view.setUint16(0x40, (fields.hotkey ?? 0) & 0xffff, true);

    return concat([
        header,
        ...idList ? [u16(idList.length), idList] : [],
        ...linkInfo ? [linkInfo] : [],
        ...texts,
        ...extra,
        u32(0),
    ]);
}

/** A cut-short or inconsistent link: what makes decoding give up. */
class Truncated extends Error {}

/**
 * A bounds-checked view over the link's bytes.
 *
 * @param {Uint8Array} bytes
 */
function reader(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    /** @param {number} at @param {number} length */
    const need = (at, length)=>{
        if (at < 0 || length < 0 || at + length > bytes.length)
        {
            throw new Truncated();
        }
    };
    return {
        /** @param {number} at */
        u16: at=>(need(at, 2), view.getUint16(at, true)),
        /** @param {number} at */
        u32: at=>(need(at, 4), view.getUint32(at, true)),
        /** @param {number} at */
        i32: at=>(need(at, 4), view.getInt32(at, true)),
        /** @param {number} at */
        u64: at=>(need(at, 8), view.getBigUint64(at, true)),
        /** @param {number} at @param {number} length */
        slice: (at, length)=>(need(at, length), bytes.subarray(at, at + length)),
    };
}

/** @param {string} base @param {string} suffix */
const joinSuffix = (base, suffix)=>(suffix === '' ? base
    : base.endsWith('\\') ? base + suffix : `${base}\\${suffix}`);

/**
 * A string at an offset inside a structure, ANSI or UTF-16, bounded by it.
 *
 * @param {Uint8Array} bytes @param {number} at @param {boolean} wide
 */
function stringAt(bytes, at, wide){
    if (at <= 0 || at >= bytes.length)
    {
        throw new Truncated();
    }
    const text = wide ? readUtf16Z(bytes, at) : readAnsiZ(bytes, at);
    if (text === null)
    {
        throw new Truncated();
    }
    return text;
}

/**
 * @param {Uint8Array} info  The whole LinkInfo, its size field first.
 * @returns {LinkInfo}
 */
function decodeLinkInfo(info){
    const read = reader(info);
    const head = read.u32(4);
    const flags = read.u32(8);
    const unicodeOffsets = head >= LINK_INFO_HEADER_UNICODE;
    const baseUnicodeAt = unicodeOffsets ? read.u32(0x1c) : 0;
    const suffixUnicodeAt = unicodeOffsets ? read.u32(0x20) : 0;
    const suffix = suffixUnicodeAt !== 0 ? stringAt(info, suffixUnicodeAt, true)
        : read.u32(24) !== 0 ? stringAt(info, read.u32(24), false) : '';

    /** @type {LinkInfo['volume']} */
    let volume = null;
    /** @type {string | null} */
    let localBasePath = null;
    if ((flags & VOLUME_ID_AND_LOCAL_BASE_PATH) !== 0)
    {
        const at = read.u32(12);
        const id = read.slice(at, read.u32(at));
        const idRead = reader(id);
        const labelAt = idRead.u32(12);
        volume = {
            driveType: idRead.u32(4),
            serialNumber: idRead.u32(8),
            label: labelAt === 0x14 ? stringAt(id, idRead.u32(0x10), true)
                : stringAt(id, labelAt, false),
        };
        localBasePath = baseUnicodeAt !== 0 ? stringAt(info, baseUnicodeAt, true)
            : stringAt(info, read.u32(16), false);
    }

    /** @type {LinkInfo['network']} */
    let network = null;
    if ((flags & COMMON_NETWORK_RELATIVE_LINK_AND_PATH_SUFFIX) !== 0)
    {
        const at = read.u32(20);
        const link = read.slice(at, read.u32(at));
        const linkRead = reader(link);
        const linkFlags = linkRead.u32(4);
        const nameAt = linkRead.u32(8);
        const deviceAt = linkRead.u32(12);
        const wide = nameAt > 0x14;
        const nameUnicodeAt = wide ? linkRead.u32(0x14) : 0;
        const deviceUnicodeAt = wide ? linkRead.u32(0x18) : 0;
        network = {
            netName: nameUnicodeAt !== 0 ? stringAt(link, nameUnicodeAt, true)
                : stringAt(link, nameAt, false),
            // ValidDevice and ValidNetType say whether the other two mean anything.
            deviceName: (linkFlags & 1) === 0 ? null : deviceUnicodeAt !== 0
                ? stringAt(link, deviceUnicodeAt, true) : stringAt(link, deviceAt, false),
            providerType: (linkFlags & 2) === 0 ? null : linkRead.u32(16),
        };
    }

    const base = localBasePath ?? network?.netName ?? '';
    return {
        path: joinSuffix(base, suffix),
        localBasePath,
        commonPathSuffix: suffix,
        volume,
        network,
    };
}

/**
 * The text of an environment-shaped block (the target's, the icon's, the
 * installer's descriptor): the wide copy when it has one, else the ANSI.
 *
 * @param {Uint8Array} block
 */
function environmentText(block){
    if (block.length < ENVIRONMENT_UNICODE + 2)
    {
        throw new Truncated();
    }
    const wide = readUtf16Z(block, ENVIRONMENT_UNICODE) ?? '';
    return wide !== '' ? wide
        : readAnsiZ(block, ENVIRONMENT_ANSI, ENVIRONMENT_UNICODE) ?? '';
}

/**
 * Reads a link. Null for bytes that are not one: a header of the wrong size or
 * class, or a section that runs past the end.
 *
 * @param {Uint8Array} bytes
 * @returns {ShellLink | null}
 */
export function decodeShellLink(bytes){
    try
    {
        return decode(bytes);
    }
    catch (e){
        if (e instanceof Truncated)
        {
            return null;
        }
        throw e;
    }
}

/** @param {Uint8Array} bytes @returns {ShellLink | null} */
function decode(bytes){
    const read = reader(bytes);
    if (bytes.length < HEADER_SIZE || read.u32(0) !== HEADER_SIZE
        || formatGuid(read.slice(4, 16)).toUpperCase() !== CLSID_SHELL_LINK)
    {
        return null;
    }
    const flags = read.u32(0x14);
    const showCommand = read.u32(0x3c);
    let at = HEADER_SIZE;

    /** @type {Uint8Array | null} */
    let idList = null;
    if ((flags & LINK_FLAGS.HAS_LINK_TARGET_ID_LIST) !== 0)
    {
        const size = read.u16(at);
        idList = read.slice(at + 2, size);
        at += 2 + size;
    }

    /** @type {LinkInfo | null} */
    let linkInfo = null;
    if ((flags & LINK_FLAGS.HAS_LINK_INFO) !== 0)
    {
        const size = read.u32(at);
        if (size < LINK_INFO_HEADER)
        {
            throw new Truncated();
        }
        // ForceNoLinkInfo says to ignore a LinkInfo that is there.
        if ((flags & LINK_FLAGS.FORCE_NO_LINK_INFO) === 0)
        {
            linkInfo = decodeLinkInfo(read.slice(at, size));
        }
        at += size;
    }

    const unicode = (flags & LINK_FLAGS.IS_UNICODE) !== 0;
    /** @param {number} flag */
    const text = flag=>{
        if ((flags & flag) === 0)
        {
            return '';
        }
        const count = read.u16(at);
        const length = unicode ? count * 2 : count;
        const raw = read.slice(at + 2, length);
        at += 2 + length;
        if (!unicode)
        {
            return decodeAnsi(raw);
        }
        let out = '';
        for (let n = 0; n < count; n++)
        {
            out += String.fromCharCode(raw[n * 2] | (raw[n * 2 + 1] << 8));
        }
        return out;
    };
    const description = text(LINK_FLAGS.HAS_NAME);
    const relativePath = text(LINK_FLAGS.HAS_RELATIVE_PATH);
    const workingDirectory = text(LINK_FLAGS.HAS_WORKING_DIR);
    const commandLine = text(LINK_FLAGS.HAS_ARGUMENTS);
    const iconLocation = text(LINK_FLAGS.HAS_ICON_LOCATION);

    /** @type {{ signature: number, bytes: Uint8Array }[]} */
    const blocks = [];
    /** @type {string | null} */
    let environmentTarget = null;
    /** @type {string | null} */
    let environmentIcon = null;
    /** @type {string | null} */
    let darwinId = null;
    // The extra data is the part of a link nothing needs to find its target,
    // so its end is read forgivingly: the end of the bytes, or a block that
    // claims more bytes than are left, ends it as the terminal block would.
    while (at + 8 <= bytes.length)
    {
        const size = read.u32(at);
        if (size < 8 || at + size > bytes.length)
        {
            break;
        }
        const block = read.slice(at, size);
        const signature = reader(block).u32(4);
        blocks.push({ signature, bytes: block });
        if (signature === BLOCK_SIGNATURES.ENVIRONMENT)
        {
            environmentTarget = environmentText(block);
        }
        else if (signature === BLOCK_SIGNATURES.ICON_ENVIRONMENT)
        {
            environmentIcon = environmentText(block);
        }
        else if (signature === BLOCK_SIGNATURES.DARWIN)
        {
            darwinId = environmentText(block);
        }
        at += size;
    }

    const idListPath = idList ? pathOfIdList(idList) : null;
    const environmentUsed = (flags & LINK_FLAGS.HAS_EXP_STRING) !== 0 ? environmentTarget : null;
    return {
        flags,
        fileAttributes: read.u32(0x18),
        creationTime: read.u64(0x1c),
        accessTime: read.u64(0x24),
        writeTime: read.u64(0x2c),
        fileSize: read.u32(0x34),
        iconIndex: read.i32(0x38),
        showCommand: showCommand === SW_SHOWMAXIMIZED || showCommand === SW_SHOWMINNOACTIVE
            ? showCommand : SW_SHOWNORMAL,
        hotkey: read.u16(0x40),
        idList,
        idListPath,
        linkInfo,
        description,
        relativePath,
        workingDirectory,
        arguments: commandLine,
        iconLocation,
        environmentTarget,
        environmentIcon,
        darwinId,
        blocks,
        target: environmentUsed ?? idListPath ?? linkInfo?.path ?? '',
    };
}

/**
 * The volume a link is written to, as the file surface sees it.
 *
 * @typedef {Object} LinkVolume
 * @property {LinkStat} stat
 * @property {(path: string, mode: { read?: boolean, write?: boolean,
 *     create?: boolean, truncate?: boolean }) => unknown} open
 * @property {(node: any, offset: number, bytes: Uint8Array) => unknown} write
 * @property {(node: any) => void} close
 */

/**
 * Writes a link at `path`, replacing what is there, with the target's facts
 * read off the same volume. False when the file cannot be created -- the
 * directory it goes in is missing, or the name is read-only -- which is the
 * caller's to make or to report.
 *
 * @param {LinkVolume} volume
 * @param {string} path
 * @param {ShellLinkFields} fields
 * @returns {boolean}
 */
export function writeShellLink(volume, path, fields){
    const node = volume.open(path, { write: true, create: true, truncate: true });
    if (!node)
    {
        return false;
    }
    try
    {
        volume.write(node, 0, encodeShellLink(fields, name=>volume.stat(name)));
    }
    finally
    {
        volume.close(node);
    }
    return true;
}
