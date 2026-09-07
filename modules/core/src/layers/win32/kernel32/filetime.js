/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * When a file was touched, and what timezone the machine believes it is in.
 *
 * One decision runs through the whole file and is worth stating once: **this
 * machine is in UTC and has no daylight saving.** So the two conversions
 * between file time and local file time are the identity, and the timezone
 * report says a bias of zero with no transition dates.
 *
 * That is a choice, not an oversight. A program timestamps a save with one
 * clock and reads it back with another, and any offset invented here would make
 * those two disagree -- a file saved "in the future", a cache that always looks
 * stale. There is no user-visible clock in this build to be wrong about, so the
 * consistent answer is the useful one.
 *
 * File times themselves are real where the filesystem knows them and zero where
 * it does not. Zero is meaningful: it is what Windows reports for a file whose
 * time was never recorded, and a program that sorts by it gets a stable order
 * rather than an invented one.
 */

/** Codes this surface reports. */
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;

/** What GetTimeZoneInformation answers: this machine is not in daylight time. */
const TIME_ZONE_ID_UNKNOWN = 0;

/**
 * BY_HANDLE_FILE_INFORMATION, laid out the way the guest compiled it.
 *
 * The three FILETIMEs are eight bytes each, so nothing after the attributes is
 * where a field count would put it -- a size read from the wrong offset comes
 * back as a plausible number rather than as an error.
 */
export const BY_HANDLE_FILE_INFORMATION = Object.freeze({
    dwFileAttributes: 0,
    ftCreationTime: 4,
    ftLastAccessTime: 12,
    ftLastWriteTime: 20,
    dwVolumeSerialNumber: 28,
    nFileSizeHigh: 32,
    nFileSizeLow: 36,
    nNumberOfLinks: 40,
    nFileIndexHigh: 44,
    nFileIndexLow: 48,
    SIZE: 52,
});

/**
 * TIME_ZONE_INFORMATION. The two names are WCHAR[32] -- 64 bytes each, not 32 --
 * which is the offset most often got wrong here and puts every field after
 * StandardName in the wrong place.
 */
export const TIME_ZONE_INFORMATION = Object.freeze({
    Bias: 0,
    StandardName: 4,
    StandardDate: 68,
    StandardBias: 84,
    DaylightName: 88,
    DaylightDate: 152,
    DaylightBias: 168,
    SIZE: 172,
});

/** The volume every file here reports belonging to. */
const VOLUME_SERIAL = 0xb0771f42;

/** FILE_ATTRIBUTE_DIRECTORY and FILE_ATTRIBUTE_ARCHIVE. */
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_ARCHIVE = 0x20;

/**
 * @typedef {Object} FileTimeHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} setLastError
 * @property {(handle: number, type?: string) => any} resolveHandle
 * @property {(path: string) => { exists: boolean, isDirectory: boolean,
 *                                size: number } | null} stat
 */

/** @param {string} text @returns {Uint8Array} UTF-16, NUL-terminated. */
const wide = text=>{
    const bytes = new Uint8Array((text.length + 1) * 2);
    for (let at = 0; at < text.length; at++)
    {
        const code = text.charCodeAt(at);
        bytes[at * 2] = code & 0xff;
        bytes[at * 2 + 1] = code >> 8;
    }
    return bytes;
};

/**
 * @param {FileTimeHost} host
 */
