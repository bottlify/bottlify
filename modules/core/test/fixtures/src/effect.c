/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * A D3DX effect driven the way a game's renderer drives one, frame after
 * frame: a technique of two passes, its parameters changed between passes,
 * CommitChanges after each change, and an ID3DXEffectStateManager of the
 * program's own taking every state the effect sets -- each of which it
 * records and passes on to the device.
 *
 * Every state the manager is handed goes into a running hash, with the
 * values its pointers lead to, and so does every HRESULT the effect
 * answers; the program prints both and how many calls of each kind came.
 * Two runs of it on two ways of making those calls must print the same.
 *
 * The number at the end of the command line seeds what a run does: how many
 * frames and draws, which parameters change between draws, whether a commit
 * changes anything, and whether Begin saves and restores the device's state
 * or leaves it. A second thread keeps busy meanwhile.
 */

#include "rt.h"

typedef long HRESULT;
typedef void *Object;
typedef void (*Slot)(void);

__declspec(dllimport) Object __stdcall Direct3DCreate9(unsigned version);
__declspec(dllimport) HRESULT __stdcall D3DXCreateEffect(Object device, const void *source,
    unsigned length, const void *defines, Object include, unsigned flags, Object pool,
    Object *effect, Object *errors);
__declspec(dllimport) unsigned short __stdcall RegisterClassA(const void *wndclass);
__declspec(dllimport) void *__stdcall CreateWindowExA(unsigned ex, const char *cls,
    const char *name, unsigned style, int x, int y, int w, int h, void *parent, void *menu,
    void *instance, void *param);
__declspec(dllimport) long __stdcall DefWindowProcA(void *window, unsigned message,
    unsigned wparam, long lparam);
__declspec(dllimport) const char *__stdcall GetCommandLineA(void);
__declspec(dllimport) void *__stdcall CreateThread(void *security, unsigned stack,
    unsigned(__stdcall *start)(void *), void *parameter, unsigned flags, unsigned *id);
__declspec(dllimport) unsigned __stdcall WaitForSingleObject(void *handle, unsigned ms);

/* A method by its slot, `this` first. */
#define SLOT(object, index) ((*(Slot **)(object))[index])
#define METHOD(type, object, index) ((type)SLOT(object, index))

/* IDirect3D9 and IDirect3DDevice9 */
enum { D3D_CREATE_DEVICE = 16 };
enum {
    DEV_SET_TRANSFORM = 44, DEV_SET_MATERIAL = 49, DEV_SET_LIGHT = 51, DEV_LIGHT_ENABLE = 53,
    DEV_SET_RENDER_STATE = 57, DEV_SET_TEXTURE = 65, DEV_SET_TEXTURE_STAGE_STATE = 67,
    DEV_SET_SAMPLER_STATE = 69, DEV_SET_NPATCH_MODE = 79, DEV_SET_FVF = 89,
    DEV_SET_VERTEX_SHADER = 92, DEV_SET_VS_CONSTANT_F = 94, DEV_SET_VS_CONSTANT_I = 96,
    DEV_SET_VS_CONSTANT_B = 98, DEV_SET_PIXEL_SHADER = 107, DEV_SET_PS_CONSTANT_F = 109,
    DEV_SET_PS_CONSTANT_I = 111, DEV_SET_PS_CONSTANT_B = 113, DEV_GET_RENDER_STATE = 58,
    DEV_GET_VS_CONSTANT_F = 95,
};
/* ID3DXEffect */
enum {
    FX_RELEASE = 2, FX_GET_PARAMETER_BY_NAME = 9, FX_SET_BOOL = 22, FX_SET_INT = 26,
    FX_SET_FLOAT = 30, FX_SET_VECTOR = 34, FX_SET_MATRIX = 38, FX_SET_TECHNIQUE = 58,
    FX_BEGIN = 63, FX_BEGIN_PASS = 64, FX_COMMIT_CHANGES = 65, FX_END_PASS = 66, FX_END = 67,
    FX_SET_STATE_MANAGER = 71,
};

