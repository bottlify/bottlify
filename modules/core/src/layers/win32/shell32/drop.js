/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A drop's HDROP: the global block WM_DROPFILES hands a window, a DROPFILES
 * header then the dropped paths, each ended by a NUL and the list by one
 * more, in the ANSI page or UTF-16 as the header's fWide says. The block is
 * whoever made it -- a program can post its own -- so it is read through
 * kernel32's GlobalLock as the program reads it, never kept.
 */

/** DROPFILES: where the list starts, the drop point, whether it fell outside the client area, its width. */
const DROPFILES = Object.freeze({ pFiles: 0, x: 4, y: 8, fNC: 12, fWide: 16 });

/** DragQueryFile's index that asks how many files there are. */
const COUNT_FILES = 0xffffffff;

/** The most a list is read through, which no list of paths comes near. */
const MOST_LIST = 0x10000;

/**
 * @typedef {Object} DropHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(library: string) => Record<string, { handler: (args: number[]) => any }>
 *     | undefined} [library]
 */

/**
 * @param {Uint8Array} bytes @param {boolean} wide
 * @returns {string[]} the paths of a list, to its empty one
 */
export function dropPaths(bytes, wide){
    const unit = wide ? 2 : 1;
    /** @type {string[]} */
    const paths = [];
    let text = '';
    for (let at = 0; at + unit <= bytes.length; at += unit)
    {
        const code = wide ? bytes[at] | bytes[at + 1] << 8 : bytes[at];
        if (code !== 0)
        {
            text += String.fromCharCode(code);
            continue;
        }
        if (text === '')
        {
            break;
        }
        paths.push(text);
        text = '';
    }
    return paths;
}

/**
 * @param {DropHost} host
 * @param {(bytes: Uint8Array) => string} decode  The ANSI page.
 * @param {(text: string) => Uint8Array} encode   The ANSI page, no terminator.
 */
export function createDropFunctions(host, decode, encode){
    /** @param {string} name @param {number[]} args */
    const kernel32 = async(name, args)=>{
        const target = host.library?.('KERNEL32.dll')?.[name];
        return target ? /** @type {number} */ (await target.handler(args)) >>> 0 : 0;
    };

    /**
     * What a drop holds, read under the program's own lock; null for a
     * handle that is no block.
     *
     * @param {number} drop
     */
    const readDrop = async drop=>{
        const at = await kernel32('GlobalLock', [drop]);
        if (at === 0)
        {
            return null;
        }
        try
        {
            const header = host.readMemory(at, 20);
            const view = new DataView(header.slice().buffer);
            const wide = view.getUint32(DROPFILES.fWide, true) !== 0;
            const size = await kernel32('GlobalSize', [drop]);
            const start = view.getUint32(DROPFILES.pFiles, true);
            const length = Math.max(0, Math.min(size || MOST_LIST, MOST_LIST) - start);
            const raw = dropPaths(host.readMemory(at + start, length), wide);
            return {
                paths: wide ? raw
                    : raw.map(path=>decode(Uint8Array.from(path, c=>c.charCodeAt(0)))),
                x: view.getInt32(DROPFILES.x, true),
                y: view.getInt32(DROPFILES.y, true),
                client: view.getUint32(DROPFILES.fNC, true) === 0,
            };
        }
        finally
        {
            await kernel32('GlobalUnlock', [drop]);
        }
    };

    /**
     * DragQueryFile for either width: the count for 0xFFFFFFFF, the path's
     * length for no buffer, else the path cut to the buffer with its
     * terminator and the characters copied (Wine's shellole drop test).
     *
     * @param {boolean} wide
     */
    const dragQueryFile = wide=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: async([drop, index, buffer, room])=>{
            const read = await readDrop(drop);
            if (read === null)
            {
                return 0;
            }
            if ((index >>> 0) === COUNT_FILES)
            {
                return read.paths.length;
            }
            const path = read.paths[index >>> 0];
            if (path === undefined)
            {
                return 0;
            }
            if ((buffer >>> 0) === 0 || (room >>> 0) === 0)
            {
                return wide ? path.length : encode(path).length;
            }
            const cut = path.slice(0, (room >>> 0) - 1);
            if (wide)
            {
                const bytes = new Uint8Array((cut.length + 1) * 2);
                for (let i = 0; i < cut.length; i++)
                {
                    bytes[i * 2] = cut.charCodeAt(i) & 0xff;
                    bytes[i * 2 + 1] = cut.charCodeAt(i) >>> 8;
                }
                host.writeMemory(buffer >>> 0, bytes);
                return cut.length;
            }
            const bytes = encode(cut);
            host.writeMemory(buffer >>> 0, Uint8Array.of(...bytes, 0));
            return bytes.length;
        },
    });

    return {
        DragQueryFileA: dragQueryFile(false),
        DragQueryFileW: dragQueryFile(true),

        /**
         * BOOL DragQueryPoint(HDROP hDrop, POINT *ppt)
         *
         * Where the drop fell, in the window's client coordinates; TRUE when
         * that was inside the client area.
         */
        DragQueryPoint: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: async([drop, point])=>{
                const read = await readDrop(drop);
                if (read === null)
                {
                    return 0;
                }
                if ((point >>> 0) !== 0)
                {
                    const bytes = new Uint8Array(8);
                    const view = new DataView(bytes.buffer);
                    view.setInt32(0, read.x, true);
                    view.setInt32(4, read.y, true);
                    host.writeMemory(point >>> 0, bytes);
                }
                return read.client ? 1 : 0;
            },
        },

        /** void DragFinish(HDROP hDrop): the block freed. */
        DragFinish: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: async([drop])=>{
                await kernel32('GlobalFree', [drop]);
                return 0;
            },
        },
    };
}
