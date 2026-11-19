/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The kernel32 file surface, over an injected virtual filesystem.
 *
 * Nothing here knows where bytes actually live. The filesystem is handed in and
 * speaks in paths and opaque nodes; everything below is the translation between
 * that and what the guest compiled against -- handles, DWORD pairs standing in
 * for 64-bit values, out-parameters, and the last-error slot.
 *
 * Two things about that translation are worth stating up front, because both
 * are places a faithful implementation looks wrong:
 *
 * The last error is part of the return value of half this surface. CreateFile
 * reports through it on success as well as on failure, and SetFilePointer and
 * GetFileSize have return values that are simultaneously a legal answer and a
 * failure -- the only way a caller can tell is that a failure also set an error
 * code. So success clears it wherever the documented idiom depends on that, and
 * a comment says so at each of them.
 *
 * A handle is a handle. Files, searches, events and threads share one space and
 * one CloseHandle, so the table is injected rather than kept here: two handle
 * spaces means a file handle that collides with an event, which the guest has
 * no way to notice.
 */

import { HANDLE_STDIN, HANDLE_STDOUT, HANDLE_STDERR } from './console.js';
import { FILE_OBJECT_KINDS } from './handle-tags.js';
import { FILE_IMPLIED, SYNCHRONIZE, allows, mappedAccess } from './access.js';
import { fileAttributes, fileIndex, msToFileTime } from './filetime.js';
import { decodeAnsi, decodeOem, encodeAnsi, encodeOem } from './locale.js';
import { createCommFunctions } from './comm.js';
import { createResourceUpdates } from './resource-update.js';
import { readToTerminator } from '../common/scan-windows.js';
import { overlappedLayout, overlappedPosition, overlappedResult } from '../common/overlapped.js';
import { mountPointsOf, onVolume } from './drives.js';
import { MOUNT_MANAGER, mountManagerControl } from './mountmgr.js';
import { isMailslotName } from './mailslots.js';
import { isPipeName } from './pipes.js';
import { isNameInExpression, win32Expression } from './name-expression.js';
import { fullPathName } from '../ntdll/paths.js';
import { STATUS, toDosError } from '../ntdll/status.js';
import {
    FSCTL_DELETE_REPARSE_POINT, FSCTL_GET_REPARSE_POINT, FSCTL_SET_REPARSE_POINT,
    IO_REPARSE_TAG_MOUNT_POINT, IO_REPARSE_TAG_SYMLINK, reparseRequest,
} from './reparse.js';

/** Codes this surface reports through the last-error slot. */
const ERROR_SUCCESS = 0;
const ERROR_INVALID_FUNCTION = 1;
const ERROR_MORE_DATA = 234;
const ERROR_FILE_NOT_FOUND = 2;
/** What CreateSymbolicLink answers a user who may not make links. */
const ERROR_PRIVILEGE_NOT_HELD = 1314;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
/** CreateFile's dwShareMode bit that lets another handle write the file too. */
const FILE_SHARE_READ = 0x1;
const FILE_SHARE_WRITE = 0x2;
const FILE_SHARE_DELETE = 0x4;
/** A buffer the call cannot read from, as NT answers a null one. */
const ERROR_INVALID_USER_BUFFER = 1784;
/** What NT answers a read into a null buffer. */
const ERROR_NOACCESS = 998;
const ERROR_INVALID_HANDLE = 6;
const ERROR_NO_MORE_FILES = 18;
const ERROR_WRITE_PROTECT = 19;
const ERROR_NOT_SAME_DEVICE = 17;
const ERROR_FILE_EXISTS = 80;
const ERROR_INVALID_PARAMETER = 87;
/** The unit a FILE_SEGMENT_ELEMENT names: one page of the caller's memory. */
const PAGE_SIZE = 4096;
/** GetFileAttributesEx's one information level. */
const GET_FILE_EX_INFO_STANDARD = 0;
const WIN32_FILE_ATTRIBUTE_DATA_SIZE = 36;
const ERROR_NEGATIVE_SEEK = 131;
const ERROR_NOT_SUPPORTED = 50;
const ERROR_DIR_NOT_EMPTY = 145;
/** A reparse point of a tag nothing answers, and one standing for what cannot be reached. */
const ERROR_CANT_ACCESS_FILE = 1920;
const ERROR_CANT_RESOLVE_FILENAME = 1921;
/** How many reparse points one open may pass through before it is a loop. */
const LINK_HOPS = 31;
/** CreateFile's flag and NtCreateFile's option for the reparse point itself. */
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const FILE_OPEN_REPARSE_POINT = 0x00200000;
const ERROR_ALREADY_EXISTS = 183;
const ERROR_SHARING_VIOLATION = 32;
const ERROR_USER_MAPPED_FILE = 1224;
const ERROR_LOCK_VIOLATION = 33;
const ERROR_NOT_LOCKED = 158;
const ERROR_INVALID_NAME = 123;
const ERROR_REQUEST_ABORTED = 1235;
const ERROR_DIRECTORY = 267;
const ERROR_IO_DEVICE = 1117;
const ERROR_HANDLE_EOF = 38;
const ERROR_FILENAME_EXCED_RANGE = 206;

/** Where an OVERLAPPED keeps its status, its count and its starting offset. */

/** ReadDirectoryChangesW's statuses, and the error a completion routine is told. */
const STATUS_PENDING = 0x103;
/** What a cancel found nothing to cancel with. */
const STATUS_NOT_FOUND = 0xc0000225;
const STATUS_NOTIFY_ENUM_DIR = 0x10c;
const ERROR_NOTIFY_ENUM_DIR = 1022;
/** Every FILE_NOTIFY_CHANGE_ flag. */
const FILE_NOTIFY_CHANGE_ALL = 0x17f;

/** The failure value of each of the four APIs that has its own. */
const INVALID_HANDLE_VALUE = 0xffffffff;
const INVALID_SET_FILE_POINTER = 0xffffffff;
const INVALID_FILE_SIZE = 0xffffffff;
const INVALID_FILE_ATTRIBUTES = 0xffffffff;

/**
 * The access rights we decode: the generic ones and the specific data rights
 * they stand for. A mask that names none of these opens the file for neither
 * reading nor writing, which is what Windows does for the query-only access of
 * zero and for DELETE alone.
 */
const FILE_READ_DATA = 0x0001;
const FILE_WRITE_DATA = 0x0002;
const FILE_APPEND_DATA = 0x0004;
const DELETE = 0x00010000;
const GENERIC_ALL = 0x10000000;
const GENERIC_EXECUTE = 0x20000000;
const FILE_EXECUTE = 0x20;
const FILE_WRITE_ATTRIBUTES = 0x100;
const GENERIC_WRITE = 0x40000000;
const GENERIC_READ = 0x80000000;

/** dwFlagsAndAttributes' flag that ends the file with its handle. */
const FILE_FLAG_DELETE_ON_CLOSE = 0x04000000;
/** What lets CreateFile open a directory, as a handle for its times and its changes. */
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const FILE_FLAG_OVERLAPPED = 0x40000000;

/** LockFileEx's flag for an exclusive lock; without it the lock is shared. */
const LOCKFILE_EXCLUSIVE_LOCK = 0x2;

/** NtCreateFile's CreateDisposition, and what IO_STATUS_BLOCK.Information reports. */
const FILE_SUPERSEDE = 0;
const FILE_OPEN = 1;
const FILE_CREATE = 2;
const FILE_OPEN_IF = 3;
const FILE_OVERWRITE = 4;
const FILE_OVERWRITE_IF = 5;
const FILE_SUPERSEDED = 0;
const FILE_OPENED = 1;
const FILE_CREATED = 2;
const FILE_OVERWRITTEN = 3;

/** NtCreateFile's CreateOptions this surface acts on. */
const FILE_DIRECTORY_FILE = 0x0001;
const FILE_NON_DIRECTORY_FILE = 0x0040;
const FILE_DELETE_ON_CLOSE = 0x1000;
const FILE_OPEN_BY_FILE_ID = 0x2000;

/** The statuses the native opens answer with. */
const STATUS_SUCCESS = 0;
const STATUS_END_OF_FILE = 0xc0000011;
const STATUS_IO_DEVICE_ERROR = 0xc0000185;
const STATUS_BUFFER_OVERFLOW = 0x80000005;
const STATUS_INVALID_INFO_CLASS = 0xc0000003;
const STATUS_INVALID_DEVICE_REQUEST = 0xc0000010;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004;
/** The FILE_INFORMATION_CLASS values NtQueryInformationFile answers. */
const FILE_BASIC_INFORMATION = 4;
const FILE_STANDARD_INFORMATION = 5;
const FILE_INTERNAL_INFORMATION = 6;
const FILE_EA_INFORMATION = 7;
const FILE_ACCESS_INFORMATION = 8;
const FILE_NAME_INFORMATION = 9;
const FILE_POSITION_INFORMATION = 14;
const FILE_MODE_INFORMATION = 16;
const FILE_ALIGNMENT_INFORMATION = 17;
const FILE_ALL_INFORMATION = 18;
const FILE_NETWORK_OPEN_INFORMATION = 34;
const FILE_ATTRIBUTE_TAG_INFORMATION = 35;
/** FILE_MODE_INFORMATION's flags, as NtCreateFile's options name them. */
const FILE_SEQUENTIAL_ONLY = 0x4;
const FILE_SYNCHRONOUS_IO_NONALERT = 0x20;
/** What CreateFile's flag asks of the cache, kept for FileModeInformation. */
const FILE_FLAG_SEQUENTIAL_SCAN = 0x08000000;
/** FILE_ALL_INFORMATION's fixed part, ahead of the name's characters. */
const ALL_INFORMATION_FIXED = 100;
/** FILE_GENERIC_READ and FILE_GENERIC_WRITE, what an open for each is granted. */
const FILE_GENERIC_READ = 0x120089;
const FILE_GENERIC_WRITE = 0x120116;
/** Every right a file object has, and the one CreateFile always asks beside the caller's. */
const FILE_ALL_ACCESS = 0x1f01ff;
const FILE_READ_ATTRIBUTES = 0x80;
const ERROR_PIPE_BUSY = 231;
/** A pipe no instance of which listens: ERROR_PIPE_BUSY. */
const STATUS_PIPE_NOT_AVAILABLE = 0xc00000ac;
/** GetCurrentThread's pseudo-handle; GetCurrentProcess's is the one above it. */
const CURRENT_THREAD_HANDLE = 0xfffffffe;
const STATUS_UNSUCCESSFUL = 0xc0000001;
const STATUS_ACCESS_VIOLATION = 0xc0000005;
const STATUS_INVALID_HANDLE = 0xc0000008;
const STATUS_INVALID_PARAMETER = 0xc000000d;
const STATUS_INVALID_USER_BUFFER = 0xc00000e8;
const STATUS_OBJECT_TYPE_MISMATCH = 0xc0000024;
const STATUS_ACCESS_DENIED = 0xc0000022;
const STATUS_OBJECT_NAME_INVALID = 0xc0000033;
const STATUS_OBJECT_NAME_NOT_FOUND = 0xc0000034;
const STATUS_OBJECT_NAME_COLLISION = 0xc0000035;
const STATUS_OBJECT_PATH_NOT_FOUND = 0xc000003a;
const STATUS_OBJECT_PATH_SYNTAX_BAD = 0xc000003b;
const STATUS_LOCK_NOT_GRANTED = 0xc0000055;
const STATUS_RANGE_NOT_LOCKED = 0xc000007e;
const STATUS_MEDIA_WRITE_PROTECTED = 0xc00000a2;
const STATUS_FILE_IS_A_DIRECTORY = 0xc00000ba;
const STATUS_NOT_A_DIRECTORY = 0xc0000103;
const STATUS_CANNOT_DELETE = 0xc0000121;
/** An open of a file whose deletion is pending: ERROR_ACCESS_DENIED to Win32. */
const STATUS_DELETE_PENDING = 0xc0000056;
const STATUS_SHARING_VIOLATION = 0xc0000043;
const STATUS_DIRECTORY_NOT_EMPTY = 0xc0000101;
const STATUS_NO_SUCH_FILE = 0xc000000f;
const STATUS_NO_MORE_FILES = 0x80000006;
const STATUS_EAS_NOT_SUPPORTED = 0xc000004f;

/** dwCreationDisposition. */
const CREATE_NEW = 1;
const CREATE_ALWAYS = 2;
const OPEN_EXISTING = 3;
const OPEN_ALWAYS = 4;
const TRUNCATE_EXISTING = 5;

/** dwMoveMethod. */
const FILE_BEGIN = 0;
const FILE_CURRENT = 1;
const FILE_END = 2;

/**
 * The attributes answered are `fileAttributes`'s, over what the volume records
 * of what SetFileAttributes and a creating call set. The ones a program may
 * set are these; the rest (directory, compressed, encrypted, reparse point)
 * say what a file is, and a request naming them sets nothing of them.
 */
const FILE_ATTRIBUTE_READONLY = 0x0001;
const FILE_ATTRIBUTE_ARCHIVE = 0x0020;
const FILE_ATTRIBUTE_NORMAL = 0x0080;
const SETTABLE_ATTRIBUTES = 0x0001 | 0x0002 | 0x0004 | 0x0020 | 0x0080 | 0x0100
    | 0x1000 | 0x2000;

/** The ANSI path limit, and the size of cFileName with it. */
const MAX_PATH = 260;
/** A search path list is many of them; longer is a pointer that is not a string. */
const MAX_PATH_LIST = 32767;
/** The longest path the wide spellings take, in characters. */
const MAX_WIDE_PATH = 32767;

/**
 * The path separator, as a named constant rather than a literal, because it is
 * also this file's escape character and the two are easy to confuse when one
 * appears inside a template or a regular expression.
 */
const SEPARATOR = '\\';

/**
 * OFSTRUCT, which OpenFile fills in. The path is eight-bit text in a fixed
 * array at the end, and cBytes counts the whole structure rather than the path.
 */
const OFSTRUCT_SIZE = 136;
const OFSTRUCT_PATH = 8;
const OFSTRUCT_PATH_MAX = 128;

/** OpenFile's uStyle bits, and its failure value. */
const OF_WRITE = 0x0001;
const OF_READWRITE = 0x0002;
const OF_CREATE = 0x1000;
const OF_DELETE = 0x0200;
const OF_EXIST = 0x4000;
const HFILE_ERROR = 0xffffffff;

/** FindFirstFileEx's levels, search operations and flags, as far as they go here. */
const FIND_EX_INFO_BASIC = 1;
const FIND_EX_SEARCH_LIMIT_TO_DIRECTORIES = 1;
const FIND_FIRST_EX_CASE_SENSITIVE = 0x1;
const FIND_FIRST_EX_LARGE_FETCH = 0x2;

/** MoveFileEx's flags: the two an installer actually passes. */
const MOVEFILE_REPLACE_EXISTING = 0x0001;
const MOVEFILE_DELAY_UNTIL_REBOOT = 0x0004;

/** How much of a file to move at a time when copying one. */
const COPY_CHUNK = 1 << 20;
/** CopyFileEx's flag for CopyFile's bFailIfExists. */
const COPY_FILE_FAIL_IF_EXISTS = 0x1;

/**
 * The machine's scratch directory: what TMP and TEMP name in the environment
 * a process starts with (environment.js), and GetTempPath's answer where the
 * environment cannot be read.
 */
const TEMP_PATH = 'C:\\WINDOWS\\TEMP\\';
/** The two system directories a search with no path of its own ends in. */
const WINDOWS_DIRECTORY = 'C:\\WINDOWS';
const SYSTEM_DIRECTORY = 'C:\\WINDOWS\\system32';
const PROGRAM_FILES = 'C:\\Program Files';

/**
 * WIN32_FIND_DATAA, laid out the way the guest compiled it.
 *
 * The three FILETIMEs are eight bytes each and the two names are fixed arrays,
 * so nothing here is derivable from a field count -- an offset read from the
 * wrong place produces a plausible file size rather than an error. The tail is
 * cAlternateFileName's 14 bytes, which the structure's four-byte alignment
 * rounds up to a total of 320.
 */
export const WIN32_FIND_DATAA = Object.freeze({
    dwFileAttributes: 0,
    ftCreationTime: 4,
    ftLastAccessTime: 12,
    ftLastWriteTime: 20,
    nFileSizeHigh: 28,
    nFileSizeLow: 32,
    dwReserved0: 36,
    dwReserved1: 40,
    cFileName: 44,
    cAlternateFileName: 304,
    SIZE: 320,
});

/**
 * @typedef {Object} FileStat
 * @property {boolean} exists
 * @property {boolean} isDirectory
 * @property {number} size
 * @property {number} [modified]  Milliseconds since the epoch; absent means unknown.
 * @property {boolean} [readOnly]  On read-only media.
 * @property {boolean} [hidden]
 * @property {number} [attributes]  What a program set, when one did.
 * @property {number} [links]  How many names the file has; one when absent.
 * @property {string} [identity]  What the file is known by whatever its names:
 *           its own path unless it has others.
 * @property {string} [junction]  For a reparse point naming a place on its drive, that place.
 * @property {number} [reparseTag]  The tag of the reparse point it is.
 */

/**
 * @typedef {Object} DirectoryEntry
 * @property {string} name
 * @property {boolean} isDirectory
 * @property {number} size
 * @property {number} [modified]  Milliseconds since the epoch; absent means unknown.
 * @property {boolean} [readOnly]
 * @property {boolean} [hidden]
 * @property {number} [attributes]
 * @property {number} [links]
 * @property {string} [identity]
 * @property {number} [reparseTag]  The tag of the reparse point it is.
 */

/** The handle kinds that are file objects: what CancelIo takes. */
/** GetFinalPathNameByHandle's namespaces. */
const VOLUME_NAME_DOS = 0x0;
const VOLUME_NAME_NT = 0x2;
const VOLUME_NAME_NONE = 0x4;

/** FILE_INFO_BY_HANDLE_CLASS: the classes SetFileInformationByHandle takes here. */
/**
 * What setting a class of an open file ends in: a Win32 error (0 when it
 * held), or a refusal the native call names apart from it.
 *
 * @typedef {number | { error: number, status: number }} InformationError
 */
const FILE_INFO = Object.freeze({ BASIC: 0, RENAME: 3, DISPOSITION: 4, ALLOCATION: 5,
    END_OF_FILE: 6, IO_PRIORITY_HINT: 12, DISPOSITION_EX: 21, RENAME_EX: 22 });
/**
 * Their least sizes on a 32-bit process: FILE_BASIC_INFO's four LARGE_INTEGERs
 * and a DWORD, padded; FILE_RENAME_INFO's flag word, root handle, name length
 * and first character.
 *
 * @type {Map<number, number>}
 */
const FILE_INFO_SIZES = new Map([[FILE_INFO.BASIC, 40], [FILE_INFO.RENAME, 16],
    [FILE_INFO.DISPOSITION, 1], [FILE_INFO.ALLOCATION, 8], [FILE_INFO.END_OF_FILE, 8],
    [FILE_INFO.IO_PRIORITY_HINT, 4], [FILE_INFO.DISPOSITION_EX, 4], [FILE_INFO.RENAME_EX, 16]]);
/**
 * NtSetInformationFile's FILE_INFORMATION_CLASS values that are the same
 * records as SetFileInformationByHandle's, and the FILE_INFO class each is.
 *
 * @type {Map<number, number>}
 */
const NATIVE_SET_CLASSES = new Map([[4, FILE_INFO.BASIC], [10, FILE_INFO.RENAME],
    [13, FILE_INFO.DISPOSITION], [19, FILE_INFO.ALLOCATION], [20, FILE_INFO.END_OF_FILE],
    [43, FILE_INFO.IO_PRIORITY_HINT], [64, FILE_INFO.DISPOSITION_EX], [65, FILE_INFO.RENAME_EX]]);
/** The native classes that are NtSetInformationFile's own. */
const FILE_POSITION_SET = 14;
const FILE_MODE_SET = 16;
const FILE_COMPLETION_INFORMATION = 30;
const FILE_VALID_DATA_LENGTH_INFORMATION = 39;
/** FILE_IO_COMPLETION_NOTIFICATION_INFORMATION: the completion modes, a ULONG. */
const FILE_IO_COMPLETION_NOTIFICATION_INFORMATION = 41;
/** The FILE_INFORMATION_CLASS values of a pipe end. */
const FILE_PIPE_INFORMATION = 23;
const FILE_PIPE_LOCAL_INFORMATION = 24;
/**
 * The room each class's record needs before the I/O manager asks the file
 * system anything: a buffer shorter than its fixed part is
 * STATUS_INFO_LENGTH_MISMATCH whatever the object, a name's record
 * included (its length and one character, aligned: Wine's ntdll pipe test
 * finds four bytes refused).
 *
 * @type {Map<number, number>}
 */
const QUERY_LENGTHS = new Map([
    [FILE_BASIC_INFORMATION, 40], [FILE_STANDARD_INFORMATION, 24],
    [FILE_INTERNAL_INFORMATION, 8], [FILE_EA_INFORMATION, 4], [FILE_ACCESS_INFORMATION, 4],
    [FILE_NAME_INFORMATION, 8], [FILE_POSITION_INFORMATION, 8], [FILE_MODE_INFORMATION, 4],
    [FILE_ALIGNMENT_INFORMATION, 4], [FILE_NETWORK_OPEN_INFORMATION, 56],
    [FILE_ATTRIBUTE_TAG_INFORMATION, 8], [FILE_PIPE_INFORMATION, 8],
    [FILE_PIPE_LOCAL_INFORMATION, 40],
]);
/** NtReadFile's and NtWriteFile's two negative offsets: the end, the file pointer. */
const FILE_WRITE_TO_END_OF_FILE = 0xffffffff;
const FILE_USE_FILE_POINTER_POSITION = 0xfffffffe;
/** FILE_MODE_INFORMATION's bits a handle's mode may be set to. */
const FILE_WRITE_THROUGH = 0x2;
const FILE_SYNCHRONOUS_IO_ALERT = 0x10;
/** The last of the open options FileModeInformation reports back. */
const FILE_NO_INTERMEDIATE_BUFFERING = 0x8;
/** The open options a handle's mode keeps: the rest act at the open and are gone. */
const FILE_MODE_OPTIONS = FILE_WRITE_THROUGH | FILE_SEQUENTIAL_ONLY
    | FILE_NO_INTERMEDIATE_BUFFERING | FILE_SYNCHRONOUS_IO_ALERT | FILE_SYNCHRONOUS_IO_NONALERT;
/** CreateFile's flags that are the same hints: write-through and no buffering. */
const FILE_FLAG_WRITE_THROUGH = 0x80000000;
const FILE_FLAG_NO_BUFFERING = 0x20000000;

/** The two modes a handle waits in for its I/O. */
const SYNCHRONOUS_MODES = FILE_SYNCHRONOUS_IO_ALERT | FILE_SYNCHRONOUS_IO_NONALERT;

/**
 * A file handle's FILE_MODE_INFORMATION: what its open kept, or, for one
 * made without (a directory's), synchronous unless overlapped.
 *
 * @param {{ mode?: number, overlapped?: boolean }} file
 */
const modeOf = file=>file.mode ?? (file.overlapped ? 0 : FILE_SYNCHRONOUS_IO_NONALERT);

/**
 * The mode a handle CreateFile opens has: synchronous unless it asked for
 * overlapped I/O, with the hints its flags give.
 *
 * @param {number} flags
 */
const modeOfFlags = flags=>(((flags >>> 0) & FILE_FLAG_OVERLAPPED) !== 0
    ? 0 : FILE_SYNCHRONOUS_IO_NONALERT)
    | (((flags >>> 0) & FILE_FLAG_SEQUENTIAL_SCAN) !== 0 ? FILE_SEQUENTIAL_ONLY : 0)
    | (((flags >>> 0) & FILE_FLAG_WRITE_THROUGH) !== 0 ? FILE_WRITE_THROUGH : 0)
    | (((flags >>> 0) & FILE_FLAG_NO_BUFFERING) !== 0 ? FILE_NO_INTERMEDIATE_BUFFERING : 0);
const FILE_DISPOSITION_FLAG_DELETE = 0x1;
/** The name goes as the handle that asked closes, other opens or not. */
const FILE_DISPOSITION_FLAG_POSIX_SEMANTICS = 0x2;
const FILE_RENAME_FLAG_REPLACE_IF_EXISTS = 0x1;
const FILE_RENAME_FLAG_IGNORE_READONLY_ATTRIBUTE = 0x40;
/** NtSetInformationFile's hard link classes (FILE_LINK_INFORMATION and its Ex form). */
const FILE_LINK_INFORMATION = 11;
const FILE_LINK_INFORMATION_EX = 72;
/** FILE_LINK_INFORMATION_EX's flags: replace what is there, a read-only one too. */
const FILE_LINK_REPLACE_IF_EXISTS = 0x1;
const FILE_LINK_IGNORE_READONLY_ATTRIBUTE = 0x40;
/** Milliseconds between 1601 and 1970, what a FILETIME counts from. */
const FILETIME_EPOCH_MS = 11644473600000;

/** GetBinaryType's kinds. */
const SCS_32BIT_BINARY = 0;
const SCS_DOS_BINARY = 1;
const SCS_WOW_BINARY = 2;
const SCS_64BIT_BINARY = 6;
const IMAGE_FILE_DLL = 0x2000;
const ERROR_BAD_EXE_FORMAT = 193;
const ERROR_BAD_LENGTH = 24;
const ERROR_NOT_FOUND = 1168;

const FILE_OBJECTS = new Set(['file', 'directory', 'pipe-read', 'pipe-write', 'pipe']);

/**
 * @typedef {Object} OpenMode
 * @property {boolean} [read]
 * @property {boolean} [write]
 * @property {boolean} [create]        Make the file when it is not there.
 * @property {boolean} [truncate]      Discard whatever it already holds.
 * @property {boolean} [failIfExists]  Refuse rather than open an existing file.
 * @property {boolean} [shareRead]     Another handle may read the file while this one is open;
 *                                     absent, it may.
 * @property {boolean} [shareWrite]    Another handle may write the file while this one is open.
 * @property {boolean} [delete]        DELETE access: it may be renamed or deleted through it.
 * @property {boolean} [shareDelete]   Another may rename or delete the file while it is open;
 *                                     absent, it may.
 */

/**
 * The virtual filesystem this surface is built on. Paths reaching it are
 * absolute and carry no trailing separator except at a drive root.
 *
 * @typedef {Object} FileSystem
 * @property {(path: string) => FileStat | null} stat
 * @property {(path: string) => string | null} [removalRefused]
 *           Why the file may not be renamed or deleted as its opens stand, or null.
 * @property {(path: string) => boolean} [isOpen]  whether any process holds the file open
 * @property {(path: string) => string | null} [deviceOf]  the device a path names, upper case
 * @property {() => string | null} [openRefusal]  why the last `open` answered null
 * @property {(path: string) => string | null} [mappedAs]  how a section maps the file
 * @property {(path: string, existing: string) => string | null} [link]
 *           Gives a file one more name: null, or the volume's code for why not.
 * @property {(path: string,
 *     point: { tag: number, data: Uint8Array | null, target: string | null } | null)
 *     => string | null | { away: true }} [setReparse]
 *           Sets a reparse point (null: takes it off): null, or the volume's code for why not.
 * @property {(path: string) => { tag: number, data: Uint8Array | null } | null} [reparseOf]
 *           The reparse point as it was set.
 * @property {(path: string, mode: OpenMode) => any} open   Opaque node, or null.
 * @property {(node: any, offset: number, length: number, onlyCopied?: boolean) =>
 *     Uint8Array | Promise<Uint8Array>} read
 *           Short at the end of the file; empty past it, which is not an error.
 *           A promise when the bytes are not resident yet -- see ReadFile.
 * @property {(node: any, offset: number, bytes: Uint8Array) => number} write
 * @property {(node: any, offset: number, bytes: Uint8Array)
 *     => number | Promise<number>} [writeOrFetch]
 *           write, or a promise when the file must be copied up from blocks
 *           not resident yet -- see WriteFile.
 * @property {(node: any, size: number) => void} truncate
 * @property {(node: any) => void} close
 * @property {(node: any) => void} [retain]  one more hold, which a close gives back
 * @property {(node: any, kind: any) => any} [section]  a node of its own for a section
 * @property {(node: any) => Uint8Array | null} [standInImage]
 *           The image an engine's library stands in with, for its node.
 * @property {(path: string) => boolean} remove
 * @property {(path: string, modified: number) => boolean} [setModified]
 * @property {(path: string) => boolean} mkdir
 * @property {(from: string, to: string, options?: { held?: boolean }) => boolean} rename
 *     `held`: through a handle that holds the file for deletion, so its other opens
 *     are not asked again
 * @property {(from: string, to: string, options?: { held?: boolean }) =>
 *     boolean | Promise<boolean>} [renameOrFetch]
 *           rename, waiting for the blocks a move off a bundle copies.
 * @property {(path: string, pattern: string) => DirectoryEntry[]} list
 * @property {() => string} currentDirectory
 * @property {(path: string) => void} setCurrentDirectory
 * @property {(path: string) => boolean} [writeProtected]
 *           Whether the path is on read-only media, a disc.
 * @property {(path: string, attributes: number | null) => boolean} [setAttributes]
 *           Records the attributes a program set on a name; `null` forgets
 *           them. Absent, SetFileAttributes changes nothing a later call sees.
 * @property {(path: string, subtree: boolean, filter: number,
 *     notify: (records: import('./vfs.js').ChangeRecord[]) => void,
 *     alive: () => boolean) => { close: () => void }} [watch]
 *           Tells `notify` of each change under a directory `filter` asks about.
 *           Absent, ReadDirectoryChangesW is refused.
 */

