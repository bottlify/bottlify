/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Directory change notifications: a handle a program waits on to hear that a
 * directory it shows -- a save list, a downloads folder -- has changed.
 *
 * The handle is a waitable object of its own kind: what it waits on is a
 * manual-reset event of the kernel's, so WaitForSingleObject and its family
 * take it as they take any event, and SetEvent does not, as it does not on
 * Windows. The volume says when a name under the directory changes
 * (`vfs.js`'s `watch`), and a change the handle's filter asks about sets
 * the event. It stays set until FindNextChangeNotification asks for the next
 * change; a change that came while it was already set is not lost, but sets
 * it again at once, as the changes Windows buffers between the two calls do.
 */

import { createRefusals } from '../common/refusal.js';
import { untagged } from './handle-tags.js';

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_INVALID_HANDLE = 6;
const ERROR_NOT_SUPPORTED = 50;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_DIRECTORY = 267;

const INVALID_HANDLE_VALUE = 0xffffffff;

/**
 * Every FILE_NOTIFY_CHANGE_ flag: names of files and directories, attributes,
 * size, the three times, and security. A filter of none, or of anything else,
 * is a bad parameter.
 */
export const FILE_NOTIFY_CHANGE_FILE_NAME = 0x001;
export const FILE_NOTIFY_CHANGE_DIR_NAME = 0x002;
export const FILE_NOTIFY_CHANGE_ATTRIBUTES = 0x004;
export const FILE_NOTIFY_CHANGE_SIZE = 0x008;
export const FILE_NOTIFY_CHANGE_LAST_WRITE = 0x010;
const FILE_NOTIFY_CHANGE_ALL = 0x17f;

/** The handle type, which only these calls and the waits accept. */
const CHANGE_NOTIFICATION = 'change-notification';

/** A path's longest reading, in characters. */
const MAX_PATH_READ = 0x8000;

/**
 * @typedef {Object} WatchedVolume
 * @property {(path: string) => { exists: boolean, isDirectory: boolean } | null} stat
 * @property {(path: string, subtree: boolean, filter: number,
 *     changed: () => void, alive: () => boolean) => { close: () => void }} watch
 */

/**
 * @typedef {Object} ChangeHost
 * @property {any} kernel  createEvent, setEvent, resetEvent and the handle table.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(code: number) => void} [setLastError]
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {WatchedVolume} [volume]
 *     The volume the files are on. Without it there is nothing to watch and
 *     the first call is refused.
 */

/**
 * @param {ChangeHost} host
 */
export function createChangeNotifications(host){
    const { kernel } = host;
    const refuse = createRefusals(host);
    const noVolume = refuse('FindFirstChangeNotification', {
        argBytes: 12, answer: INVALID_HANDLE_VALUE, lastError: ERROR_NOT_SUPPORTED,
        why: 'no volume was handed to the change notifications',
    });

    /**
     * What each handle's event is watching, and whether a change came while
     * the event was already set.
     *
     * @type {WeakMap<object, { watch: { close: () => void }, set: boolean, missed: boolean }>}
     */
    const watching = new WeakMap();

    /** @param {number} code @param {number} [answer] */
    const fail = (code, answer = 0)=>{
        host.setLastError?.(code);
        return answer;
    };

    /**
     * A string in guest memory, a unit at a time: a path is short, and a
     * read that stops at its terminator cannot run into a page past it.
     *
     * @param {number} address @param {boolean} wide
     */
    const readText = (address, wide)=>{
        const width = wide ? 2 : 1;
        let text = '';
        for (let at = address; text.length < MAX_PATH_READ; at += width)
        {
            const unit = host.readMemory(at, width);
            const code = wide ? unit[0] | unit[1] << 8 : unit[0];
            if (code === 0)
            {
                break;
            }
            text += String.fromCharCode(code);
        }
        return text;
    };

    /** @param {number} handle */
    const eventOf = handle=>{
        try
        {
            const plain = untagged(handle);
            return kernel.handles.typeOf?.(plain) === CHANGE_NOTIFICATION
                ? kernel.handles.resolve(plain) ?? null
                : null;
        }
        catch (e){
            void e;
            return null;
        }
    };

    /**
     * HANDLE FindFirstChangeNotification(LPCSTR lpPathName, BOOL bWatchSubtree,
     *     DWORD dwNotifyFilter), either width.
     *
     * @param {boolean} wide
     */
    const findFirst = wide=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([pointer, subtree, filter])=>{
            if ((pointer >>> 0) === 0)
            {
                return fail(ERROR_PATH_NOT_FOUND, INVALID_HANDLE_VALUE);
            }
            const asked = filter >>> 0;
            if (asked === 0 || (asked & ~FILE_NOTIFY_CHANGE_ALL) !== 0)
            {
                return fail(ERROR_INVALID_PARAMETER, INVALID_HANDLE_VALUE);
            }
            const { volume } = host;
            if (!volume)
            {
                return noVolume.handler();
            }
            const path = readText(pointer >>> 0, wide).replace(/\//g, '\\');
            const entry = volume.stat(path);
            if (!entry || !entry.exists)
            {
                const slash = path.replace(/\\+$/, '').lastIndexOf('\\');
                const parent = slash <= 0 ? null : volume.stat(path.slice(0, slash));
                return fail(slash <= 0 || parent?.isDirectory
                    ? ERROR_FILE_NOT_FOUND : ERROR_PATH_NOT_FOUND, INVALID_HANDLE_VALUE);
            }
            if (!entry.isDirectory)
            {
                return fail(ERROR_DIRECTORY, INVALID_HANDLE_VALUE);
            }
            const event = kernel.createEvent({ manualReset: true, signalled: false,
                name: `change notification for ${path}` });
            const state = { watch: { close: ()=>{} }, set: false, missed: false };
            state.watch = volume.watch(path, (subtree >>> 0) !== 0, asked, ()=>{
                if (state.set)
                {
                    state.missed = true;
                    return;
                }
                state.set = true;
                kernel.setEvent(event);
            }, ()=>kernel.handles.holds?.(event) ?? true);
            watching.set(event, state);
            return kernel.handles.open(CHANGE_NOTIFICATION, event);
        },
    });

    return {
        FindFirstChangeNotificationA: findFirst(false),
        FindFirstChangeNotificationW: findFirst(true),

        /**
         * BOOL FindNextChangeNotification(HANDLE hChangeHandle): waiting for
         * the next change, which a change that already came answers at once.
         */
        FindNextChangeNotification: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const event = eventOf(handle);
                const state = event ? watching.get(event) : undefined;
                if (!event || !state)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (state.missed)
                {
                    state.missed = false;
                    return 1;
                }
                state.set = false;
                kernel.resetEvent(event);
                return 1;
            },
        },

        /**
         * BOOL FindCloseChangeNotification(HANDLE hChangeHandle): the watch
         * ended and the handle closed. CloseHandle closes it too; the volume
         * then drops the watch the next time a change would reach it.
         */
        FindCloseChangeNotification: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const event = eventOf(handle);
                if (!event)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                watching.get(event)?.watch.close();
                watching.delete(event);
                kernel.handles.close(untagged(handle));
                return 1;
            },
        },
    };
}
