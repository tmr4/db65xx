/* eslint-disable @typescript-eslint/naming-convention */
import {
    BYTE_WIDTH, BYTE_FORMAT, WORD_WIDTH, WORD_FORMAT, ADDR_WIDTH, ADDR_FORMAT, ADDRL_WIDTH,
    byteMask, addrMask, addrHighMask, addrMaskL, addrBankMask, spBase,
    NEGATIVE, OVERFLOW, UNUSED, BREAK, DECIMAL, INTERRUPT, ZERO, CARRY, MS, IRS,
    RESET, COP, BRK, ABORT, NMI, IRQ
} from './constants';
import { EE65xx } from './ee65xx';

interface IDisasm {
    inst: string;
    mode: string;
}

var instruct: Function[] = [];
var cycletime: number[] = [];
var extracycles: number[] = [];
var disassemble: IDisasm[] = [];
var init65C02 = false;

export function instruction(cpu: string, inst: string, mode: string, cycles: number, xcycles: number = 0): Function {
    function decorate(f: Function, memberName: string, propertyDescriptor: PropertyDescriptor): Function {
        let index = 0;
        if (cpu === '65xx') {
            for (let i = 0; i < 256; i++) {
                instruct[i] = propertyDescriptor.value;
            }
        } else {
            if (cpu === '65C02') {
                index = 1;
                if (!init65C02) {
                    const j = index * 256;
                    // copy 6502 entries into 65C02
                    for (let i = 0; i < 256; i++) {
                        instruct[i + j] = instruct[i];
                    }
                    init65C02 = true;
                }
            } else if (cpu === '65816') {
                index = 2;
            }
            var opcode: number = 0;
            opcode = Number.parseInt(memberName.slice(5), 16);
            instruct[opcode + index * 256] = propertyDescriptor.value;
            disassemble[opcode + index * 256] = { inst, mode };
            cycletime[opcode + index * 256] = cycles;
            extracycles[opcode + index * 256] = xcycles;
        }

        return f;  // Return the original function
    }
    return decorate;
}

export class MPU65XX {
    private ee65xx!: EE65xx;

    // processor characteristics
    public name: string;
    protected index = 0;
    public processorCycles: number;
    public memory: Uint8Array = new Uint8Array();
    public start_pc: number;
    public excycles: number;
    public addcycles: boolean;
    public IRQ_pin: boolean;
    public waiting: boolean | undefined;

    // registers
    public pc!: number;
    public a!: number;
    public x!: number;
    public y!: number;
    public sp!: number;
    public p!: number;

    // we'll include these to reduce redefinitions when modeling the 16-bit processors
    // it likely leads to some inefficiency in the '02 processors
    public mode!: number;
    public b!: number;
    public dpr!: number;
    public pbr!: number;
    public dbr!: number;

    public constructor(ee65xx: EE65xx, pc = 0xfffc) {
        this.ee65xx = ee65xx;

        // config
        this.name = '65XX';

        // vm status
        this.excycles = 0;
        this.addcycles = false;
        this.processorCycles = 0;

        this.start_pc = pc;
        this.sp = 0;
        this.IRQ_pin = true;
    }

    public reset() {
        this.pc = this.WordAt(RESET);

        this.a = 0;
        this.x = 0;
        this.y = 0;
        this.p = BREAK | UNUSED | INTERRUPT;
        this.processorCycles = 0;

        this.mode = 1;
        this.pbr = 0;
        this.dbr = 0;
    }

    public step() {
        if ((this.IRQ_pin === false) && ((this.p & INTERRUPT) === 0)) {
            this.irq();
            this.IRQ_pin = true;
        }
        const instructCode = this.memory[(this.pbr << ADDR_WIDTH) + this.pc];
        this.incPC();
        this.excycles = 0;
        this.addcycles = extracycles[instructCode] === 0 ? false : true;;
        instruct[instructCode + this.index * 256].call(this);
        this.pc &= addrMask;
        this.processorCycles += cycletime[instructCode] + this.excycles;
    }

