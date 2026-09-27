/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * NTSTATUS, and the Win32 error each one becomes.
 *
 * The native interface and the Win32 one do not share an error domain. A status
 * is a bitfield whose top two bits are its severity, a Win32 error is a small
 * ordinal, and the same failure carries a different number in each. A program
 * that calls an Nt entry point and then reports through GetLastError crosses
 * between them, and this table is the whole of that crossing.
 *
 * A status that is not here becomes ERROR_MR_MID_NOT_FOUND, which is what
 * Windows answers for a status it has no message for. That is a real code a
 * caller can recognise, unlike a guess at what the failure meant.
 */

/** The statuses this library produces or translates. */
export const STATUS = Object.freeze({
    SUCCESS: 0x00000000,
    TIMEOUT: 0x00000102,
    PENDING: 0x00000103,
    BUFFER_OVERFLOW: 0x80000005,
    NO_MORE_FILES: 0x80000006,
    NO_MORE_ENTRIES: 0x8000001a,
    UNSUCCESSFUL: 0xc0000001,
    NOT_IMPLEMENTED: 0xc0000002,
    INVALID_INFO_CLASS: 0xc0000003,
    INFO_LENGTH_MISMATCH: 0xc0000004,
    ACCESS_VIOLATION: 0xc0000005,
    INVALID_HANDLE: 0xc0000008,
    INVALID_PARAMETER: 0xc000000d,
    NO_SUCH_DEVICE: 0xc000000e,
    NO_SUCH_FILE: 0xc000000f,
    END_OF_FILE: 0xc0000011,
    NO_MEMORY: 0xc0000017,
    ACCESS_DENIED: 0xc0000022,
    BUFFER_TOO_SMALL: 0xc0000023,
    OBJECT_NAME_INVALID: 0xc0000033,
    OBJECT_NAME_NOT_FOUND: 0xc0000034,
    OBJECT_NAME_COLLISION: 0xc0000035,
    OBJECT_PATH_NOT_FOUND: 0xc000003a,
    SHARING_VIOLATION: 0xc0000043,
    DISK_FULL: 0xc000007f,
    INSUFFICIENT_RESOURCES: 0xc000009a,
    NOT_SUPPORTED: 0xc00000bb,
    /** The second argument, counting from one, as the native codes number them. */
    INVALID_PARAMETER_2: 0xc00000f0,
    NOT_A_DIRECTORY: 0xc0000103,
    NAME_TOO_LONG: 0xc0000106,
    CANNOT_DELETE: 0xc0000121,
    /** RtlVerifyVersionInfo's answer when the system does not meet the request. */
    REVISION_MISMATCH: 0xc0000059,
});

/** The Win32 errors this table produces. */
const ERROR = Object.freeze({
    SUCCESS: 0,
    INVALID_FUNCTION: 1,
    FILE_NOT_FOUND: 2,
    PATH_NOT_FOUND: 3,
    ACCESS_DENIED: 5,
    INVALID_HANDLE: 6,
    NOT_ENOUGH_MEMORY: 8,
    NO_MORE_FILES: 18,
    BAD_LENGTH: 24,
    GEN_FAILURE: 31,
    SHARING_VIOLATION: 32,
    HANDLE_EOF: 38,
    NOT_SUPPORTED: 50,
    INVALID_PARAMETER: 87,
    DISK_FULL: 112,
    INSUFFICIENT_BUFFER: 122,
    INVALID_NAME: 123,
    FILENAME_EXCED_RANGE: 206,
    ALREADY_EXISTS: 183,
    MORE_DATA: 234,
    WAIT_TIMEOUT: 258,
    NO_MORE_ITEMS: 259,
    DIRECTORY: 267,
    MR_MID_NOT_FOUND: 317,
    IO_PENDING: 997,
    NOACCESS: 998,
    REVISION_MISMATCH: 1306,
    NO_SYSTEM_RESOURCES: 1450,
});

/**
 * The translation is many-to-one in this direction and has no inverse: four
 * different reasons a name cannot be resolved all arrive as ERROR_FILE_NOT_FOUND,
 * which is what a program written against Win32 was expecting to see.
 */
/** @type {Map<number, number>} */
const TO_DOS_ERROR = new Map([
    [STATUS.SUCCESS, ERROR.SUCCESS],
    [STATUS.TIMEOUT, ERROR.WAIT_TIMEOUT],
    [STATUS.PENDING, ERROR.IO_PENDING],
    [STATUS.BUFFER_OVERFLOW, ERROR.MORE_DATA],
    [STATUS.NO_MORE_FILES, ERROR.NO_MORE_FILES],
    [STATUS.NO_MORE_ENTRIES, ERROR.NO_MORE_ITEMS],
    [STATUS.UNSUCCESSFUL, ERROR.GEN_FAILURE],
    [STATUS.NOT_IMPLEMENTED, ERROR.INVALID_FUNCTION],
    [STATUS.INVALID_INFO_CLASS, ERROR.INVALID_PARAMETER],
    [STATUS.INFO_LENGTH_MISMATCH, ERROR.BAD_LENGTH],
    [STATUS.ACCESS_VIOLATION, ERROR.NOACCESS],
    [STATUS.INVALID_HANDLE, ERROR.INVALID_HANDLE],
    [STATUS.INVALID_PARAMETER, ERROR.INVALID_PARAMETER],
    [STATUS.NO_SUCH_DEVICE, ERROR.FILE_NOT_FOUND],
    [STATUS.NO_SUCH_FILE, ERROR.FILE_NOT_FOUND],
    [STATUS.END_OF_FILE, ERROR.HANDLE_EOF],
    [STATUS.NO_MEMORY, ERROR.NOT_ENOUGH_MEMORY],
    [STATUS.ACCESS_DENIED, ERROR.ACCESS_DENIED],
    [STATUS.BUFFER_TOO_SMALL, ERROR.INSUFFICIENT_BUFFER],
    [STATUS.OBJECT_NAME_INVALID, ERROR.INVALID_NAME],
    [STATUS.OBJECT_NAME_NOT_FOUND, ERROR.FILE_NOT_FOUND],
    [STATUS.OBJECT_NAME_COLLISION, ERROR.ALREADY_EXISTS],
    [STATUS.OBJECT_PATH_NOT_FOUND, ERROR.PATH_NOT_FOUND],
    [STATUS.SHARING_VIOLATION, ERROR.SHARING_VIOLATION],
    [STATUS.DISK_FULL, ERROR.DISK_FULL],
    [STATUS.INSUFFICIENT_RESOURCES, ERROR.NO_SYSTEM_RESOURCES],
    [STATUS.NOT_SUPPORTED, ERROR.NOT_SUPPORTED],
    [STATUS.INVALID_PARAMETER_2, ERROR.INVALID_PARAMETER],
    [STATUS.NOT_A_DIRECTORY, ERROR.DIRECTORY],
    [STATUS.NAME_TOO_LONG, ERROR.FILENAME_EXCED_RANGE],
    [STATUS.CANNOT_DELETE, ERROR.ACCESS_DENIED],
    [STATUS.REVISION_MISMATCH, ERROR.REVISION_MISMATCH],
]);

/** What an unmapped status becomes, and the one code that means "no mapping". */
export const ERROR_MR_MID_NOT_FOUND = ERROR.MR_MID_NOT_FOUND;

/**
 * @param {number} status
 * @returns {number} the Win32 error a caller will report
 */
export function toDosError(status){
    return TO_DOS_ERROR.get(status >>> 0) ?? ERROR.MR_MID_NOT_FOUND;
}
