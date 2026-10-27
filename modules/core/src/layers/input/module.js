/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createDirectInput, GUID_SysKeyboard, GUID_SysMouse } from './dinput/seam.js';
import { createInputRouter } from './router.js';
import { createDomInput } from './dom.js';
import { createXInput } from './xinput.js';

/**
 * input -- the devices a program reads, and the one way events get in.
 *
 * There are two entirely separate paths a Win32 program can read input
 * through, and a program commonly uses both at once: the message queue, which
 * lives in `win32` because that is where `GetMessage` is, and DirectInput,
 * which a program polls or drains rather than waiting for. This layer owns the
 * second and posts into the first, so that one event reaches a program both
 * ways and the two readings cannot disagree. XInput is answered here too, for
 * the two system libraries no program brings (`xinput.js`).
 *
 * `send` is the whole input side of this module. What it takes is a normalised
 * event -- a physical key, a pointer motion, a button, a focus change -- and
 * nothing about it is a browser's: a page produces those events through
 * `attach`, a test produces them directly, and neither can tell the difference.
 */

/** The input layer's module for one graph; see `defaultModules`. */
export function createInputModule(){
    /**
     * The instance this module object made last, for `diagnostics()` and
     * `dispose()`. Every graph is given module objects of its own
     * (`defaultModules`), so a child's graph built beside its parent's has
     * its own and neither one's going reaches the other's.
     *
     * @type {any}
     */
    let current = null;

    return {
        name: 'input',
        version: '0.2.0',
        requires: /** @type {readonly string[]} */ (['win32', 'bridge', 'memory']),

        /**
         * @param {any} config
         * @param {import('../../system/contract.js').ScopedModuleHost} host
         * @returns {Promise<any>}
         */
        async create(config, host){
            const memory = host.requireApi('memory');
            const win32 = host.requireApi('win32');
            const bridge = host.requireApi('bridge');

            const dinput = createDirectInput({
                memory: {
                    /** @param {number} address @param {number} length */
                    readMemory: (address, length)=>memory.readBytes(address, length),
                    /** @param {number} address @param {Uint8Array} bytes */
                    writeMemory: (address, bytes)=>memory.writeBytes(address, bytes),
                },
                // The guest's clock, for the same reason the sound layer takes one:
                // an event timestamped from a second clock is one a program can
                // order wrongly against everything else it knows the time of.
                now: config?.now ?? (()=>Date.now()),
                publishInterface: config?.publishInterface ?? (()=>0),
                divergence: config?.divergence,
                signal: config?.signal,
                mouseHeld: config?.mouseHeld,
                // Where a mouse in absolute mode starts when it is taken: the
                // cursor, as the router keeps it. Made below; asked only later.
                cursor: ()=>router?.cursor() ?? null,
                // Where a DIDEVICEINSTANCE is written for a program's enumeration
                // callback, and the route into that callback itself. The callback
                // is guest code, so answering an enumeration means running the
                // guest from inside the host call -- the sound seam's own shape.
                allocate: config?.allocate ?? (bytes=>win32.heap().allocate(bytes)),
                callGuest: config?.callGuest
                    ?? ((/** @type {number} */ entry, /** @type {number[]} */ args,
                        /** @type {any} */ thread)=>bridge.callGuest({ entry, args, thread })),
                callerThread: config?.callerThread ?? (()=>bridge.callerThread()),
                // What a window handle names, for SetCooperativeLevel, which
                // wants a top-level window. A build without win32 has no windows
                // to tell apart, and any handle is then taken as one.
                windowKind: config?.windowKind ?? ((/** @type {number} */ hwnd)=>{
                    /** @type {{ hwnd: string, child: boolean }[]} */
                    let listed;
                    try
                    {
                        listed = win32.windows();
                    }
                    catch {
                        return undefined;
                    }
                    const found = listed.find(entry=>Number(entry.hwnd) === hwnd);
                    return found ? (found.child ? 'child' : 'top') : null;
                }),
                // The program's own foreground window, which a device that
                // reads input only in the foreground needs to be acquired. Not
                // the browser's focus: that never reaches the guest.
                foreground: config?.foreground ?? (()=>{
                    try
                    {
                        return win32.activeWindow?.();
                    }
                    catch {
                        return undefined;
                    }
                }),
            });

            const xinput = createXInput();

            // The queue is win32's, and this is the seam it exists for: a keystroke
            // is not a window operation, so it arrives from outside and is posted
            // like any other message.
            //
            // Asked for inside a guard because a build can be assembled without
            // win32, in which case this api is a stub whose every call throws. That
            // build has no windows to post to, so input degrades to DirectInput
            // alone -- which is what "degraded but not broken" means here.
            const queue = (()=>{
                try
                {
                    return win32.queue();
                }
                catch {
                    return null;
                }
            })();

            // Device input is shown to the low-level hooks before anything
            // has it (WH_MOUSE_LL, WH_KEYBOARD_LL, through user32's queue).
            // With none installed an event goes in as it always did, at once.
            // With one, what the event makes -- its messages, characters,
            // DirectInput and raw input -- is held until the hooks have
            // answered, events in the order they came, and an event a hook
            // took away makes nothing. The router has moved the cursor by
            // then, so a hook reads where it is now; a hook of a thread that
            // does not answer holds input for LowLevelHooksTimeout at most.
            /** @type {{ run: () => void, message?: any }[] | null} */
            let holding = null;
            /** The held events not yet let through, or null when none is. @type {Promise<void> | null} */
            let behind = null;
            /** @param {() => void} run @param {any} [message] */
            const effect = (run, message)=>{
                if (holding)
                {
                    holding.push({ run, message });
                    return;
                }
                run();
            };
            /** @param {number} message @returns {'mouse' | 'keyboard' | null} */
            const hookedAs = message=>{
                const KEY_MESSAGES = [0x0100, 0x0101, 0x0104, 0x0105];
                if (KEY_MESSAGES.includes(message))
                {
                    return 'keyboard';
                }
                return message >= 0x0200 && message <= 0x020e ? 'mouse' : null;
            };
            /**
             * One event through the router, held for the hooks when any is installed.
             *
             * @param {import('./router.js').HostInputEvent} event
             */
            const sendDevice = event=>{
                const seam = queue?.lowLevel ?? null;
                const watched = seam !== null && (seam.hooked('mouse') || seam.hooked('keyboard'));
                if (!watched && behind === null)
                {
                    return router.send(event);
                }
                /** @type {{ run: () => void, message?: any }[]} */
                const held = [];
                holding = held;
                let answer;
                try
                {
                    answer = router.send(event);
                }
                finally
                {
                    holding = null;
                }
                const shown = held.filter(each=>each.message && seam !== null
                    && hookedAs(each.message.message) !== null
                    && seam.hooked(/** @type {'mouse' | 'keyboard'} */ (hookedAs(each.message.message))));
                /** @param {number} index @returns {Promise<boolean>} */
                const ask = async index=>{
                    const each = shown[index];
                    if (!each || seam === null)
                    {
                        return false;
                    }
                    const kind = /** @type {'mouse' | 'keyboard'} */ (hookedAs(each.message.message));
                    return ((await seam.show(kind, each.message)) | 0) !== 0 || ask(index + 1);
                };
                const mine = (behind ?? Promise.resolve()).then(()=>ask(0)).then(taken=>{
                    if (!taken)
                    {
                        held.forEach(each=>each.run());
                    }
                }, ()=>held.forEach(each=>each.run())).then(()=>{
                    if (behind === mine)
                    {
                        behind = null;
                    }
                });
                behind = mine;
                return answer;
            };

            const router = createInputRouter({
                /** @param {any} message */
                post: message=>effect(()=>queue?.post(message), message),
                /** @param {number} character @param {number} lParam */
                compose: (character, lParam)=>effect(()=>queue?.compose(character, lParam)),
                /** @param {import('./dinput/devices.js').InputEvent} event */
                device: event=>effect(()=>dinput.post(event)),
                now: config?.now ?? (()=>Date.now()),
                // Which window input is for. Handed down because only whoever
                // assembled the process knows which one a person is looking at.
                target: config?.foreground ?? (()=>0),
                bounds: config?.bounds ?? null,
                // Where a press is written down. Handed in because only whoever
                // assembled the process has a journal, and because a build that
                // wants no record should pay for none.
                trace: config?.trace,
                // Where the cursor is on the viewport, for a page drawing it
                // over a locked pointer.
                moved: config?.cursorMoved,
                // A device a program holds exclusively is read through
                // DirectInput alone, and the window hears nothing of it.
                exclusive: kind=>dinput.exclusive(kind),
                // The device's own report, for a program that registered for raw
                // input; whether one did, and which window hears it, is user32's.
                rawInput: report=>effect(()=>{
                    try
                    {
                        win32.rawInput?.(report);
                    }
                    catch {
                        // No win32: no window to post WM_INPUT to.
                    }
                }),
                // Pasted text is the clipboard's, which is win32's; a build
                // without it has no clipboard to paste into.
                paste: text=>effect(()=>{
                    try
                    {
                        win32.paste(text);
                    }
                    catch {
                        // No win32: nothing to paste into.
                    }
                }),
            });

            /** @type {ReturnType<typeof createDomInput> | null} */
            let attached = null;

            current = {
                /**
                 * The libraries, keyed as an import descriptor names them. The
                 * assembling caller merges these with win32's and hands the lot to
                 * the loader.
                 */
                libraries: ()=>({ ...dinput.libraries, ...xinput.libraries }),

                /**
                 * The numbers those libraries export by, where Windows pins them:
                 * a library a program imports from by ordinal is synthesised with
                 * these, and xinput1_4 has two functions found by number alone.
                 */
                ordinals: ()=>({ ...xinput.ordinals }),

                /**
                 * Feeds one host event in: it becomes a window message and a change
                 * of DirectInput state, both or neither -- except that a device a
                 * program holds exclusively through DirectInput reaches it there
                 * alone, as on Windows, where the window's messages then stop.
                 *
                 * @param {import('./router.js').HostInputEvent} event
                 */
                send: event=>sendDevice(event),

                /**
                 * Feeds one event straight to a DirectInput device, in that
                 * device's own codes. Returns false when nothing took it -- no
                 * device created, or one that is not acquired -- which is a fact
                 * worth having rather than a failure: it says the program is not
                 * reading this device right now.
                 *
                 * @param {import('./dinput/devices.js').InputEvent} event
                 */
                post: event=>dinput.post(event),

                /**
                 * Listens to a canvas. Only one at a time: two viewports feeding
                 * one guest is two people playing one keyboard.
                 *
                 * @param {any} canvas
                 * @param {{ pointerLock?: boolean, listen?: boolean }} [options]
                 *     `listen: false` takes the canvas as the picture only -- an
                 *     OffscreenCanvas in a worker has no events of its own, and
                 *     the page that has them feeds `send` from where they happen.
                 */
                attach(canvas, options){
                    attached?.detach();
                    attached = null;
                    // The canvas's own pixels are the picture, so they are both
                    // what a pointer position is measured in and what the cursor
                    // may not leave. One number rather than two.
                    router.confineTo(()=>({ width: canvas.width, height: canvas.height }));
                    if (options?.listen === false)
                    {
                        return null;
                    }
                    attached = createDomInput({
                        canvas,
                        /** @param {import('./router.js').HostInputEvent} event */
                        send: event=>router.send(event),
                        pointerLock: options?.pointerLock ?? false,
                    });
                    return attached;
                },
                detach(){
                    attached?.detach();
                    attached = null;
                    router.confineTo(null);
                },

                /**
                 * Reads whatever has no events of its own. A gamepad is a snapshot
                 * API, so somebody has to ask; this is that call, and it does
                 * nothing when no canvas is attached.
                 */
                poll(){
                    attached?.poll();
                },

                /**
                 * A phone's keyboard, typing into the attached canvas's game;
                 * from inside a touch's handler (`dom.js`). False with no canvas.
                 */
                showKeyboard: ()=>attached?.showKeyboard() ?? false,
                hideKeyboard: ()=>attached?.hideKeyboard(),
                keyboardShown: ()=>attached?.keyboardShown() ?? false,

                /**
                 * The cursor's coordinate space, as the program declared it with
                 * ClipCursor. Passed straight to the router, which scales pointer
                 * motion into it.
                 *
                 * @param {{ left: number, top: number, right: number, bottom: number } | null} rect
                 */
                clip: rect=>router.clip(rect),

                /**
                 * Where the program put the cursor with SetCursorPos, in that same
                 * space. From then on pointer motion is relative to it.
                 *
                 * @param {number} x @param {number} y
                 */
                place: (x, y)=>router.place(x, y),
                /** @param {boolean} visible */
                cursorShown: visible=>router.shown(visible),

                /** @param {number} vk */
                keyState: vk=>router.keyState(vk),
                /** @param {number} vk */
                asyncKeyState: vk=>router.asyncKeyState(vk),
                keyboardState: ()=>router.keyboardState(),
                /** @param {Uint8Array} bytes */
                setKeyboardState: bytes=>router.setKeyboardState(bytes),
                cursor: ()=>router.cursor(),
                pad: ()=>router.pad(),

                /** @param {string} guid */
                device: guid=>dinput.device(guid),

                dinput: ()=>dinput,
                xinput: ()=>xinput,
                router: ()=>router,
            };
            return current;
        },

        /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
        diagnostics(){
            return {
                name: 'input',
                version: '0.2.0',
                status: current ? 'ready' : 'created',
                metrics: {
                    libraries: current ? Object.keys(current.libraries()) : [],
                    ...(current ? current.dinput().diagnostics() : {}),
                    ...(current ? current.router().diagnostics() : {}),
                    // How often a program asked XInput about a pad, every answer
                    // being that there is none.
                    ...(current ? { xinput: current.xinput().diagnostics() } : {}),
                },
            };
        },

        async dispose(){
            current?.detach();
            current = null;
        },
    };
}

/** One graph's worth, for the boundary check and for a test that builds this layer alone. */
export const inputModule = createInputModule();

export { GUID_SysKeyboard, GUID_SysMouse };
