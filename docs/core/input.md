# input

Keyboard, mouse and gamepad, delivered to a Win32 program both ways it reads them at once. See
[README.md](README.md) for the layer map, [system.md](system.md) for the module contract and
[host.md](host.md) for how a page attaches a canvas.

## Purpose

A program of this era reads input twice over and expects both readings to describe the same
world: the window message queue says a key went down, DirectInput says the key is down, and a
program commonly steers with one and takes commands with the other. This layer owns DirectInput
(`DINPUT.dll`, `DINPUT8.dll`), posts into `win32`'s message queue and hands every event to
user32's raw input as the device reported it, so there is exactly one place an event arrives and
it feeds all three. It also answers XInput (`XINPUT9_1_0.dll`, `XINPUT1_4.dll`), as a machine with
no controller plugged in. What arrives is a normalised host event -- a physical
key, a pointer motion, a button, a wheel notch -- and nothing about it is a browser's: a page
produces those events through `attach`, a test produces them directly, and neither can tell the
difference. Only keyboard and mouse ever cross from the browser to the guest; focus, tab
visibility and page lifecycle do not.

## Contract

| field | value |
|---|---|
| `name` | `input` |
| `version` | `0.2.0` |
| `requires` | `win32`, `bridge`, `memory` |

Source: `src/layers/input/module.js`. The DirectInput seam imports `IUNKNOWN_METHODS` and
`readGuid` from `src/layers/win32/ole32/`, which `requires` admits.

### Configuration

| option | type | default | meaning |
|---|---|---|---|
| `now` | `() => ms` | `Date.now` | The guest's clock, for message and DirectInput timestamps. |
| `publishInterface` | `(object, iid) => address` | `() => 0` | The bridge's vtable publisher; the default refuses rather than publishing into nowhere. |
| `signal` | `(eventHandle) => void` | absent | Sets the event a device's `SetEventNotification` named when data arrives. |
| `foreground` | `() => hwnd` | `() => 0` | Which window messages are for. Only the assembling caller knows which one a person is looking at. |
| `bounds` | `() => { width, height }` or null | null | The client area the cursor is confined to before a canvas is attached. |
| `windowKind` | `(hwnd) => 'top' \| 'child' \| null \| undefined` | read from `win32.windows()` | What a window handle names, for `SetCooperativeLevel`, which wants a top-level window: `null` for no window, `undefined` for a build that cannot tell, which takes any handle as a window. |
| `allocate`, `callGuest`, `callerThread` | functions | win32's heap, the bridge | Guest memory for the structures an enumeration hands a program's callback, and how that callback is run on the calling thread. |
| `trace` | `(press) => void` | absent | Told of every button press as it was mapped: position, message, parameters, and whether the message was withheld. |

### Provided API

