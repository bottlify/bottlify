/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The directory list a dialog keeps in a list box or a combo box: LB_DIR and
 * CB_DIR, which fill one with what a directory holds, and the DlgDir calls
 * built on them -- the file picker of the Windows 3.1 era, still used by
 * programs that never moved to the common dialogs.
 *
 * The listing is the volume every file call uses. An entry is spelt the way
 * the box shows it and DlgDirSelectEx reads it back: a file by its name, a
 * directory in brackets, a drive between dashes in brackets. DlgDirList
 * lists the directories with `*.*` whatever the pattern, so a person can
 * walk into a directory whose name the pattern does not match, and it moves
 * the process's current directory to the one listed.
 */

import { encodeAnsi } from '../kernel32/locale.js';
import { readText } from './unicode.js';

/** DlgDirList's and LB_DIR's kinds of entry. */
export const DDL_READONLY = 0x0001;
export const DDL_HIDDEN = 0x0002;
export const DDL_SYSTEM = 0x0004;
export const DDL_DIRECTORY = 0x0010;
export const DDL_ARCHIVE = 0x0020;
export const DDL_POSTMSGS = 0x2000;
export const DDL_DRIVES = 0x4000;
export const DDL_EXCLUSIVE = 0x8000;

/** FILE_ATTRIBUTE_* bits a directory entry may carry beside its kind. */
const ATTRIBUTE_SYSTEM = 0x0004;
const ATTRIBUTE_ARCHIVE = 0x0020;

const LB_RESETCONTENT = 0x0184;
const LB_DIR = 0x018d;
const LB_GETCURSEL = 0x0188;
const LB_GETTEXT = 0x0189;
const LB_GETTEXTLEN = 0x018a;
const CB_DIR = 0x0145;
const CB_GETCURSEL = 0x0147;
const CB_GETLBTEXT = 0x0148;
const CB_GETLBTEXTLEN = 0x0149;
const CB_RESETCONTENT = 0x014b;

const MAX_PATH = 260;

/** @typedef {import('../kernel32/files.js').FileSystem} FileSystem */

/**
 * Continues with an answer that may still be on its way: a message a
 * program's own procedure answers comes back as a promise.
 *
 * @param {any} value @param {(answer: any) => any} then
 */
const after = (value, then)=>(typeof value?.then === 'function' ? value.then(then) : then(value));

/**
 * A path as the volume takes it: absolute, with `.` and `..` worked out,
 * relative to the current directory -- or to its drive's root for one that
 * starts at a separator, or to the root of a drive named without one.
 *
 * @param {FileSystem} files @param {string} path
 */
