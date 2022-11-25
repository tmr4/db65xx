/* eslint-disable @typescript-eslint/naming-convention */
import {
    BYTE_WIDTH, BYTE_FORMAT, WORD_WIDTH, WORD_FORMAT, ADDR_WIDTH, ADDR_FORMAT, ADDRL_WIDTH,
    byteMask, addrMask, addrHighMask, addrMaskL, addrBankMask, spBase,
    NEGATIVE, OVERFLOW, UNUSED, BREAK, DECIMAL, INTERRUPT, ZERO, CARRY, MS, IRS,
    RESET, COP, BRK, ABORT, NMI, IRQ
} from './constants';
import { MPU65XX, instruction } from './mpu65xx';
import { EE65xx } from './ee65xx';

export class MPU6502 extends MPU65XX {

    public constructor(ee65xx: EE65xx, memory: Uint8Array | null, pc = 0xfffc) {
        super(ee65xx, pc);

        // config
        this.name = '6502';

        if (memory === null) {
            memory = new Uint8Array(0x10000);
        }
        this.memory = memory;
    }

    public reset() {
        super.reset();

        if (this.name === '6502') {
            this.p |= DECIMAL;
        }
    }


    //private reprformat() {
    //    return ("%s PC  AC XR YR SP NV-BDIZC\n"
    //            "%s) { %04x %02x %02x %02x %02x %s")
    //}
    //private __repr__() {
    //    flags = itoa(this.p, 2).rjust(BYTE_WIDTH, '0')
    //    indent = ' ' * (len(this.name) + 2)
    //    this.x, this.y, this.sp, flags)
    //}

    // *****************************************************************************
    // Addressing modes

    protected AbsoluteXAddr() {
        if (this.addcycles) {
            const a1 = this.OperandWord();
            const a2 = (a1 + this.x) & addrMask;
            if ((a1 & addrHighMask) !== (a2 & addrHighMask)) {
                this.excycles += 1;
            }
            return a2;
        } else {
            return (this.OperandWord() + this.x) & addrMask;
        }
    }

    private AbsoluteYAddr() {
        if (this.addcycles) {
            const a1 = this.OperandWord();
            const a2 = (a1 + this.y) & addrMask;
            if ((a1 & addrHighMask) !== (a2 & addrHighMask)) {
                this.excycles += 1;
            }
            return a2;
        } else {
            return (this.OperandWord() + this.y) & addrMask;
        }
    }

    private IndirectXAddr() {
        return this.WrapAt(byteMask & (this.ByteAt(this.pc) + this.x));
    }

    private IndirectYAddr() {
        if (this.addcycles) {
            const a1 = this.WrapAt(this.ByteAt(this.pc));
            const a2 = (a1 + this.y) & addrMask;
            if ((a1 & addrHighMask) !== (a2 & addrHighMask)) {
                this.excycles += 1;
            }
            return a2;
        } else {
            return (this.WrapAt(this.ByteAt(this.pc)) + this.y) & addrMask;
        }
    }

    protected ZeroPageAddr() {
        return this.ByteAt(this.pc);
    }

    protected ZeroPageXAddr() {
        return byteMask & (this.x + this.ByteAt(this.pc));
    }

    private ZeroPageYAddr() {
        return byteMask & (this.y + this.ByteAt(this.pc));
    }


    // *****************************************************************************
    // Operations