| member | what it is |
|---|---|
| `libraries()` | `{ 'DINPUT.dll', 'DINPUT8.dll', 'XINPUT9_1_0.dll', 'XINPUT1_4.dll' }`, shaped like a `win32` library's tables. |
| `ordinals()` | Export ordinals where Windows pins them: every `XINPUT1_4.dll` export by its `.spec` number, `XInputGetStateEx` at 100 and `XInputGetCapabilitiesEx` at 108 among them. `src/app.js` synthesises the library with these. |
| `send(event)` | One `HostInputEvent` in; a window message and a DirectInput state change out, both or neither -- except that a device a program holds exclusively through DirectInput reaches it there alone (see "Exclusive devices"). Returns whether anything came of it. |
| `post(event)` | One event straight to a DirectInput device in its own codes; false when no device is created or acquired. |
| `attach(canvas, { pointerLock?, listen? })` | Listens to one canvas (a second call detaches the first) and confines the cursor to the canvas's own pixels. `listen: false` takes the canvas as the picture only, for an `OffscreenCanvas` whose events live on the page. |
| `detach()` | Removes every listener and releases whatever was held. |
| `poll()` | Reads the gamepad, which has no events of its own; nothing when no canvas is attached. |
| `clip(rect)` | The coordinate space the program declared with `ClipCursor`; null or a degenerate rect clears it. |
| `keyState(vk)` | `0x8000` when the virtual key is down and the low bit when it is toggled on (CapsLock, NumLock, ScrollLock), as `GetKeyState` answers. The mouse buttons are keys here too, `VK_LBUTTON` through `VK_XBUTTON2`. |
| `asyncKeyState(vk)` | The high bit while the key is physically down, plus the low bit while a press is pending, as `GetAsyncKeyState` answers; the read clears the low bit. |
| `keyboardState()` | A fresh 256-byte table, as `GetKeyboardState` fills: high bit down, low bit the toggle for CapsLock/NumLock/ScrollLock. |
| `setKeyboardState(bytes)` | Makes a 256-byte table the thread's view of the keyboard, as `SetKeyboardState` does: what `GetKeyState` and `GetKeyboardState` read. The physical state `GetAsyncKeyState` reads is kept apart and left alone -- a table that says A is down does not press A. |
| `cursor()` | `{ x, y }` in the program's client coordinates. |
| `pad()` | `{ axes, buttons }` as the last poll left them. |
| `device(guid)` | A created DirectInput device, for whoever is measuring. |
| `dinput()`, `xinput()`, `router()` | The DirectInput seam, the XInput tables and the router. |

`src/app.js` hands `win32`'s user32 `cursor`, `clipCursor`, `keyState`, `asyncKeyState`,
`keyboardState` and `setKeyboardState` from this API, so `GetCursorPos`, `ClipCursor`,
`GetKeyState`, `GetAsyncKeyState`, `GetKeyboardState` and `SetKeyboardState` read the router's
state.

### The event model

`HostInputEvent` (`src/layers/input/router.js`):

| `kind` | fields | becomes |
|---|---|---|
| `key` | `code` (a `KeyboardEvent.code`), `down` | `WM_KEYDOWN`/`WM_KEYUP` or the `SYS` pair when ALT is held or the key is ALT or F10, with a full lParam (scan code, extended bit, context bit, previous-state bit, transition bit); a DirectInput key event. |
| `text` | `text` | Handed to the queue's `compose` for `TranslateMessage` to turn into `WM_CHAR`, one per UTF-16 code unit, carrying the last key's lParam. Never posted directly, so a program sees exactly one character. |
| `pointerMove` | `x`, `y` (client) and/or `dx`, `dy` | `WM_MOUSEMOVE` with the button and modifier mask; a relative DirectInput mouse event. Whichever of position or delta is missing is derived from the other. |
| `pointerButton` | `button` (`left`, `right`, `middle`, `x1`, `x2`), `down` | The matching `WM_*BUTTONDOWN/UP` (with the XBUTTON id in the high word); the button's virtual key set or cleared; a DirectInput button event. |
| `wheel` | `delta` (multiples of `WHEEL_DELTA`) | `WM_MOUSEWHEEL`; a DirectInput wheel event. |
| `focus` | `gained` | Loss releases every held key and button so nothing stays down for ever; gain does nothing. |
| `padAxis`, `padButton` | `axis`/`value`, `index`/`down` | Stored for `pad()`. No DirectInput joystick device or XInput slot reads them. |

Every key, button, wheel notch and relative motion also goes to `win32.rawInput` as the device
reported it -- a key's make code, E0 prefix, unsided virtual key and message; a motion's counts
(what DirectInput reads, and nothing for a motion of nothing); a button's transition; the wheel's
delta -- whether or not the window hears the message. user32 decides who is told: a program that
registered for raw input is posted `WM_INPUT` ([`win32.md`](./win32.md)).

### Published libraries

| library | entry points | what they are |
|---|---|---|
| `DINPUT.dll` | 4 | `DirectInputCreateA`, `DirectInputCreateW`, `DirectInputCreateEx`, `DllCanUnloadNow`. |
| `DINPUT8.dll` | 2 | `DirectInput8Create`, `DllCanUnloadNow`. |
| `XINPUT9_1_0.dll` | 4 | `XInputGetState`, `XInputSetState`, `XInputGetCapabilities`, `XInputGetDSoundAudioDeviceGuids`. |
| `XINPUT1_4.dll` | 9 | The first three, and `XInputEnable`, `XInputGetBatteryInformation`, `XInputGetKeystroke`, `XInputGetStateEx`, `XInputGetCapabilitiesEx`, `XInputGetAudioDeviceIds`. |

