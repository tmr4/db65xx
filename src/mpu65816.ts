/* eslint-disable @typescript-eslint/naming-convention */
import {
    BYTE_WIDTH, BYTE_FORMAT, WORD_WIDTH, WORD_FORMAT, ADDR_WIDTH, ADDR_FORMAT, ADDRL_WIDTH,
    byteMask, addrMask, addrHighMask, addrMaskL, addrBankMask, spBase,
    NEGATIVE, OVERFLOW, UNUSED, BREAK, DECIMAL, INTERRUPT, ZERO, CARRY, MS, IRS,
    RESET, COP, BRK, ABORT, NMI, IRQ
} from './constants';
import { MPU65XX, instruction } from './mpu65xx';

// 65c816
//   Registers
//       a { represents both 8 and 16 bit accumulator (the 65816 C register is not modeled separately)
//       b { only valid in 8 bit mode (otherwise use high byte of a)
//     x,y { represent both 8 and 16 bit registers. Note that processor flags bit 4 alone cannot indicate
//          whether we are in 8 or 16 bit as during an interrupt this bit will be cleared and instructions
//          would consider the registers as 16-bit even though they are 8-bit.  Thus code checks both
//          processor flags bit 4 and mode where appropriate.
//
export class MPU65816 extends MPU65XX {

    public constructor(memory: Uint8Array | null, pc = 0xfffc) {
        super(pc);

        // config
        this.name = '65C816';
        this.index = 2;
        this.waiting = false;

        if (memory === null) {
            memory = new Uint8Array(0x40000);
        }
        this.memory = memory;
    }

    public reset() {
        super.reset();

        this.b = 0; // b is 8 bit and hidden
        this.dpr = 0;
    }

    /*
        private reprformat() {
            if(this.mode) {
                return ("%s PC   AC XR YR SP NV-BDIZC\n"
                        "%s { %04x %02x %02x %02x %02x %s")
            else {
                return ("%s B  K  PC   AC   XR   YR   SP   D    NVMXDIZC\n"
                        "%s { %02x %02x {%04x %04x %04x %04x %04x %04x %s")
        }

        private __repr__() {
            flags = itoa(this.p, 2).rjust(BYTE_WIDTH, '0')
            indent = ' ' * (len(this.name) + 1)
            if(this.mode) {
                return this.reprformat() % (indent, this.name, this.pc, this.a,
                                            this.x, this.y, this.sp, flags)
            else {
                return this.reprformat() % (indent, this.name, this.dbr, this.pbr, this.pc,
                                            this.a, this.x, this.y, this.sp, this.dpr, flags)
        }
    */

    public step() {
        if (this.waiting) {
            this.processorCycles += 1;
            if (this.IRQ_pin === false) {
                this.waiting = false;
            }
        }
        else {
            super.step();
        }
    }

    // *****************************************************************************
    // Helpers for addressing modes and instructions

    private OperandLong(): number {
        const epc = this.OperandAddr();
        return (this.ByteAt(epc + 2) << ADDR_WIDTH) + this.WordAt(epc);
    }

    // stack related helpers
    private FlagsNZWord(value): void {
        this.p &= ~(ZERO | NEGATIVE);
        if (value === 0) {
            this.p |= ZERO;
        }
        else {
            this.p |= (value >> BYTE_WIDTH) & NEGATIVE;
        }
    }

    // *****************************************************************************
    // *****************************************************************************
    //   Page and Bank Boundary Wrapping
    //
    //   Page Boundary Wrapping
    //   From { http {//6502.org/tutorials/65c816opcodes.html#5.1
    //   Page boundary wrapping only occurs in emulation mode, and only for 65C02 instructions and addressing
    //   modes.  When in emulation mode, page boundary wrapping only occurs in the following situations {
    //       A. The direct page wraps at page boundary only when dpr low byte is 0
    //       B. The stack wraps at the page 1 boundary
    //
    //   Bank Boundary Wrapping
    //   From { http {//6502.org/tutorials/65c816opcodes.html#5.2
    //   Bank boundary wrapping occurs in both native and emulation mode.
    //   The following are confined to bank 0 and thus wrap at the bank 0 boundary {
    //       A. The direct page
    //       B. The stack
    //       C. Absolute Indirect and Absolute Indirect Long addressing modes (only apply to JMP)
    //
    //   The following are confined to bank K and thus wrap at the bank K boundary {
    //       A. Absolute Indirect Indexed X addressing mode (only applies to JMP and JSR)
    //       B. The Program Counter
    //
    //   For the MVN and MVP instructions, the source and destination banks wraps at their bank boundaries.
    //
    //   Otherwise, wrapping does not occur at bank boundaries.

    // *** TODO {
    // per http {//www.6502.org/tutorials/65c816opcodes.html#5.8
    // I assume that page boundary wrapping takes precedence over bank boundary wrapping in
    // emulation mode when dpr low byte is 0
    // ***

    // http {//www.6502.org/tutorials/65c816opcodes.html#5.7 through
    // http {//www.6502.org/tutorials/65c816opcodes.html#5.9
    // discuss wrapping at $00ffff.  Since address modes simply return an
    // address the individual operations will need to handle any wrapping
    // differences (may need a wrap flag passed from the instruction, such as
    // opORA(this.DirectPageAddr, wrapFlag=1) to indicate the address returned
    // by DirectPageAddr needs to be wrapped in certain instances)
    // I would like to verify that the conditions specified in the link above
    // hold before spending the effort to code this

    // Possible affect on cycle counts {
    // When drp starts on a page boundary, the effective address is formed
    // by concatenating the dpr high byte to the direct page offset rather
    //  than simply adding drp and the offset, or {
    //
    //   (this.dpr >> BYTE_WIDTH) + this.ByteAt(epc)
    // vs
    //   this.dpr + this.ByteAt(epc)
    //
    // See 65816 Programming Manual, pg 156, which states that this save 1 cycle

    // new 65816 address modes and instructions don't page boundary wrap
    private dpWrap(offset: number, pageWrap: boolean = true): number {
        // direct page wraps at {
        if (pageWrap && this.mode && ((this.dpr & byteMask) === 0)) {
            // page boundary in emulation mode when dpr low byte = 0
            return this.dpr + (offset & byteMask);
        }
        else {
            // bank 0 boundary
            return (this.dpr + offset) & addrMask;
        }
    }

    // returns bank 0 word at dpaddr, wrapping at page or bank 0 boundary as appropriate
    private dpWrapAt(dpaddr: number): number {
        // direct page indirect address wraps at {
        if (this.mode && ((this.dpr & byteMask) === 0)) {
            // page boundary in emulation mode when dpr low byte = 0
            return this.WrapAt(dpaddr);
        }
        else if (dpaddr === 0xffff) {
            // bank 0 boundary
            return (this.ByteAt(0x0000) << BYTE_WIDTH) + this.ByteAt(dpaddr);
        }
        else {
            return this.WordAt(dpaddr);
        }
    }


    // *****************************************************************************
    // *****************************************************************************

    // Addressing modes

    // address modes have to return an effective address, which is something like {
    //   (this.dbr << ADDR_WIDTH) + this.pc
    // as they are invariably used to directly access memory or in functions that do
    // such as ByteAt and WordAt which take a simple offset into memory
    // Modes that use pbr (e.g. JMP, JSR, etc.) are handled separately in the instructions themselves
    // *** TODO { do we need to restrict effective address to memory model limit? ***

    // New 65816 Specific Addressing Modes {
    // From { https {//softpixel.com/~cwright/sianse/docs/65816NFO.HTM#6.10
    // -------------------------------------
    //    New Mode Name                             Example
    //    -------------------------------------------------------
    //    Absolute Long                             LDA $123456
    //    Absolute Long Indexed X                   LDA $123456,X
    //    Absolute Indexed Indirect                 JMP ($1234,X)
    //    Absolute Indirect Long                    JMP [$1234]
    //    Block Move                                MVP 0,0
    //    Direct Page Indirect                      LDA ($12)
    //    Direct Page Indirect Long                 LDA [$12]
    //    Direct Page Indirect Long Indexed Y       LDA [$77],Y
    //    Program Counter Relative Long             BRL $1234
    //    Stack Relative                            LDA 15,S
    //    Stack Relative Indirect Indexed Y         LDA (9,S),Y

    // new 65816 address modes don't page wrap
    // I assume that Direct Page Indirect is new in name only, it's the 6502's zero page
    // Perhaps this is a reference to the limitations of page wrapping (if(so, why not the others)
    // *** TODO { verify this ***

    // *** TODO: validate extra cycles relative to Bank, can we consolidate this into 65xx? ***
    private AbsoluteXAddr(): number {
        const a1 = (this.dbr << ADDR_WIDTH) + this.OperandWord();
        const a2 = a1 + this.x;
        if (this.addcycles) {
            if ((a1 & addrBankMask) !== (a2 & addrBankMask)) {
                this.excycles += 1;
            }
        }
        return a2;
    }

    private AbsoluteYAddr(): number { // "aby" (9 opcodes)
        const addr = this.OperandWord();
        const a1 = (this.dbr << ADDR_WIDTH) + addr;
        const a2 = a1 + this.y;
        if (this.addcycles) {
            if ((a1 & addrBankMask) !== (a2 & addrBankMask)) {
                this.excycles += 1;
            }
        }
        return a2;
    }

    // Absolute Indirect "abi" (1 opcode) modeled directly in JMP
    // 65C02 and 65816 don't have the 6502 page wrap bug
    // but operand indirection wraps at bank 0 boundary

    private AbsoluteIndirectXAddr(): number { // "aix" (2 opcodes)
        const pb_addr = (this.pbr << ADDR_WIDTH) + this.OperandWord() + this.x;

        // program bank addr indirection wraps at bank boundary
        if ((pb_addr & addrMask) === 0xffff) {
            return (this.ByteAt(this.pbr << ADDR_WIDTH) << BYTE_WIDTH) + this.ByteAt(pb_addr);
        }
        else {
            return this.WordAt(pb_addr);
        }
    }

    // Absolute Indirect Long "ail" (1 opcode) modeled directly in JMP
    // new 65816 address modes don't wrap
    // but operand indirection wraps at bank 0 boundary

    // new 65816 address modes don't wrap
    private AbsoluteLongAddr(): number { // new to 65816, "abl" (10 opcodes)
        // JML and JSL handle this mode separately as they has to change pbr
        return this.OperandLong();
    }

    // new 65816 address modes don't wrap
    private AbsoluteLongXAddr(): number { // new to 65816, "alx" (8 opcodes)
        // *** TODO { add 1 cycle if(mode = 0 (do it either here or in instruction) generally it
        // seems that it's done in address mode private ***
        return this.OperandLong() + this.x;
    }

    // Accumulator "acc" (6 opcodes) modeled as a null address argument in appropriate operation call

    // new 65816 address modes don't wrap
    // Block Move addressing { "blk" (2 opcodes) modeled inline

    private DirectPageAddr(): number { // "dpg" (24 opcodes)
        return this.dpWrap(this.OperandByte());
    }

    private DirectPageXAddr(): number { // "dpx" (18 opcodes)
        return this.dpWrap(this.OperandByte() + this.x);
    }

    private DirectPageYAddr(): number { // "dpy" (2 opcodes)
        return this.dpWrap(this.OperandByte() + this.y);
    }

    private DirectPageIndirectXAddr(): number { // "dix" (8 opcodes)
        const dpaddr = this.dpWrap(this.OperandByte() + this.x);
        const inaddr = this.dpWrapAt(dpaddr);
        return (this.dbr << ADDR_WIDTH) + inaddr;
    }

