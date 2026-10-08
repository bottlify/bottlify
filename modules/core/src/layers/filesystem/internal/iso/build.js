/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A disc image built from a tree of files: a primary volume descriptor, a
 * Joliet one when asked for, a terminator, both directory trees and the files'
 * bytes, laid out the way a mastering program lays a disc out. The primary
 * tree carries upper-case short names with a version, the Joliet tree the
 * names as given, and both point at the same bytes.
 *
 * What a disc image is to the engine, for files that came as something else:
 * an archive a setup was shipped in is mounted as the disc it stands in for.
 * The tests build their discs with it too, with the layouts a real mastering
 * program leaves (split and interleaved files, hidden entries).
 *
 * Path tables are left empty: the engine's reader walks directories and never
 * looks at them.
 */

const SECTOR = 2048;

/**
 * @typedef {Object} FixtureOptions
 * @property {Record<string, Uint8Array | string | null>} files
 *        Paths with `/` or `\`, to their bytes; null makes an empty directory.
 * @property {string} [label]
 * @property {boolean} [joliet]      Write a Joliet tree too (the default).
 * @property {string[]} [hidden]     Paths recorded with the existence bit.
 * @property {Record<string, number>} [split]
 *        A file written as several extents of at most this many bytes, one
 *        sector apart, all but the last marked as continued.
 * @property {Record<string, { unit: number, gap: number }>} [interleave]
 * @property {number[]} [time]       Recording time: years since 1900, month, day,
 *                                   hour, minute, second, zone in quarter hours.
 */

/** @param {Uint8Array} out @param {number} at @param {number} value */
const both16 = (out, at, value)=>{
    out[at] = value & 0xff;
    out[at + 1] = value >>> 8 & 0xff;
    out[at + 2] = value >>> 8 & 0xff;
    out[at + 3] = value & 0xff;
};

/** @param {Uint8Array} out @param {number} at @param {number} value */
const both32 = (out, at, value)=>{
    for (let byte = 0; byte < 4; byte++)
    {
        out[at + byte] = value >>> byte * 8 & 0xff;
        out[at + 7 - byte] = value >>> byte * 8 & 0xff;
    }
};

/** @param {string} text @returns {Uint8Array} */
const latin1 = text=>Uint8Array.from(text, character=>character.charCodeAt(0) & 0xff);

/** @param {string} text @returns {Uint8Array} */
const ucs2 = text=>{
    const out = new Uint8Array(text.length * 2);
    for (let index = 0; index < text.length; index++)
    {
        out[index * 2] = text.charCodeAt(index) >>> 8;
        out[index * 2 + 1] = text.charCodeAt(index) & 0xff;
    }
    return out;
};

/**
 * @typedef {Object} Node
 * @property {string} name
 * @property {string} path
 * @property {boolean} directory
 * @property {Uint8Array} bytes
 * @property {Node[]} children
 * @property {Map<string, string>} short   Primary names of the children, by Joliet name.
 * @property {number} primaryAt   Sector of its primary directory.
 * @property {number} jolietAt    Sector of its Joliet directory.
 * @property {number} dataAt      Sector of a file's first byte.
 */

/**
 * @param {FixtureOptions} options
 * @returns {Uint8Array<ArrayBuffer>}
 */
