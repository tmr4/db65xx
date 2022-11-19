/* eslint-disable @typescript-eslint/naming-convention */
import {
    BYTE_WIDTH, BYTE_FORMAT, WORD_WIDTH, WORD_FORMAT, ADDR_WIDTH, ADDR_FORMAT, ADDRL_WIDTH,
    byteMask, addrMask, addrHighMask, addrMaskL, addrBankMask, spBase,
    NEGATIVE, OVERFLOW, UNUSED, BREAK, DECIMAL, INTERRUPT, ZERO, CARRY, MS, IRS,
    RESET, COP, BRK, ABORT, NMI, IRQ
} from './constants';
import { instruction } from './mpu65xx';
import { MPU6502 } from './mpu6502';

export class MPU65C02 extends MPU6502 {
    public waiting: boolean;

    public constructor(memory: Uint8Array | null, pc = 0xfffc) {
        super(memory, pc);

        // config
        this.name = '65C02';
        this.index = 1;
        this.waiting = false;
    }

    public reset() {
        super.reset();
    }

    public step() {
        if (this.waiting) {
            this.processorCycles += 1;
            if (this.IRQ_pin === false) {
                this.waiting = false;
            }
        } else {
            super.step();
        }
    }

    // *****************************************************************************
    // Addressing modes

    private ZeroPageIndirectAddr() {
        return this.WordAt(255 & (this.ByteAt(this.pc)));
    }

    private IndirectAbsXAddr() {
        return (this.WordAt(this.pc) + this.x) & addrMask;
    }

    // *****************************************************************************
    // Operations

    private opRMB(x: () => number, mask) {
        const address = x.call(this);
        this.memory[address] &= mask;
    }

    private opSMB(x: () => number, mask) {
        const address = x.call(this);
        this.memory[address] |= mask;
    }

    private opSTZ(x: () => number) {
        this.memory[x.call(this)] = 0x00;
    }

    private opTSB(x: () => number) {
        const address = x.call(this);
        const m = this.memory[address];
        this.p &= ~ZERO;
        const z = m & this.a;
        if (z === 0) {
            this.p |= ZERO;
        }
        this.memory[address] = m | this.a;
    }

    private opTRB(x: () => number) {
        const address = x.call(this);
        const m = this.memory[address];
        this.p &= ~ZERO;
        const z = m & this.a;
        if (z === 0) {
            this.p |= ZERO;
        }
        this.memory[address] = m & ~this.a;
    }

    // *****************************************************************************
    // Instructions

    @instruction("65C02", "BRK", "imp", 7)
    protected inst_0x00() {
        super.inst_0x00();

        // 65C02 clears decimal flag
        this.p &= ~DECIMAL;
    }

    @instruction("65C02", "TSB", "zpg", 5)
    private inst_0x04() {
        this.opTSB(this.ZeroPageAddr);
        this.pc += 1;
    }

    @instruction("65C02", "RMB0", "zpg", 5)
    private inst_0x07() {
        this.opRMB(this.ZeroPageAddr, 0xFE);
        this.pc += 1;
    }

    @instruction("65C02", "TSB", "abs", 6)
    private inst_0x0c() {
        this.opTSB(this.AbsoluteAddr);
        this.pc += 2;
    }

    @instruction("65C02", "ORA", "zpi", 5)
    private inst_0x12() {
        this.opORA(this.ZeroPageIndirectAddr);
        this.pc += 1;
    }

    @instruction("65C02", "TRB", "zpg", 5)
    private inst_0x14() {
        this.opTRB(this.ZeroPageAddr);
        this.pc += 1;
    }

    @instruction("65C02", "RMB1", "zpg", 5)
    private inst_0x17() {
        this.opRMB(this.ZeroPageAddr, 0xFD);
        this.pc += 1;
    }

    @instruction("65C02", "INC", "acc", 2)
    private inst_0x1a() {
        this.opINC(null);
    }

    @instruction("65C02", "TRB", "abs", 6)
    private inst_0x1c() {
        this.opTRB(this.AbsoluteAddr);
        this.pc += 2;
    }

    @instruction("65C02", "RMB2", "zpg", 5)
    private inst_0x27() {
        this.opRMB(this.ZeroPageAddr, 0xFB);
        this.pc += 1;
    }

    @instruction("65C02", "AND", "zpi", 5)
    private inst_0x32() {
        this.opAND(this.ZeroPageIndirectAddr);
        this.pc += 1;
    }

    @instruction("65C02", "BIT", "zpx", 4)
    private inst_0x34() {
        this.opBIT(this.ZeroPageXAddr);
        this.pc += 1;
    }

    @instruction("65C02", "RMB3", "zpg", 5)
    private inst_0x37() {
        this.opRMB(this.ZeroPageAddr, 0xF7);
        this.pc += 1;
    }

    @instruction("65C02", "DEC", "acc", 2)
    private inst_0x3a() {
        this.opDEC(null);
    }

    @instruction("65C02", "BIT", "abx", 4)
    private inst_0x3c() {
        this.opBIT(this.AbsoluteXAddr);
        this.pc += 2;
    }

    @instruction("65C02", "RMB4", "zpg", 5)
    private inst_0x47() {
        this.opRMB(this.ZeroPageAddr, 0xEF);
        this.pc += 1;
    }

    @instruction("65C02", "EOR", "zpi", 5)
    private inst_0x52() {
        this.opEOR(this.ZeroPageIndirectAddr);
        this.pc += 1;
    }

