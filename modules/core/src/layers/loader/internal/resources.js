/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The resource directory: icons, bitmaps, cursors, version blocks and strings.
 *
 * A three-level tree — type, then name, then language — of identical directory
 * nodes, and two things about it are easy to get wrong and silent when wrong.
 *
 * The first is that an entry's two dwords are read differently. Both use the top
 * bit as a tag, but the offsets underneath mean different things: every offset
 * *within the tree* is relative to the start of the resource directory, while
 * the one in the leaf, `OffsetToData`, is an RVA like any other. Reading the
 * leaf as directory-relative lands inside the tree and returns a fragment of the
 * directory as if it were the resource.
 *
 * The second is that a name is counted, not terminated: an entry tagged as named
 * points at a WORD length followed by exactly that many UTF-16 code units, with
 * no NUL after them. Reading it as a C string runs into the next name.
 */

import { rvaToFileOffset } from './pe.js';

const DIR_RESOURCE = 2;

/** IMAGE_RESOURCE_DIRECTORY: four fields we skip, then the two counts. */
const DIRECTORY_HEADER_SIZE = 16;
const ENTRY_SIZE = 8;

/** The tag bit on both of an entry's dwords, meaning "name" and "subdirectory". */
const HIGH_BIT = 0x80000000;

/** Strings live in bundles of sixteen under this type, and nowhere else. */
export const RT_STRING = 6;

/** How many strings share one bundle. */
const STRINGS_PER_BUNDLE = 16;

/** Only the types worth naming in a listing; anything else is reported by number. */
const TYPE_NAMES = new Map([
    [1, 'CURSOR'], [2, 'BITMAP'], [3, 'ICON'], [4, 'MENU'], [5, 'DIALOG'],
    [RT_STRING, 'STRING'], [9, 'ACCELERATOR'], [10, 'RCDATA'],
    [12, 'GROUP_CURSOR'], [14, 'GROUP_ICON'], [16, 'VERSION'], [24, 'MANIFEST'],
]);

/**
 * One resource, found.
 *
 * @typedef {Object} FoundResource
 * @property {number} rva       Where its bytes are, relative to the image base.
 *                              Already mapped, so a caller adds the base and has
 *                              an address -- there is nothing to copy.
 * @property {number} size
 * @property {number} codePage
 * @property {number | string} language
 */

/**
 * @typedef {Object} ListedResource
 * @property {number | string} type
 * @property {string} typeName   The type's usual name, or its number as text.
 * @property {number | string} name
 * @property {number | string} language
 * @property {number} rva
 * @property {number} size
 */

/**
 * Finds one resource by type, name and language.
 *
 * `null` for the language means "whatever this image has", which is what a
 * program with one language always wants and what every caller here asks for:
 * a title that ships one locale still tags its resources with it, so demanding
 * a specific language would find nothing.
 *
 * @param {Uint8Array} bytes  The raw file (not the mapped image).
 * @param {import('./pe.js').PeImage} image
 * @param {number | string} type
 * @param {number | string} name
 * @param {number | string | null} [language]
 * @returns {FoundResource | null}
 */
export function findResource(bytes, image, type, name, language = null){
    const tree = openTree(bytes, image);
    if (!tree)
    {
        return null;
    }

    const byType = tree.lookup(tree.root, type);
    if (byType === null)
    {
        return null;
    }
    // A level that answers with a leaf rather than a subdirectory ends the walk.
    // Two-level trees are unusual but legal, and refusing them would refuse an
    // image over a shape that costs nothing to accept.
    if (!byType.directory)
    {
        return tree.leaf(byType.offset, language ?? 0);
    }

    const byName = tree.lookup(byType.offset, name);
    if (byName === null)
    {
        return null;
    }
    if (!byName.directory)
    {
        return tree.leaf(byName.offset, language ?? 0);
    }

    const byLanguage = tree.lookup(byName.offset, language);
    if (byLanguage === null || byLanguage.directory)
    {
        return null;
    }
    return tree.leaf(byLanguage.offset, byLanguage.key);
}

/**
 * Reads one string resource.
 *
 * Strings are not stored one per identifier. Sixteen of them share a bundle
 * whose own resource id is `(id >> 4) + 1`, and inside it they sit end to end,
 * each a WORD length followed by that many UTF-16 code units. The length counts
 * code units rather than bytes, and the bundle id is one-based rather than
 * zero-based; either mistaken quietly returns a different string, which is worse
 * than returning none.
 *
 * A slot whose length is zero holds no string. That is how a gap in a range of
 * identifiers is stored, so it is absence rather than an empty string.
 *
 * @param {Uint8Array} bytes
 * @param {import('./pe.js').PeImage} image
 * @param {number} id
 * @param {number | string | null} [language]
 * @returns {string | null}
 */