    protected opADC(x: () => number) {
        let data = this.ByteAt(x.call(this));

        if (this.p & DECIMAL) {
            let halfcarry = 0;
            let decimalcarry = 0;
            let adjust0 = 0;
            let adjust1 = 0;
            let nibble0 = (data & 0xf) + (this.a & 0xf) + (this.p & CARRY);
            if (nibble0 > 9) {
                adjust0 = 6;
                halfcarry = 1;
            }
            let nibble1 = ((data >> 4) & 0xf) + ((this.a >> 4) & 0xf) + halfcarry;
            if (nibble1 > 9) {
                adjust1 = 6;
                decimalcarry = 1;
            }

            // the ALU outputs are not decimally adjusted
            nibble0 = nibble0 & 0xf;
            nibble1 = nibble1 & 0xf;

            // the final A contents will be decimally adjusted
            nibble0 = (nibble0 + adjust0) & 0xf;
            nibble1 = (nibble1 + adjust1) & 0xf;

            // Update result for use in setting flags below
            const aluresult = (nibble1 << 4) + nibble0;

            this.p &= ~(CARRY | OVERFLOW | NEGATIVE | ZERO);
            if (aluresult === 0) {
                this.p |= ZERO;
            } else {
                this.p |= aluresult & NEGATIVE;
            }
            if (decimalcarry === 1) {
                this.p |= CARRY;
            }
            if ((~(this.a ^ data) & (this.a ^ aluresult)) & NEGATIVE) {
                this.p |= OVERFLOW;
            }
            this.a = (nibble1 << 4) + nibble0;
        } else {
            var tmp: number;

            if (this.p & CARRY) {
                tmp = 1;
            } else {
                tmp = 0;
            }
            const result = data + this.a + tmp;
            this.p &= ~(CARRY | OVERFLOW | NEGATIVE | ZERO);
            if ((~(this.a ^ data) & (this.a ^ result)) & NEGATIVE) {
                this.p |= OVERFLOW;
            }
            data = result;
            if (data > byteMask) {
                this.p |= CARRY;
                data &= byteMask;
            }
            if (data === 0) {
                this.p |= ZERO;
            } else {
                this.p |= data & NEGATIVE;
            }
            this.a = data;
        }
    }

    protected opAND(x: () => number) {
        this.a &= this.ByteAt(x.call(this));
        this.FlagsNZ(this.a);
    }

    private opASL(x: (() => number) | null) {
        let tbyte: number;
        let addr: number = 0;

        if (x === null) {
            tbyte = this.a;
        } else {
            addr = x.call(this);
            tbyte = this.ByteAt(addr);
        }

        this.p &= ~(CARRY | NEGATIVE | ZERO);

        if (tbyte & NEGATIVE) {
            this.p |= CARRY;
        }
        tbyte = (tbyte << 1) & byteMask;

        if (tbyte) {
            this.p |= tbyte & NEGATIVE;
        } else {
            this.p |= ZERO;
        }

        if (x === null) {
            this.a = tbyte;
        } else {
            this.memory[addr] = tbyte;
        }
    }

    protected opBIT(x: () => number) {
        const tbyte = this.ByteAt(x.call(this));
        this.p &= ~(ZERO | NEGATIVE | OVERFLOW);
        if ((this.a & tbyte) === 0) {
            this.p |= ZERO;
        }
        this.p |= tbyte & (NEGATIVE | OVERFLOW);
    }

    protected opCMP(x: (() => number), register_value) {
        const tbyte = this.ByteAt(x.call(this));
        this.p &= ~(CARRY | ZERO | NEGATIVE);
        if (register_value === tbyte) {
            this.p |= CARRY | ZERO;
        } else if (register_value > tbyte) {
            this.p |= CARRY;
        }
        this.p |= (register_value - tbyte) & NEGATIVE;
    }

    protected opDEC(x: (() => number) | null) {
        let tbyte: number;
        let addr: number = 0;

        if (x === null) {
            tbyte = this.a;
        } else {
            addr = x.call(this);
            tbyte = this.ByteAt(addr);
        }

        this.p &= ~(ZERO | NEGATIVE);
        tbyte = (tbyte - 1) & byteMask;
        if (tbyte) {
            this.p |= tbyte & NEGATIVE;
        } else {
            this.p |= ZERO;
        }

        if (x === null) {
            this.a = tbyte;
        } else {
            this.memory[addr] = tbyte;
        }
    }

    protected opEOR(x: () => number) {
        this.a ^= this.ByteAt(x.call(this));
        this.FlagsNZ(this.a);
    }

    protected opINC(x: (() => number) | null) {
        var tbyte: number, addr: number = 0;

        if (x === null) {
            tbyte = this.a;
        } else {
            addr = x.call(this);
            tbyte = this.ByteAt(addr);
        }

        this.p &= ~(ZERO | NEGATIVE);
        tbyte = (tbyte + 1) & byteMask;
        if (tbyte) {
            this.p |= tbyte & NEGATIVE;
        } else {
            this.p |= ZERO;
        }

        if (x === null) {
            this.a = tbyte;
        } else {
            this.memory[addr] = tbyte;
        }
    }

    protected opLDA(x: () => number) {
        this.a = this.ByteAt(x.call(this));
        this.FlagsNZ(this.a);
    }

    private opLDX(y: () => number) {
        this.x = this.ByteAt(y.call(this));
        this.FlagsNZ(this.x);
    }

    private opLDY(x: () => number) {
        this.y = this.ByteAt(x.call(this));
        this.FlagsNZ(this.y);
    }