    @instruction("65C02", "RMB5", "zpg", 5)
    private inst_0x57() {
        this.opRMB(this.ZeroPageAddr, 0xDF);
        this.pc += 1;
    }

    @instruction("65C02", "PHY", "imp", 3)
    private inst_0x5a() {
        this.stPush(this.y);
    }

    @instruction("65C02", "STZ", "imp", 3)
    private inst_0x64() {
        this.opSTZ(this.ZeroPageAddr);
        this.pc += 1;
    }

    @instruction("65C02", "RMB6", "zpg", 5)
    private inst_0x67() {
        this.opRMB(this.ZeroPageAddr, 0xBF);
        this.pc += 1;
    }

    @instruction("65C02", "JMP", "ind", 6)
    protected inst_0x6c() {
        const ta = this.WordAt(this.pc);
        this.pc = this.WordAt(ta);
    }

    @instruction("65C02", "ADC", "zpi", 5)
    private inst_0x72() {
        this.opADC(this.ZeroPageIndirectAddr);
        this.pc += 1;
    }

    @instruction("65C02", "STZ", "zpx", 4)
    private inst_0x74() {
        this.opSTZ(this.ZeroPageXAddr);
        this.pc += 1;
    }

    @instruction("65C02", "RMB7", "zpg", 5)
    private inst_0x77() {
        this.opRMB(this.ZeroPageAddr, 0x7F);
        this.pc += 1;
    }

    @instruction("65C02", "PLY", "imp", 4)
    private inst_0x7a() {
        this.y = this.stPop();
        this.FlagsNZ(this.y);
    }

    @instruction("65C02", "JMP", "iax", 6)
    private inst_0x7c() {
        this.pc = this.WordAt(this.IndirectAbsXAddr());
    }

    @instruction("65C02", "BRA", "rel", 1, 1)
    private inst_0x80() {
        this.ProgramCounterRelAddr();
    }

    @instruction("65C02", "SMB0", "zpg", 5)
    private inst_0x87() {
        this.opSMB(this.ZeroPageAddr, 0x01);
        this.pc += 1;
    }

    @instruction("65C02", "BIT", "imm", 2)
    private inst_0x89() {
        // This instruction(BIT #$12) does not use opBIT because in the
        // immediate mode, BIT only affects the Z flag.
        const tbyte = this.OperandByte();
        this.p &= ~(ZERO);
        if ((this.a & tbyte) === 0) {
            this.p |= ZERO;
        }
        this.pc += 1;
    }

    @instruction("65C02", "STA", "zpi", 5)
    private inst_0x92() {
        this.opSTA(this.ZeroPageIndirectAddr);
        this.pc += 1;
    }

    @instruction("65C02", "SMB1", "zpg", 5)
    private inst_0x97() {
        this.opSMB(this.ZeroPageAddr, 0x02);
        this.pc += 1;
    }

    @instruction("65C02", "STZ", "abs", 4)
    private inst_0x9c() {
        this.opSTZ(this.AbsoluteAddr);
        this.pc += 2;
    }

    @instruction("65C02", "STZ", "abx", 5)
    private inst_0x9e() {
        this.opSTZ(this.AbsoluteXAddr);
        this.pc += 2;
    }

    @instruction("65C02", "SMB2", "zpg", 5)
    private inst_0xa7() {
        this.opSMB(this.ZeroPageAddr, 0x04);
        this.pc += 1;
    }

    @instruction("65C02", "LDA", "zpi", 5)
    private inst_0xb2() {
        this.opLDA(this.ZeroPageIndirectAddr);
        this.pc += 1;
    }

    @instruction("65C02", "SMB3", "zpg", 5)
    private inst_0xb7() {
        this.opSMB(this.ZeroPageAddr, 0x08);
        this.pc += 1;
    }

    @instruction("65C02", "SMB4", "zpg", 5)
    private inst_0xc7() {
        this.opSMB(this.ZeroPageAddr, 0x10);
        this.pc += 1;
    }

    @instruction("65C02", "WAI", "imp", 3)
    private inst_0xcb() {
        this.waiting = true;
    }

    @instruction("65C02", "CMP", "zpi", 5)
    private inst_0xd2() {
        this.opCMP(this.ZeroPageIndirectAddr, this.a);
        this.pc += 1;
    }

    @instruction("65C02", "SMB5", "zpg", 5)
    private inst_0xd7() {
        this.opSMB(this.ZeroPageAddr, 0x20);
        this.pc += 1;
    }

    @instruction("65C02", "PHX", "imp", 3)
    private inst_0xda() {
        this.stPush(this.x);
    }

    @instruction("65C02", "SMB6", "zpg", 5)
    private inst_0xe7() {
        this.opSMB(this.ZeroPageAddr, 0x40);
        this.pc += 1;
    }

    @instruction("65C02", "SBC", "zpi", 5)
    private inst_0xf2() {
        this.opSBC(this.ZeroPageIndirectAddr);
        this.pc += 1;
    }

    @instruction("65C02", "SMB7", "zpg", 5)
    private inst_0xf7() {
        this.opSMB(this.ZeroPageAddr, 0x80);
        this.pc += 1;
    }

    @instruction("65C02", "PLX", "imp", 4)
    private inst_0xfa() {
        this.x = this.stPop();
        this.FlagsNZ(this.x);
    }
}