    // trigger an IRQ
    protected irq() {
        if (this.p & INTERRUPT) {
            return;
        }

        if (this.mode === 0) {
            this.stPush(this.pbr);
        }

        this.stPushWord(this.pc);

        if (this.mode) {
            this.stPush(this.p & ~BREAK | UNUSED);
        }
        else {
            this.stPush(this.p);
        }

        this.p |= INTERRUPT;
        this.pbr = 0;
        this.pc = this.WordAt(IRQ[this.mode]);
        this.processorCycles += 7;
    }

    // trigger an NMI in the processor
    protected nmi() {
        if (this.mode === 0) {
            this.stPush(this.pbr);
        }

        this.stPushWord(this.pc);

        if (this.mode) {
            this.stPush(this.p & ~BREAK | UNUSED);
        }
        else {
            this.stPush(this.p);
        }

        this.p |= INTERRUPT;
        this.pbr = 0;
        this.pc = this.WordAt(NMI[this.mode]);
        this.processorCycles += 7;
    }

    // public method to set the status register from the UI
    public setP(p: number) {
        p &= 0xff;  // mask it
        if (this.mode) {
            // *** TODO:
            // the 65816 Programming manual has the this can change the BREAK flag
            // verify this isn't true ***
            this.p = p | BREAK | UNUSED;
        }
        else {
            if ((p & MS) !== (this.p & MS)) {
                if (p & MS) {
                    // A 16 => 8, save B, mask off high byte of A
                    this.b = (this.a >> BYTE_WIDTH) & byteMask;
                    this.a = this.a & byteMask;
                }
                else {
                    // A 8 => 16, set A = b a
                    this.a = (this.b << BYTE_WIDTH) + this.a;
                    this.b = 0;
                }
            }
            if ((p & IRS) !== (this.p & IRS)) {
                if (p & IRS) {
                    // X,Y 16 => 8, truncate X,Y
                    this.x = this.x & byteMask;
                    this.y = this.y & byteMask;
                }
            }
            this.p = p;
        }
    }

    private _opCode: number = 0;
    public get opCode(): number {
        return this.OperandByte();
    }

    private _address: number = 0;
    public get address(): number {
        return this.OperandAddr();
    }

    // *****************************************************************************
    // Helpers for addressing modes and instructions

    // *** useful for debuging for now, may be able to incorporate them ***    }
    private LongAt(addr: number): number {
        return (this.ByteAt(addr + 2) << ADDR_WIDTH) + (this.ByteAt(addr + 1) << BYTE_WIDTH) + this.ByteAt(addr);
    }
    private TCAt(addr: number): number {
        return (this.WordAt(addr + 2) << ADDR_WIDTH) + this.WordAt(addr);
    }

    protected ByteAt(addr: number): number {
        return this.memory[addr];
    }

    protected WordAt(addr: number): number {
        return this.ByteAt(addr) + (this.ByteAt(addr + 1) << BYTE_WIDTH);
    }

    protected OperandAddr(): number {
        return (this.pbr << ADDR_WIDTH) + this.pc;
    }

    protected OperandByte(): number {
        return this.ByteAt(this.OperandAddr());
    }

    protected OperandWord(): number {
        return this.WordAt(this.OperandAddr());
    }

    protected incPC(inc: number = 1): void {
        this.pc = (this.pc + inc) & addrMask;
    }

    // status register related helpers
    protected pCLR(x: number): void {
        this.p &= ~x;
    }

    protected pSET(x: number) {
        this.p |= x;
    }

    protected isSET(x: number): boolean {
        //return this.p & x; // it's shorter just to inline this
        return (this.p & x) !== 0;
    }

    protected isCLR(x: number) {
        return !(this.p & x); // but not this
    }