    private opLSR(x: (() => number) | null) {
        let tbyte: number;
        let addr: number = 0;

        if (x === null) {
            tbyte = this.a;
        } else {
            addr = x.call(this);
            tbyte = this.ByteAt(addr);
        }

        this.p &= ~(CARRY | NEGATIVE | ZERO);
        this.p |= tbyte & 1;

        tbyte = tbyte >> 1;
        if (tbyte) {
            //pass
        } else {
            this.p |= ZERO;
        }

        if (x === null) {
            this.a = tbyte;
        } else {
            this.memory[addr] = tbyte;
        }
    }

    protected opORA(x: () => number) {
        this.a |= this.ByteAt(x.call(this));
        this.FlagsNZ(this.a);
    }

    private opROL(x: (() => number) | null) {
        let tbyte: number;
        let addr: number = 0;

        if (x === null) {
            tbyte = this.a;
        } else {
            addr = x.call(this);
            tbyte = this.ByteAt(addr);
        }

        if (this.p & CARRY) {
            if (tbyte & NEGATIVE) {
                //pass
            } else {
                this.p &= ~CARRY;
            }
            tbyte = (tbyte << 1) | 1;
        } else {
            if (tbyte & NEGATIVE) {
                this.p |= CARRY;
            }
            tbyte = tbyte << 1;
        }
        tbyte &= byteMask;
        this.FlagsNZ(tbyte);

        if (x === null) {
            this.a = tbyte;
        } else {
            this.memory[addr] = tbyte;
        }
    }

    private opROR(x: (() => number) | null) {
        var tbyte: number, addr: number = 0;

        if (x === null) {
            tbyte = this.a;
        } else {
            addr = x.call(this);
            tbyte = this.ByteAt(addr);
        }

        if (this.p & CARRY) {
            if (tbyte & 1) {
                //pass
            } else {
                this.p &= ~CARRY;
            }
            tbyte = (tbyte >> 1) | NEGATIVE;
        } else {
            if (tbyte & 1) {
                this.p |= CARRY;
            }
            tbyte = tbyte >> 1;
        }
        this.FlagsNZ(tbyte);

        if (x === null) {
            this.a = tbyte;
        } else {
            this.memory[addr] = tbyte;
        }
    }

    protected opSBC(x: () => number) {
        var data = this.ByteAt(x.call(this));

        if (this.p & DECIMAL) {
            let halfcarry = 1;
            let decimalcarry = 0;
            let adjust0 = 0;
            let adjust1 = 0;
            let nibble0 = (this.a & 0xf) + (~data & 0xf) + (this.p & CARRY);

            if (nibble0 <= 0xf) {
                halfcarry = 0;
                adjust0 = 10;
            }
            let nibble1 = ((this.a >> 4) & 0xf) + ((~data >> 4) & 0xf) + halfcarry;
            if (nibble1 <= 0xf) {
                adjust1 = 10 << 4;
            }

            // the ALU outputs are not decimally adjusted
            let aluresult = this.a + (~data & byteMask) + (this.p & CARRY);

            if (aluresult > byteMask) {
                decimalcarry = 1;
            }
            aluresult &= byteMask;

            // but the final result will be adjusted
            nibble0 = (aluresult + adjust0) & 0xf;
            nibble1 = ((aluresult + adjust1) >> 4) & 0xf;

            // Update result for use in setting flags below
            aluresult = (nibble1 << 4) + nibble0;

            this.p &= ~(CARRY | ZERO | NEGATIVE | OVERFLOW);
            if (aluresult === 0) {
                this.p |= ZERO;
            } else {
                this.p |= aluresult & NEGATIVE;
            }
            if (decimalcarry === 1) {
                this.p |= CARRY;
            }
            if (((this.a ^ data) & (this.a ^ aluresult)) & NEGATIVE) {
                this.p |= OVERFLOW;
            }
            this.a = aluresult;
        } else {
            const result = this.a + (~data & byteMask) + (this.p & CARRY);
            this.p &= ~(CARRY | ZERO | OVERFLOW | NEGATIVE);
            if (((this.a ^ data) & (this.a ^ result)) & NEGATIVE) {
                this.p |= OVERFLOW;
            }
            data = result & byteMask;
            if (data === 0) {
                this.p |= ZERO;
            }
            if (result > byteMask) {
                this.p |= CARRY;
            }
            this.p |= data & NEGATIVE;
            this.a = data;
        }
    }

