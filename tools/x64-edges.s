# The x86-64 encodings a compiler seldom emits and a decoder easily gets wrong,
# assembled by tools/x64-decode-fixture.mjs into the 64-bit decoder's reference.
    .intel_syntax noprefix
    .text
edges:
    # Byte registers: with any REX prefix 4..7 are SPL, BPL, SIL, DIL.
    mov spl, al
    mov sil, dil
    mov ah, al
    mov bh, ch
    mov r8b, r15b
    movzx eax, sil
    movzx r9d, r10b
    movsx rax, bpl
    setne r12b
    # R12 needs a SIB, R13 a displacement, as RSP and RBP do.
    mov eax, dword ptr [r12]
    mov eax, dword ptr [r13]
    mov eax, dword ptr [r13 + 8*r12 + 4]
    mov eax, dword ptr [rsp + 8*r12]
    mov rax, qword ptr [rbp + 8*r13 - 0x80]
    mov r15, qword ptr [r8 + r9]
    lea rax, [rip + 0x1000]
    lea r11, [rip - 0x10]
    mov qword ptr [rip + 0x20], 0x7fffffff
    # The address-size prefix: 32-bit registers and EIP.
    lea eax, [eax + ecx]
    mov eax, dword ptr [ebx + 4*esi + 0x10]
    mov ecx, dword ptr [eip + 0x40]
    # 64-bit immediates and offsets.
    movabs rax, 0x1122334455667788
    movabs r12, 0xffffffff00000001
    movabs al, byte ptr [0x1122334455667788]
    movabs qword ptr [0x12345678], rax
    mov rax, -1
    mov qword ptr [rsp + 0x28], 0
    add r12, -0x80
    add rax, 0x7fffffff
    and rax, -0x10
    imul rax, rcx, 0x12345678
    imul r9, r10, -2
    # The stack and the near branches: 64 bits by default.
    push r15
    pop r8
    push 0x12345678
    push -1
    push qword ptr [rax]
    pop qword ptr [rax + 8]
    push ax
    pushfq
    popfq
    enter 0x20, 0
    leave
    call qword ptr [rip + 0x10]
    jmp qword ptr [rax + 8*rcx]
    call rax
    call r11
    jmp r11
    ret 8
    ret
1:  jrcxz 1b
    jecxz 1b
    loop 1b
    jne 1b
    # Sign and zero extension, and the widened forms of old instructions.
    movsxd rax, ecx
    movsxd r10, dword ptr [rcx]
    cdqe
    cqo
    cwde
    cdq
    cbw
    cwd
    xchg r8, rax
    xchg rax, rcx
    xchg r9d, eax
    pause
    nop
    bswap rax
    bswap r9d
    bswap r13
    # Locked and repeated forms.
    cmpxchg16b xmmword ptr [rdi]
    cmpxchg8b qword ptr [rdi]
    lock cmpxchg qword ptr [rdi], rcx
    lock xadd dword ptr [rax], ecx
    lock inc qword ptr [r14]
    rep movsq
    rep stosb
    repne scasb
    movsb
    lodsq
    stosq
    cmpsq
    rep movsd
    # Integer operations at 64 bits.
    shl r9, cl
    rol qword ptr [rax], 1
    sar r10, 63
    shld rax, rcx, 4
    shrd r8, r9, cl
    bt rax, 63
    bts qword ptr [rsi], rcx
    bsr r10, r11
    cmovae r14, qword ptr [rbx]
    test r8, r8
    test byte ptr [rsi], 1
    test spl, 1
    xor r11d, r11d
    neg r15
    not qword ptr [rdx]
    mul r9
    imul r10
    div qword ptr [rcx]
    idiv r11d
    adc r13, r14
    sbb rax, qword ptr [r12 + 8]
    # SSE with the eight further xmm registers and 64-bit integers.
    movq rax, xmm0
    movq xmm9, r10
    movd xmm1, eax
    movd r12d, xmm15
    cvtsi2sd xmm8, rax
    cvtsi2ss xmm2, r9
    cvttsd2si r10, xmm15
    cvtsd2si eax, xmm3
    pextrw r9d, xmm10, 3
    pinsrw xmm11, r12d, 2
    movmskpd r8d, xmm3
    pmovmskb eax, xmm12
    movaps xmm15, xmmword ptr [r8 + 0x10]
    addsd xmm8, qword ptr [rip + 0x100]
    pxor xmm13, xmm14
    pshufd xmm9, xmm10, 0x1b
    movdqu xmmword ptr [r9 + 8*r10], xmm11
    # Segments: GS holds the TEB, FS is flat but still a base.
    mov rax, qword ptr gs:[0x30]
    mov rcx, qword ptr gs:[0x60]
    mov eax, dword ptr fs:[rax]
    # x87 under REX.
    fld qword ptr [rax]
    fstp dword ptr [r9]
    fild qword ptr [r10 + 8]
    # What stays in every mode.
    int3
    ud2
    cpuid
    rdtsc
