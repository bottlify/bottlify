/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * imagehlp's certificate calls: the WIN_CERTIFICATE entries of a PE file's
 * certificate table, which the security directory (data directory 4) locates
 * by file offset, not by RVA.
 *
 * The table is a run of entries, each its own dwLength long (the eight bytes
 * of header counted) and padded to eight bytes. Adding one appends it to the
 * table, which is kept at the end of the file, where the Authenticode format
 * puts it; removing one closes the gap and the file ends where the table now
 * does. The directory entry is rewritten each time; the header's checksum is
 * left as it was, as ImageAddCertificate leaves it.
 */

const ERROR_INVALID_HANDLE = 6;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_BAD_EXE_FORMAT = 193;
const ERROR_INSUFFICIENT_BUFFER = 122;

/** ImageEnumerateCertificates' filter that takes every type. */
const CERT_SECTION_TYPE_ANY = 0xff;
const WIN_CERTIFICATE_HEADER = 8;
const SECURITY_DIRECTORY = 4;

/**
 * @typedef {Object} ImageFile
 * @property {string} path
 * @property {any} node
 * @property {boolean} [write]
 */

/**
 * @typedef {Object} ImageCertificatesHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} setLastError
 * @property {(handle: number) => ImageFile | null} fileOf  A kernel32 file handle's file.
 * @property {{ stat: (path: string) => { size: number } | null,
 *     read: (node: any, offset: number, length: number) => Uint8Array | Promise<Uint8Array>,
 *     write: (node: any, offset: number, bytes: Uint8Array) => number,
 *     truncate: (node: any, size: number) => void }} files
 */

/**
 * Where the security directory's entry is in a PE image, and the table it
 * names; null for a file that is not one.
 *
 * @param {Uint8Array} bytes
 */
export function certificateTable(bytes){
    if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a)
    {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const pe = view.getUint32(0x3c, true);
    if (pe + 24 > bytes.length || view.getUint32(pe, true) !== 0x00004550)
    {
        return null;
    }
    const optional = pe + 24;
    const magic = view.getUint16(optional, true);
    const count = magic === 0x10b ? optional + 92 : magic === 0x20b ? optional + 108 : -1;
    if (count < 0 || count + 4 > bytes.length || view.getUint32(count, true) <= SECURITY_DIRECTORY)
    {
        return null;
    }
    const entry = count + 4 + SECURITY_DIRECTORY * 8;
    const offset = view.getUint32(entry, true);
    const size = view.getUint32(entry + 4, true);
    /** @type {{ at: number, bytes: Uint8Array, type: number }[]} */
    const certificates = [];
    if (offset !== 0 && size !== 0 && offset + size <= bytes.length)
    {
        for (let at = offset; at + WIN_CERTIFICATE_HEADER <= offset + size;)
        {
            const length = view.getUint32(at, true);
            if (length < WIN_CERTIFICATE_HEADER || at + length > offset + size)
            {
                break;
            }
            certificates.push({ at, bytes: bytes.slice(at, at + length),
                type: view.getUint16(at + 6, true) });
            at += (length + 7) & ~7;
        }
    }
    return { entry, offset, size, certificates };
}

