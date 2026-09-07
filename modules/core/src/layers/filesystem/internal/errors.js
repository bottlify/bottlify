/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The failures this layer reports, named rather than numbered.
 *
 * A numbered Win32 error would be the wrong currency here: the same condition
 * is a different number depending on which API asked (CreateFile answers
 * ERROR_FILE_NOT_FOUND where FindFirstFile answers ERROR_NO_MORE_FILES), so the
 * mapping belongs to the caller that knows which API it is implementing.
 */

export const ErrorCode = {
    /** The text is not a path this layer can address at all. */
    INVALID_PATH: 'INVALID_PATH',
    /** An argument other than the path is out of range. */
    INVALID_PARAMETER: 'INVALID_PARAMETER',
    /** No drive is mounted under that letter. */
    NO_SUCH_DRIVE: 'NO_SUCH_DRIVE',
    /** The final component does not exist. */
    NOT_FOUND: 'NOT_FOUND',
    /** A directory along the way does not exist -- Win32 tells these two apart. */
    PATH_NOT_FOUND: 'PATH_NOT_FOUND',
    ALREADY_EXISTS: 'ALREADY_EXISTS',
    NOT_A_DIRECTORY: 'NOT_A_DIRECTORY',
    IS_A_DIRECTORY: 'IS_A_DIRECTORY',
    DIRECTORY_NOT_EMPTY: 'DIRECTORY_NOT_EMPTY',
    ACCESS_DENIED: 'ACCESS_DENIED',
    /** Another handle on the same file does not permit this access. */
    SHARING_VIOLATION: 'SHARING_VIOLATION',
    /** The path names a reserved device; the caller above answers it. */
    IS_DEVICE: 'IS_DEVICE',
    INVALID_HANDLE: 'INVALID_HANDLE',
};

/**
 * @param {string} code   One of ErrorCode.
 * @param {string} message
 * @returns {Error & { code: string }}
 */
export function fsError(code, message){
    const error = /** @type {Error & { code: string }} */ (new Error(message));
    error.code = code;
    return error;
}
