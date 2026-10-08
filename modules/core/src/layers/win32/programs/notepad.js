/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * notepad.exe: a text file shown in a window of its own until the window is
 * closed.
 *
 * A setup shows its readme by starting `C:\WINDOWS\Notepad.exe readme.txt`,
 * or by asking the shell to open a .txt, which is the same program. What it
 * needs is that program: a window titled "readme.txt - Notepad" holding the
 * text, which the person reads, scrolls and closes, and a process that ends
 * then, which a setup waiting on it goes on after.
 *
 * Everything is a call a program could make: the file read through CreateFile
 * and ReadFile, the window a frame of its own class -- DefWindowProc its
 * procedure -- with an edit control filling its client area, and a message
 * loop that runs until the frame is gone. Editing, saving
 * and printing are not offered; `/p` (print) is refused by name.
 */

import { argumentsOf } from './command-line.js';
import { decodeAnsi } from '../kernel32/locale.js';

const GENERIC_READ = 0x80000000;
const FILE_SHARE_READ = 0x1;
const OPEN_EXISTING = 3;
const INVALID_HANDLE_VALUE = 0xffffffff;

const WS_OVERLAPPEDWINDOW = 0x00cf0000;
const WS_VISIBLE = 0x10000000;
const WS_CHILD = 0x40000000;
const WS_VSCROLL = 0x00200000;
const WS_HSCROLL = 0x00100000;
const WS_EX_CLIENTEDGE = 0x00000200;
const ES_MULTILINE = 0x0004;
const ES_AUTOVSCROLL = 0x0040;
const ES_AUTOHSCROLL = 0x0080;
/** The frame's class, as Notepad names it. */
const FRAME_CLASS = 'Notepad';
/** WNDCLASSW, as RegisterClassW reads it. */
const WNDCLASSW = Object.freeze({ lpfnWndProc: 4, hInstance: 16, hCursor: 24,
    hbrBackground: 28, lpszClassName: 36, SIZE: 40 });
const IDC_ARROW = 32512;
const COLOR_WINDOW = 5;
const CW_USEDEFAULT = 0x80000000;
const EM_SETLIMITTEXT = 0x00c5;
const WM_SETTEXT = 0x000c;
const WM_QUIT = 0x0012;
const PM_REMOVE = 0x0001;
const QS_ALLINPUT = 0x04ff;
const MB_ICONEXCLAMATION = 0x30;

/** How long the loop waits for a message before it looks whether the window is still there. */
const IDLE_WAIT_MS = 250;
/** MSG's size, and where its message field is. */
const MSG_SIZE = 28;
const MSG_MESSAGE = 4;

/**
 * A text file's bytes as its text: UTF-16 or UTF-8 when it opens with that
 * encoding's byte order mark, the ANSI code page otherwise, as Notepad reads
 * one -- with its lines ended CR LF, which is what an edit control breaks at.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function textOfFile(bytes){
    let text;
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
    {
        text = new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }
    else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    {
        text = new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    else
    {
        text = decodeAnsi(bytes);
    }
    return text.replace(/\r?\n/g, '\r\n');
}

/**
 * The file a Notepad command line names: the rest of the line, its quotes
 * taken off, as Notepad reads it -- a path with spaces needs none. Null for
 * none; `print` for a `/p` line.
 *
 * @param {string} line  The arguments after argv[0].
 * @returns {{ path: string | null, print: boolean }}
 */
export function parseNotepad(line){
    let rest = line.trim();
    const print = /^\/p(\s|$)/i.test(rest);
    if (print)
    {
        rest = rest.slice(2).trim();
    }
    const path = rest.replace(/^"(.*)"$/, '$1').trim();
    return { path: path === '' ? null : path, print };
}

/**
 * Runs Notepad over the process's command line; its answer is the exit code.
 *
 * @param {import('./msiexec.js').ProgramContext} context
 * @returns {Promise<number>}
 */
