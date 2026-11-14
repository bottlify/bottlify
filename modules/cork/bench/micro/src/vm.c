/* A stack-machine bytecode interpreter: a switch over opcodes (a jump table), the way script engines run. */
typedef unsigned int u32;
enum { PUSH, LOAD, STORE, ADD, SUB, MUL, AND, XOR, SHL, SHR, JNZ, JMP, DUP, DROP, LT, HALT, INC, CALLN };
static int prog[64];
static int vars[16];
static int stack[256];
static u32 native(u32 a){ return a * 2654435761u >> 7; }
static int run(const int *pc0){
    const int *pc = pc0; int *sp = stack; u32 acc = 0;
    for(;;){
        switch(*pc++){
        case PUSH: *sp++ = *pc++; break;
        case LOAD: *sp++ = vars[*pc++]; break;
        case STORE: vars[*pc++] = *--sp; break;
        case ADD: sp--; sp[-1] += sp[0]; break;
        case SUB: sp--; sp[-1] -= sp[0]; break;
        case MUL: sp--; sp[-1] *= sp[0]; break;
        case AND: sp--; sp[-1] &= sp[0]; break;
        case XOR: sp--; sp[-1] ^= sp[0]; break;
        case SHL: sp--; sp[-1] <<= (sp[0] & 31); break;
        case SHR: sp--; sp[-1] = (u32)sp[-1] >> (sp[0] & 31); break;
        case JNZ: { int t = *pc++; if (*--sp) pc = pc0 + t; break; }
        case JMP: pc = pc0 + *pc; break;
        case DUP: sp[0] = sp[-1]; sp++; break;
        case DROP: sp--; break;
        case LT: sp--; sp[-1] = sp[-1] < sp[0]; break;
        case INC: vars[*pc++]++; break;
        case CALLN: sp[-1] = native(sp[-1]); break;
        case HALT: return vars[1];
        }
    }
}
int main(void){
    int i = 0;
    /* v0 = 0; v1 = 7; loop: v1 = (v1*31 ^ v0) + (v1>>3); v1 = native(v1) ^ v1; v0++; if v0 < 3000 goto loop */
    prog[i++]=PUSH; prog[i++]=0; prog[i++]=STORE; prog[i++]=0;
    prog[i++]=PUSH; prog[i++]=7; prog[i++]=STORE; prog[i++]=1;
    int loop = i;
    prog[i++]=LOAD; prog[i++]=1; prog[i++]=PUSH; prog[i++]=31; prog[i++]=MUL;
    prog[i++]=LOAD; prog[i++]=0; prog[i++]=XOR;
    prog[i++]=LOAD; prog[i++]=1; prog[i++]=PUSH; prog[i++]=3; prog[i++]=SHR; prog[i++]=ADD;
    prog[i++]=DUP; prog[i++]=CALLN; prog[i++]=XOR; prog[i++]=STORE; prog[i++]=1;
    prog[i++]=INC; prog[i++]=0;
    prog[i++]=LOAD; prog[i++]=0; prog[i++]=PUSH; prog[i++]=3000; prog[i++]=LT;
    prog[i++]=JNZ; prog[i++]=loop;
    prog[i++]=HALT;
    return run(prog);
}