/**
 * @typedef {Object} FileHost
 * @property {number} [pointerSize]  8 in a 64-bit process, whose OVERLAPPED is
 *     laid out wider (`overlappedLayout`); absent, 4.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {{ read: (handle: number, buffer: number, length: number, out: number,
 *     native?: boolean, overlapped?: number,
 *     io?: { event: number, apc: number, context: number }) => any,
 *     write: (handle: number, buffer: number, length: number, out: number,
 *     native?: boolean, overlapped?: number, routine?: number,
 *     io?: { event: number, apc: number, context: number }) => any,
 *     readEx?: (handle: number, buffer: number, length: number, overlapped: number,
 *     routine: number) => any,
 *     writeEx?: (handle: number, buffer: number, length: number, overlapped: number,
 *     routine: number) => any }[]} [streams]
 *           Handles the reads and writes hand on before taking them for files:
 *           each answers the call, or null for a handle that is not its own.
 *           `native` asks for NtReadFile's answers: `out` is the IO_STATUS_BLOCK.
 * @property {{ open: (name: string, access: number) => { handle: number } | { error: number },
 *     information: (handle: number, kind: number) => Uint8Array | 'unknown class' | null,
 *     setInformation?: (handle: number, kind: number, from: number, length: number)
 *     => number | null }}
 *     [mailslots]  Opens a client of the mailslot CreateFile is given the name of, and
 *     answers NtQueryInformationFile and NtSetInformationFile of a mailslot handle
 *     (null: not one).
 * @property {{ closed: (object: any) => void }} [jobs]  Told of a job's handle closed.
 * @property {{ closed: (object: any) => void }} [debugObjects]  Told of a debug object's
 *           handle closed: with its last, its debuggees go as it says.
 * @property {ReturnType<typeof import('./pipes.js').createNamedPipes>} [pipes]
 *           Named pipes: CreateFile opens a client end by a pipe's name, a closed
 *           end is told, CancelIo and CancelIoEx cancel what waits on one.
 * @property {(address: number, length: number) => Uint8Array} [windowMemory]
 *           The guest's own bytes, not a copy, valid until the guest runs again:
 *           what a write hands a volume that keeps a copy of what it is given.
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} readWideString
 *           `maxLength` in bytes, as the memory layer counts it: a wide path of
 *           MAX_PATH characters is twice that.
 * @property {FileSystem} files
 * @property {(path: string, sd: number) => void} [recordFileSecurity]
 *           Keeps the SECURITY_ATTRIBUTES' descriptor CreateFile or CreateDirectory
 *           was given as the new object's security. A no-op when absent.
 * @property {(code: number) => void} setLastError
 * @property {(name: string) => string | undefined} [environmentVariable]
 *           The process's variable of that name, any case, as it stands now.
 * @property {(api: string, detail: string, severity?: 'loss') => void} [divergence]
 * @property {(record: { path: string, error: number, access: number, share: number,
 *     disposition: number, flags: number }) => void} [openRefused]  told of every open
 *     CreateFile or NtCreateFile refused, with the error and what was asked
 * @property {(handle: number, text: string) => void} writeConsole
 *           Where a write to a standard handle goes instead of the filesystem.
 * @property {(handle: number) => void} [resetEvent]
 *           Clears an OVERLAPPED's event when an operation on it starts pending.
 * @property {(handle: number) => void} [setEvent]
 *           Signals the event NtReadFile or NtWriteFile is given, when it completes.
 * @property {() => string[]} [drives]  the drive letters, for the mount manager
 * @property {(letter: string) => any} [volume]  a drive's volume, its `kind` read
 * @property {{ open: (type: string, object: any, access?: number | null) => number,
 *              resolve: (handle: number, type?: string) => any,
 *              access?: (handle: number) => number | null,
 *              close: (handle: number) => any,
 *              typeOf?: (handle: number) => string | undefined,
 *              holds?: (object: any) => boolean,
 *              list?: () => { handle: number, type: string, object: any }[] }} handles
 *           The one handle table, shared with every other kind of object.
 * @property {() => any} [currentThread]
 *           Whose call this is, for an answer that arrives after the thread has
 *           been parked -- by then the running thread is somebody else.
 * @property {(thread: any, code: number) => void} [setLastErrorFor]
 * @property {{ offsetOf: (overlapped: number) => number,
 *              completed: (file: number, transferred: number, overlapped: number) => boolean,
 *              closed: (handle: number, object: any) => void,
 *              bind?: (file: number, port: number, key: number)
 *                  => boolean | 'synchronous',
 *              bound?: (file: number) => boolean }} [ports]
 *           Completion ports. Absent, overlapped I/O still reads and writes;
 *           what it does not do is tell anyone it finished.
 * @property {(thread: any, routine: number, args: number[]) => void} [queueApc]
 *           Queues a routine to a thread, to run at its next alertable wait:
 *           how ReadFileEx and WriteFileEx deliver their completion routines.
 * @property {string[]} [directories]
 *           The shell folders the configured Windows names (the registry's
 *           `shellFolderDirectories`), parents first, made at start beside the
 *           system's own. Absent, only the system's are made.
 * @property {() => string} [imagePath]
 *           The running program, whose directory is the first place a search
 *           with no path of its own looks. Absent, the search starts at the
 *           current directory.
 * @property {() => string[]} [systemLibraries]
 *           The libraries this build implements, by file name: each stands in
 *           the system folder as a file of its own, where a setup looks for it
 *           before loading it. Absent, the folder shows only what is on it.
 * @property {SystemPrograms} [systemPrograms]
 *           The programs this build runs in place of the system's, which stand
 *           where Windows keeps them beside the libraries.
 * @property {{ forget: (object: any) => void }} [namedObjects]
 *           Told when a handle closes, so a named mutex, event, semaphore,
 *           timer or file mapping can free its name once nothing holds it any
 *           more. Absent, a name is never freed -- the same as never closing
 *           the object, which is what the calls this table serves already do
 *           when there is nothing to tell.
 */

/** @param {number} value */
const low = value=>value >>> 0;

/** @param {number} value */
const high = value=>Math.floor(value / 0x100000000) >>> 0;

/**
 * Reassembles the signed 64-bit value a pair of DWORDs stands for. Distances
 * are signed -- seeking backwards from the end is the common case -- and only
 * the low half arrives as a two's-complement number.
 *
 * @param {number} lowPart @param {number} highPart
 */
const int64 = (lowPart, highPart)=>(highPart | 0) * 0x100000000 + (lowPart >>> 0);

/** When a library the system folder shows was made: Windows XP SP3's build. */
const SYSTEM_LIBRARY_TIME = Date.UTC(2008, 3, 14, 12);
/** The size such a library reports when its image is not to hand. */
const SYSTEM_LIBRARY_SIZE = 0x10000;

/**
 * Where the engine's libraries stand as files, and what they hold.
 *
 * @typedef {Object} LibraryFiles
 * @property {(name: string) => string | null} [homeOf]
 *           The folder a library is installed in when it is not the system
 *           folder -- the Steam client's, in Steam's -- or null.
 * @property {(name: string) => Uint8Array | null} [imageOf]
 *           The library's image as the engine made it, which its file holds.
 * @property {SystemPrograms} [programs]  The programs that stand as files beside them.
 */

/**
 * The programs this build runs in place of the system's (`programs/table.js`):
 * which one a path names, and its image.
 *
 * @typedef {Object} SystemPrograms
 * @property {(path: string) => string | null} at  its routine, or null for none there
 * @property {(path: string) => Uint8Array | null} image
 */

/**
 * A volume on which the system folder -- or the folder a library is
 * installed in (`homeOf`) -- also holds the libraries this build implements,
 * each by its own name, unless a file of that name is there; and the programs
 * it runs in place of the system's (`SYSTEM_PROGRAMS`: msiexec, rundll32 and
 * the rest) stand where Windows keeps them, their images the ones it starts.
 *
 * Is it there, what are its attributes, a search for its exact name
 * (InstallShield's UseDLL looks with FindFirstFile first), and its bytes: the
 * image the engine made, read as any file is (A41) -- the Steam API and a DRM
 * wrapper read the client they loaded. A search with a wildcard lists the
 * folder as it is. Opened to be written, it becomes a file on the volume that
 * the program writes -- a setup replacing it, as a DirectX setup replaces what
 * it finds older -- and a program that loads the name still gets the engine's
 * own: what a setup puts there is never in its way.
 *
 * @template {FileSystem} T
 * @param {T} real @param {(() => string[]) | undefined} libraries
 * @param {LibraryFiles} [where]
 * @returns {T & { standInImage?: (node: any) => Uint8Array | null }}
 */
export function withSystemLibraries(real, libraries, where = {}){
    if (!libraries)
    {
        return real;
    }
    const system = SYSTEM_DIRECTORY.toLowerCase();
    /** @param {string} path @returns {string | null} the library's own spelling */
    const libraryAt = path=>{
        const lower = path.toLowerCase();
        const cut = lower.lastIndexOf('\\');
        const name = lower.slice(cut + 1);
        const library = libraries().find(each=>each.toLowerCase() === name);
        if (library === undefined)
        {
            return null;
        }
        const home = where.homeOf?.(library)?.toLowerCase() ?? system;
        return lower.slice(0, cut) === home ? library : null;
    };
    /**
     * The program this build runs in place of a system one there (`SYSTEM_PROGRAMS`):
     * its file name as the path spells it, or null.
     *
     * @param {string} path
     */
    const programAt = path=>((where.programs?.at(path) ?? null) === null ? null
        : path.slice(path.lastIndexOf('\\') + 1));
    /** @param {string} path @returns {string | null} what stands there, by its own spelling */
    const standingAt = path=>libraryAt(path) ?? programAt(path);
    /** @param {string} name @param {string} path @returns {Uint8Array | null} */
    const imageAt = (name, path)=>(programAt(path) !== null && libraryAt(path) === null
        ? where.programs?.image(path) ?? null : where.imageOf?.(name) ?? null);
    /** @param {string} name @param {string} path */
    const entryOf = (name, path)=>({ exists: true, isDirectory: false,
        size: imageAt(name, path)?.length ?? SYSTEM_LIBRARY_SIZE,
        modified: SYSTEM_LIBRARY_TIME });
    /**
     * The open stand-ins, each its library's image and the holds beyond its
     * open: a mapping of the file, and each view of it, keeps the image as a
     * file's node is kept, until the last of them closes.
     *
     * @type {WeakMap<object, { image: Uint8Array, holds: number }>}
     */
    const opened = new WeakMap();
    return Object.assign(Object.create(real), {
        /** @param {string} path */
        stat: path=>{
            const found = real.stat(path);
            const name = found ? null : standingAt(path);
            return found ?? (name ? entryOf(name, path) : null);
        },
        /** @param {string} path @param {any} options */
        open: (path, options)=>{
            const node = real.open(path, options);
            const name = node || real.stat(path) ? null : standingAt(path);
            if (node || !name)
            {
                return node;
            }
            if (options?.write)
            {
                return real.open(path, { ...options, create: true });
            }
            const image = imageAt(name, path);
            if (!image)
            {
                return null;
            }
            const standIn = {};
            opened.set(standIn, { image, holds: 0 });
            return standIn;
        },
        /**
         * The image a stand-in opened, or null for a file of the volume: its
         * length is the file's size, which the volume's own nodes are asked.
         *
         * @param {any} node
         */
        standInImage: node=>opened.get(node)?.image ?? null,
        /**
         * @param {any} node @param {number} offset @param {number} length
         * @param {boolean} [onlyCopied]
         */
        read: (node, offset, length, onlyCopied)=>{
            const image = opened.get(node)?.image;
            return image ? image.slice(offset, offset + length)
                : real.read(node, offset, length, onlyCopied);
        },
        /** @param {any} node */
        retain: node=>{
            const standIn = opened.get(node);
            if (standIn)
            {
                standIn.holds++;
            }
            else
            {
                real.retain?.(node);
            }
        },
        /** A stand-in has no section of its own: a mapping holds it. @param {any} node @param {any} kind */
        section: (node, kind)=>(opened.has(node) ? null : real.section?.(node, kind) ?? null),
        /** @param {any} node @param {number} offset @param {Uint8Array} bytes */
        write: (node, offset, bytes)=>(opened.has(node) ? 0 : real.write(node, offset, bytes)),
        /** @param {any} node @param {number} size */
        truncate: (node, size)=>{
            if (!opened.has(node))
            {
                real.truncate(node, size);
            }
        },
        /** @param {any} node */
        close: node=>{
            const standIn = opened.get(node);
            if (!standIn)
            {
                real.close(node);
            }
            else if (standIn.holds > 0)
            {
                standIn.holds--;
            }
            else
            {
                opened.delete(node);
            }
        },
        /** @param {string} path @param {string} pattern */
        list: (path, pattern)=>{
            const found = real.list(path, pattern);
            const at = `${path.replace(/\\$/, '')}\\${pattern}`;
            const name = (found?.length ?? 0) === 0 && !/[*?]/.test(pattern ?? '')
                ? standingAt(at) : null;
            return name ? [{ ...entryOf(name, at), name }] : found;
        },
    });
}

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * `argBytes` is the size of the argument list the guest compiled against; all
 * of these are stdcall, the bridge's default, so none of them says so. Note
 * SetFilePointerEx, whose LARGE_INTEGER is passed by value and therefore costs
 * eight of its twenty bytes.
 *
 * @param {FileHost} host
 */