export function buildIso({
    files, label = 'TESTDISC', joliet = true, hidden = [], split = {}, interleave = {},
    time = [101, 2, 3, 4, 5, 6, 0],
})
{
    /** @param {string} name @param {string} path @param {boolean} directory @returns {Node} */
    const node = (name, path, directory)=>({
        name, path, directory, bytes: new Uint8Array(0), children: [], short: new Map(),
        primaryAt: 0, jolietAt: 0, dataAt: 0,
    });
    const root = node('', '', true);
    const hiddenSet = new Set(hidden.map(path=>path.replace(/\//g, '\\')));

    for (const [spelled, content] of Object.entries(files))
    {
        const parts = spelled.split(/[\\/]/).filter(Boolean);
        let at = root;
        parts.forEach((part, index)=>{
            const leaf = index === parts.length - 1;
            let child = at.children.find(existing=>existing.name === part);
            if (!child)
            {
                child = node(part, parts.slice(0, index + 1).join('\\'), !leaf || content === null);
                at.children.push(child);
            }
            if (leaf && content !== null)
            {
                child.bytes = typeof content === 'string' ? latin1(content) : content;
            }
            at = child;
        });
    }

    /** @param {Node} directory */
    const shortNames = directory=>{
        const taken = new Set();
        for (const child of directory.children)
        {
            const dot = child.directory ? -1 : child.name.lastIndexOf('.');
            const clean = (/** @type {string} */ text)=>text.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
            const base = clean(dot < 0 ? child.name : child.name.slice(0, dot)).slice(0, 8);
            const extension = dot < 0 ? '' : clean(child.name.slice(dot + 1)).slice(0, 3);
            let name = child.directory ? base : `${base}.${extension}`;
            for (let counter = 1; taken.has(name); counter++)
            {
                const stem = `${base.slice(0, 6)}~${counter}`;
                name = child.directory ? stem : `${stem}.${extension}`;
            }
            taken.add(name);
            directory.short.set(child.name, child.directory ? name : `${name};1`);
            if (child.directory)
            {
                shortNames(child);
            }
        }
    };
    shortNames(root);

    /** @param {Node} child */
    const extentsOf = child=>{
        const limit = split[child.path] ?? child.bytes.length;
        const sizes = [];
        for (let left = child.bytes.length; left > limit; left -= limit)
        {
            sizes.push(limit);
        }
        sizes.push(child.bytes.length - sizes.reduce((sum, size)=>sum + size, 0));
        return sizes;
    };

    /** @param {Uint8Array} identifier @param {number} extents */
    const recordLength = (identifier, extents = 1)=>
        (33 + identifier.length + (identifier.length % 2 === 0 ? 1 : 0)) * extents;

    /** @param {Node} directory @param {boolean} wide */
    const identifierOf = (directory, wide)=>(/** @type {Node} */ child)=>(wide
        ? ucs2(child.name) : latin1(/** @type {string} */ (directory.short.get(child.name))));

    /** @param {Uint8Array} a @param {Uint8Array} b */
    const compare = (a, b)=>{
        for (let at = 0; at < Math.min(a.length, b.length); at++)
        {
            if (a[at] !== b[at])
            {
                return a[at] - b[at];
            }
        }
        return a.length - b.length;
    };

    /**
     * A directory's children in the order its records are written: by
     * identifier, as the format asks.
     *
     * @param {Node} directory @param {boolean} wide
     */
    const childrenOf = (directory, wide)=>[...directory.children].sort((a, b)=>
        compare(identifierOf(directory, wide)(a), identifierOf(directory, wide)(b)));

    /** @param {Node} directory @param {boolean} wide @returns {number} sectors */
    const directorySectors = (directory, wide)=>{
        let sectors = 1;
        let used = recordLength(new Uint8Array(1)) * 2;
        for (const child of childrenOf(directory, wide))
        {
            const extents = child.directory ? 1 : extentsOf(child).length;
            const one = recordLength(identifierOf(directory, wide)(child));
            for (let count = 0; count < extents; count++)
            {
                if (used + one > SECTOR)
                {
                    sectors++;
                    used = 0;
                }
                used += one;
            }
        }
        return sectors;
    };

    /** @type {Node[]} */
    const directories = [];
    /** @param {Node} directory */
    const collect = directory=>{
        directories.push(directory);
        directory.children.filter(child=>child.directory).forEach(collect);
    };
    collect(root);

    /**
     * Every directory of one tree in path table order: level by level, each
     * level by its parent's number and then by identifier.
     *
     * @param {boolean} wide @returns {{ node: Node, parent: number, identifier: Uint8Array }[]}
     */
    const pathOrder = wide=>{
        /** @type {{ node: Node, parent: number, identifier: Uint8Array }[]} */
        const out = [{ node: root, parent: 1, identifier: new Uint8Array([0]) }];
        for (let index = 0; index < out.length; index++)
        {
            for (const child of childrenOf(out[index].node, wide).filter(entry=>entry.directory))
            {
                out.push({ node: child, parent: index + 1,
                    identifier: identifierOf(out[index].node, wide)(child) });
            }
        }
        return out;
    };

    // Descriptors at 16, 17 (Joliet) and a terminator; a sector for each path
    // table, little- and big-endian for each tree; then the trees; then data.
    const tablesAt = 16 + (joliet ? 2 : 1) + 1;
    let next = tablesAt + (joliet ? 4 : 2);
    const sectorsOf = new Map();
    for (const directory of directories)
    {
        directory.primaryAt = next;
        sectorsOf.set(`p:${directory.path}`, directorySectors(directory, false));
        next += sectorsOf.get(`p:${directory.path}`);
    }
    if (joliet)
    {
        for (const directory of directories)
        {
            directory.jolietAt = next;
            sectorsOf.set(`j:${directory.path}`, directorySectors(directory, true));
            next += sectorsOf.get(`j:${directory.path}`);
        }
    }

    /** @type {Map<Node, { at: number, length: number, unit: number, gap: number }[]>} */
    const placed = new Map();
    /** @param {Node} directory */
    const place = directory=>{
        for (const child of directory.children)
        {
            if (child.directory)
            {
                place(child);
                continue;
            }
            const woven = interleave[child.path];
            if (woven)
            {
                const units = Math.max(1, Math.ceil(child.bytes.length / (woven.unit * SECTOR)));
                placed.set(child, [{ at: next, length: child.bytes.length, ...woven }]);
                next += units * (woven.unit + woven.gap);
                continue;
            }
            /** @type {{ at: number, length: number, unit: number, gap: number }[]} */
            const runs = [];
            for (const size of extentsOf(child))
            {
                runs.push({ at: next, length: size, unit: 0, gap: 0 });
                // One sector left empty between the parts, so a reader that
                // treats them as one run reads the wrong bytes.
                next += Math.ceil(size / SECTOR) + (runs.length < extentsOf(child).length ? 1 : 0);
            }
            placed.set(child, runs);
        }
    };
    place(root);

    const image = new Uint8Array(Math.max(next, 20) * SECTOR);
    const volumeSectors = image.length / SECTOR;

    /**
     * @param {number} at @param {Uint8Array} identifier @param {number} extent
     * @param {number} size @param {number} flags @param {number} [unit] @param {number} [gap]
     * @returns {number} the record's length
     */
    const writeRecord = (at, identifier, extent, size, flags, unit = 0, gap = 0)=>{
        const length = recordLength(identifier);
        image[at] = length;
        both32(image, at + 2, extent);
        both32(image, at + 10, size);
        image.set(time.map(value=>value & 0xff), at + 18);
        image[at + 25] = flags;
        image[at + 26] = unit;
        image[at + 27] = gap;
        both16(image, at + 28, 1);
        image[at + 32] = identifier.length;
        image.set(identifier, at + 33);
        return length;
    };

    /** @param {Node} directory @param {Node | null} parent @param {boolean} wide */
    const writeDirectory = (directory, parent, wide)=>{
        const key = wide ? 'j' : 'p';
        const own = wide ? directory.jolietAt : directory.primaryAt;
        const size = sectorsOf.get(`${key}:${directory.path}`) * SECTOR;
        const up = parent ? (wide ? parent.jolietAt : parent.primaryAt) : own;
        const upSize = sectorsOf.get(`${key}:${parent ? parent.path : directory.path}`) * SECTOR;
        let at = own * SECTOR;
        at += writeRecord(at, new Uint8Array([0]), own, size, 2);
        at += writeRecord(at, new Uint8Array([1]), up, upSize, 2);
        for (const child of childrenOf(directory, wide))
        {
            const identifier = identifierOf(directory, wide)(child);
            const runs = child.directory
                ? [{ at: wide ? child.jolietAt : child.primaryAt,
                    length: sectorsOf.get(`${key}:${child.path}`) * SECTOR, unit: 0, gap: 0 }]
                : /** @type {any[]} */ (placed.get(child));
            runs.forEach((run, index)=>{
                if (at % SECTOR + recordLength(identifier) > SECTOR)
                {
                    at = Math.ceil(at / SECTOR) * SECTOR;
                }
                const flags = (child.directory ? 2 : 0) | (hiddenSet.has(child.path) ? 1 : 0)
                    | (index < runs.length - 1 ? 0x80 : 0);
                at += writeRecord(at, identifier, run.at, run.length, flags, run.unit, run.gap);
            });
        }
        for (const child of directory.children.filter(entry=>entry.directory))
        {
            writeDirectory(child, directory, wide);
        }
    };

    /** @param {boolean} wide */
    const writePathTables = wide=>{
        const little = tablesAt + (wide ? 2 : 0);
        const big = little + 1;
        const view = new DataView(image.buffer);
        let size = 0;
        for (const { node: directory, parent, identifier } of pathOrder(wide))
        {
            const extent = wide ? directory.jolietAt : directory.primaryAt;
            for (const [sector, le] of [[little, true], [big, false]])
            {
                const at = /** @type {number} */ (sector) * SECTOR + size;
                image[at] = identifier.length;
                view.setUint32(at + 2, extent, /** @type {boolean} */ (le));
                view.setUint16(at + 6, parent, /** @type {boolean} */ (le));
                image.set(identifier, at + 8);
            }
            size += 8 + identifier.length + identifier.length % 2;
        }
        if (size > SECTOR)
        {
            throw new Error('the fixture keeps each path table in one sector');
        }
        return { size, little, big };
    };

    /** @param {number} sector @param {number} type @param {boolean} wide */
    const writeDescriptor = (sector, type, wide)=>{
        const at = sector * SECTOR;
        image[at] = type;
        image.set(latin1('CD001'), at + 1);
        image[at + 6] = 1;
        const labelBytes = wide ? ucs2(label.padEnd(16, ' ')) : latin1(label.padEnd(32, ' '));
        image.set(labelBytes.subarray(0, 32), at + 40);
        both32(image, at + 80, volumeSectors);
        if (wide)
        {
            image.set(latin1('%/E'), at + 88);
        }
        both16(image, at + 120, 1);
        both16(image, at + 124, 1);
        both16(image, at + 128, SECTOR);
        const table = writePathTables(wide);
        both32(image, at + 132, table.size);
        new DataView(image.buffer).setUint32(at + 140, table.little, true);
        new DataView(image.buffer).setUint32(at + 148, table.big, false);
        const rootAt = wide ? root.jolietAt : root.primaryAt;
        const rootSize = sectorsOf.get(`${wide ? 'j' : 'p'}:`) * SECTOR;
        writeRecord(at + 156, new Uint8Array([0]), rootAt, rootSize, 2);
        image[at + 881] = 1;
    };

    writeDescriptor(16, 1, false);
    if (joliet)
    {
        writeDescriptor(17, 2, true);
    }
    const terminator = (joliet ? 18 : 17) * SECTOR;
    image[terminator] = 255;
    image.set(latin1('CD001'), terminator + 1);
    image[terminator + 6] = 1;

    writeDirectory(root, null, false);
    if (joliet)
    {
        writeDirectory(root, null, true);
    }

    for (const [child, runs] of placed)
    {
        let written = 0;
        for (const run of runs)
        {
            if (run.unit === 0)
            {
                image.set(child.bytes.subarray(written, written + run.length), run.at * SECTOR);
                written += run.length;
                continue;
            }
            const unitBytes = run.unit * SECTOR;
            for (let unit = 0; written < child.bytes.length; unit++)
            {
                const piece = child.bytes.subarray(written, written + unitBytes);
                image.set(piece, (run.at + unit * (run.unit + run.gap)) * SECTOR);
                written += piece.length;
            }
        }
    }
    return image;
}