    private DirectPageIndirectAddr(): number { // "dpi" (8 opcodes)
        const dpaddr = this.dpWrap(this.OperandByte());
        const inaddr = this.dpWrapAt(dpaddr);;
        return (this.dbr << ADDR_WIDTH) + inaddr;
    }

    // new 65816 address modes don't page boundary wrap
    private DirectPageIndirectLongAddr(): number { // new to 65816, "dil" (8 opcodes)
        var bank: number, inaddr: number;

        const dpaddr = this.dpWrap(this.OperandByte(), false);

        // indirect adddress wraps at bank 0 boundary
        if (dpaddr === 0xffff) {
            bank = this.ByteAt(0x0001);
            inaddr = (this.ByteAt(0x0000) << BYTE_WIDTH) + this.ByteAt(dpaddr);
        }
        else if (dpaddr === 0xfffe) {
            bank = this.ByteAt(0x0000);
            inaddr = this.WordAt(dpaddr);
        }
        else {
            bank = this.ByteAt(dpaddr + 2);
            inaddr = this.WordAt(dpaddr);
        }

        return (bank << ADDR_WIDTH) + inaddr;
    }

    private DirectPageIndirectYAddr(): number { // "diy" (8 opcodes)
        // *** TODO { check on excycles ***
        const dpaddr = this.dpWrap(this.OperandByte());
        const inaddr = this.dpWrapAt(dpaddr);
        const efaddr = (this.dbr << ADDR_WIDTH) + inaddr + this.y;
        if (this.addcycles) {
            if ((inaddr & addrBankMask) !== (efaddr & addrBankMask)) {
                this.excycles += 1;
            }
        }
        return efaddr;
    }

    // new 65816 address modes don't page boundary wrap
    private DirectPageIndirectLongYAddr(): number { // new to 65816, "dly" (8 opcodes)
        // *** TODO { check on excycles ***
        const inaddr = this.DirectPageIndirectLongAddr();
        const efaddr = inaddr + this.y;

        if (this.addcycles) {
            if ((inaddr & addrBankMask) !== (efaddr & addrBankMask)) {
                this.excycles += 1;
            }
        }

        return efaddr;
    }

    // Implied addressing "imp" (29 opcodes, 65816 programming manual misses WAI)

    // new 65816 address modes don't wrap
    private ProgramCounterRelLongAddr(): void { // "prl" (1 opcode)
        var addr: number;

        // this.excycles += 1
        const offset = this.OperandWord();
        this.incPC();

        if ((offset >> BYTE_WIDTH) & NEGATIVE) {
            addr = this.pc - (offset ^ addrMask) - 1;
        }
        else {
            addr = this.pc + offset;
        }

        // *** TODO { verify this extra cycle ***
        // if((this.pc & addrHighMask) !== (addr & addrHighMask) {
        //    this.excycles += 1

        this.pc = (this.pbr << ADDR_WIDTH) + (addr & addrMask);
    }

    // These is the WDC Programming Manual breakdown for stack addressing
    // *** TODO { these need cleaned up. Don't need so many distinctions. ***
    // Stack Absolute Addressing "ska" (1 opcode) modeled directly
    // Stack Direct Page Indirect Addressing "ski" (1 opcode) modeled directly
    // Stack Interrupt Addressing "stk" (2 opcodes) modeled directly
    // Stack Program Counter Relative Addressing "spc" (1 opcode) modeled directly
    // Stack Pull Addressing "stk" (6 opcodes) modeled directly
    // Stack Push Addressing "stk" (7 opcodes) modeled directly 65816 Programming manual only lists 6
    // Stack RTI, RTL, RTS Addressing "stk" (3 opcodes) modeled directly

    // new 65816 address modes don't wrap
    private StackRelAddr(): number { // "str" (8 opcode) 65816 Programming manual only lists 4
        return (this.sp + this.OperandByte()) & addrMask;
    }

    // new 65816 address modes don't wrap
    private StackRelIndirectYAddr(): number { // "siy" (8 opcode)
        const spaddr = (this.sp + this.OperandByte()) & addrMask;
        const inaddr = this.WordAt(spaddr);
        // *** TODO { any extra cycles? ***
        return (this.dbr << ADDR_WIDTH) + inaddr + this.y;
    }

    // *****************************************************************************
    // *****************************************************************************
    // Operations

