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
 * The statuses the engine makes are named here; the rest of Windows' table,
 * for a status a program got elsewhere and hands over, is status-windows.js.
 * A status in neither becomes ERROR_MR_MID_NOT_FOUND, which is what
 * Windows answers for a status it has no message for. That is a real code a
 * caller can recognise, unlike a guess at what the failure meant.
 */

import { WINDOWS_STATUS_ERRORS } from './status-windows.js';

/** The statuses this library produces or translates. */
export const STATUS = Object.freeze({
    SUCCESS: 0x00000000,
    TIMEOUT: 0x00000102,
    PENDING: 0x00000103,
    DATATYPE_MISALIGNMENT: 0x80000002,
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
    DLL_NOT_FOUND: 0xc0000135,
    DLL_INIT_FAILED: 0xc0000142,
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
    /** What a section is refused with or answers. */
    /** A success: an image's view is mapped, away from its base and moved there. */
    IMAGE_NOT_AT_BASE: 0x40000003,
    /** An image with no fixups whose base is taken. */
    CONFLICTING_ADDRESSES: 0xc0000018,
    NOT_MAPPED_VIEW: 0xc0000019,
    INVALID_VIEW_SIZE: 0xc000001f,
    INVALID_FILE_FOR_SECTION: 0xc0000020,
    OBJECT_TYPE_MISMATCH: 0xc0000024,
    SECTION_TOO_BIG: 0xc0000040,
    /** A protection a section, or a page of a view of one, cannot have. */
    INVALID_PAGE_PROTECTION: 0xc0000045,
    SECTION_NOT_IMAGE: 0xc0000049,
    MAPPED_FILE_SIZE_ZERO: 0xc000011e,
    INVALID_IMAGE_NOT_MZ: 0xc000012f,
    /** An MZ file whose headers describe no image. */
    INVALID_IMAGE_FORMAT: 0xc000007b,
    /** An MZ file of the other kinds: a 16-bit NE one, a Windows 16-bit one, one
     *  whose new header cannot be read or is no kind at all. */
    INVALID_IMAGE_NE_FORMAT: 0xc000011b,
    INVALID_IMAGE_PROTECT: 0xc0000130,
    INVALID_IMAGE_WIN_16: 0xc0000131,
    /** An x86-64 image on a machine that runs none. */
    INVALID_IMAGE_WIN_64: 0xc000035a,
    /** A client id that names no process or thread. */
    INVALID_CID: 0xc000000b,
    /** Two ways of naming one object given together, or neither given. */
    INVALID_PARAMETER_MIX: 0xc0000030,
    /** What a resource lookup is refused with, by the part that was missing. */
    RESOURCE_DATA_NOT_FOUND: 0xc0000089,
    RESOURCE_TYPE_NOT_FOUND: 0xc000008a,
    RESOURCE_NAME_NOT_FOUND: 0xc000008b,
    RESOURCE_LANG_NOT_FOUND: 0xc0000204,
    /** A message table that holds no message by that number. */
    MESSAGE_NOT_FOUND: 0xc0000109,
    /** A pipe's: its other end gone, cut off, still listening, closing; an I/O cancelled. */
    PIPE_BROKEN: 0xc000014b,
    PIPE_DISCONNECTED: 0xc00000b0,
    PIPE_LISTENING: 0xc00000b3,
    PIPE_CLOSING: 0xc00000b1,
    /** A listen whose client came first. */
    PIPE_CONNECTED: 0xc00000b2,
    /** A cancel that found no I/O to cancel. */
    NOT_FOUND: 0xc0000225,
    /** A pipe end in no state for the request: a server cut from its client. */
    INVALID_PIPE_STATE: 0xc00000ad,
    /** A file-system or device control code the object does not answer. */
    INVALID_DEVICE_REQUEST: 0xc0000010,
    /** A pipe whose instances are all made: no other is to be had. */
    INSTANCE_NOT_AVAILABLE: 0xc00000ab,
    /** A pipe none of whose instances listens: a client cannot open it now. */
    PIPE_NOT_AVAILABLE: 0xc00000ac,
    /** A request the object is of the wrong kind for: a client end asked to listen. */
    ILLEGAL_FUNCTION: 0xc00000af,
    /** A wait for a pipe instance whose time ran out. */
    IO_TIMEOUT: 0xc00000b5,
    /** A transaction asked of an end with an answer already waiting unread. */
    PIPE_BUSY: 0xc00000ae,
    /** A transaction asked of a pipe not read as messages. */
    INVALID_READ_MODE: 0xc00000b4,
    /** A name that cannot be spelled for its object: an unnamed pipe's. */
    OBJECT_PATH_INVALID: 0xc0000039,
    CANCELLED: 0xc0000120,
    /** A success: a create with OBJ_OPENIF opened an object its name held already. */
    OBJECT_NAME_EXISTS: 0x40000000,
    /** A mutant released by a thread that does not own it; a semaphore past its maximum. */
    MUTANT_NOT_OWNED: 0xc0000046,
    SEMAPHORE_LIMIT_EXCEEDED: 0xc0000047,
    /** A reparse point's: none there, its buffer or tag malformed or not the one set,
     *  a tag no filter answers, one standing for what cannot be reached. */
    NOT_A_REPARSE_POINT: 0xc0000275,
    IO_REPARSE_TAG_INVALID: 0xc0000276,
    IO_REPARSE_TAG_MISMATCH: 0xc0000277,
    IO_REPARSE_DATA_INVALID: 0xc0000278,
    IO_REPARSE_TAG_NOT_HANDLED: 0xc0000279,
    REPARSE_POINT_NOT_RESOLVED: 0xc0000280,
    /** A buffer handed in with no room or none at all, where one was asked for. */
    INVALID_USER_BUFFER: 0xc00000e8,
    INVALID_BUFFER_SIZE: 0xc0000206,
    DIRECTORY_NOT_EMPTY: 0xc0000101,
    PRIVILEGE_NOT_HELD: 0xc0000061,
    MEDIA_WRITE_PROTECTED: 0xc00000a2,
});