export function createFileFunctions(host){
    const layout = overlappedLayout(host.pointerSize);
    const files = withSystemLibraries(host.files, host.systemLibraries,
        { programs: host.systemPrograms });

    // A machine has these directories before any program runs: GetTempPath
    // and GetSystemDirectory promise them, the registry names the program
    // directories and the profile's folders, and an installer's first act is
    // to create its scratch file in one and its last to move a shared library
    // into another. A promise of a directory that is not there fails that
    // create or move with "access denied", which is the wrong answer to a
    // question the program never asked. A driver's setup copies its .sys into
    // system32's drivers folder, which every installation has, the same way,
    // and its INF into the INF directory. Windows Installer keeps its cache in
    // the Installer folder, and an installer's own deferred actions write
    // their scripts there (WiX's do).
    for (const path of [WINDOWS_DIRECTORY, TEMP_PATH.slice(0, -1), SYSTEM_DIRECTORY,
        `${SYSTEM_DIRECTORY}\\drivers`, `${SYSTEM_DIRECTORY}\\drivers\\etc`,
        `${WINDOWS_DIRECTORY}\\inf`, `${WINDOWS_DIRECTORY}\\Installer`, PROGRAM_FILES,
        `${PROGRAM_FILES}\\Common Files`, ...host.directories ?? []])
    {
        try
        {
            if (!files.stat(path)?.exists)
            {
                files.mkdir(path);
            }
        }
        catch (e){
            // A volume that cannot make a directory -- a build assembled
            // without one -- has no directory to promise, and nothing to do
            // about it here.
            void e;
        }
    }

    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        host.writeMemory(address, new Uint8Array([
            value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
        ]));
    };

    /** Most out-parameters here are optional, and a NULL one is not an error. */
    const writeDwordIf = (/** @type {number} */ address, /** @type {number} */ value)=>{
        if (address !== 0)
        {
            writeDword(address, value);
        }
    };

    /** @param {number} address @param {number} value */
    const writeQword = (address, value)=>{
        writeDword(address, low(value));
        writeDword(address + 4, high(value));
    };

    /** @param {number} address */
    const readDword = address=>{
        const bytes = host.readMemory(address, 4);
        return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    };

    /**
     * The end of a ReadFileEx or WriteFileEx: the OVERLAPPED says it finished
     * and how much moved, and the completion routine is queued to the thread
     * that asked.
     *
     * @param {any} thread @param {number} overlapped @param {number} routine
     * @param {number} transferred
     */
    const completeWith = (thread, overlapped, routine, transferred)=>{
        overlappedResult(writeDword, layout, overlapped, ERROR_SUCCESS, transferred);
        if ((routine >>> 0) !== 0)
        {
            host.queueApc?.(thread, routine >>> 0,
                [ERROR_SUCCESS, transferred >>> 0, overlapped >>> 0]);
        }
        return 1;
    };

    /**
     * Whether the ANSI spellings of the functions here read and write names in
     * the OEM page rather than the ANSI one: SetFileApisToOEM, which a console
     * program calls so the names it prints are in the page its console shows.
     */
    let fileApisOem = false;

    /** A name in the page the ANSI spellings use now. @param {string} text */
    const encodeName = text=>(fileApisOem ? encodeOem(text) : encodeAnsi(text));

    /**
     * A NUL-terminated name in the page the ANSI spellings use now, at most
     * `limit` bytes; read a window at a time, so one at the end of what the
     * program allocated is not read past.
     *
     * @param {number} address @param {number} limit
     */
    const readName = (address, limit)=>(fileApisOem
        ? decodeOem(readToTerminator(host, address, 1, limit).bytes)
        : host.readCString(address, limit));

    /**
     * The two-call protocol every path-returning function here shares: called
     * with a buffer too small (or none at all) it reports the size it needs
     * *including* the terminator, and having written it reports the length
     * *without* one. Callers switch on exactly that difference. The path goes
     * back in the ANSI page the memory layer read it in, so a name a program
     * gave comes back in its own bytes.
     *
     * @param {number} buffer @param {number} size @param {string} text
     * @returns {number} what the function returns
     */
    const writeStringTo = (buffer, size, text)=>{
        if (buffer === 0 || text.length + 1 > (size >>> 0))
        {
            return text.length + 1;
        }
        host.writeMemory(buffer, encodeName(text + '\0'));
        return text.length;
    };

    /**
     * A name longer than MAX_PATH is still a name: it is read to its end,
     * and then found or not as any other is. The calls that convert one name
     * through the static buffer refuse it instead (`oneName`).
     *
     * @param {number} pointer
     */
    const pathArgument = pointer=>fullPath(
        pointer === 0 ? '' : readName(pointer >>> 0, MAX_PATH_LIST));

    /**
     * Turns what the guest wrote into the absolute path the filesystem takes.
     * Forward slashes are accepted because Windows accepts them, `.` and `..`
     * are resolved here rather than below, and the trailing separator is
     * dropped -- the filesystem sees one spelling of a directory, and the one
     * caller that cares about the separator (GetFullPathNameA) puts it back.
     *
     * @param {string} given
     */
    function fullPath(given){
        if (given === '')
        {
            return '';
        }
        // A volume's own name is its drive's root, `\\?\` and all.
        const volume = onVolume(given);
        const name = volume ? `${volume.letter}:\\${volume.rest}` : given;
        // The Win32 file namespace turns the parsing off: no slash is a
        // separator and no dot a step. The filesystem reads it so itself.
        if (name.startsWith('\\\\?\\'))
        {
            return name;
        }
        const written = driveRelative(name.replace(/\//g, '\\'));
        const rooted = isAbsolute(written) ? written : underCurrentDirectory(written);
        // A UNC path's root is its leading pair of separators; anything else
        // rooted here is a drive letter, colon, separator.
        const root = rooted.startsWith('\\\\') ? '\\\\' : rooted.slice(0, 3);
        /** @type {string[]} */
        const parts = [];
        const pieces = rooted.slice(root.length).split('\\');
        pieces.forEach((part, index)=>{
            if (part === '' || part === '.')
            {
                return;
            }
            if (part === '..')
            {
                parts.pop();
                return;
            }
            // A name cannot end in a dot or a space: the last one's are
            // dropped (`file.txt. ` is `file.txt`, and a name of nothing else
            // names nothing), and a folder's single dot before a separator.
            // A pattern's dots are its own (`*.` is a name with no
            // extension): FindFirstFile reads them, so they stay.
            const pattern = /[*?]/.test(part);
            const kept = pattern ? part : index === pieces.length - 1 ? part.replace(/[. ]+$/, '')
                : /[^.]\.$/.test(part) ? part.slice(0, -1) : part;
            if (kept !== '')
            {
                parts.push(kept);
            }
        });
        return root + parts.join('\\');
    }

    /** @param {string} path */
    const isAbsolute = path=>/^[A-Za-z]:\\/.test(path) || path.startsWith('\\\\');

    /**
     * A path that names a drive without a separator -- "C:" or "C:WINDOWS" --
     * is relative to that drive's own current directory, which Windows keeps
     * per drive. A drive the process has never been on has its root for one;
     * the drive it is on has the directory it is in, so "C:" alone is where
     * the process already stands. A caller walking up a path it means to
     * create ends that walk here, and a refusal of it reads as "the whole
     * path is invalid" rather than "the last piece is not there yet".
     *
     * @param {string} path
     */
    const driveRelative = path=>{
        const drive = /^([A-Za-z]:)(?!\\)/.exec(path);
        if (drive === null)
        {
            return path;
        }
        const rest = path.slice(2);
        const current = files.currentDirectory();
        const base = current.slice(0, 2).toLowerCase() === drive[1].toLowerCase()
            ? current
            : drive[1] + '\\';
        if (rest === '')
        {
            return base;
        }
        return base.endsWith('\\') ? base + rest : base + '\\' + rest;
    };

    /** @param {string} path */
    const underCurrentDirectory = path=>{
        const current = files.currentDirectory();
        // Rooted but driveless -- "\WINDOWS" -- means the drive we are on.
        if (path.startsWith('\\'))
        {
            return current.slice(0, 2) + path;
        }
        return current.endsWith('\\') ? current + path : current + '\\' + path;
    };

    /** @param {string} path @returns {string} the directory holding it */
    const parentOf = path=>{
        const at = path.lastIndexOf('\\');
        if (at < 0)
        {
            return '';
        }
        // "C:\FILE" -- the parent is the root, which keeps its separator.
        return at <= 2 ? path.slice(0, at + 1) : path.slice(0, at);
    };

    /**
     * Which of the two "it isn't there" codes applies. Windows distinguishes
     * them by where the walk stopped, and callers do act on the difference: a
     * missing file is often expected, a missing directory rarely is.
     *
     * @param {string} path
     */
    const missing = path=>{
        const parent = files.stat(parentOf(path));
        // A directory that is a reparse point of a tag no filter here
        // answers holds nothing a path can reach.
        if (parent?.exists && unhandledTag(parent.reparseTag ?? 0))
        {
            return ERROR_CANT_ACCESS_FILE;
        }
        return parent && parent.exists && parent.isDirectory
            ? ERROR_FILE_NOT_FOUND
            : ERROR_PATH_NOT_FOUND;
    };

    /**
     * Where an open of `path` lands past the reparse points it is, unless
     * asked for the reparse point itself: a mount point or a symbolic link
     * stands for the place it names - followed to the end of a chain of
     * them, a loop or a chain too long not resolved - and any other tag is
     * one no filter here answers. A link to a directory is opened as itself,
     * whose contents are the target's; one to a file opens that file, and a
     * dangling one the place it names, which a create then makes.
     *
     * @param {string} path @param {any} entry  `files.stat(path)`
     * @returns {{ path: string, error?: undefined } | { error: number, path?: undefined }}
     */
    const throughReparse = (path, entry)=>{
        let at = path;
        let here = entry;
        for (let hop = 0; hop <= LINK_HOPS; hop++)
        {
            const tag = here?.exists ? here.reparseTag ?? 0 : 0;
            if (tag === 0)
            {
                return { path: here?.isDirectory ? path : at };
            }
            if (unhandledTag(tag))
            {
                return { error: ERROR_CANT_ACCESS_FILE };
            }
            if (!here.junction)
            {
                return { error: ERROR_FILE_NOT_FOUND };
            }
            at = `${path.slice(0, 2)}${SEPARATOR}${here.junction}`;
            here = files.stat(at);
        }
        return { error: ERROR_CANT_RESOLVE_FILENAME };
    };

    /**
     * Whether the last name of a path holds a wildcard: no file or directory
     * can be called that, so whatever would make, open, remove or rename one
     * answers ERROR_INVALID_NAME before looking anything up.
     *
     * @param {string} path
     */
    const wildcardName = path=>/[*?]/.test(path.slice(path.lastIndexOf(SEPARATOR) + 1));

    /**
     * Whether a reparse tag is one no filter here answers: every tag but
     * the two that name a place, a mount point and a symbolic link.
     *
     * @param {number} tag
     */
    const unhandledTag = tag=>tag !== 0 && tag !== IO_REPARSE_TAG_MOUNT_POINT
        && tag !== IO_REPARSE_TAG_SYMLINK;

    /**
     * Fails a call with a code, returning whatever that function's failure
     * value is. Everything that fails here does both, and doing only one of
     * them is the bug this exists to make impossible.
     *
     * @param {number} code @param {number} [result]
     */
    const fail = (code, result = 0)=>{
        host.setLastError(code);
        return result;
    };

    /** @param {number} handle */
    const isStandardHandle = handle=>
        handle === HANDLE_STDIN || handle === HANDLE_STDOUT || handle === HANDLE_STDERR;

    /**
     * Resolves a handle to one of ours, or null. A stale or invented handle is
     * a return code rather than an exception: guests do pass them, and Windows
     * answers with a failure.
     *
     * @param {number} handle @param {string} type
     */
    const object = (handle, type)=>{
        try
        {
            return host.handles.resolve(handle >>> 0, type);
        }
        catch (e){
            void e;
            return null;
        }
    };

    /**
     * Whether a file handle may read its data, or write it: its open may,
     * and the handle was granted the right - a duplicate may hold fewer
     * rights than the open it shares (`access.js`, the file kind).
     *
     * @param {number} handle @param {{ read?: boolean, write?: boolean }} file
     */
    const reads = (handle, file)=>Boolean(file.read)
        && allows(host.handles.access?.(handle >>> 0) ?? null, FILE_READ_DATA);
    /** @param {number} handle @param {{ read?: boolean, write?: boolean }} file */
    const writes = (handle, file)=>{
        const granted = host.handles.access?.(handle >>> 0) ?? null;
        return Boolean(file.write)
            && (granted === null || (granted & (FILE_WRITE_DATA | FILE_APPEND_DATA)) !== 0);
    };

    /** @param {number} handle  whether it is the null device's */
    const isNul = handle=>host.handles.typeOf?.(handle >>> 0) === 'device'
        && object(handle, 'device')?.device === 'nul';

    /**
     * The null device as a stream: a read is the end of it, a write taken
     * whole and kept nowhere -- in ReadFile's terms or NtReadFile's.
     */
    const nulStream = {
        /** @param {number} handle @param {number} buffer @param {number} length
         *  @param {number} out @param {boolean} [native] */
        read: (handle, buffer, length, out, native = false)=>{
            if (!isNul(handle))
            {
                return null;
            }
            if (native)
            {
                writeDword(out >>> 0, STATUS_END_OF_FILE);
                writeDword((out >>> 0) + 4, 0);
                return STATUS_END_OF_FILE;
            }
            writeDwordIf(out >>> 0, 0);
            host.setLastError(ERROR_SUCCESS);
            return 1;
        },
        /** @param {number} handle @param {number} buffer @param {number} length
         *  @param {number} out @param {boolean} [native] */
        write: (handle, buffer, length, out, native = false)=>{
            if (!isNul(handle))
            {
                return null;
            }
            if (native)
            {
                writeDword(out >>> 0, STATUS_SUCCESS);
                writeDword((out >>> 0) + 4, length >>> 0);
                return STATUS_SUCCESS;
            }
            writeDwordIf(out >>> 0, length >>> 0);
            host.setLastError(ERROR_SUCCESS);
            return 1;
        },
    };

    /** Handles that are no file, each answering a read or write of its own first. */
    /** @type {NonNullable<FileHost['streams']>} */
    const streams = [nulStream, ...host.streams ?? []];

    /**
     * The size the filesystem currently reports for an open file. Taken by path
     * rather than remembered, because a second handle onto the same file, or a
     * SetEndOfFile through one of them, changes it under us.
     *
     * @param {{ path: string }} file
     */
    const sizeOf = file=>files.stat(file.path)?.size ?? 0;

    /** @param {DirectoryEntry | FileStat} entry */
    const attributesOf = entry=>fileAttributes(entry);

    /**
     * Whether a change aimed at `path` lands on read-only media. A disc refuses
     * every write, create and delete as the device, before any name on it is
     * looked at, and says so with its own code rather than as a denied access:
     * an installer told the media is write-protected knows it is looking at
     * the disc it was started from.
     *
     * @param {string} path
     */
    const onReadOnlyMedia = path=>files.writeProtected?.(path) === true;

    /** The refusal of a change to `path`, when the volume did not make it. @param {string} path */
    const denied = path=>onReadOnlyMedia(path) ? ERROR_WRITE_PROTECT : ERROR_ACCESS_DENIED;

    /**
     * Whether a file carries the read-only attribute a program set. Such a
     * file refuses to be written, truncated or deleted by name with "access
     * denied" until the attribute is taken off; renaming it is allowed. A
     * directory's read-only bit is advice to the shell and refuses nothing.
     *
     * @param {FileStat | null | undefined} entry
     */
    const readOnlyFile = entry=>Boolean(entry?.exists && !entry.isDirectory
        && ((entry.attributes ?? 0) & FILE_ATTRIBUTE_READONLY) !== 0);

    /**
     * The attributes a creating call gives a new file: what it asked for,
     * archived as every new file is, or nothing recorded when it asked for
     * none.
     *
     * @param {string} path @param {number} asked
     */
    const giveAttributes = (path, asked)=>{
        const bits = (asked >>> 0) & SETTABLE_ATTRIBUTES & ~FILE_ATTRIBUTE_NORMAL;
        files.setAttributes?.(path, bits === 0 ? null : bits | FILE_ATTRIBUTE_ARCHIVE);
    };

    /**
     * A WIN32_FIND_DATAA with its head filled -- attributes, the three times,
     * the size -- which is also the whole of a WIN32_FILE_ATTRIBUTE_DATA.
     *
     * @param {DirectoryEntry | FileStat} entry
     */
    const findDataHead = entry=>{
        const data = new Uint8Array(WIN32_FIND_DATAA.SIZE);
        const view = new DataView(data.buffer);
        view.setUint32(WIN32_FIND_DATAA.dwFileAttributes, attributesOf(entry), true);
        // One time for all three: the volume records when a file was last
        // written and nothing else, and a program comparing dates compares
        // the write time.
        const time = msToFileTime(entry.modified ?? 0);
        view.setBigUint64(WIN32_FIND_DATAA.ftCreationTime, time, true);
        view.setBigUint64(WIN32_FIND_DATAA.ftLastAccessTime, time, true);
        view.setBigUint64(WIN32_FIND_DATAA.ftLastWriteTime, time, true);
        const size = entry.size ?? 0;
        view.setUint32(WIN32_FIND_DATAA.nFileSizeHigh, high(size), true);
        view.setUint32(WIN32_FIND_DATAA.nFileSizeLow, low(size), true);
        // A reparse point's tag goes where the structure keeps it.
        view.setUint32(WIN32_FIND_DATAA.dwReserved0, entry.reparseTag ?? 0, true);
        return data;
    };

    /**
     * Fills in a whole WIN32_FIND_DATAA. Written in one piece so that no field
     * can be left holding whatever the caller's buffer had in it -- the times
     * and the alternate 8.3 name we have nothing to say about are zeros the
     * guest can read, not gaps.
     *
     * @param {number} address @param {DirectoryEntry} entry
     */
    const writeFindData = (address, entry)=>{
        const data = findDataHead(entry);
        data.set(encodeName(entry.name.slice(0, MAX_PATH - 1)), WIN32_FIND_DATAA.cFileName);
        host.writeMemory(address, data);
    };

    /**
     * Runs a seek and reports where it landed, or null when the answer is not a
     * legal position. Shared by both SetFilePointer forms, which differ only in
     * how they carry the number and how they report the failure.
     *
     * @param {any} file @param {number} distance @param {number} method
     * @returns {number | null}
     */
    const seek = (file, distance, method)=>{
        let base;
        switch (method){
            case FILE_BEGIN:
                base = 0;
                break;
            case FILE_CURRENT:
                base = file.position;
                break;
            case FILE_END:
                base = sizeOf(file);
                break;
            default:
                return null;
        }
        const position = base + distance;
        // Past the end is legal and is how a file is extended; before the
        // beginning is not.
        return position < 0 ? null : position;
    };

    /**
     * CreateFileA's disposition, as what the filesystem is asked to do.
     *
     * @type {Record<number, OpenMode | undefined>}
     */
    const openModes = {
        [CREATE_NEW]: { create: true, failIfExists: true },
        [CREATE_ALWAYS]: { create: true, truncate: true },
        [OPEN_EXISTING]: {},
        [OPEN_ALWAYS]: { create: true },
        [TRUNCATE_EXISTING]: { truncate: true },
    };

    /**
     * WIN32_FIND_DATAW: the same fields as the ANSI form, with both names twice
     * as wide. Everything up to cFileName sits at the same offset in both, which
     * is exactly why the tail is easy to get wrong -- a reader that shares the
     * offsets and forgets the widths writes the second name over the first.
     */
    const WIN32_FIND_DATAW = Object.freeze({
        ...WIN32_FIND_DATAA,
        cAlternateFileName: 564,
        SIZE: 592,
    });

    /** @param {string} text @returns {Uint8Array} UTF-16, with no terminator. */
    const utf16 = text=>{
        const bytes = new Uint8Array(text.length * 2);
        for (let at = 0; at < text.length; at++)
        {
            const code = text.charCodeAt(at);
            bytes[at * 2] = code & 0xff;
            bytes[at * 2 + 1] = code >> 8;
        }
        return bytes;
    };

    /**
     * The wide twin of writeStringTo. The two-call protocol is counted in
     * characters in both forms -- a caller passing a character count and reading
     * one back never sees the byte width -- so only the writing differs.
     *
     * @param {number} buffer @param {number} size @param {string} text
     */
    const writeWideStringTo = (buffer, size, text)=>{
        if (buffer === 0 || text.length + 1 > (size >>> 0))
        {
            return text.length + 1;
        }
        host.writeMemory(buffer, utf16(text + String.fromCharCode(0)));
        return text.length;
    };

    /** @param {number} address @param {DirectoryEntry} entry */
    const writeWideFindData = (address, entry)=>{
        const data = new Uint8Array(WIN32_FIND_DATAW.SIZE);
        const view = new DataView(data.buffer);
        view.setUint32(WIN32_FIND_DATAW.dwFileAttributes, attributesOf(entry), true);
        const time = msToFileTime(entry.modified ?? 0);
        view.setBigUint64(WIN32_FIND_DATAW.ftCreationTime, time, true);
        view.setBigUint64(WIN32_FIND_DATAW.ftLastAccessTime, time, true);
        view.setBigUint64(WIN32_FIND_DATAW.ftLastWriteTime, time, true);
        const size = entry.size ?? 0;
        view.setUint32(WIN32_FIND_DATAW.nFileSizeHigh, high(size), true);
        view.setUint32(WIN32_FIND_DATAW.nFileSizeLow, low(size), true);
        data.set(utf16(entry.name.slice(0, MAX_PATH - 1)), WIN32_FIND_DATAW.cFileName);
        host.writeMemory(address, data);
    };

    /**
     * How text arrives and leaves, which is the whole of the difference between
     * an ANSI entry point and its wide twin.
     *
     * Every operation below is written once, over resolved strings, and appears
     * twice in the table with one of these two bound to it. Writing the pair
     * separately is how a file comes to open one way and not the other.
     *
     * @typedef {Object} TextForm
     * @property {(pointer: number) => string} path
     * @property {(pointer: number) => string} raw
     *           What the caller actually wrote, before resolution. One function
     *           needs it: GetFullPathName keeps a trailing separator the caller
     *           put there, and resolution is what takes it off.
     * @property {(pointer: number) => string} list
     *           A path list, which runs longer than any one path.
     * @property {(buffer: number, size: number, text: string) => number} write
     * @property {(address: number, entry: DirectoryEntry) => void} findData
     * @property {number} unit  Bytes per character, for pointer arithmetic.
     */

    /** @type {TextForm} */
    const ANSI = {
        path: pathArgument,
        raw: pointer=>pointer === 0 ? '' : readName(pointer >>> 0, MAX_PATH_LIST),
        list: pointer=>readName(pointer >>> 0, MAX_PATH_LIST),
        write: writeStringTo,
        findData: writeFindData,
        unit: 1,
    };

    /** @type {TextForm} */
    const WIDE = {
        path: pointer=>fullPath(
            pointer === 0 ? '' : host.readWideString(pointer >>> 0, MAX_WIDE_PATH * 2)),
        raw: pointer=>pointer === 0 ? '' : host.readWideString(pointer >>> 0, MAX_WIDE_PATH * 2),
        list: pointer=>host.readWideString(pointer >>> 0, MAX_PATH_LIST * 2),
        write: writeWideStringTo,
        findData: writeWideFindData,
        unit: 2,
    };

    /**
     * One operation, both spellings.
     *
     * @param {number} argBytes
     * @param {(args: number[], text: TextForm) => any} body
     */
    const bothForms = (argBytes, body)=>({
        ansi: { argBytes, handler: (/** @type {number[]} */ args)=>body(args, ANSI) },
        wide: { argBytes, handler: (/** @type {number[]} */ args)=>body(args, WIDE) },
    });

    /** What ANSI_ONE_NAME throws for a name its buffer cannot hold. */
    const NAME_TOO_LONG = Symbol('name too long');

    /**
     * The name of an ANSI call that takes one: Windows converts it into the
     * thread's static Unicode buffer, MAX_PATH characters and a terminator,
     * and a longer one is refused with ERROR_FILENAME_EXCED_RANGE rather than
     * cut. A call taking two names converts them into buffers of their own
     * and has no such limit.
     *
     * @param {number} pointer
     */
    const oneAnsiName = pointer=>{
        const name = pointer === 0 ? '' : readName(pointer >>> 0, MAX_PATH_LIST);
        if (name.length > MAX_PATH)
        {
            throw NAME_TOO_LONG;
        }
        return name;
    };

    /** @type {TextForm} */
    const ANSI_ONE_NAME = { ...ANSI, path: pointer=>fullPath(oneAnsiName(pointer)),
        raw: oneAnsiName };

    /**
     * An operation on one name, both spellings: the ANSI one refuses a name
     * too long for the static buffer, failing with what the operation fails with.
     *
     * @param {number} argBytes
     * @param {(args: number[], text: TextForm) => any} body
     * @param {number} [failed]  what the function returns when it fails
     */
    const oneName = (argBytes, body, failed = 0)=>({
        ansi: { argBytes, handler: (/** @type {number[]} */ args)=>{
            try
            {
                return body(args, ANSI_ONE_NAME);
            }
            catch (e){
                if (e !== NAME_TOO_LONG)
                {
                    throw e;
                }
                return fail(ERROR_FILENAME_EXCED_RANGE, failed);
            }
        } },
        wide: { argBytes, handler: (/** @type {number[]} */ args)=>body(args, WIDE) },
    });

    const deleteFile = oneName(4, ([name], text)=>{
        const path = text.path(name);
        const entry = files.stat(path);
        if (!entry || !entry.exists)
        {
            return fail(missing(path));
        }
        if (entry.isDirectory || (readOnlyFile(entry) && !onReadOnlyMedia(path)))
        {
            return fail(ERROR_ACCESS_DENIED);
        }
        // The file an image section maps is the program's: it stays.
        if (files.mappedAs?.(path) === 'image')
        {
            return fail(ERROR_ACCESS_DENIED);
        }
        // An open that does not share deletion keeps the name.
        if (files.removalRefused?.(path) === 'SHARING_VIOLATION')
        {
            return fail(ERROR_SHARING_VIOLATION);
        }
        return files.remove(path) ? 1 : fail(denied(path));
    });

    /**
     * The move both spellings, the extended form and a rename through a handle
     * share: the Win32 error it ends in, 0 when it moved.
     *
     * @param {string} source @param {string} destination @param {boolean} replace
     * @param {{ held?: boolean, readOnlyReplaced?: boolean }} [how]  `held`: through
     *     a handle that holds the file for deletion; `readOnlyReplaced`: a read-only
     *     file at the destination is replaced as any other
     *     (FILE_RENAME_IGNORE_READONLY_ATTRIBUTE)
     * @returns {number | Promise<number>}
     */
    const moveError = (source, destination, replace,
        { held = false, readOnlyReplaced = false } = {})=>
    {
        const moving = files.stat(source);
        if (!moving?.exists)
        {
            return missing(source);
        }
        if (wildcardName(destination))
        {
            return ERROR_INVALID_NAME;
        }
        // Its own name, in any case: nothing is replaced, and only the
        // spelling may change.
        if (source.toLowerCase() === destination.toLowerCase())
        {
            return files.rename(source, destination, { held }) ? 0 : denied(source);
        }
        const present = files.stat(destination);
        if (present?.exists && !replace)
        {
            return ERROR_ALREADY_EXISTS;
        }
        // A folder that is not there to move into is a path not found, as
        // Windows answers it: a caller makes the folder and moves again (a
        // WiX setup putting a payload in its cache), where a refusal stopped it.
        const into = files.stat(parentOf(destination));
        if (!into?.exists || !into.isDirectory)
        {
            return ERROR_PATH_NOT_FOUND;
        }
        // A file is renamed as it is deleted: an open that does not share
        // deletion keeps its name - unless the rename is through a handle
        // that holds it for deletion, against which every other open was
        // admitted already.
        if (!held && files.removalRefused?.(source) === 'SHARING_VIOLATION')
        {
            return ERROR_SHARING_VIOLATION;
        }
        if (present?.exists)
        {
            // What is replaced must be a file nobody holds open.
            if (present.isDirectory || files.isOpen?.(destination))
            {
                return ERROR_ACCESS_DENIED;
            }
            if ((readOnlyFile(present) && !readOnlyReplaced) || !files.remove(destination))
            {
                return denied(destination);
            }
        }
        // A move off a disc has to delete what it moved, so the disc refuses
        // it as surely as a move onto one.
        // A move off the bundle may have to wait for the blocks it copies.
        const moved = files.renameOrFetch ? files.renameOrFetch(source, destination, { held })
            : files.rename(source, destination, { held });
        /** @param {boolean} done */
        const answer = done=>{
            if (!done)
            {
                return denied(onReadOnlyMedia(source) ? source : destination);
            }
            follow(source, destination);
            return 0;
        };
        return typeof moved === 'boolean' ? answer(moved) : moved.then(answer);
    };

    /**
     * The move as a Win32 call answers it: TRUE, or FALSE and the last error.
     *
     * @param {string} source @param {string} destination @param {boolean} replace
     */
    const renamePath = (source, destination, replace)=>{
        const error = moveError(source, destination, replace);
        /** @param {number} code */
        const answer = code=>(code === 0 ? 1 : fail(code));
        return typeof error === 'number' ? answer(error) : error.then(answer);
    };

    /**
     * This process's open files under a name just moved, named as they are
     * now: an open file is the file, whatever it is called since, as on
     * Windows - an NGen worker renames the native image it wrote into the
     * cache and goes on asking its handle the image's size.
     *
     * @param {string} source @param {string} destination
     */
    const follow = (source, destination)=>{
        const from = source.toLowerCase();
        for (const { type, object: open } of host.handles.list?.() ?? [])
        {
            const path = type === 'file' && typeof open?.path === 'string' ? open.path : null;
            const lower = path?.toLowerCase();
            if (path !== null && (lower === from || lower?.startsWith(`${from}\\`)))
            {
                open.path = `${destination}${path.slice(source.length)}`;
            }
        }
    };

    /**
     * Where the next generated temporary name starts looking.
     *
     * Counted rather than randomised, as Windows does, and kept across calls so
     * that a caller asking twice in a row is not handed the same name twice --
     * which is the whole reason it asks.
     */
    let nextTempNumber = 1;

    const moveFile = bothForms(8, ([from, to], text)=>
        renamePath(text.path(from), text.path(to), false));

    /** @param {string} base @param {string} stem @param {number} number */
    const tempName = (base, stem, number)=>
        `${base}${stem}${number.toString(16).toUpperCase()}.tmp`;

    /**
     * GetTempPath's answer: the first of TMP, TEMP and USERPROFILE that is
     * set, else the Windows directory, as a full path with its separator -
     * so "C:" is that drive's current directory - read when asked, since a
     * program sets TMP to move its own scratch files.
     */
    const tempPath = ()=>{
        if (!host.environmentVariable)
        {
            return TEMP_PATH;
        }
        const named = ['TMP', 'TEMP', 'USERPROFILE']
            .map(name=>host.environmentVariable?.(name) ?? '').find(value=>value !== '');
        const full = fullPath(named ?? WINDOWS_DIRECTORY);
        return full.endsWith(SEPARATOR) ? full : full + SEPARATOR;
    };

    const getTempFileName = bothForms(16, ([directory, prefix, unique, out], text)=>{
        const folder = (directory >>> 0) === 0 ? tempPath() : text.path(directory);
        const stem = text.raw(prefix).slice(0, 3);
        const base = folder.endsWith(SEPARATOR) ? folder : folder + SEPARATOR;
        // The directory must be there, whether a file is made in it or only
        // a name built.
        if (!files.stat(fullPath(folder))?.isDirectory)
        {
            return fail(ERROR_DIRECTORY, 0);
        }

        let number = (unique >>> 0) & 0xffff;
        let path = '';
        if (number !== 0)
        {
            path = tempName(base, stem, number);
        }
        else
        {
            // A name nothing holds. Windows counts rather than randomises,
            // and a caller that asks twice must not be handed the same name
            // -- so the file is created here, which is what makes the second
            // search skip it.
            for (number = nextTempNumber; number <= 0xffff; number++)
            {
                const candidate = tempName(base, stem, number);
                const entry = files.stat(candidate);
                if (!entry || !entry.exists)
                {
                    path = candidate;
                    break;
                }
            }
            if (path === '')
            {
                return fail(ERROR_ACCESS_DENIED, 0);
            }
            nextTempNumber = number + 1;
            const node = files.open(path,
                { read: true, write: true, create: true, truncate: true });
            if (!node)
            {
                return fail(ERROR_ACCESS_DENIED, 0);
            }
            // Created and closed: the name is reserved by the file's
            // existence, not by holding it open. Held, the caller's own open
            // of the name it was just given would be refused as shared with
            // nobody.
            files.close(node);
        }

        text.write(out >>> 0, MAX_PATH, path.slice(0, MAX_PATH - 1));
        host.setLastError(ERROR_SUCCESS);
        return number;
    });

    /**
     * The move an installer makes when it puts an unpacked file in its
     * final place. MOVEFILE_REPLACE_EXISTING is the flag that matters: a
     * second install over the first replaces rather than failing, and
     * without honouring it the second run stops on the first file it
     * already wrote.
     *
     * MOVEFILE_DELAY_UNTIL_REBOOT names a file to move when the machine
     * next starts. There is no next start here, so it is refused rather
     * than accepted and forgotten -- a caller told it succeeded would
     * believe a file it still needs has been scheduled.
     */
    const moveFileEx = bothForms(12, ([from, to, flags], text)=>{
        if ((flags >>> 0 & MOVEFILE_DELAY_UNTIL_REBOOT) !== 0)
        {
            return fail(ERROR_NOT_SUPPORTED);
        }
        return renamePath(text.path(from), text.path(to),
            (flags >>> 0 & MOVEFILE_REPLACE_EXISTING) !== 0);
    });

    /**
     * MoveFileEx with a routine told of a copy's progress. A move here is a
     * rename on one volume, which copies nothing, so the routine is never
     * called -- as on Windows, where it is called only when the move copies
     * across volumes (MOVEFILE_COPY_ALLOWED).
     */
    const moveFileWithProgress = bothForms(20, ([from, to, , , flags], text)=>
        moveFileEx[text === ANSI ? 'ansi' : 'wide'].handler([from, to, flags]));

    /** How the volume says a link could not be made, as CreateHardLink answers it. */
    const LINK_ERRORS = Object.freeze({
        NOT_SAME_DEVICE: ERROR_NOT_SAME_DEVICE, ACCESS_DENIED: ERROR_ACCESS_DENIED,
        IS_A_DIRECTORY: ERROR_ACCESS_DENIED, ALREADY_EXISTS: ERROR_ALREADY_EXISTS,
        NOT_FOUND: ERROR_FILE_NOT_FOUND, PATH_NOT_FOUND: ERROR_PATH_NOT_FOUND,
        NOT_A_DIRECTORY: ERROR_PATH_NOT_FOUND, WRITE_PROTECTED: ERROR_WRITE_PROTECT,
        INVALID_PATH: ERROR_INVALID_NAME, NO_SUCH_DRIVE: ERROR_PATH_NOT_FOUND,
    });

    /** The file-system controls a file's or a directory's handle answers: its reparse point. */
    const REPARSE_CONTROLS = new Set([FSCTL_SET_REPARSE_POINT, FSCTL_GET_REPARSE_POINT,
        FSCTL_DELETE_REPARSE_POINT]);

    /**
     * A reparse control on the file or directory at `path`, through the one
     * set of rules (`reparseRequest`), with the bytes it hands back written
     * to `output`.
     *
     * @param {string} path @param {number} code @param {number} input
     * @param {number} inLength @param {number} output @param {number} outLength
     * @returns {{ status: number, information: number }}
     */
    const reparseControl = (path, code, input, inLength, output, outLength)=>{
        if (!files.setReparse || !files.reparseOf)
        {
            host.divergence?.('FSCTL_SET_REPARSE_POINT', `the volume keeps no reparse points;`
                + ` ${path} not made one`);
            return { status: STATUS_INVALID_DEVICE_REQUEST, information: 0 };
        }
        const given = input === 0 || inLength === 0 ? null
            : host.readMemory(input, inLength).slice();
        const answer = reparseRequest(/** @type {any} */ (files), path, code, given,
            output !== 0, outLength, host);
        if (answer.output)
        {
            host.writeMemory(output, answer.output);
        }
        return answer;
    };

    /**
     * BOOL CreateHardLink(LPCTSTR lpFileName, LPCTSTR lpExistingFileName,
     *     LPSECURITY_ATTRIBUTES)
     *
     * One file under one more name, on its own drive: what is written
     * through either is read through both, and the bytes go with the last
     * name. A directory has none (ACCESS_DENIED), nor has a name already
     * taken (ALREADY_EXISTS), whatever case it is spelt in.
     */
    const createHardLink = bothForms(12, ([name, existing], text)=>{
        const path = text.path(name);
        const target = text.path(existing);
        if (!files.link)
        {
            host.divergence?.('CreateHardLink', `the volume keeps no links; ${path} not linked`);
            return fail(ERROR_INVALID_FUNCTION);
        }
        const refused = files.link(path, target);
        if (refused !== null)
        {
            return fail(LINK_ERRORS[/** @type {keyof typeof LINK_ERRORS} */ (refused)]
                ?? ERROR_ACCESS_DENIED);
        }
        host.setLastError(ERROR_SUCCESS);
        return 1;
    });

    /**
     * The volume has no reparse points to make a link of; the caller is
     * answered as a user without the privilege to create one is.
     */
    const createSymbolicLink = bothForms(12, ([name], text)=>{
        host.divergence?.('CreateSymbolicLink', `no symbolic links; ${text.path(name)} not made`);
        return fail(ERROR_PRIVILEGE_NOT_HELD);
    });

    /**
     * ReplaceFile: the replacement takes the replaced file's name, and the
     * replaced file goes to the backup name when one is given. Either file
     * read-only refuses the whole replacement before anything moves.
     */
    const replaceFile = bothForms(24, ([replaced, replacement, backup], text)=>{
        const target = text.path(replaced);
        const source = text.path(replacement);
        const old = files.stat(target);
        const incoming = files.stat(source);
        if (!old?.exists || !incoming?.exists)
        {
            return fail(ERROR_FILE_NOT_FOUND);
        }
        if (readOnlyFile(old) || readOnlyFile(incoming))
        {
            return fail(ERROR_ACCESS_DENIED);
        }
        if ((backup >>> 0) !== 0)
        {
            const kept = renamePath(target, text.path(backup), true);
            if (kept !== 1)
            {
                return kept;
            }
        }
        else if (!files.remove(target))
        {
            return fail(denied(target));
        }
        return renamePath(source, target, true);
    });

    /**
     * The copy every spelling shares. Copied through the ordinary read and
     * write path rather than by asking the filesystem for a copy, because a
     * copy that is not a read followed by a write is a second implementation
     * of both. The copy carries the source's attributes and its write time,
     * as a copy on Windows does; a file copied onto itself is the destination
     * open colliding with the source's, a sharing violation.
     *
     * @param {string} named @param {string} destinationNamed @param {boolean} failIfExists
     * @returns {number | Promise<number>}
     */
    const copyPath = (named, destinationNamed, failIfExists)=>{
        if (named === '' || destinationNamed === '')
        {
            return fail(ERROR_PATH_NOT_FOUND);
        }
        // Both names are opened as an open of them would be: a symbolic
        // link copies what it names, and a copy onto one writes what it
        // names, the link left as it is.
        const origin = throughReparse(named, files.stat(named));
        if (origin.error !== undefined)
        {
            return fail(origin.error);
        }
        const source = origin.path;
        const entry = files.stat(source);
        if (!entry || !entry.exists || entry.isDirectory)
        {
            return fail(entry?.isDirectory ? ERROR_ACCESS_DENIED : missing(source));
        }
        if (named.toLowerCase() === destinationNamed.toLowerCase())
        {
            return fail(ERROR_SHARING_VIOLATION);
        }
        const link = files.stat(destinationNamed);
        if (failIfExists && link?.exists)
        {
            return fail(ERROR_FILE_EXISTS);
        }
        const to = throughReparse(destinationNamed, link);
        if (to.error !== undefined)
        {
            return fail(to.error);
        }
        const destination = to.path;
        if (source.toLowerCase() === destination.toLowerCase())
        {
            return fail(ERROR_SHARING_VIOLATION);
        }
        const present = destination === destinationNamed ? link : files.stat(destination);
        if (readOnlyFile(present) || present?.isDirectory)
        {
            return fail(ERROR_ACCESS_DENIED);
        }
        /** @param {string} path */
        const refusal = path=>(files.openRefusal?.() === 'SHARING_VIOLATION'
            ? ERROR_SHARING_VIOLATION : onReadOnlyMedia(path) ? ERROR_WRITE_PROTECT
                : files.stat(path)?.exists ? ERROR_ACCESS_DENIED : missing(path));
        // The source is read sharing everything; the destination written
        // sharing reading and writing, but not its deletion -- a holder of
        // DELETE keeps it -- and settled before it is emptied.
        const input = files.open(source, { read: true, shareRead: true, shareWrite: true,
            shareDelete: true });
        if (!input)
        {
            return fail(refusal(source));
        }
        const output = files.open(destination, { read: false, write: true, create: true,
            shareRead: true, shareWrite: true });
        if (!output)
        {
            files.close(input);
            return fail(refusal(destination));
        }
        const mapped = files.mappedAs?.(destination);
        if (mapped && mapped !== 'image')
        {
            files.close(input);
            files.close(output);
            return fail(ERROR_USER_MAPPED_FILE);
        }
        files.truncate(output, 0);
        // A chunk at a time: the files a game copies are the ones it
        // shipped, and holding one of those whole is a copy that works
        // in a test and runs out of memory on a real install. A chunk of a
        // bundle's file whose blocks are not here yet is a promise: the
        // thread is parked until they are, as ReadFile's is, and the copy
        // goes on from that chunk -- the source stays open until then, since
        // the read that fetches it reads it again once they have come.
        const owner = host.currentThread?.() ?? null;
        /** @param {number} code @param {boolean} parked */
        const answer = (code, parked)=>{
            if (parked && owner && host.setLastErrorFor)
            {
                host.setLastErrorFor(owner, code);
            }
            else
            {
                host.setLastError(code);
            }
        };
        /** @param {boolean} parked */
        const finish = parked=>{
            files.close(input);
            files.close(output);
            files.setAttributes?.(destination, entry.attributes ?? null);
            if (entry.modified)
            {
                files.setModified?.(destination, entry.modified);
            }
            answer(ERROR_SUCCESS, parked);
            return 1;
        };
        /**
         * @param {number} from @param {boolean} parked
         * @returns {number | Promise<number>}
         */
        const copyFrom = (from, parked)=>{
            for (let at = from; at < entry.size; at += COPY_CHUNK)
            {
                const chunk = files.read(input, at, COPY_CHUNK);
                if (typeof (/** @type {any} */ (chunk))?.then === 'function')
                {
                    return /** @type {Promise<Uint8Array>} */ (chunk).then(bytes=>{
                        files.write(output, at, bytes);
                        return copyFrom(at + COPY_CHUNK, true);
                    }, ()=>{
                        files.close(input);
                        files.close(output);
                        answer(ERROR_IO_DEVICE, true);
                        return 0;
                    });
                }
                files.write(output, at, /** @type {Uint8Array} */ (chunk));
            }
            return finish(parked);
        };
        return copyFrom(0, false);
    };

    const copyFile = bothForms(12, ([from, to, failIfExists], text)=>
        copyPath(text.path(from), text.path(to), failIfExists !== 0));

    /**
     * The progress routine is not called: a copy here is one step with
     * nothing to report between its start and its end, and a caller that
     * would have cancelled from the routine sees the copy complete. The
     * cancel flag is read once, before anything is written.
     */
    const copyFileEx = bothForms(24, ([from, to, , , cancel, flags], text)=>{
        if ((cancel >>> 0) !== 0 && readDword(cancel >>> 0) !== 0)
        {
            return fail(ERROR_REQUEST_ABORTED);
        }
        return copyPath(text.path(from), text.path(to),
            ((flags >>> 0) & COPY_FILE_FAIL_IF_EXISTS) !== 0);
    });

    /** @param {number[]} args @param {TextForm} text */
    const searchPathBody = ([pathList, fileName, extension, size, buffer, filePart], text)=>{
        let name = text.raw(fileName);
        // Blanks are no name: the path rules would drop them and find the
        // folder searched.
        if (/^ *$/.test(name))
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const bare = name.slice(
            Math.max(name.lastIndexOf(SEPARATOR), name.lastIndexOf('/')) + 1);
        if ((extension >>> 0) !== 0 && !bare.includes('.'))
        {
            name += text.raw(extension);
        }
        const qualified = /^[A-Za-z]:|^[\\/]/.test(name)
            || name.includes(SEPARATOR) || name.includes('/');
        const directories = qualified
            ? ['']
            : (pathList >>> 0) !== 0
                ? text.list(pathList).split(';')
                : [parentOf(host.imagePath?.() ?? ''), files.currentDirectory(),
                    SYSTEM_DIRECTORY, WINDOWS_DIRECTORY];
        for (const directory of directories)
        {
            const candidate = fullPath(directory === ''
                ? name
                : `${directory.replace(/[\\/]$/, '')}${SEPARATOR}${name}`);
            // A directory is found as a file is: the search asks whether the
            // name exists, and an installer looks for its own Disk1 folder so.
            const entry = files.stat(candidate);
            if (!entry?.exists)
            {
                continue;
            }
            const written = text.write(buffer >>> 0, size, candidate);
            if (written === candidate.length)
            {
                writeDwordIf(filePart >>> 0,
                    (buffer >>> 0) + (candidate.lastIndexOf(SEPARATOR) + 1) * text.unit);
            }
            return written;
        }
        return fail(ERROR_FILE_NOT_FOUND);
    };
    const searchPath = bothForms(24, searchPathBody);

    /**
     * The security descriptor a SECURITY_ATTRIBUTES points at, or 0: its
     * lpSecurityDescriptor, the second of its three fields.
     *
     * @param {number} attributes
     */
    const securityDescriptorOf = attributes=>{
        if ((attributes >>> 0) === 0)
        {
            return 0;
        }
        const field = host.readMemory((attributes >>> 0) + 4, 4);
        return (field[0] | field[1] << 8 | field[2] << 16 | field[3] << 24) >>> 0;
    };
    const createDirectory = oneName(8, ([name, attributes], text)=>{
        const path = text.path(name);
        if (wildcardName(path))
        {
            return fail(ERROR_INVALID_NAME);
        }
        if (files.stat(path)?.exists)
        {
            return fail(ERROR_ALREADY_EXISTS);
        }
        // Only one level at a time, as Windows does: a missing parent is a
        // failure, not something to create on the way past.
        if (!files.mkdir(path))
        {
            return fail(onReadOnlyMedia(path) ? ERROR_WRITE_PROTECT : ERROR_PATH_NOT_FOUND);
        }
        host.recordFileSecurity?.(path, securityDescriptorOf(attributes));
        return 1;
    });

    const removeDirectory = oneName(4, ([name], text)=>{
        const path = text.path(name);
        if (wildcardName(path))
        {
            return fail(ERROR_INVALID_NAME);
        }
        const entry = files.stat(path);
        if (!entry || !entry.exists)
        {
            return fail(missing(path));
        }
        if (!entry.isDirectory)
        {
            return fail(ERROR_DIRECTORY);
        }
        // The current directory is held open, and so is a directory opened
        // without sharing deletion.
        if (files.removalRefused?.(path) === 'SHARING_VIOLATION')
        {
            return fail(ERROR_SHARING_VIOLATION);
        }
        return files.remove(path)
            ? 1 : fail(onReadOnlyMedia(path) ? ERROR_WRITE_PROTECT : ERROR_DIR_NOT_EMPTY);
    });

    /**
     * A pipe's name, answered as Windows' attribute query answers it: by
     * opening the name (`pipes.query`) - a normal file while an instance
     * listened, ERROR_PIPE_BUSY while none does.
     *
     * @param {number} name @param {any} text
     * @returns {number | null}  the error, 0, or null for a name that is no pipe's
     */
    const pipeQuery = (name, text)=>(name !== 0 && host.pipes && isPipeName(text.raw(name))
        ? host.pipes.query(text.raw(name)) : null);

    const getFileAttributes = oneName(4, ([name], text)=>{
        const piped = pipeQuery(name, text);
        if (piped !== null)
        {
            return piped === 0 ? FILE_ATTRIBUTE_NORMAL : fail(piped, INVALID_FILE_ATTRIBUTES);
        }
        const path = text.path(name);
        const entry = files.stat(path);
        if (!entry || !entry.exists)
        {
            return fail(missing(path), INVALID_FILE_ATTRIBUTES);
        }
        return attributesOf(entry);
    }, INVALID_FILE_ATTRIBUTES);

    /** WIN32_FILE_ATTRIBUTE_DATA is the head of a WIN32_FIND_DATA. */
    const getFileAttributesEx = oneName(12, ([name, level, out], text)=>{
        if ((level >>> 0) !== GET_FILE_EX_INFO_STANDARD)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const piped = pipeQuery(name, text);
        if (piped !== null)
        {
            if (piped !== 0)
            {
                return fail(piped);
            }
            const data = new Uint8Array(WIN32_FILE_ATTRIBUTE_DATA_SIZE);
            new DataView(data.buffer).setUint32(0, FILE_ATTRIBUTE_NORMAL, true);
            host.writeMemory(out >>> 0, data);
            return 1;
        }
        const path = text.path(name);
        const entry = files.stat(path);
        if (!entry || !entry.exists)
        {
            return fail(missing(path));
        }
        host.writeMemory(out >>> 0,
            findDataHead(entry).subarray(0, WIN32_FILE_ATTRIBUTE_DATA_SIZE));
        return 1;
    });

    const setFileAttributes = oneName(8, ([name, attributes], text)=>{
        const path = text.path(name);
        if (!files.stat(path)?.exists)
        {
            return fail(missing(path));
        }
        if (onReadOnlyMedia(path))
        {
            return fail(ERROR_WRITE_PROTECT);
        }
        files.setAttributes?.(path, (attributes >>> 0) & SETTABLE_ATTRIBUTES);
        return 1;
    });

    const setCurrentDirectory = oneName(4, ([name], text)=>{
        const path = text.path(name);
        const entry = files.stat(path);
        if (!entry || !entry.exists)
        {
            return fail(missing(path));
        }
        if (!entry.isDirectory)
        {
            return fail(ERROR_DIRECTORY);
        }
        files.setCurrentDirectory(path);
        return 1;
    });

    const getCurrentDirectory = bothForms(8, ([size, buffer], text)=>
        text.write(buffer >>> 0, size, files.currentDirectory()));

    const getFullPathName = oneName(16, ([name, size, buffer, filePart], text)=>{
        const asked = text.raw(name);
        // No name, NULL or empty, is no name at all, as Windows from 7 says.
        if (asked === '')
        {
            return fail(ERROR_INVALID_NAME);
        }
        // A path in the Win32 file namespace is already as full as it gets, and
        // is handed back as written: that namespace turns all parsing off.
        if (asked.startsWith('\\\\?\\'))
        {
            const result = text.write(buffer >>> 0, size, asked);
            if (result === asked.length)
            {
                const at = asked.lastIndexOf(SEPARATOR);
                writeDwordIf(filePart >>> 0, asked.endsWith(SEPARATOR)
                    ? 0 : (buffer >>> 0) + (at + 1) * text.unit);
            }
            return result;
        }
        // Devices, device paths, the last name's dots and a directory's
        // separator are the full path's own rules (`fullPathName`); the rest
        // is placed as every file call places it.
        const { path: written, filePart: at } = fullPathName(asked, fullPath);
        const result = text.write(buffer >>> 0, size, written);
        if (result === written.length)
        {
            // Into the caller's own buffer, so the offset is in characters
            // scaled by however wide one is.
            writeDwordIf(filePart >>> 0, at === -1 ? 0 : (buffer >>> 0) + at * text.unit);
        }
        return result;
    });

    /**
     * The name as given, but for a component in 8.3 shape -- which might be
     * a short name -- in the case the volume keeps it in: what
     * GetLongPathName answers. A component already long stays as given,
     * case and all (Wine's kernel32 path test; a program reopens what it
     * passed), as do drives, dots and anything the volume does not list.
     *
     * @param {string} given
     */
    const longCase = given=>{
        const parts = given.split(/([\\/]+)/);
        let prefix = '';
        /** @param {string} part @param {number} index */
        const resolve = (part, index)=>{
            const separator = index % 2 === 1;
            if (separator || !/^[^.\s"*/:<>?\\|]{1,8}(\.[^.\s"*/:<>?\\|]{0,3})?$/.test(part)
                || /^[A-Za-z]:$/.test(part) || (given.startsWith('\\\\') && index <= 4))
            {
                return part;
            }
            try
            {
                const found = files.list(fullPath(prefix === '' ? '.' : prefix), part)
                    .find(entry=>entry.name.toLowerCase() === part.toLowerCase());
                return found ? found.name : part;
            }
            catch {
                return part;
            }
        };
        return parts.map((part, index)=>{
            const resolved = resolve(part, index);
            prefix += resolved;
            return resolved;
        }).join('');
    };

    /**
     * GetLongPathName and GetShortPathName: the name as the caller gave it --
     * relative or absolute, its separators and a trailing one kept, as
     * Windows keeps them (Wine's kernel32 path tests). Short 8.3 names are a
     * FAT artefact this volume keeps none of, so a component's short form is
     * the component; the long form has the case the volume keeps it in. The
     * path must exist: a caller uses the failure to test exactly that.
     *
     * @param {boolean} long
     */
    const pathForm = long=>oneName(12, ([name, buffer, size], text)=>{
        if ((name >>> 0) === 0)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const path = text.path(name);
        if (wildcardName(path))
        {
            return fail(ERROR_INVALID_NAME);
        }
        if (!files.stat(path)?.exists)
        {
            return fail(missing(path));
        }
        const given = text.raw(name);
        return text.write(buffer >>> 0, size, long ? longCase(given) : given);
    });
    const getLongPathName = pathForm(true);
    const getShortPathName = pathForm(false);

    const findFirstFile = oneName(8, ([name, data], text)=>{
        const path = text.path(name);
        if (path === '')
        {
            return fail(ERROR_PATH_NOT_FOUND, INVALID_HANDLE_VALUE);
        }
        // A device named without wildcards is found as itself, wherever it
        // is asked for: one entry, under the name it was asked by.
        const asked = path.slice(path.lastIndexOf(SEPARATOR) + 1);
        if (!/[*?]/.test(asked) && files.deviceOf?.(path))
        {
            /** @type {DirectoryEntry} */
            const device = { name: asked, isDirectory: false, size: 0,
                attributes: FILE_ATTRIBUTE_ARCHIVE };
            text.findData(data >>> 0, device);
            host.setLastError(ERROR_SUCCESS);
            return host.handles.open('find', { entries: [device], index: 1 });
        }
        const directory = parentOf(path);
        const pattern = path.slice(directory.endsWith(SEPARATOR)
            ? directory.length
            : directory.length + 1);
        const holder = files.stat(directory);
        if (!holder || !holder.exists || !holder.isDirectory)
        {
            return fail(ERROR_PATH_NOT_FOUND, INVALID_HANDLE_VALUE);
        }
        // The pattern is matched as the native expression kernel32 makes of
        // it (`win32Expression`), each name of the folder in turn; every
        // folder but a drive's root lists itself and its parent first, as "."
        // and "..", when the expression takes them - a program that skips the
        // first two entries unseen relies on it.
        const expression = win32Expression(pattern);
        const dots = /^[A-Za-z]:\\?$/.test(directory) ? []
            : ['.', '..'].map(dot=>({ ...holder, name: dot, isDirectory: true, size: 0 }));
        // A name without wildcards is looked up as itself, which finds the
        // libraries this build implements in the system folder too.
        const listed = files.list(directory, /[*?<>"]/.test(pattern) ? '*' : pattern) ?? [];
        const entries = [...dots, ...listed]
            .filter(entry=>isNameInExpression(expression, entry.name));
        if (entries.length === 0)
        {
            return fail(ERROR_FILE_NOT_FOUND, INVALID_HANDLE_VALUE);
        }
        text.findData(data >>> 0, entries[0]);
        host.setLastError(ERROR_SUCCESS);
        return host.handles.open('find', { entries, index: 1 });
    }, INVALID_HANDLE_VALUE);

    /**
     * FindFirstFileEx: the same search, with the level of detail, a search
     * operation and flags. The basic level leaves out the 8.3 name, which is
     * never written here anyway; limiting to directories is advice a file
     * system is free not to take, and a caller filters for itself; and the
     * flags ask for case-sensitive matching or larger reads, neither of which
     * changes what is found. Anything else is refused.
     */
    const findFirstFileEx = oneName(24, ([name, level, data, operation, filter, flags], text)=>{
        if ((level >>> 0) > FIND_EX_INFO_BASIC
            || (operation >>> 0) > FIND_EX_SEARCH_LIMIT_TO_DIRECTORIES
            || filter !== 0
            || ((flags >>> 0) & ~(FIND_FIRST_EX_CASE_SENSITIVE | FIND_FIRST_EX_LARGE_FETCH)) !== 0)
        {
            return fail(ERROR_INVALID_PARAMETER, INVALID_HANDLE_VALUE);
        }
        return (text === WIDE ? findFirstFile.wide : findFirstFile.ansi).handler([name, data]);
    }, INVALID_HANDLE_VALUE);

    /**
     * What is wrong with a name a file is opened by, before anything is
     * looked up, or 0. Resolution forgives what the open must not: a wildcard
     * names no one file, and a trailing separator says the name is a
     * directory -- an existing directory spelled so is not a file to open
     * unless it is opened as a directory, and a new file cannot be made
     * under a name that ends in one.
     *
     * @param {string} raw  What the caller wrote.
     * @param {string} path  The same, resolved.
     * @param {boolean} creating  Whether the disposition may make the file.
     * @param {number} [flags]  CreateFile's, FILE_FLAG_BACKUP_SEMANTICS read.
     */
    const nameRefusal = (raw, path, creating, flags = 0)=>{
        if (wildcardName(path))
        {
            return ERROR_INVALID_NAME;
        }
        // A colon past the drive's own is no name -- C:c:\windows -- and a
        // name in the device namespace that is no device is not found.
        if (!raw.startsWith('\\\\') && /:/.test(raw.slice(2)))
        {
            return ERROR_INVALID_NAME;
        }
        if (/^\\\\\.\\[^\\/:]+$/.test(raw)
            && !/^\\\\\.\\(Volume\{|PhysicalDrive|CdRom|Harddisk)/i.test(raw))
        {
            return ERROR_FILE_NOT_FOUND;
        }
        if (!/[\\/]$/.test(raw) || /^[A-Za-z]:[\\/]$/.test(raw))
        {
            return 0;
        }
        const entry = files.stat(path);
        if (entry?.exists)
        {
            const asDirectory = ((flags >>> 0) & FILE_FLAG_BACKUP_SEMANTICS) !== 0;
            return !entry.isDirectory ? ERROR_INVALID_NAME
                : asDirectory ? 0 : ERROR_PATH_NOT_FOUND;
        }
        return creating ? ERROR_INVALID_NAME : missing(path);
    };

    /**
     * The open CreateFile and NtCreateFile share, over a resolved path: a
     * handle and whether the file was already there, or the Win32 error it
     * failed with. `cannotDelete` and `deletePending` mark the refusals the
     * native call names differently -- a read-only file asked to go away when
     * it closes, and a file whose deletion is pending.
     *
     * @param {string} path
     * @param {{ access: number, share: number, disposition: number, flags: number,
     *     mode?: number }} request
     * @param {number} [implied]  rights the handle is granted beside those asked
     * @returns {{ handle: number, existed: boolean } | { error: number, cannotDelete?: boolean,
     *     deletePending?: boolean }}
     */
    const openPath = (path, request, implied = 0)=>{
        const result = openPathOnce(path, request, implied);
        if ('error' in result)
        {
            host.openRefused?.({ path, error: result.error, ...request });
        }
        return result;
    };
    /**
     * `openPath` without the account of what it refused.
     *
     * @param {string} path
     * @param {{ access: number, share: number, disposition: number, flags: number,
     *     mode?: number }} request
     * @param {number} implied
     * @returns {{ handle: number, existed: boolean }
     *     | { error: number, cannotDelete?: boolean, deletePending?: boolean }}
     */
    const openPathOnce = (path, { access, share, disposition, flags, mode: kept }, implied)=>{
        const mode = openModes[disposition >>> 0];
        if (!mode)
        {
            return { error: ERROR_INVALID_PARAMETER };
        }
        const rights = access >>> 0;
        const read = (rights & (GENERIC_READ | GENERIC_ALL | FILE_READ_DATA)) !== 0;
        const write = (rights
            & (GENERIC_WRITE | GENERIC_ALL | FILE_WRITE_DATA | FILE_APPEND_DATA)) !== 0;
        const deleteOnClose = ((flags >>> 0) & FILE_FLAG_DELETE_ON_CLOSE) !== 0;
        // Emptying an existing file is asked with GENERIC_WRITE itself:
        // FILE_WRITE_DATA alone does not do.
        if (disposition === TRUNCATE_EXISTING && (rights & GENERIC_WRITE) === 0)
        {
            return { error: ERROR_INVALID_PARAMETER };
        }
        if ((write || deleteOnClose) && onReadOnlyMedia(path))
        {
            return { error: ERROR_WRITE_PROTECT };
        }

        const named = files.stat(path);
        const landed = named?.reparseTag && ((flags >>> 0) & FILE_FLAG_OPEN_REPARSE_POINT) === 0
            ? throughReparse(path, named) : { path };
        if (landed.error !== undefined)
        {
            return { error: landed.error };
        }
        if (landed.path !== path)
        {
            return openPathOnce(landed.path, { access, share, disposition,
                flags: (flags >>> 0) | FILE_FLAG_OPEN_REPARSE_POINT, mode: kept }, implied);
        }
        const existing = named;
        const exists = Boolean(existing && existing.exists);
        // A file whose deletion is pending opens no more, whatever is asked.
        if (exists && deletePending.has(path.toLowerCase()))
        {
            return { error: ERROR_ACCESS_DENIED, deletePending: true };
        }
        if (exists && existing?.isDirectory)
        {
            // A directory opens only with FILE_FLAG_BACKUP_SEMANTICS, and
            // only as itself: no bytes to read or write, nothing to make.
            if (((flags >>> 0) & FILE_FLAG_BACKUP_SEMANTICS) === 0
                || disposition === CREATE_ALWAYS || disposition === TRUNCATE_EXISTING)
            {
                return { error: ERROR_ACCESS_DENIED };
            }
            if (disposition === CREATE_NEW)
            {
                return { error: ERROR_FILE_EXISTS };
            }
            const handle = host.handles.open('file',
                { path, node: null, directory: true, read: false, write: false, position: 0,
                    // A folder watched through a completion port is opened so.
                    ...((flags >>> 0) & FILE_FLAG_OVERLAPPED) !== 0 ? { overlapped: true } : {} },
                mappedAccess('file', rights | implied));
            return { handle, existed: true };
        }
        if (exists && disposition === CREATE_NEW)
        {
            return { error: ERROR_FILE_EXISTS };
        }
        if (!exists && (disposition === OPEN_EXISTING
                || disposition === TRUNCATE_EXISTING))
        {
            return { error: missing(path) };
        }
        // A file a section maps cannot be emptied under it; an image
        // section's refusal of writers is the sharing's, below.
        if (exists && (disposition === CREATE_ALWAYS || disposition === TRUNCATE_EXISTING)
            && files.mappedAs?.(path) && files.mappedAs?.(path) !== 'image')
        {
            return { error: ERROR_USER_MAPPED_FILE };
        }
        if (readOnlyFile(existing))
        {
            if (write || disposition === CREATE_ALWAYS || disposition === TRUNCATE_EXISTING)
            {
                return { error: ERROR_ACCESS_DENIED };
            }
            if (deleteOnClose)
            {
                return { error: ERROR_ACCESS_DENIED, cannotDelete: true };
            }
        }

        // Executing a file reads it, as far as sharing is concerned; whether
        // ReadFile may is this handle's own `read`.
        const executes = (rights & (GENERIC_EXECUTE | FILE_EXECUTE)) !== 0;
        const node = files.open(path, {
            read: read || executes, write, ...mode,
            shareRead: ((share >>> 0) & FILE_SHARE_READ) !== 0,
            shareWrite: ((share >>> 0) & FILE_SHARE_WRITE) !== 0,
            delete: deleteOnClose || (rights & (DELETE | GENERIC_ALL)) !== 0,
            shareDelete: ((share >>> 0) & FILE_SHARE_DELETE) !== 0,
        });
        if (!node)
        {
            // Another open's terms refuse this one's, as CreateFile says it.
            if (files.openRefusal?.() === 'SHARING_VIOLATION')
            {
                return { error: ERROR_SHARING_VIOLATION };
            }
            return { error: onReadOnlyMedia(path) ? ERROR_WRITE_PROTECT
                : exists ? ERROR_ACCESS_DENIED : missing(path) };
        }
        // A new file takes the attributes it was created with; one that is
        // replaced takes them too, as a file made afresh would.
        if (!exists || disposition === CREATE_ALWAYS)
        {
            giveAttributes(path, flags);
        }
        // A handle opened for overlapped I/O keeps no file pointer of its
        // own that a read or write moves: each says where in its OVERLAPPED.
        const overlapped = ((flags >>> 0) & FILE_FLAG_OVERLAPPED) !== 0;
        const writeAttributes = (rights
            & (GENERIC_WRITE | GENERIC_ALL | FILE_WRITE_ATTRIBUTES)) !== 0;
        // FILE_FLAG_DELETE_ON_CLOSE asks for DELETE with it, as CreateFile does.
        const handle = host.handles.open('file', {
            path, node, read, write, writeAttributes, position: 0,
            mode: kept ?? modeOfFlags(flags),
            ...deleteOnClose ? { deleteOnClose } : {},
            ...overlapped ? { overlapped } : {},
        }, mappedAccess('file', rights | implied | (deleteOnClose ? DELETE : 0)));
        return { handle, existed: exists };
    };

    /**
     * CreateFile, in terms of a resolved path, so both spellings open the same
     * file. Security and the template are accepted and ignored: there is no
     * security descriptor to check against, and no attribute of a template file
     * we could copy. FILE_SHARE_WRITE is honoured, so a second writer the first
     * open agreed to share with gets in; reading is always shared, so an open
     * Windows would refuse for want of FILE_SHARE_READ still succeeds here.
     */
    const createFile = oneName(28, ([name, access, share, attributes, disposition, flags], text)=>{
        // The one device opened by name: the mount manager, whatever was asked of it.
        if (name !== 0 && text.raw(name).toLowerCase() === MOUNT_MANAGER.toLowerCase())
        {
            host.setLastError(ERROR_SUCCESS);
            return host.handles.open('device', { device: 'mountmgr' });
        }
        // The null device, by its name in any directory or as \\.\NUL: what
        // is written to it goes nowhere, and reading it is the end at once.
        if (name !== 0 && (/^\\\\\.\\nul$/i.test(text.raw(name))
            || files.deviceOf?.(text.path(name)) === 'NUL'))
        {
            host.setLastError(ERROR_SUCCESS);
            return host.handles.open('device', { device: 'nul' });
        }
        // A pipe's name opens a client end of an instance that listens.
        if (name !== 0 && host.pipes && isPipeName(text.raw(name)))
        {
            // CreateFile asks the native open for the attributes and a wait
            // on the handle beside what the caller asked, as for any file.
            const client = host.pipes.open(text.raw(name),
                (access | SYNCHRONIZE | FILE_READ_ATTRIBUTES) >>> 0, flags, attributes);
            if ('error' in client)
            {
                return fail(client.error, INVALID_HANDLE_VALUE);
            }
            host.setLastError(ERROR_SUCCESS);
            return client.handle;
        }
        // A mailslot's name opens its client end.
        if (name !== 0 && host.mailslots && isMailslotName(text.raw(name)))
        {
            const client = host.mailslots.open(text.raw(name), access);
            if ('error' in client)
            {
                return fail(client.error, INVALID_HANDLE_VALUE);
            }
            host.setLastError(ERROR_SUCCESS);
            return client.handle;
        }
        const refusal = nameRefusal(text.raw(name), text.path(name),
            disposition !== OPEN_EXISTING && disposition !== TRUNCATE_EXISTING, flags);
        if (refusal !== 0)
        {
            return fail(refusal, INVALID_HANDLE_VALUE);
        }
        // CreateFile asks, beside what it was asked, to wait on the handle and
        // to read the file's attributes, as Windows' does.
        const opened = openPath(text.path(name), { access, share, disposition, flags },
            FILE_IMPLIED);
        if ('error' in opened)
        {
            return fail(opened.error, INVALID_HANDLE_VALUE);
        }
        // A program reads the error after a *successful* CreateFile:
        // ERROR_ALREADY_EXISTS is how the two dispositions that accept
        // either state say which one they found, and clearing it
        // otherwise is what makes that test mean anything.
        const either = disposition === CREATE_ALWAYS || disposition === OPEN_ALWAYS;
        host.setLastError(opened.existed && either ? ERROR_ALREADY_EXISTS : ERROR_SUCCESS);
        // A file created now keeps the descriptor it was given; one opened
        // does not take one.
        if (!opened.existed)
        {
            host.recordFileSecurity?.(text.path(name), securityDescriptorOf(attributes));
        }
        return opened.handle;
    }, INVALID_HANDLE_VALUE);

    /**
     * An object name as the native calls take it -- `\??\C:\dir\file`, or
     * `\??\UNC\server\share\file` -- as the path the volume takes, or the
     * status that says why it is not one. A name relative to a directory
     * handle joins that directory's path; the only directory handles are the
     * native open's own.
     *
     * @param {number} attributes  OBJECT_ATTRIBUTES
     * @returns {{ path: string, status?: undefined } | { status: number, path?: undefined }}
     */
    const nativeName = attributes=>{
        const given = givenName(attributes);
        return given === null ? { status: STATUS_OBJECT_NAME_INVALID }
            : resolveNative(given.root, given.name);
    };

    /**
     * The root directory handle and the name an OBJECT_ATTRIBUTES gives, as
     * written; null for no name at all.
     *
     * @param {number} attributes
     * @returns {{ root: number, name: string } | null}
     */
    const givenName = attributes=>{
        const root = readDword(attributes + 4);
        const string = readDword(attributes + 8);
        if (string === 0)
        {
            return null;
        }
        const descriptor = host.readMemory(string, 8);
        const length = descriptor[0] | (descriptor[1] << 8);
        const buffer = readDword(string + 4);
        const raw = buffer === 0 || length === 0 ? new Uint8Array(0)
            : host.readMemory(buffer, length & ~1);
        let name = '';
        for (let at = 0; at + 1 < raw.length; at += 2)
        {
            name += String.fromCharCode(raw[at] | (raw[at + 1] << 8));
        }
        return { root, name };
    };

    /**
     * A native name, relative to a directory handle or in the object
     * namespace's DOS devices, as the path on a volume it names.
     *
     * @param {number} root  a directory handle, or 0
     * @param {string} name
     * @returns {{ path: string, status?: undefined } | { status: number, path?: undefined }}
     */
    const resolveNative = (root, name)=>{
        // A name holding a character no file name may is refused as a name
        // before any part of it is looked for; so is a namespace prefix
        // with nothing after it.
        const prefix = /^\\(\?\?|DosDevices|GLOBAL\?\?)\\/i.exec(name);
        const names = prefix ? name.slice(prefix[0].length).replace(/^[A-Za-z]:/, '') : name;
        const rooted = root !== 0 || name.startsWith(SEPARATOR);
        const unnamable = [...names].some(character=>character < ' '
            || '"*/:<>?|'.includes(character));
        if ((rooted && unnamable) || (prefix && names === ''))
        {
            return { status: STATUS_OBJECT_NAME_INVALID };
        }
        if (root !== 0)
        {
            // A folder CreateFile opened is a file object of a folder.
            const opened = object(root, 'file');
            const directory = object(root, 'directory') ?? (opened?.directory ? opened : null);
            if (!directory)
            {
                return { status: STATUS_INVALID_HANDLE };
            }
            return name.startsWith(SEPARATOR)
                ? { status: STATUS_INVALID_PARAMETER }
                : { path: fullPath(name === '' ? directory.path
                    : `${directory.path.replace(/\\$/, '')}${SEPARATOR}${name}`) };
        }
        if (!prefix)
        {
            return { status: name.startsWith(SEPARATOR)
                ? STATUS_OBJECT_PATH_NOT_FOUND : STATUS_OBJECT_PATH_SYNTAX_BAD };
        }
        const rest = name.slice(prefix[0].length);
        if (/^UNC\\/i.test(rest))
        {
            return { path: fullPath(`\\\\${rest.slice(4)}`) };
        }
        return /^[A-Za-z]:(\\|$)/.test(rest)
            ? { path: fullPath(rest.length === 2 ? `${rest}\\` : rest) }
            : { status: STATUS_OBJECT_PATH_NOT_FOUND };
    };

    /**
     * What a listed entry is known by, the path its number is made from: a
     * file with several names is known by one of them, any other by its own.
     *
     * @param {string} directory @param {{ name: string, identity?: string }} entry
     */
    const listedIdentity = (directory, entry)=>entry.identity
        ?? `${directory.replace(/\\$/, '')}${SEPARATOR}${entry.name}`;

    /**
     * FILE_OPEN_BY_FILE_ID's name: the eight bytes of a file's number on the
     * volume the root handle is on, as FileInternalInformation and the
     * directory listings answer it. A number is made from what the file is
     * known by, so it is found by walking the volume: the root handle's folder
     * first, where a program that just listed it looks, then the drive. A
     * reparse point is not walked through, so a loop is never followed.
     *
     * @param {{ root: number, name: string }} given
     * @returns {{ path: string, status?: undefined } | { status: number, path?: undefined }}
     */
    const byFileId = ({ root, name })=>{
        const opened = root === 0 ? null : object(root, 'file');
        const directory = root === 0 ? null : object(root, 'directory') ?? opened;
        if (!directory)
        {
            return { status: STATUS_INVALID_HANDLE };
        }
        // An object id (sixteen bytes) names nothing on a volume that keeps none.
        if (name.length !== 4)
        {
            return { status: STATUS_INVALID_PARAMETER };
        }
        const number = (name.charCodeAt(0) | name.charCodeAt(1) << 16) >>> 0;
        const above = (name.charCodeAt(2) | name.charCodeAt(3) << 16) >>> 0;
        const drive = /^[A-Za-z]:/.exec(directory.path)?.[0];
        if (above !== 0 || !drive)
        {
            return { status: STATUS_INVALID_PARAMETER };
        }
        const start = opened && !opened.directory
            ? directory.path.replace(/\\[^\\]*$/, '') : directory.path;
        const seen = new Set();
        /** @param {string} folder @returns {string | null} */
        const walk = folder=>{
            const key = folder.toLowerCase();
            if (seen.has(key))
            {
                return null;
            }
            seen.add(key);
            if (fileIndex(folder) === number)
            {
                return folder;
            }
            const entries = files.list(folder, '*') ?? [];
            for (const entry of entries)
            {
                const identity = listedIdentity(folder, entry);
                if (!entry.isDirectory && fileIndex(identity) === number)
                {
                    return identity;
                }
            }
            for (const entry of entries)
            {
                if (entry.isDirectory && !(/** @type {any} */ (entry).reparseTag))
                {
                    const found = walk(`${folder.replace(/\\$/, '')}${SEPARATOR}${entry.name}`);
                    if (found)
                    {
                        return found;
                    }
                }
            }
            return null;
        };
        const found = walk(start) ?? walk(`${drive}${SEPARATOR}`);
        return found ? { path: fullPath(found) } : { status: STATUS_INVALID_PARAMETER };
    };

    /** @type {Record<number, number>} */
    const NATIVE_FAILURES = {
        [ERROR_FILE_NOT_FOUND]: STATUS_OBJECT_NAME_NOT_FOUND,
        [ERROR_PATH_NOT_FOUND]: STATUS_OBJECT_PATH_NOT_FOUND,
        [ERROR_ACCESS_DENIED]: STATUS_ACCESS_DENIED,
        [ERROR_FILE_EXISTS]: STATUS_OBJECT_NAME_COLLISION,
        [ERROR_ALREADY_EXISTS]: STATUS_OBJECT_NAME_COLLISION,
        [ERROR_INVALID_PARAMETER]: STATUS_INVALID_PARAMETER,
        [ERROR_WRITE_PROTECT]: STATUS_MEDIA_WRITE_PROTECTED,
        [ERROR_INVALID_HANDLE]: STATUS_INVALID_HANDLE,
        [ERROR_SHARING_VIOLATION]: STATUS_SHARING_VIOLATION,
        [ERROR_DIR_NOT_EMPTY]: STATUS_DIRECTORY_NOT_EMPTY,
        [ERROR_INVALID_NAME]: STATUS_OBJECT_NAME_INVALID,
        [ERROR_BAD_LENGTH]: STATUS_INFO_LENGTH_MISMATCH,
        // A pipe none of whose instances listens.
        [ERROR_PIPE_BUSY]: STATUS_PIPE_NOT_AVAILABLE,
        [ERROR_CANT_ACCESS_FILE]: STATUS.IO_REPARSE_TAG_NOT_HANDLED,
        [ERROR_CANT_RESOLVE_FILENAME]: STATUS.REPARSE_POINT_NOT_RESOLVED,
    };

    /**
     * The native dispositions, as CreateFile's; FILE_SUPERSEDE replaces the
     * file as FILE_OVERWRITE_IF does, and differs only in what it reports.
     *
     * @type {Record<number, number>}
     */
    const NATIVE_DISPOSITIONS = {
        [FILE_SUPERSEDE]: CREATE_ALWAYS,
        [FILE_OPEN]: OPEN_EXISTING,
        [FILE_CREATE]: CREATE_NEW,
        [FILE_OPEN_IF]: OPEN_ALWAYS,
        [FILE_OVERWRITE]: TRUNCATE_EXISTING,
        [FILE_OVERWRITE_IF]: CREATE_ALWAYS,
    };

    /**
     * NTSTATUS NtCreateFile(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
     *   PIO_STATUS_BLOCK, PLARGE_INTEGER AllocationSize, ULONG FileAttributes,
     *   ULONG ShareAccess, ULONG CreateDisposition, ULONG CreateOptions,
     *   PVOID EaBuffer, ULONG EaLength)
     *
     * The same open as CreateFile's, reached by the native name and answered
     * with a status. What the native call adds is its options: a directory
     * may be asked for or ruled out, and a file asked to delete itself when
     * its handle closes must have been opened for DELETE -- a read-only file
     * refuses that with STATUS_CANNOT_DELETE, after any refusal of the write
     * access it was also asked for.
     *
     * @param {number[]} args
     */
    const ntCreateFile = ([out, access, attributes, status, , givenAttributes, share,
        disposition, options])=>{
        // The I/O manager checks the options before it looks at the name:
        // synchronous I/O waits on the file object, so it needs SYNCHRONIZE
        // asked in so many words, and a directory is only opened or made.
        const synchronous = ((options >>> 0)
            & (FILE_SYNCHRONOUS_IO_ALERT | FILE_SYNCHRONOUS_IO_NONALERT)) !== 0;
        if ((synchronous && ((access >>> 0) & SYNCHRONIZE) === 0)
            || (((options >>> 0) & FILE_DIRECTORY_FILE) !== 0
                && ![FILE_CREATE, FILE_OPEN, FILE_OPEN_IF].includes(disposition >>> 0)))
        {
            return STATUS_INVALID_PARAMETER;
        }
        // What the pipe device answers - itself, a pipe's name, a server's
        // own instance - opens there, with the rights asked and no more.
        const given = givenName(attributes >>> 0);
        const client = given && host.pipes
            ? host.pipes.nativeOpen(given, access >>> 0, options >>> 0, disposition >>> 0) : null;
        if (client)
        {
            if ('status' in client)
            {
                return client.status;
            }
            if ('error' in client)
            {
                return NATIVE_FAILURES[client.error] ?? STATUS_UNSUCCESSFUL;
            }
            writeDword(out >>> 0, client.handle);
            if ((status >>> 0) !== 0)
            {
                writeDword(status >>> 0, STATUS_SUCCESS);
                writeDword((status >>> 0) + 4, FILE_OPENED);
            }
            return STATUS_SUCCESS;
        }
        const named = ((options >>> 0) & FILE_OPEN_BY_FILE_ID) !== 0 && given
            ? byFileId(given) : nativeName(attributes >>> 0);
        if ('status' in named)
        {
            return named.status;
        }
        const path = named.path;
        const wanted = options >>> 0;
        const directoryOnly = (wanted & FILE_DIRECTORY_FILE) !== 0;
        const fileOnly = (wanted & FILE_NON_DIRECTORY_FILE) !== 0;
        const deleteOnClose = (wanted & FILE_DELETE_ON_CLOSE) !== 0;
        const creation = NATIVE_DISPOSITIONS[disposition >>> 0];
        if (creation === undefined || (directoryOnly && fileOnly)
            || (deleteOnClose && ((access >>> 0) & DELETE) === 0))
        {
            return STATUS_INVALID_PARAMETER;
        }
        /** @param {number} handle @param {number} information */
        const opened = (handle, information)=>{
            writeDword(out >>> 0, handle);
            if ((status >>> 0) !== 0)
            {
                writeDword(status >>> 0, STATUS_SUCCESS);
                writeDword((status >>> 0) + 4, information);
            }
            return STATUS_SUCCESS;
        };

        const found = files.stat(path);
        const literal = (wanted & FILE_OPEN_REPARSE_POINT) !== 0;
        // A reparse point reopened through its own handle by an empty name
        // has nothing left to reparse: Windows calls its data invalid.
        if (found?.reparseTag && !literal && given?.root && given.name === '')
        {
            return STATUS.IO_REPARSE_DATA_INVALID;
        }
        const landed = found?.reparseTag && !literal ? throughReparse(path, found) : { path };
        if (landed.error !== undefined)
        {
            return NATIVE_FAILURES[landed.error] ?? STATUS_UNSUCCESSFUL;
        }
        const existing = landed.path === path ? found : files.stat(landed.path);
        if (existing?.exists && existing.isDirectory)
        {
            if (fileOnly)
            {
                return STATUS_FILE_IS_A_DIRECTORY;
            }
            if (creation === CREATE_NEW)
            {
                return STATUS_OBJECT_NAME_COLLISION;
            }
            // A directory is not replaced or emptied as a file is.
            if (creation === CREATE_ALWAYS || creation === TRUNCATE_EXISTING)
            {
                return STATUS_ACCESS_DENIED;
            }
            return opened(host.handles.open('directory',
                { path, ...deleteOnClose ? { deleteOnClose } : {} }), FILE_OPENED);
        }
        if (directoryOnly)
        {
            if (existing?.exists)
            {
                return STATUS_NOT_A_DIRECTORY;
            }
            if (creation !== CREATE_NEW && creation !== OPEN_ALWAYS)
            {
                return STATUS_OBJECT_NAME_NOT_FOUND;
            }
            if (wildcardName(path))
            {
                return STATUS_OBJECT_NAME_INVALID;
            }
            if (!files.mkdir(landed.path))
            {
                return onReadOnlyMedia(path)
                    ? STATUS_MEDIA_WRITE_PROTECTED : STATUS_OBJECT_PATH_NOT_FOUND;
            }
            return opened(host.handles.open('directory', { path: landed.path }), FILE_CREATED);
        }

        // The reparse points on the way are behind it: the file is opened as it is.
        const result = openPath(landed.path, {
            access, share, disposition: creation,
            flags: (givenAttributes >>> 0) | (deleteOnClose ? FILE_FLAG_DELETE_ON_CLOSE : 0)
                | FILE_FLAG_OPEN_REPARSE_POINT,
            mode: wanted & FILE_MODE_OPTIONS,
        });
        if ('error' in result)
        {
            return result.cannotDelete
                ? STATUS_CANNOT_DELETE
                : result.deletePending ? STATUS_DELETE_PENDING
                    : NATIVE_FAILURES[result.error] ?? STATUS_UNSUCCESSFUL;
        }
        const replaced = disposition === FILE_SUPERSEDE ? FILE_SUPERSEDED : FILE_OVERWRITTEN;
        return opened(result.handle, !result.existed ? FILE_CREATED
            : creation === CREATE_ALWAYS || creation === TRUNCATE_EXISTING
                ? replaced : FILE_OPENED);
    };

    /**
     * The files whose deletion is pending, by path folded to one case: set
     * through FileDispositionInformation on any handle, they open no more
     * (STATUS_DELETE_PENDING) and go when the last handle onto them closes.
     *
     * Each is kept with the path it goes by: a section made from the file
     * may hold it open past its last handle, and closing that deletes it.
     *
     * @type {Map<string, string>}
     */
    const deletePending = new Map();

    /**
     * The byte ranges locked in each file, by the file's name folded to one
     * case: a lock belongs to the file and is seen through every handle onto
     * it, while who holds it is the handle that took it.
     *
     * @type {Map<string, { handle: number, start: bigint, length: bigint,
     *     exclusive: boolean }[]>}
     */
    const locks = new Map();
    const QWORD_END = 1n << 64n;

    /** A 64-bit quantity from its two halves. @param {number} lowPart @param {number} highPart */
    const qword = (lowPart, highPart)=>(BigInt(highPart >>> 0) << 32n) | BigInt(lowPart >>> 0);

    /**
     * Whether a lock asked for over `start` and `length` collides with one
     * held. A lock of no bytes asked for is taken whatever is held; one held
     * is a point that a range covering it collides with.
     *
     * @param {bigint} start @param {bigint} length @param {bigint} otherStart
     * @param {bigint} otherLength
     */
    const overlaps = (start, length, otherStart, otherLength)=>{
        if (length === 0n)
        {
            return false;
        }
        if (otherLength === 0n)
        {
            return start <= otherStart && otherStart < start + length;
        }
        return start < otherStart + otherLength && otherStart < start + length;
    };

    /**
     * Takes a lock, or says why not. An exclusive lock collides with every
     * lock it overlaps, the taker's own included; a shared one only with
     * another handle's exclusive lock. A range running past the end of a
     * 64-bit offset is not one.
     *
     * @param {number} handle @param {bigint} start @param {bigint} length
     * @param {boolean} exclusive
     * @returns {number} a Win32 error, ERROR_SUCCESS when taken
     */
    const lockRange = (handle, start, length, exclusive)=>{
        const file = object(handle, 'file');
        if (!file)
        {
            return ERROR_INVALID_HANDLE;
        }
        if (start + length > QWORD_END)
        {
            return ERROR_INVALID_PARAMETER;
        }
        const key = file.path.toLowerCase();
        const held = locks.get(key) ?? [];
        const collides = held.some(lock=>overlaps(start, length, lock.start, lock.length)
            && (exclusive || (lock.exclusive && lock.handle !== handle)));
        if (collides)
        {
            return ERROR_LOCK_VIOLATION;
        }
        held.push({ handle, start, length, exclusive });
        locks.set(key, held);
        return ERROR_SUCCESS;
    };

    /**
     * Gives back a lock the handle holds over exactly this range; an
     * exclusive one goes before a shared one over the same bytes.
     *
     * @param {number} handle @param {bigint} start @param {bigint} length
     * @returns {number} a Win32 error, ERROR_SUCCESS when given back
     */
    const unlockRange = (handle, start, length)=>{
        const file = object(handle, 'file');
        if (!file)
        {
            return ERROR_INVALID_HANDLE;
        }
        const held = locks.get(file.path.toLowerCase()) ?? [];
        const same = (/** @type {{ handle: number, start: bigint, length: bigint }} */ lock)=>
            lock.handle === handle && lock.start === start && lock.length === length;
        let at = held.findIndex(lock=>same(lock) && lock.exclusive);
        if (at < 0)
        {
            at = held.findIndex(same);
        }
        if (at < 0)
        {
            return ERROR_NOT_LOCKED;
        }
        held.splice(at, 1);
        return ERROR_SUCCESS;
    };

    /**
     * Closes a handle of any kind, and whatever it held here with it: the
     * volume's node, its locks, a file it was to delete.
     *
     * @param {number} handle
     * @returns {boolean} whether it was a handle
     */
    const release = handle=>{
        try
        {
            // A file handle and a mapping over the file each hold
            // the node, and closing either gives back its own hold:
            // the node closes with the last of them, in whichever
            // order the program closes them.
            const type = host.handles.typeOf?.(handle);
            const closed = host.handles.close(handle);
            if (closed && closed.node
                && (type === undefined || type === 'file' || type === 'mapping'))
            {
                files.close(closed.node);
            }
            if (type === 'file' && closed?.path)
            {
                const key = closed.path.toLowerCase();
                const kept = (locks.get(key) ?? []).filter(lock=>lock.handle !== handle);
                if (kept.length === 0)
                {
                    locks.delete(key);
                }
                else
                {
                    locks.set(key, kept);
                }
            }
            // With the last handle to the file, not with a duplicate of it.
            // POSIX semantics: the name goes with the handle that asked.
            if (closed?.posixDelete && closed.path !== undefined && !host.handles.holds?.(closed))
            {
                files.remove(closed.path);
            }
            // A handle that deletes on close leaves the file pending while
            // other opens of it remain - a handle, or a section made from it -
            // and the last of them deletes it.
            if (closed?.deleteOnClose && closed.path !== undefined
                && !host.handles.holds?.(closed))
            {
                deletePending.set(String(closed.path).toLowerCase(), String(closed.path));
            }
            const own = String(closed?.path ?? '').toLowerCase();
            if (closed && (closed.node || deletePending.has(own)) && !host.handles.holds?.(closed))
            {
                for (const [key, path] of [...deletePending])
                {
                    // A directory's open is its handle alone.
                    if (!(files.isOpen?.(path) ?? false) || (!closed.node && own === key))
                    {
                        files.remove(path);
                        deletePending.delete(key);
                    }
                }
            }
            // A no-op on anything that was never named.
            host.namedObjects?.forget(closed);
            // A pipe end goes with its last handle, in whichever process. Its
            // operations still pending end cancelled first, and each still
            // reaches the port the handle was bound to, as on Windows.
            if (type === 'pipe')
            {
                host.pipes?.closed(handle, closed);
            }
            if (type === 'debug-object')
            {
                host.debugObjects?.closed(closed);
            }
            if (type === 'job')
            {
                host.jobs?.closed(closed);
            }
            // Handle numbers are recycled, so anything keyed by this one
            // has to go now: a completion-port association that outlives
            // its handle sends the next file's packets to a port nobody
            // is reading, and a thread parked on a port that has just
            // closed waits on something nothing can reach.
            host.ports?.closed(handle, closed);
            return true;
        }
        catch (e){
            void e;
            return false;
        }
    };

    /**
     * The status block every native file call writes, success or not.
     *
     * @param {number} block @param {number} status @param {number} information
     */
    const report = (block, status, information)=>{
        if (block !== 0)
        {
            writeDword(block, status);
            writeDword(block + 4, information);
        }
        return status;
    };

    /**
     * A set's answer: an error is refused before the request completes, and
     * the status block is left as it was (the conformance tests find it
     * untouched); success and a warning are written as `report` writes them.
     *
     * @param {number} block @param {number} status @param {number} information
     */
    const settled = (block, status, information)=>((status >>> 30) === 3 ? status
        : report(block, status, information));

    /**
     * The rights a file object's handle was granted, as FileAccessInformation
     * answers them: every right (FILE_ALL_ACCESS) for a handle granted all.
     *
     * @param {number} handle
     */
    const rightsOf = handle=>(host.handles.access?.(handle >>> 0) ?? FILE_ALL_ACCESS) >>> 0;

    /** @param {number} value */
    const dwordOf = value=>new Uint8Array(new Uint32Array([value >>> 0]).buffer);

    /**
     * What kind of object a handle names, the current process's and thread's
     * pseudo-handles included: a file call given one of those is refused as
     * the wrong type of object, not as no handle at all.
     *
     * @param {number} handle
     * @returns {string | null}
     */
    const heldKind = handle=>((handle >>> 0) >= CURRENT_THREAD_HANDLE ? 'process'
        : host.handles.typeOf?.(handle >>> 0) ?? null);

    /**
     * One FILE_INFORMATION_CLASS record of an open file, as NtQueryInformationFile
     * lays it out; null for a class this keeps nothing for. The volume keeps
     * one time per file, the last write, and every time answers with it, as
     * GetFileTime's do.
     *
     * @param {any} file @param {number} kind
     * @param {number} [handle]  the handle asked through: FileAccessInformation is its rights
     * @returns {Uint8Array | null}
     */
    const informationOf = (file, kind, handle = 0)=>{
        const entry = files.stat(file.path);
        const size = file.directory ? 0n : BigInt(entry?.size ?? 0);
        // Whole clusters, as FileStandardInfo by handle counts them.
        const allocated = (size + 4095n) & ~4095n;
        const attributes = fileAttributes(entry ?? { isDirectory: file.directory === true });
        const time = msToFileTime(entry?.modified ?? 0);
        /** @param {number} length @param {(view: DataView) => void} fill */
        const record = (length, fill)=>{
            const bytes = new Uint8Array(length);
            fill(new DataView(bytes.buffer));
            return bytes;
        };
        /** @param {DataView} view @param {number} at */
        const times = (view, at)=>{
            for (let field = 0; field < 4; field++)
            {
                view.setBigUint64(at + field * 8, time, true);
            }
        };
        const name = String(file.path).replace(/^[A-Za-z]:/, '');
        const mode = modeOf(file);
        const access = handle !== 0 ? rightsOf(handle)
            : (file.read ? FILE_GENERIC_READ : 0) | (file.write ? FILE_GENERIC_WRITE : 0);
        // A file's number on its volume, GetFileInformationByHandle's: the
        // same for the same file under any of its names, which is what
        // comparing two handles asks.
        const index = fileIndex(entry?.identity ?? file.path);
        switch (kind)
        {
            case FILE_BASIC_INFORMATION:
                // Four times, the attributes, and the padding to eight.
                return record(40, view=>{
                    times(view, 0);
                    view.setUint32(32, attributes, true);
                });
            case FILE_STANDARD_INFORMATION:
                // AllocationSize, EndOfFile, NumberOfLinks, DeletePending, Directory.
                return record(24, view=>{
                    view.setBigUint64(0, allocated, true);
                    view.setBigUint64(8, size, true);
                    view.setUint32(16, entry?.links ?? 1, true);
                    view.setUint8(20, file.deleteOnClose
                        || deletePending.has(String(file.path).toLowerCase()) ? 1 : 0);
                    view.setUint8(21, file.directory ? 1 : 0);
                });
            case FILE_INTERNAL_INFORMATION:
                return record(8, view=>view.setBigUint64(0, BigInt(index), true));
            case FILE_EA_INFORMATION:
                return new Uint8Array(4);
            case FILE_ACCESS_INFORMATION:
                return record(4, view=>view.setUint32(0, access, true));
            case FILE_NAME_INFORMATION:
                // The path from the volume's root, without its drive.
                return record(4 + name.length * 2, view=>{
                    view.setUint32(0, name.length * 2, true);
                    [...name].forEach((unit, at)=>view.setUint16(4 + at * 2,
                        unit.charCodeAt(0), true));
                });
            case FILE_POSITION_INFORMATION:
                return record(8, view=>view.setBigUint64(0, BigInt(file.position), true));
            case FILE_MODE_INFORMATION:
                return record(4, view=>view.setUint32(0, mode, true));
            case FILE_ALIGNMENT_INFORMATION:
                return new Uint8Array(4);
            case FILE_ALL_INFORMATION: {
                // Basic, Standard, Internal, Ea, Access, Position, Mode,
                // Alignment, then the name.
                const parts = [FILE_BASIC_INFORMATION, FILE_STANDARD_INFORMATION,
                    FILE_INTERNAL_INFORMATION, FILE_EA_INFORMATION, FILE_ACCESS_INFORMATION,
                    FILE_POSITION_INFORMATION, FILE_MODE_INFORMATION, FILE_ALIGNMENT_INFORMATION,
                    FILE_NAME_INFORMATION].map(part=>/** @type {Uint8Array} */ (
                    informationOf(file, part, handle)));
                const all = new Uint8Array(parts.reduce((sum, part)=>sum + part.length, 0));
                parts.reduce((at, part)=>{
                    all.set(part, at);
                    return at + part.length;
                }, 0);
                return all;
            }
            case FILE_NETWORK_OPEN_INFORMATION:
                // Four times, AllocationSize, EndOfFile, the attributes, padding.
                return record(56, view=>{
                    times(view, 0);
                    view.setBigUint64(32, allocated, true);
                    view.setBigUint64(40, size, true);
                    view.setUint32(48, attributes, true);
                });
            case FILE_ATTRIBUTE_TAG_INFORMATION:
                // The attributes, and the tag of the reparse point it is.
                return record(8, view=>{
                    view.setUint32(0, attributes, true);
                    view.setUint32(4, entry?.reparseTag ?? 0, true);
                });
            default:
                return null;
        }
    };

    /**
     * Each open directory's change watch, set by its first ReadDirectoryChangesW
     * and kept with that call's filter, subtree and buffer length -- later
     * calls' own are not looked at, as Windows keeps the first. Changes come
     * whether or not a call is waiting and are kept until one takes them;
     * more than the first buffer held are lost, and the next call is told
     * so (STATUS_NOTIFY_ENUM_DIR, nothing written).
     *
     * @type {WeakMap<object, { watch: { close: () => void }, room: number,
     *     records: import('./vfs.js').ChangeRecord[], overflowed: boolean,
     *     waiting: ((records: import('./vfs.js').ChangeRecord[] | null) => void)[] }>}
     */
    const directoryWatches = new WeakMap();

    /**
     * What a watch has kept, handed over and forgotten: its records, or null
     * when there were more than it could hold.
     *
     * @param {{ records: import('./vfs.js').ChangeRecord[], overflowed: boolean }} kept
     */
    const taken = kept=>{
        const records = kept.overflowed ? null : kept.records;
        kept.records = [];
        kept.overflowed = false;
        return records;
    };

    /**
     * Changes as FILE_NOTIFY_INFORMATION records, each on a four-byte boundary
     * chained by NextEntryOffset, the last's zero and unpadded.
     *
     * @param {import('./vfs.js').ChangeRecord[]} records
     */
    const notifyRecords = records=>{
        /** @type {number[]} */
        const starts = [];
        let end = 0;
        for (const record of records)
        {
            const start = (end + 3) & ~3;
            starts.push(start);
            end = start + 12 + record.name.length * 2;
        }
        const bytes = new Uint8Array(end);
        const view = new DataView(bytes.buffer);
        records.forEach((record, index)=>{
            const at = starts[index];
            view.setUint32(at, index + 1 < records.length ? starts[index + 1] - at : 0, true);
            view.setUint32(at + 4, record.action, true);
            view.setUint32(at + 8, record.name.length * 2, true);
            [...record.name].forEach((unit, offset)=>view.setUint16(at + 12 + offset * 2,
                unit.charCodeAt(0), true));
        });
        return bytes;
    };

    /**
     * BOOL ReadDirectoryChangesW(HANDLE hDirectory, LPVOID lpBuffer,
     *     DWORD nBufferLength, BOOL bWatchSubtree, DWORD dwNotifyFilter,
     *     LPDWORD lpBytesReturned, LPOVERLAPPED lpOverlapped,
     *     LPOVERLAPPED_COMPLETION_ROUTINE lpCompletionRoutine)
     *
     * Changes kept since the last call answer at once; otherwise a
     * synchronous call waits for the next, and an overlapped one returns
     * pending (Internal STATUS_PENDING, its event cleared) and completes
     * as overlapped reads do: the event and the port, or the routine queued
     * to the calling thread with the event left alone.
     */
    const readDirectoryChanges = {
        argBytes: 32,
        /** @param {number[]} args */
        handler: ([handle, buffer, length, subtree, filter, returned, overlapped, routine])=>{
            const asked = filter >>> 0;
            if (asked === 0 || (asked & ~FILE_NOTIFY_CHANGE_ALL) !== 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const directory = object(handle, 'file') ?? object(handle, 'directory');
            if (!directory)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            if (!directory.directory && host.handles.typeOf?.(handle >>> 0) !== 'directory')
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            if (!files.watch)
            {
                host.divergence?.('ReadDirectoryChangesW', 'the volume tells no changes');
                return fail(ERROR_INVALID_FUNCTION);
            }
            let state = directoryWatches.get(directory);
            if (!state)
            {
                const kept = { watch: { close: ()=>{} }, room: length >>> 0,
                    records: /** @type {import('./vfs.js').ChangeRecord[]} */ ([]),
                    overflowed: false,
                    waiting: /** @type {((records: any) => void)[]} */ ([]) };
                kept.watch = files.watch(directory.path, (subtree >>> 0) !== 0, asked, records=>{
                    if (records.length === 0)
                    {
                        return;
                    }
                    kept.records.push(...records);
                    if (notifyRecords(kept.records).length > kept.room)
                    {
                        kept.records = [];
                        kept.overflowed = true;
                    }
                    kept.waiting.shift()?.(taken(kept));
                }, ()=>host.handles.holds?.(directory) ?? true);
                directoryWatches.set(directory, kept);
                state = kept;
            }
            const watched = state;
            const pointer = overlapped >>> 0;
            const thread = host.currentThread?.() ?? null;
            /**
             * Writes what a call is given and says how it ended.
             *
             * @param {import('./vfs.js').ChangeRecord[] | null} records
             */
            const give = records=>{
                const bytes = records === null ? null : notifyRecords(records);
                const fits = bytes !== null && bytes.length <= (length >>> 0)
                    && (buffer >>> 0) !== 0;
                if (fits)
                {
                    host.writeMemory(buffer >>> 0, bytes);
                }
                const count = fits ? bytes.length : 0;
                const status = fits ? 0 : STATUS_NOTIFY_ENUM_DIR;
                if (pointer === 0)
                {
                    writeDwordIf(returned >>> 0, count);
                    return 1;
                }
                if ((routine >>> 0) !== 0)
                {
                    overlappedResult(writeDword, layout, pointer, status, count);
                    host.queueApc?.(thread, routine >>> 0,
                        [status === 0 ? ERROR_SUCCESS : ERROR_NOTIFY_ENUM_DIR, count, pointer]);
                    return 1;
                }
                host.ports?.completed(handle >>> 0, count, pointer);
                overlappedResult(writeDword, layout, pointer, status, count);
                return 1;
            };
            if (watched.records.length > 0 || watched.overflowed)
            {
                return give(taken(watched));
            }
            if (pointer === 0)
            {
                return new Promise(resolve=>{
                    watched.waiting.push(records=>resolve(give(records)));
                });
            }
            overlappedResult(writeDword, layout, pointer, STATUS_PENDING);
            if ((routine >>> 0) === 0)
            {
                const event = (readDword(pointer + layout.event) & ~1) >>> 0;
                if (event !== 0)
                {
                    host.resetEvent?.(event);
                }
            }
            watched.waiting.push(give);
            return 1;
        },
    };

    /**
     * A control code sent to an open handle: the mount manager answers its
     * own; a file or directory on the volume is no driver's, and answers
     * none; anything else is no file object.
     *
     * @param {number} handle @param {number} code
     * @param {number} input @param {number} inLength @param {number} output
     * @param {number} outLength
     * @returns {{ status: number, information: number }}
     */
    const deviceControl = (handle, code, input, inLength, output, outLength)=>{
        if (object(handle, 'device')?.device === 'mountmgr')
        {
            const answer = mountManagerControl(mountPointsOf(host), code,
                input >>> 0 === 0 ? null : host.readMemory(input >>> 0, inLength >>> 0),
                output >>> 0 === 0 ? 0 : outLength >>> 0);
            if (answer.output)
            {
                host.writeMemory(output >>> 0, answer.output);
            }
            return answer;
        }
        if (object(handle, 'file') || object(handle, 'directory'))
        {
            host.divergence?.('NtDeviceIoControlFile',
                `control code 0x${(code >>> 0).toString(16)} sent to a file`);
            return { status: STATUS_INVALID_DEVICE_REQUEST, information: 0 };
        }
        return { status: host.handles.typeOf?.(handle >>> 0) === undefined
            ? STATUS_INVALID_HANDLE : STATUS_OBJECT_TYPE_MISMATCH, information: 0 };
    };

    /**
     * The native calls over this table's opens, which ntdll publishes.
     */
    /**
     * NtReadFile and NtWriteFile: the transfer finishes before the call
     * answers, as ReadFile's does. The IO_STATUS_BLOCK is written when it
     * happens and left alone when the call is refused; the event is
     * signalled and the APC queued once it is done. A ByteOffset says where,
     * unless it is FILE_USE_FILE_POINTER_POSITION, or for a write
     * FILE_WRITE_TO_END_OF_FILE.
     *
     * @param {boolean} writing
     */
    const ntTransfer = writing=>({
        argBytes: 36,
        /** @param {number[]} args */
        handler: ([handle, event, apc, context, block, buffer, length, offset])=>{
            const status = (/** @type {number} */ answer)=>{
                // Done, with its data or a warning (part of a message), or at
                // the end of the file: the event and the APC say so.
                if (answer !== STATUS_PENDING && ((answer >>> 30) !== 3
                    || answer === STATUS_END_OF_FILE))
                {
                    if ((event >>> 0) !== 0)
                    {
                        host.setEvent?.(event >>> 0);
                    }
                    if ((apc >>> 0) !== 0)
                    {
                        host.queueApc?.(host.currentThread?.() ?? null, apc >>> 0,
                            [context >>> 0, block >>> 0, 0]);
                    }
                }
                return answer;
            };
            // A file bound to a completion port completes there: a request
            // that also asks for an APC is refused before anything is done.
            if ((apc >>> 0) !== 0 && host.ports?.bound?.(handle >>> 0))
            {
                return STATUS_INVALID_PARAMETER;
            }
            // A request on a pipe end clears its event as it is made, whatever
            // then becomes of it: what the event says afterwards is this
            // request's (a read refused as the pipe broken leaves it clear).
            if ((event >>> 0) !== 0 && heldKind(handle) === 'pipe')
            {
                host.resetEvent?.(event >>> 0);
            }
            for (const stream of streams)
            {
                // A handle opened for overlapped I/O does not wait: the stream
                // finishes the call through these, as Windows does.
                const io = { event: event >>> 0, apc: apc >>> 0, context: context >>> 0 };
                const answer = writing
                    ? stream.write(handle, buffer, length, block, true, 0, 0, io)
                    : stream.read(handle, buffer, length, block, true, 0, io);
                if (answer === STATUS_PENDING && (event >>> 0) !== 0)
                {
                    host.resetEvent?.(event >>> 0);
                }
                if (answer !== null)
                {
                    return typeof answer === 'number' ? status(answer) : answer;
                }
            }
            const file = object(handle, 'file');
            if (!file || file.directory)
            {
                // A directory is a file object with no bytes: the file system
                // has no read or write for it.
                return file || object(handle, 'directory') ? STATUS_INVALID_DEVICE_REQUEST
                    : STATUS_INVALID_HANDLE;
            }
            if (writing ? !writes(handle, file) : !reads(handle, file))
            {
                return STATUS_ACCESS_DENIED;
            }
            // The kernel probes the buffer before the transfer: none for a
            // count is refused whether or not anything would have moved (a
            // read at the end of the file included), the status block and the
            // event untouched - a read as the access violation it is, a write
            // as STATUS_INVALID_USER_BUFFER, the answer the conformance tests
            // find for a write from nowhere.
            if ((buffer >>> 0) === 0 && (length >>> 0) !== 0)
            {
                return writing ? STATUS_INVALID_USER_BUFFER : STATUS_ACCESS_VIOLATION;
            }
            // A handle opened for asynchronous I/O has no file pointer: each
            // request says where, and the pointer it does not have stays put.
            const asynchronous = (modeOf(file) & SYNCHRONOUS_MODES) === 0;
            if (asynchronous && (offset >>> 0) === 0)
            {
                return STATUS_INVALID_PARAMETER;
            }
            let at = file.position;
            if ((offset >>> 0) !== 0)
            {
                const lower = readDword(offset >>> 0);
                const upper = readDword((offset >>> 0) + 4);
                if ((upper & 0x80000000) === 0)
                {
                    at = upper * 0x100000000 + lower;
                }
                else if (writing && upper === 0xffffffff && lower === FILE_WRITE_TO_END_OF_FILE)
                {
                    at = sizeOf(file);
                }
                else if (asynchronous || upper !== 0xffffffff
                    || lower !== FILE_USE_FILE_POINTER_POSITION)
                {
                    // A negative offset is none of the two the call names
                    // (the end, the file pointer): refused before anything
                    // is done, the status block untouched.
                    return STATUS_INVALID_PARAMETER;
                }
            }
            /** @param {number} done @param {number} code */
            const finish = (done, code)=>{
                if (!asynchronous)
                {
                    file.position = at + done;
                }
                writeDword(block >>> 0, code);
                writeDword((block >>> 0) + 4, done);
                return status(code);
            };
            const count = length >>> 0;
            if (writing)
            {
                const bytes = count === 0
                    ? new Uint8Array(0) : host.readMemory(buffer >>> 0, count).slice();
                const stored = (files.writeOrFetch ?? files.write)
                    .call(files, file.node, at, bytes);
                return typeof stored === 'number'
                    ? finish(stored, STATUS_SUCCESS)
                    : /** @type {any} */ (stored).then(
                        (/** @type {number} */ done)=>finish(done, STATUS_SUCCESS),
                        ()=>STATUS_IO_DEVICE_ERROR);
            }
            /** @param {Uint8Array} bytes */
            const delivered = bytes=>{
                if (bytes.length > 0)
                {
                    host.writeMemory(buffer >>> 0, bytes);
                }
                // Nothing left to read is an answer of its own here, where
                // ReadFile answers TRUE with nothing read.
                return finish(bytes.length,
                    bytes.length === 0 && count > 0 ? STATUS_END_OF_FILE : STATUS_SUCCESS);
            };
            const bytes = files.read(file.node, at, count);
            return typeof (/** @type {any} */ (bytes))?.then !== 'function'
                ? delivered(/** @type {any} */ (bytes))
                : /** @type {any} */ (bytes).then(delivered, ()=>STATUS_IO_DEVICE_ERROR);
        },
    });

    const natives = {
        /**
         * NTSTATUS NtReadFile(HANDLE, HANDLE Event, PIO_APC_ROUTINE, PVOID ApcContext,
         *   PIO_STATUS_BLOCK, PVOID Buffer, ULONG Length, PLARGE_INTEGER ByteOffset,
         *   PULONG Key)
         */
        NtReadFile: ntTransfer(false),
        /**
         * NTSTATUS NtWriteFile(HANDLE, HANDLE Event, PIO_APC_ROUTINE, PVOID ApcContext,
         *   PIO_STATUS_BLOCK, const void *Buffer, ULONG Length, PLARGE_INTEGER ByteOffset,
         *   PULONG Key)
         */
        NtWriteFile: ntTransfer(true),
        /**
         * NTSTATUS NtLockFile(HANDLE, HANDLE Event, PIO_APC_ROUTINE, PVOID ApcContext,
         *   PIO_STATUS_BLOCK, PLARGE_INTEGER ByteOffset, PLARGE_INTEGER Length,
         *   ULONG Key, BOOLEAN FailImmediately, BOOLEAN ExclusiveLock)
         *
         * LockFileEx's lock; one that would wait is not granted, as there.
         */
        NtLockFile: {
            argBytes: 40,
            /** @param {number[]} args */
            handler: ([handle, , , , block, offset, length, , , exclusive])=>{
                if ((block >>> 0) === 0 || (offset >>> 0) === 0 || (length >>> 0) === 0)
                {
                    return STATUS_ACCESS_VIOLATION;
                }
                const answer = lockRange(handle >>> 0,
                    qword(readDword(offset >>> 0), readDword((offset >>> 0) + 4)),
                    qword(readDword(length >>> 0), readDword((length >>> 0) + 4)),
                    (exclusive & 0xff) !== 0);
                return report(block >>> 0, answer === ERROR_SUCCESS ? STATUS_SUCCESS
                    : answer === ERROR_LOCK_VIOLATION ? STATUS_LOCK_NOT_GRANTED
                        : answer === ERROR_INVALID_HANDLE ? STATUS_INVALID_HANDLE
                            : STATUS_INVALID_PARAMETER, 0);
            },
        },

        /**
         * NTSTATUS NtUnlockFile(HANDLE, PIO_STATUS_BLOCK, PLARGE_INTEGER ByteOffset,
         *                       PLARGE_INTEGER Length, ULONG Key)
         *
         * The status block is written whatever the answer, and a NULL one is
         * the access violation writing it would be.
         */
        NtUnlockFile: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, block, offset, length])=>{
                if ((block >>> 0) === 0 || (offset >>> 0) === 0 || (length >>> 0) === 0)
                {
                    return STATUS_ACCESS_VIOLATION;
                }
                const answer = unlockRange(handle >>> 0,
                    qword(readDword(offset >>> 0), readDword((offset >>> 0) + 4)),
                    qword(readDword(length >>> 0), readDword((length >>> 0) + 4)));
                return report(block >>> 0, answer === ERROR_SUCCESS ? STATUS_SUCCESS
                    : answer === ERROR_INVALID_HANDLE ? STATUS_INVALID_HANDLE
                        : STATUS_RANGE_NOT_LOCKED, 0);
            },
        },

        NtCreateFile: { argBytes: 44, handler: ntCreateFile },

        /**
         * NTSTATUS NtCancelIoFile(HANDLE, PIO_STATUS_BLOCK)
         *
         * What the calling thread waits for on the handle ends cancelled - a
         * pipe's reads, writes and connects; a file's I/O has finished by the
         * time its call answers. Success, written in the block, whether or
         * not there was any; a handle that is no file object is refused.
         */
        NtCancelIoFile: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, block])=>{
                if (host.pipes?.cancel(handle, { thread: host.currentThread?.() }) == null
                    && !FILE_OBJECTS.has(host.handles.typeOf?.(handle >>> 0) ?? ''))
                {
                    return STATUS_INVALID_HANDLE;
                }
                return report(block >>> 0, STATUS_SUCCESS, 0);
            },
        },

        /**
         * NTSTATUS NtCancelIoFileEx(HANDLE, PIO_STATUS_BLOCK IoRequestToCancel,
         *   PIO_STATUS_BLOCK)
         *
         * The one request whose IO_STATUS_BLOCK is named, or every one on the
         * handle of any thread: STATUS_NOT_FOUND, written in the block, when
         * there was none (CancelIoEx's ERROR_NOT_FOUND).
         */
        NtCancelIoFileEx: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, request, block])=>{
                const count = host.pipes?.cancel(handle,
                    (request >>> 0) === 0 ? {} : { block: request >>> 0 });
                if (count == null && !FILE_OBJECTS.has(host.handles.typeOf?.(handle >>> 0) ?? ''))
                {
                    return STATUS_INVALID_HANDLE;
                }
                return report(block >>> 0, (count ?? 0) > 0 ? STATUS_SUCCESS : STATUS_NOT_FOUND, 0);
            },
        },

        /**
         * NTSTATUS NtFsControlFile(HANDLE, HANDLE Event, PIO_APC_ROUTINE, PVOID,
         *   PIO_STATUS_BLOCK, ULONG FsControlCode, PVOID, ULONG, PVOID, ULONG)
         *
         * A pipe end answers its own (`pipes.control`: FSCTL_PIPE_PEEK). The
         * volume answers no file-system control: reparse points, compression
         * and the rest are the requests of a volume it is not.
         */
        NtFsControlFile: {
            argBytes: 40,
            /** @param {number[]} args */
            handler: ([handle, event, apc, context, block, code, input, inLength, output, room])=>{
                // The request's event is cleared as it is made, whether it
                // then finishes, waits or is refused.
                if ((event >>> 0) !== 0 && host.pipes?.isPipe(handle))
                {
                    host.resetEvent?.(event >>> 0);
                }
                const piped = host.pipes?.control(handle, code, output, room, block,
                    { event: event >>> 0, apc: apc >>> 0, context: context >>> 0 },
                    input >>> 0, inLength >>> 0);
                if (piped)
                {
                    if ('parked' in piped)
                    {
                        return piped.parked;
                    }
                    if (piped.status === STATUS_PENDING)
                    {
                        return STATUS_PENDING;
                    }
                    // A request done at once that reached the pipe - a success
                    // or a warning - signals its event and queues its APC.
                    if ((piped.status >>> 30) !== 3)
                    {
                        if ((event >>> 0) !== 0)
                        {
                            host.setEvent?.(event >>> 0);
                        }
                        if ((apc >>> 0) !== 0)
                        {
                            host.queueApc?.(host.currentThread?.() ?? null, apc >>> 0,
                                [context >>> 0, block >>> 0, 0]);
                        }
                    }
                    return settled(block >>> 0, piped.status, piped.information);
                }
                const held = object(handle, 'file') ?? object(handle, 'directory');
                if (!held)
                {
                    return report(block >>> 0, STATUS_INVALID_HANDLE, 0);
                }
                if (REPARSE_CONTROLS.has(code >>> 0) && files.setReparse)
                {
                    const { status, information } = reparseControl(held.path, code >>> 0,
                        input >>> 0, inLength >>> 0, output >>> 0, room >>> 0);
                    return (status >>> 0) < 0xc0000000 ? settled(block >>> 0, status, information)
                        : status;
                }
                host.divergence?.('NtFsControlFile',
                    `control code 0x${(code >>> 0).toString(16)} is not one this volume answers`);
                return report(block >>> 0, STATUS_INVALID_DEVICE_REQUEST, 0);
            },
        },

        /**
         * NTSTATUS NtDeviceIoControlFile(HANDLE, HANDLE Event, PIO_APC_ROUTINE,
         *   PVOID, PIO_STATUS_BLOCK, ULONG IoControlCode, PVOID InputBuffer,
         *   ULONG InputBufferLength, PVOID OutputBuffer, ULONG OutputBufferLength)
         *
         * Every request finishes before the call answers. The block is
         * written for an answer the device gave, success or a warning, and
         * left alone for a request refused before it reached one.
         */
        NtDeviceIoControlFile: {
            argBytes: 40,
            /** @param {number[]} args */
            handler: ([handle, , , , block, code, input, inLength, output, outLength])=>{
                const { status, information } = deviceControl(handle, code, input, inLength,
                    output, outLength);
                return (status >>> 0) < 0xc0000000 ? report(block >>> 0, status, information)
                    : status;
            },
        },

        /**
         * NTSTATUS NtQueryInformationFile(HANDLE, PIO_STATUS_BLOCK, PVOID,
         *                                 ULONG Length, FILE_INFORMATION_CLASS)
         *
         * The name, the size and the position of an open file; a class
         * this surface keeps nothing for is refused, and the refusal said.
         */
        NtQueryInformationFile: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, block, out, length, kind])=>{
                if ((kind >>> 0) === FILE_IO_COMPLETION_NOTIFICATION_INFORMATION && host.pipes
                    && (host.handles.typeOf?.(handle >>> 0) ?? null) !== null)
                {
                    if ((length >>> 0) < 4)
                    {
                        return report(block >>> 0, STATUS_INFO_LENGTH_MISMATCH, 0);
                    }
                    writeDword(out >>> 0, host.pipes.completionModes.of(handle));
                    return report(block >>> 0, STATUS_SUCCESS, 4);
                }
                const held = heldKind(handle);
                const fileObject = held === 'pipe' || FILE_OBJECT_KINDS.has(held ?? '');
                if (fileObject && (length >>> 0) < (QUERY_LENGTHS.get(kind >>> 0) ?? 0))
                {
                    return report(block >>> 0, STATUS_INFO_LENGTH_MISMATCH, 0);
                }
                // A pipe end answers its own classes, then what any file object does.
                const piped = host.pipes?.information?.(handle >>> 0, kind >>> 0) ?? null;
                if (piped !== null && !(piped instanceof Uint8Array))
                {
                    return report(block >>> 0, piped.status, 0);
                }
                const slot = piped ?? (fileObject && (kind >>> 0) === FILE_ACCESS_INFORMATION
                    ? dwordOf(rightsOf(handle))
                    : host.mailslots?.information(handle, kind >>> 0) ?? null);
                // A directory the native open made is a file object as any
                // other, its information the directory's.
                const folder = slot === null ? object(handle, 'directory') : null;
                const file = slot === null ? object(handle, 'file')
                    ?? (folder && { ...folder, directory: true, position: 0 }) : null;
                if (slot === null && !file)
                {
                    return report(block >>> 0, held !== null && !fileObject
                        ? STATUS_OBJECT_TYPE_MISMATCH : STATUS_INVALID_HANDLE, 0);
                }
                const known = slot ?? informationOf(file, kind >>> 0, handle >>> 0);
                const data = known === 'unknown class' ? null : known;
                if (data === null)
                {
                    host.divergence?.('NtQueryInformationFile',
                        `information class ${kind >>> 0} is not kept`);
                    return report(block >>> 0, STATUS_INVALID_INFO_CLASS, 0);
                }
                if ((length >>> 0) < data.length)
                {
                    // A name, alone or at the end of the whole record, is
                    // cut to the room with its length saying all of it.
                    const fixed = kind >>> 0 === FILE_NAME_INFORMATION ? 8
                        : kind >>> 0 === FILE_ALL_INFORMATION ? ALL_INFORMATION_FIXED : -1;
                    const fits = fixed >= 0 && (length >>> 0) >= fixed;
                    if (fits)
                    {
                        host.writeMemory(out >>> 0, data.subarray(0, length >>> 0));
                    }
                    return report(block >>> 0, fits ? STATUS_BUFFER_OVERFLOW
                        : STATUS_INFO_LENGTH_MISMATCH, fits ? length >>> 0 : 0);
                }
                host.writeMemory(out >>> 0, data);
                return report(block >>> 0, STATUS_SUCCESS, data.length);
            },
        },

        /**
         * NTSTATUS NtQueryAttributesFile(POBJECT_ATTRIBUTES, PFILE_BASIC_INFORMATION)
         *
         * FileBasicInformation of a file named rather than opened.
         */
        NtQueryAttributesFile: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([attributes, out])=>attributesOfName(attributes >>> 0, out >>> 0,
                FILE_BASIC_INFORMATION),
        },

        /**
         * NTSTATUS NtQueryFullAttributesFile(POBJECT_ATTRIBUTES,
         *                                    PFILE_NETWORK_OPEN_INFORMATION)
         */
        NtQueryFullAttributesFile: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([attributes, out])=>attributesOfName(attributes >>> 0, out >>> 0,
                FILE_NETWORK_OPEN_INFORMATION),
        },

        /**
         * NTSTATUS NtDeleteFile(POBJECT_ATTRIBUTES)
         *
         * A file, or a folder with nothing in it, deleted by name: a read-only
         * file cannot be (STATUS_CANNOT_DELETE), an open that does not share
         * deletion keeps it, and a folder with anything in it stays.
         */
        NtDeleteFile: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([attributes])=>{
                if ((attributes >>> 0) === 0)
                {
                    return STATUS_ACCESS_VIOLATION;
                }
                const named = nativeName(attributes >>> 0);
                if (named.status !== undefined)
                {
                    return named.status;
                }
                const { path } = named;
                const entry = files.stat(path);
                if (!entry?.exists)
                {
                    return NATIVE_FAILURES[missing(path)];
                }
                if (onReadOnlyMedia(path))
                {
                    return STATUS_MEDIA_WRITE_PROTECTED;
                }
                if (entry.isDirectory)
                {
                    return files.remove(path) ? STATUS_SUCCESS : STATUS_DIRECTORY_NOT_EMPTY;
                }
                if (readOnlyFile(entry) || files.mappedAs?.(path) === 'image')
                {
                    return STATUS_CANNOT_DELETE;
                }
                if (files.removalRefused?.(path) === 'SHARING_VIOLATION')
                {
                    return STATUS_SHARING_VIOLATION;
                }
                return files.remove(path) ? STATUS_SUCCESS : STATUS_ACCESS_DENIED;
            },
        },

        /**
         * NTSTATUS NtFlushBuffersFile(HANDLE, PIO_STATUS_BLOCK)
         *
         * Every write here is in the volume when the call that made it
         * returns, so there is nothing to flush; a handle that cannot write
         * is refused as Windows refuses it.
         */
        NtFlushBuffersFile: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, block])=>{
                // A pipe end waits until its reader has taken what it wrote.
                const piped = host.pipes?.flushNative?.(handle >>> 0, block >>> 0) ?? null;
                if (piped !== null)
                {
                    return typeof piped === 'number' ? piped : piped.parked;
                }
                const file = object(handle, 'file');
                if (!file)
                {
                    return STATUS_INVALID_HANDLE;
                }
                return report(block >>> 0, writes(handle, file) ? STATUS_SUCCESS
                    : STATUS_ACCESS_DENIED, 0);
            },
        },

        /**
         * NTSTATUS NtSetEaFile(HANDLE, PIO_STATUS_BLOCK, PVOID Buffer, ULONG Length)
         *
         * The volume keeps no extended attributes, and says so as FAT does.
         */
        NtSetEaFile: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, block])=>{
                if (!fileOrDirectory(handle))
                {
                    return STATUS_INVALID_HANDLE;
                }
                host.divergence?.('NtSetEaFile', 'the volume keeps no extended attributes');
                return report(block >>> 0, STATUS_EAS_NOT_SUPPORTED, 0);
            },
        },

        /**
         * NTSTATUS NtQueryEaFile(HANDLE, PIO_STATUS_BLOCK, PVOID Buffer, ULONG Length,
         *   BOOLEAN ReturnSingleEntry, PVOID EaList, ULONG EaListLength,
         *   PULONG EaIndex, BOOLEAN RestartScan)
         *
         * No file has any (FileEaInformation says a size of 0 for every one).
         */
        NtQueryEaFile: {
            argBytes: 36,
            /** @param {number[]} args */
            handler: ([handle, block])=>{
                if (!fileOrDirectory(handle))
                {
                    return STATUS_INVALID_HANDLE;
                }
                return report(block >>> 0, STATUS_EAS_NOT_SUPPORTED, 0);
            },
        },

        /**
         * NTSTATUS NtQueryDirectoryFile(HANDLE, HANDLE Event, PIO_APC_ROUTINE,
         *   PVOID ApcContext, PIO_STATUS_BLOCK, PVOID FileInformation, ULONG Length,
         *   FILE_INFORMATION_CLASS, BOOLEAN ReturnSingleEntry,
         *   PUNICODE_STRING FileName, BOOLEAN RestartScan)
         *
         * A folder's entries a call at a time, from where the last call left
         * off. The mask is the first call's (none is `*`); a restart begins
         * the listing again, under a new mask if it names one. The call
         * finishes before it answers: the event, if any, is signalled.
         */
        NtQueryDirectoryFile: {
            argBytes: 44,
            /** @param {number[]} args */
            handler: ([handle, event, , , block, out, length, kind, single, mask, restart])=>{
                const listed = directoryRecords(handle >>> 0, block >>> 0, out >>> 0, length >>> 0,
                    kind >>> 0, (single & 0xff) !== 0, mask >>> 0, (restart & 0xff) !== 0);
                if ((event >>> 0) !== 0 && listed.reported)
                {
                    host.setEvent?.(event >>> 0);
                }
                return listed.status;
            },
        },

        /**
         * NTSTATUS NtSetInformationFile(HANDLE, PIO_STATUS_BLOCK, PVOID,
         *                               ULONG Length, FILE_INFORMATION_CLASS)
         *
         * The classes SetFileInformationByHandle has, through the same code;
         * the position, the mode, the completion port a handle reports to and a
         * mailslot's read timeout, which are this call's own. A rename's name
         * is a native one, relative to the record's root directory or in
         * `\??\`. A class nothing keeps is refused, and the refusal said.
         *
         * FileLinkInformation (and its Ex form) gives the file one more name
         * (`linkError`), its record laid out as a rename's.
         */
        NtSetInformationFile: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, block, from, length, kind])=>{
                const slot = host.pipes?.setInformation?.(handle >>> 0, kind >>> 0,
                    from >>> 0, length >>> 0) ?? host.mailslots?.setInformation?.(handle >>> 0,
                    kind >>> 0, from >>> 0, length >>> 0) ?? null;
                if (slot !== null)
                {
                    return settled(block >>> 0, slot, 0);
                }
                // The completion modes are any handle's, kept with the pipes as
                // SetFileCompletionNotificationModes keeps them.
                if ((kind >>> 0) === FILE_IO_COMPLETION_NOTIFICATION_INFORMATION && host.pipes)
                {
                    if ((length >>> 0) < 4)
                    {
                        return settled(block >>> 0, STATUS_INFO_LENGTH_MISMATCH, 0);
                    }
                    const error = host.pipes.completionModes.set(handle >>> 0,
                        readDword(from >>> 0));
                    return settled(block >>> 0, error === 0 ? STATUS_SUCCESS
                        : error === ERROR_INVALID_PARAMETER ? STATUS_INVALID_PARAMETER
                            : STATUS_INVALID_HANDLE, 0);
                }
                // Any file object reports to a port - a pipe's end as well as a
                // file on the volume.
                if ((kind >>> 0) === FILE_COMPLETION_INFORMATION)
                {
                    if ((length >>> 0) < 8)
                    {
                        return settled(block >>> 0, STATUS_INFO_LENGTH_MISMATCH, 0);
                    }
                    const held = host.handles.typeOf?.(handle >>> 0) ?? '';
                    const fileObject = held === 'pipe' || FILE_OBJECT_KINDS.has(held);
                    const bound = fileObject && host.ports?.bind?.(handle >>> 0,
                        readDword(from >>> 0), readDword((from >>> 0) + 4));
                    // A handle no port takes is refused before any I/O: the
                    // status block is left as it was.
                    return bound === 'synchronous' ? STATUS_INVALID_PARAMETER
                        : settled(block >>> 0, bound ? STATUS_SUCCESS : STATUS_INVALID_HANDLE, 0);
                }
                const open = fileOrDirectory(handle);
                if (!open)
                {
                    const held = heldKind(handle);
                    return settled(block >>> 0, held !== null && held !== 'pipe'
                        && !FILE_OBJECT_KINDS.has(held) ? STATUS_OBJECT_TYPE_MISMATCH
                        : STATUS_INVALID_HANDLE, 0);
                }
                if ((kind >>> 0) === FILE_LINK_INFORMATION
                    || (kind >>> 0) === FILE_LINK_INFORMATION_EX)
                {
                    if ((length >>> 0) < 16)
                    {
                        return settled(block >>> 0, STATUS_INFO_LENGTH_MISMATCH, 0);
                    }
                    const record = host.readMemory(from >>> 0, length >>> 0).slice();
                    return settled(block >>> 0, linkError(open, record,
                        (kind >>> 0) === FILE_LINK_INFORMATION_EX), 0);
                }
                const type = NATIVE_SET_CLASSES.get(kind >>> 0);
                const own = (kind >>> 0) === FILE_POSITION_SET || (kind >>> 0) === FILE_MODE_SET
                    || (kind >>> 0) === FILE_COMPLETION_INFORMATION
                    || (kind >>> 0) === FILE_VALID_DATA_LENGTH_INFORMATION;
                if (type === undefined && !own)
                {
                    host.divergence?.('NtSetInformationFile',
                        `information class ${kind >>> 0} is not kept`);
                    return settled(block >>> 0, STATUS_INVALID_INFO_CLASS, 0);
                }
                const size = type !== undefined ? /** @type {number} */ (FILE_INFO_SIZES.get(type))
                    : (kind >>> 0) === FILE_MODE_SET ? 4 : 8;
                if ((length >>> 0) < size)
                {
                    return settled(block >>> 0, STATUS_INFO_LENGTH_MISMATCH, 0);
                }
                if ((from >>> 0) === 0)
                {
                    return STATUS_ACCESS_VIOLATION;
                }
                const bytes = host.readMemory(from >>> 0, length >>> 0).slice();
                const view = new DataView(bytes.buffer);
                const { file, kind: what } = open;
                switch (kind >>> 0)
                {
                    case FILE_POSITION_SET: {
                        const at = view.getBigInt64(0, true);
                        if (at < 0n)
                        {
                            return settled(block >>> 0, STATUS_INVALID_PARAMETER, 0);
                        }
                        file.position = Number(at);
                        return settled(block >>> 0, STATUS_SUCCESS, 0);
                    }
                    case FILE_MODE_SET: {
                        // Only the write-through and sequential hints change;
                        // a synchronous handle may switch between alerting and
                        // not, and an asynchronous one cannot become either.
                        const mode = view.getUint32(0, true);
                        const synchronous = mode & (FILE_SYNCHRONOUS_IO_ALERT
                            | FILE_SYNCHRONOUS_IO_NONALERT);
                        if ((mode & ~(FILE_WRITE_THROUGH | FILE_SEQUENTIAL_ONLY
                            | FILE_SYNCHRONOUS_IO_ALERT | FILE_SYNCHRONOUS_IO_NONALERT)) !== 0
                            || synchronous === (FILE_SYNCHRONOUS_IO_ALERT
                                | FILE_SYNCHRONOUS_IO_NONALERT)
                            || (synchronous !== 0) !== (modeOf(file) & SYNCHRONOUS_MODES) > 0)
                        {
                            return settled(block >>> 0, STATUS_INVALID_PARAMETER, 0);
                        }
                        file.mode = mode;
                        return settled(block >>> 0, STATUS_SUCCESS, 0);
                    }
                    case FILE_VALID_DATA_LENGTH_INFORMATION:
                        // Every byte of a file here is data written: there is
                        // no tail of unwritten allocation to declare valid.
                        return settled(block >>> 0, what === 'file' && file.write
                            ? STATUS_SUCCESS : STATUS_ACCESS_DENIED, 0);
                    default:
                        break;
                }
                const error = informationError(file, what, /** @type {number} */ (type), bytes,
                    // A bare name with no root renames the file where it is.
                    asked=>(view.getUint32(4, true) === 0 && !asked.includes(SEPARATOR)
                        ? renameTarget(file.path, asked)
                        : resolveNative(view.getUint32(4, true), asked).path ?? null),
                    handle >>> 0);
                /** @param {InformationError} code */
                const answer = code=>settled(block >>> 0, typeof code !== 'number' ? code.status
                    : code === 0 ? STATUS_SUCCESS : NATIVE_FAILURES[code] ?? STATUS_UNSUCCESSFUL,
                0);
                return error instanceof Promise ? error.then(answer) : answer(error);
            },
        },

        /**
         * NTSTATUS NtOpenFile(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
         *                     PIO_STATUS_BLOCK, ULONG ShareAccess, ULONG OpenOptions)
         *
         * NtCreateFile's FILE_OPEN, with no attributes and no extended ones.
         */
        NtOpenFile: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([out, access, attributes, status, share, options])=>
                ntCreateFile([out, access, attributes, status, 0, 0, share, FILE_OPEN,
                    options]),
        },
    };

    const findNextFile = bothForms(8, ([handle, data], text)=>{
        const search = object(handle, 'find');
        if (!search)
        {
            return fail(ERROR_INVALID_HANDLE);
        }
        if (search.index >= search.entries.length)
        {
            return fail(ERROR_NO_MORE_FILES);
        }
        text.findData(data >>> 0, search.entries[search.index]);
        search.index++;
        return 1;
    });

    /**
     * The path an open file or directory handle stands for, or null for a
     * handle that is none (a pipe has no name on a volume).
     *
     * @param {number} handle
     */
    const handlePath = handle=>{
        const type = host.handles.typeOf?.(handle >>> 0);
        if (type !== 'file' && type !== 'directory')
        {
            return null;
        }
        return object(handle, type)?.path ?? null;
    };

    /**
     * GetFinalPathNameByHandle in either width. The name is the one the file
     * was opened by -- a volume's names are its own spelling, with no links
     * to resolve -- in the namespace the flags ask for: the drive's
     * (`\\?\C:\...`), the volume's device (`\Device\HarddiskVolumeN\...`,
     * the drives numbered from C as QueryDosDevice names them), or none (the
     * path below the root). A volume GUID path is not one this answers.
     *
     * @param {TextForm} text
     */
    const finalPathName = text=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([handle, buffer, room, flags])=>{
            const path = handlePath(handle);
            if (path === null)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            const volumeName = (flags >>> 0) & 0x7;
            if (((flags >>> 0) & ~0xf) !== 0 || (volumeName !== VOLUME_NAME_DOS
                && volumeName !== VOLUME_NAME_NT && volumeName !== VOLUME_NAME_NONE))
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const below = path.slice(2);
            const index = path.toUpperCase().charCodeAt(0) - 'C'.charCodeAt(0) + 1;
            const name = volumeName === VOLUME_NAME_DOS ? `\\\\?\\${path}`
                : volumeName === VOLUME_NAME_NT
                    ? `\\Device\\HarddiskVolume${Math.max(index, 1)}${below}` : below;
            if ((room >>> 0) < name.length + 1 || (buffer >>> 0) === 0)
            {
                return name.length + 1;
            }
            text.write(buffer >>> 0, room >>> 0, name);
            return name.length;
        },
    });

    /**
     * The name a FILE_RENAME_INFO asks for: a full path as it is, a bare
     * name in the directory the file is in.
     *
     * @param {string} current @param {string} asked
     */
    const renameTarget = (current, asked)=>(/^[A-Za-z]:|^\\/.test(asked) ? fullPath(asked)
        : `${current.slice(0, current.lastIndexOf('\\'))}\\${asked}`);

    /**
     * A record of informationOf for a file named in an OBJECT_ATTRIBUTES,
     * written where the caller asks: NtQueryAttributesFile's and
     * NtQueryFullAttributesFile's answer.
     *
     * @param {number} attributes @param {number} out @param {number} kind
     */
    const attributesOfName = (attributes, out, kind)=>{
        if (attributes === 0 || out === 0)
        {
            return STATUS_ACCESS_VIOLATION;
        }
        const named = nativeName(attributes);
        if (named.status !== undefined)
        {
            return named.status;
        }
        const entry = files.stat(named.path);
        if (!entry?.exists)
        {
            return NATIVE_FAILURES[missing(named.path)];
        }
        const record = informationOf({ path: named.path, directory: entry.isDirectory }, kind);
        if (!(record instanceof Uint8Array))
        {
            return STATUS_INVALID_INFO_CLASS;
        }
        host.writeMemory(out, record);
        return STATUS_SUCCESS;
    };

    /**
     * The FILE_INFORMATION_CLASS values NtQueryDirectoryFile lists in, each
     * with where its name starts: FileDirectoryInformation's times, sizes and
     * attributes come first in all but the names-only one, then the EA size,
     * the short name (none: a name here has no 8.3 alias) and the file's id.
     *
     * @type {Map<number, { name: number, ea?: number, id?: number }>}
     */
    const DIRECTORY_CLASSES = new Map([
        [1, { name: 64 }], [2, { name: 68, ea: 64 }], [3, { name: 94, ea: 64 }],
        [12, { name: 12 }], [37, { name: 104, ea: 64, id: 96 }],
        [38, { name: 80, ea: 64, id: 72 }]]);
    const FILE_NAMES_INFORMATION = 12;

    /**
     * Lists a folder handle's next entries into a buffer, each record eight
     * aligned and linked to the next by its offset. The first record that
     * does not fit is cut to the room with STATUS_BUFFER_OVERFLOW; nothing
     * matching at the first call is STATUS_NO_SUCH_FILE, nothing left
     * STATUS_NO_MORE_FILES.
     *
     * @param {number} handle @param {number} block  the IO_STATUS_BLOCK
     * @param {number} out @param {number} length @param {number} kind
     * @param {boolean} single @param {number} mask  a UNICODE_STRING, or 0
     * @param {boolean} restart
     * @returns {{ status: number, reported: boolean }}
     */
    const directoryRecords = (handle, block, out, length, kind, single, mask, restart)=>{
        const directory = object(handle, 'directory');
        if (!directory)
        {
            return { status: object(handle, 'file') ? STATUS_INVALID_PARAMETER
                : STATUS_INVALID_HANDLE, reported: false };
        }
        const shape = DIRECTORY_CLASSES.get(kind);
        if (shape === undefined)
        {
            host.divergence?.('NtQueryDirectoryFile', `information class ${kind} is not kept`);
            return { status: STATUS_INVALID_INFO_CLASS, reported: false };
        }
        if (length < shape.name)
        {
            return { status: STATUS_INFO_LENGTH_MISMATCH, reported: false };
        }
        if (!directory.listing || restart)
        {
            let pattern = directory.listing?.pattern ?? '*';
            if (mask !== 0)
            {
                const units = readDword(mask) & 0xffff;
                const buffer = readDword(mask + 4);
                const raw = buffer === 0 ? new Uint8Array(0) : host.readMemory(buffer, units & ~1);
                pattern = '';
                for (let at = 0; at + 1 < raw.length; at += 2)
                {
                    pattern += String.fromCharCode(raw[at] | raw[at + 1] << 8);
                }
            }
            // The mask is a native expression, matched as the system matches
            // it (`name-expression.js`), and every folder but a drive's root
            // holds "." and ".." first.
            const holder = files.stat(directory.path);
            // "." is the folder itself and ".." its parent, by number too.
            const parent = directory.path.replace(/\\[^\\]*\\?$/, '');
            const dots = /^[A-Za-z]:\\?$/.test(directory.path) || !holder ? []
                : [['.', directory.path], ['..', /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent]]
                    .map(([dot, of])=>({ ...holder, name: dot, isDirectory: true, size: 0,
                        identity: of }));
            const entries = [...dots, ...files.list(directory.path, '*') ?? []]
                .filter(entry=>isNameInExpression(pattern === '' ? '*' : pattern, entry.name));
            directory.listing = { pattern, entries, next: 0, first: true };
        }
        const listing = directory.listing;
        const first = listing.first;
        listing.first = false;
        if (listing.next >= listing.entries.length)
        {
            // STATUS_NO_MORE_FILES is a warning, and a warning completes the
            // call: its status block is written. An error leaves it alone.
            return first ? { status: STATUS_NO_SUCH_FILE, reported: false }
                : { status: report(block, STATUS_NO_MORE_FILES, 0), reported: true };
        }
        const bytes = new Uint8Array(length);
        const view = new DataView(bytes.buffer);
        let at = 0;
        let previous = -1;
        let status = STATUS_SUCCESS;
        while (listing.next < listing.entries.length)
        {
            const entry = listing.entries[listing.next];
            const name = entry.name;
            const size = shape.name + name.length * 2;
            if (at + size > length)
            {
                if (previous >= 0)
                {
                    break;
                }
                status = STATUS_BUFFER_OVERFLOW;
            }
            listing.next++;
            if (previous >= 0)
            {
                view.setUint32(previous, at - previous, true);
            }
            const fill = (/** @type {() => void} */ write)=>{
                try
                {
                    write();
                }
                catch (e){
                    // A field past the room is not written: the record is cut.
                    if (!(e instanceof RangeError))
                    {
                        throw e;
                    }
                }
            };
            if (kind === FILE_NAMES_INFORMATION)
            {
                fill(()=>view.setUint32(at + 8, name.length * 2, true));
            }
            else
            {
                const time = msToFileTime(entry.modified ?? 0);
                const bytesOf = BigInt(entry.isDirectory ? 0 : entry.size ?? 0);
                fill(()=>{
                    for (let field = 0; field < 4; field++)
                    {
                        view.setBigUint64(at + 8 + field * 8, time, true);
                    }
                    view.setBigUint64(at + 40, bytesOf, true);
                    view.setBigUint64(at + 48, (bytesOf + 4095n) & ~4095n, true);
                    view.setUint32(at + 56, attributesOf(entry), true);
                    view.setUint32(at + 60, name.length * 2, true);
                    if (shape.id !== undefined)
                    {
                        view.setBigUint64(at + shape.id,
                            BigInt(fileIndex(listedIdentity(directory.path, entry))), true);
                    }
                });
            }
            for (let unit = 0; unit < name.length && at + shape.name + unit * 2 + 1 < length;
                unit++)
            {
                view.setUint16(at + shape.name + unit * 2, name.charCodeAt(unit), true);
            }
            previous = at;
            at = Math.min(length, (at + size + 7) & ~7);
            if (single || status !== STATUS_SUCCESS)
            {
                break;
            }
        }
        const used = status === STATUS_BUFFER_OVERFLOW ? length
            : previous + shape.name + listing.entries[listing.next - 1].name.length * 2;
        host.writeMemory(out, bytes.subarray(0, used));
        return { status: report(block, status, used), reported: true };
    };

    /**
     * The settable classes of an open file, as SetFileInformationByHandle and
     * NtSetInformationFile both set them: the basic times and attributes, the
     * end of the file and its allocation, a rename, deletion on close. The
     * Win32 error it ends in, 0 when it held.
     *
     * @param {any} file @param {string} kind  'file' or 'directory'
     * @param {number} type  a FILE_INFO class
     * @param {Uint8Array} bytes  the record, at least its class's size
     * @param {(name: string) => string | null} target  where a rename's name
     *     leads, null for one that leads nowhere
     * @param {number} handle  the handle the class is set through: its rights
     * @returns {InformationError | Promise<InformationError>}  a Win32 error, or
     *     one the native call names otherwise (`status`)
     */
    const informationError = (file, kind, type, bytes, target, handle)=>{
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        switch (type)
        {
            case FILE_INFO.BASIC: {
                if (!(file.writeAttributes ?? file.write ?? true))
                {
                    return ERROR_ACCESS_DENIED;
                }
                const written = view.getBigInt64(16, true);
                if (written > 0n)
                {
                    files.setModified?.(file.path,
                        Number(written / 10000n) - FILETIME_EPOCH_MS);
                }
                const attributes = view.getUint32(32, true);
                if (attributes !== 0)
                {
                    files.setAttributes?.(file.path, attributes & SETTABLE_ATTRIBUTES);
                }
                return 0;
            }
            case FILE_INFO.END_OF_FILE:
            case FILE_INFO.ALLOCATION: {
                if (kind !== 'file' || !file.write)
                {
                    return ERROR_ACCESS_DENIED;
                }
                const at = Number(view.getBigInt64(0, true));
                if (at < 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const current = files.stat(file.path)?.size ?? 0;
                // An allocation only ever cuts a file shorter: room reserved
                // past its end is not part of it.
                if (type === FILE_INFO.END_OF_FILE || at < current)
                {
                    files.truncate(file.node, at);
                }
                return 0;
            }
            case FILE_INFO.DISPOSITION:
            case FILE_INFO.DISPOSITION_EX: {
                const deleting = type === FILE_INFO.DISPOSITION ? bytes[0] !== 0
                    : (view.getUint32(0, true) & FILE_DISPOSITION_FLAG_DELETE) !== 0;
                // Deletion is the file's, asked through a handle that may delete it.
                if (!allows(host.handles.access?.(handle >>> 0) ?? null, DELETE))
                {
                    return ERROR_ACCESS_DENIED;
                }
                if (deleting)
                {
                    const entry = files.stat(file.path);
                    if (readOnlyFile(entry) || onReadOnlyMedia(file.path))
                    {
                        return { error: ERROR_ACCESS_DENIED, status: STATUS_CANNOT_DELETE };
                    }
                    if (entry?.isDirectory && files.list(file.path, '*')
                        .some(each=>each.name !== '.' && each.name !== '..'))
                    {
                        return ERROR_DIR_NOT_EMPTY;
                    }
                }
                // Pending, the file opens no more, and goes with the last
                // handle onto it; cleared through any handle, it stays.
                const key = String(file.path).toLowerCase();
                if (deleting && type === FILE_INFO.DISPOSITION_EX
                    && (view.getUint32(0, true) & FILE_DISPOSITION_FLAG_POSIX_SEMANTICS) !== 0)
                {
                    file.posixDelete = true;
                }
                else if (deleting)
                {
                    deletePending.set(key, String(file.path));
                }
                else
                {
                    deletePending.delete(key);
                    file.deleteOnClose = false;
                }
                return 0;
            }
            case FILE_INFO.RENAME:
            case FILE_INFO.RENAME_EX: {
                const replace = type === FILE_INFO.RENAME ? bytes[0] !== 0
                    : (view.getUint32(0, true) & FILE_RENAME_FLAG_REPLACE_IF_EXISTS) !== 0;
                const nameBytes = view.getUint32(8, true);
                if (12 + nameBytes > bytes.length || nameBytes === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                let asked = '';
                for (let at = 12; at + 1 < 12 + nameBytes; at += 2)
                {
                    asked += String.fromCharCode(bytes[at] | bytes[at + 1] << 8);
                }
                const destination = target(asked);
                if (destination === null)
                {
                    return ERROR_PATH_NOT_FOUND;
                }
                // A rename is the file's deletion from its name: the handle
                // must hold it for deletion, and then holds it against every
                // other open already.
                if (!allows(host.handles.access?.(handle >>> 0) ?? null, DELETE))
                {
                    return ERROR_ACCESS_DENIED;
                }
                const moved = moveError(file.path, destination, replace, { held: true,
                    readOnlyReplaced: type === FILE_INFO.RENAME_EX
                        && (view.getUint32(0, true) & FILE_RENAME_FLAG_IGNORE_READONLY_ATTRIBUTE)
                            !== 0 });
                /** @param {number} code */
                const settle = code=>{
                    if (code === 0)
                    {
                        file.path = destination;
                    }
                    return code;
                };
                return typeof moved === 'number' ? settle(moved) : moved.then(settle);
            }
            default:
                // FileIoPriorityHintInfo: a hint with nothing to prioritise.
                return 0;
        }
    };

    /**
     * A hard link asked through an open file: FILE_LINK_INFORMATION's
     * replace flag (or the Ex form's flags), root directory and name, the
     * name a native one as a rename's. A folder has no other names
     * (STATUS_FILE_IS_A_DIRECTORY). A name that is taken is a collision
     * unless replacing was asked; then a folder or an open file there is
     * refused (STATUS_ACCESS_DENIED), as is a read-only file the call did
     * not say to ignore, and anything else gives its name up - the new name
     * spelt as asked. The file's own name is already its link.
     *
     * @param {{ file: any, kind: string }} open  the handle's file
     * @param {Uint8Array} record @param {boolean} extended  the Ex form
     * @returns {number}  the status
     */
    const linkError = (open, record, extended)=>{
        const view = new DataView(record.buffer);
        const flags = extended ? view.getUint32(0, true)
            : record[0] !== 0 ? FILE_LINK_REPLACE_IF_EXISTS : 0;
        const root = view.getUint32(4, true);
        const nameBytes = view.getUint32(8, true);
        if (nameBytes === 0 || 12 + nameBytes > record.length)
        {
            return STATUS_INVALID_PARAMETER;
        }
        let asked = '';
        for (let at = 12; at + 1 < 12 + nameBytes; at += 2)
        {
            asked += String.fromCharCode(record[at] | record[at + 1] << 8);
        }
        const { file } = open;
        if (open.kind === 'directory' || file.directory)
        {
            return STATUS_FILE_IS_A_DIRECTORY;
        }
        const resolved = root === 0 && !asked.includes(SEPARATOR)
            ? { path: renameTarget(file.path, asked) } : resolveNative(root, asked);
        if (!resolved.path)
        {
            return resolved.status ?? STATUS_OBJECT_PATH_NOT_FOUND;
        }
        const path = resolved.path;
        const present = files.stat(path);
        if (present?.exists)
        {
            if ((flags & FILE_LINK_REPLACE_IF_EXISTS) === 0)
            {
                return STATUS_OBJECT_NAME_COLLISION;
            }
            // Its own name, perhaps spelt otherwise: the link it is takes the
            // spelling asked.
            if (path.toLowerCase() === String(file.path).toLowerCase())
            {
                if (path !== file.path && files.rename(file.path, path, { held: true }))
                {
                    follow(file.path, path);
                }
                return STATUS_SUCCESS;
            }
            if (present.isDirectory || files.isOpen?.(path)
                || (readOnlyFile(present) && (flags & FILE_LINK_IGNORE_READONLY_ATTRIBUTE) === 0)
                || !files.remove(path))
            {
                return STATUS_ACCESS_DENIED;
            }
        }
        if (!files.link)
        {
            host.divergence?.('NtSetInformationFile',
                `the volume keeps no links; ${path} not linked`);
            return STATUS_INVALID_DEVICE_REQUEST;
        }
        const refused = files.link(path, file.path);
        return refused === null ? STATUS_SUCCESS
            : NATIVE_FAILURES[LINK_ERRORS[/** @type {keyof typeof LINK_ERRORS} */ (refused)]
                ?? ERROR_ACCESS_DENIED] ?? STATUS_ACCESS_DENIED;
    };

    /**
     * The file or directory a handle names, with which of the two it is.
     *
     * @param {number} handle
     */
    const fileOrDirectory = handle=>{
        const kind = host.handles.typeOf?.(handle >>> 0);
        const file = kind === 'file' || kind === 'directory' ? object(handle, kind) : null;
        return file ? { file, kind: /** @type {string} */ (kind) } : null;
    };

    /**
     * SetFileInformationByHandle: its classes, each the size the class has
     * at least; a rename's name is relative to the file's folder or a path.
     *
     * @param {number} handle @param {number} type @param {number} from @param {number} length
     */
    const setInformationByHandle = (handle, type, from, length)=>{
        const open = fileOrDirectory(handle);
        if (!open)
        {
            return fail(ERROR_INVALID_HANDLE);
        }
        const size = FILE_INFO_SIZES.get(type);
        if (size === undefined)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        if (length < size || from === 0)
        {
            return fail(ERROR_BAD_LENGTH);
        }
        const bytes = host.readMemory(from, Math.max(length, size)).slice();
        const error = informationError(open.file, open.kind, type, bytes,
            asked=>renameTarget(open.file.path, asked), handle >>> 0);
        /** @param {InformationError} code */
        const answer = code=>(typeof code !== 'number' ? fail(code.error)
            : code === 0 ? 1 : fail(code));
        return error instanceof Promise ? error.then(answer) : answer(error);
    };

    /**
     * GetBinaryType in either width: what kind of program a file is, read
     * from its headers. A PE image's machine word says 32 or 64 bits, a
     * library is no program (ERROR_BAD_EXE_FORMAT, as Windows answers one),
     * an NE image is a Windows 3.x one, a bare MZ one MS-DOS's, as is a
     * `.com` with no header at all.
     *
     * @param {number} name @param {number} out @param {TextForm} text
     */
    const binaryType = async(name, out, text)=>{
        const path = text.path(name);
        const entry = files.stat(path);
        if (!entry?.exists || entry.isDirectory)
        {
            return fail(entry?.isDirectory ? ERROR_ACCESS_DENIED : missing(path));
        }
        const node = files.open(path, { read: true, shareRead: true, shareWrite: true,
            shareDelete: true });
        if (!node)
        {
            return fail(ERROR_ACCESS_DENIED);
        }
        /** @type {Uint8Array} */
        let head;
        try
        {
            head = await files.read(node, 0, Math.min(entry.size, 0x1000));
        }
        finally
        {
            files.close(node);
        }
        const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
        /** @type {number | null} */
        let kind = null;
        if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a)
        {
            kind = SCS_DOS_BINARY;
            const at = head.length >= 0x40 ? view.getUint32(0x3c, true) : head.length;
            if (at + 26 <= head.length && view.getUint32(at, true) === 0x4550)
            {
                const characteristics = view.getUint16(at + 22, true);
                const magic = view.getUint16(at + 24, true);
                kind = (characteristics & IMAGE_FILE_DLL) !== 0 ? null
                    : magic === 0x20b ? SCS_64BIT_BINARY : SCS_32BIT_BINARY;
            }
            else if (at + 2 <= head.length && head[at] === 0x4e && head[at + 1] === 0x45)
            {
                kind = SCS_WOW_BINARY;
            }
        }
        else if (/\.com$/i.test(path))
        {
            kind = SCS_DOS_BINARY;
        }
        if (kind === null)
        {
            return fail(ERROR_BAD_EXE_FORMAT);
        }
        writeDwordIf(out >>> 0, kind);
        return 1;
    };

    const table = {
        /**
         * HANDLE CreateFile(LPCSTR, DWORD dwDesiredAccess, DWORD dwShareMode,
         *   LPSECURITY_ATTRIBUTES, DWORD dwCreationDisposition,
         *   DWORD dwFlagsAndAttributes, HANDLE hTemplateFile)
         *
         * One body, both spellings.
         */
        CreateFileA: createFile.ansi,
        CreateFileW: { ...createFile.wide, natives },

        /**
         * HANDLE CreateFile2(LPCWSTR, DWORD dwDesiredAccess, DWORD dwShareMode,
         *   DWORD dwCreationDisposition, LPCREATEFILE2_EXTENDED_PARAMETERS)
         *
         * CreateFileW with its attributes, flags and quality-of-service flags
         * in a structure: dwSize, dwFileAttributes, dwFileFlags,
         * dwSecurityQosFlags, then the security attributes and the template,
         * which CreateFileW does not look at either.
         */
        /**
         * HANDLE ReOpenFile(HANDLE hOriginalFile, DWORD dwDesiredAccess,
         *     DWORD dwShareMode, DWORD dwFlagsAndAttributes)
         *
         * A handle of its own to the file another names, opened again as it stands
         * (OPEN_EXISTING) with this access, sharing and flags -- an engine reopens
         * a file it opened for synchronous reads to read it overlapped.
         */
        ReOpenFile: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([original, access, share, flags])=>{
                const path = handlePath(original);
                if (path === null)
                {
                    return fail(ERROR_INVALID_HANDLE, INVALID_HANDLE_VALUE);
                }
                const opened = openPath(path, { access: access >>> 0, share: share >>> 0,
                    disposition: OPEN_EXISTING, flags: flags >>> 0 });
                if ('error' in opened)
                {
                    return fail(opened.error, INVALID_HANDLE_VALUE);
                }
                host.setLastError(ERROR_SUCCESS);
                return opened.handle;
            },
        },

        CreateFile2: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([name, access, share, disposition, parameters])=>{
                let flags = 0;
                if ((parameters >>> 0) !== 0)
                {
                    const bytes = host.readMemory(parameters >>> 0, 16);
                    const view = new DataView(bytes.buffer, bytes.byteOffset, 16);
                    flags = (view.getUint32(4, true) | view.getUint32(8, true)
                        | view.getUint32(12, true)) >>> 0;
                }
                return createFile.wide.handler([name, access, share, 0, disposition, flags, 0]);
            },
        },

        /**
         * BOOL ReadFile(HANDLE, LPVOID, DWORD, LPDWORD lpNumberOfBytesRead,
         *               LPOVERLAPPED)
         *
         * Every read here finishes before the call answers, so an overlapped
         * read is a synchronous one that also completes: the position comes out
         * of the OVERLAPPED rather than the file pointer, and when it is done
         * the structure, its event and the handle's completion port are all told.
         * Leaving that last part out is invisible until something waits for it,
         * and then it is a pool parked for ever on a packet nobody posts.
         *
         * Reading a standard handle is an immediate end of input rather than a
         * failure -- there is no console to type at, and a program that asks
         * gets the answer it would get from a redirected empty stream.
         */
        ReadFile: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, buffer, length, read, overlapped])=>{
                // Zeroed before anything is checked, as Windows documents: a
                // caller that reads the count after a failure reads 0.
                writeDwordIf(read >>> 0, 0);
                if (isStandardHandle(handle >>> 0))
                {
                    return 1;
                }
                for (const stream of streams)
                {
                    const answer = stream.read(handle, buffer, length, read, false, overlapped);
                    if (answer !== null)
                    {
                        return answer;
                    }
                }
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (!reads(handle, file))
                {
                    return fail(ERROR_ACCESS_DENIED);
                }
                if ((buffer >>> 0) === 0 && (length >>> 0) !== 0)
                {
                    writeDwordIf(read >>> 0, 0);
                    return fail(ERROR_NOACCESS);
                }
                const pointer = overlapped >>> 0;
                const at = pointer !== 0 && host.ports
                    ? host.ports.offsetOf(pointer)
                    : file.position;
                /** @param {Uint8Array} bytes */
                const deliver = bytes=>{
                    if (bytes.length > 0)
                    {
                        host.writeMemory(buffer >>> 0, bytes);
                    }
                    // A synchronous handle's pointer moves past what was read,
                    // even when an OVERLAPPED said where; an overlapped one's
                    // does not.
                    if (pointer === 0 || !file.overlapped)
                    {
                        file.position = at + bytes.length;
                    }
                    // Written even when nothing was read: a program that checks
                    // it is exactly the one that has reached the end of a file.
                    writeDwordIf(read >>> 0, bytes.length);
                    if (pointer !== 0)
                    {
                        host.ports?.completed(handle >>> 0, bytes.length, pointer);
                    }
                    return 1;
                };

                const bytes = files.read(file.node, at, length >>> 0);
                // A volume backed by a bundle answers with a promise when the
                // bytes are not here yet. The guest cannot wait, so the bridge
                // parks it -- the same way it does for any call that has no
                // answer at the moment it is asked.
                if (typeof (/** @type {any} */ (bytes))?.then !== 'function')
                {
                    return deliver(/** @type {any} */ (bytes));
                }
                const owner = host.currentThread?.() ?? null;
                return /** @type {any} */ (bytes).then(deliver, (/** @type {any} */ e)=>{
                    // The program gets no bytes and goes on: a loss, said.
                    host.divergence?.('ReadFile', `${length >>> 0} bytes of ${file.path} at ${at}`
                        + ` not read: ${e?.message ?? e}`, 'loss');
                    // A read that fails once the thread is parked answers FALSE
                    // long after the error slot was last written, and whatever
                    // is in it belongs to some other call. A caller reading a
                    // stale code acts on a failure that did not happen -- and
                    // no completion is posted either, because none was accepted.
                    host.setLastErrorFor?.(owner, ERROR_IO_DEVICE);
                    return 0;
                });
            },
        },

        /**
         * BOOL WriteFile(HANDLE, LPCVOID, DWORD, LPDWORD lpNumberOfBytesWritten,
         *                LPOVERLAPPED)
         *
         * The standard handles are not files and never become them: a console
         * program writes to the same function as one writing a save file, and
         * this is where the two part company.
         */
        WriteFile: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, buffer, length, written, overlapped])=>{
                const count = length >>> 0;
                writeDwordIf(written >>> 0, 0);
                if (isStandardHandle(handle >>> 0))
                {
                    const bytes = host.readMemory(buffer >>> 0, count);
                    host.writeConsole(handle >>> 0, decodeAnsi(bytes));
                    writeDwordIf(written >>> 0, count);
                    return 1;
                }
                for (const stream of streams)
                {
                    const answer = stream.write(handle, buffer, length, written, false,
                        overlapped);
                    if (answer !== null)
                    {
                        return answer;
                    }
                }
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (!writes(handle, file))
                {
                    return fail(ERROR_ACCESS_DENIED);
                }
                if ((buffer >>> 0) === 0 && count !== 0)
                {
                    writeDwordIf(written >>> 0, 0);
                    return fail(ERROR_INVALID_USER_BUFFER);
                }
                // The guest's own bytes where the memory layer lends them: a
                // volume keeps a copy of what it is written, never the array,
                // and an installer writes gigabytes through here -- read into
                // a copy, then copied again, then stored.
                const bytes = count === 0
                    ? new Uint8Array(0)
                    : host.windowMemory?.(buffer >>> 0, count)
                        ?? host.readMemory(buffer >>> 0, count);
                const pointer = overlapped >>> 0;
                const at = pointer !== 0 && host.ports
                    ? host.ports.offsetOf(pointer)
                    : file.position;
                /** @param {number} stored */
                const deliver = stored=>{
                    // An overlapped write on a handle opened for it leaves the
                    // file pointer where it was; the OVERLAPPED says where.
                    if (pointer === 0 || !file.overlapped)
                    {
                        file.position = at + stored;
                    }
                    // Written even for a zero-length write, which is how a program
                    // asks whether the handle still works.
                    writeDwordIf(written >>> 0, stored);
                    // The same debt an overlapped read owes: a save written through
                    // a pool hangs if the packet its worker waits on never arrives.
                    if (pointer !== 0)
                    {
                        host.ports?.completed(handle >>> 0, stored, pointer);
                    }
                    return 1;
                };
                const stored = (files.writeOrFetch ?? files.write)
                    .call(files, file.node, at, bytes);
                if (typeof stored === 'number')
                {
                    return deliver(stored);
                }
                // Parked like ReadFile while the bundle's blocks arrive.
                const owner = host.currentThread?.() ?? null;
                return /** @type {any} */ (stored.then(deliver, ()=>{
                    host.setLastErrorFor?.(owner, ERROR_IO_DEVICE);
                    return 0;
                }));
            },
        },

        /**
         * BOOL WriteFileGather(HANDLE, FILE_SEGMENT_ELEMENT aSegmentArray[],
         *   DWORD nNumberOfBytesToWrite, LPDWORD lpReserved, LPOVERLAPPED)
         *
         * One transfer at the OVERLAPPED's offset from a page per segment,
         * completed at once and reported once, as an overlapped WriteFile is.
         */
        WriteFileGather: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, segments, length, , overlapped])=>{
                const file = object(handle, 'file');
                if (!file || (overlapped >>> 0) === 0 || !host.ports)
                {
                    return fail(file ? ERROR_INVALID_PARAMETER : ERROR_INVALID_HANDLE);
                }
                if (!writes(handle, file))
                {
                    return fail(ERROR_ACCESS_DENIED);
                }
                const bytes = new Uint8Array(length >>> 0);
                for (let at = 0; at < bytes.length; at += PAGE_SIZE)
                {
                    const page = readDword((segments >>> 0) + at / PAGE_SIZE * 8);
                    bytes.set(host.readMemory(page, Math.min(PAGE_SIZE, bytes.length - at)), at);
                }
                const stored = files.write(file.node, host.ports.offsetOf(overlapped >>> 0), bytes);
                host.ports.completed(handle >>> 0, stored, overlapped >>> 0);
                return 1;
            },
        },

        /**
         * BOOL ReadFileScatter(HANDLE, FILE_SEGMENT_ELEMENT aSegmentArray[],
         *   DWORD nNumberOfBytesToRead, LPDWORD lpReserved, LPOVERLAPPED)
         *
         * The read WriteFileGather's write is the mirror of: a page per segment.
         */
        ReadFileScatter: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, segments, length, , overlapped])=>{
                const file = object(handle, 'file');
                const ports = host.ports;
                if (!file || (overlapped >>> 0) === 0 || !ports)
                {
                    return fail(file ? ERROR_INVALID_PARAMETER : ERROR_INVALID_HANDLE);
                }
                if (!reads(handle, file))
                {
                    return fail(ERROR_ACCESS_DENIED);
                }
                /** @param {Uint8Array} bytes */
                const deliver = bytes=>{
                    for (let at = 0; at < bytes.length; at += PAGE_SIZE)
                    {
                        const page = readDword((segments >>> 0) + at / PAGE_SIZE * 8);
                        host.writeMemory(page, bytes.subarray(at, at + PAGE_SIZE));
                    }
                    ports.completed(handle >>> 0, bytes.length, overlapped >>> 0);
                    return 1;
                };
                const bytes = files.read(file.node, ports.offsetOf(overlapped >>> 0), length >>> 0);
                return typeof (/** @type {any} */ (bytes))?.then === 'function'
                    ? /** @type {Promise<Uint8Array>} */ (bytes).then(deliver)
                    : deliver(/** @type {Uint8Array} */ (bytes));
            },
        },

        /**
         * BOOL ReadFileEx(HANDLE hFile, LPVOID lpBuffer, DWORD nNumberOfBytesToRead,
         *   LPOVERLAPPED lpOverlapped, LPOVERLAPPED_COMPLETION_ROUTINE)
         *
         * Overlapped I/O that reports through a completion routine instead of
         * an event or a port: the transfer is done at the OVERLAPPED's offset,
         * its status and count are written for GetOverlappedResult, and the
         * routine is queued to the calling thread with (error, count,
         * OVERLAPPED) -- it runs at that thread's next alertable wait, never
         * before this returns. hEvent is the program's own to use. A read that
         * starts at the end of the file fails with ERROR_HANDLE_EOF and queues
         * nothing.
         */
        ReadFileEx: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, buffer, length, overlapped, routine])=>{
                const pointer = overlapped >>> 0;
                // A stream that keeps its own operations (a pipe end) queues
                // the routine when its operation ends.
                for (const stream of streams)
                {
                    const answer = pointer === 0 || !host.queueApc ? null
                        : stream.readEx?.(handle, buffer, length, pointer, routine >>> 0) ?? null;
                    if (answer !== null)
                    {
                        return answer;
                    }
                }
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (!reads(handle, file))
                {
                    return fail(ERROR_ACCESS_DENIED);
                }
                if (pointer === 0 || !host.queueApc)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const thread = host.currentThread?.() ?? null;
                /** @param {Uint8Array} bytes */
                const deliver = bytes=>{
                    if (bytes.length === 0 && (length >>> 0) > 0)
                    {
                        // On the thread that asked, which after a wait for
                        // the bytes is no longer the one running.
                        if (thread && host.setLastErrorFor)
                        {
                            host.setLastErrorFor(thread, ERROR_HANDLE_EOF);
                        }
                        else
                        {
                            host.setLastError(ERROR_HANDLE_EOF);
                        }
                        return 0;
                    }
                    if (bytes.length > 0)
                    {
                        host.writeMemory(buffer >>> 0, bytes);
                    }
                    return completeWith(thread, pointer, routine, bytes.length);
                };
                const bytes = files.read(file.node, overlappedPosition(readDword, layout, pointer),
                    length >>> 0);
                if (typeof (/** @type {any} */ (bytes))?.then !== 'function')
                {
                    return deliver(/** @type {any} */ (bytes));
                }
                return /** @type {any} */ (bytes).then(deliver, ()=>{
                    host.setLastErrorFor?.(thread, ERROR_IO_DEVICE);
                    return 0;
                });
            },
        },

        /**
         * BOOL WriteFileEx(HANDLE hFile, LPCVOID lpBuffer, DWORD nNumberOfBytesToWrite,
         *   LPOVERLAPPED lpOverlapped, LPOVERLAPPED_COMPLETION_ROUTINE)
         *
         * ReadFileEx's counterpart: written at the OVERLAPPED's offset, and the
         * routine queued the same way.
         */
        WriteFileEx: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, buffer, length, overlapped, routine])=>{
                const pointer = overlapped >>> 0;
                for (const stream of streams)
                {
                    const answer = pointer === 0 || !host.queueApc ? null
                        : stream.writeEx?.(handle, buffer, length, pointer, routine >>> 0) ?? null;
                    if (answer !== null)
                    {
                        return answer;
                    }
                }
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (!writes(handle, file))
                {
                    return fail(ERROR_ACCESS_DENIED);
                }
                if (pointer === 0 || !host.queueApc)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const count = length >>> 0;
                const bytes = count === 0
                    ? new Uint8Array(0)
                    : host.readMemory(buffer >>> 0, count).slice();
                const stored = files.write(file.node,
                    overlappedPosition(readDword, layout, pointer), bytes);
                return completeWith(host.currentThread?.() ?? null, pointer, routine, stored);
            },
        },

        /**
         * DWORD SetFilePointer(HANDLE, LONG lDistanceToMove,
         *                      PLONG lpDistanceToMoveHigh, DWORD dwMoveMethod)
         *
         * Its return value is ambiguous by design and cannot be fixed here:
         * 0xffffffff is both the failure value and the low half of a legal
         * position. The documented way out is that a failure also sets the last
         * error, so a caller that cares clears the error first and reads it
         * after. That only works if success clears it too, which is why it does
         * so below.
         */
        SetFilePointer: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, distance, highPointer, method])=>{
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE, INVALID_SET_FILE_POINTER);
                }
                // The high half is an in/out parameter: supplied, it carries
                // the top 32 bits of the distance in and the new position out.
                const moveHigh = highPointer >>> 0;
                const wanted = moveHigh === 0
                    ? (distance | 0)
                    : int64(distance, readDword(moveHigh));
                const position = seek(file, wanted, method >>> 0);
                if (position === null)
                {
                    return fail(
                        (method >>> 0) > FILE_END ? ERROR_INVALID_PARAMETER : ERROR_NEGATIVE_SEEK,
                        INVALID_SET_FILE_POINTER);
                }
                file.position = position;
                if (moveHigh !== 0)
                {
                    writeDword(moveHigh, high(position));
                }
                host.setLastError(ERROR_SUCCESS);
                return low(position);
            },
        },

        /**
         * BOOL SetFilePointerEx(HANDLE, LARGE_INTEGER liDistanceToMove,
         *                       PLARGE_INTEGER lpNewFilePointer, DWORD dwMoveMethod)
         *
         * The same seek without the ambiguity: the distance arrives whole (by
         * value, so it occupies two of the argument slots) and the answer comes
         * back through a pointer, leaving the return value free to mean what it
         * says.
         */
        SetFilePointerEx: {
            argBytes: 20,
            quadwords: [1],
            /** @param {number[]} args */
            handler: ([handle, distanceLow, distanceHigh, newPointer, method])=>{
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const position = seek(file, int64(distanceLow, distanceHigh), method >>> 0);
                if (position === null)
                {
                    return fail((method >>> 0) > FILE_END
                        ? ERROR_INVALID_PARAMETER
                        : ERROR_NEGATIVE_SEEK);
                }
                file.position = position;
                if (newPointer !== 0)
                {
                    writeQword(newPointer >>> 0, position);
                }
                return 1;
            },
        },

        /** BOOL SetEndOfFile(HANDLE) */
        SetEndOfFile: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (!writes(handle, file))
                {
                    return fail(ERROR_ACCESS_DENIED);
                }
                // The current position is the new end -- that is the whole
                // function; it takes no size of its own.
                files.truncate(file.node, file.position);
                return 1;
            },
        },

        /**
         * BOOL FlushFileBuffers(HANDLE)
         *
         * Nothing between the guest and the filesystem is buffered, so a file
         * has nothing to push; a pipe end waits for its reader to take what it
         * wrote (`pipes.flush`). Validating the handle is the rest, and a
         * program that flushes an invalid one wants to hear about it.
         */
        FlushFileBuffers: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>host.pipes?.flush(handle)
                ?? (object(handle, 'file') ? 1 : fail(ERROR_INVALID_HANDLE)),
        },

        /**
         * DWORD GetFileSize(HANDLE, LPDWORD lpFileSizeHigh)
         *
         * Ambiguous in the same way as SetFilePointer, and answered the same
         * way: a file whose low size DWORD is 0xffffffff is indistinguishable
         * from a failure except by the last error, so success clears it.
         */
        GetFileSize: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, highPointer])=>{
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE, INVALID_FILE_SIZE);
                }
                const size = sizeOf(file);
                writeDwordIf(highPointer >>> 0, high(size));
                host.setLastError(ERROR_SUCCESS);
                return low(size);
            },
        },

        /** BOOL GetFileSizeEx(HANDLE, PLARGE_INTEGER lpFileSize) */
        GetFileSizeEx: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, pointer])=>{
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (pointer === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                writeQword(pointer >>> 0, sizeOf(file));
                return 1;
            },
        },

        /**
         * BOOL CloseHandle(HANDLE)
         *
         * Every kind of object goes through this one function, so it closes the
         * handle whatever it names and only tells the filesystem when what it
         * named was a file or a search of one.
         */
        CloseHandle: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>(release(handle >>> 0) ? 1 : fail(ERROR_INVALID_HANDLE)),
        },

        /** BOOL DeleteFile(LPCSTR) -- one body, both spellings. */
        DeleteFileA: deleteFile.ansi,
        DeleteFileW: deleteFile.wide,

        /** BOOL MoveFile(LPCSTR lpExistingFileName, LPCSTR lpNewFileName) -- one body, both spellings. */
        MoveFileA: moveFile.ansi,
        MoveFileW: moveFile.wide,

        /** BOOL CopyFile(LPCSTR, LPCSTR, BOOL bFailIfExists) -- one body, both spellings. */
        CopyFileA: copyFile.ansi,
        CopyFileW: copyFile.wide,

        /**
         * BOOL CopyFileEx(LPCSTR, LPCSTR, LPPROGRESS_ROUTINE, LPVOID lpData,
         *                 LPBOOL pbCancel, DWORD dwCopyFlags) -- both spellings.
         */
        CopyFileExA: copyFileEx.ansi,
        CopyFileExW: copyFileEx.wide,

        /** BOOL CreateDirectory(LPCSTR, LPSECURITY_ATTRIBUTES) -- one body, both spellings. */
        CreateDirectoryA: createDirectory.ansi,
        CreateDirectoryW: createDirectory.wide,

        /** BOOL RemoveDirectory(LPCSTR) -- one body, both spellings. */
        RemoveDirectoryA: removeDirectory.ansi,
        RemoveDirectoryW: removeDirectory.wide,

        /** DWORD GetFileAttributes(LPCSTR) -- one body, both spellings. */
        GetFileAttributesA: getFileAttributes.ansi,
        GetFileAttributesW: getFileAttributes.wide,
        GetFileAttributesExA: getFileAttributesEx.ansi,
        GetFileAttributesExW: getFileAttributesEx.wide,

        /** BOOL SetFileAttributes(LPCSTR, DWORD dwFileAttributes) -- one body, both spellings. */
        SetFileAttributesA: setFileAttributes.ansi,
        SetFileAttributesW: setFileAttributes.wide,

        /**
         * DWORD SearchPathA(LPCSTR lpPath, LPCSTR lpFileName, LPCSTR lpExtension,
         *                   DWORD nBufferLength, LPSTR lpBuffer, LPSTR *lpFilePart)
         *
         * A path list given is searched, separated by semicolons; none given
         * is the documented order -- the program's directory, the current
         * one, the system and Windows directories. The extension is added
         * only to a name that has none of its own, and a name already
         * qualified with a directory is looked for where it says. The answer
         * is shaped as GetFullPathName's: the length written, the size
         * needed when the buffer is short, zero and ERROR_FILE_NOT_FOUND when
         * nothing is there.
         */
        SearchPathA: searchPath.ansi,
        SearchPathW: searchPath.wide,

        /** DWORD GetFullPathName(LPCSTR, DWORD, LPSTR, LPSTR *lpFilePart) -- one body, both spellings. */
        GetFullPathNameA: getFullPathName.ansi,
        GetFullPathNameW: getFullPathName.wide,

        /** DWORD GetCurrentDirectory(DWORD nBufferLength, LPSTR lpBuffer) -- one body, both spellings. */
        GetCurrentDirectoryA: getCurrentDirectory.ansi,
        GetCurrentDirectoryW: getCurrentDirectory.wide,

        /** BOOL SetCurrentDirectory(LPCSTR) -- one body, both spellings. */
        SetCurrentDirectoryA: setCurrentDirectory.ansi,
        SetCurrentDirectoryW: setCurrentDirectory.wide,

        /** DWORD GetTempPathA(DWORD nBufferLength, LPSTR lpBuffer) */
        GetTempPathA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([size, buffer])=>writeStringTo(buffer >>> 0, size, tempPath()),
        },

        /**
         * DWORD GetTempPathW(DWORD nBufferLength, LPWSTR lpBuffer)
         *
         * The same answer, written differently from its ANSI twin, as
         * kernel32's path tests pin: what the path does not fill is zeroed --
         * the whole buffer when it is too short, the rest after the path when
         * it is not -- as far as the longest wide path, and no further.
         */
        GetTempPathW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([size, buffer])=>{
                const count = Math.min(size >>> 0, MAX_WIDE_PATH);
                if ((buffer >>> 0) !== 0 && count > 0)
                {
                    host.writeMemory(buffer >>> 0, new Uint8Array(count * 2));
                }
                return writeWideStringTo(buffer >>> 0, size, tempPath());
            },
        },

        /**
         * UINT GetTempFileName(LPCSTR lpPathName, LPCSTR lpPrefixString,
         *                      UINT uUnique, LPSTR lpTempFileName)
         *
         * The name a self-extractor unpacks itself into. Two behaviours here
         * are the program's contract rather than detail, and both are silent
         * when wrong:
         *
         * - **A zero uUnique creates the file.** That is how the caller
         *   reserves the name against anyone else taking it, and a program
         *   that then opens it for writing expects it to exist. With a
         *   non-zero uUnique nothing is created and the name is simply built.
         * - **The number is returned as well as written.** A caller keeps it
         *   to build the next name in a series without asking again.
         *
         * The prefix contributes at most three characters, as Windows does,
         * because the whole name has to fit an 8.3 form; the number is in
         * upper-case hexadecimal before a lower-case `.tmp`, the spelling
         * kernel32's file tests compare byte for byte. One body, both
         * spellings.
         */
        GetTempFileNameA: getTempFileName.ansi,
        GetTempFileNameW: getTempFileName.wide,

        CreateSymbolicLinkA: createSymbolicLink.ansi,
        CreateSymbolicLinkW: createSymbolicLink.wide,
        CreateHardLinkA: createHardLink.ansi,
        CreateHardLinkW: createHardLink.wide,
        ReplaceFileA: replaceFile.ansi,
        ReplaceFileW: replaceFile.wide,
        // kernel32's export of the name with neither suffix, which is the
        // wide call: the name a program written before the A and W forms
        // looks up.
        ReplaceFile: replaceFile.wide,
        /**
         * BOOL MoveFileEx(LPCSTR lpExistingFileName, LPCSTR lpNewFileName,
         *                 DWORD dwFlags) -- one body, both spellings.
         */
        MoveFileExA: moveFileEx.ansi,
        MoveFileExW: moveFileEx.wide,
        MoveFileWithProgressA: moveFileWithProgress.ansi,
        MoveFileWithProgressW: moveFileWithProgress.wide,

        /**
         * void SetFileApisToOEM(void)
         *
         * The ANSI spellings of the file functions take and give names in the
         * OEM page from here on (`fileApisOem`).
         */
        SetFileApisToOEM: {
            argBytes: 0,
            handler: ()=>{
                fileApisOem = true;
                return 0;
            },
        },

        /** void SetFileApisToANSI(void): back to the ANSI page, the default. */
        SetFileApisToANSI: {
            argBytes: 0,
            handler: ()=>{
                fileApisOem = false;
                return 0;
            },
        },

        /** BOOL AreFileApisANSI(void) */
        AreFileApisANSI: {
            argBytes: 0,
            handler: ()=>(fileApisOem ? 0 : 1),
        },

        /** HANDLE FindFirstFile(LPCSTR, LPWIN32_FIND_DATA) -- one body, both spellings. */
        FindFirstFileA: findFirstFile.ansi,
        FindFirstFileW: findFirstFile.wide,

        /**
         * HANDLE FindFirstFileEx(LPCSTR, FINDEX_INFO_LEVELS, LPVOID,
         *   FINDEX_SEARCH_OPS, LPVOID lpSearchFilter, DWORD dwAdditionalFlags)
         */
        FindFirstFileExA: findFirstFileEx.ansi,
        FindFirstFileExW: findFirstFileEx.wide,

        /** BOOL FindNextFile(HANDLE, LPWIN32_FIND_DATA) -- one body, both spellings. */
        FindNextFileA: findNextFile.ansi,
        FindNextFileW: findNextFile.wide,

        /**
         * BOOL FindClose(HANDLE)
         *
         * A search handle is not a file handle: it names no open file, and
         * CloseHandle is not what closes it.
         */
        FindClose: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                if (!object(handle, 'find'))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                host.handles.close(handle >>> 0);
                return 1;
            },
        },

        /** DWORD GetLongPathName(LPCSTR, LPSTR, DWORD) -- one body, both spellings. */
        GetLongPathNameA: getLongPathName.ansi,
        GetLongPathNameW: getLongPathName.wide,

        /**
         * DWORD GetShortPathNameA(LPCSTR, LPSTR, DWORD), and GetShortPathNameW
         *
         * This volume keeps no 8.3 aliases, so a name's short form is the name
         * itself: a program that reopens the file by what it is handed finds
         * it, and only one that counts on the dotted-eight shape sees a
         * difference.
         */
        GetShortPathNameA: getShortPathName.ansi,
        GetShortPathNameW: getShortPathName.wide,

        /**
         * HFILE OpenFile(LPCSTR lpFileName, LPOFSTRUCT lpReOpenBuff, UINT uStyle)
         *
         * The 16-bit call that predates CreateFile, still linked against by
         * runtimes of this era. It is expressed in terms of CreateFile rather
         * than reimplemented, because the two differing about whether a file
         * exists would be worse than either being wrong.
         *
         * OF_EXIST is the reason it is worth having at all: a caller uses it to
         * test for a file without opening one, and gets back a boolean-ish
         * result rather than a handle it would have to close.
         */
        OpenFile: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name, reopen, style])=>{
                const path = pathArgument(name);
                const entry = files.stat(path);
                const flags = style >>> 0;
                const exists = Boolean(entry && entry.exists);

                if (reopen !== 0)
                {
                    // OFSTRUCT: cBytes, fFixedDisk, nErrCode, two reserved
                    // words, then the path as eight-bit text. A caller reads the
                    // path back out of it, so it is filled even on failure.
                    const data = new Uint8Array(OFSTRUCT_SIZE);
                    data[0] = OFSTRUCT_SIZE;
                    data[1] = 1;
                    data.set(encodeAnsi(path.slice(0, OFSTRUCT_PATH_MAX - 1)), OFSTRUCT_PATH);
                    host.writeMemory(reopen >>> 0, data);
                }

                if ((flags & OF_EXIST) !== 0)
                {
                    return exists ? 1 : fail(missing(path), HFILE_ERROR);
                }
                if ((flags & OF_DELETE) !== 0)
                {
                    if (!exists)
                    {
                        return fail(missing(path), HFILE_ERROR);
                    }
                    if (readOnlyFile(entry))
                    {
                        return fail(ERROR_ACCESS_DENIED, HFILE_ERROR);
                    }
                    return files.remove(path) ? 1 : fail(denied(path), HFILE_ERROR);
                }

                const write = (flags & (OF_WRITE | OF_READWRITE)) !== 0;
                const create = (flags & OF_CREATE) !== 0;
                if (!exists && !create)
                {
                    return fail(missing(path), HFILE_ERROR);
                }
                if ((write || create) && readOnlyFile(entry))
                {
                    return fail(ERROR_ACCESS_DENIED, HFILE_ERROR);
                }
                const node = files.open(path,
                    { read: !write, write, create, truncate: create });
                if (!node)
                {
                    return fail(denied(path), HFILE_ERROR);
                }
                host.setLastError(ERROR_SUCCESS);
                return host.handles.open('file',
                    { path, node, read: !write, write, position: 0 });
            },
        },

        /**
         * The file family a sixteen-bit program was written against, which an
         * installer of this era is: a self-extractor writes its payload to a
         * temporary directory with these and not with CreateFile.
         *
         * They are the same files and the same handles as everything else here
         * -- an HFILE is a HANDLE, and Windows lets one be passed where the
         * other is expected. Keeping two kinds would mean a program that opens
         * with `_lopen` and closes with `CloseHandle` leaks, and programs do
         * exactly that.
         *
         * HFILE _lopen(LPCSTR lpPathName, int iReadWrite)
         */
        _lopen: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name, mode])=>{
                const path = pathArgument(name);
                const write = (mode & OF_READWRITE) !== 0 || (mode & OF_WRITE) !== 0;
                // OF_WRITE alone is write-only: a read through it is refused.
                const read = (mode & (OF_READWRITE | OF_WRITE)) !== OF_WRITE;
                const entry = files.stat(path);
                if (!entry || !entry.exists)
                {
                    return fail(missing(path), HFILE_ERROR);
                }
                if (write && readOnlyFile(entry))
                {
                    return fail(ERROR_ACCESS_DENIED, HFILE_ERROR);
                }
                const node = files.open(path, { read, write, create: false });
                if (!node)
                {
                    return fail(denied(path), HFILE_ERROR);
                }
                host.setLastError(ERROR_SUCCESS);
                return host.handles.open('file', { path, node, read, write, position: 0 });
            },
        },

        /**
         * HFILE _lcreat(LPCSTR lpPathName, int iAttribute)
         *
         * Always creates and always truncates, which is the difference from
         * `_lopen`: a self-extractor calls this for every file it unpacks and
         * relies on a second pass finding an empty one rather than the tail of
         * the first. The attribute is the DOS one -- read-only, hidden, system
         * in its low bits -- and the new file carries it, while the handle
         * that made it still writes.
         */
        _lcreat: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name, attribute])=>{
                const path = pathArgument(name);
                const refusal = nameRefusal(ANSI.raw(name), path, true);
                if (refusal !== 0)
                {
                    return fail(refusal, HFILE_ERROR);
                }
                if (readOnlyFile(files.stat(path)))
                {
                    return fail(ERROR_ACCESS_DENIED, HFILE_ERROR);
                }
                const node = files.open(path,
                    { read: true, write: true, create: true, truncate: true });
                if (!node)
                {
                    return fail(denied(path), HFILE_ERROR);
                }
                giveAttributes(path, (attribute >>> 0) & 0x7);
                host.setLastError(ERROR_SUCCESS);
                return host.handles.open('file',
                    { path, node, read: true, write: true, position: 0 });
            },
        },

        /** UINT _lread(HFILE hFile, LPVOID lpBuffer, UINT uBytes) */
        _lread: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, buffer, count])=>{
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE, HFILE_ERROR);
                }
                if (!reads(handle, file))
                {
                    return fail(ERROR_ACCESS_DENIED, HFILE_ERROR);
                }
                const bytes = files.read(file.node, file.position, count >>> 0);
                // A bundle-backed volume can answer with a promise. This family
                // has no overlapped form and no way to say "later", so the
                // caller is parked exactly as the modern spelling parks it.
                const deliver = (/** @type {Uint8Array} */ data)=>{
                    host.writeMemory(buffer >>> 0, data);
                    file.position += data.length;
                    host.setLastError(ERROR_SUCCESS);
                    return data.length;
                };
                return typeof (/** @type {any} */ (bytes))?.then === 'function'
                    ? /** @type {any} */ (bytes).then(deliver)
                    : deliver(/** @type {any} */ (bytes));
            },
        },

        /** UINT _lwrite(HFILE hFile, LPCSTR lpBuffer, UINT uBytes) */
        _lwrite: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, buffer, count])=>{
                const file = object(handle, 'file');
                if (!file || !writes(handle, file))
                {
                    return fail(ERROR_INVALID_HANDLE, HFILE_ERROR);
                }
                const bytes = count === 0
                    ? new Uint8Array(0)
                    : host.readMemory(buffer >>> 0, count >>> 0).slice();
                /** @param {number} stored */
                const deliver = stored=>{
                    file.position += stored;
                    host.setLastError(ERROR_SUCCESS);
                    return stored;
                };
                const stored = (files.writeOrFetch ?? files.write).call(files, file.node,
                    file.position, bytes);
                return typeof stored === 'number'
                    ? deliver(stored)
                    : /** @type {any} */ (stored.then(deliver, ()=>HFILE_ERROR));
            },
        },

        /** LONG _llseek(HFILE hFile, LONG lOffset, int iOrigin) */
        _llseek: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, offset, origin])=>{
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE, HFILE_ERROR);
                }
                // The origins are the same three values SetFilePointer uses,
                // and the offset is signed: seeking backwards from the end is
                // how a program reads a trailer.
                const position = seek(file, offset | 0, origin >>> 0);
                if (position === null)
                {
                    return fail(ERROR_NEGATIVE_SEEK, HFILE_ERROR);
                }
                file.position = position;
                host.setLastError(ERROR_SUCCESS);
                return position;
            },
        },

        /**
         * HFILE _lclose(HFILE hFile)
         *
         * Zero for success, which is the opposite of CloseHandle's convention
         * and the kind of difference that is silent when got wrong: a caller
         * that checks for zero would see every close as a failure.
         *
         * The volume is told, as CloseHandle tells it. A handle closed without
         * its file stays open underneath with its sharing terms, and the next
         * open of the same name for writing -- which is exactly what follows a
         * create-and-close -- is refused as shared with nobody.
         */
        _lclose: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                if (!release(handle >>> 0))
                {
                    return fail(ERROR_INVALID_HANDLE, HFILE_ERROR);
                }
                host.setLastError(ERROR_SUCCESS);
                return 0;
            },
        },

        /**
         * BOOL LockFile(HANDLE, DWORD dwFileOffsetLow, DWORD dwFileOffsetHigh,
         *               DWORD nNumberOfBytesToLockLow, DWORD nNumberOfBytesToLockHigh)
         *
         * An exclusive lock that does not wait.
         */
        LockFile: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, offsetLow, offsetHigh, lengthLow, lengthHigh])=>{
                const answer = lockRange(handle >>> 0, qword(offsetLow, offsetHigh),
                    qword(lengthLow, lengthHigh), true);
                return answer === ERROR_SUCCESS ? 1 : fail(answer);
            },
        },

        /** BOOL UnlockFile(HANDLE, DWORD, DWORD, DWORD, DWORD) */
        UnlockFile: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, offsetLow, offsetHigh, lengthLow, lengthHigh])=>{
                const answer = unlockRange(handle >>> 0, qword(offsetLow, offsetHigh),
                    qword(lengthLow, lengthHigh));
                return answer === ERROR_SUCCESS ? 1 : fail(answer);
            },
        },

        /**
         * BOOL LockFileEx(HANDLE, DWORD dwFlags, DWORD dwReserved,
         *   DWORD nNumberOfBytesToLockLow, DWORD nNumberOfBytesToLockHigh,
         *   LPOVERLAPPED)
         *
         * LockFile's lock at the OVERLAPPED's offset, shared unless
         * LOCKFILE_EXCLUSIVE_LOCK says otherwise. A lock that would have to
         * wait for another handle's is refused rather than waited for: the
         * wait has no end here unless another thread of this process lets go,
         * and a caller told no can retry where one parked for ever cannot.
         */
        LockFileEx: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([handle, flags, reserved, lengthLow, lengthHigh, overlapped])=>{
                if (!object(handle, 'file'))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (reserved !== 0 || overlapped === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const at = overlapped >>> 0;
                const answer = lockRange(handle >>> 0,
                    qword(readDword(at + layout.offset), readDword(at + layout.offsetHigh)),
                    qword(lengthLow, lengthHigh), ((flags >>> 0) & LOCKFILE_EXCLUSIVE_LOCK) !== 0);
                return answer === ERROR_SUCCESS ? 1 : fail(answer);
            },
        },

        /**
         * BOOL UnlockFileEx(HANDLE, DWORD dwReserved, DWORD nNumberOfBytesToUnlockLow,
         *   DWORD nNumberOfBytesToUnlockHigh, LPOVERLAPPED)
         */
        UnlockFileEx: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, reserved, lengthLow, lengthHigh, overlapped])=>{
                if (!object(handle, 'file'))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (reserved !== 0 || overlapped === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const at = overlapped >>> 0;
                const answer = unlockRange(handle >>> 0,
                    qword(readDword(at + layout.offset), readDword(at + layout.offsetHigh)),
                    qword(lengthLow, lengthHigh));
                return answer === ERROR_SUCCESS ? 1 : fail(answer);
            },
        },

        /**
         * BOOL DeviceIoControl(HANDLE hDevice, DWORD dwIoControlCode, LPVOID lpInBuffer,
         *     DWORD nInBufferSize, LPVOID lpOutBuffer, DWORD nOutBufferSize,
         *     LPDWORD lpBytesReturned, LPOVERLAPPED lpOverlapped)
         *
         * The mount manager answers its own codes, as NtDeviceIoControlFile
         * does. Nothing else here is a driver: the volume is a file store,
         * and ERROR_INVALID_FUNCTION is what a driver says of a code it does
         * not handle, so a program asking a disk or a VxD for something
         * takes the documented no.
         */
        ReadDirectoryChangesW: readDirectoryChanges,

        DeviceIoControl: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([handle, code, input, inLength, output, outLength, returned])=>{
                const opened = object(handle, 'file');
                const folder = opened?.directory ? opened : object(handle, 'directory');
                const holder = folder ?? opened;
                if (holder && REPARSE_CONTROLS.has(code >>> 0))
                {
                    const { status, information } = reparseControl(holder.path, code >>> 0,
                        input >>> 0, inLength >>> 0, output >>> 0, outLength >>> 0);
                    if (returned >>> 0 !== 0 && (status >>> 0) < 0xc0000000)
                    {
                        writeDword(returned >>> 0, information);
                    }
                    return status === STATUS_SUCCESS ? (host.setLastError(ERROR_SUCCESS), 1)
                        : fail(toDosError(status));
                }
                if (object(handle, 'device') === null)
                {
                    return fail(ERROR_INVALID_FUNCTION);
                }
                const { status, information } = deviceControl(handle, code, input, inLength,
                    output, outLength);
                if (returned >>> 0 !== 0 && (status >>> 0) < 0xc0000000)
                {
                    writeDword(returned >>> 0, information);
                }
                const error = {
                    [STATUS_SUCCESS]: ERROR_SUCCESS,
                    [STATUS_BUFFER_OVERFLOW]: ERROR_MORE_DATA,
                    [STATUS_INVALID_PARAMETER]: ERROR_INVALID_PARAMETER,
                    [STATUS_OBJECT_NAME_NOT_FOUND]: ERROR_FILE_NOT_FOUND,
                }[status >>> 0] ?? ERROR_INVALID_FUNCTION;
                return error === ERROR_SUCCESS ? 1 : fail(error);
            },
        },

        /**
         * BOOL CancelIo(HANDLE hFile)
         *
         * A file's reads and writes have finished by the time their calls
         * answer -- a parked one answers before its thread runs again -- so
         * on a file the calling thread has nothing outstanding and there is
         * nothing to cancel; a pipe's waiting reads and connects are. A
         * handle that is no file object is refused, as NtCancelIoFile
         * refuses one.
         */
        CancelIo: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                // A pipe's waiting reads and connects are the only I/O here
                // that outlives its call: the calling thread's end cancelled.
                if (host.pipes?.cancel(handle, { thread: host.currentThread?.() }) != null)
                {
                    return 1;
                }
                const kind = isStandardHandle(handle >>> 0) ? 'file'
                    : host.handles.typeOf?.(handle >>> 0);
                return kind && FILE_OBJECTS.has(kind) ? 1 : fail(ERROR_INVALID_HANDLE);
            },
        },

        /**
         * BOOL CancelIoEx(HANDLE hFile, LPOVERLAPPED lpOverlapped)
         *
         * A file's reads and writes have finished by the time their calls
         * return, so there is nothing of a file's left to cancel
         * (ERROR_NOT_FOUND), as Windows answers when the request has already
         * completed. A pipe's waiting operations, the one OVERLAPPED's or all
         * of the handle's, end cancelled.
         */
        CancelIoEx: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, overlapped])=>{
                const cancelled = host.pipes?.cancel(handle, (overlapped >>> 0) === 0 ? {}
                    : { overlapped: overlapped >>> 0 });
                if (cancelled != null)
                {
                    return cancelled > 0 ? 1 : fail(ERROR_NOT_FOUND);
                }
                const kind = isStandardHandle(handle >>> 0) ? 'file'
                    : host.handles.typeOf?.(handle >>> 0);
                return fail(kind && FILE_OBJECTS.has(kind) ? ERROR_NOT_FOUND
                    : ERROR_INVALID_HANDLE);
            },
        },

        /**
         * DWORD GetFinalPathNameByHandleA/W(HANDLE hFile, LPTSTR lpszFilePath,
         *     DWORD cchFilePath, DWORD dwFlags)
         *
         * The length written, its terminator not counted; with too little
         * room, the room it needs, its terminator counted.
         */
        GetFinalPathNameByHandleA: finalPathName(ANSI),
        GetFinalPathNameByHandleW: finalPathName(WIDE),

        /**
         * BOOL SetFileInformationByHandle(HANDLE hFile,
         *     FILE_INFO_BY_HANDLE_CLASS FileInformationClass, LPVOID, DWORD dwBufferSize)
         */
        SetFileInformationByHandle: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, type, from, length])=>
                setInformationByHandle(handle >>> 0, type >>> 0, from >>> 0, length >>> 0),
        },

        /** BOOL GetBinaryTypeA/W(LPCTSTR lpApplicationName, LPDWORD lpBinaryType) */
        GetBinaryTypeA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name, out])=>binaryType(name, out, ANSI),
        },
        GetBinaryTypeW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name, out])=>binaryType(name, out, WIDE),
        },

        // The serial port calls, refused on a machine with no serial port.
        ...createCommFunctions(host),

        // A program rewriting an executable's resources on the volume.
        ...createResourceUpdates({ ...host, fullPath }),
    };

    // The long spellings are the same calls on Win32, where every count is
    // 32 bits: _hread and _hwrite were _lread and _lwrite for a huge pointer.
    return { ...table, _hread: table._lread, _hwrite: table._lwrite };
}