    private opADC(x: () => number) {
        var data: number;

        if (this.p & MS) {
            data = this.ByteAt(x.call(this));
        }
        else {
            data = this.WordAt(x.call(this));
        }

        if (this.p & DECIMAL) {
            var a: number;

            // Includes proposed fix from {
            // https {//github.com/mnaberez/py65/pull/55/commits/666cd9cd99484f769b563218214433d37faa1d87
            // as discussed at { https {//github.com/mnaberez/py65/issues/33
            //
            // This now passed 8-bit BCD tests from {
            // http {//6502.org/tutorials/decimal_mode.html#B
            // that I've modeled at { C {\Users\tmrob\Documents\Projects\65C816\Assembler\decimal
            //
            //       C {\Users\tmrob\Documents\Projects\65C816\Assembler\decimal>bcd
            //
            //       C {\Users\tmrob\Documents\Projects\65C816\Assembler\decimal>py65816mon -m 65c816 -r bcd.bin -i fff0 -o fff1
            //       Wrote +65536 bytes from $0000 to $ffff
            //       -------------------------------------
            //       65816 BCD Tests {
            //       -------------------------------------
            //       BCD,8
            //       Mode     | Test | NV-BDIZC | Result |
            //       -------------------------------------
            //       Emulation  ADC    01-10111   PASS
            //       Emulation  SBC    00-10111   PASS
            //
            //       -------------------------------------
            //       BCD,8
            //       Mode     | Test | NVMXDIZC | Result |
            //       -------------------------------------
            //       Native-8   ADC    01110111   PASS
            //       Native-8   SBC    00110111   PASS
            //

            // 8-bit
            // *** TODO { should try to consolidate these ***
            if (this.p & MS) {

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
                }
                else {
                    if (this.p & MS) {
                        this.p |= aluresult & NEGATIVE;
                    }
                }
                if (decimalcarry === 1) {
                    this.p |= CARRY;
                }
                if ((~(this.a ^ data) & (this.a ^ aluresult)) & NEGATIVE) {
                    this.p |= OVERFLOW;
                }
                a = (nibble1 << 4) + nibble0;
            }
            else {
                // 16 bit
                let halfcarry = 0;
                let decimalcarry = 0;
                let adjust0 = 0;
                let adjust1 = 0;
                let nibble0 = (data & 0xf) + (this.a & 0xf) + (this.p & CARRY);

                //                this.memory[0xfff1] = 0x20
                //                this.memory[0xfff1] = nibble0 + 0x30
                //                this.memory[0xfff1] = 0x20
                //                this.memory[0xfff1] = (this.a & 0xf) + 0x30
                //                this.memory[0xfff1] = 0x20
                //                this.memory[0xfff1] = (data & 0xf) + 0x30
                //                this.memory[0xfff1] = 0x20
                //                this.memory[0xfff1] = (this.p & CARRY) + 0x30

                if (nibble0 > 9) {
                    adjust0 = 6;
                    halfcarry = 1;
                }
                let nibble1 = ((data >> 4) & 0xf) + ((this.a >> 4) & 0xf) + halfcarry;
                halfcarry = 0;
                if (nibble1 > 9) {
                    adjust1 = 6;
                    halfcarry = 1;
                }

                // continue with msb nibbles
                let adjust2 = 0;
                let adjust3 = 0;
                let nibble2 = (((data & 0xf00) + (this.a & 0xf00)) >> 8) + halfcarry;
                halfcarry = 0;
                if (nibble2 > 9) {
                    adjust2 = 6;
                    halfcarry = 1;
                }
                let nibble3 = ((((data >> 4) & 0xf00) + ((this.a >> 4) & 0xf00)) >> 8) + halfcarry;
                if (nibble3 > 9) {
                    adjust3 = 6;
                    decimalcarry = 1;
                }

                // the ALU outputs are not decimally adjusted
                nibble0 = nibble0 & 0xf;
                nibble1 = nibble1 & 0xf;
                nibble2 = nibble2 & 0xf;
                nibble3 = nibble3 & 0xf;

                // the final A contents will be decimally adjusted
                nibble0 = (nibble0 + adjust0) & 0xf;
                nibble1 = (nibble1 + adjust1) & 0xf;
                nibble2 = (nibble2 + adjust2) & 0xf;
                nibble3 = (nibble3 + adjust3) & 0xf;

                // Update result for use in setting flags below
                const aluresult = (nibble3 << 12) + (nibble2 << 8) + (nibble1 << 4) + nibble0;
                //                this.memory[0xfff1] = nibble3 + 0x30
                //                this.memory[0xfff1] = nibble2 + 0x30
                //                this.memory[0xfff1] = nibble1 + 0x30
                //                this.memory[0xfff1] = nibble0 + 0x30
                //                this.memory[0xfff1] = 0x20

                this.p &= ~(CARRY | OVERFLOW | NEGATIVE | ZERO);
                if (aluresult === 0) {
                    this.p |= ZERO;
                }
                else {
                    this.p |= (aluresult >> BYTE_WIDTH) & NEGATIVE;
                }

                if (decimalcarry === 1) {
                    this.p |= CARRY;
                }
                // if((~(this.a ^ data) & (this.a ^ aluresult)) & NEGATIVE {
                //    this.p |= OVERFLOW
                a = aluresult;

                if (((~(this.a ^ data) & (this.a ^ aluresult)) >> BYTE_WIDTH) & NEGATIVE) {
                    this.p |= OVERFLOW;
                }
            }

            this.a = a;
        }
        else {
            var tmp: number;

            if (this.p & CARRY) {
                tmp = 1;
            }
            else {
                tmp = 0;
            }
            const result = data + this.a + tmp;
            this.p &= ~(CARRY | OVERFLOW | NEGATIVE | ZERO);

            if (this.p & MS) {
                if ((~(this.a ^ data) & (this.a ^ result)) & NEGATIVE) {
                    this.p |= OVERFLOW;
                }
            }
            else {
                if ((~(this.a ^ data) & (this.a ^ result)) & (NEGATIVE << BYTE_WIDTH)) {
                    this.p |= OVERFLOW;
                }
            }
            data = result;
            if (this.p & MS) {
                if (data > byteMask) {
                    this.p |= CARRY;
                    data &= byteMask;
                }
            }
            else {
                if (data > addrMask) {
                    this.p |= CARRY;
                    data &= addrMask;
                }
            }
            if (data === 0) {
                this.p |= ZERO;
            }
            else {
                if (this.p & MS) {
                    this.p |= data & NEGATIVE;
                }
                else {
                    this.p |= (data >> BYTE_WIDTH) & NEGATIVE;
                }
            }
            this.a = data;
        }
    }

    private opAND(x: () => number) {
        if (this.p & MS) {
            this.a &= this.ByteAt(x.call(this));
            this.FlagsNZ(this.a);
        }
        else {
            this.a &= this.WordAt(x.call(this));
            this.FlagsNZWord(this.a);
        }
    }

    private opASL(x: (() => number) | null) {
        var tbyte: number, addr: number = 0;

        if (x === null) {
            tbyte = this.a;
        }
        else {
            addr = x.call(this);
            if (this.p & MS) {
                tbyte = this.ByteAt(addr);
            }
            else {
                tbyte = this.WordAt(addr);
            }
        }

        this.p &= ~(CARRY | NEGATIVE | ZERO);

        if (this.p & MS) {
            if (tbyte & NEGATIVE) {
                this.p |= CARRY;
            }
            tbyte = (tbyte << 1) & byteMask;
        }
        else {
            if ((tbyte >> BYTE_WIDTH) & NEGATIVE) {
                this.p |= CARRY;
            }
            tbyte = (tbyte << 1) & addrMask;
        }

        if (tbyte) {
            if (this.p & MS) {
                this.p |= tbyte & NEGATIVE;
            }
            else {
                this.p |= (tbyte >> BYTE_WIDTH) & NEGATIVE;
            }
        }
        else {
            this.p |= ZERO;
        }

        if (x === null) {
            this.a = tbyte;
        }
        else {
            if (this.p & MS) {
                this.memory[addr] = tbyte;
            }
            else {
                this.memory[addr] = tbyte & byteMask;
                this.memory[addr + 1] = tbyte >> BYTE_WIDTH;
            }
        }
    }

    private opBIT(x: () => number) {
        var tbyte: number;

        if (this.p & MS) {
            tbyte = this.ByteAt(x.call(this));
        }
        else {
            tbyte = this.WordAt(x.call(this));
        }

        this.p &= ~(ZERO | NEGATIVE | OVERFLOW);
        if ((this.a & tbyte) === 0) {
            this.p |= ZERO;
        }
        if (this.p & MS) {
            this.p |= tbyte & (NEGATIVE | OVERFLOW);
        }
        else {
            this.p |= (tbyte >> BYTE_WIDTH) & (NEGATIVE | OVERFLOW);
        }
    }

    private opCMP(addr: (() => number), register_value, bit_flag) {
        var tbyte: number, result: number;

        if ((bit_flag === IRS) && this.mode) {
            bit_flag = 1;
        }
        else {
            bit_flag = this.p & bit_flag;
        }

        if (bit_flag) {
            tbyte = this.ByteAt(addr.call(this));
        }
        else {
            tbyte = this.WordAt(addr.call(this));
        }

        this.p &= ~(CARRY | ZERO | NEGATIVE);

        result = register_value - tbyte;

        if (result === 0) {
            this.p |= CARRY | ZERO;
        }
        else if (result > 0) {
            this.p |= CARRY;
        }

        if (bit_flag) {
            this.p |= result & NEGATIVE;
        }
        else {
            this.p |= (result >> BYTE_WIDTH) & NEGATIVE;
        }
    }

    private opDEC(x: (() => number) | null) {
        var tbyte: number, addr: number = 0;

        if (x === null) {
            tbyte = this.a;
        }
        else {
            addr = x.call(this);
            if (this.p & MS) {
                tbyte = this.ByteAt(addr);
            }
            else {
                tbyte = this.WordAt(addr);
            }
        }

        this.p &= ~(ZERO | NEGATIVE);
        if (this.p & MS) {
            tbyte = (tbyte - 1) & byteMask;
        }
        else {
            tbyte = (tbyte - 1) & addrMask;
        }

        if (tbyte) {
            if (this.p & MS) {
                this.p |= tbyte & NEGATIVE;
            }
            else {
                this.p |= (tbyte >> BYTE_WIDTH) & NEGATIVE;
            }
        }
        else {
            this.p |= ZERO;
        }

        if (x === null) {
            this.a = tbyte;
        }
        else {
            if (this.p & MS) {
                this.memory[addr] = tbyte & byteMask;
            }
            else {
                this.memory[addr] = tbyte & byteMask;
                this.memory[addr + 1] = (tbyte >> BYTE_WIDTH);
            }
        }
    }

    private opEOR(x: () => number) {
        if (this.p & MS) {
            this.a ^= this.ByteAt(x.call(this));
            this.FlagsNZ(this.a);
        }
        else {
            this.a ^= this.WordAt(x.call(this));
            this.FlagsNZWord(this.a);
        }
    }

    private opINC(x: (() => number) | null) {
        var tbyte: number, addr: number = 0;

        if (x === null) {
            tbyte = this.a;
        }
        else {
            addr = x.call(this);
            if (this.p & MS) {
                tbyte = this.ByteAt(addr);
            }
            else {
                tbyte = this.WordAt(addr);
            }
        }

        this.p &= ~(ZERO | NEGATIVE);
        if (this.p & MS) {
            tbyte = (tbyte + 1) & byteMask;
        }
        else {
            tbyte = (tbyte + 1) & addrMask;
        }
        if (tbyte) {
            if (this.p & MS) {
                this.p |= tbyte & NEGATIVE;
            }
            else {
                this.p |= (tbyte >> BYTE_WIDTH) & NEGATIVE;
            }
        }
        else {
            this.p |= ZERO;
        }

        if (x === null) {
            this.a = tbyte;
        }
        else {
            if (this.p & MS) {
                this.memory[addr] = tbyte & byteMask;
            }
            else {
                this.memory[addr] = tbyte & byteMask;
                this.memory[addr + 1] = (tbyte >> BYTE_WIDTH);
            }
        }
    }

    private opLDA(x: () => number) {
        if (this.p & MS) {
            this.a = this.ByteAt(x.call(this));
            this.FlagsNZ(this.a);
        }
        else {
            this.a = this.WordAt(x.call(this));
            this.FlagsNZWord(this.a);
        }
    }

    private opLDX(y: () => number) {
        if ((this.p & IRS) || this.mode) {
            this.x = this.ByteAt(y.call(this));
            this.FlagsNZ(this.x);
        }
        else {
            this.x = this.WordAt(y.call(this));
            this.FlagsNZWord(this.x);
        }
    }

    private opLDY(x: () => number) {
        if ((this.p & IRS) || this.mode) {
            this.y = this.ByteAt(x.call(this));
            this.FlagsNZ(this.y);
        }
        else {
            this.y = this.WordAt(x.call(this));
            this.FlagsNZWord(this.y);
        }
    }

    private opLSR(x: (() => number) | null) {
        var tbyte: number, addr: number = 0;

        if (x === null) {
            tbyte = this.a;
        }
        else {
            addr = x.call(this);
            if (this.p & MS) {
                tbyte = this.ByteAt(addr);
            }
            else {
                tbyte = this.WordAt(addr);
            }
        }

        this.p &= ~(CARRY | NEGATIVE | ZERO);
        this.p |= tbyte & 1;

        tbyte = tbyte >> 1;
        if (tbyte) {
            //pass
        }
        else {
            this.p |= ZERO;
        }

        if (x === null) {
            this.a = tbyte;
        }
        else {
            if (this.p & MS) {
                this.memory[addr] = tbyte;
            }
            else {
                this.memory[addr] = tbyte & byteMask;
                this.memory[addr + 1] = tbyte >> BYTE_WIDTH;
            }
        }
    }

    private opMVB(inc: number) {
        // X is source, Y is dest, A is bytes to move - 1
        // If inc = 1 the addresses are the start
        // If inc = -1 the addresses are the end
        // Operand lsb is dest dbr, msb is source
        const dbr = this.OperandByte() << ADDR_WIDTH;
        const sbr = (this.OperandWord() >> BYTE_WIDTH) << ADDR_WIDTH;
        this.memory[dbr + this.y] = this.memory[sbr + this.x];
        this.x += inc;
        this.y += inc;
        if ((this.p & IRS) || this.mode) {
            this.x &= byteMask;
            this.y &= byteMask;
        }
        else {
            this.x &= addrMask;
            this.y &= addrMask;
        }

        if (this.p & MS) {
            const c = (this.b << BYTE_WIDTH) + this.a - 1;
            this.a = c & byteMask;
            this.b = (c >> BYTE_WIDTH) & byteMask;
        }
        else {
            this.a -= 1;
            this.a &= addrMask;
        }
    }

    private opORA(x: () => number) {
        if (this.p & MS) {
            this.a |= this.ByteAt(x.call(this));
            this.FlagsNZ(this.a);
        }
        else {
            this.a |= this.WordAt(x.call(this));
            this.FlagsNZWord(this.a);
        }
    }

    private opROL(x: (() => number) | null) {
        var tbyte: number, addr: number = 0;

        if (x === null) {
            tbyte = this.a;
        }
        else {
            addr = x.call(this);
            if (this.p & MS) {
                tbyte = this.ByteAt(addr);
            }
            else {
                tbyte = this.WordAt(addr);
            }
        }

        if (this.p & CARRY) {
            if (this.p & MS) {
                if (tbyte & NEGATIVE) {
                    //pass
                }
                else {
                    this.p &= ~CARRY;
                }
            }
            else {
                if ((tbyte >> BYTE_WIDTH) & NEGATIVE) {
                    //pass
                }
                else {
                    this.p &= ~CARRY;
                }
            }

            tbyte = (tbyte << 1) | 1;
        }
        else {
            if (this.p & MS) {
                if (tbyte & NEGATIVE) {
                    this.p |= CARRY;
                }
            }
            else {
                if ((tbyte >> BYTE_WIDTH) & NEGATIVE) {
                    this.p |= CARRY;
                }
            }
            tbyte = tbyte << 1;
        }

        if (this.p & MS) {
            tbyte &= byteMask;
            this.FlagsNZ(tbyte);
        }
        else {
            tbyte &= addrMask;
            this.FlagsNZWord(tbyte);
        }

        if (x === null) {
            this.a = tbyte;
        }
        else {
            if (this.p & MS) {
                this.memory[addr] = tbyte & byteMask;
            }
            else {
                this.memory[addr] = tbyte & byteMask;
                this.memory[addr + 1] = tbyte >> BYTE_WIDTH;
            }
        }
    }

    private opROR(x: (() => number) | null) {
        var tbyte: number, addr: number = 0;

        if (x === null) {
            tbyte = this.a;
        }
        else {
            addr = x.call(this);
            if (this.p & MS) {
                tbyte = this.ByteAt(addr);
            }
            else {
                tbyte = this.WordAt(addr);
            }
        }

        if (this.p & CARRY) {
            if (tbyte & 1) {
                //pass
            }
            else {
                this.p &= ~CARRY;
            }
            if (this.p & MS) {
                tbyte = (tbyte >> 1) | NEGATIVE;
            }
            else {
                tbyte = (tbyte >> 1) | (NEGATIVE << BYTE_WIDTH);
            }
        }
        else {
            if (tbyte & 1) {
                this.p |= CARRY;
            }
            tbyte = tbyte >> 1;
        }

        if (this.p & MS) {
            this.FlagsNZ(tbyte);
        }
        else {
            this.FlagsNZWord(tbyte);
        }

        if (x === null) {
            this.a = tbyte;
        }
        else {
            if (this.p & MS) {
                this.memory[addr] = tbyte & byteMask;
            }
            else {
                this.memory[addr] = tbyte & byteMask;
                this.memory[addr + 1] = tbyte >> BYTE_WIDTH;
            }
        }
    }

    private opSBC(x: () => number) {
        var data: number;

        if (this.p & MS) {
            data = this.ByteAt(x.call(this));
        }
        else {
            data = this.WordAt(x.call(this));
        }

        if (this.p & DECIMAL) {
            // https {//github.com/mnaberez/py65/pull/55/commits/666cd9cd99484f769b563218214433d37faa1d87
            // as discussed at { https {//github.com/mnaberez/py65/issues/33
            //
            // This now passed 8-bit BCD tests from {
            // http {//6502.org/tutorials/decimal_mode.html#B
            // that I've modeled at { C {\Users\tmrob\Documents\Projects\65C816\Assembler\decimal
            //
            //       C {\Users\tmrob\Documents\Projects\65C816\Assembler\decimal>bcd
            //
            //       C {\Users\tmrob\Documents\Projects\65C816\Assembler\decimal>py65816mon -m 65c816 -r bcd.bin -i fff0 -o fff1
            //       Wrote +65536 bytes from $0000 to $ffff
            //       -------------------------------------
            //       65816 BCD Tests {
            //       -------------------------------------
            //       BCD,8
            //       Mode     | Test | NV-BDIZC | Result |
            //       -------------------------------------
            //       Emulation  ADC    01-10111   PASS
            //       Emulation  SBC    00-10111   PASS
            //
            //       -------------------------------------
            //       BCD,8
            //       Mode     | Test | NVMXDIZC | Result |
            //       -------------------------------------
            //       Native-8   ADC    01110111   PASS
            //       Native-8   SBC    00110111   PASS
            //

            // 8-bit
            // *** TODO { should try to consolidate these ***
            if (this.p & MS) {

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
                }
                else {
                    this.p |= aluresult & NEGATIVE;
                }
                if (decimalcarry === 1) {
                    this.p |= CARRY;
                }
                if (((this.a ^ data) & (this.a ^ aluresult)) & NEGATIVE) {
                    this.p |= OVERFLOW;
                }
                this.a = aluresult;
            }
            else {
                // 16 bit
                let halfcarry = 1;
                let decimalcarry = 0;
                let adjust0 = 0;
                let adjust1 = 0;
                let nibble0 = (this.a & 0xf) + (~data & 0xf) + (this.p & CARRY);

                //                this.memory[0xfff1] = 0x20
                //                this.memory[0xfff1] = nibble0 + 0x30
                //                this.memory[0xfff1] = 0x20
                //                this.memory[0xfff1] = (this.a & 0xf) + 0x30
                //                this.memory[0xfff1] = 0x20
                //                this.memory[0xfff1] = (data & 0xf) + 0x30
                //                this.memory[0xfff1] = 0x20
                //                this.memory[0xfff1] = (this.p & CARRY) + 0x30
                //                this.a = (nibble1 << 4) + nibble0
                //                this.a = 0
                //                this.a = 0xffff

                if (nibble0 <= 0xf) {
                    halfcarry = 0;
                    adjust0 = 10;
                }
                let nibble1 = ((this.a >> 4) & 0xf) + ((~data >> 4) & 0xf) + halfcarry;
                halfcarry = 1;
                if (nibble1 <= 0xf) {
                    halfcarry = 0;
                    adjust1 = 10 << 4;
                }
                // continue with msb nibbles
                let adjust2 = 0;
                let adjust3 = 0;
                let nibble2 = (((this.a & 0xf00) + (~data & 0xf00)) >> 8) + halfcarry;
                halfcarry = 1;
                if (nibble2 <= 0xf) {
                    halfcarry = 0;
                    adjust2 = 10;
                }
                let nibble3 = ((((this.a >> 4) & 0xf00) + ((~data >> 4) & 0xf00)) >> 8) + halfcarry;
                if (nibble3 <= 0xf) {
                    adjust3 = 10 << 4;
                }

                // the ALU outputs are not decimally adjusted
                let aluresult = this.a + (~data & addrMask) + (this.p & CARRY);

                if (aluresult > addrMask) {
                    decimalcarry = 1;
                }
                const aluresultL = aluresult & byteMask;
                const aluresultH = (aluresult >> BYTE_WIDTH) & byteMask;

                // but the final result will be adjusted
                nibble0 = (aluresultL + adjust0) & 0xf;
                nibble1 = ((aluresultL + adjust1) >> 4) & 0xf;
                nibble2 = (aluresultH + adjust2) & 0xf;
                nibble3 = ((aluresultH + adjust3) >> 4) & 0xf;

                // Update result for use in setting flags below
                aluresult = (nibble3 << 12) + (nibble2 << 8) + (nibble1 << 4) + nibble0;

                this.p &= ~(CARRY | ZERO | NEGATIVE | OVERFLOW);
                if (aluresult === 0) {
                    this.p |= ZERO;
                }
                else {
                    this.p |= (aluresult >> BYTE_WIDTH) & NEGATIVE;
                }
                if (decimalcarry === 1) {
                    this.p |= CARRY;
                }
                if ((((this.a ^ data) & (this.a ^ aluresult)) >> BYTE_WIDTH) & NEGATIVE) {
                    this.p |= OVERFLOW;
                }
                this.a = aluresult;
            }
        }
        else {
            var result: number;

            if (this.p & MS) {
                result = this.a + (~data & byteMask) + (this.p & CARRY);
            }
            else {
                result = this.a + (~data & addrMask) + (this.p & CARRY);
            }
            this.p &= ~(CARRY | ZERO | OVERFLOW | NEGATIVE);
            if (this.p & MS) {
                if (((this.a ^ data) & (this.a ^ result)) & NEGATIVE) {
                    this.p |= OVERFLOW;
                }
                data = result & byteMask;
                if (result > byteMask) {
                    this.p |= CARRY;
                }
                this.p |= data & NEGATIVE;
            }
            else {
                if ((((this.a ^ data) & (this.a ^ result)) >> BYTE_WIDTH) & NEGATIVE) {
                    this.p |= OVERFLOW;
                }
                data = result & addrMask;
                if (result > addrMask) {
                    this.p |= CARRY;
                }
                this.p |= (data >> BYTE_WIDTH) & NEGATIVE;
            }
            if (data === 0) {
                this.p |= ZERO;
            }

            this.a = data;
        }
    }

    private opSTA(x: () => number) {
        const addr = x.call(this);

        if (this.p & MS) {
            this.memory[addr] = this.a & byteMask;
        }
        else {
            this.memory[addr] = this.a & byteMask;
            this.memory[addr + 1] = (this.a >> BYTE_WIDTH) & byteMask;
        }
    }

    private opSTX(y: () => number) {
        const addr = y.call(this);

        // need to be explicit with mode as bit 4 can be 0 in mode 1 with an interrupt
        if ((this.p & IRS) || this.mode) {
            this.memory[addr] = this.x & byteMask;
        }
        else {
            this.memory[addr] = this.x & byteMask;
            this.memory[addr + 1] = (this.x >> BYTE_WIDTH) & byteMask;
        }
    }

    private opSTY(x: () => number) {
        const addr = x.call(this);

        // need to be explicit with mode as bit 4 can be 0 in mode 1 with an interrupt
        if ((this.p & IRS) || this.mode) {
            this.memory[addr] = this.y & byteMask;
        }
        else {
            this.memory[addr] = this.y & byteMask;
            this.memory[addr + 1] = (this.y >> BYTE_WIDTH) & byteMask;
        }
    }

    private opSTZ(x: () => number) {
        const addr = x.call(this);

        if (this.p & MS) {
            this.memory[addr] = 0x00;
        }
        else {
            this.memory[addr] = 0x00;
            this.memory[addr + 1] = 0x00;
        }
    }

    private opTSB(x: () => number) {
        var m, r, z;
        const addr = x.call(this);

        if (this.p & MS) {
            m = this.memory[addr];
        }
        else {
            m = (this.memory[addr + 1] << BYTE_WIDTH) + this.memory[addr];
        }

        this.p &= ~ZERO;
        z = m & this.a;
        if (z === 0) {
            this.p |= ZERO;
        }

        r = m | this.a;
        if (this.p & MS) {
            this.memory[addr] = r;
        }
        else {
            this.memory[addr] = r & byteMask;
            this.memory[addr + 1] = (r >> BYTE_WIDTH) & byteMask;
        }
    }

    private opTRB(x: () => number) {
        var m, r, z;
        const addr = x.call(this);

        if (this.p & MS) {
            m = this.memory[addr];
        }
        else {
            m = (this.memory[addr + 1] << BYTE_WIDTH) + this.memory[addr];
        }

        this.p &= ~ZERO;
        z = m & this.a;
        if (z === 0) {
            this.p |= ZERO;
        }

        r = m & ~this.a;
        if (this.p & MS) {
            this.memory[addr] = r;
        }
        else {
            this.memory[addr] = r & byteMask;
            this.memory[addr + 1] = (r >> BYTE_WIDTH) & byteMask;
        }
    }

    // *****************************************************************************
    // *****************************************************************************
    // Instructions

    // *** TODO: extra cycles need considered for all new to 65816 only opcodes ***    }

    @instruction("65816", "BRK", "stk", 7)
    private inst_0x00() {
        if (!this.mode) {
            this.stPush(this.pbr);
        }

        // pc has already been increased one
        // increment for optional signature byte
        const pc = (this.pc + 1) & addrMask;
        this.stPushWord(pc);

        if (this.mode) {
            this.p |= BREAK;
            this.stPush(this.p | BREAK | UNUSED);
        }
        else {
            this.stPush(this.p);
        }

        this.p |= INTERRUPT;
        this.pbr = 0;
        if (this.mode) {
            this.pc = this.WordAt(IRQ[this.mode]);
        }
        else {
            this.pc = this.WordAt(BRK);
        }

        // 65C816 clears decimal flag, NMOS 6502 does not
        this.p &= ~DECIMAL;
    }

    @instruction("65816", "ORA", "dix", 6)
    private inst_0x01() {
        this.opORA(this.DirectPageIndirectXAddr);
        this.incPC();
    }

    @instruction("65816", "COP", "stk", 7)  // new to 65816
    private inst_0x02() {
        // *** TODO: consider consolidating with BRK ***
        if (!this.mode) {
            this.stPush(this.pbr);
        }

        // pc has already been increased one
        // increment for optional signature byte
        const pc = (this.pc + 1) & addrMask;
        this.stPushWord(pc);

        this.stPush(this.p);

        this.p |= INTERRUPT;
        this.pbr = 0;
        this.pc = this.WordAt(COP[this.mode]);

        // 65C816 clears decimal flag
        this.p &= ~DECIMAL;
    }

    @instruction("65816", "ORA", "str", 2)  // new to 65816
    private inst_0x03() {
        this.opORA(this.StackRelAddr);
        this.incPC();
    }

    @instruction("65816", "TSB", "dpg", 5)
    private inst_0x04() {
        this.opTSB(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("65816", "ORA", "dpg", 3)
    private inst_0x05() {
        this.opORA(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("65816", "ASL", "dpg", 5)
    private inst_0x06() {
        this.opASL(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("65816", "ORA", "dil", 6)  // new to 65816
    private inst_0x07() {
        this.opORA(this.DirectPageIndirectLongAddr);
        this.incPC();
    }

    @instruction("65816", "PHP", "stk", 3)
    private inst_0x08() {
        if (this.mode) {
            this.stPush(this.p | BREAK | UNUSED);
        }
        else {
            this.stPush(this.p);
        }
    }

    @instruction("65816", "ORA", "imm", 2)
    private inst_0x09() {
        this.opORA(this.ImmediateAddr);
        this.incPC(2 - ((this.p & MS) >> 5));
    }

    @instruction("65816", "ASL", "acc", 2)
    private inst_0x0a() {
        this.opASL(null);
    }

    @instruction("65816", "PHD", "stk", 4) // new to 65816
    private inst_0x0b() {
        this.stPushWord(this.dpr);
    }

    @instruction("65816", "TSB", "abs", 6)
    private inst_0x0c() {
        this.opTSB(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("65816", "ORA", "abs", 4)
    private inst_0x0d() {
        this.opORA(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("65816", "ASL", "abs", 6)
    private inst_0x0e() {
        this.opASL(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("65816", "ORA", "abl", 5) // new to 65816
    private inst_0x0f() {
        this.opORA(this.AbsoluteLongAddr);
        this.incPC(3);
    }

    @instruction("65816", "BPL", "pcr", 2, 2)
    private inst_0x10() {
        this.bCLR(NEGATIVE);
    }

    @instruction("65816", "ORA", "diy", 5, 1)
    private inst_0x11() {
        this.opORA(this.DirectPageIndirectYAddr);
        this.incPC();
    }

    @instruction("65816", "ORA", "dpi", 5)
    private inst_0x12() {
        this.opORA(this.DirectPageIndirectAddr);
        this.incPC();
    }

    @instruction("65816", "ORA", "siy", 7) // new to 65816
    private inst_0x13() {
        this.opORA(this.StackRelIndirectYAddr);
        this.incPC();
    }

    @instruction("65816", "TRB", "dpg", 5)
    private inst_0x14() {
        this.opTRB(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("65816", "ORA", "dpx", 4)
    private inst_0x15() {
        this.opORA(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("65816", "ASL", "dpx", 6)
    private inst_0x16() {
        this.opASL(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("65816", "ORA", "dly", 6)  // new to 65816
    private inst_0x17() {
        this.opORA(this.DirectPageIndirectLongYAddr);
        this.incPC();
    }

    @instruction("65816", "CLC", "imp", 2)
    private inst_0x18() {
        this.pCLR(CARRY);
    }

    @instruction("65816", "ORA", "aby", 4, 1)
    private inst_0x19() {
        this.opORA(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("65816", "INC", "acc", 2)
    private inst_0x1a() {
        this.opINC(null);
    }

    @instruction("65816", "TCS", "imp", 2) // new to 65816
    private inst_0x1b() {
        if (this.p & MS) {
            // A is 8 bit
            if (this.mode) {
                // high byte is forced to 1 elsewhere
                this.sp = this.a & byteMask;
            }
            else {
                // hidden B is transfered
                this.sp = (this.b << BYTE_WIDTH) + this.a;
            }
        }
        else {
            // A is 16 bit
            this.sp = this.a;
        }
    }

    @instruction("65816", "TRB", "abs", 6)
    private inst_0x1c() {
        this.opTRB(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("65816", "ORA", "abx", 4, 1)
    private inst_0x1d() {
        this.opORA(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("65816", "ASL", "abx", 7)
    private inst_0x1e() {
        this.opASL(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("65816", "ORA", "alx", 5) // new to 65816
    private inst_0x1f() {
        this.opORA(this.AbsoluteLongXAddr);
        this.incPC(3);
    }

    @instruction("65816", "JSR", "abs", 6)
    private inst_0x20() {
        this.stPushWord((this.pc + 1) & addrMask);
        this.pc = this.OperandWord();
    }

    @instruction("65816", "AND", "dix", 6)
    private inst_0x21() {
        this.opAND(this.DirectPageIndirectXAddr);
        this.incPC();
    }

    @instruction("65816", "JSL", "abl", 8) // new to 65816
    private inst_0x22() {
        this.stPush(this.pbr);
        this.stPushWord((this.pc + 2) & addrMask);
        const pbr = this.ByteAt((this.pbr << ADDR_WIDTH) + this.pc + 2);
        this.pc = this.OperandWord();
        this.pbr = pbr;
    }

    @instruction("65816", "AND", "str", 4) // new to 65816
    private inst_0x23() {
        this.opAND(this.StackRelAddr);
        this.incPC();
    }

    @instruction("65816", "BIT", "dpg", 3)
    private inst_0x24() {
        this.opBIT(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("65816", "AND", "dpg", 3)
    private inst_0x25() {
        this.opAND(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("65816", "ROL", "dpg", 5)
    private inst_0x26() {
        this.opROL(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("65816", "AND", "dil", 6)  // new to 65816
    private inst_0x27() {
        this.opAND(this.DirectPageIndirectLongAddr);
        this.incPC();
    }

    @instruction("65816", "PLP", "stk", 4)
    private inst_0x28() {
        const p = this.stPop();
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

    @instruction("65816", "AND", "imm", 2)
    private inst_0x29() {
        this.opAND(this.ImmediateAddr);
        this.incPC(2 - ((this.p & MS) >> 5));
    }

    @instruction("65816", "ROL", "acc", 2)
    private inst_0x2a() {
        this.opROL(null);
    }

    @instruction("65816", "PLD", "stk", 5) // new to 65816
    private inst_0x2b() {
        this.dpr = this.stPopWord();
    }

    @instruction("65816", "BIT", "abs", 4)
    private inst_0x2c() {
        this.opBIT(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("65816", "AND", "abs", 4)
    private inst_0x2d() {
        this.opAND(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("65816", "ROL", "abs", 6)
    private inst_0x2e() {
        this.opROL(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("65816", "AND", "abl", 5) // new to 65816
    private inst_0x2f() {
        this.opAND(this.AbsoluteLongAddr);
        this.incPC(3);
    }

    @instruction("65816", "BMI", "pcr", 2, 2)
    private inst_0x30() {
        this.bSET(NEGATIVE);
    }

    @instruction("65816", "AND", "diy", 5, 1)
    private inst_0x31() {
        this.opAND(this.DirectPageIndirectYAddr);
        this.incPC();
    }

    @instruction("65816", "AND", "dpi", 5)
    private inst_0x32() {
        this.opAND(this.DirectPageIndirectAddr);
        this.incPC();
    }

    @instruction("65816", "AND", "siy", 7) // new to 65816
    private inst_0x33() {
        this.opAND(this.StackRelIndirectYAddr);
        this.incPC();
    }

    @instruction("65816", "BIT", "dpx", 4)
    private inst_0x34() {
        this.opBIT(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("65816", "AND", "dpx", 4)
    private inst_0x35() {
        this.opAND(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("65816", "ROL", "dpx", 6)
    private inst_0x36() {
        this.opROL(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("65816", "AND", "dly", 7) // new to 65816
    private inst_0x37() {
        this.opAND(this.DirectPageIndirectLongYAddr);
        this.incPC();
    }

    @instruction("65816", "SEC", "imp", 2)
    private inst_0x38() {
        this.pSET(CARRY);
    }

    @instruction("65816", "AND", "aby", 4, 1)
    private inst_0x39() {
        this.opAND(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("65816", "DEC", "acc", 2)
    private inst_0x3a() {
        this.opDEC(null);
    }

    @instruction("65816", "TSC", "imp", 2) // new to 65816
    private inst_0x3b() {
        if (this.p & MS) {
            // A is 8 bit, hidden B is set to high byte
            if (this.mode) {
                this.b = 0x01;
            }
            else {
                this.b = this.sp >> BYTE_WIDTH;
            }
            this.a = this.sp & byteMask;
        }
        else {
            // A is 16 bit
            this.a = this.sp;
        }

        this.FlagsNZWord(this.sp);
    }

    @instruction("65816", "BIT", "abx", 4)
    private inst_0x3c() {
        this.opBIT(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("65816", "AND", "abx", 4, 1)
    private inst_0x3d() {
        this.opAND(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("65816", "ROL", "abx", 7)
    private inst_0x3e() {
        this.opROL(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("65816", "AND", "alx", 5) // new to 65816
    private inst_0x3f() {
        this.opAND(this.AbsoluteLongXAddr);
        this.incPC(3);
    }

    @instruction("65816", "RTI", "stk", 6)
    private inst_0x40() {
        var p;

        if (this.mode) {
            this.p = (this.stPop() | BREAK | UNUSED);
            this.pc = this.stPopWord();
        }
        else {
            p = this.stPop();
            this.pc = this.stPopWord();
            this.pbr = this.stPop();

            // reflect any change in register modes
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

    @instruction("65816", "EOR", "dix", 6)
    private inst_0x41() {
        this.opEOR(this.DirectPageIndirectXAddr);
        this.incPC();
    }

    @instruction("65816", "WDM", "imp", 2) // new to 65816
    private inst_0x42() {
        // shouldn't be used but if this acts like a two byte NOP
        this.incPC();
    }

    @instruction("65816", "EOR", "str", 4) // new to 65816
    private inst_0x43() {
        this.opEOR(this.StackRelAddr);
        this.incPC();
    }

    @instruction("65816", "MVP", "blk", 7) // new to 65816
    private inst_0x44() {
        // MVP handles interrupts by not incrementing pc until C === $ffff
        // thus like the 65816 it completes the current byte transfer before
        // breaking for the interrupt and then returns
        // X is source, Y is dest ending addresses; A is bytes to move - 1
        // Operand lsb is dest dbr, msb is source
        var c;

        if (this.p & MS) {
            c = (this.b << BYTE_WIDTH) + this.a;
        }
        else {
            c = this.a;
        }

        if (c !== 0xffff) {
            this.opMVB(-1);
            this.pc -= 1; // move pc back to the MVP instruction
        }
        else {
            this.dbr = this.OperandByte();
            this.incPC(2);
        }
    }

    @instruction("65816", "EOR", "dpg", 3)
    private inst_0x45() {
        this.opEOR(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("65816", "LSR", "dpg", 5)
    private inst_0x46() {
        this.opLSR(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("65816", "EOR", "dil", 6) // new to 65816
    private inst_0x47() {
        this.opEOR(this.DirectPageIndirectLongAddr);
        this.incPC();
    }

    @instruction("65816", "PHA", "stk", 3)
    private inst_0x48() {
        if (this.p & MS) {
            this.stPush(this.a);
        }
        else {
            this.stPushWord(this.a);
        }
    }

    @instruction("65816", "EOR", "imm", 2)
    private inst_0x49() {
        this.opEOR(this.ImmediateAddr);
        this.incPC(2 - ((this.p & MS) >> 5));
    }

    @instruction("65816", "LSR", "acc", 2)
    private inst_0x4a() {
        this.opLSR(null);
    }

    @instruction("65816", "PHK", "stk", 3) // new to 65816
    private inst_0x4b() {
        this.stPush(this.pbr);
    }

    @instruction("65816", "JMP", "abs", 3)
    private inst_0x4c() {
        this.pc = this.OperandWord();
    }

    @instruction("65816", "EOR", "abs", 4)
    private inst_0x4d() {
        this.opEOR(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("65816", "LSR", "abs", 6)
    private inst_0x4e() {
        this.opLSR(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("65816", "EOR", "abl", 5) // new to 65816
    private inst_0x4f() {
        this.opEOR(this.AbsoluteLongAddr);
        this.incPC(3);
    }

    @instruction("65816", "BVC", "pcr", 2, 2)
    private inst_0x50() {
        this.bCLR(OVERFLOW);
    }

    @instruction("65816", "EOR", "diy", 5, 1)
    private inst_0x51() {
        this.opEOR(this.DirectPageIndirectYAddr);
        this.incPC();
    }

    @instruction("65816", "EOR", "dpi", 5)
    private inst_0x52() {
        this.opEOR(this.DirectPageIndirectAddr);
        this.incPC();
    }

    @instruction("65816", "EOR", "siy", 7) // new to 65816
    private inst_0x53() {
        this.opEOR(this.StackRelIndirectYAddr);
        this.incPC();
    }

    @instruction("65816", "MVN", "blk", 7) // new to 65816
    private inst_0x54() {
        // MVN handles interrupts by not incrementing pc until A === $ffff
        // thus like the 65816 it completes the current byte transfer before
        // breaking for the interrupt and then returns
        // X is source, Y is dest starting addresses; A is bytes to move - 1
        // Operand lsb is dest dbr, msb is source
        var c;

        if (this.p & MS) {
            c = (this.b << BYTE_WIDTH) + this.a;
        }
        else {
            c = this.a;
        }

        if (c !== 0xffff) {
            this.opMVB(1);
            this.pc -= 1; // move pc back to the MVP instruction
        }
        else {
            this.dbr = this.OperandByte();
            this.incPC(2);
        }
    }

    @instruction("65816", "EOR", "dpx", 4)
    private inst_0x55() {
        this.opEOR(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("65816", "LSR", "dpx", 6)
    private inst_0x56() {
        this.opLSR(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("65816", "EOR", "dly", 6) // new to 65816
    private inst_0x57() {
        this.opEOR(this.DirectPageIndirectLongYAddr);
        this.incPC();
    }

    @instruction("65816", "CLI", "imp", 2)
    private inst_0x58() {
        this.pCLR(INTERRUPT);
    }

    @instruction("65816", "EOR", "aby", 4, 1)
    private inst_0x59() {
        this.opEOR(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("65816", "PHY", "stk", 3)
    private inst_0x5a() {
        if ((this.p & IRS) || this.mode) {
            this.stPush(this.y);
        }
        else {
            this.stPushWord(this.y);
        }
    }

    @instruction("65816", "TCD", "imp", 2) // new to 65816
    private inst_0x5b() {
        if (this.p & MS) {
            // A is 8 bit, hidden B is transfered as well
            this.dpr = (this.b << BYTE_WIDTH) + this.a;
        }
        else {
            // A is 16 bit
            this.dpr = this.a;
        }

        this.FlagsNZWord(this.dpr);
    }

    @instruction("65816", "JML", "abl", 4)  // new to 65816
    private inst_0x5c() {
        const pbr = this.ByteAt((this.pbr << ADDR_WIDTH) + this.pc + 2);
        this.pc = this.OperandWord();
        this.pbr = pbr;
    }

    @instruction("65816", "EOR", "abx", 4, 1)
    private inst_0x5d() {
        this.opEOR(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("65816", "LSR", "abx", 7)
    private inst_0x5e() {
        this.opLSR(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("65816", "EOR", "alx", 5) // new to 65816
    private inst_0x5f() {
        this.opEOR(this.AbsoluteLongXAddr);
        this.incPC(3);
    }

    @instruction("65816", "RTS", "stk", 6)
    private inst_0x60() {
        this.pc = this.stPopWord();
        this.incPC();
    }

    @instruction("65816", "ADC", "dix", 6)
    private inst_0x61() {
        this.opADC(this.DirectPageIndirectXAddr);
        this.incPC();
    }

    @instruction("65816", "PER", "spc", 6) // new to 65816
    private inst_0x62() {
        this.stPushWord((this.pc + this.OperandWord()) & addrMask);
        this.incPC(2);
    }

    @instruction("65816", "ADC", "str", 4) // new to 65816
    private inst_0x63() {
        this.opADC(this.StackRelAddr);
        this.incPC();
    }

    @instruction("65816", "STZ", "dpg", 3)
    private inst_0x64() {
        this.opSTZ(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("65816", "ADC", "dpg", 3)
    private inst_0x65() {
        this.opADC(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("65816", "ROR", "dpg", 5)
    private inst_0x66() {
        this.opROR(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("65816", "ADC", "dil", 6) // new to 65816
    private inst_0x67() {
        this.opADC(this.DirectPageIndirectLongAddr);
        this.incPC();
    }

    @instruction("65816", "PLA", "stk", 4)
    private inst_0x68() {
        if (this.p & MS) {
            this.a = this.stPop();
            this.FlagsNZ(this.a);
        }
        else {
            this.a = this.stPopWord();
            this.FlagsNZWord(this.a);
        }
    }

    @instruction("65816", "ADC", "imm", 2)
    private inst_0x69() {
        this.opADC(this.ImmediateAddr);
        this.incPC(2 - ((this.p & MS) >> 5));
    }

    @instruction("65816", "ROR", "acc", 2)
    private inst_0x6a() {
        this.opROR(null);
    }

    @instruction("65816", "RTL", "stk", 6) // new to 65816
    private inst_0x6b() {
        this.pc = this.stPopWord();
        this.pbr = this.stPop();
        this.incPC();
    }

    @instruction("65816", "JMP", "abi", 5)
    private inst_0x6c() {
        // 65C02 and 65816 don't have the 6502 page wrap bug
        const operand = this.OperandWord();

        // operand indirection wraps at bank 0 boundary
        if (operand === 0xffff) {
            this.pc = (this.ByteAt(0x0000) << BYTE_WIDTH) + this.ByteAt(operand);
        }
        else {
            this.pc = this.WordAt(operand);
        }
    }

    @instruction("65816", "ADC", "abs", 4)
    private inst_0x6d() {
        this.opADC(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("65816", "ROR", "abs", 6)
    private inst_0x6e() {
        this.opROR(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("65816", "ADC", "abl", 5) // new to 65816
    private inst_0x6f() {
        this.opADC(this.AbsoluteLongAddr);
        this.incPC(3);
    }

    @instruction("65816", "BVS", "pcr", 2, 2)
    private inst_0x70() {
        this.bSET(OVERFLOW);
    }

    @instruction("65816", "ADC", "diy", 5, 1)
    private inst_0x71() {
        this.opADC(this.DirectPageIndirectYAddr);
        this.incPC();
    }

    @instruction("65816", "ADC", "dpi", 5)
    private inst_0x72() {
        this.opADC(this.DirectPageIndirectAddr);
        this.incPC();
    }

    @instruction("65816", "ADC", "siy", 7) // new to 65816
    private inst_0x73() {
        this.opADC(this.StackRelIndirectYAddr);
        this.incPC();
    }

    @instruction("65816", "STZ", "dpx", 4)
    private inst_0x74() {
        this.opSTZ(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("65816", "ADC", "dpx", 4)
    private inst_0x75() {
        this.opADC(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("65816", "ROR", "dpx", 6)
    private inst_0x76() {
        this.opROR(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("65816", "ADC", "dly", 6) // new to 65816
    private inst_0x77() {
        this.opADC(this.DirectPageIndirectLongYAddr);
        this.incPC();
    }

    @instruction("65816", "SEI", "imp", 2)
    private inst_0x78() {
        this.pSET(INTERRUPT);
    }

    @instruction("65816", "ADC", "aby", 4, 1)
    private inst_0x79() {
        this.opADC(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("65816", "PLY", "stk", 4)
    private inst_0x7a() {
        if ((this.p & IRS) || this.mode) {
            this.y = this.stPop();
            this.FlagsNZ(this.y);
        }
        else {
            this.y = this.stPopWord();
            this.FlagsNZWord(this.y);
        }
    }

    @instruction("65816", "TDC", "imp", 2) // new to 65816
    private inst_0x7b() {
        if (this.p & MS) {
            // A is 8 bit, hidden B is set to high byte
            this.b = this.dpr >> BYTE_WIDTH;
            this.a = this.dpr & byteMask;
        }
        else {
            // A is 16 bit
            this.a = this.dpr;
        }

        this.FlagsNZWord(this.dpr);
    }

    @instruction("65816", "JMP", "aix", 6)
    private inst_0x7c() {
        this.pc = this.AbsoluteIndirectXAddr();
    }

    @instruction("65816", "ADC", "abx", 4, 1)
    private inst_0x7d() {
        this.opADC(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("65816", "ROR", "abx", 7)
    private inst_0x7e() {
        this.opROR(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("65816", "ADC", "alx", 5) // new to 65816
    private inst_0x7F() {
        this.opADC(this.AbsoluteLongXAddr);
        this.incPC(3);
    }

    @instruction("65816", "BRA", "pcr", 1, 1)
    private inst_0x80() {
        this.ProgramCounterRelAddr();
    }

    @instruction("65816", "STA", "dix", 6)
    private inst_0x81() {
        this.opSTA(this.DirectPageIndirectXAddr);
        this.incPC();
    }

    @instruction("65816", "BRL", "prl", 4) // new to 65816
    private inst_0x82() {
        this.ProgramCounterRelLongAddr();
    }

    @instruction("65816", "STA", "str", 4) // new to 65816
    private inst_0x83() {
        this.opSTA(this.StackRelAddr);
        this.incPC();
    }

    @instruction("65816", "STY", "dpg", 3)
    private inst_0x84() {
        this.opSTY(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("65816", "STA", "dpg", 3)
    private inst_0x85() {
        this.opSTA(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("65816", "STX", "dpg", 3)
    private inst_0x86() {
        this.opSTX(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("65816", "STA", "dil", 6) // new to 65816
    private inst_0x87() {
        this.opSTA(this.DirectPageIndirectLongAddr);
        this.incPC();
    }

    @instruction("65816", "DEY", "imp", 2)
    private inst_0x88() {
        this.y -= 1;
        if ((this.p & IRS) || this.mode) {
            this.y &= byteMask;
            this.FlagsNZ(this.y);
        }
        else {
            this.y &= addrMask;
            this.FlagsNZWord(this.y);
        }
    }

    @instruction("65816", "BIT", "imm", 2)
    private inst_0x89() {
        var tbyte;

        // *** TODO: consider using opBIT using { ***
        // p = this.p
        // this.opBIT(this.ImmediateAddr);
        // This instruction (BIT #$12) does not use opBIT because in the
        // immediate mode, BIT only affects the Z flag.
        if (this.p & MS) {
            tbyte = this.OperandByte();
        }
        else {
            tbyte = this.OperandWord();
        }
        this.p &= ~(ZERO);
        if ((this.a & tbyte) === 0) {
            this.p |= ZERO;
        }
        this.incPC(2 - ((this.p & MS) >> 5));
    }

    @instruction("65816", "TXA", "imp", 2)
    private inst_0x8a() {
        // let's be explicit on mode here because interrupts can affect BREAK flag
        // which is the same as IRS, result is the same though, transfer lsb
        if ((this.p & MS) && this.isCLR(IRS) && (this.mode === 0)) {
            // if this.p & MS and this.isCLR(IRS) {
            // A is 8 bit and X is 16 bit
            this.a = this.x & byteMask;
        }
        else {
            // A and X both 8 bit, or both 16 bit, or A is 16 and X is 8
            this.a = this.x;
        }

        if (this.p & MS) {
            this.FlagsNZ(this.a);
        }
        else {
            this.FlagsNZWord(this.a);
        }
    }

    @instruction("65816", "PHB", "stk", 3) // new to 65816
    private inst_0x8B() {
        this.stPush(this.dbr);
    }

    @instruction("65816", "STY", "abs", 4)
    private inst_0x8c() {
        this.opSTY(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("65816", "STA", "abs", 4)
    private inst_0x8d() {
        this.opSTA(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("65816", "STX", "abs", 4)
    private inst_0x8e() {
        this.opSTX(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("65816", "STA", "abl", 5) // new to 65816
    private inst_0x8F() {
        this.opSTA(this.AbsoluteLongAddr);
        this.incPC(3);
    }

    @instruction("65816", "BCC", "pcr", 2, 2)
    private inst_0x90() {
        this.bCLR(CARRY);
    }

    @instruction("65816", "STA", "diy", 6)
    private inst_0x91() {
        this.opSTA(this.DirectPageIndirectYAddr);
        this.incPC();
    }

    @instruction("65816", "STA", "dpi", 5)
    private inst_0x92() {
        this.opSTA(this.DirectPageIndirectAddr);
        this.incPC();
    }

    @instruction("65816", "STA", "siy", 7) // new to 65816
    private inst_0x93() {
        this.opSTA(this.StackRelIndirectYAddr);
        this.incPC();
    }

    @instruction("65816", "STY", "dpx", 4)
    private inst_0x94() {
        this.opSTY(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("65816", "STA", "dpx", 4)
    private inst_0x95() {
        this.opSTA(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("65816", "STX", "dpy", 4)
    private inst_0x96() {
        this.opSTX(this.DirectPageYAddr);
        this.incPC();
    }

    @instruction("65816", "STA", "dly", 6) // new to 65816
    private inst_0x97() {
        this.opSTA(this.DirectPageIndirectLongYAddr);
        this.incPC();
    }

    @instruction("65816", "TYA", "imp", 2)
    private inst_0x98() {
        // let's be explicit on mode here because interrupts can affect BREAK flag
        // which is the same as IRS, result is the same though, transfer lsb
        if ((this.p & MS) && this.isCLR(IRS) && (this.mode === 0)) {
            // if this.p & MS and this.isCLR(IRS) {
            // A is 8 bit and Y is 16 bit
            this.a = this.y & byteMask;
        }
        else {
            // A and Y both 8 bit, or both 16 bit, or A is 16 and Y is 8
            this.a = this.y;
        }

        if (this.p & MS) {
            this.FlagsNZ(this.a);
        }
        else {
            this.FlagsNZWord(this.a);
        }
    }

    @instruction("65816", "STA", "aby", 5)
    private inst_0x99() {
        this.opSTA(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("65816", "TXS", "imp", 2)
    private inst_0x9a() {
        if (this.mode) {
            this.sp = this.x;
        }
        else {
            if ((this.p & IRS) || this.mode) {
                // sp high byte is zero
                this.sp = this.x & byteMask;
            }
            else {
                this.sp = this.x;
            }
        }
    }

    @instruction("65816", "TXY", "imp", 2) // new to 65816
    private inst_0x9b() {
        this.y = this.x;
        if ((this.p & IRS) || this.mode) {
            this.FlagsNZ(this.y);
        }
        else {
            this.FlagsNZWord(this.y);
        }
    }

    @instruction("65816", "STZ", "abs", 4)
    private inst_0x9c() {
        this.opSTZ(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("65816", "STA", "abx", 5)
    private inst_0x9d() {
        this.opSTA(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("65816", "STZ", "abx", 5)
    private inst_0x9e() {
        this.opSTZ(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("65816", "STA", "alx", 5) // new to 65816
    private inst_0x9f() {
        this.opSTA(this.AbsoluteLongXAddr);
        this.incPC(3);
    }

    @instruction("65816", "LDY", "imm", 2)
    private inst_0xa0() {
        this.opLDY(this.ImmediateAddr);
        this.incPC(2 - (((this.p & IRS) >> 4) || this.mode));
    }

    @instruction("65816", "LDA", "dix", 6)
    private inst_0xa1() {
        this.opLDA(this.DirectPageIndirectXAddr);
        this.incPC();
    }

    @instruction("65816", "LDX", "imm", 2)
    private inst_0xa2() {
        this.opLDX(this.ImmediateAddr);
        this.incPC(2 - (((this.p & IRS) >> 4) || this.mode));
    }

    @instruction("65816", "LDA", "str", 4) // new to 65816
    private inst_0xa3() {
        this.opLDA(this.StackRelAddr);
        this.incPC();
    }

    @instruction("65816", "LDY", "dpg", 3)
    private inst_0xa4() {
        this.opLDY(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("65816", "LDA", "dpg", 3)
    private inst_0xa5() {
        this.opLDA(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("65816", "LDX", "dpg", 3)
    private inst_0xa6() {
        this.opLDX(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("65816", "LDA", "dil", 6) // new to 65816
    private inst_0xa7() {
        this.opLDA(this.DirectPageIndirectLongAddr);
        this.incPC();
    }

    @instruction("65816", "TAY", "imp", 2)
    private inst_0xa8() {
        // need to be explicit on mode here because interrupts can affect BREAK flag which is the same as IRS
        if ((this.p & MS) && this.isCLR(IRS) && (this.mode === 0)) {
            // A is 8 bit and Y is 16 bit, hidden B is transfered as well
            this.y = (this.b << BYTE_WIDTH) + this.a;
        }
        else if (this.isCLR(MS) && this.isSET(IRS)) {
            // A is 16 bit and Y is 8 bit
            this.y = this.a & byteMask;
        }
        else {
            // A and Y both 8 bit, or both 16 bit
            // *** this also works in emulation mode during an interrupt (p bit 4 is cleared) ***
            this.y = this.a;
        }

        if ((this.p & IRS) || this.mode) {
            this.FlagsNZ(this.y);
        }
        else {
            this.FlagsNZWord(this.y);
        }
    }

    @instruction("65816", "LDA", "imm", 2)
    private inst_0xa9() {
        this.opLDA(this.ImmediateAddr);
        this.incPC(2 - ((this.p & MS) >> 5));
    }

    @instruction("65816", "TAX", "imp", 2)
    private inst_0xaa() {
        // need to be explicit on mode here because interrupts can affect BREAK flag which is the same as IRS
        if ((this.p & MS) && this.isCLR(IRS) && (this.mode === 0)) {
            // A is 8 bit and X is 16 bit, hidden B is transfered as well
            this.x = (this.b << BYTE_WIDTH) + this.a;
        }
        else if (this.isCLR(MS) && this.isSET(IRS)) {
            // A is 16 bit and X is 8 bit
            this.x = this.a & byteMask;
        }
        else {
            // A and X both 8 bit, or both 16 bit
            // *** this also works in emulation mode during an interrupt (p bit 4 is cleared) ***
            this.x = this.a;
        }

        if ((this.p & IRS) || this.mode) {
            this.FlagsNZ(this.x);
        }
        else {
            this.FlagsNZWord(this.x);
        }
    }

    @instruction("65816", "PLB", "stk", 4) // new to 65816
    private inst_0xab() {
        this.dbr = this.stPop();
    }

    @instruction("65816", "LDY", "abs", 4)
    private inst_0xac() {
        this.opLDY(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("65816", "LDA", "abs", 4)
    private inst_0xad() {
        this.opLDA(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("65816", "LDX", "abs", 4)
    private inst_0xae() {
        this.opLDX(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("65816", "LDA", "abl", 5) // new to 65816
    private inst_0xaf() {
        this.opLDA(this.AbsoluteLongAddr);
        this.incPC(3);
    }

    @instruction("65816", "BCS", "pcr", 2, 2)
    private inst_0xb0() {
        this.bSET(CARRY);
    }

    @instruction("65816", "LDA", "diy", 5, 1)
    private inst_0xb1() {
        this.opLDA(this.DirectPageIndirectYAddr);
        this.incPC();
    }

    @instruction("65816", "LDA", "dpi", 5)
    private inst_0xb2() {
        this.opLDA(this.DirectPageIndirectAddr);
        this.incPC();
    }

    @instruction("65816", "LDA", "siy", 7) // new to 65816
    private inst_0xb3() {
        this.opLDA(this.StackRelIndirectYAddr);
        this.incPC();
    }

    @instruction("65816", "LDY", "dpx", 4)
    private inst_0xb4() {
        this.opLDY(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("65816", "LDA", "dpx", 4)
    private inst_0xb5() {
        this.opLDA(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("65816", "LDX", "dpy", 4)
    private inst_0xb6() {
        this.opLDX(this.DirectPageYAddr);
        this.incPC();
    }

    @instruction("65816", "LDA", "dly", 6) // new to 65816
    private inst_0xb7() {
        this.opLDA(this.DirectPageIndirectLongYAddr);
        this.incPC();
    }

    @instruction("65816", "CLV", "imp", 2)
    private inst_0xb8() {
        this.pCLR(OVERFLOW);
    }

    @instruction("65816", "LDA", "aby", 4, 1)
    private inst_0xb9() {
        this.opLDA(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("65816", "TSX", "imp", 2)
    private inst_0xba() {
        if ((this.p & IRS) || this.mode) {
            this.x = this.sp & byteMask;
            this.FlagsNZ(this.x);
        }
        else {
            this.x = this.sp;
            this.FlagsNZWord(this.x);
        }
    }

    @instruction("65816", "TYX", "imp", 2) // new to 65816
    private inst_0xbb() {
        this.x = this.y;
        if ((this.p & IRS) || this.mode) {
            this.FlagsNZ(this.x);
        }
        else {
            this.FlagsNZWord(this.x);
        }
    }

    @instruction("65816", "LDY", "abx", 4, 1)
    private inst_0xbc() {
        this.opLDY(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("65816", "LDA", "abx", 4, 1)
    private inst_0xbd() {
        this.opLDA(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("65816", "LDX", "aby", 4, 1)
    private inst_0xbe() {
        this.opLDX(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("65816", "LDA", "alx", 5) // new to 65816
    private inst_0xbf() {
        this.opLDA(this.AbsoluteLongXAddr);
        this.incPC(3);
    }

    @instruction("65816", "CPY", "imm", 2)
    private inst_0xc0() {
        this.opCMP(this.ImmediateAddr, this.y, IRS);
        this.incPC(2 - (((this.p & IRS) >> 4) || this.mode));
    }

    @instruction("65816", "CMP", "dix", 6)
    private inst_0xc1() {
        this.opCMP(this.DirectPageIndirectXAddr, this.a, MS);
        this.incPC();
    }

    @instruction("65816", "REP", "imm", 3) // new to 65816
    private inst_0xc2() {
        const operand = this.OperandByte();
        let mask = CARRY;

        while (mask) {
            //            if mask & operand and not (this.mode and (mask & BREAK or mask & UNUSED)) {
            //                if mask === MS and this.isSET(MS) {
            //                    // A 8 => 16, set A = b a
            //                    this.a = (this.b << BYTE_WIDTH) + this.a
            //                    this.b = 0
            //                this.pCLR(mask)

            // *** TODO: consider reworking SEP also to make conditionals clearer ***
            if (mask & operand) {
                if (this.mode) {
                    // can't change BREAK or UNUSED flags in emulation mode
                    if (!(mask & BREAK) || (mask & UNUSED)) {
                        this.pCLR(mask);
                    }
                }
                else {
                    if ((mask === MS) && this.isSET(MS)) {
                        // A 8 => 16, set A = b a
                        this.a = (this.b << BYTE_WIDTH) + this.a;
                        this.b = 0;
                    }
                    this.pCLR(mask);
                }
            }

            mask = (mask << 1) & byteMask;
        }
        this.incPC();
    }

    @instruction("65816", "CMP", "str", 4) // new to 65816
    private inst_0xc3() {
        this.opCMP(this.StackRelAddr, this.a, MS);
        this.incPC();
    }

    @instruction("65816", "CPY", "dpg", 3)
    private inst_0xc4() {
        this.opCMP(this.DirectPageAddr, this.y, IRS);
        this.incPC();
    }

    @instruction("65816", "CMP", "dpg", 3)
    private inst_0xc5() {
        this.opCMP(this.DirectPageAddr, this.a, MS);
        this.incPC();
    }

    @instruction("65816", "DEC", "dpg", 5)
    private inst_0xc6() {
        this.opDEC(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("65816", "CMP", "dil", 6) // new to 65816
    private inst_0xc7() {
        this.opCMP(this.DirectPageIndirectLongAddr, this.a, MS);
        this.incPC();
    }

    @instruction("65816", "INY", "imp", 2)
    private inst_0xc8() {
        this.y += 1;
        if ((this.p & IRS) || this.mode) {
            this.y &= byteMask;
            this.FlagsNZ(this.y);
        }
        else {
            this.y &= addrMask;
            this.FlagsNZWord(this.y);
        }
    }

    @instruction("65816", "CMP", "imm", 2)
    private inst_0xc9() {
        this.opCMP(this.ImmediateAddr, this.a, MS);
        this.incPC(2 - ((this.p & MS) >> 5));
    }

    @instruction("65816", "DEX", "imp", 2)
    private inst_0xca() {
        this.x -= 1;
        if ((this.p & IRS) || this.mode) {
            this.x &= byteMask;
            this.FlagsNZ(this.x);
        }
        else {
            this.x &= addrMask;
            this.FlagsNZWord(this.x);
        }
    }

    @instruction("65816", "WAI", 'imp', 3)
    private inst_0xcb() {
        this.waiting = true;
    }

    @instruction("65816", "CPY", "abs", 4)
    private inst_0xcc() {
        this.opCMP(this.AbsoluteAddr, this.y, IRS);
        this.incPC(2);
    }

    @instruction("65816", "CMP", "abs", 4)
    private inst_0xcd() {
        this.opCMP(this.AbsoluteAddr, this.a, MS);
        this.incPC(2);
    }

    @instruction("65816", "DEC", "abs", 3)
    private inst_0xce() {
        this.opDEC(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("65816", "CMP", "abl", 5) // new to 65816
    private inst_0xcf() {
        this.opCMP(this.AbsoluteLongAddr, this.a, MS);
        this.incPC(3);
    }

    @instruction("65816", "BNE", "pcr", 2, 2)
    private inst_0xd0() {
        this.bCLR(ZERO);
    }

    @instruction("65816", "CMP", "diy", 5, 1)
    private inst_0xd1() {
        this.opCMP(this.DirectPageIndirectYAddr, this.a, MS);
        this.incPC();
    }

    @instruction("65816", "CMP", 'dpi', 5)
    private inst_0xd2() {
        this.opCMP(this.DirectPageIndirectAddr, this.a, MS);
        this.incPC();
    }

    @instruction("65816", "CMP", "siy", 7) // new to 65816
    private inst_0xd3() {
        this.opCMP(this.StackRelIndirectYAddr, this.a, MS);
        this.incPC();
    }

    @instruction("65816", "PEI", "ski", 6) // new to 65816
    private inst_0xd4() {
        const addr = this.WordAt(this.dpr + this.OperandByte()); // in Bank 0
        this.stPushWord(addr);
        this.incPC();
    }

    @instruction("65816", "CMP", "dpx", 4)
    private inst_0xd5() {
        this.opCMP(this.DirectPageXAddr, this.a, MS);
        this.incPC();
    }

    @instruction("65816", "DEC", "dpx", 6)
    private inst_0xd6() {
        this.opDEC(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("65816", "CMP", "dly", 6) // new to 65816
    private inst_0xd7() {
        this.opCMP(this.DirectPageIndirectLongYAddr, this.a, MS);
        this.incPC();
    }

    @instruction("65816", "CLD", "imp", 2)
    private inst_0xd8() {
        this.pCLR(DECIMAL);
    }

    @instruction("65816", "CMP", "aby", 4, 1)
    private inst_0xd9() {
        this.opCMP(this.AbsoluteYAddr, this.a, MS);
        this.incPC(2);
    }

    @instruction("65816", "PHX", "stk", 3)
    private inst_0xda() {
        if ((this.p & IRS) || this.mode) {
            this.stPush(this.x);
        }
        else {
            this.stPushWord(this.x);
        }
    }

    @instruction("65816", "STP", "imp", 3) // new to 65816
    private inst_0xdb() {
        // *** TODO: need to implement stop the processor ***
        // *** and wait for reset pin to be pulled low    ***
        // *** for now just wait ***
        this.waiting = true;
    }

    @instruction("65816", "JML", "ail", 6)  // new to 65816
    private inst_0xdc() {
        var pbr;
        const operand = this.OperandWord();

        // operand indirection wraps at bank 0 boundary
        if (operand === 0xffff) {
            pbr = this.ByteAt(0x0001);
            this.pc = (this.ByteAt(0x0000) << BYTE_WIDTH) + this.ByteAt(operand);
        }
        else if (operand === 0xfffe) {
            pbr = this.ByteAt(0x0000);
            this.pc = this.WordAt(operand);
        }
        else {
            pbr = this.ByteAt(operand + 2);
            this.pc = this.WordAt(operand);
        }

        this.pbr = pbr;
    }

    @instruction("65816", "CMP", "abx", 4, 1)
    private inst_0xdd() {
        this.opCMP(this.AbsoluteXAddr, this.a, MS);
        this.incPC(2);
    }

    @instruction("65816", "DEC", "abx", 7)
    private inst_0xde() {
        this.opDEC(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("65816", "CMP", "alx", 5) // new to 65816
    private inst_0xdf() {
        this.opCMP(this.AbsoluteLongXAddr, this.a, MS);
        this.incPC(3);
    }

    @instruction("65816", "CPX", "imm", 2)
    private inst_0xe0() {
        this.opCMP(this.ImmediateAddr, this.x, IRS);
        this.incPC(2 - (((this.p & IRS) >> 4) || this.mode));
    }

    @instruction("65816", "SBC", "dix", 6)
    private inst_0xe1() {
        this.opSBC(this.DirectPageIndirectXAddr);
        this.incPC();
    }

    @instruction("65816", "SEP", "imm", 3) // new to 65816
    private inst_0xe2() {
        const operand = this.OperandByte();
        let mask = CARRY;
        while (mask) {
            // can't change BREAK or UNUSED flags in emulation mode
            if ((mask & operand) && !(this.mode && ((mask & BREAK) || (mask & UNUSED)))) {
                if ((mask === MS) && this.isCLR(MS)) {
                    // A 16 => 8, save B, mask A high byte
                    this.b = (this.a >> BYTE_WIDTH) & byteMask;
                    this.a = this.a & byteMask;
                }
                else if ((mask === IRS) && this.isCLR(IRS)) {
                    // X,Y 16 => 8, set high byte to zero
                    this.x = this.x & byteMask;
                    this.y = this.y & byteMask;
                }
                this.pSET(mask);
            }
            mask = (mask << 1) & byteMask;
        }
        this.incPC();
    }

    @instruction("65816", "SBC", "str", 4) // new to 65816
    private inst_0xe3() {
        this.opSBC(this.StackRelAddr);
        this.incPC();
    }

    @instruction("65816", "CPX", "dpg", 3)
    private inst_0xe4() {
        this.opCMP(this.DirectPageAddr, this.x, IRS);
        this.incPC();
    }

    @instruction("65816", "SBC", "dpg", 3)
    private inst_0xe5() {
        this.opSBC(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("65816", "INC", "dpg", 5)
    private inst_0xe6() {
        this.opINC(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("65816", "SBC", "dil", 6) // new to 65816
    private inst_0xe7() {
        this.opSBC(this.DirectPageIndirectLongAddr);
        this.incPC();
    }

    @instruction("65816", "INX", "imp", 2)
    private inst_0xe8() {
        this.x += 1;
        if ((this.p & IRS) || this.mode) {
            this.x &= byteMask;
            this.FlagsNZ(this.x);
        }
        else {
            this.x &= addrMask;
            this.FlagsNZWord(this.x);
        }
    }

    @instruction("65816", "SBC", "imm", 2)
    private inst_0xe9() {
        this.opSBC(this.ImmediateAddr);
        this.incPC(2 - ((this.p & MS) >> 5));
    }

    @instruction("65816", "NOP", "imp", 2)
    private inst_0xea() {
        //pass
    }

    @instruction("65816", "XBA", "imp", 3) // new to 65816
    private inst_0xeb() {
        var b;
        const a = this.a & byteMask;

        if (this.p & MS) { // 8 bit
            this.a = this.b;
            this.b = b = a;
        }
        else { // 16 bits
            b = (this.a >> BYTE_WIDTH) & byteMask;
            this.a = (a << BYTE_WIDTH) + b;
        }

        // *** I don't think B is relevant w/ 16-bit A so I don't
        // maintain a hidden B in this mode ***

        this.FlagsNZ(b);
    }

    @instruction("65816", "CPX", "abs", 4)
    private inst_0xec() {
        this.opCMP(this.AbsoluteAddr, this.x, IRS);
        this.incPC(2);
    }

    @instruction("65816", "SBC", "abs", 4)
    private inst_0xed() {
        this.opSBC(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("65816", "INC", "abs", 6)
    private inst_0xee() {
        this.opINC(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("65816", "SBC", "abl", 5) // new to 65816
    private inst_0xef() {
        this.opSBC(this.AbsoluteLongAddr);
        this.incPC(3);
    }

    @instruction("65816", "BEQ", "pcr", 2, 2)
    private inst_0xf0() {
        this.bSET(ZERO);
    }

    @instruction("65816", "SBC", "diy", 5, 1)
    private inst_0xf1() {
        this.opSBC(this.DirectPageIndirectYAddr);
        this.incPC();
    }

    @instruction("65816", "SBC", "dpi", 5)
    private inst_0xf2() {
        this.opSBC(this.DirectPageIndirectAddr);
        this.incPC();
    }

    @instruction("65816", "SBC", "siy", 7) // new to 65816
    private inst_0xf3() {
        this.opSBC(this.StackRelIndirectYAddr);
        this.incPC();
    }

    @instruction("65816", "PEA", "ska", 5) // new to 65816
    private inst_0xf4() {
        this.stPushWord(this.OperandWord());
        this.incPC(2);
    }

    @instruction("65816", "SBC", "dpx", 4)
    private inst_0xf5() {
        this.opSBC(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("65816", "INC", "dpx", 6)
    private inst_0xf6() {
        this.opINC(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("65816", "SBC", "dly", 6) // new to 65816
    private inst_0xf7() {
        this.opSBC(this.DirectPageIndirectLongYAddr);
        this.incPC();
    }

    @instruction("65816", "SED", "imp", 2)
    private inst_0xf8() {
        this.pSET(DECIMAL);
    }

    @instruction("65816", "SBC", "aby", 4, 1)
    private inst_0xf9() {
        this.opSBC(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("65816", "PLX", "stk", 4)
    private inst_0xfa() {
        if ((this.p & IRS) || this.mode) {
            this.x = this.stPop();
            this.FlagsNZ(this.x);
        }
        else {
            this.x = this.stPopWord();
            this.FlagsNZWord(this.x);
        }
    }

    @instruction("65816", "XCE", "imp", 2) // new to 65816
    private inst_0xfb() {
        // 65816 Programming Manual, pg 423, describes these action as
        // only happening when actually switching modes.
        // I verified on the W65C265SXB that the registers, M and X don't
        // change if XCE is executed called in native mode with carry cleared
        // (native => native).  I couldn't test emulation => emulation
        // becuase the W65C265SXB monitor doesn't seem to work in emulation mode.
        // *** TODO: verify emulation => emulation transfer on 65816 ***
        if (this.mode && this.isCLR(CARRY)) { // emul => native
            this.pSET(MS);
            this.pSET(IRS);
            this.pSET(CARRY);
            this.mode = 0;
            this.sp = spBase + this.sp;
        }
        else if (!this.mode && this.isSET(CARRY)) { // native => emul
            this.pSET(BREAK);
            this.pSET(UNUSED);
            this.pCLR(CARRY);
            this.b = (this.a >> BYTE_WIDTH) & byteMask;
            this.a = this.a & byteMask;
            this.x = this.x & byteMask;
            this.y = this.y & byteMask;
            this.sp = (this.sp & byteMask);
            this.mode = 1;
        }
    }

    @instruction("65816", "JSR", "aix", 8) // new to 65816
    private inst_0xfc() {
        this.stPushWord((this.pc + 1) & addrMask);
        this.pc = this.AbsoluteIndirectXAddr();
    }

    @instruction("65816", "SBC", "abx", 4, 1)
    private inst_0xfd() {
        this.opSBC(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("65816", "INC", "abx", 7)
    private inst_0xfe() {
        this.opINC(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("65816", "SBC", "alx", 5) // new to 65816
    private inst_0xff() {
        this.opSBC(this.AbsoluteLongXAddr);
        this.incPC(3);
    }
}