/** The Win32 errors this table produces. */
const ERROR = Object.freeze({
    SUCCESS: 0,
    INVALID_FUNCTION: 1,
    FILE_NOT_FOUND: 2,
    PATH_NOT_FOUND: 3,
    ACCESS_DENIED: 5,
    MOD_NOT_FOUND: 126,
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
    SEM_TIMEOUT: 121,
    BAD_PATHNAME: 161,
    FILENAME_EXCED_RANGE: 206,
    ALREADY_EXISTS: 183,
    OBJECT_NAME_EXISTS: 698,
    MORE_DATA: 234,
    WAIT_TIMEOUT: 258,
    NO_MORE_ITEMS: 259,
    DIRECTORY: 267,
    NOT_A_REPARSE_POINT: 4390,
    INVALID_REPARSE_DATA: 4392,
    REPARSE_TAG_INVALID: 4393,
    REPARSE_TAG_MISMATCH: 4394,
    CANT_ACCESS_FILE: 1920,
    CANT_RESOLVE_FILENAME: 1921,
    INVALID_USER_BUFFER: 1784,
    DIR_NOT_EMPTY: 145,
    PRIVILEGE_NOT_HELD: 1314,
    WRITE_PROTECT: 19,
    BAD_EXE_FORMAT: 193,
    MR_MID_NOT_FOUND: 317,
    INVALID_ADDRESS: 487,
    IMAGE_NOT_AT_BASE: 700,
    RESOURCE_DATA_NOT_FOUND: 1812,
    RESOURCE_TYPE_NOT_FOUND: 1813,
    RESOURCE_NAME_NOT_FOUND: 1814,
    RESOURCE_LANG_NOT_FOUND: 1815,
    IO_PENDING: 997,
    NOACCESS: 998,
    FILE_INVALID: 1006,
    DLL_INIT_FAILED: 1114,
    REVISION_MISMATCH: 1306,
    NO_SYSTEM_RESOURCES: 1450,
    BROKEN_PIPE: 109,
    NO_DATA: 232,
    PIPE_BUSY: 231,
    PIPE_NOT_CONNECTED: 233,
    BAD_PIPE: 230,
    PIPE_CONNECTED: 535,
    NOT_FOUND: 1168,
    PIPE_LISTENING: 536,
    OPERATION_ABORTED: 995,
});

/**
 * The translation is many-to-one in this direction and has no inverse: four
 * different reasons a name cannot be resolved all arrive as ERROR_FILE_NOT_FOUND,
 * which is what a program written against Win32 was expecting to see.
 */