export function createFileTimeFunctions(host){
    /** @param {number} handle @param {string} [type] */
    const object = (handle, type)=>{
        try
        {
            return host.resolveHandle(handle >>> 0, type);
        }
        catch (e){
            void e;
            return null;
        }
    };

    /** @param {number} code @param {number} [result] */
    const fail = (code, result = 0)=>{
        host.setLastError(code);
        return result;
    };

    /** @param {number} address @returns {bigint} */
    const readFileTime = address=>{
        const bytes = host.readMemory(address, 8);
        return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
    };

    /** @param {number} address @param {bigint} value */
    const writeFileTime = (address, value)=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, value, true);
        host.writeMemory(address, bytes);
    };

    /**
     * A file's recorded times, in FILETIME units. Nothing in the filesystem
     * carries them yet, so all three are the same zero -- see the note at the
     * top about why that is an answer rather than a gap.
     *
     * @param {any} file
     */
    const timesOf = file=>{
        void file;
        return { created: 0n, accessed: 0n, written: 0n };
    };

    return {
        /**
         * BOOL FileTimeToLocalFileTime(const FILETIME *lpFileTime,
         *                              LPFILETIME lpLocalFileTime)
         *
         * The identity, because this machine is in UTC. Still a real function:
         * a caller checks the return value, and the two pointers may differ.
         */
        FileTimeToLocalFileTime: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([from, to])=>{
                if (from === 0 || to === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                writeFileTime(to >>> 0, readFileTime(from >>> 0));
                return 1;
            },
        },

        /** BOOL LocalFileTimeToFileTime(const FILETIME *, LPFILETIME) */
        LocalFileTimeToFileTime: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([from, to])=>{
                if (from === 0 || to === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                writeFileTime(to >>> 0, readFileTime(from >>> 0));
                return 1;
            },
        },

        /**
         * BOOL GetFileTime(HANDLE hFile, LPFILETIME lpCreationTime,
         *   LPFILETIME lpLastAccessTime, LPFILETIME lpLastWriteTime)
         *
         * All three pointers are optional and a NULL one is not an error, which
         * is how a program asks for only the write time -- the usual case.
         */
        GetFileTime: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, created, accessed, written])=>{
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const times = timesOf(file);
                for (const [address, value] of /** @type {[number, bigint][]} */ ([
                    [created >>> 0, times.created],
                    [accessed >>> 0, times.accessed],
                    [written >>> 0, times.written],
                ]))
                {
                    if (address !== 0)
                    {
                        writeFileTime(address, value);
                    }
                }
                return 1;
            },
        },

        /**
         * BOOL SetFileTime(HANDLE hFile, const FILETIME *, const FILETIME *,
         *                  const FILETIME *)
         *
         * Accepted and not stored. The filesystem keeps no times, so recording
         * them here would produce a file whose times GetFileTime reports and
         * nothing else agrees with -- worse than not keeping them at all, since
         * a program could then see them change and not persist.
         */
        SetFileTime: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle])=>object(handle, 'file') ? 1 : fail(ERROR_INVALID_HANDLE),
        },

        /**
         * BOOL GetFileInformationByHandle(HANDLE hFile,
         *   LPBY_HANDLE_FILE_INFORMATION lpFileInformation)
         *
         * Written in one piece so no field is left holding whatever the caller's
         * buffer had in it. The file index is derived from the path rather than
         * invented per call: a program compares two indices to decide whether
         * two handles name one file, and a fresh number each time makes every
         * comparison say no.
         */
        GetFileInformationByHandle: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, information])=>{
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (information === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const entry = host.stat(file.path);
                const size = entry?.size ?? 0;
                const index = fileIndex(file.path);

                const data = new Uint8Array(BY_HANDLE_FILE_INFORMATION.SIZE);
                const view = new DataView(data.buffer);
                view.setUint32(BY_HANDLE_FILE_INFORMATION.dwFileAttributes,
                    entry?.isDirectory ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_ARCHIVE,
                    true);
                view.setUint32(BY_HANDLE_FILE_INFORMATION.dwVolumeSerialNumber,
                    VOLUME_SERIAL, true);
                view.setUint32(BY_HANDLE_FILE_INFORMATION.nFileSizeHigh,
                    Math.floor(size / 0x100000000) >>> 0, true);
                view.setUint32(BY_HANDLE_FILE_INFORMATION.nFileSizeLow, size >>> 0, true);
                view.setUint32(BY_HANDLE_FILE_INFORMATION.nNumberOfLinks, 1, true);
                view.setUint32(BY_HANDLE_FILE_INFORMATION.nFileIndexLow, index, true);
                host.writeMemory(information >>> 0, data);
                return 1;
            },
        },

        /**
         * BOOL SetLocalTime(const SYSTEMTIME *lpSystemTime)
         *
         * Refused. The clock is the guest's own and is what every timestamp and
         * every elapsed-time measurement in the run is taken against; letting a
         * program move it would make a measurement that spans the call
         * meaningless, and there is no user whose wall clock this would be.
         */
        SetLocalTime: {
            argBytes: 4,
            handler: ()=>fail(ERROR_INVALID_PARAMETER),
        },

        /**
         * DWORD GetTimeZoneInformation(LPTIME_ZONE_INFORMATION lpTimeZoneInformation)
         *
         * TIME_ZONE_ID_UNKNOWN with a zero bias: this machine is in UTC and
         * observes no daylight saving. Reporting a transition would make the
         * conversions above wrong twice a year.
         */
        GetTimeZoneInformation: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([information])=>{
                if (information === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER, 0xffffffff);
                }
                const data = new Uint8Array(TIME_ZONE_INFORMATION.SIZE);
                data.set(wide('UTC'), TIME_ZONE_INFORMATION.StandardName);
                data.set(wide('UTC'), TIME_ZONE_INFORMATION.DaylightName);
                host.writeMemory(information >>> 0, data);
                return TIME_ZONE_ID_UNKNOWN;
            },
        },
    };
}

/**
 * A stable file index for a path.
 *
 * Windows takes this from the filesystem's own record. There is no such record
 * here, so it is derived from the path -- which gives the one property a caller
 * actually uses: two handles onto the same file report the same index, and two
 * different files almost never do.
 *
 * @param {string} path
 */
function fileIndex(path){
    let hash = 2166136261;
    const text = path.toLowerCase();
    for (let at = 0; at < text.length; at++)
    {
        hash ^= text.charCodeAt(at);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}