/** @param {ImageCertificatesHost} host */
export function createImageCertificateFunctions(host){
    /** @param {number} address */
    const dword = address=>{
        const bytes = host.readMemory(address, 4);
        return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    };
    /** @param {number} address @param {number} value */
    const setDword = (address, value)=>{
        const out = new Uint8Array(4);
        new DataView(out.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address, out);
    };
    /** @param {number} code */
    const fail = code=>{
        host.setLastError(code);
        return 0;
    };

    /**
     * Runs `then` on the file's bytes and its table, the read waited for
     * when it has to be.
     *
     * @param {number} handle
     * @param {(file: ImageFile, bytes: Uint8Array,
     *     table: NonNullable<ReturnType<typeof certificateTable>>) => number} then
     * @returns {number | Promise<number>}
     */
    const withImage = (handle, then)=>{
        const file = host.fileOf(handle >>> 0);
        const stat = file ? host.files.stat(file.path) : null;
        if (!file || !stat)
        {
            return fail(ERROR_INVALID_HANDLE);
        }
        /** @param {Uint8Array} bytes */
        const go = bytes=>{
            const table = certificateTable(bytes);
            return table ? then(file, bytes, table) : fail(ERROR_BAD_EXE_FORMAT);
        };
        const read = host.files.read(file.node, 0, stat.size);
        return read instanceof Promise ? read.then(go) : go(read);
    };

    /**
     * Writes `entries` as the file's table, at the end of the file (where it
     * already ends the file, in place), and the directory entry for it.
     *
     * @param {ImageFile} file @param {Uint8Array} bytes
     * @param {NonNullable<ReturnType<typeof certificateTable>>} table
     * @param {Uint8Array[]} entries
     */
    const rewrite = (file, bytes, table, entries)=>{
        const atEnd = table.offset !== 0 && table.offset + table.size >= bytes.length;
        const start = atEnd ? table.offset : (bytes.length + 7) & ~7;
        const padded = entries.map(one=>{
            const out = new Uint8Array((one.length + 7) & ~7);
            out.set(one);
            return out;
        });
        const size = padded.reduce((total, one)=>total + one.length, 0);
        const out = new Uint8Array(size);
        let at = 0;
        for (const one of padded)
        {
            out.set(one, at);
            at += one.length;
        }
        if (size > 0)
        {
            host.files.write(file.node, start, out);
            host.files.truncate(file.node, start + size);
        }
        else if (atEnd)
        {
            host.files.truncate(file.node, table.offset);
        }
        const directory = new Uint8Array(8);
        const view = new DataView(directory.buffer);
        view.setUint32(0, size === 0 ? 0 : start, true);
        view.setUint32(4, size, true);
        host.files.write(file.node, table.entry, directory);
    };

    return {
        /**
         * BOOL ImageEnumerateCertificates(HANDLE FileHandle, WORD TypeFilter,
         *     PDWORD CertificateCount, PDWORD Indices, DWORD IndexCount)
         */
        ImageEnumerateCertificates: {
            argBytes: 20,
            handler: (/** @type {number[]} */ [handle, filter, countAt, indices, room])=>
                withImage(handle, (_file, _bytes, table)=>{
                    if ((countAt >>> 0) === 0)
                    {
                        return fail(ERROR_INVALID_PARAMETER);
                    }
                    const wanted = filter & 0xffff;
                    const matching = table.certificates.flatMap((one, index)=>
                        (wanted === CERT_SECTION_TYPE_ANY || one.type === wanted ? [index] : []));
                    setDword(countAt >>> 0, matching.length);
                    if ((indices >>> 0) !== 0)
                    {
                        matching.slice(0, room >>> 0).forEach((index, at)=>
                            setDword((indices >>> 0) + at * 4, index));
                    }
                    return 1;
                }),
        },

        /**
         * BOOL ImageGetCertificateData(HANDLE FileHandle, DWORD CertificateIndex,
         *     LPWIN_CERTIFICATE Certificate, PDWORD RequiredLength)
         */
        ImageGetCertificateData: {
            argBytes: 16,
            handler: (/** @type {number[]} */ [handle, index, out, lengthAt])=>
                withImage(handle, (_file, _bytes, table)=>{
                    const certificate = table.certificates[index >>> 0];
                    if (!certificate || (lengthAt >>> 0) === 0)
                    {
                        return fail(ERROR_INVALID_PARAMETER);
                    }
                    const room = dword(lengthAt >>> 0);
                    setDword(lengthAt >>> 0, certificate.bytes.length);
                    if ((out >>> 0) === 0 || room < certificate.bytes.length)
                    {
                        return fail(ERROR_INSUFFICIENT_BUFFER);
                    }
                    host.writeMemory(out >>> 0, certificate.bytes);
                    return 1;
                }),
        },

        /**
         * BOOL ImageAddCertificate(HANDLE FileHandle, LPWIN_CERTIFICATE Certificate,
         *     PDWORD Index)
         */
        ImageAddCertificate: {
            argBytes: 12,
            handler: (/** @type {number[]} */ [handle, certificate, indexAt])=>
                withImage(handle, (file, bytes, table)=>{
                    if (!file.write)
                    {
                        return fail(ERROR_ACCESS_DENIED);
                    }
                    const length = (certificate >>> 0) === 0 ? 0 : dword(certificate >>> 0);
                    if (length < WIN_CERTIFICATE_HEADER)
                    {
                        return fail(ERROR_INVALID_PARAMETER);
                    }
                    const added = host.readMemory(certificate >>> 0, length).slice();
                    rewrite(file, bytes, table,
                        [...table.certificates.map(one=>one.bytes), added]);
                    if ((indexAt >>> 0) !== 0)
                    {
                        setDword(indexAt >>> 0, table.certificates.length);
                    }
                    return 1;
                }),
        },

        /** BOOL ImageRemoveCertificate(HANDLE FileHandle, DWORD Index) */
        ImageRemoveCertificate: {
            argBytes: 8,
            handler: (/** @type {number[]} */ [handle, index])=>
                withImage(handle, (file, bytes, table)=>{
                    if (!file.write)
                    {
                        return fail(ERROR_ACCESS_DENIED);
                    }
                    if ((index >>> 0) >= table.certificates.length)
                    {
                        return fail(ERROR_INVALID_PARAMETER);
                    }
                    rewrite(file, bytes, table, table.certificates
                        .filter((_, at)=>at !== (index >>> 0)).map(one=>one.bytes));
                    return 1;
                }),
        },
    };
}