    protected opSTA(x: () => number) {
        this.memory[x.call(this)] = this.a;
    }

    private opSTX(y: () => number) {
        this.memory[y.call(this)] = this.x;
    }

    private opSTY(x: () => number) {
        this.memory[x.call(this)] = this.y;
    }

    // *****************************************************************************
    // Instructions

    @instruction("6502", "BRK", "imp", 7)
    protected inst_0x00() {
        // pc has already been increased one
        const pc = (this.pc + 1) & addrMask;
        this.stPushWord(pc);

        this.p |= BREAK;
        this.stPush(this.p | BREAK | UNUSED);

        this.p |= INTERRUPT;
        this.pc = this.WordAt(IRQ[this.mode]);
    }

    @instruction("6502", "ORA", "inx", 6)
    private inst_0x01() {
        this.opORA(this.IndirectXAddr);
        this.incPC();
    }

    @instruction("6502", "ORA", "zpg", 3)
    private inst_0x05() {
        this.opORA(this.ZeroPageAddr);
        this.incPC();
    }

    @instruction("6502", "ASL", "zpg", 5)
    private inst_0x06() {
        this.opASL(this.ZeroPageAddr);
        this.incPC();
    }

    @instruction("6502", "PHP", "imp", 3)
    private inst_0x08() {
        this.stPush(this.p | BREAK | UNUSED);
    }

    @instruction("6502", "ORA", "imm", 2)
    private inst_0x09() {
        this.opORA(this.ImmediateAddr);
        this.incPC();
    }

    @instruction("6502", "ASL", "acc", 2)
    private inst_0x0a() {
        this.opASL(null);
    }

