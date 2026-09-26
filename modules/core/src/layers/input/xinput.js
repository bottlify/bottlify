/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * XInput, as Windows answers it with no controller plugged in.
 *
 * xinput9_1_0.dll (Vista's) and xinput1_4.dll (Windows 8's) are system
 * libraries rather than part of the DirectX redistributable, so no file of
 * either comes with a program or sits on the system volume, and a program
 * that imports XInputGetState from one has nowhere else to be answered. An
 * import nothing answers stops the process on its first call.
 *
 * What is answered is the truth about this machine: there is no pad in any
 * of the four slots. The page's gamepad is kept by the router and nothing
 * reads it yet, so reporting one here would be a pad that never moves. Each
 * call checks its arguments first, as Wine's xinput tests show Windows does:
 * a user index past the four, or a null structure, is ERROR_BAD_ARGUMENTS
 * whether or not anything is connected. Everything else is
 * ERROR_DEVICE_NOT_CONNECTED, with the caller's structure left as it was --
 * the answer every program is written to take, since it is what a player
 * without a pad gets.
 *
 * The two libraries export different sets, and each is given its own: 9.1.0
 * has no XInputEnable, keystrokes or battery, and 1.4 dropped
 * XInputGetDSoundAudioDeviceGuids (both per Wine's .spec files, which its
 * tests hold to on Windows).
 */

const ERROR_BAD_ARGUMENTS = 160;
const ERROR_DEVICE_NOT_CONNECTED = 1167;

/** The four user slots, and the "any of them" GetKeystroke also takes. */
const XUSER_MAX_COUNT = 4;
const XUSER_INDEX_ANY = 0xff;
const XINPUT_FLAG_GAMEPAD = 0x00000001;

/**
 * @typedef {{ argBytes: number, handler: (args: number[]) => number }} Export
 */

/**
 * The XInput libraries.
 *
 * @returns {{ libraries: Record<string, Record<string, Export>>,
 *             diagnostics: () => { asked: number, enabled: boolean } }}
 */
export function createXInput(){
    /** How often a program asked about a pad, so a run can say it looked. */
    let asked = 0;
    /** XInputEnable's last word; with nothing connected it changes no answer. */
    let enabled = true;

    /**
     * The one answer for a slot: bad arguments, or no pad there.
     *
     * @param {number} index @param {boolean} valid  Whether the rest of the
     *        arguments are ones Windows accepts.
     */
    const slot = (index, valid)=>{
        asked++;
        return (index >>> 0) < XUSER_MAX_COUNT && valid
            ? ERROR_DEVICE_NOT_CONNECTED
            : ERROR_BAD_ARGUMENTS;
    };

    /** @param {number} pointer */
    const given = pointer=>(pointer >>> 0) !== 0;

    /** DWORD XInputGetState(DWORD, XINPUT_STATE*) */
    const XInputGetState = {
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([index, state])=>slot(index, given(state)),
    };
    /** DWORD XInputSetState(DWORD, XINPUT_VIBRATION*) */
    const XInputSetState = {
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([index, vibration])=>slot(index, given(vibration)),
    };
    /**
     * DWORD XInputGetCapabilities(DWORD, DWORD flags, XINPUT_CAPABILITIES*)
     *
     * Zero or XINPUT_FLAG_GAMEPAD are the only flags there are.
     */
    const XInputGetCapabilities = {
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([index, flags, capabilities])=>slot(index,
            ((flags >>> 0) & ~XINPUT_FLAG_GAMEPAD) === 0 && given(capabilities)),
    };

    return {
        libraries: {
            'XINPUT9_1_0.dll': {
                XInputGetState,
                XInputSetState,
                XInputGetCapabilities,
                /** DWORD XInputGetDSoundAudioDeviceGuids(DWORD, GUID* render, GUID* capture) */
                XInputGetDSoundAudioDeviceGuids: {
                    argBytes: 12,
                    /** @param {number[]} args */
                    handler: ([index, render, capture])=>slot(index,
                        given(render) && given(capture)),
                },
            },
            'XINPUT1_4.dll': {
                XInputGetState,
                XInputSetState,
                XInputGetCapabilities,
                /** void XInputEnable(BOOL) */
                XInputEnable: {
                    argBytes: 4,
                    /** @param {number[]} args */
                    handler: ([enable])=>{
                        enabled = enable !== 0;
                        return 0;
                    },
                },
                /** DWORD XInputGetBatteryInformation(DWORD, BYTE, XINPUT_BATTERY_INFORMATION*) */
                XInputGetBatteryInformation: {
                    argBytes: 12,
                    /** @param {number[]} args */
                    handler: ([index, , information])=>slot(index, given(information)),
                },
                /**
                 * DWORD XInputGetKeystroke(DWORD, DWORD reserved, XINPUT_KEYSTROKE*)
                 *
                 * The one call that may ask about every slot at once, and
                 * with none of them holding a pad the answer is the same.
                 */
                XInputGetKeystroke: {
                    argBytes: 12,
                    /** @param {number[]} args */
                    handler: ([index, , keystroke])=>slot(
                        (index >>> 0) === XUSER_INDEX_ANY ? 0 : index, given(keystroke)),
                },
                /** DWORD XInputGetStateEx(DWORD, XINPUT_STATE*): GetState with the guide button. */
                XInputGetStateEx: XInputGetState,
                /** DWORD XInputGetCapabilitiesEx(DWORD, DWORD, DWORD, XINPUT_CAPABILITIES_EX*) */
                XInputGetCapabilitiesEx: {
                    argBytes: 16,
                    /** @param {number[]} args */
                    handler: ([, index, flags, capabilities])=>slot(index,
                        ((flags >>> 0) & ~XINPUT_FLAG_GAMEPAD) === 0 && given(capabilities)),
                },
                /**
                 * DWORD XInputGetAudioDeviceIds(DWORD, LPWSTR, UINT*, LPWSTR, UINT*)
                 *
                 * A headset is found through the pad it is plugged into, and
                 * there is none.
                 */
                XInputGetAudioDeviceIds: {
                    argBytes: 20,
                    /** @param {number[]} args */
                    handler: ([index])=>slot(index, true),
                },
            },
        },
        diagnostics: ()=>({ asked, enabled }),
    };
}
