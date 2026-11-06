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
 * device window back, and the device then waits for a Reset. Windows leaves a
 * minimised window to the taskbar to restore; there being none here,
 * regaining the activation restores it (decision A87). A mode another set
 * under the device (WM_DISPLAYCHANGE) also leaves it waiting for one.
 * SC_RESTORE is carried out by the default procedure before the program hears
 * it. An extended device is never lost. D3DCREATE_NOWINDOWCHANGES leaves both
 * windows to the program. What the runtime's own changes to the focus window
 * make goes to the default procedure, not the program's, a WM_DISPLAYCHANGE
 * aside. (Wine's d3d8 and d3d9 test_wndproc, test_window_style,
 * test_lost_device.)
 *
 * The procedure given back at the device's last release is the program's,
 * unless the program has set another since: that one stays.
 */

const GWLP_WNDPROC = -4;
const GWL_STYLE = -16;
const WS_VISIBLE = 0x10000000;

const WM_ACTIVATEAPP = 0x001c;
const WM_DISPLAYCHANGE = 0x007e;
const WM_SYSCOMMAND = 0x0112;
const SC_RESTORE = 0xf120;

const SW_MINIMIZE = 6;
const SW_RESTORE = 9;
const HWND_TOPMOST = 0xffffffff;
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
 * @property {string} deviceState  As `DEVICE_STATE`.
 *
 * @typedef {Object} Held
 * @property {FocusDevice} device
 * @property {number} focus
 * @property {number} window   The device window.
 * @property {boolean} changes  Whether the windows are the runtime's to change.
 * @property {boolean} extended
 * @property {{ width: number, height: number }} size
 */

/**
 * @param {Object} deps
 * @param {(name: string) => { handler: (args: number[]) => unknown } | undefined} deps.user32
 * @param {(name: string, handler: (args: number[]) => unknown) => number} deps.procedure
 *        A guest-callable address that runs `handler` with a window procedure's four arguments.
 * @param {{ LOST: string, NOT_RESET: string, OK: string }} deps.states
 */
export function createFocusWindows({ user32, procedure, states }){
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
        // program's to hear, a mode change aside (wined3d filter_messages).
        if (!entry || (entry.filtering > 0 && (message >>> 0) !== WM_DISPLAYCHANGE))
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
                    before.push(()=>filtered(one.focus, ()=>activate(one, (wParam >>> 0) !== 0)));
                    break;
                case WM_DISPLAYCHANGE:
                    if (!one.extended && one.device.deviceState === states.OK)
                    {
                        one.device.injectDeviceLoss(true);
                    }
                    break;
                default:
                    break;
            }
        }
        if ((message >>> 0) === WM_SYSCOMMAND && ((wParam >>> 0) & 0xfff0) === SC_RESTORE)
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
     * The application losing the activation, or regaining it.
     *
     * @param {Held} one @param {boolean} active
     */
    const activate = (one, active)=>{
        if (active)
        {
            return inTurn([
                ()=>(one.changes
                    ? (call('IsIconic', [one.window]) !== 0
                        ? call('ShowWindow', [one.window, SW_RESTORE])
                        : call('SetWindowPos', [one.window, 0, 0, 0, one.size.width,
                            one.size.height, SWP_NOACTIVATE | SWP_NOZORDER]))
                    : 0),
                ()=>{
                    if (!one.extended && one.device.deviceState === states.LOST)
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
            // put above the others.
            ()=>(one.changes && visible(one.window)
                ? call('ShowWindow', [one.window, SW_MINIMIZE]) : 0),
            ()=>(one.changes && !one.extended ? call('SetWindowPos', [one.window, HWND_TOPMOST,
                0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE]) : 0),
            ()=>{
                if (!one.extended)
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
        hooked.delete(one.focus);
        // The program's procedure back, unless it set another meanwhile.
        if ((Number(call('GetWindowLongA', [one.focus, GWLP_WNDPROC])) >>> 0) === stub)
        {
            call('SetWindowLongA', [one.focus, GWLP_WNDPROC, entry.original]);
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
         *     height: number, created: boolean }} how
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
                extended: how.extended, size: { width: 0, height: 0 } };
            Object.assign(one, { focus, window: (how.window >>> 0) || focus,
                changes: !how.noWindowChanges, size: { width: how.width, height: how.height } });
            held.set(device, one);
            hook(focus).devices.add(one);
            return inTurn([
                ()=>(how.created ? call('SetForegroundWindow', [focus]) : 0),
                ()=>{
                    if (!one.changes)
                    {
                        return 0;
                    }
                    // An extended device leaves the window it is first made on
                    // as it is, and shows it above the others every time after.
                    const again = how.extended && how.created
                        ? madeOn.has(one.window) : null;
                    madeOn.add(one.window);
                    return again ?? !visible(one.window)
                        ? filtered(one.window, ()=>call('SetWindowPos', [one.window, HWND_TOPMOST,
                            0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW]))
                        : 0;
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
