/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What DirectX's redistributable setup installs, read from its cabinets: each
 * component a cabinet with the INF the setup installs it by. Both the setup a
 * title runs (`programs/dxsetup.js`) and a Steam bottle's install
 * (`steam/redist.js`) put the same files down from here.
 */

import { readCabinet, decodeFolder } from '../cabinet/cabinet.js';

/**
 * The optional components' cabinets (`Jun2010_d3dx10_43_x86.cab`): what the
 * setup installs on XP and later. dxnt.cab, DirectX.cab and the like carry the
 * system's own DirectX for systems before it, which the setup leaves alone
 * there and the engine answers for itself.
 */
export const DIRECTX_CABINET = /^[a-z]{3}20\d\d_[^\\/]+\.cab$/i;

/**
 * Bytes as characters of the same codes -- ISO 8859-1, which TextDecoder's
 * 'latin1' is not: it is windows-1252, and 0x80 would come back as the euro sign.
 *
 * @param {Uint8Array} bytes
 */
export const latin1 = bytes=>{
    let text = '';
    for (let at = 0; at < bytes.length; at += 0x8000)
    {
        text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    return text;
};

/**
 * Every file a cabinet holds, by its name in the cabinet.
 *
 * @param {Uint8Array} bytes
 * @returns {Map<string, Uint8Array>}
 */
export function cabinetFiles(bytes){
    const cabinet = readCabinet(bytes);
    /** @type {Map<number, Uint8Array>} */
    const folders = new Map();
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    for (const file of cabinet.files)
    {
        if (!folders.has(file.folder))
        {
            folders.set(file.folder, decodeFolder(cabinet, file.folder));
        }
        const stream = /** @type {Uint8Array} */ (folders.get(file.folder));
        files.set(file.name.replace(/^\.\\/, ''), stream.subarray(file.offset, file.offset + file.size));
    }
    return files;
}

/**
 * An INF file's sections, by name lower-cased, each its lines with comments
 * and blank lines dropped.
 *
 * @param {string} text
 * @returns {Map<string, string[]>}
 */
export function parseInf(text){
    /** @type {Map<string, string[]>} */
    const sections = new Map();
    /** @type {string[] | null} */
    let current = null;
    for (const raw of text.split(/\r?\n/))
    {
        const line = raw.replace(/;.*$/, '').trim();
        const head = /^\[(.+)\]$/.exec(line);
        if (head)
        {
            current = [];
            sections.set(head[1].trim().toLowerCase(), current);
        }
        else if (line && current)
        {
            current.push(line);
        }
    }
    return sections;
}

/** A section's `key = value` lines, by key lower-cased. @param {string[] | undefined} lines */
const keyed = lines=>new Map((lines ?? []).filter(line=>line.includes('=')).map(line=>[
    line.slice(0, line.indexOf('=')).trim().toLowerCase(),
    line.slice(line.indexOf('=') + 1).trim().replace(/^"(.*)"$/, '$1')]));

/** The directory ids DirectX's INFs name: the Windows folder and the system folder. */
const DIRECTORY_IDS = /** @type {Record<string, string>} */ ({
    10: 'C:\\WINDOWS', 11: 'C:\\WINDOWS\\system32' });

/**
 * The files DirectX's setup installs from its cabinets on a machine, as their
 * INFs say: each cabinet's Windows NT INF (its 9x one is not this machine's),
 * every install section of it but the other machine's -- `x86_Install` on a
 * 32-bit machine, `x64_Install` (the 32-bit libraries into SysWOW64) on a
 * 64-bit one -- each file its CopyFiles lists put in its DestinationDirs
 * directory. A 32-bit machine takes no 64-bit image. `unregistered` names the
 * libraries an INF has registered as COM servers ([DllRegisterServer]), which
 * this does not do.
 *
 * @param {Uint8Array[]} cabinets
 * @param {'x86' | 'amd64'} machine
 * @returns {{ files: { path: string, bytes: Uint8Array }[], unregistered: string[] }}
 */
export function directxFiles(cabinets, machine){
    /** @type {Map<string, { path: string, bytes: Uint8Array }>} */
    const files = new Map();
    /** @type {Set<string>} */
    const unregistered = new Set();
    const other = machine === 'amd64' ? 'x86_install' : 'x64_install';
    for (const bytes of cabinets)
    {
        /** @type {Map<string, { name: string, bytes: Uint8Array }>} */
        const inside = new Map();
        try
        {
            for (const [name, content] of cabinetFiles(bytes))
            {
                inside.set(name.toLowerCase(), { name, bytes: content });
            }
        }
        catch {
            continue;
        }
        for (const [name, { bytes: text }] of inside)
        {
            if (!name.endsWith('.inf'))
            {
                continue;
            }
            const inf = parseInf(latin1(text));
            if (!/^\$windows nt\$$/i.test(keyed(inf.get('version')).get('signature') ?? ''))
            {
                continue;
            }
            const directories = keyed(inf.get('destinationdirs'));
            let copied = false;
            for (const [section, lines] of inf)
            {
                const lists = section === other ? undefined : keyed(lines).get('copyfiles');
                for (const list of lists ? lists.split(',').map(one=>one.trim().toLowerCase()) : [])
                {
                    const [id, below] = (directories.get(list)
                        ?? directories.get('defaultdestdir') ?? '').split(',')
                        // A folder below may be quoted: 10,"Driver Cache\i386".
                        .map(one=>one.trim().replace(/^"(.*)"$/, '$1'));
                    const directory = DIRECTORY_IDS[id];
                    for (const line of directory ? inf.get(list) ?? [] : [])
                    {
                        const file = inside.get(line.split(',')[0].trim().toLowerCase());
                        if (!file || (machine === 'x86' && /\.(dll|exe)$/i.test(file.name)
                            && imageMachine(file.bytes.subarray(0, 4096)) !== 'x86'))
                        {
                            continue;
                        }
                        const path = `${directory}${below ? `\\${below}` : ''}\\${file.name}`;
                        files.set(path.toLowerCase(), { path, bytes: file.bytes });
                        copied = true;
                    }
                }
            }
            for (const line of copied ? inf.get('dllregisterserver') ?? [] : [])
            {
                unregistered.add(line.slice(line.lastIndexOf('\\') + 1));
            }
        }
    }
    return { files: [...files.values()], unregistered: [...unregistered].sort() };
}

/**
 * A PE image's machine: `amd64` for an x86-64 one, else `x86`.
 *
 * @param {Uint8Array} bytes  Its first few kilobytes are enough.
 * @returns {'x86' | 'amd64'}
 */
export function imageMachine(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const at = bytes.length >= 0x40 ? view.getUint32(0x3c, true) : 0;
    return at + 6 <= bytes.length && view.getUint16(at + 4, true) === 0x8664 ? 'amd64' : 'x86';
}
