/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a full-screen Direct3D 8 or 9 device does to the windows it is given:
 * the focus window's procedure is the runtime's while the device is full
 * screen, so the runtime hears the application lose and regain the
 * activation before the program does; and the device window is kept the
 * mode's size, and shown above the others (WS_EX_TOPMOST) when it was
 * hidden: by an extended device only from the second device made on it, and
 * then whether hidden or not.
 *
 * Losing the activation (WM_ACTIVATEAPP with FALSE) puts the display back to
 * the registry's mode, minimises a shown device window - above the others,
 * but for an extended device - and loses the device; regaining it brings the
 * device window back, and the device then waits for a Reset; an extended
 * device is not lost but answers that its window is covered meanwhile
 * (S_PRESENT_OCCLUDED), and takes its mode back itself. Windows leaves a
 * minimised window to the taskbar to restore; there being none here,
 * regaining the activation restores it (decision A87). A mode another set
 * under the device (WM_DISPLAYCHANGE) also leaves it waiting for one.
 * SC_RESTORE is carried out by the default procedure before the program hears
 * it. An extended device is never lost. D3DCREATE_NOWINDOWCHANGES leaves both
 * windows to the program. What the runtime's own changes to the focus window
 * make goes to the default procedure, not the program's, WM_DISPLAYCHANGE and
 * WM_ACTIVATEAPP aside. (Wine's d3d8 and d3d9 test_wndproc, test_window_style,
 * test_lost_device.)
 *
 * The procedure given back at the device's last release is the program's,
 * unless the program has set another since: that one stays.
 *
 * DirectDraw's exclusive full-screen level holds its window the same way, with
 * three differences (`announce`): what the runtime does to the window the
 * program hears; taking the level places the window over the mode first and
 * activates it after, above the others and shown only when it was the
 * foreground window, its frame kept; and a mode set while it is held, by
 * anyone, brings the window to the new size before the program hears of the
 * mode. Regaining the activation sets the object's own mode again, and giving
 * the level back takes the window from above the others (Wine's ddraw
 * test_wndproc, test_window_style, test_coop_level_mode_set).
 */

const GWLP_WNDPROC = -4;
const GWL_STYLE = -16;
const WS_VISIBLE = 0x10000000;

const WM_ACTIVATEAPP = 0x001c;
const WM_DISPLAYCHANGE = 0x007e;
const WM_SYSCOMMAND = 0x0112;
const SC_RESTORE = 0xf120;

const SW_SHOW = 5;
const SW_MINIMIZE = 6;
const SW_RESTORE = 9;
const HWND_TOPMOST = 0xffffffff;
const HWND_NOTOPMOST = 0xfffffffe;
const HWND_BROADCAST = 0xffff;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;

/** @param {unknown} value @param {(answer: any) => any} then */
const andThen = (value, then)=>(typeof (/** @type {any} */ (value))?.then === 'function'
    ? /** @type {Promise<unknown>} */ (value).then(then) : then(value));

/**
 * Calls one after another, each waited for when it answers with a promise.
 *
 * @param {(() => unknown)[]} steps
 * @returns {unknown}
 */
const inTurn = steps=>steps.reduce((/** @type {unknown} */ before, step)=>
    andThen(before, ()=>step()), undefined);

/**
 * @typedef {Object} FocusDevice
 * @property {(restorable?: boolean) => void} injectDeviceLoss
 * @property {(covered: boolean) => void} [occlude]
 * @property {string} deviceState  As `DEVICE_STATE`.
 *
 * @typedef {Object} Held
 * @property {FocusDevice} device
 * @property {number} focus
 * @property {number} window   The device window.
 * @property {boolean} changes  Whether the windows are the runtime's to change.
 * @property {boolean} extended
 * @property {{ width: number, height: number }} size
 * @property {boolean} setting  While the mode it set is being told.
 * @property {(() => { bitsPerPixel: number } | null) | undefined} reapply
 *           Sets the device's mode again, and answers how it was found when it
 *           was not the device's.
 * @property {boolean} announce  DirectDraw's: its changes to the windows are the
 *           program's to hear, and the window follows every mode set.
 * @property {(() => unknown) | undefined} regain
 *           DirectDraw's: sets the object's mode again as the application is
 *           active again, telling every window itself.
 */

