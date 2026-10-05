/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { cabinetChecksum } from './cabinet.js';

/** @param {string} text */
const bytes = text=>Uint8Array.from([...text].map(c=>c.charCodeAt(0)));

/**
 * A cabinet laid out as the format describes it: header, folders, files,
 * then each folder's data blocks, checksummed unless told not to be.
 *
 * @param {{
 *   folders: { compression: number, blocks: { packed: Uint8Array, size: number }[] }[],
 *   files: { name: string, size: number, offset: number, folder: number }[],
 *   reserve?: Uint8Array, dataReserve?: number, checksums?: boolean,
 * }} spec
 */
export function buildCabinet(spec){
    const reserve = spec.reserve ?? null;
    const dataReserve = spec.dataReserve ?? 0;
    const headerSize = 36 + (reserve || dataReserve ? 4 + (reserve?.length ?? 0) : 0);
    const foldersAt = headerSize;
    const filesAt = foldersAt + spec.folders.length * 8;
    const names = spec.files.map(file=>bytes(`${file.name}\0`));
    let dataAt = filesAt + spec.files.reduce((sum, _, i)=>sum + 16 + names[i].length, 0);
    const folderStarts = spec.folders.map(folder=>{
        const start = dataAt;
        dataAt += folder.blocks.reduce((sum, block)=>
            sum + 8 + dataReserve + block.packed.length, 0);
        return start;
    });
    const out = new Uint8Array(dataAt);
    const view = new DataView(out.buffer);
    out.set(bytes('MSCF'), 0);
    view.setUint32(8, out.length, true);
    view.setUint32(16, filesAt, true);
    out[24] = 3;
    out[25] = 1;
    view.setUint16(26, spec.folders.length, true);
    view.setUint16(28, spec.files.length, true);
    view.setUint16(30, reserve || dataReserve ? 4 : 0, true);
    view.setUint16(32, 0x0622, true);
    if (reserve || dataReserve)
    {
        view.setUint16(36, reserve?.length ?? 0, true);
        out[39] = dataReserve;
        out.set(reserve ?? [], 40);
    }
    spec.folders.forEach((folder, i)=>{
        view.setUint32(foldersAt + i * 8, folderStarts[i], true);
        view.setUint16(foldersAt + i * 8 + 4, folder.blocks.length, true);
        view.setUint16(foldersAt + i * 8 + 6, folder.compression, true);
    });
    let at = filesAt;
    spec.files.forEach((file, i)=>{
        view.setUint32(at, file.size, true);
        view.setUint32(at + 4, file.offset, true);
        view.setUint16(at + 8, file.folder, true);
        view.setUint16(at + 10, 0x226c, true);
        view.setUint16(at + 12, 0x59ba, true);
        view.setUint16(at + 14, 0x20, true);
        out.set(names[i], at + 16);
        at += 16 + names[i].length;
    });
    spec.folders.forEach((folder, i)=>{
        let block = folderStarts[i];
        for (const { packed, size } of folder.blocks)
        {
            view.setUint16(block + 4, packed.length, true);
            view.setUint16(block + 6, size, true);
            out.set(packed, block + 8 + dataReserve);
            if (spec.checksums !== false)
            {
                const header = out.subarray(block + 4, block + 8 + dataReserve);
                view.setUint32(block, cabinetChecksum(header, cabinetChecksum(packed, 0)), true);
            }
            block += 8 + dataReserve + packed.length;
        }
    });
    return out;
}