export async function runNotepad(context){
    const { call, wide } = context;
    const plan = parseNotepad(argumentsOf(context.commandLine));
    if (plan.print)
    {
        await context.message('Printing is not available on this machine.', 'Notepad',
            MB_ICONEXCLAMATION);
        return 0;
    }

    let text = '';
    let title = 'Untitled';
    if (plan.path !== null)
    {
        const read = await readText(context, plan.path);
        if (read === null)
        {
            await context.message(`Cannot find the ${plan.path} file.`, 'Notepad',
                MB_ICONEXCLAMATION);
        }
        else
        {
            text = read;
            title = plan.path.slice(Math.max(plan.path.lastIndexOf('\\'),
                plan.path.lastIndexOf('/')) + 1);
        }
    }

    // The frame's class is the program's own, with DefWindowProc for its
    // procedure: the frame is moved, activated and closed as any window is,
    // and nothing in it is the program's to answer -- the edit control is.
    const instance = await call('KERNEL32.dll', 'GetModuleHandleW', [0]);
    // Loaded rather than looked up: the image imports nothing but the
    // engine's own library, so USER32 may not be in the process yet.
    const user32 = await call('KERNEL32.dll', 'LoadLibraryW', [wide('USER32.dll')]);
    const fields = new DataView(new ArrayBuffer(WNDCLASSW.SIZE));
    fields.setUint32(WNDCLASSW.lpfnWndProc, await call('KERNEL32.dll', 'GetProcAddress',
        [user32, context.ansi('DefWindowProcW')]), true);
    fields.setUint32(WNDCLASSW.hInstance, instance, true);
    fields.setUint32(WNDCLASSW.hCursor, await call('USER32.dll', 'LoadCursorW',
        [0, IDC_ARROW]), true);
    fields.setUint32(WNDCLASSW.hbrBackground, COLOR_WINDOW + 1, true);
    fields.setUint32(WNDCLASSW.lpszClassName, wide(FRAME_CLASS), true);
    await call('USER32.dll', 'RegisterClassW', [context.bytes(new Uint8Array(fields.buffer))]);
    const frame = await call('USER32.dll', 'CreateWindowExW', [0, wide(FRAME_CLASS),
        wide(`${title} - Notepad`), WS_OVERLAPPEDWINDOW | WS_VISIBLE,
        CW_USEDEFAULT, CW_USEDEFAULT, 640, 480, 0, 0, instance, 0]);
    if (frame === 0)
    {
        return 1;
    }
    const rect = context.block(16);
    await call('USER32.dll', 'GetClientRect', [frame, rect]);
    const client = new DataView(context.read(rect, 16).buffer);
    const edit = await call('USER32.dll', 'CreateWindowExW', [WS_EX_CLIENTEDGE, wide('EDIT'),
        0, WS_CHILD | WS_VISIBLE | WS_VSCROLL | WS_HSCROLL | ES_MULTILINE | ES_AUTOVSCROLL
            | ES_AUTOHSCROLL,
        0, 0, client.getInt32(8, true), client.getInt32(12, true), frame, 1, 0, 0]);
    if (edit !== 0)
    {
        // Notepad lifts the edit control's limit: a readme runs past 30,000.
        await call('USER32.dll', 'SendMessageW', [edit, EM_SETLIMITTEXT, 0, 0]);
        await call('USER32.dll', 'SendMessageW', [edit, WM_SETTEXT, 0, wide(text)]);
        await call('USER32.dll', 'SetFocus', [edit]);
    }

    // The program's message loop, for as long as its window stands.
    const message = context.block(MSG_SIZE);
    while (await call('USER32.dll', 'IsWindow', [frame]) !== 0)
    {
        if (await call('USER32.dll', 'PeekMessageW', [message, 0, 0, 0, PM_REMOVE]) !== 0)
        {
            if (new DataView(context.read(message + MSG_MESSAGE, 4).buffer)
                .getUint32(0, true) === WM_QUIT)
            {
                break;
            }
            await call('USER32.dll', 'TranslateMessage', [message]);
            await call('USER32.dll', 'DispatchMessageW', [message]);
            continue;
        }
        await call('USER32.dll', 'MsgWaitForMultipleObjects',
            [0, 0, 0, IDLE_WAIT_MS, QS_ALLINPUT]);
    }
    return 0;
}

/**
 * A file's text, read as the program reads it; null when it cannot be opened.
 *
 * @param {import('./msiexec.js').ProgramContext} context @param {string} path
 * @returns {Promise<string | null>}
 */
async function readText(context, path){
    const { call } = context;
    const handle = await call('KERNEL32.dll', 'CreateFileW', [context.wide(path), GENERIC_READ,
        FILE_SHARE_READ, 0, OPEN_EXISTING, 0, 0]);
    if (handle === INVALID_HANDLE_VALUE)
    {
        return null;
    }
    try
    {
        const size = await call('KERNEL32.dll', 'GetFileSize', [handle, 0]);
        if (size === INVALID_HANDLE_VALUE)
        {
            return null;
        }
        const buffer = context.block(Math.max(size, 1));
        const done = context.block(4);
        if (await call('KERNEL32.dll', 'ReadFile', [handle, buffer, size, done, 0]) === 0)
        {
            return null;
        }
        const count = new DataView(context.read(done, 4).buffer).getUint32(0, true);
        return textOfFile(context.read(buffer, count));
    }
    finally
    {
        await call('KERNEL32.dll', 'CloseHandle', [handle]);
    }
}