/**
 * @param {Object} deps
 * @param {(name: string) => { handler: (args: number[]) => unknown } | undefined} deps.user32
 * @param {(name: string, handler: (args: number[]) => unknown) => number} deps.procedure
 *        A guest-callable address that runs `handler` with a window procedure's four arguments.
 * @param {(hwnd: number) => void} [deps.cover]
 *        Makes a window the one a full-screen device presents into: its frame
 *        takes no room.
 * @param {{ LOST: string, NOT_RESET: string, OK: string }} deps.states
 */
export function createFocusWindows({ user32, procedure, cover, states }){
    /** @param {string} name @param {number[]} args */
    const call = (name, args)=>user32(name)?.handler(args) ?? 0;

    /** The devices full screen on each focus window, and its procedure before. */
    /** @type {Map<number, { original: number, devices: Set<Held>, filtering: number }>} */
    const hooked = new Map();
    /** @type {Map<FocusDevice, Held>} */
    const held = new Map();
    let stub = 0;
    /** The device windows an extended device has been made on. */
    /** @type {Set<number>} */
    const madeOn = new Set();
    /** @param {number} hwnd */
    const visible = hwnd=>(Number(call('GetWindowLongA', [hwnd, GWL_STYLE])) & WS_VISIBLE) !== 0;

    /**
     * The runtime's procedure: what the devices on this window make of a
     * message, then the program's own.
     *
     * @param {number[]} args
     */
    const dispatch = ([hwnd, message, wParam, lParam])=>{
        const entry = hooked.get(hwnd >>> 0);
        // What the runtime's own changes to the window make is not the
        // program's to hear, but for a mode change and the application
        // becoming active by them (test_reset_fullscreen).
        if (!entry || (entry.filtering > 0 && (message >>> 0) !== WM_DISPLAYCHANGE
            && (message >>> 0) !== WM_ACTIVATEAPP))
        {
            return call('DefWindowProcA', [hwnd, message, wParam, lParam]);
        }
        const passOn = ()=>call('CallWindowProcA', [entry.original, hwnd, message, wParam, lParam]);
        /** @type {(() => unknown)[]} */
        const before = [];
        for (const one of entry.devices)
        {
            switch (message >>> 0){
                case WM_ACTIVATEAPP:
                    before.push(()=>quietly(one, ()=>activate(one, (wParam >>> 0) !== 0)));
                    break;
                case WM_DISPLAYCHANGE:
                    // The window of an exclusive DirectDraw object is the new
                    // mode's size before the program hears of the mode.
                    if (one.announce)
                    {
                        if (one.changes)
                        {
                            before.push(()=>call('SetWindowPos', [one.window, 0, 0, 0,
                                (lParam >>> 0) & 0xffff, (lParam >>> 16) & 0xffff,
                                SWP_NOACTIVATE | SWP_NOZORDER]));
                        }
                        break;
                    }
                    // The mode the device set itself loses it nothing.
                    if (!one.extended && !one.setting && one.device.deviceState === states.OK)
                    {
                        one.device.injectDeviceLoss(true);
                    }
                    break;
                default:
                    break;
            }
        }
        if ((message >>> 0) === WM_SYSCOMMAND && ((wParam >>> 0) & 0xfff0) === SC_RESTORE
            && [...entry.devices].some(one=>!one.announce))
        {
            before.push(()=>call('DefWindowProcA', [hwnd, message, wParam, lParam]));
        }
        return andThen(inTurn(before), passOn);
    };

    /**
     * Runs the runtime's own changes to a window with what they make sent
     * to the default procedure rather than to the program's, when the
     * window is a focus window.
     *
     * @param {number} hwnd @param {() => unknown} changes
     */
    const filtered = (hwnd, changes)=>{
        const entry = hooked.get(hwnd);
        if (!entry)
        {
            return changes();
        }
        entry.filtering++;
        /** @param {unknown} answer */
        const done = answer=>{
            entry.filtering--;
            return answer;
        };
        /** @type {unknown} */
        let answer;
        try
        {
            answer = changes();
        }
        catch (e){
            done(0);
            throw e;
        }
        return typeof (/** @type {any} */ (answer))?.then === 'function'
            ? /** @type {Promise<unknown>} */ (answer).then(done, e=>{
                done(0);
                throw e;
            }) : done(answer);
    };

    /**
     * The runtime's changes to a device's windows, sent to the default
     * procedure (`filtered`) but for DirectDraw's, which the program hears.
     *
     * @param {Held} one @param {() => unknown} changes
     */
    const quietly = (one, changes)=>(one.announce ? changes() : filtered(one.focus, changes));

    /**
     * A mode the device set, which every window hears of as it hears of a
     * mode ChangeDisplaySettings set, and which loses that device nothing.
     *
     * @param {Held} one @param {{ bitsPerPixel: number } | null | undefined} mode
     */
    const tellMode = (one, mode)=>{
        if (!mode)
        {
            return 0;
        }
        one.setting = true;
        /** @param {unknown} answer */
        const set = answer=>{
            one.setting = false;
            return answer;
        };
        return andThen(call('SendMessageA', [HWND_BROADCAST, WM_DISPLAYCHANGE, mode.bitsPerPixel,
            ((one.size.height & 0xffff) << 16 | one.size.width & 0xffff) >>> 0]), set);
    };

    /**
     * The application losing the activation, or regaining it.
     *
     * @param {Held} one @param {boolean} active
     */
    const activate = (one, active)=>{
        if (active)
        {
            return inTurn([
                // DirectDraw sets its mode again itself.
                ()=>(one.announce ? one.regain?.() ?? 0 : 0),
                // An extended device takes its mode back itself, where
                // another waits for a Reset to.
                ()=>{
                    if (!one.extended)
                    {
                        return 0;
                    }
                    one.device.occlude?.(false);
                    return tellMode(one, one.reapply?.());
                },
                ()=>(one.changes
                    ? (call('IsIconic', [one.window]) !== 0
                        ? call('ShowWindow', [one.window, SW_RESTORE])
                        // DirectDraw's window is the mode's size by its mode.
                        : one.announce ? 0 : call('SetWindowPos', [one.window, 0, 0, 0,
                            one.size.width, one.size.height, SWP_NOACTIVATE | SWP_NOZORDER]))
                    : 0),
                ()=>{
                    if (!one.extended && !one.announce && one.device.deviceState === states.LOST)
                    {
                        one.device.injectDeviceLoss(true);
                    }
                },
            ]);
        }
        return inTurn([
            // The registry's mode, which every window hears of.
            ()=>call('ChangeDisplaySettingsA', [0, 0]),
            // A hidden window stays as it is; an extended device's is not
            // put above the others, and DirectDraw's stays where it was.
            ()=>(one.changes && visible(one.window)
                ? call('ShowWindow', [one.window, SW_MINIMIZE]) : 0),
            ()=>(one.changes && !one.extended && !one.announce ? call('SetWindowPos', [one.window,
                HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE]) : 0),
            ()=>{
                if (one.extended)
                {
                    one.device.occlude?.(true);
                }
                // DirectDraw's surfaces are lost by the activation itself.
                else if (!one.announce)
                {
                    one.device.injectDeviceLoss(false);
                }
            },
        ]);
    };

    /** @param {number} focus */
    const hook = focus=>{
        let entry = hooked.get(focus);
        if (!entry)
        {
            stub ||= procedure('d3d focus window', dispatch);
            entry = { original: 0, devices: new Set(), filtering: 0 };
            hooked.set(focus, entry);
            entry.original = Number(call('SetWindowLongA', [focus, GWLP_WNDPROC, stub])) >>> 0;
        }
        return entry;
    };

    /** @param {Held} one */
    const unhook = one=>{
        const entry = hooked.get(one.focus);
        if (!entry)
        {
            return;
        }
        entry.devices.delete(one);
        if (entry.devices.size > 0)
        {
            return;
        }
        // The program's procedure back, unless it set another meanwhile.
        if ((Number(call('GetWindowLongA', [one.focus, GWLP_WNDPROC])) >>> 0) === stub)
        {
            hooked.delete(one.focus);
            call('SetWindowLongA', [one.focus, GWLP_WNDPROC, entry.original]);
        }
        // DirectDraw remembers the procedure it found, and holds the window
        // again later without setting its own over the program's: the one it
        // gives back at the end is that first one (test_wndproc).
        else if (!one.announce)
        {
            hooked.delete(one.focus);
        }
    };

    return {
        /**
         * A device created, or reset, full screen: its focus window hooked and
         * activated, its device window shown - above the others when it was
         * hidden - unless the program keeps its windows itself. A windowed
         * one lets the focus window go.
         *
         * @param {FocusDevice} device
         * @param {{ focus: number, window: number, fullscreen: boolean,
         *     noWindowChanges: boolean, extended: boolean, width: number,
         *     height: number, created: boolean, mode?: { bitsPerPixel: number } | null,
         *     reapply?: () => { bitsPerPixel: number } | null, announce?: boolean,
         *     regain?: () => unknown }} how
         *        `mode` when the device set a mode other than the one it found;
         *        `reapply` sets it again, for an extended device regaining the
         *        activation.
         * @returns {unknown} a promise while the windows hear of it
         */
        take(device, how){
            const before = held.get(device);
            if (!how.fullscreen)
            {
                if (before)
                {
                    unhook(before);
                    held.delete(device);
                    // DirectDraw's window comes down from above the others,
                    // unless the program keeps its windows.
                    if (before.announce && !how.noWindowChanges)
                    {
                        return call('SetWindowPos', [before.window, HWND_NOTOPMOST, 0, 0, 0, 0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE]);
                    }
                }
                return 0;
            }
            const focus = (how.focus >>> 0) || (how.window >>> 0);
            if (before && before.focus !== focus)
            {
                unhook(before);
            }
            /** @type {Held} */
            const one = before ?? { device, focus, window: how.window >>> 0, changes: false,
                extended: how.extended, size: { width: 0, height: 0 }, setting: false,
                reapply: undefined, announce: false, regain: undefined };
            Object.assign(one, { focus, window: (how.window >>> 0) || focus,
                changes: !how.noWindowChanges, size: { width: how.width, height: how.height },
                reapply: how.reapply, announce: how.announce === true, regain: how.regain });
            held.set(device, one);
            hook(focus).devices.add(one);
            if (one.announce)
            {
                // Over the mode, frame and all. Unless another window of its
                // own thread has the foreground, it is shown and made the
                // foreground window, and above the others when it was that
                // already (test_window_style, test_coop_level_activateapp).
                const foreground = Number(call('GetForegroundWindow', [])) >>> 0;
                const threadOf = (/** @type {number} */ hwnd)=>
                    Number(call('GetWindowThreadProcessId', [hwnd, 0])) >>> 0;
                const own = foreground === one.window;
                const takes = own || foreground === 0
                    || threadOf(foreground) !== threadOf(one.window);
                return inTurn([
                    ()=>(one.changes ? call('SetWindowPos', [one.window, own ? HWND_TOPMOST : 0,
                        0, 0, how.width, how.height, SWP_NOACTIVATE
                        | (takes ? SWP_SHOWWINDOW : 0) | (own ? 0 : SWP_NOZORDER)]) : 0),
                    ()=>(takes ? call('SetForegroundWindow', [focus]) : 0),
                ]);
            }
            // Created or reset, an extended device's window is its own again.
            device.occlude?.(false);
            return inTurn([
                ()=>(how.created ? call('SetForegroundWindow', [focus]) : 0),
                ()=>tellMode(one, how.mode),
                ()=>{
                    if (!one.changes)
                    {
                        return 0;
                    }
                    // The picture is the whole mode, and so is the window.
                    cover?.(one.window);
                    const hidden = !visible(one.window);
                    // Created, an extended device leaves the window it is
                    // first made on where it is, and shows it above the others
                    // every time after; a reset shows a window hidden since.
                    const again = how.extended && how.created
                        ? madeOn.has(one.window) : null;
                    madeOn.add(one.window);
                    const raise = how.created && (again ?? hidden);
                    return inTurn([
                        ()=>filtered(one.focus, ()=>call('SetWindowPos', [one.window,
                            raise ? HWND_TOPMOST : 0, 0, 0, how.width, how.height, SWP_NOACTIVATE
                            | (raise ? SWP_SHOWWINDOW : SWP_NOZORDER)])),
                        ()=>(!how.created && hidden
                            ? filtered(one.focus, ()=>call('ShowWindow', [one.window, SW_SHOW]))
                            : 0),
                    ]);
                },
            ]);
        },

        /**
         * The device's last release: its focus window's procedure given back.
         *
         * @param {FocusDevice} device
         */
        release(device){
            const one = held.get(device);
            if (one)
            {
                held.delete(device);
                unhook(one);
            }
        },
    };
}