static const char SOURCE[] =
    "float4x4 World;\n"
    "float4 Tint;\n"
    "float Scale;\n"
    "int Mode;\n"
    "bool Bright;\n"
    "struct VOut { float4 pos : POSITION; float4 col : COLOR0; };\n"
    "VOut vs(float4 p : POSITION) { VOut o; o.pos = mul(p, World) * Scale;"
    " o.col = Bright ? Tint * 2 : Tint; return o; }\n"
    "float4 ps(float4 c : COLOR0) : COLOR0 { return c; }\n"
    "technique Main {\n"
    "  pass P0 { VertexShader = compile vs_2_0 vs(); PixelShader = compile ps_2_0 ps();\n"
    "    ZEnable = false; CullMode = None; AlphaBlendEnable = true; }\n"
    "  pass P1 { VertexShader = compile vs_2_0 vs(); PixelShader = compile ps_2_0 ps();\n"
    "    AlphaBlendEnable = false; FillMode = Wireframe; }\n"
    "}\n";

static Object device;
static unsigned hash = 2166136261u;
static unsigned counts[18];

static void mix(unsigned word)
{
    for (int i = 0; i < 4; i++)
    {
        hash = (hash ^ ((word >> (i * 8)) & 0xff)) * 16777619u;
    }
}

static void mixWords(const unsigned *words, unsigned count)
{
    for (unsigned i = 0; i < count; i++)
    {
        mix(words[i]);
    }
}

/* The manager: records what it is handed, then hands it to the device. */
typedef struct Manager { Slot *vtable; unsigned refs; } Manager;

static HRESULT __stdcall QueryInterface(Manager *self, const void *iid, void **out)
{
    (void)iid;
    *out = self;
    return 0;
}
static unsigned __stdcall AddRef(Manager *self) { return ++self->refs; }
static unsigned __stdcall Release(Manager *self) { return --self->refs; }

#define NOTE(index) (counts[index]++, mix(0x100 + (index)))

