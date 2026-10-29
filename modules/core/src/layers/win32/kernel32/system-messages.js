/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What FormatMessage's FORMAT_MESSAGE_FROM_SYSTEM finds: the system's message
 * table, for the error codes a program meets, in Windows' own wording and
 * with the CR LF every entry of a message table ends in -- a program that
 * shows one strips it, and one that compares a message finds the text it
 * would find on a real machine. An HRESULT of FACILITY_WIN32 is its code's.
 *
 * @type {ReadonlyMap<number, string>}
 */
export const SYSTEM_MESSAGES = new Map(/** @type {[number, string][]} */ ([
    [0, 'The operation completed successfully.'],
    [1, 'Incorrect function.'],
    [2, 'The system cannot find the file specified.'],
    [3, 'The system cannot find the path specified.'],
    [4, 'The system cannot open the file.'],
    [5, 'Access is denied.'],
    [6, 'The handle is invalid.'],
    [7, 'The storage control blocks were destroyed.'],
    [8, 'Not enough memory resources are available to process this command.'],
    [9, 'The storage control block address is invalid.'],
    [10, 'The environment is incorrect.'],
    [11, 'An attempt was made to load a program with an incorrect format.'],
    [12, 'The access code is invalid.'],
    [13, 'The data is invalid.'],
    [14, 'Not enough memory resources are available to complete this operation.'],
    [15, 'The system cannot find the drive specified.'],
    [16, 'The directory cannot be removed.'],
    [17, 'The system cannot move the file to a different disk drive.'],
    [18, 'There are no more files.'],
    [19, 'The media is write protected.'],
    [20, 'The system cannot find the device specified.'],
    [21, 'The device is not ready.'],
    [22, 'The device does not recognize the command.'],
    [23, 'Data error (cyclic redundancy check).'],
    [24, 'The program issued a command but the command length is incorrect.'],
    [25, 'The drive cannot locate a specific area or track on the disk.'],
    [26, 'The specified disk or diskette cannot be accessed.'],
    [27, 'The drive cannot find the sector requested.'],
    [28, 'The printer is out of paper.'],
    [29, 'The system cannot write to the specified device.'],
    [30, 'The system cannot read from the specified device.'],
    [31, 'A device attached to the system is not functioning.'],
    [32, 'The process cannot access the file because it is being used by another process.'],
    [33, 'The process cannot access the file because another process has locked a portion of '
        + 'the file.'],
    [36, 'Too many files opened for sharing.'],
    [38, 'Reached the end of the file.'],
    [39, 'The disk is full.'],
    [50, 'The request is not supported.'],
    [53, 'The network path was not found.'],
    [80, 'The file exists.'],
    [82, 'The directory or file cannot be created.'],
    [87, 'The parameter is incorrect.'],
    [109, 'The pipe has been ended.'],
    [110, 'The system cannot open the device or file specified.'],
    [111, 'The file name is too long.'],
    [112, 'There is not enough space on the disk.'],
    [120, 'This function is not supported on this system.'],
    [122, 'The data area passed to a system call is too small.'],
    [123, 'The filename, directory name, or volume label syntax is incorrect.'],
    [126, 'The specified module could not be found.'],
    [127, 'The specified procedure could not be found.'],
    [128, 'There are no child processes to wait for.'],
    [145, 'The directory is not empty.'],
    [161, 'The specified path is invalid.'],
    [170, 'The requested resource is in use.'],
    [183, 'Cannot create a file when that file already exists.'],
    [193, '%1 is not a valid Win32 application.'],
    [206, 'The filename or extension is too long.'],
    [230, 'The pipe state is invalid.'],
    [231, 'All pipe instances are busy.'],
    [232, 'The pipe is being closed.'],
    [233, 'No process is on the other end of the pipe.'],
    [234, 'More data is available.'],
    [258, 'The wait operation timed out.'],
    [259, 'No more data is available.'],
    [267, 'The directory name is invalid.'],
    [288, 'Attempt to release mutex not owned by caller.'],
    [298, 'Too many posts were made to a semaphore.'],
    [299, 'Only part of a ReadProcessMemory or WriteProcessMemory request was completed.'],
    [317, 'The system cannot find message text for message number 0x%1 in the message file '
        + 'for %2.'],
    [487, 'Attempt to access invalid address.'],
    [534, 'Arithmetic result exceeded 32 bits.'],
    [995, 'The I/O operation has been aborted because of either a thread exit or an '
        + 'application request.'],
    [996, 'Overlapped I/O event is not in a signaled state.'],
    [997, 'Overlapped I/O operation is in progress.'],
    [998, 'Invalid access to memory location.'],
    [1001, 'Recursion too deep; the stack overflowed.'],
    [1004, 'Invalid flags.'],
    [1008, 'An attempt was made to reference a token that does not exist.'],
    [1011, 'The configuration registry key could not be opened.'],
    [1012, 'The configuration registry key could not be read.'],
    [1013, 'The configuration registry key could not be written.'],
    [1060, 'The specified service does not exist as an installed service.'],
    [1113, 'No mapping for the Unicode character exists in the target multi-byte code page.'],
    [1114, 'A dynamic link library (DLL) initialization routine failed.'],
    [1150, 'The specified program requires a newer version of Windows.'],
    [1155, 'No application is associated with the specified file for this operation.'],
    [1168, 'Element not found.'],
    [1223, 'The operation was canceled by the user.'],
    [1400, 'Invalid window handle.'],
    [1401, 'Invalid menu handle.'],
    [1402, 'Invalid cursor handle.'],
    [1407, 'Cannot find window class.'],
    [1410, 'Class already exists.'],
    [1411, 'Class does not exist.'],
    [1413, 'Invalid index.'],
    [1450, 'Insufficient system resources exist to complete the requested service.'],
    [1813, 'The specified resource type cannot be found in the image file.'],
    [1814, 'The specified resource name cannot be found in the image file.'],
    [1815, 'The specified resource language ID cannot be found in the image file.'],
    [0x80004001, 'Not implemented'],
    [0x80004002, 'No such interface supported'],
    [0x80004003, 'Invalid pointer'],
    [0x80004004, 'Operation aborted'],
    [0x80004005, 'Unspecified error'],
    [0x8000ffff, 'Catastrophic failure'],
    [0x80040154, 'Class not registered'],
    [0x800401f0, 'CoInitialize has not been called.'],
    [0x800b0100, 'No signature was present in the subject.'],
    [0x80092009, 'Cannot find object or property.'],
]).map(([code, text])=>[code, `${text}\r\n`]));

/**
 * A system message's text for a code, or null where the table has none.
 *
 * @param {number} code
 */
export function systemMessage(code){
    const direct = SYSTEM_MESSAGES.get(code >>> 0);
    if (direct !== undefined)
    {
        return direct;
    }
    // FACILITY_WIN32: 0x8007xxxx is Win32 error xxxx.
    return (code >>> 16) === 0x8007 ? SYSTEM_MESSAGES.get(code & 0xffff) ?? null : null;
}