    @instruction("6502", "ORA", "abs", 4)
    private inst_0x0d() {
        this.opORA(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("6502", "ASL", "abs", 6)
    private inst_0x0e() {
        this.opASL(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("6502", "BPL", "rel", 2, 2)
    private inst_0x10() {
        this.bCLR(NEGATIVE);
    }

    @instruction("6502", "ORA", "iny", 5, 1)
    private inst_0x11() {
        this.opORA(this.IndirectYAddr);
        this.incPC();
    }

    @instruction("6502", "ORA", "zpx", 4)
    private inst_0x15() {
        this.opORA(this.ZeroPageXAddr);
        this.incPC();
    }

    @instruction("6502", "ASL", "zpx", 6)
    private inst_0x16() {
        this.opASL(this.ZeroPageXAddr);
        this.incPC();
    }

    @instruction("6502", "CLC", "imp", 2)
    private inst_0x18() {
        this.pCLR(CARRY);
    }

    @instruction("6502", "ORA", "aby", 4, 1)
    private inst_0x19() {
        this.opORA(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("6502", "ORA", "abx", 4, 1)
    private inst_0x1d() {
        this.opORA(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("6502", "ASL", "abx", 7)
    private inst_0x1e() {
        this.opASL(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("6502", "JSR", "abs", 6)
    private inst_0x20() {
        this.stPushWord((this.pc + 1) & addrMask);
        this.pc = this.OperandWord();
    }

    @instruction("6502", "AND", "inx", 6)
    private inst_0x21() {
        this.opAND(this.IndirectXAddr);
        this.incPC();
    }

    @instruction("6502", "BIT", "zpg", 3)
    private inst_0x24() {
        this.opBIT(this.ZeroPageAddr);
        this.incPC();
    }

    @instruction("6502", "AND", "zpg", 3)
    private inst_0x25() {
        this.opAND(this.ZeroPageAddr);
        this.incPC();
    }

    @instruction("6502", "ROL", "zpg", 5)
    private inst_0x26() {
        this.opROL(this.ZeroPageAddr);
        this.incPC();
    }

    @instruction("6502", "PLP", "imp", 4)
    private inst_0x28() {
        this.p = (this.stPop() | BREAK | UNUSED);
    }

    @instruction("6502", "AND", "imm", 2)
    private inst_0x29() {
        this.opAND(this.ImmediateAddr);
        this.incPC();
    }

    @instruction("6502", "ROL", "acc", 2)
    private inst_0x2a() {
        this.opROL(null);
    }

    @instruction("6502", "BIT", "abs", 4)
    private inst_0x2c() {
        this.opBIT(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("6502", "AND", "abs", 4)
    private inst_0x2d() {
        this.opAND(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("6502", "ROL", "abs", 6)
    private inst_0x2e() {
        this.opROL(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("6502", "BMI", "rel", 2, 2)
    private inst_0x30() {
        this.bSET(NEGATIVE);
    }

    @instruction("6502", "AND", "iny", 5, 1)
    private inst_0x31() {
        this.opAND(this.IndirectYAddr);
        this.incPC();
    }

    @instruction("6502", "AND", "zpx", 4)
    private inst_0x35() {
        this.opAND(this.ZeroPageXAddr);
        this.incPC();
    }

    @instruction("6502", "ROL", "zpx", 6)
    private inst_0x36() {
        this.opROL(this.ZeroPageXAddr);
        this.incPC();
    }

    @instruction("6502", "SEC", "imp", 2)
    private inst_0x38() {
        this.pSET(CARRY);
    }

    @instruction("6502", "AND", "aby", 4, 1)
    private inst_0x39() {
        this.opAND(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("6502", "AND", "abx", 4, 1)
    private inst_0x3d() {
        this.opAND(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("6502", "ROL", "abx", 7)
    private inst_0x3e() {
        this.opROL(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("6502", "RTI", "imp", 6)
    private inst_0x40() {
        this.p = (this.stPop() | BREAK | UNUSED);
        this.pc = this.stPopWord();
    }

    @instruction("6502", "EOR", "inx", 6)
    private inst_0x41() {
        this.opEOR(this.IndirectXAddr);
        this.incPC();
    }

    @instruction("6502", "EOR", "zpg", 3)
    private inst_0x45() {
        this.opEOR(this.ZeroPageAddr);
        this.incPC();
    }

    @instruction("6502", "LSR", "zpg", 5)
    private inst_0x46() {
        this.opLSR(this.ZeroPageAddr);
        this.incPC();
    }

    @instruction("6502", "PHA", "imp", 3)
    private inst_0x48() {
        this.stPush(this.a);
    }

    @instruction("6502", "EOR", "imm", 2)
    private inst_0x49() {
        this.opEOR(this.ImmediateAddr);
        this.incPC();
    }

    @instruction("6502", "LSR", "acc", 2)
    private inst_0x4a() {
        this.opLSR(null);
    }

    @instruction("6502", "JMP", "abs", 3)
    private inst_0x4c() {
        this.pc = this.OperandWord();
    }

    @instruction("6502", "EOR", "abs", 4)
    private inst_0x4d() {
        this.opEOR(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("6502", "LSR", "abs", 6)
    private inst_0x4e() {
        this.opLSR(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("6502", "BVC", "rel", 2, 2)
    private inst_0x50() {
        this.bCLR(OVERFLOW);
    }

    @instruction("6502", "EOR", "iny", 5, 1)
    private inst_0x51() {
        this.opEOR(this.IndirectYAddr);
        this.incPC();
    }

    @instruction("6502", "EOR", "zpx", 4)
    private inst_0x55() {
        this.opEOR(this.ZeroPageXAddr);
        this.incPC();
    }

    @instruction("6502", "LSR", "zpx", 6)
    private inst_0x56() {
        this.opLSR(this.ZeroPageXAddr);
        this.incPC();
    }

    @instruction("6502", "CLI", "imp", 2)
    private inst_0x58() {
        this.pCLR(INTERRUPT);
    }

    @instruction("6502", "EOR", "aby", 4, 1)
    private inst_0x59() {
        this.opEOR(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("6502", "EOR", "abx", 4, 1)
    private inst_0x5d() {
        this.opEOR(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("6502", "LSR", "abx", 7)
    private inst_0x5e() {
        this.opLSR(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("6502", "RTS", "imp", 6)
    private inst_0x60() {
        this.pc = this.stPopWord();
        this.incPC();
    }

    @instruction("6502", "ADC", "inx", 6)
    private inst_0x61() {
        this.opADC(this.IndirectXAddr);
        this.incPC();
    }

    @instruction("6502", "ADC", "zpg", 3)
    private inst_0x65() {
        this.opADC(this.ZeroPageAddr);
        this.incPC();
    }

    @instruction("6502", "ROR", "zpg", 5)
    private inst_0x66() {
        this.opROR(this.ZeroPageAddr);
        this.incPC();
    }

    @instruction("6502", "PLA", "imp", 4)
    private inst_0x68() {
        this.a = this.stPop();
        this.FlagsNZ(this.a);
    }

    @instruction("6502", "ADC", "imm", 2)
    private inst_0x69() {
        this.opADC(this.ImmediateAddr);
        this.incPC();
    }

    @instruction("6502", "ROR", "acc", 2)
    private inst_0x6a() {
        this.opROR(null);
    }

    @instruction("6502", "JMP", "ind", 5)
    protected inst_0x6c() {
        const ta = this.OperandWord();
        this.pc = this.WrapAt(ta);
    }

    @instruction("6502", "ADC", "abs", 4)
    private inst_0x6d() {
        this.opADC(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("6502", "ROR", "abs", 6)
    private inst_0x6e() {
        this.opROR(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("6502", "BVS", "rel", 2, 2)
    private inst_0x70() {
        this.bSET(OVERFLOW);
    }

    @instruction("6502", "ADC", "iny", 5, 1)
    private inst_0x71() {
        this.opADC(this.IndirectYAddr);
        this.incPC();
    }

    @instruction("6502", "ADC", "zpx", 4)
    private inst_0x75() {
        this.opADC(this.ZeroPageXAddr);
        this.incPC();
    }

    @instruction("6502", "ROR", "zpx", 6)
    private inst_0x76() {
        this.opROR(this.ZeroPageXAddr);
        this.incPC();
    }

    @instruction("6502", "SEI", "imp", 2)
    private inst_0x78() {
        this.pSET(INTERRUPT);
    }

    @instruction("6502", "ADC", "aby", 4, 1)
    private inst_0x79() {
        this.opADC(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("6502", "ADC", "abx", 4, 1)
    private inst_0x7d() {
        this.opADC(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("6502", "ROR", "abx", 7)
    private inst_0x7e() {
        this.opROR(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("6502", "STA", "inx", 6)
    private inst_0x81() {
        this.opSTA(this.IndirectXAddr);
        this.incPC();
    }

    @instruction("6502", "STY", "zpg", 3)
    private inst_0x84() {
        this.opSTY(this.ZeroPageAddr);
        this.incPC();
    }

    @instruction("6502", "STA", "zpg", 3)
    private inst_0x85() {
        this.opSTA(this.ZeroPageAddr);
        this.incPC();
    }

    @instruction("6502", "STX", "zpg", 3)
    private inst_0x86() {
        this.opSTX(this.ZeroPageAddr);
        this.incPC();
    }

    @instruction("6502", "DEY", "imp", 2)
    private inst_0x88() {
        this.y -= 1;
        this.y &= byteMask;
        this.FlagsNZ(this.y);
    }

    @instruction("6502", "TXA", "imp", 2)
    private inst_0x8a() {
        this.a = this.x;
        this.FlagsNZ(this.a);
    }

    @instruction("6502", "STY", "abs", 4)
    private inst_0x8c() {
        this.opSTY(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("6502", "STA", "abs", 4)
    private inst_0x8d() {
        this.opSTA(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("6502", "STX", "abs", 4)
    private inst_0x8e() {
        this.opSTX(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("6502", "BCC", "rel", 2, 2)
    private inst_0x90() {
        this.bCLR(CARRY);
    }

    @instruction("6502", "STA", "iny", 6)
    private inst_0x91() {
        this.opSTA(this.IndirectYAddr);
        this.incPC();
    }

    @instruction("6502", "STY", "zpx", 4)
    private inst_0x94() {
        this.opSTY(this.ZeroPageXAddr);
        this.incPC();
    }

    @instruction("6502", "STA", "zpx", 4)
    private inst_0x95() {
        this.opSTA(this.ZeroPageXAddr);
        this.incPC();
    }

    @instruction("6502", "STX", "zpy", 4)
    private inst_0x96() {
        this.opSTX(this.ZeroPageYAddr);
        this.incPC();
    }

    @instruction("6502", "TYA", "imp", 2)
    private inst_0x98() {
        this.a = this.y;
        this.FlagsNZ(this.a);
    }

    @instruction("6502", "STA", "aby", 5)
    private inst_0x99() {
        this.opSTA(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("6502", "TXS", "imp", 2)
    private inst_0x9a() {
        this.sp = this.x;
    }

    @instruction("6502", "STA", "abx", 5)
    private inst_0x9d() {
        this.opSTA(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("6502", "LDY", "imm", 2)
    private inst_0xa0() {
        this.opLDY(this.ImmediateAddr);
        this.incPC();
    }

    @instruction("6502", "LDA", "inx", 6)
    private inst_0xa1() {
        this.opLDA(this.IndirectXAddr);
        this.incPC();
    }

    @instruction("6502", "LDX", "imm", 2)
    private inst_0xa2() {
        this.opLDX(this.ImmediateAddr);
        this.incPC();
    }

    @instruction("6502", "LDY", "zpg", 3)
    private inst_0xa4() {
        this.opLDY(this.ZeroPageAddr);
        this.incPC();
    }

    @instruction("6502", "LDA", "zpg", 3)
    private inst_0xa5() {
        this.opLDA(this.ZeroPageAddr);
        this.incPC();
    }

    @instruction("6502", "LDX", "zpg", 3)
    private inst_0xa6() {
        this.opLDX(this.ZeroPageAddr);
        this.incPC();
    }

    @instruction("6502", "TAY", "imp", 2)
    private inst_0xa8() {
        this.y = this.a;
        this.FlagsNZ(this.y);
    }

    @instruction("6502", "LDA", "imm", 2)
    private inst_0xa9() {
        this.opLDA(this.ImmediateAddr);
        this.incPC();
    }

    @instruction("6502", "TAX", "imp", 2)
    private inst_0xaa() {
        this.x = this.a;
        this.FlagsNZ(this.x);
    }

    @instruction("6502", "LDY", "abs", 4)
    private inst_0xac() {
        this.opLDY(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("6502", "LDA", "abs", 4)
    private inst_0xad() {
        this.opLDA(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("6502", "LDX", "abs", 4)
    private inst_0xae() {
        this.opLDX(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("6502", "BCS", "rel", 2, 2)
    private inst_0xb0() {
        this.bSET(CARRY);
    }

    @instruction("6502", "LDA", "iny", 5, 1)
    private inst_0xb1() {
        this.opLDA(this.IndirectYAddr);
        this.incPC();
    }

    @instruction("6502", "LDY", "zpx", 4)
    private inst_0xb4() {
        this.opLDY(this.ZeroPageXAddr);
        this.incPC();
    }

    @instruction("6502", "LDA", "zpx", 4)
    private inst_0xb5() {
        this.opLDA(this.ZeroPageXAddr);
        this.incPC();
    }

    @instruction("6502", "LDX", "zpy", 4)
    private inst_0xb6() {
        this.opLDX(this.ZeroPageYAddr);
        this.incPC();
    }

    @instruction("6502", "CLV", "imp", 2)
    private inst_0xb8() {
        this.pCLR(OVERFLOW);
    }

    @instruction("6502", "LDA", "aby", 4, 1)
    private inst_0xb9() {
        this.opLDA(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("6502", "TSX", "imp", 2)
    private inst_0xba() {
        this.x = this.sp;
        this.FlagsNZ(this.x);
    }

    @instruction("6502", "LDY", "abx", 4, 1)
    private inst_0xbc() {
        this.opLDY(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("6502", "LDA", "abx", 4, 1)
    private inst_0xbd() {
        this.opLDA(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("6502", "LDX", "aby", 4, 1)
    private inst_0xbe() {
        this.opLDX(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("6502", "CPY", "imm", 2)
    private inst_0xc0() {
        this.opCMP(this.ImmediateAddr, this.y);
        this.incPC();
    }

    @instruction("6502", "CMP", "inx", 6)
    private inst_0xc1() {
        this.opCMP(this.IndirectXAddr, this.a);
        this.incPC();
    }

    @instruction("6502", "CPY", "zpg", 3)
    private inst_0xc4() {
        this.opCMP(this.ZeroPageAddr, this.y);
        this.incPC();
    }

    @instruction("6502", "CMP", "zpg", 3)
    private inst_0xc5() {
        this.opCMP(this.ZeroPageAddr, this.a);
        this.incPC();
    }

    @instruction("6502", "DEC", "zpg", 5)
    private inst_0xc6() {
        this.opDEC(this.ZeroPageAddr);
        this.incPC();
    }

    @instruction("6502", "INY", "imp", 2)
    private inst_0xc8() {
        this.y += 1;
        this.y &= byteMask;
        this.FlagsNZ(this.y);
    }

    @instruction("6502", "CMP", "imm", 2)
    private inst_0xc9() {
        this.opCMP(this.ImmediateAddr, this.a);
        this.incPC();
    }

    @instruction("6502", "DEX", "imp", 2)
    private inst_0xca() {
        this.x -= 1;
        this.x &= byteMask;
        this.FlagsNZ(this.x);
    }

    @instruction("6502", "CPY", "abs", 4)
    private inst_0xcc() {
        this.opCMP(this.AbsoluteAddr, this.y);
        this.incPC(2);
    }

    @instruction("6502", "CMP", "abs", 4)
    private inst_0xcd() {
        this.opCMP(this.AbsoluteAddr, this.a);
        this.incPC(2);
    }

    @instruction("6502", "DEC", "abs", 3)
    private inst_0xce() {
        this.opDEC(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("6502", "BNE", "rel", 2, 2)
    private inst_0xd0() {
        this.bCLR(ZERO);
    }

    @instruction("6502", "CMP", "iny", 5, 1)
    private inst_0xd1() {
        this.opCMP(this.IndirectYAddr, this.a);
        this.incPC();
    }

    @instruction("6502", "CMP", "zpx", 4)
    private inst_0xd5() {
        this.opCMP(this.ZeroPageXAddr, this.a);
        this.incPC();
    }

    @instruction("6502", "DEC", "zpx", 6)
    private inst_0xd6() {
        this.opDEC(this.ZeroPageXAddr);
        this.incPC();
    }

    @instruction("6502", "CLD", "imp", 2)
    private inst_0xd8() {
        this.pCLR(DECIMAL);
    }

    @instruction("6502", "CMP", "aby", 4, 1)
    private inst_0xd9() {
        this.opCMP(this.AbsoluteYAddr, this.a);
        this.incPC(2);
    }

    @instruction("6502", "CMP", "abx", 4, 1)
    private inst_0xdd() {
        this.opCMP(this.AbsoluteXAddr, this.a);
        this.incPC(2);
    }

    @instruction("6502", "DEC", "abx", 7)
    private inst_0xde() {
        this.opDEC(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("6502", "CPX", "imm", 2)
    private inst_0xe0() {
        this.opCMP(this.ImmediateAddr, this.x);
        this.incPC();
    }

    @instruction("6502", "SBC", "inx", 6)
    private inst_0xe1() {
        this.opSBC(this.IndirectXAddr);
        this.incPC();
    }

    @instruction("6502", "CPX", "zpg", 3)
    private inst_0xe4() {
        this.opCMP(this.ZeroPageAddr, this.x);
        this.incPC();
    }

    @instruction("6502", "SBC", "zpg", 3)
    private inst_0xe5() {
        this.opSBC(this.ZeroPageAddr);
        this.incPC();
    }

    @instruction("6502", "INC", "zpg", 5)
    private inst_0xe6() {
        this.opINC(this.ZeroPageAddr);
        this.incPC();
    }

    @instruction("6502", "INX", "imp", 2)
    private inst_0xe8() {
        this.x += 1;
        this.x &= byteMask;
        this.FlagsNZ(this.x);
    }

    @instruction("6502", "SBC", "imm", 2)
    private inst_0xe9() {
        this.opSBC(this.ImmediateAddr);
        this.incPC();
    }

    @instruction("6502", "NOP", "imp", 2)
    private inst_0xea() {
        //pass
    }

    @instruction("6502", "CPX", "abs", 4)
    private inst_0xec() {
        this.opCMP(this.AbsoluteAddr, this.x);
        this.incPC(2);
    }

    @instruction("6502", "SBC", "abs", 4)
    private inst_0xed() {
        this.opSBC(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("6502", "INC", "abs", 6)
    private inst_0xee() {
        this.opINC(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("6502", "BEQ", "rel", 2, 2)
    private inst_0xf0() {
        this.bSET(ZERO);
    }

    @instruction("6502", "SBC", "iny", 5, 1)
    private inst_0xf1() {
        this.opSBC(this.IndirectYAddr);
        this.incPC();
    }

    @instruction("6502", "SBC", "zpx", 4)
    private inst_0xf5() {
        this.opSBC(this.ZeroPageXAddr);
        this.incPC();
    }

    @instruction("6502", "INC", "zpx", 6)
    private inst_0xf6() {
        this.opINC(this.ZeroPageXAddr);
        this.incPC();
    }

    @instruction("6502", "SED", "imp", 2)
    private inst_0xf8() {
        this.pSET(DECIMAL);
    }

    @instruction("6502", "SBC", "aby", 4, 1)
    private inst_0xf9() {
        this.opSBC(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("6502", "SBC", "abx", 4, 1)
    private inst_0xfd() {
        this.opSBC(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("6502", "INC", "abx", 7)
    private inst_0xfe() {
        this.opINC(this.AbsoluteXAddr);
        this.incPC(2);
    }
}