    // branch related helpers
    protected bCLR(x: number) {
        if (this.p & x) {
            this.incPC();
        } else {
            this.ProgramCounterRelAddr();
        }
    }

    protected bSET(x: number) {
        if (this.p & x) {
            this.ProgramCounterRelAddr();
        } else {
            this.incPC();
        }
    }

    // stack related helpers
    protected stPush(z: number): void {
        if (this.mode) {
            this.memory[spBase + this.sp] = z & byteMask;
        }
        else {
            this.memory[this.sp] = z & byteMask;
        }
        this.sp -= 1;
        if (this.mode) {
            this.sp &= byteMask;
        }
        else {
            this.sp &= addrMask;
        }
    }

    protected stPop(): number {
        this.sp += 1;
        if (this.mode) {
            this.sp &= byteMask;
        }
        else {
            this.sp &= addrMask;
        }
        if (this.mode) {
            return this.ByteAt(spBase + this.sp);
        }
        else {
            return this.ByteAt(this.sp);
        }
    }

    protected stPushWord(z) {
        this.stPush((z >> BYTE_WIDTH) & byteMask);
        this.stPush(z & byteMask);
    }

    protected stPopWord(): number {
        let z = this.stPop();
        z += this.stPop() << BYTE_WIDTH;
        return z;
    }

    protected FlagsNZ(value) {
        this.p &= ~(ZERO | NEGATIVE);
        if (value === 0) {
            this.p |= ZERO;
        } else {
            this.p |= value & NEGATIVE;
        }
    }

    // *****************************************************************************
    //   Page Boundary Wrapping

    // Original py65 page boundary WrapAt
    // returns word at addr, wrapping at a page boundary
    //private WrapAt(addr) {
    //    wrap = lambda x) { (x & addrHighMask) + ((x + 1) & byteMask)
    //    return this.ByteAt(addr) + (this.ByteAt(wrap(addr)) << BYTE_WIDTH)
    //}
    protected WrapAt(addr: number): number {
        // Examples for addresses at page boundary and not, say 0x01ff and 0x0155 {
        //                 0x01ff => 0x0100       +   0x0200 =>  0x00  = 0x0100
        //                 0x0155 => 0x0100       +   0x0156 =>  0x56  = 0x0156
        //        wrap = lambda x { (x & addrHighMask) + ((x + 1) & byteMask)
        //     get bytes at 0x01ff   and         0x0100
        //     get bytes at 0x0155   and         0x0156
        //        return this.ByteAt(addr) + (this.ByteAt(wrap(addr)) << BYTE_WIDTH)
        if (addr + 1 > (1 << BYTE_WIDTH)) {
            return this.ByteAt(addr) + (this.ByteAt(0) << BYTE_WIDTH);
        }
        else {
            return this.WordAt(addr);
        }
    }

    // *****************************************************************************
    // Addressing modes

    protected AbsoluteAddr(): number {
        return (this.dbr << ADDR_WIDTH) + this.OperandWord();
    }

    protected ImmediateAddr(): number {
        return this.OperandAddr();
    }

    protected ProgramCounterRelAddr(): void {
        const offset = this.OperandByte();
        let addr: number;

        this.excycles += 1;
        this.incPC();

        if (offset & NEGATIVE) {
            addr = this.pc - (offset ^ byteMask) - 1;
        }
        else {
            addr = this.pc + offset;
        }

        // *** TODO verify this extra cycle is applicable for all processors
        // and modes, especially 65C02 BBR and BBS.
        // http://www.6502.org/tutorials/65c02opcodes.html says it applies to 65C02 BBR/BBS ***
        if ((this.pc & addrHighMask) !== (addr & addrHighMask)) {
            this.excycles += 1;
        }

        this.pc = addr & addrMask;
    }

    // *****************************************************************************
    // Instructions

    @instruction("65xx", "", "", 0)
    private inst_not_implemented() {
        //this.incPC();
        this.pc -= 1;
        this.ee65xx.stopOnException();
    }
}