export function absolutePath(files, path){
    const written = path.replace(/\//g, '\\');
    const current = files.currentDirectory();
    let rooted;
    if (/^[A-Za-z]:\\/.test(written))
    {
        rooted = written;
    }
    else if (/^[A-Za-z]:/.test(written))
    {
        // A drive without a separator is relative to that drive's own
        // directory: the current one on the current drive, else its root.
        const sameDrive = current.slice(0, 2).toLowerCase() === written.slice(0, 2).toLowerCase();
        rooted = `${sameDrive ? current : written.slice(0, 2)}\\${written.slice(2)}`;
    }
    else if (written.startsWith('\\'))
    {
        rooted = `${current.slice(0, 2)}${written}`;
    }
    else
    {
        rooted = `${current}\\${written}`;
    }
    /** @type {string[]} */
    const parts = [];
    for (const part of rooted.slice(3).split('\\'))
    {
        if (part === '' || part === '.')
        {
            continue;
        }
        if (part === '..')
        {
            parts.pop();
            continue;
        }
        parts.push(part);
    }
    return `${rooted.slice(0, 3)}${parts.join('\\')}`;
}

/**
 * What LB_DIR adds for a path and pattern: the matching entries the kinds
 * asked for allow, spelt as the box shows them, then the drives. `found` is
 * false when the search found nothing at all, which LB_DIR answers with
 * LB_ERR and no drives.
 *
 * Without DDL_EXCLUSIVE a file with no read-only, hidden or system mark is
 * always listed and one with a mark only when that mark is asked for; with
 * it, only the files carrying a mark asked for, or -- when no mark is asked
 * for and no directories or drives either -- the files with none.
 *
 * @param {FileSystem} files @param {number} kinds @param {string} spec
 * @returns {{ found: boolean, items: string[] }}
 */
export function directoryItems(files, kinds, spec){
    const path = absolutePath(files, spec === '' ? '*.*' : spec);
    const cut = path.lastIndexOf('\\');
    const directory = cut <= 2 ? path.slice(0, 3) : path.slice(0, cut);
    const pattern = path.slice(cut + 1) || '*.*';
    const holder = files.stat(directory);
    const entries = holder?.exists && holder.isDirectory
        ? files.list(directory, pattern) ?? [] : [];
    const root = directory.length <= 3;
    // FindFirstFile finds the parent's entry in any directory but a root;
    // the volume does not list it, so it is put back where it would match.
    const parent = !root && (pattern === '*' || pattern === '*.*');
    if (entries.length === 0 && !parent)
    {
        return { found: false, items: [] };
    }
    const fileMarks = kinds & (DDL_READONLY | DDL_HIDDEN | DDL_SYSTEM | DDL_ARCHIVE);
    const exclusive = (kinds & DDL_EXCLUSIVE) !== 0;
    /** @type {string[]} */
    const items = parent && (kinds & DDL_DIRECTORY) !== 0 ? ['[..]'] : [];
    for (const entry of entries)
    {
        if (entry.isDirectory)
        {
            if ((kinds & DDL_DIRECTORY) !== 0 && entry.name !== '.' && entry.name !== '..')
            {
                items.push(`[${entry.name}]`);
            }
            continue;
        }
        const marks = (entry.readOnly ? DDL_READONLY : 0) | (entry.hidden ? DDL_HIDDEN : 0)
            | ((entry.attributes ?? 0) & ATTRIBUTE_SYSTEM ? DDL_SYSTEM : 0)
            | ((entry.attributes ?? 0) & ATTRIBUTE_ARCHIVE ? DDL_ARCHIVE : 0);
        const listed = exclusive
            ? (fileMarks === 0
                ? (kinds & (DDL_DIRECTORY | DDL_DRIVES)) === 0
                    && (marks & (DDL_READONLY | DDL_HIDDEN | DDL_SYSTEM)) === 0
                : (marks & fileMarks) !== 0)
            : (marks & (DDL_READONLY | DDL_HIDDEN | DDL_SYSTEM) & ~kinds) === 0;
        if (listed)
        {
            items.push(entry.name);
        }
    }
    if ((kinds & DDL_DRIVES) !== 0)
    {
        for (let letter = 0; letter < 26; letter++)
        {
            const drive = String.fromCharCode(0x61 + letter);
            if (files.stat(`${drive.toUpperCase()}:\\`)?.exists)
            {
                items.push(`[-${drive}-]`);
            }
        }
    }
    return { found: true, items };
}

/**
 * The text a list item stands for, as DlgDirSelectEx hands it back: a
 * directory as its name and a separator, a drive as its letter and a colon,
 * both answering TRUE; a file as its name, with a dot added to a name with
 * no extension, answering FALSE.
 *
 * @param {string} item
 * @returns {{ text: string, directory: boolean }}
 */
export function selectedPath(item){
    if (item.startsWith('['))
    {
        if (item.startsWith('[-'))
        {
            return { text: `${item.charAt(2)}:`, directory: true };
        }
        return { text: `${item.slice(1, -1)}\\`, directory: true };
    }
    return { text: item.includes('.') ? item : `${item}.`, directory: false };
}

/**
 * @param {Object} options
 * @param {{ readMemory: (address: number, length: number) => Uint8Array,
 *     writeMemory: (address: number, bytes: Uint8Array) => void,
 *     readCString: (address: number, maxLength: number) => string,
 *     files?: FileSystem, allocate?: (bytes: number) => number,
 *     release?: (address: number) => void,
 *     callerThread?: () => unknown,
 *     divergence?: (api: string, detail: string) => void }} options.host
 * @param {(name: string, args: number[], thread?: unknown) => any} options.call
 *        One of user32's own entry points, called as a program calls it.
 */
export function createDirectoryListFunctions({ host, call }){
    /**
     * A string laid down in guest memory for as long as `use` runs, for a
     * message that carries a pointer to one.
     *
     * @param {string} text @param {(address: number) => any} use
     */
    const withString = (text, use)=>{
        const bytes = encodeAnsi(`${text}\0`);
        const at = host.allocate?.(bytes.length) ?? 0;
        if (at === 0)
        {
            return 0;
        }
        host.writeMemory(at, bytes);
        return after(use(at), answer=>{
            host.release?.(at);
            return answer;
        });
    };

    /**
     * Text written to a caller's buffer as lstrcpyn writes it: cut to the
     * room, terminated, in the caller's encoding.
     *
     * @param {number} address @param {string} text @param {number} room @param {boolean} wide
     */
    const writeOut = (address, text, room, wide)=>{
        if ((address >>> 0) === 0 || room <= 0)
        {
            return;
        }
        const cut = text.slice(0, room - 1);
        host.writeMemory(address >>> 0, wide
            ? new Uint8Array(Uint16Array.from(`${cut}\0`, c=>c.charCodeAt(0)).buffer)
            : encodeAnsi(`${cut}\0`));
    };

    /**
     * DlgDirList and DlgDirListComboBox, either spelling.
     *
     * @param {number[]} args @param {boolean} wide @param {boolean} combo
     * @returns {number | Promise<number>}
     */
    const dirList = ([dialog, pathSpec, listId, staticId, kinds], wide, combo)=>{
        const files = host.files;
        if (!files || !host.allocate)
        {
            host.divergence?.('DlgDirList', 'no volume or no memory to list one through');
            return 0;
        }
        const thread = host.callerThread?.();
        const spec = (pathSpec >>> 0) === 0 ? '' : readText(host, pathSpec >>> 0, wide, MAX_PATH);
        let attributes = kinds & ~DDL_POSTMSGS;
        if (attributes === DDL_DRIVES)
        {
            attributes |= DDL_EXCLUSIVE;
        }
        // The directory part becomes the current directory; the pattern is
        // what is left, and what is written back.
        const written = spec.replace(/\//g, '\\');
        const cut = Math.max(written.lastIndexOf('\\'), /^[A-Za-z]:/.test(written) ? 1 : -1);
        let directory = cut === -1 ? '' : written.slice(0, cut + 1);
        let pattern = written.slice(cut + 1);
        if (directory === '' && pattern !== '' && !/[*?]/.test(pattern)
            && files.stat(absolutePath(files, pattern))?.isDirectory)
        {
            directory = pattern;
            pattern = '';
        }
        if (pattern === '')
        {
            pattern = '*.*';
        }
        if (directory !== '')
        {
            const target = absolutePath(files, directory);
            const found = files.stat(target);
            if (!found?.exists || !found.isDirectory)
            {
                return 0;
            }
            files.setCurrentDirectory(target);
        }
        if ((pathSpec >>> 0) !== 0)
        {
            writeOut(pathSpec, pattern, MAX_PATH, wide);
        }
        const send = 'SendMessageA';
        const reset = combo ? CB_RESETCONTENT : LB_RESETCONTENT;
        const dir = combo ? CB_DIR : LB_DIR;
        const fill = ()=>{
            const box = (listId >>> 0) === 0 ? 0 : call('GetDlgItem', [dialog, listId], thread);
            if (box === 0)
            {
                return 0;
            }
            /** @param {number} asked @param {string} text */
            const list = (asked, text)=>withString(text, at=>call(send, [box, dir, asked, at],
                thread));
            return after(call(send, [box, reset, 0, 0], thread), ()=>{
                if ((attributes & DDL_DIRECTORY) === 0)
                {
                    return list(attributes, pattern);
                }
                const folders = ()=>list((attributes & (DDL_DIRECTORY | DDL_DRIVES))
                    | DDL_EXCLUSIVE, '*.*');
                return (attributes & DDL_EXCLUSIVE) !== 0 ? folders()
                    : after(list(attributes & ~(DDL_DIRECTORY | DDL_DRIVES), pattern), folders);
            });
        };
        return after(fill(), ()=>{
            if ((staticId >>> 0) === 0)
            {
                return 1;
            }
            // Shown in lower case, as the Windows 3.1 dialog it comes from
            // showed it.
            return after(withString(files.currentDirectory().toLowerCase(), at=>
                call('SetDlgItemTextA', [dialog, staticId, at], thread)), ()=>1);
        });
    };

    /**
     * DlgDirSelectEx and DlgDirSelectComboBoxEx, either spelling.
     *
     * @param {number[]} args @param {boolean} wide @param {boolean} combo
     * @returns {number | Promise<number>}
     */
    const dirSelect = ([dialog, out, room, listId], wide, combo)=>{
        const thread = host.callerThread?.();
        const box = call('GetDlgItem', [dialog, listId], thread);
        if (box === 0 || !host.allocate)
        {
            return 0;
        }
        /** @param {number} message @param {number} wParam @param {number} lParam */
        const ask = (message, wParam, lParam)=>call('SendMessageA', [box, message, wParam, lParam],
            thread);
        /** @param {number} selected @param {number} length @param {number} at */
        const pick = (selected, length, at)=>after(
            ask(combo ? CB_GETLBTEXT : LB_GETTEXT, selected, at), ()=>{
                const picked = selectedPath(host.readCString(at, length + 1));
                writeOut(out, picked.text, room | 0, wide);
                return picked.directory ? 1 : 0;
            });
        return after(ask(combo ? CB_GETCURSEL : LB_GETCURSEL, 0, 0), selected=>((selected | 0) < 0
            ? 0
            : after(ask(combo ? CB_GETLBTEXTLEN : LB_GETTEXTLEN, selected, 0), length=>
                ((length | 0) < 0 ? 0
                    : withString(' '.repeat(length | 0), at=>pick(selected, length | 0, at))))));
    };

    return {
        /**
         * int DlgDirListA(HWND hDlg, LPSTR lpPathSpec, int nIDListBox,
         *                 int nIDStaticPath, UINT uFileType)
         *
         * The list box filled with what the path's directory holds, that
         * directory made current and shown in the static, the pattern left
         * in lpPathSpec. FALSE for a directory that is not there.
         */
        DlgDirListA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>dirList(args, false, false),
        },
        DlgDirListW: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>dirList(args, true, false),
        },

        /** int DlgDirListComboBoxA(HWND, LPSTR, int nIDComboBox, int, UINT): the same, a combo box. */
        DlgDirListComboBoxA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>dirList(args, false, true),
        },
        DlgDirListComboBoxW: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>dirList(args, true, true),
        },

        /**
         * BOOL DlgDirSelectExA(HWND hwndDlg, LPSTR lpString, int chCount, int idListBox)
         *
         * The selected entry as a path piece: TRUE for a directory or a
         * drive, FALSE for a file -- or for nothing selected, when the
         * buffer is left alone.
         */
        DlgDirSelectExA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>dirSelect(args, false, false),
        },
        DlgDirSelectExW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>dirSelect(args, true, false),
        },

        /** BOOL DlgDirSelectComboBoxExA(HWND, LPSTR, int cchOut, int idComboBox) */
        DlgDirSelectComboBoxExA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>dirSelect(args, false, true),
        },
        DlgDirSelectComboBoxExW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>dirSelect(args, true, true),
        },
    };
}