static HRESULT __stdcall SetTransform(Manager *self, unsigned state, const unsigned *matrix)
{
    (void)self;
    NOTE(0);
    mix(state);
    mixWords(matrix, 16);
    return METHOD(HRESULT(__stdcall *)(Object, unsigned, const void *), device,
        DEV_SET_TRANSFORM)(device, state, matrix);
}
static HRESULT __stdcall SetMaterial(Manager *self, const unsigned *material)
{
    (void)self;
    NOTE(1);
    mixWords(material, 17);
    return METHOD(HRESULT(__stdcall *)(Object, const void *), device, DEV_SET_MATERIAL)(
        device, material);
}
static HRESULT __stdcall SetLight(Manager *self, unsigned index, const unsigned *light)
{
    (void)self;
    NOTE(2);
    mix(index);
    mixWords(light, 26);
    return METHOD(HRESULT(__stdcall *)(Object, unsigned, const void *), device, DEV_SET_LIGHT)(
        device, index, light);
}
static HRESULT __stdcall LightEnable(Manager *self, unsigned index, int enable)
{
    (void)self;
    NOTE(3);
    mix(index);
    mix((unsigned)enable);
    return METHOD(HRESULT(__stdcall *)(Object, unsigned, int), device, DEV_LIGHT_ENABLE)(
        device, index, enable);
}
static HRESULT __stdcall SetRenderState(Manager *self, unsigned state, unsigned value)
{
    (void)self;
    NOTE(4);
    mix(state);
    mix(value);
    return METHOD(HRESULT(__stdcall *)(Object, unsigned, unsigned), device,
        DEV_SET_RENDER_STATE)(device, state, value);
}
static HRESULT __stdcall SetTexture(Manager *self, unsigned stage, Object texture)
{
    (void)self;
    NOTE(5);
    mix(stage);
    mix(texture != 0);
    return METHOD(HRESULT(__stdcall *)(Object, unsigned, Object), device, DEV_SET_TEXTURE)(
        device, stage, texture);
}
static HRESULT __stdcall SetTextureStageState(Manager *self, unsigned stage, unsigned type,
    unsigned value)
{
    (void)self;
    NOTE(6);
    mix(stage);
    mix(type);
    mix(value);
    return METHOD(HRESULT(__stdcall *)(Object, unsigned, unsigned, unsigned), device,
        DEV_SET_TEXTURE_STAGE_STATE)(device, stage, type, value);
}
static HRESULT __stdcall SetSamplerState(Manager *self, unsigned sampler, unsigned type,
    unsigned value)
{
    (void)self;
    NOTE(7);
    mix(sampler);
    mix(type);
    mix(value);
    return METHOD(HRESULT(__stdcall *)(Object, unsigned, unsigned, unsigned), device,
        DEV_SET_SAMPLER_STATE)(device, sampler, type, value);
}
static HRESULT __stdcall SetNPatchMode(Manager *self, unsigned segments)
{
    (void)self;
    NOTE(8);
    mix(segments);
    return METHOD(HRESULT(__stdcall *)(Object, unsigned), device, DEV_SET_NPATCH_MODE)(
        device, segments);
}
static HRESULT __stdcall SetFVF(Manager *self, unsigned fvf)
{
    (void)self;
    NOTE(9);
    mix(fvf);
    return METHOD(HRESULT(__stdcall *)(Object, unsigned), device, DEV_SET_FVF)(device, fvf);
}
static HRESULT __stdcall SetVertexShader(Manager *self, Object shader)
{
    (void)self;
    NOTE(10);
    mix(shader != 0);
    return METHOD(HRESULT(__stdcall *)(Object, Object), device, DEV_SET_VERTEX_SHADER)(
        device, shader);
}
static HRESULT __stdcall SetVertexShaderConstantF(Manager *self, unsigned reg,
    const unsigned *data, unsigned count)
{
    (void)self;
    NOTE(11);
    mix(reg);
    mix(count);
    mixWords(data, count * 4);
    return METHOD(HRESULT(__stdcall *)(Object, unsigned, const void *, unsigned), device,
        DEV_SET_VS_CONSTANT_F)(device, reg, data, count);
}
static HRESULT __stdcall SetVertexShaderConstantI(Manager *self, unsigned reg,
    const unsigned *data, unsigned count)
{
    (void)self;
    NOTE(12);
    mix(reg);
    mix(count);
    mixWords(data, count * 4);
    return METHOD(HRESULT(__stdcall *)(Object, unsigned, const void *, unsigned), device,
        DEV_SET_VS_CONSTANT_I)(device, reg, data, count);
}
static HRESULT __stdcall SetVertexShaderConstantB(Manager *self, unsigned reg,
    const unsigned *data, unsigned count)
{
    (void)self;
    NOTE(13);
    mix(reg);
    mix(count);
    mixWords(data, count);
    return METHOD(HRESULT(__stdcall *)(Object, unsigned, const void *, unsigned), device,
        DEV_SET_VS_CONSTANT_B)(device, reg, data, count);
}
static HRESULT __stdcall SetPixelShader(Manager *self, Object shader)
{
    (void)self;
    NOTE(14);
    mix(shader != 0);
    return METHOD(HRESULT(__stdcall *)(Object, Object), device, DEV_SET_PIXEL_SHADER)(
        device, shader);
}
static HRESULT __stdcall SetPixelShaderConstantF(Manager *self, unsigned reg,
    const unsigned *data, unsigned count)
{
    (void)self;
    NOTE(15);
    mix(reg);
    mix(count);
    mixWords(data, count * 4);
    return METHOD(HRESULT(__stdcall *)(Object, unsigned, const void *, unsigned), device,
        DEV_SET_PS_CONSTANT_F)(device, reg, data, count);
}
static HRESULT __stdcall SetPixelShaderConstantI(Manager *self, unsigned reg,
    const unsigned *data, unsigned count)
{
    (void)self;
    NOTE(16);
    mix(reg);
    mix(count);
    mixWords(data, count * 4);
    return METHOD(HRESULT(__stdcall *)(Object, unsigned, const void *, unsigned), device,
        DEV_SET_PS_CONSTANT_I)(device, reg, data, count);
}
static HRESULT __stdcall SetPixelShaderConstantB(Manager *self, unsigned reg,
    const unsigned *data, unsigned count)
{
    (void)self;
    NOTE(17);
    mix(reg);
    mix(count);
    mixWords(data, count);
    return METHOD(HRESULT(__stdcall *)(Object, unsigned, const void *, unsigned), device,
        DEV_SET_PS_CONSTANT_B)(device, reg, data, count);
}