Interfaces (`src/layers/input/dinput/seam.js`): `IDirectInput` through `IDirectInput8`, A and W
(5, 6, 7 and 8 slots after `IUnknown`), and `IDirectInputDevice` through `IDirectInputDevice8`,
A and W (15, 24, 26 and 29 slots), each known by the IID `dinput.h` defines. Every slot is
declared; unimplemented ones answer `E_NOTIMPL` from the right index. `CreateDevice` hands back the
device interface its root is declared with -- `IDirectInputDevice8` from `IDirectInput8`,
`IDirectInputDevice` from every earlier root, each in the root's width -- and `CreateDeviceEx` the
one it names.

### `diagnostics()`

| metric | meaning |
|---|---|
| `libraries` | Library names published. |
| `devices[]` | Per DirectInput device: `guid`, `kind`, `acquired`, `buffered` (the `DIPROP_BUFFERSIZE`), `queued`. |
| `published` | Interfaces published. |
| `enumerations` | How often a program asked what DirectInput devices there are. |
| `xinput` | `asked` (how often a program asked XInput about a pad) and `enabled` (`XInputEnable`'s last word). |
| `posted`, `dropped` | Messages posted; events with an unmapped key, unknown button or unknown kind. |
| `keysDown`, `buttonsDown` | What is held right now, by code and by name. |
| `cursor` | Where the cursor is. |
| `viewport`, `clip` | The two spaces a pointer travels between: the confining viewport and the declared clip rect. A cursor that lands short of where it was aimed is these two disagreeing. |

## How it works

### `dom.js`: the browser half

`src/layers/input/dom.js` attaches to the canvas and to nothing else -- not `window`, not
`document`. Keyboard events reach the focused element, so a page carrying a game behaves like an
ordinary page until the person clicks into it; the canvas is given a tab stop if it has none and a
2 px outline while focused, so a machine swallowing keystrokes and one ignoring them do not look
alike. Pointer motion is reported whether or not the canvas has focus, because a click on a panel
beside the viewport is a fact about the page, not the mouse.

- **Keys.** `keydown`/`keyup` send `code` with `preventDefault` only for keys the guest maps and
  never for `Escape`, `F5`, `F11`, `F12` or anything with Ctrl or Meta held; ALT combinations are
  taken, since programs bind alt-enter and the browser's ALT menu is recoverable. A printable
  `key`, or `Enter`/`Tab`/`Backspace`/`Escape` as their control characters, is sent as `text`. Two
  Escapes within 600 ms blur the canvas and hand focus back to the page; both still reach the
  guest first. A paste gesture is the one chord treated specially: the V of a Ctrl- or Cmd-V is
  held back until the `paste` event has delivered its text (sent as `paste`, for the guest's
  clipboard), then delivered as Control-V -- the chord a program of this era pastes on, whatever
  the page's own -- or let go on its own after 250 ms when no paste follows.
- **Pointer.** Every move projects `clientX/Y` through the canvas's bounding rect minus its border
  and padding (re-read only when the drawn size changes) and the ratio of the picture's pixels to
  the drawn size, so a canvas displayed at any size lands the cursor where the person is pointing.
  Relative motion is the difference of two projected positions rather than `movementX/Y`, which a
  browser reports in different units on a scaled display; fractions left by rounding are carried.
  A locked pointer has no position, so it is the one case that uses `movementX/Y`, and no `x`/`y`
  are sent. A move with Control held is the person's, never the program's -- the way out of a
  title that grabs the pointer -- and the next free move starts afresh rather than delivering the
  distance travelled while held. A press or release that arrives without a preceding move -- a touch, a pen, a
  synthesised click -- moves the cursor to its own position first. `pointerdown` focuses the
  canvas, captures the pointer, and requests pointer lock only when `attach` asked for it;
  `contextmenu` is suppressed.
- **Wheel.** Only while focused, so scrolling over an idle game scrolls the page; pixel deltas
  accumulate at 100 px per notch, line and page deltas count as notches; the sign is inverted to
  Windows' convention; one `wheel` event per whole notch.
- **Focus.** `focus` and `blur` send the `focus` event, whose only guest-visible effect is the
  release of held keys on loss.
- **Gamepad.** `poll()` reads `navigator.getGamepads()` while focused, takes the first pad
  present, and sends an axis when it moved more than 0.02 or a button when it changed. It starts
  no timer of its own; whoever ticks the engine calls it.
- **Detach** removes every listener, clears the outline, and sends a focus loss if focused.

### `router.js`: one event, two readings

`src/layers/input/router.js` turns each event into the messages above and a DirectInput event.
It keeps the 256-entry virtual-key array (both the paired key such as `VK_SHIFT` and the sided
one such as `VK_LSHIFT`; releasing one shift with the other held keeps `VK_SHIFT` down), the set
of held physical keys, the pressed buttons, and the cursor. `src/layers/win32/user32/keys.js` maps
105 `KeyboardEvent.code` values to a set-1 scan code, its E0 prefix, the virtual key and the sided
virtual key, from which both the message lParam and the DirectInput code (scan code with E0 folded
into bit 7) are derived; it lives under `win32` rather than `input` because `MapVirtualKeyA` needs
the same table and `win32` cannot import a layer that itself requires `win32`.

The router keeps two key tables: the physical one `GetAsyncKeyState` reads, and the thread's view
`GetKeyState` and `GetKeyboardState` read, which `SetKeyboardState` rewrites; an event moves both.
A mouse button is a virtual key in both, with the async press bit on its transition, as a key is.
The router posts no `WM_SETCURSOR`: user32 sends it to the window under the pointer as each of the
mouse's messages is taken ([`win32.md`](./win32.md)). `WM_MOUSEWHEEL`'s lParam is in screen
coordinates, which equal client coordinates here because there is no desktop for a window to sit
on.

**Viewport and clip.** The cursor is confined to `bounds` until `attach` supplies the canvas's own
pixels through `confineTo`. When the program has declared a rect through `ClipCursor`, the router
scales pointer travel across the real viewport into that space -- a menu built for 640x480 shown in
a larger back buffer moves its cursor by DirectInput counts that span exactly 640x480 -- carrying
the fractional remainder so a slow drag through a shrinking scale is not rounded to nothing, and
confines the cursor to the rect; DirectInput reports the scaled motion whether or not it was
clipped, as hardware does. Undeclared, the viewport is the space and the scale is one.

**Activation** is not this layer's. The program becomes the active application when it shows its
first window, told by user32 from inside that call ([`win32.md`](./win32.md)), and the page never
takes it back. A page's focus is a page concern -- a person clicking a button beside the canvas, a
browser taking focus for its own reasons -- and forwarding it as `WM_ACTIVATEAPP` or `WM_KILLFOCUS`
would make a program pause or abandon a cinematic because something happened to a web page.

**Exclusive devices.** A keyboard or mouse a program has acquired at a `DISCL_EXCLUSIVE`
cooperative level reaches it through DirectInput alone: the router withholds that device's window
messages -- and the characters a key would have composed -- while DirectInput, the cursor, the key
state and raw input still follow every event. On Windows an exclusive foreground `Acquire`
registers the device for raw input with `RIDEV_NOLEGACY`, which stops the legacy messages, and a
program reading a click both ways would otherwise act on it twice. A press record says when its
message was withheld.

### DirectInput

`src/layers/input/dinput/devices.js` is a device without the COM. A mouse's axes are deltas
consumed by reading, so `GetDeviceState` reports motion since the previous call; the buffered
queue holds one event fewer than the `DIPROP_BUFFERSIZE` stated -- a buffer of one holds nothing
and only overflows -- the oldest event going when it is full, and running it over is remembered
and reported once, by a read or a peek, as `DI_BUFFEROVERFLOW`, the `S_FALSE` a program has to
look at. `Unacquire` keeps the buffered events and the overflow, as Windows does, and drops the
motion not yet read and the keyboard's key state, so a key still held across `Unacquire` and
`Acquire` reads up until it is pressed again; what arrives while nobody holds the device is not
buffered. An
unacquired device's `GetDeviceState` answers `DIERR_NOTACQUIRED`, never zeroes; its buffer can
still be read before DirectInput 8 and answers `DIERR_NOTACQUIRED` from 8. The device's objects --
the mouse's three axes and five buttons at their `DIMOUSESTATE2` offsets, a push button per key a
host can press at its DIK code -- are what `EnumObjects` and `GetObjectInfo` describe.

`src/layers/input/dinput/seam.js` hands out two devices, `GUID_SysKeyboard` and `GUID_SysMouse`;
any other GUID is `DIERR_DEVICENOTREG`. Each `DirectInputCreate`, `DirectInputCreateEx` and
`DirectInput8Create` makes an object of its own that keeps the version it was asked for
(`Initialize` sets it too), and a device answers as the version of the object that made it. The
object counts its references as one whichever interface each came through, and the devices it made
hold none a program sees: its last `Release` answers zero while a device is still held, and the
device goes on answering (Wine's `device8.c` releases it so). A device released to nothing is
over: the next `CreateDevice` for it makes a new one, and one still held is handed out again with a
reference for the new caller.

Creation and `Initialize` refuse as Windows does (Wine's `dinput.c`): a null out-pointer is
`E_POINTER`; an interface of the other generation `DIERR_NOINTERFACE` (`DirectInputCreateEx` looks
at the interface before the pointer, and leaves the pointer as it was); a null module handle
`DIERR_INVALIDPARAM`, except for version 0x300; a version of 0 `DIERR_NOTINITIALIZED`; a version
no DirectInput before 8 was released as (0x300, 0x500, 0x50A, 0x5B2, 0x602, 0x61A, 0x700) is
`DIERR_BETADIRECTINPUTVERSION` up to 0x700 and `DIERR_OLDDIRECTINPUTVERSION` past it, and
DirectInput 8 takes 0x800 alone on the same terms. A creation asked to aggregate makes nothing and
answers `DI_OK` with the pointer null. A root before 8 is one pointer per width: `IDirectInputA`,
`2A` and `7A` are the `7A` table's pointer, the wide ones and `IUnknown` the `7W` table's, and
neither family answers the other's (the bridge's `sharedWith`). `CreateDevice` and
`GetDeviceStatus` refuse a null with `E_POINTER`, `RunControlPanel` a handle that is no window with
`E_HANDLE` and any flags with `DIERR_INVALIDPARAM` (there is no control panel to show), and
`EnumDevices` a device type or flags there are not with `DIERR_INVALIDPARAM`.
`SetDataFormat` does not walk the caller's `DIOBJECTDATAFORMAT` array: it recognises the layout by
`dwDataSize` -- 256 for `c_dfDIKeyboard`, 16 for `c_dfDIMouse`, 20 for `c_dfDIMouse2` -- and
answers `DIERR_UNSUPPORTED` to any other size rather than writing at the wrong offsets, and
`DIERR_INVALIDPARAM` to a keyboard format on a mouse or the reverse. `GetDeviceState` must be
asked for exactly the size the format set. `SetProperty` takes `DIPROP_BUFFERSIZE` and accepts
axis mode, ranges and dead zones without acting (the device is already relative and unscaled); a
held device refuses a new buffer size or axis mode with `DIERR_ACQUIRED`, and a buffer size set
between `Unacquire` and `Acquire` is the way a program resizes one. `GetProperty` answers only the
buffer size. `GetDeviceData` on a device no buffer size was set for answers `DIERR_NOTBUFFERED`.
`Acquire` of an acquired device and `Unacquire` of one nobody holds change nothing and answer
`DI_NOEFFECT`. `SetCooperativeLevel` is checked as Windows checks it for the system pair: exactly
one of exclusive and nonexclusive and one of foreground and background (`DIERR_INVALIDPARAM`
otherwise), a null window only for background and nonexclusive and never a child window or a
handle naming no window (`E_HANDLE`), background and exclusive together `DIERR_UNSUPPORTED`, an
exclusive keyboard refused to a DirectInput before 7 (`DIERR_INVALIDPARAM`), and any new level on
an acquired device `DIERR_ACQUIRED`. `GetCapabilities` reports `DIDC_ATTACHED | DIDC_EMULATED`,
three axes and five buttons for the mouse and 128 buttons for the keyboard, and the device type in
the codes of the interface's generation with its subtype: `0x112` and `0x413` through
`IDirectInputDevice8`, `0x102` and `0x403` before it. `GetDeviceInfo` fills a `DIDEVICEINSTANCE`,
in either of its two sizes and the interface's width, with the device's own GUIDs and that type.
`EnumObjects` runs the program's callback once per object its `DIDFT` filter asks for, stopping
only on `DIENUM_STOP`; `GetObjectInfo` finds one by offset or by id, answers `DIERR_UNSUPPORTED` by
usage and `DIERR_NOTFOUND` for no such object. `EnumDevices` describes the two attached devices to
the program's own callback, as Windows does: the pointer's class first and then the keyboard's,
each written into a `DIDEVICEINSTANCE` in guest memory in the width of the vtable the call arrived
on, with the type `GetCapabilities` reports. The callbacks run through the bridge, the caller
parked while they do; `DIEDFL_FORCEFEEDBACK` lists nothing, and a null callback is
`DIERR_INVALIDPARAM`. `Poll` has nothing to poll -- the devices do not claim `DIDC_POLLEDDEVICE`
-- and answers `DIERR_NOTACQUIRED` for a device nobody holds and, for a held one, `DI_NOEFFECT`
from DirectInput 7 on and `DI_OK` before it. The root's `RunControlPanel` and `Initialize`
succeed; `FindDevice` and `GetDeviceStatus` for an unknown GUID answer `DIERR_DEVICENOTREG`.

### XInput

`src/layers/input/xinput.js` answers the two XInput libraries that are part of Windows rather
than of the DirectX redistributable, so no program brings a copy and the system volume holds none.
Each exports what its Wine `.spec` lists, and `xinput1_4` at the numbers that `.spec` gives: a
program takes `XInputGetStateEx` (100) and `XInputGetCapabilitiesEx` (108) with `GetProcAddress` on
the ordinal. Every call checks its arguments first -- a user index past three (`XUSER_INDEX_ANY`
allowed for `XInputGetKeystroke`), a null structure or a flag other than `XINPUT_FLAG_GAMEPAD` is
`ERROR_BAD_ARGUMENTS` -- and otherwise answers `ERROR_DEVICE_NOT_CONNECTED` with the caller's
structure untouched: there is no pad in any of the four slots.

## Limitations and divergences

- **No joystick device, and no XInput pad.** `padAxis`/`padButton` are stored for `pad()` and
  nothing in DirectInput or XInput reads them; `GetDeviceState` knows keyboard and mouse layouts
  only. The seam's header names "a
  joystick's" layout among the four it recognises; the `FORMATS` table holds three.
- **Only two devices, and enumeration is static.** `EnumDevices` names `GUID_SysKeyboard` and
  `GUID_SysMouse`; a device plugged in while the process runs is never reported, and the product
  GUID of each is the device's own instance GUID, as Windows reports the system pair.
- **Data formats are recognised by size**, not by walking the description; a hand-rolled format of
  an unfamiliar size is refused.
- **Force feedback, effects, action maps, `SendDeviceData`, `Escape`, `GetImageInfo`, and a
  device's own `RunControlPanel` and `Initialize`** are declared and answer `E_NOTIMPL`.
- **`SetProperty` acts on the buffer size alone**; the axis mode, ranges and dead zones are
  accepted and ignored. `GetProperty` for anything but the buffer size is `DIERR_UNSUPPORTED`.
- **A mouse's button state is not cleared by `Unacquire`** and changes only while the device is
  acquired, so a button let go while a program had given the mouse up still reads as held after its
  next `Acquire`.
- **The keyboard's objects are the keys a host can press**, one per DIK code the key table maps,
  fewer than the 128 buttons `GetCapabilities` counts.
- **Two-pad play** is not modelled; the first pad present is the pad.
- **One canvas at a time**; a second `attach` detaches the first.
- **Pointer lock** is only requested from a `pointerdown`, and the browser may refuse it.
- **Force feedback is absent**, so `EnumDevices` with `DIEDFL_FORCEFEEDBACK` lists nothing.

There is no `divergence` hook in this layer; what is reported is `dropped` (unmapped keys and
unknown buttons), `viewport` against `clip`, and each device's `acquired`, `buffered` and
`queued`.

## Tests

All under `npm test` from `modules/core` (`node --test "src/**/*.test.js"`); 177 `test()` cases.

| file | kind | what it pins |
|---|---|---|
| `src/layers/input/module.test.js` | Wiring, over the real `win32` message queue | A key sent to the layer arrives in the queue the program pumps; DirectInput is published beside the message path and XInput answered with no pad, its ordinals offered beside its tables; an event reaches win32 as the device reported it; a mouse held exclusively through DirectInput stops reaching the window; `SetCooperativeLevel` asks win32 what a handle names; a build without `win32` still takes input; diagnostics report both halves. |
| `src/layers/input/router.test.js` | Contract | Message and lParam encoding for keys, modifiers and system keys; mouse messages and masks; text composition; clip scaling and confinement; focus gained telling the program nothing and focus loss releasing everything; the keyboard-state table, its toggles, the logical state apart from the physical one, the buttons as keys and the async press bit; an exclusive DirectInput device's messages withheld; every event also reported for `WM_INPUT`. |
| `src/layers/input/dom.test.js` | Unit, against a stand-in canvas | Which keys are taken from the page, what a press becomes, where a click is in the game's own pixels through border and scale, wheel accumulation, double-Escape release, that nothing stays attached. |
| `src/layers/input/dinput/devices.test.js` | Contract | Delta consumption, a buffer of N holding N - 1, ring overflow reporting, the buffer kept across `Unacquire`, unacquired refusal, key state layout. |
| `src/layers/input/dinput/seam.test.js` | Contract, over a flat guest memory | Every slot's argument count for all eight interface generations, each device generation found by its IID and `CreateDevice` answering the one its root is declared with, `SetDataFormat` by size, `GetDeviceState` size checks, `GetDeviceData` in both structure sizes and unbuffered, properties and what an acquired device refuses, `DI_NOEFFECT` from `Acquire`, `Unacquire` and `Poll`, `SetCooperativeLevel`'s checks and exclusive holding, `GetCapabilities`' types and counts, `GetDeviceInfo`, `EnumObjects` and `GetObjectInfo`, creation and refusals, a device's last `Release` ending every generation a program asked it for, the DirectInput object counting its references across its interfaces and a device answering after that object's last `Release`; `EnumDevices` describing both devices to a recorded guest callback, in both widths and both device-type generations. |
| `src/layers/input/xinput.test.js` | Contract | Each library exports what its `.spec` does and nothing else, `xinput1_4` at its `.spec`'s ordinals, every slot answers that no pad is connected, arguments are checked before the slot is, `XInputEnable` is remembered. |
| `src/xinput.itest.js` | Integration, a built program on the emulator | `GetProcAddress` on `xinput1_4.dll` by ordinal 100 and 108 answers the address the names do, and 100 answers as `XInputGetStateEx` does with no pad. |

What a real browser does with a `KeyboardEvent` or a `PointerEvent` is not covered by the unit
suite; the `dom.js` tests settle only what the adapter decides for itself. No tracked CDP scenario
asserts on input.