export function loadString(bytes, image, id, language = null){
    const wanted = id >>> 0;
    const found = findResource(
        bytes, image, RT_STRING, (wanted >> 4) + 1, language);
    if (!found)
    {
        return null;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = rvaToFileOffset(image, found.rva);
    const end = at + found.size;
    const slot = wanted & STRINGS_PER_BUNDLE - 1;

    for (let index = 0; index < STRINGS_PER_BUNDLE; index++)
    {
        if (at + 2 > end)
        {
            return null;
        }
        const length = view.getUint16(at, true);
        at += 2;
        if (index === slot)
        {
            if (length === 0 || at + length * 2 > end)
            {
                return null;
            }
            let text = '';
            for (let unit = 0; unit < length; unit++)
            {
                text += String.fromCharCode(view.getUint16(at + unit * 2, true));
            }
            return text;
        }
        at += length * 2;
    }
    return null;
}

/**
 * Everything an image carries, flattened.
 *
 * Worth having because it turns a question into a fact: an executable that will
 * not load a string either has none, or has them somewhere this reader is not
 * looking, and a listing says which without guessing.
 *
 * @param {Uint8Array} bytes
 * @param {import('./pe.js').PeImage} image
 * @returns {ListedResource[]}
 */
export function listResources(bytes, image){
    const tree = openTree(bytes, image);
    if (!tree)
    {
        return [];
    }

    /** @type {ListedResource[]} */
    const found = [];
    for (const type of tree.entries(tree.root))
    {
        if (!type.directory)
        {
            continue;
        }
        for (const name of tree.entries(type.offset))
        {
            if (!name.directory)
            {
                continue;
            }
            for (const language of tree.entries(name.offset))
            {
                const leaf = language.directory
                    ? null
                    : tree.leaf(language.offset, language.key);
                if (!leaf)
                {
                    continue;
                }
                found.push({
                    type: type.key,
                    typeName: typeof type.key === 'number'
                        ? TYPE_NAMES.get(type.key) ?? String(type.key)
                        : type.key,
                    name: name.key,
                    language: language.key,
                    rva: leaf.rva,
                    size: leaf.size,
                });
            }
        }
    }
    return found;
}

/**
 * The directory, and the three readings that only make sense inside it.
 *
 * Every offset here is measured from the directory's own start, so the base is
 * bound once and the walk never has to remember which of its numbers are
 * relative to what.
 *
 * @param {Uint8Array} bytes
 * @param {import('./pe.js').PeImage} image
 */
function openTree(bytes, image){
    const directory = image.directories[DIR_RESOURCE];
    if (!directory || directory.size === 0)
    {
        return null;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const base = rvaToFileOffset(image, directory.address);
    const limit = directory.size;

    /** A node outside the directory is a malformed image, not a resource. */
    const within = (/** @type {number} */ offset, /** @type {number} */ span)=>
        offset >= 0 && offset + span <= limit && base + offset + span <= bytes.length;

    /**
     * The entries of one directory node, in file order: named first, then id.
     *
     * @param {number} offset  Of the node, from the directory's start.
     */
    const entries = function *(offset){
        if (!within(offset, DIRECTORY_HEADER_SIZE))
        {
            return;
        }
        const at = base + offset;
        const count = view.getUint16(at + 12, true) + view.getUint16(at + 14, true);
        for (let index = 0; index < count; index++)
        {
            const entry = offset + DIRECTORY_HEADER_SIZE + index * ENTRY_SIZE;
            if (!within(entry, ENTRY_SIZE))
            {
                return;
            }
            const first = view.getUint32(base + entry, true);
            const second = view.getUint32(base + entry + 4, true);
            yield {
                key: (first & HIGH_BIT) !== 0
                    ? readName(first & ~HIGH_BIT)
                    : first >>> 0,
                directory: (second & HIGH_BIT) !== 0,
                offset: second & ~HIGH_BIT,
            };
        }
    };

    /**
     * An IMAGE_RESOURCE_DIR_STRING_U: a count of code units, then that many,
     * with nothing after them to stop at.
     *
     * @param {number} offset
     */
    function readName(offset){
        if (!within(offset, 2))
        {
            return '';
        }
        const length = view.getUint16(base + offset, true);
        if (!within(offset, 2 + length * 2))
        {
            return '';
        }
        let text = '';
        for (let unit = 0; unit < length; unit++)
        {
            text += String.fromCharCode(view.getUint16(base + offset + 2 + unit * 2, true));
        }
        return text;
    }

    return {
        root: 0,
        entries,

        /**
         * The entry a key names, or the first one when the key is null.
         *
         * Names match without regard to case, which is what the API promises and
         * what a program relying on it depends on.
         *
         * @param {number} node
         * @param {number | string | null} key
         */
        lookup(node, key){
            for (const entry of entries(node))
            {
                if (key === null)
                {
                    return entry;
                }
                if (typeof key === 'string' && typeof entry.key === 'string')
                {
                    if (key.toLowerCase() === entry.key.toLowerCase())
                    {
                        return entry;
                    }
                    continue;
                }
                if (entry.key === key)
                {
                    return entry;
                }
            }
            return null;
        },

        /**
         * IMAGE_RESOURCE_DATA_ENTRY. Its first field is an RVA, unlike every
         * other offset in this directory.
         *
         * @param {number} offset
         * @param {number | string} language
         * @returns {FoundResource | null}
         */
        leaf(offset, language){
            if (!within(offset, 16))
            {
                return null;
            }
            const at = base + offset;
            return {
                rva: view.getUint32(at, true),
                size: view.getUint32(at + 4, true),
                codePage: view.getUint32(at + 8, true),
                language,
            };
        },
    };
}