static Slot managerVtable[] = {
    (Slot)QueryInterface, (Slot)AddRef, (Slot)Release, (Slot)SetTransform, (Slot)SetMaterial,
    (Slot)SetLight, (Slot)LightEnable, (Slot)SetRenderState, (Slot)SetTexture,
    (Slot)SetTextureStageState, (Slot)SetSamplerState, (Slot)SetNPatchMode, (Slot)SetFVF,
    (Slot)SetVertexShader, (Slot)SetVertexShaderConstantF, (Slot)SetVertexShaderConstantI,
    (Slot)SetVertexShaderConstantB, (Slot)SetPixelShader, (Slot)SetPixelShaderConstantF,
    (Slot)SetPixelShaderConstantI, (Slot)SetPixelShaderConstantB,
};
static Manager manager = { managerVtable, 1 };

static long __stdcall WindowProc(void *window, unsigned message, unsigned wparam, long lparam)
{
    return DefWindowProcA(window, message, wparam, lparam);
}

static void hex(unsigned value)
{
    char text[11] = "0x";
    for (int i = 0; i < 8; i++)
    {
        unsigned digit = (value >> ((7 - i) * 4)) & 15;
        text[2 + i] = (char)(digit < 10 ? '0' + digit : 'a' + digit - 10);
    }
    text[10] = 0;
    say(text);
}

/* The effect's answer, into the hash: a call it refuses shows. */
static void answer(HRESULT result)
{
    mix(0x7700);
    mix((unsigned)result);
}

typedef void *Handle;

/* A thread that keeps busy beside the renderer, so a machine with several
   executors runs the two at once and the renderer's calls may be answered for
   an executor other than the process's own. What it counts is not printed:
   how far it got depends on the host. */
static volatile unsigned stopBusy;
static volatile unsigned busyCount;
static unsigned __stdcall Busy(void *unused)
{
    (void)unused;
    while (!stopBusy)
    {
        busyCount++;
    }
    return 0;
}

static unsigned seed;

/* xorshift: one run per seed. */
static unsigned next(unsigned below)
{
    seed ^= seed << 13;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    return seed % below;
}

/* The last number on the command line, or 1. */
static unsigned seedFromCommandLine(void)
{
    const char *line = GetCommandLineA();
    unsigned value = 0, any = 0;
    for (const char *at = line; *at; at++)
    {
        if (*at >= '0' && *at <= '9')
        {
            value = any ? value * 10 + (unsigned)(*at - '0') : (unsigned)(*at - '0');
            any = 1;
        }
        else if (*at == ' ')
        {
            any = 0;
        }
    }
    return value ? value : 1;
}