/** @type {Map<number, number>} */
const TO_DOS_ERROR = new Map([
    ...WINDOWS_STATUS_ERRORS,
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
    [STATUS.DLL_NOT_FOUND, ERROR.MOD_NOT_FOUND],
    [STATUS.DLL_INIT_FAILED, ERROR.DLL_INIT_FAILED],
    [STATUS.BUFFER_TOO_SMALL, ERROR.INSUFFICIENT_BUFFER],
    [STATUS.OBJECT_NAME_INVALID, ERROR.INVALID_NAME],
    [STATUS.OBJECT_NAME_NOT_FOUND, ERROR.FILE_NOT_FOUND],
    [STATUS.OBJECT_NAME_COLLISION, ERROR.ALREADY_EXISTS],
    [STATUS.OBJECT_NAME_EXISTS, ERROR.OBJECT_NAME_EXISTS],
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
    [STATUS.NOT_MAPPED_VIEW, ERROR.INVALID_ADDRESS],
    [STATUS.IMAGE_NOT_AT_BASE, ERROR.IMAGE_NOT_AT_BASE],
    [STATUS.CONFLICTING_ADDRESSES, ERROR.INVALID_ADDRESS],
    // A view that does not fit is refused as access is: MapViewOfFile's
    // answer for a length past the end.
    [STATUS.INVALID_VIEW_SIZE, ERROR.ACCESS_DENIED],
    [STATUS.INVALID_FILE_FOR_SECTION, ERROR.BAD_EXE_FORMAT],
    [STATUS.OBJECT_TYPE_MISMATCH, ERROR.INVALID_HANDLE],
    [STATUS.SECTION_TOO_BIG, ERROR.NOT_ENOUGH_MEMORY],
    [STATUS.INVALID_PAGE_PROTECTION, ERROR.INVALID_PARAMETER],
    [STATUS.SECTION_NOT_IMAGE, ERROR.INVALID_PARAMETER],
    [STATUS.MAPPED_FILE_SIZE_ZERO, ERROR.FILE_INVALID],
    [STATUS.INVALID_IMAGE_NOT_MZ, ERROR.BAD_EXE_FORMAT],
    [STATUS.INVALID_IMAGE_FORMAT, ERROR.BAD_EXE_FORMAT],
    [STATUS.INVALID_IMAGE_NE_FORMAT, ERROR.BAD_EXE_FORMAT],
    [STATUS.INVALID_IMAGE_PROTECT, ERROR.BAD_EXE_FORMAT],
    [STATUS.INVALID_IMAGE_WIN_16, ERROR.BAD_EXE_FORMAT],
    [STATUS.INVALID_IMAGE_WIN_64, ERROR.BAD_EXE_FORMAT],
    [STATUS.INVALID_CID, ERROR.INVALID_PARAMETER],
    [STATUS.INVALID_PARAMETER_MIX, ERROR.INVALID_PARAMETER],
    [STATUS.RESOURCE_DATA_NOT_FOUND, ERROR.RESOURCE_DATA_NOT_FOUND],
    [STATUS.RESOURCE_TYPE_NOT_FOUND, ERROR.RESOURCE_TYPE_NOT_FOUND],
    [STATUS.RESOURCE_NAME_NOT_FOUND, ERROR.RESOURCE_NAME_NOT_FOUND],
    [STATUS.RESOURCE_LANG_NOT_FOUND, ERROR.RESOURCE_LANG_NOT_FOUND],
    [STATUS.MESSAGE_NOT_FOUND, ERROR.MR_MID_NOT_FOUND],
    [STATUS.PIPE_BROKEN, ERROR.BROKEN_PIPE],
    [STATUS.PIPE_DISCONNECTED, ERROR.PIPE_NOT_CONNECTED],
    [STATUS.INVALID_PIPE_STATE, ERROR.BAD_PIPE],
    [STATUS.PIPE_CONNECTED, ERROR.PIPE_CONNECTED],
    [STATUS.NOT_FOUND, ERROR.NOT_FOUND],
    [STATUS.INVALID_DEVICE_REQUEST, ERROR.INVALID_FUNCTION],
    [STATUS.PIPE_LISTENING, ERROR.PIPE_LISTENING],
    [STATUS.PIPE_CLOSING, ERROR.NO_DATA],
    [STATUS.INSTANCE_NOT_AVAILABLE, ERROR.PIPE_BUSY],
    [STATUS.PIPE_NOT_AVAILABLE, ERROR.PIPE_BUSY],
    [STATUS.ILLEGAL_FUNCTION, ERROR.INVALID_FUNCTION],
    [STATUS.IO_TIMEOUT, ERROR.SEM_TIMEOUT],
    [STATUS.PIPE_BUSY, ERROR.PIPE_BUSY],
    [STATUS.INVALID_READ_MODE, ERROR.BAD_PIPE],
    [STATUS.OBJECT_PATH_INVALID, ERROR.BAD_PATHNAME],
    [STATUS.CANCELLED, ERROR.OPERATION_ABORTED],
    [STATUS.NOT_A_REPARSE_POINT, ERROR.NOT_A_REPARSE_POINT],
    [STATUS.IO_REPARSE_TAG_INVALID, ERROR.REPARSE_TAG_INVALID],
    [STATUS.IO_REPARSE_TAG_MISMATCH, ERROR.REPARSE_TAG_MISMATCH],
    [STATUS.IO_REPARSE_DATA_INVALID, ERROR.INVALID_REPARSE_DATA],
    [STATUS.IO_REPARSE_TAG_NOT_HANDLED, ERROR.CANT_ACCESS_FILE],
    [STATUS.REPARSE_POINT_NOT_RESOLVED, ERROR.CANT_RESOLVE_FILENAME],
    [STATUS.INVALID_USER_BUFFER, ERROR.INVALID_USER_BUFFER],
    [STATUS.INVALID_BUFFER_SIZE, ERROR.INVALID_USER_BUFFER],
    [STATUS.DIRECTORY_NOT_EMPTY, ERROR.DIR_NOT_EMPTY],
    [STATUS.PRIVILEGE_NOT_HELD, ERROR.PRIVILEGE_NOT_HELD],
    [STATUS.MEDIA_WRITE_PROTECTED, ERROR.WRITE_PROTECT],
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