int mainCRTStartup(void)
{
    seed = seedFromCommandLine() * 2654435761u | 1;
    const unsigned frames = 8 + next(40);
    const unsigned draws = 1 + next(4);
    /* D3DXFX_DONOTSAVESTATE, or a state block recorded and restored around each Begin */
    const unsigned beginFlags = next(3) == 0 ? 0 : 1;
    void *busy = CreateThread(0, 0, Busy, 0, 0, 0);
    unsigned wndclass[10] = { 0, (unsigned)WindowProc, 0, 0, 0, 0, 0, 0, 0,
        (unsigned)"BottlifyEffect" };
    RegisterClassA(wndclass);
    void *window = CreateWindowExA(0, "BottlifyEffect", "effect", 0, 0, 0, 64, 64, 0, 0, 0, 0);
    Object d3d = Direct3DCreate9(32);
    check("Direct3DCreate9", d3d != 0);
    /* 64x64, X8R8G8B8, one back buffer, DISCARD, windowed */
    unsigned present[14] = { 64, 64, 22, 1, 0, 0, 1, (unsigned)window, 1, 0, 0, 0, 0, 0 };
    HRESULT made = METHOD(HRESULT(__stdcall *)(Object, unsigned, unsigned, void *, unsigned,
        void *, Object *), d3d, D3D_CREATE_DEVICE)(d3d, 0, 1, window, 0x20, present, &device);
    check("CreateDevice", made == 0 && device != 0);

    Object effect = 0;
    unsigned length = 0;
    while (SOURCE[length])
    {
        length++;
    }
    HRESULT created = D3DXCreateEffect(device, SOURCE, length, 0, 0, 0, 0, &effect, 0);
    check("D3DXCreateEffect", created == 0 && effect != 0);
    if (!effect)
    {
        ExitProcess(failures);
    }
    typedef Handle(__stdcall * ByName)(Object, Handle, const char *);
    ByName byName = METHOD(ByName, effect, FX_GET_PARAMETER_BY_NAME);
    Handle world = byName(effect, 0, "World");
    Handle tint = byName(effect, 0, "Tint");
    Handle scale = byName(effect, 0, "Scale");
    Handle mode = byName(effect, 0, "Mode");
    Handle bright = byName(effect, 0, "Bright");
    check("parameters", world && tint && scale && mode && bright);

    typedef HRESULT(__stdcall * Plain)(Object);
    typedef HRESULT(__stdcall * WithUnsigned)(Object, unsigned);
    typedef HRESULT(__stdcall * WithHandle)(Object, Handle);
    typedef HRESULT(__stdcall * SetPointer)(Object, Handle, const void *);
    typedef HRESULT(__stdcall * SetWord)(Object, Handle, unsigned);
    for (int managed = 1; managed >= 0; managed--)
    {
        answer(METHOD(HRESULT(__stdcall *)(Object, Object), effect, FX_SET_STATE_MANAGER)(
            effect, managed ? (Object)&manager : 0));
        answer(METHOD(WithHandle, effect, FX_SET_TECHNIQUE)(effect, (Handle)"Main"));
        for (unsigned frame = 0; frame < frames; frame++)
        {
            float matrix[16] = { 0 };
            for (int i = 0; i < 4; i++)
            {
                matrix[i * 5] = 1.0f + (float)frame * 0.25f;
            }
            matrix[12] = (float)frame;
            answer(METHOD(SetPointer, effect, FX_SET_MATRIX)(effect, world, matrix));
            unsigned passes = 0;
            answer(METHOD(HRESULT(__stdcall *)(Object, unsigned *, unsigned), effect, FX_BEGIN)(
                effect, &passes, beginFlags));
            mix(passes);
            for (unsigned pass = 0; pass < passes; pass++)
            {
                answer(METHOD(WithUnsigned, effect, FX_BEGIN_PASS)(effect, pass));
                for (unsigned draw = 0; draw < draws; draw++)
                {
                    float vector[4] = { (float)draw, (float)pass, (float)next(100), 1.0f };
                    float value = 0.5f + (float)next(8);
                    unsigned changes = next(16);
                    if (changes & 1)
                    {
                        answer(METHOD(SetPointer, effect, FX_SET_VECTOR)(effect, tint, vector));
                    }
                    if (changes & 2)
                    {
                        answer(METHOD(SetWord, effect, FX_SET_FLOAT)(effect, scale,
                            *(unsigned *)&value));
                    }
                    if (changes & 4)
                    {
                        answer(METHOD(SetWord, effect, FX_SET_INT)(effect, mode, next(5)));
                    }
                    if (changes & 8)
                    {
                        answer(METHOD(SetWord, effect, FX_SET_BOOL)(effect, bright, next(2)));
                    }
                    answer(METHOD(Plain, effect, FX_COMMIT_CHANGES)(effect));
                    if (next(2))
                    {
                        /* A commit with nothing changed since the last. */
                        answer(METHOD(Plain, effect, FX_COMMIT_CHANGES)(effect));
                    }
                }
                answer(METHOD(Plain, effect, FX_END_PASS)(effect));
            }
            answer(METHOD(Plain, effect, FX_END)(effect));
            /* What the device holds now, as the program can read it: the states
               the passes set and the constants the vertex shader was given. */
            static const unsigned states[] = { 7, 8, 22, 27 };
            for (int i = 0; i < 4; i++)
            {
                unsigned value = 0;
                answer(METHOD(HRESULT(__stdcall *)(Object, unsigned, unsigned *), device,
                    DEV_GET_RENDER_STATE)(device, states[i], &value));
                mix(value);
            }
            unsigned constants[32] = { 0 };
            answer(METHOD(HRESULT(__stdcall *)(Object, unsigned, void *, unsigned), device,
                DEV_GET_VS_CONSTANT_F)(device, 0, constants, 8));
            mixWords(constants, 32);
        }
    }
    stopBusy = 1;
    WaitForSingleObject(busy, 0xffffffff);
    check("the manager was handed states", counts[4] > 0 && counts[10] > 0 && counts[11] > 0);
    say("hash ");
    hex(hash);
    say("\r\ncounts");
    for (int i = 0; i < 18; i++)
    {
        say(" ");
        hex(counts[i]);
    }
    say("\r\n");
    METHOD(Plain, effect, FX_RELEASE)(effect);
    ExitProcess(failures);
    return failures;
}
