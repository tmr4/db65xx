/* eslint-disable eqeqeq */
/* eslint-disable @typescript-eslint/naming-convention */
import { instruction, IDisasm } from './devices';

//export var instruct: Function[] = new Array(256).fill(MPU.inst_not_implemented());
//export var instruct: Function[] = new Array(256).fill(0);
//export var instruct: Function[] = new Array(256);
//export var cycletime: number[] = new Array(256).fill(0);
//export var extracycles: number[] = new Array(256).fill(0);
//export var disassemble: IDisasm[] = new Array(256).fill(["???", "imp"]);
export var instruct: Function[] = [];
export var cycletime: number[] = [];
export var extracycles: number[] = [];
export var disassemble: IDisasm[] = [];

// 65c816
//   Registers
//       a { represents both 8 and 16 bit accumulator (the 65816 C register is not modeled separately)
//       b { only valid in 8 bit mode (otherwise use high byte of a)
//     x,y { represent both 8 and 16 bit registers. Note that processor flags bit 4 alone cannot indicate
//          whether we are in 8 or 16 bit as during an interrupt this bit will be cleared and instructions
//          would consider the registers as 16-bit even though they are 8-bit.  Thus code checks both
//          processor flags bit 4 and mode where appropriate.
//
export class MPU65816 {
    // processor characteristics
    public name: string;
    public waiting: boolean;
    public spBase: number;
    public processorCycles: number;
    public memory: Uint8Array = new Uint8Array();
    public start_pc: number;
    public excycles: number;
    public addcycles: boolean;
    public IRQ_pin: boolean;
    public mode!: number;

    // registers
    public pc!: number;
    public a!: number;
    public b!: number;
    public x!: number;
    public y!: number;
    public sp!: number;
    public p!: number;
    public pbr!: number;
    public dbr!: number;
    public dpr!: number;

    // masks
    public byteMask: number;
    public addrMask: number;
    public addrMaskL: number;
    public addrHighMask: number;
    public addrBankMask: number;

    // vectors
    RESET = 0xfffc;
    COP = [0xffe4, 0xfff4];
    BRK = 0xffe6;
    ABORT = [0xffe8, 0xfff8];
    NMI = [0xffea, 0xfffa];
    IRQ = [0xffee, 0xfffe];

    // processor flags
    NEGATIVE = 128;
    OVERFLOW = 64;
    MS = 32;            // native mode
    UNUSED = 32;        // emulation mode
    IRS = 16;           // native mode
    BREAK = 16;         // emulation mode
    DECIMAL = 8;
    INTERRUPT = 4;
    ZERO = 2;
    CARRY = 1;

    BYTE_WIDTH = 8;
    BYTE_FORMAT = "%02x";
    WORD_WIDTH = 16;
    WORD_FORMAT = "%04x";
    ADDR_WIDTH = 16;
    ADDR_FORMAT = "%04x";
    ADDRL_WIDTH = 24;
    ADDRL_FORMAT = "%05x";

    public constructor(memory: Uint8Array | null, pc = 0xfffc) {
        // config
        this.name = '65C816';
        this.waiting = false;
        this.byteMask = ((1 << this.BYTE_WIDTH) - 1);
        this.addrMask = ((1 << this.ADDR_WIDTH) - 1);
        this.addrMaskL = ((1 << this.ADDRL_WIDTH) - 1); // *** TODO { do we need to restrict this more hardwired memory model limit? ***
        this.addrHighMask = (this.byteMask << this.BYTE_WIDTH);
        this.addrBankMask = (this.addrHighMask << this.BYTE_WIDTH); // *** TODO { should this be limited to 0x110000? ***
        this.spBase = 1 << this.BYTE_WIDTH;

        // vm status
        this.excycles = 0;
        this.addcycles = false;
        this.processorCycles = 0;

        if(memory == null) {
            memory = new Uint8Array(0x40000);
        }
        this.memory = memory;

        // this.start_pc = 0xfffc
        this.start_pc = pc;
        this.sp = 0;
        this.IRQ_pin = true;

        // init
        this.reset();
    }

    _opCode: number = 0;

    get opCode(): number {
        return this.ByteAt(this.pc + (this.pbr << this.ADDR_WIDTH));
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
        flags = itoa(this.p, 2).rjust(this.BYTE_WIDTH, '0')
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
        if(this.waiting) {
            this.processorCycles += 1;
            if(this.IRQ_pin === false) {
                this.waiting = false;
            }
        }
        else {
            if((this.IRQ_pin == false) && ((this.p & this.INTERRUPT) == 0)) {
                this.irq();
                this.IRQ_pin = true;
            }
            const instructCode = this.memory[(this.pbr << this.ADDR_WIDTH) + this.pc];
            this.incPC();
            this.excycles = 0;
            this.addcycles = extracycles[instructCode] == 0 ? false : true;;
//            (this.(instruct[instructCode]))();
//            instruct[instructCode]();
            instruct[instructCode].call(this);
            this.pc &= this.addrMask;
            this.processorCycles += cycletime[instructCode] + this.excycles;
            //return self;
        }
    }

    private reset() {
        // pc is just the 16 bit program counter and must be combined with pbr to
        // access the program in memory
        this.pc = this.WordAt(this.RESET);

        // a, x and y are full 16 bit registers
        // they must be processed properly when in emulation mode
        this.a = 0;
        this.b = 0; // b is 8 bit and hidden, it is only relevent in 8 bit
        this.x = 0;
        this.y = 0;

        this.p = this.BREAK | this.UNUSED | this.INTERRUPT;
        this.processorCycles = 0;

        this.mode = 1;
        this.dbr = 0;
        this.pbr = 0;
        this.dpr = 0;
    }

    private irq() {
        // triggers an IRQ
        if(this.p & this.INTERRUPT) {
            return;
        }

        if(this.mode == 0) {
            this.stPush(this.pbr);
        }

        this.stPushWord(this.pc);

        if(this.mode) {
            // py65 has
            //   this.p &= ~this.BREAK
            //   this.stPush(this.p | this.UNUSED)
            // but a cleared break is only pushed onto the stack
            // p itself is not actually changed
            this.stPush(this.p & ~this.BREAK | this.UNUSED);
        }
        else {
            this.stPush(this.p);
        }

        this.p |= this.INTERRUPT;
        this.pbr = 0;
        this.pc = this.WordAt(this.IRQ[this.mode]);
        this.processorCycles += 7;
    }

    private nmi() {
        // triggers an NMI in the processor
        if(this.mode == 0) {
            this.stPush(this.pbr);
        }

        this.stPushWord(this.pc);

        if(this.mode) {
            // py65 has
            //   this.p &= ~this.BREAK
            //   this.stPush(this.p | this.UNUSED)
            // but a cleared break is only pushed onto the stack
            // p itself is not actually changed
            this.stPush(this.p & ~this.BREAK | this.UNUSED);
        }
        else {
            this.stPush(this.p);
        }

        this.p |= this.INTERRUPT;
        this.pbr = 0;
        this.pc = this.WordAt(this.NMI[this.mode]);
        this.processorCycles += 7;
    }

    // *****************************************************************************
    // *****************************************************************************
    // Helpers for addressing modes and instructions

    public ByteAt(addr: number): number {
        return this.memory[addr];
    }

    public WordAt(addr: number): number {
        return this.ByteAt(addr) + (this.ByteAt(addr + 1) << this.BYTE_WIDTH);
    }

    // *** useful for debuging for now, may be able to incorporate them ***    }

    private LongAt(addr: number): number {
        return (this.ByteAt(addr + 2) << this.ADDR_WIDTH) + (this.ByteAt(addr + 1) << this.BYTE_WIDTH) + this.ByteAt(addr);
    }

    private TCAt(addr: number): number {
        return (this.WordAt(addr + 2) << this.ADDR_WIDTH) + this.WordAt(addr);
    }

    private OperandAddr(): number {
        return (this.pbr << this.ADDR_WIDTH) + this.pc;
    }

    private OperandByte(): number {
        return this.ByteAt(this.OperandAddr());
    }

    private OperandWord(): number {
        return this.WordAt(this.OperandAddr());
    }

    private OperandLong(): number {
        const epc = this.OperandAddr();
        return (this.ByteAt(epc + 2) << this.ADDR_WIDTH) + this.WordAt(epc);
    }

    private incPC(inc: number = 1): void {
        // pc must remain within current program bank
        this.pc = (this.pc + inc) & this.addrMask;
    }

    private bCLR(x: number): void {
        if(this.p & x) {
            this.incPC();
        }
        else {
            this.ProgramCounterRelAddr();
        }
    }

    private bSET(x: number): void {
        if(this.p & x) {
            this.ProgramCounterRelAddr();
        }
        else {
            this.incPC();
        }
    }

    private pCLR(x: number): void {
        this.p &= ~x;
    }

    private pSET(x: number) {
        this.p |= x;
    }

    private isSET(x: number): boolean {
//    private isSET(x: number) {
//        return this.p & x; // it's shorter just to inline this
        return (this.p & x) !== 0;
    }

    private isCLR(x: number) {
        return !(this.p & x); // but not this
    }
    // stack related helpers

    private stPush(z: number): void {
        if(this.mode) {
            this.memory[0x100 + this.sp] = z & this.byteMask;
        }
        else {
            this.memory[this.sp] = z & this.byteMask;
        }
        this.sp -= 1;
        if(this.mode) {
            this.sp &= this.byteMask;
        }
        else {
            this.sp &= this.addrMask;
        }
    }

    private stPop(): number {
        this.sp += 1;
        if(this.mode) {
            this.sp &= this.byteMask;
        }
        else {
            this.sp &= this.addrMask;
        }
        if(this.mode) {
            return this.ByteAt(0x100 + this.sp);
        }
        else {
            return this.ByteAt(this.sp);
        }
    }

    private stPushWord(z): void {
        this.stPush((z >> this.BYTE_WIDTH) & this.byteMask);
        this.stPush(z & this.byteMask);
    }

    private stPopWord(): number {
        let z = this.stPop();
        z += this.stPop() << this.BYTE_WIDTH;
        return z;
    }

    private FlagsNZ(value): void {
        this.p &= ~(this.ZERO | this.NEGATIVE);
        if(value == 0) {
            this.p |= this.ZERO;
        }
        else {
            this.p |= value & this.NEGATIVE;
        }
    }

    private FlagsNZWord(value): void {
        this.p &= ~(this.ZERO | this.NEGATIVE);
        if(value == 0) {
            this.p |= this.ZERO;
        }
        else {
            this.p |= (value >> this.BYTE_WIDTH) & this.NEGATIVE;
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
    //   (this.dpr >> this.BYTE_WIDTH) + this.ByteAt(epc)
    // vs
    //   this.dpr + this.ByteAt(epc)
    //
    // See 65816 Programming Manual, pg 156, which states that this save 1 cycle


    // Original py65 page boundary WrapAt
    // returns word at addr, wrapping at a page boundary
    private WrapAt(addr: number): number {
        // Examples for addresses at page boundary and not, say 0x01ff and 0x0155 {
        //                 0x01ff => 0x0100       +   0x0200 =>  0x00  = 0x0100
        //                 0x0155 => 0x0100       +   0x0156 =>  0x56  = 0x0156
//        wrap = lambda x { (x & this.addrHighMask) + ((x + 1) & this.byteMask)
        //     get bytes at 0x01ff   and         0x0100
        //     get bytes at 0x0155   and         0x0156
//        return this.ByteAt(addr) + (this.ByteAt(wrap(addr)) << this.BYTE_WIDTH)
        if(addr + 1 > (1 << this.BYTE_WIDTH)) {
            return this.ByteAt(addr) + (this.ByteAt(0) << this.BYTE_WIDTH);
        }
        else {
            return this.WordAt(addr);
        }
    }

    // new 65816 address modes and instructions don't page boundary wrap
    private dpWrap(offset: number, pageWrap: boolean = true): number {
        // direct page wraps at {
        if(pageWrap && this.mode && ((this.dpr & this.byteMask) == 0)) {
            // page boundary in emulation mode when dpr low byte = 0
            return this.dpr + (offset & this.byteMask);
        }
        else {
            // bank 0 boundary
            return (this.dpr + offset) & this.addrMask;
        }
    }

    // returns bank 0 word at dpaddr, wrapping at page or bank 0 boundary as appropriate
    private dpWrapAt(dpaddr: number): number {
        // direct page indirect address wraps at {
        if(this.mode && ((this.dpr & this.byteMask) == 0)) {
            // page boundary in emulation mode when dpr low byte = 0
            return this.WrapAt(dpaddr);
        }
        else if(dpaddr == 0xffff) {
            // bank 0 boundary
            return (this.ByteAt(0x0000) << this.BYTE_WIDTH) + this.ByteAt(dpaddr);
        }
        else {
            return this.WordAt(dpaddr);
        }
    }


    // *****************************************************************************
    // *****************************************************************************

    // Addressing modes

    // address modes have to return an effective address, which is something like {
    //   (this.dbr << this.ADDR_WIDTH) + this.pc
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

    private AbsoluteAddr(): number { // "abs" (26 opcodes)
        return (this.dbr << this.ADDR_WIDTH) + this.OperandWord();
    }

    private AbsoluteXAddr(): number { // "abx" (17 opcodes)
        const tmp = this.OperandWord();
        const a1 = (this.dbr << this.ADDR_WIDTH) + tmp;
        const a2 = a1 + this.x;
        if(this.addcycles) {
            if((a1 & this.addrBankMask) != (a2 & this.addrBankMask)) {
                this.excycles += 1;
            }
        }
        return a2;
    }

    private AbsoluteYAddr(): number { // "aby" (9 opcodes)
        const addr = this.OperandWord();
        const a1 = (this.dbr << this.ADDR_WIDTH) + addr;
        const a2 = a1 + this.y;
        if(this.addcycles) {
            if((a1 & this.addrBankMask) != (a2 & this.addrBankMask)) {
                this.excycles += 1;
            }
        }
        return a2;
    }

    // Absolute Indirect "abi" (1 opcode) modeled directly in JMP
    // 65C02 and 65816 don't have the 6502 page wrap bug
    // but operand indirection wraps at bank 0 boundary

    private AbsoluteIndirectXAddr(): number { // "aix" (2 opcodes)
        const pb_addr = (this.pbr << this.ADDR_WIDTH) + this.OperandWord() + this.x;

        // program bank addr indirection wraps at bank boundary
        if((pb_addr & this.addrMask) == 0xffff) {
            return  (this.ByteAt(this.pbr << this.ADDR_WIDTH) << this.BYTE_WIDTH) + this.ByteAt(pb_addr);
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
        return (this.dbr << this.ADDR_WIDTH) + inaddr;
    }

    private DirectPageIndirectAddr(): number { // "dpi" (8 opcodes)
        const dpaddr = this.dpWrap(this.OperandByte());
        const inaddr = this.dpWrapAt(dpaddr);;
        return (this.dbr << this.ADDR_WIDTH) + inaddr;
    }

    // new 65816 address modes don't page boundary wrap
    private DirectPageIndirectLongAddr(): number { // new to 65816, "dil" (8 opcodes)
        var bank: number, inaddr: number;

        const dpaddr = this.dpWrap(this.OperandByte(), false);

        // indirect adddress wraps at bank 0 boundary
        if(dpaddr == 0xffff) {
            bank = this.ByteAt(0x0001);
            inaddr = (this.ByteAt(0x0000) << this.BYTE_WIDTH) + this.ByteAt(dpaddr);
        }
        else if(dpaddr == 0xfffe) {
            bank = this.ByteAt(0x0000);
            inaddr = this.WordAt(dpaddr);
        }
        else {
            bank = this.ByteAt(dpaddr + 2);
            inaddr = this.WordAt(dpaddr);
        }

        return (bank << this.ADDR_WIDTH) + inaddr;
    }

    private DirectPageIndirectYAddr(): number { // "diy" (8 opcodes)
        // *** TODO { check on excycles ***
        const dpaddr = this.dpWrap(this.OperandByte());
        const inaddr = this.dpWrapAt(dpaddr);
        const efaddr = (this.dbr << this.ADDR_WIDTH) + inaddr + this.y;
        if(this.addcycles) {
            if((inaddr & this.addrBankMask) != (efaddr & this.addrBankMask)) {
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

        if(this.addcycles) {
            if((inaddr & this.addrBankMask) != (efaddr & this.addrBankMask)) {
                this.excycles += 1;
            }
        }

        return efaddr;
    }

    private ImmediateAddr(): number { // "imm" (14 opcodes)
        return this.OperandAddr();
    }

    // Implied addressing "imp" (29 opcodes, 65816 programming manual misses WAI)

    private ProgramCounterRelAddr(): void { // "pcr" (9 opcodes)
        var addr: number;

        this.excycles += 1;
        const offset = this.OperandByte();
        this.incPC();

        if(offset & this.NEGATIVE) {
            addr = this.pc - (offset ^ this.byteMask) - 1;
        }
        else {
            addr = this.pc + offset;
        }

        // *** TODO { verify this extra cycle ***
        if((this.pc & this.addrHighMask) != (addr & this.addrHighMask)) {
            this.excycles += 1;
        }

        this.pc = (this.pbr << this.ADDR_WIDTH) + (addr & this.addrMask);
    }

    // new 65816 address modes don't wrap
    private ProgramCounterRelLongAddr(): void { // "prl" (1 opcode)
        var addr: number;

        // this.excycles += 1
        const offset = this.OperandWord();
        this.incPC();

        if((offset >> this.BYTE_WIDTH) & this.NEGATIVE) {
            addr = this.pc - (offset ^ this.addrMask) - 1;
        }
        else {
            addr = this.pc + offset;
        }

        // *** TODO { verify this extra cycle ***
        // if((this.pc & this.addrHighMask) != (addr & this.addrHighMask) {
        //    this.excycles += 1

        this.pc = (this.pbr << this.ADDR_WIDTH) + (addr & this.addrMask);
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
        return (this.sp + this.OperandByte()) & this.addrMask;
    }

    // new 65816 address modes don't wrap
    private StackRelIndirectYAddr(): number { // "siy" (8 opcode)
        const spaddr = (this.sp + this.OperandByte()) & this.addrMask;
        const inaddr = this.WordAt(spaddr);
        // *** TODO { any extra cycles? ***
        return (this.dbr << this.ADDR_WIDTH) + inaddr + this.y;
    }

    // *****************************************************************************
    // *****************************************************************************
    // Operations

    private opADC(x: () => number) {
        var data: number;

        if(this.p & this.MS) {
            data = this.ByteAt(x.call(this));
        }
        else {
            data = this.WordAt(x.call(this));
        }

        if(this.p & this.DECIMAL) {
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
            if(this.p & this.MS) {

                let halfcarry = 0;
                let decimalcarry = 0;
                let adjust0 = 0;
                let adjust1 = 0;
                let nibble0 = (data & 0xf) + (this.a & 0xf) + (this.p & this.CARRY);
                if(nibble0 > 9) {
                    adjust0 = 6;
                    halfcarry = 1;
                }
                let nibble1 = ((data >> 4) & 0xf) + ((this.a >> 4) & 0xf) + halfcarry;
                if(nibble1 > 9) {
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

                this.p &= ~(this.CARRY | this.OVERFLOW | this.NEGATIVE | this.ZERO);
                if(aluresult == 0) {
                    this.p |= this.ZERO;
                }
                else {
                    if(this.p & this.MS) {
                        this.p |= aluresult & this.NEGATIVE;
                    }
                }
                if(decimalcarry == 1) {
                    this.p |= this.CARRY;
                }
                if((~(this.a ^ data) & (this.a ^ aluresult)) & this.NEGATIVE) {
                    this.p |= this.OVERFLOW;
                }
                a = (nibble1 << 4) + nibble0;
            }
            else {
                // 16 bit
                let halfcarry = 0;
                let decimalcarry = 0;
                let adjust0 = 0;
                let adjust1 = 0;
                let nibble0 = (data & 0xf) + (this.a & 0xf) + (this.p & this.CARRY);

//                this.memory[0xfff1] = 0x20
//                this.memory[0xfff1] = nibble0 + 0x30
//                this.memory[0xfff1] = 0x20
//                this.memory[0xfff1] = (this.a & 0xf) + 0x30
//                this.memory[0xfff1] = 0x20
//                this.memory[0xfff1] = (data & 0xf) + 0x30
//                this.memory[0xfff1] = 0x20
//                this.memory[0xfff1] = (this.p & this.CARRY) + 0x30

                if(nibble0 > 9) {
                    adjust0 = 6;
                    halfcarry = 1;
                }
                let nibble1 = ((data >> 4) & 0xf) + ((this.a >> 4) & 0xf) + halfcarry;
                halfcarry = 0;
                if(nibble1 > 9) {
                    adjust1 = 6;
                    halfcarry = 1;
                }

                // continue with msb nibbles
                let adjust2 = 0;
                let adjust3 = 0;
                let nibble2 = (((data & 0xf00) + (this.a & 0xf00)) >> 8) + halfcarry;
                halfcarry = 0;
                if(nibble2 > 9) {
                    adjust2 = 6;
                    halfcarry = 1;
                }
                let nibble3 = ((((data >> 4) & 0xf00) + ((this.a >> 4) & 0xf00)) >> 8) + halfcarry;
                if(nibble3 > 9) {
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

                this.p &= ~(this.CARRY | this.OVERFLOW | this.NEGATIVE | this.ZERO);
                if(aluresult == 0) {
                    this.p |= this.ZERO;
                }
                else {
                    this.p |= (aluresult >> this.BYTE_WIDTH) & this.NEGATIVE;
                }

                if(decimalcarry == 1) {
                    this.p |= this.CARRY;
                }
                // if((~(this.a ^ data) & (this.a ^ aluresult)) & this.NEGATIVE {
                //    this.p |= this.OVERFLOW
                a = aluresult;

                if(((~(this.a ^ data) & (this.a ^ aluresult)) >> this.BYTE_WIDTH) & this.NEGATIVE) {
                    this.p |= this.OVERFLOW;
                }
            }

            this.a = a;
        }
        else {
            var tmp: number;

            if(this.p & this.CARRY) {
                tmp = 1;
            }
            else {
                tmp = 0;
            }
            const result = data + this.a + tmp;
            this.p &= ~(this.CARRY | this.OVERFLOW | this.NEGATIVE | this.ZERO);

            if(this.p & this.MS) {
                if((~(this.a ^ data) & (this.a ^ result)) & this.NEGATIVE) {
                    this.p |= this.OVERFLOW;
                }
            }
            else {
                if((~(this.a ^ data) & (this.a ^ result)) & (this.NEGATIVE << this.BYTE_WIDTH)) {
                    this.p |= this.OVERFLOW;
                }
            }
            data = result;
            if(this.p & this.MS) {
                if(data > this.byteMask) {
                    this.p |= this.CARRY;
                    data &= this.byteMask;
                }
            }
            else {
                if(data > this.addrMask) {
                    this.p |= this.CARRY;
                    data &= this.addrMask;
                }
            }
            if(data == 0) {
                this.p |= this.ZERO;
            }
            else {
                if(this.p & this.MS) {
                    this.p |= data & this.NEGATIVE;
                }
                else {
                    this.p |= (data >> this.BYTE_WIDTH) & this.NEGATIVE;
                }
            }
            this.a = data;
        }
    }

    private opAND(x: () => number) {
        if(this.p & this.MS) {
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

        if(x == null) {
            tbyte = this.a;
        }
        else {
            addr = x.call(this);
            if(this.p & this.MS) {
                tbyte = this.ByteAt(addr);
            }
            else {
                tbyte = this.WordAt(addr);
            }
        }

        this.p &= ~(this.CARRY | this.NEGATIVE | this.ZERO);

        if(this.p & this.MS) {
            if(tbyte & this.NEGATIVE) {
                this.p |= this.CARRY;
            }
            tbyte = (tbyte << 1) & this.byteMask;
        }
        else {
            if((tbyte >> this.BYTE_WIDTH) & this.NEGATIVE) {
                this.p |= this.CARRY;
            }
            tbyte = (tbyte << 1) & this.addrMask;
        }

        if(tbyte) {
            if(this.p & this.MS) {
                this.p |= tbyte & this.NEGATIVE;
            }
            else {
                this.p |= (tbyte >> this.BYTE_WIDTH) & this.NEGATIVE;
            }
        }
        else {
            this.p |= this.ZERO;
        }

        if(x == null) {
            this.a = tbyte;
        }
        else {
            if(this.p & this.MS) {
                this.memory[addr] = tbyte;
            }
            else {
                this.memory[addr] = tbyte & this.byteMask;
                this.memory[addr + 1] = tbyte >> this.BYTE_WIDTH;
            }
        }
    }

    private opBIT(x: () => number) {
        var tbyte: number;

        if(this.p & this.MS) {
            tbyte = this.ByteAt(x.call(this));
        }
        else {
            tbyte = this.WordAt(x.call(this));
        }

        this.p &= ~(this.ZERO | this.NEGATIVE | this.OVERFLOW);
        if((this.a & tbyte) == 0) {
            this.p |= this.ZERO;
        }
        if(this.p & this.MS) {
            this.p |= tbyte & (this.NEGATIVE | this.OVERFLOW);
        }
        else {
            this.p |= (tbyte >> this.BYTE_WIDTH) & (this.NEGATIVE | this.OVERFLOW);
        }
    }

    private opCMP(addr: (() => number), register_value, bit_flag) {
        var tbyte: number, result: number;

        if((bit_flag == this.IRS) && this.mode) {
            bit_flag = 1;
        }
        else {
            bit_flag = this.p & bit_flag;
        }

        if(bit_flag) {
            tbyte = this.ByteAt(addr.call(this));
        }
        else {
            tbyte = this.WordAt(addr.call(this));
        }

        this.p &= ~(this.CARRY | this.ZERO | this.NEGATIVE);

        result = register_value - tbyte;

        if(result == 0) {
            this.p |= this.CARRY | this.ZERO;
        }
        else if(result > 0) {
            this.p |= this.CARRY;
        }

        if(bit_flag) {
            this.p |= result & this.NEGATIVE;
        }
        else {
            this.p |= (result >> this.BYTE_WIDTH) & this.NEGATIVE;
        }
    }

    private opDECR(x: (() => number) | null) {
        var tbyte: number, addr: number = 0;

        if(x == null) {
            tbyte = this.a;
        }
        else {
            addr = x.call(this);
            if(this.p & this.MS) {
                tbyte = this.ByteAt(addr);
            }
            else {
                tbyte = this.WordAt(addr);
            }
        }

        this.p &= ~(this.ZERO | this.NEGATIVE);
        if(this.p & this.MS) {
            tbyte = (tbyte - 1) & this.byteMask;
        }
        else {
            tbyte = (tbyte - 1) & this.addrMask;
        }

        if(tbyte) {
            if(this.p & this.MS) {
                this.p |= tbyte & this.NEGATIVE;
            }
            else {
                this.p |= (tbyte >> this.BYTE_WIDTH) & this.NEGATIVE;
            }
        }
        else {
            this.p |= this.ZERO;
        }

        if(x == null) {
            this.a = tbyte;
        }
        else {
            if(this.p & this.MS) {
                this.memory[addr] = tbyte & this.byteMask;
            }
            else {
                this.memory[addr] = tbyte & this.byteMask;
                this.memory[addr + 1] = (tbyte >> this.BYTE_WIDTH);
            }
        }
    }

    private opEOR(x: () => number) {
        if(this.p & this.MS) {
            this.a ^= this.ByteAt(x.call(this));
            this.FlagsNZ(this.a);
        }
        else {
            this.a ^= this.WordAt(x.call(this));
            this.FlagsNZWord(this.a);
        }
    }

    private opINCR(x: (() => number) | null) {
        var tbyte: number, addr: number = 0;

        if(x == null) {
            tbyte = this.a;
        }
        else {
            addr = x.call(this);
            if(this.p & this.MS) {
                tbyte = this.ByteAt(addr);
            }
            else {
                tbyte = this.WordAt(addr);
            }
        }

        this.p &= ~(this.ZERO | this.NEGATIVE);
        if(this.p & this.MS) {
            tbyte = (tbyte + 1) & this.byteMask;
        }
        else {
            tbyte = (tbyte + 1) & this.addrMask;
        }
        if(tbyte) {
            if(this.p & this.MS) {
                this.p |= tbyte & this.NEGATIVE;
            }
            else {
                this.p |= (tbyte >> this.BYTE_WIDTH) & this.NEGATIVE;
            }
        }
        else {
            this.p |= this.ZERO;
        }

        if(x == null) {
            this.a = tbyte;
        }
        else {
            if(this.p & this.MS) {
                this.memory[addr] = tbyte & this.byteMask;
            }
            else {
                this.memory[addr] = tbyte & this.byteMask;
                this.memory[addr + 1] = (tbyte >> this.BYTE_WIDTH);
            }
        }
    }

    private opLDA(x: () => number) {
        if(this.p & this.MS) {
            this.a = this.ByteAt(x.call(this));
            this.FlagsNZ(this.a);
        }
        else {
            this.a = this.WordAt(x.call(this));
            this.FlagsNZWord(this.a);
        }
    }

    private opLDX(y: () => number) {
        if((this.p & this.IRS) || this.mode) {
            this.x = this.ByteAt(y.call(this));
            this.FlagsNZ(this.x);
        }
        else {
            this.x = this.WordAt(y.call(this));
            this.FlagsNZWord(this.x);
        }
    }

    private opLDY(x: () => number) {
        if((this.p & this.IRS) || this.mode) {
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

        if(x == null) {
            tbyte = this.a;
        }
        else {
            addr = x.call(this);
            if(this.p & this.MS) {
                tbyte = this.ByteAt(addr);
            }
            else {
                tbyte = this.WordAt(addr);
            }
        }

        this.p &= ~(this.CARRY | this.NEGATIVE | this.ZERO);
        this.p |= tbyte & 1;

        tbyte = tbyte >> 1;
        if(tbyte) {
            //pass
        }
        else {
            this.p |= this.ZERO;
        }

        if(x == null) {
            this.a = tbyte;
        }
        else {
            if(this.p & this.MS) {
                this.memory[addr] = tbyte;
            }
            else {
                this.memory[addr] = tbyte & this.byteMask;
                this.memory[addr + 1] = tbyte >> this.BYTE_WIDTH;
            }
        }
    }

    private opMVB(inc: number) {
        // X is source, Y is dest, A is bytes to move - 1
        // If inc = 1 the addresses are the start
        // If inc = -1 the addresses are the end
        // Operand lsb is dest dbr, msb is source
        const dbr = this.OperandByte() << this.ADDR_WIDTH;
        const sbr = (this.OperandWord() >> this.BYTE_WIDTH) << this.ADDR_WIDTH;
        this.memory[dbr + this.y] = this.memory[sbr + this.x];
        this.x += inc;
        this.y += inc;
        if((this.p & this.IRS) || this.mode) {
            this.x &= this.byteMask;
            this.y &= this.byteMask;
        }
        else {
            this.x &= this.addrMask;
            this.y &= this.addrMask;
        }

        if(this.p & this.MS) {
            const c = (this.b << this.BYTE_WIDTH) + this.a - 1;
            this.a = c & this.byteMask;
            this.b = (c >> this.BYTE_WIDTH) & this.byteMask;
        }
        else {
            this.a -= 1;
            this.a &= this.addrMask;
        }
    }

    private opORA(x: () => number) {
        if(this.p & this.MS) {
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

        if(x == null) {
            tbyte = this.a;
        }
        else {
            addr = x.call(this);
            if(this.p & this.MS) {
                tbyte = this.ByteAt(addr);
            }
            else {
                tbyte = this.WordAt(addr);
            }
        }

        if(this.p & this.CARRY) {
            if(this.p & this.MS) {
                if(tbyte & this.NEGATIVE) {
                    //pass
                }
                else {
                    this.p &= ~this.CARRY;
                }
            }
            else {
                if((tbyte >> this.BYTE_WIDTH) & this.NEGATIVE) {
                    //pass
                }
                else {
                    this.p &= ~this.CARRY;
                }
            }

            tbyte = (tbyte << 1) | 1;
        }
        else {
            if(this.p & this.MS) {
                if(tbyte & this.NEGATIVE) {
                    this.p |= this.CARRY;
                }
            }
            else {
                if((tbyte >> this.BYTE_WIDTH) & this.NEGATIVE) {
                    this.p |= this.CARRY;
                }
            }
            tbyte = tbyte << 1;
        }

        if(this.p & this.MS) {
            tbyte &= this.byteMask;
            this.FlagsNZ(tbyte);
        }
        else {
            tbyte &= this.addrMask;
            this.FlagsNZWord(tbyte);
        }

        if(x == null) {
            this.a = tbyte;
        }
        else {
            if(this.p & this.MS) {
                this.memory[addr] = tbyte & this.byteMask;
            }
            else {
                this.memory[addr] = tbyte & this.byteMask;
                this.memory[addr + 1] = tbyte >> this.BYTE_WIDTH;
            }
        }
    }

    private opROR(x: (() => number) | null) {
        var tbyte: number, addr: number = 0;

        if(x == null) {
            tbyte = this.a;
        }
        else {
            addr = x.call(this);
            if(this.p & this.MS) {
                tbyte = this.ByteAt(addr);
            }
            else {
                tbyte = this.WordAt(addr);
            }
        }

        if(this.p & this.CARRY) {
            if(tbyte & 1) {
                //pass
            }
            else {
                this.p &= ~this.CARRY;
            }
            if(this.p & this.MS) {
                tbyte = (tbyte >> 1) | this.NEGATIVE;
            }
            else {
                tbyte = (tbyte >> 1) | (this.NEGATIVE << this.BYTE_WIDTH);
            }
        }
        else {
            if(tbyte & 1) {
                this.p |= this.CARRY;
            }
            tbyte = tbyte >> 1;
        }

        if(this.p & this.MS) {
            this.FlagsNZ(tbyte);
        }
        else {
            this.FlagsNZWord(tbyte);
        }

        if(x == null) {
            this.a = tbyte;
        }
        else {
            if(this.p & this.MS) {
                this.memory[addr] = tbyte & this.byteMask;
            }
            else {
                this.memory[addr] = tbyte & this.byteMask;
                this.memory[addr + 1] = tbyte >> this.BYTE_WIDTH;
            }
        }
    }

    private opSBC(x: () => number) {
        var data: number;

        if(this.p & this.MS) {
            data = this.ByteAt(x.call(this));
        }
        else {
            data = this.WordAt(x.call(this));
        }

        if(this.p & this.DECIMAL) {
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
            if(this.p & this.MS) {

                let halfcarry = 1;
                let decimalcarry = 0;
                let adjust0 = 0;
                let adjust1 = 0;

                let nibble0 = (this.a & 0xf) + (~data & 0xf) + (this.p & this.CARRY);
                if(nibble0 <= 0xf) {
                    halfcarry = 0;
                    adjust0 = 10;
                }
                let nibble1 = ((this.a >> 4) & 0xf) + ((~data >> 4) & 0xf) + halfcarry;
                if(nibble1 <= 0xf) {
                    adjust1 = 10 << 4;
                }
                // the ALU outputs are not decimally adjusted
                let aluresult = this.a + (~data & this.byteMask) + (this.p & this.CARRY);

                if(aluresult > this.byteMask) {
                    decimalcarry = 1;
                }
                aluresult &= this.byteMask;

                // but the final result will be adjusted
                nibble0 = (aluresult + adjust0) & 0xf;
                nibble1 = ((aluresult + adjust1) >> 4) & 0xf;

                // Update result for use in setting flags below
                aluresult = (nibble1 << 4) + nibble0;

                this.p &= ~(this.CARRY | this.ZERO | this.NEGATIVE | this.OVERFLOW);
                if(aluresult == 0) {
                    this.p |= this.ZERO;
                }
                else {
                    this.p |= aluresult & this.NEGATIVE;
                }
                if(decimalcarry == 1) {
                    this.p |= this.CARRY;
                }
                if(((this.a ^ data) & (this.a ^ aluresult)) & this.NEGATIVE) {
                    this.p |= this.OVERFLOW;
                }
                this.a = aluresult;
            }
            else {
                // 16 bit
                let halfcarry = 1;
                let decimalcarry = 0;
                let adjust0 = 0;
                let adjust1 = 0;
                let nibble0 = (this.a & 0xf) + (~data & 0xf) + (this.p & this.CARRY);

//                this.memory[0xfff1] = 0x20
//                this.memory[0xfff1] = nibble0 + 0x30
//                this.memory[0xfff1] = 0x20
//                this.memory[0xfff1] = (this.a & 0xf) + 0x30
//                this.memory[0xfff1] = 0x20
//                this.memory[0xfff1] = (data & 0xf) + 0x30
//                this.memory[0xfff1] = 0x20
//                this.memory[0xfff1] = (this.p & this.CARRY) + 0x30
//                this.a = (nibble1 << 4) + nibble0
//                this.a = 0
//                this.a = 0xffff

                if(nibble0 <= 0xf) {
                    halfcarry = 0;
                    adjust0 = 10;
                }
                let nibble1 = ((this.a >> 4) & 0xf) + ((~data >> 4) & 0xf) + halfcarry;
                halfcarry = 1;
                if(nibble1 <= 0xf) {
                    halfcarry = 0;
                    adjust1 = 10 << 4;
                }
                // continue with msb nibbles
                let adjust2 = 0;
                let adjust3 = 0;
                let nibble2 = (((this.a & 0xf00) + (~data & 0xf00)) >> 8) + halfcarry;
                halfcarry = 1;
                if(nibble2 <= 0xf) {
                    halfcarry = 0;
                    adjust2 = 10;
                }
                let nibble3 = ((((this.a >> 4) & 0xf00) + ((~data >> 4) & 0xf00)) >> 8) + halfcarry;
                if(nibble3 <= 0xf) {
                    adjust3 = 10 << 4;
                }

                // the ALU outputs are not decimally adjusted
                let aluresult = this.a + (~data & this.addrMask) + (this.p & this.CARRY);

                if(aluresult > this.addrMask) {
                    decimalcarry = 1;
                }
                const aluresultL = aluresult & this.byteMask;
                const aluresultH = (aluresult >> this.BYTE_WIDTH) & this.byteMask;

                // but the final result will be adjusted
                nibble0 = (aluresultL + adjust0) & 0xf;
                nibble1 = ((aluresultL + adjust1) >> 4) & 0xf;
                nibble2 = (aluresultH + adjust2) & 0xf;
                nibble3 = ((aluresultH + adjust3) >> 4) & 0xf;

                // Update result for use in setting flags below
                aluresult = (nibble3 << 12) + (nibble2 << 8) + (nibble1 << 4) + nibble0;

                this.p &= ~(this.CARRY | this.ZERO | this.NEGATIVE | this.OVERFLOW);
                if(aluresult == 0) {
                    this.p |= this.ZERO;
                }
                else {
                    this.p |= (aluresult >> this.BYTE_WIDTH) & this.NEGATIVE;
                }
                if(decimalcarry == 1) {
                    this.p |= this.CARRY;
                }
                if((((this.a ^ data) & (this.a ^ aluresult)) >> this.BYTE_WIDTH) & this.NEGATIVE) {
                    this.p |= this.OVERFLOW;
                }
                this.a = aluresult;
            }
        }
        else {
            var result: number;

            if(this.p & this.MS) {
                result = this.a + (~data & this.byteMask) + (this.p & this.CARRY);
            }
            else {
                result = this.a + (~data & this.addrMask) + (this.p & this.CARRY);
            }
            this.p &= ~(this.CARRY | this.ZERO | this.OVERFLOW | this.NEGATIVE);
            if(this.p & this.MS) {
                if(((this.a ^ data) & (this.a ^ result)) & this.NEGATIVE) {
                    this.p |= this.OVERFLOW;
                }
                data = result & this.byteMask;
                if(result > this.byteMask) {
                    this.p |= this.CARRY;
                }
                this.p |= data & this.NEGATIVE;
            }
            else {
                if((((this.a ^ data) & (this.a ^ result)) >> this.BYTE_WIDTH) & this.NEGATIVE) {
                    this.p |= this.OVERFLOW;
                }
                data = result & this.addrMask;
                if(result > this.addrMask) {
                    this.p |= this.CARRY;
                }
                this.p |= (data >> this.BYTE_WIDTH) & this.NEGATIVE;
            }
            if(data == 0) {
                this.p |= this.ZERO;
            }

            this.a = data;
        }
    }

    private opSTA(x: () => number) {
        const addr = x.call(this);

        if(this.p & this.MS) {
            this.memory[addr] = this.a & this.byteMask;
        }
        else {
            this.memory[addr] = this.a & this.byteMask;
            this.memory[addr + 1] = (this.a >> this.BYTE_WIDTH) & this.byteMask;
        }
    }

    private opSTX(y: () => number) {
        const addr = y.call(this);

        // need to be explicit with mode as bit 4 can be 0 in mode 1 with an interrupt
        if((this.p & this.IRS) || this.mode) {
            this.memory[addr] = this.x & this.byteMask;
        }
        else {
            this.memory[addr] = this.x & this.byteMask;
            this.memory[addr + 1] = (this.x >> this.BYTE_WIDTH) & this.byteMask;
        }
    }

    private opSTY(x: () => number) {
        const addr = x.call(this);

        // need to be explicit with mode as bit 4 can be 0 in mode 1 with an interrupt
        if((this.p & this.IRS) || this.mode) {
            this.memory[addr] = this.y & this.byteMask;
        }
        else {
            this.memory[addr] = this.y & this.byteMask;
            this.memory[addr + 1] = (this.y >> this.BYTE_WIDTH) & this.byteMask;
        }
    }

    private opSTZ(x: () => number) {
        const addr = x.call(this);

        if(this.p & this.MS) {
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

        if(this.p & this.MS) {
            m = this.memory[addr];
        }
        else {
            m = (this.memory[addr + 1] << this.BYTE_WIDTH) + this.memory[addr];
        }

        this.p &= ~this.ZERO;
        z = m & this.a;
        if(z == 0) {
            this.p |= this.ZERO;
        }

        r = m | this.a;
        if(this.p & this.MS) {
            this.memory[addr] = r;
        }
        else {
            this.memory[addr] = r & this.byteMask;
            this.memory[addr + 1] = (r >> this.BYTE_WIDTH) & this.byteMask;
        }
    }

    private opTRB(x: () => number) {
        var m, r, z;
        const addr = x.call(this);

        if(this.p & this.MS) {
            m = this.memory[addr];
        }
        else {
            m = (this.memory[addr + 1] << this.BYTE_WIDTH) + this.memory[addr];
        }

        this.p &= ~this.ZERO;
        z = m & this.a;
        if(z == 0) {
            this.p |= this.ZERO;
        }

        r = m & ~this.a;
        if(this.p & this.MS) {
            this.memory[addr] = r;
        }
        else {
            this.memory[addr] = r & this.byteMask;
            this.memory[addr + 1] = (r >> this.BYTE_WIDTH) & this.byteMask;
        }
    }

    // *****************************************************************************
    // *****************************************************************************
    // Instructions

    // *** TODO: extra cycles need considered for all new to 65816 only opcodes ***    }

    @instruction("BRK", "stk", 7)
    private inst_0x00() {
        if(!this.mode) {
            this.stPush(this.pbr);
        }

        // pc has already been increased one
        // increment for optional signature byte
        const pc = (this.pc + 1) & this.addrMask;
        this.stPushWord(pc);

        if(this.mode) {
            this.p |= this.BREAK;
            this.stPush(this.p | this.BREAK | this.UNUSED);
        }
        else {
            this.stPush(this.p);
        }

        this.p |= this.INTERRUPT;
        this.pbr = 0;
        if(this.mode) {
            this.pc = this.WordAt(this.IRQ[this.mode]);
        }
        else {
            this.pc = this.WordAt(this.BRK);
        }

        // 65C816 clears decimal flag, NMOS 6502 does not
        this.p &= ~this.DECIMAL;
    }

    @instruction("ORA", "dix", 6)
    private inst_0x01() {
        this.opORA(this.DirectPageIndirectXAddr);
        this.incPC();
    }

    @instruction("COP", "stk", 7)  // new to 65816
    private inst_0x02() {
        // *** TODO: consider consolidating with BRK ***
        if(!this.mode) {
            this.stPush(this.pbr);
        }

        // pc has already been increased one
        // increment for optional signature byte
        const pc = (this.pc + 1) & this.addrMask;
        this.stPushWord(pc);

        this.stPush(this.p);

        this.p |= this.INTERRUPT;
        this.pbr = 0;
        this.pc = this.WordAt(this.COP[this.mode]);

        // 65C816 clears decimal flag
        this.p &= ~this.DECIMAL;
    }

    @instruction("ORA", "str", 2)  // new to 65816
    private inst_0x03() {
        this.opORA(this.StackRelAddr);
        this.incPC();
    }

    @instruction("TSB", "dpg", 5)
    private inst_0x04() {
        this.opTSB(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("ORA", "dpg", 3)
    private inst_0x05() {
        this.opORA(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("ASL", "dpg", 5)
    private inst_0x06() {
        this.opASL(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("ORA", "dil", 6)  // new to 65816
    private inst_0x07() {
        this.opORA(this.DirectPageIndirectLongAddr);
        this.incPC();
    }

    @instruction("PHP", "stk", 3)
    private inst_0x08() {
        if(this.mode) {
            this.stPush(this.p | this.BREAK | this.UNUSED);
        }
        else {
            this.stPush(this.p);
        }
    }

    @instruction("ORA", "imm", 2)
    private inst_0x09() {
        this.opORA(this.ImmediateAddr);
        this.incPC(2 - ((this.p & this.MS) >> 5));
    }

    @instruction("ASL", "acc", 2)
    private inst_0x0a() {
        this.opASL(null);
    }

    @instruction("PHD", "stk", 4) // new to 65816
    private inst_0x0b() {
        this.stPushWord(this.dpr);
    }

    @instruction("TSB", "abs", 6)
    private inst_0x0c() {
        this.opTSB(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("ORA", "abs", 4)
    private inst_0x0d() {
        this.opORA(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("ASL", "abs", 6)
    private inst_0x0e() {
        this.opASL(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("ORA", "abl", 5) // new to 65816
    private inst_0x0f() {
        this.opORA(this.AbsoluteLongAddr);
        this.incPC(3);
    }

    @instruction("BPL", "pcr", 2, 2)
    private inst_0x10() {
        this.bCLR(this.NEGATIVE);
    }

    @instruction("ORA", "diy", 5, 1)
    private inst_0x11() {
        this.opORA(this.DirectPageIndirectYAddr);
        this.incPC();
    }

    @instruction("ORA", "dpi", 5)
    private inst_0x12() {
        this.opORA(this.DirectPageIndirectAddr);
        this.incPC();
    }

    @instruction("ORA", "siy", 7) // new to 65816
    private inst_0x13() {
        this.opORA(this.StackRelIndirectYAddr);
        this.incPC();
    }

    @instruction("TRB", "dpg", 5)
    private inst_0x14() {
        this.opTRB(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("ORA", "dpx", 4)
    private inst_0x15() {
        this.opORA(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("ASL", "dpx", 6)
    private inst_0x16() {
        this.opASL(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("ORA", "dly", 6)  // new to 65816
    private inst_0x17() {
        this.opORA(this.DirectPageIndirectLongYAddr);
        this.incPC();
    }

    @instruction("CLC", "imp", 2)
    private inst_0x18() {
        this.pCLR(this.CARRY);
    }

    @instruction("ORA", "aby", 4, 1)
    private inst_0x19() {
        this.opORA(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("INC", "acc", 2)
    private inst_0x1a() {
        this.opINCR(null);
    }

    @instruction("TCS", "imp", 2) // new to 65816
    private inst_0x1b() {
        if(this.p & this.MS) {
            // A is 8 bit
            if(this.mode) {
                // high byte is forced to 1 elsewhere
                this.sp = this.a & this.byteMask;
            }
            else {
                // hidden B is transfered
                this.sp = (this.b << this.BYTE_WIDTH) + this.a;
            }
        }
        else {
            // A is 16 bit
            this.sp = this.a;
        }
    }

    @instruction("TRB", "abs", 6)
    private inst_0x1c() {
        this.opTRB(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("ORA", "abx", 4, 1)
    private inst_0x1d() {
        this.opORA(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("ASL", "abx", 7)
    private inst_0x1e() {
        this.opASL(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("ORA", "alx", 5) // new to 65816
    private inst_0x1f() {
        this.opORA(this.AbsoluteLongXAddr);
        this.incPC(3);
    }

    @instruction("JSR", "abs", 6)
    private inst_0x20() {
        this.stPushWord((this.pc + 1) & this.addrMask);
        this.pc = this.OperandWord();
    }

    @instruction("AND", "dix", 6)
    private inst_0x21() {
        this.opAND(this.DirectPageIndirectXAddr);
        this.incPC();
    }

    @instruction("JSL", "abl", 8) // new to 65816
    private inst_0x22() {
        this.stPush(this.pbr);
        this.stPushWord((this.pc + 2) & this.addrMask);
        const pbr = this.ByteAt((this.pbr << this.ADDR_WIDTH) + this.pc + 2);
        this.pc = this.OperandWord();
        this.pbr = pbr;
    }

    @instruction("AND", "str", 4) // new to 65816
    private inst_0x23() {
        this.opAND(this.StackRelAddr);
        this.incPC();
    }

    @instruction("BIT", "dpg", 3)
    private inst_0x24() {
        this.opBIT(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("AND", "dpg", 3)
    private inst_0x25() {
        this.opAND(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("ROL", "dpg", 5)
    private inst_0x26() {
        this.opROL(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("AND", "dil", 6)  // new to 65816
    private inst_0x27() {
        this.opAND(this.DirectPageIndirectLongAddr);
        this.incPC();
    }

    @instruction("PLP", "stk", 4)
    private inst_0x28() {
        const p = this.stPop();
        if(this.mode) {
            // *** TODO:
            // the 65816 Programming manual has the this can change the BREAK flag
            // verify this isn't true ***
            this.p = p | this.BREAK | this.UNUSED;
        }
        else {
            if((p & this.MS) != (this.p & this.MS)) {
                if(p & this.MS) {
                    // A 16 => 8, save B, mask off high byte of A
                    this.b = (this.a >> this.BYTE_WIDTH) & this.byteMask;
                    this.a = this.a & this.byteMask;
                }
                else {
                    // A 8 => 16, set A = b a
                    this.a = (this.b << this.BYTE_WIDTH) + this.a;
                    this.b = 0;
                }
            }
            if((p & this.IRS) != (this.p & this.IRS)) {
                if(p & this.IRS) {
                    // X,Y 16 => 8, truncate X,Y
                    this.x = this.x & this.byteMask;
                    this.y = this.y & this.byteMask;
                }
            }
            this.p = p;
        }
    }

    @instruction("AND", "imm", 2)
    private inst_0x29() {
        this.opAND(this.ImmediateAddr);
        this.incPC(2 - ((this.p & this.MS) >> 5));
    }

    @instruction("ROL", "acc", 2)
    private inst_0x2a() {
        this.opROL(null);
    }

    @instruction("PLD", "stk", 5) // new to 65816
    private inst_0x2b() {
        this.dpr = this.stPopWord();
    }

    @instruction("BIT", "abs", 4)
    private inst_0x2c() {
        this.opBIT(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("AND", "abs", 4)
    private inst_0x2d() {
        this.opAND(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("ROL", "abs", 6)
    private inst_0x2e() {
        this.opROL(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("AND", "abl", 5) // new to 65816
    private inst_0x2f() {
        this.opAND(this.AbsoluteLongAddr);
        this.incPC(3);
    }

    @instruction("BMI", "pcr", 2, 2)
    private inst_0x30() {
        this.bSET(this.NEGATIVE);
    }

    @instruction("AND", "diy", 5, 1)
    private inst_0x31() {
        this.opAND(this.DirectPageIndirectYAddr);
        this.incPC();
    }

    @instruction("AND", "dpi", 5)
    private inst_0x32() {
        this.opAND(this.DirectPageIndirectAddr);
        this.incPC();
    }

    @instruction("AND", "siy", 7) // new to 65816
    private inst_0x33() {
        this.opAND(this.StackRelIndirectYAddr);
        this.incPC();
    }

    @instruction("BIT", "dpx", 4)
    private inst_0x34() {
        this.opBIT(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("AND", "dpx", 4)
    private inst_0x35() {
        this.opAND(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("ROL", "dpx", 6)
    private inst_0x36() {
        this.opROL(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("AND", "dly", 7) // new to 65816
    private inst_0x37() {
        this.opAND(this.DirectPageIndirectLongYAddr);
        this.incPC();
    }

    @instruction("SEC", "imp", 2)
    private inst_0x38() {
        this.pSET(this.CARRY);
    }

    @instruction("AND", "aby", 4, 1)
    private inst_0x39() {
        this.opAND(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("DEC", "acc", 2)
    private inst_0x3a() {
        this.opDECR(null);
    }

    @instruction("TSC", "imp", 2) // new to 65816
    private inst_0x3b() {
        if(this.p & this.MS) {
            // A is 8 bit, hidden B is set to high byte
            if(this.mode) {
                this.b = 0x01;
            }
            else {
                this.b = this.sp >> this.BYTE_WIDTH;
            }
            this.a = this.sp & this.byteMask;
        }
        else {
            // A is 16 bit
            this.a = this.sp;
        }

        this.FlagsNZWord(this.sp);
    }

    @instruction("BIT", "abx", 4)
    private inst_0x3c() {
        this.opBIT(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("AND", "abx", 4, 1)
    private inst_0x3d() {
        this.opAND(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("ROL", "abx", 7)
    private inst_0x3e() {
        this.opROL(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("AND", "alx", 5) // new to 65816
    private inst_0x3f() {
        this.opAND(this.AbsoluteLongXAddr);
        this.incPC(3);
    }

    @instruction("RTI", "stk", 6)
    private inst_0x40() {
        var p;

        if(this.mode) {
            this.p = (this.stPop() | this.BREAK | this.UNUSED);
            this.pc = this.stPopWord();
        }
        else {
            p = this.stPop();
            this.pc = this.stPopWord();
            this.pbr = this.stPop();

            // reflect any change in register modes
            if((p & this.MS) != (this.p & this.MS)) {
                if(p & this.MS) {
                    // A 16 => 8, save B, mask off high byte of A
                    this.b = (this.a >> this.BYTE_WIDTH) & this.byteMask;
                    this.a = this.a & this.byteMask;
                }
                else {
                    // A 8 => 16, set A = b a
                    this.a = (this.b << this.BYTE_WIDTH) + this.a;
                    this.b = 0;
                }
            }
            if((p & this.IRS) != (this.p & this.IRS)) {
                if(p & this.IRS) {
                    // X,Y 16 => 8, truncate X,Y
                    this.x = this.x & this.byteMask;
                    this.y = this.y & this.byteMask;
                }
            }
            this.p = p;
        }
    }

    @instruction("EOR", "dix", 6)
    private inst_0x41() {
        this.opEOR(this.DirectPageIndirectXAddr);
        this.incPC();
    }

    @instruction("WDM", "imp", 2) // new to 65816
    private inst_0x42() {
        // shouldn't be used but if this acts like a two byte NOP
        this.incPC();
    }

    @instruction("EOR", "str", 4) // new to 65816
    private inst_0x43() {
        this.opEOR(this.StackRelAddr);
        this.incPC();
    }

    @instruction("MVP", "blk", 7) // new to 65816
    private inst_0x44() {
        // MVP handles interrupts by not incrementing pc until C == $ffff
        // thus like the 65816 it completes the current byte transfer before
        // breaking for the interrupt and then returns
        // X is source, Y is dest ending addresses; A is bytes to move - 1
        // Operand lsb is dest dbr, msb is source
        var c;

        if(this.p & this.MS) {
            c = (this.b << this.BYTE_WIDTH) + this.a;
        }
        else {
            c = this.a;
        }

        if(c != 0xffff) {
            this.opMVB(-1);
            this.pc -= 1; // move pc back to the MVP instruction
        }
        else {
            this.dbr = this.OperandByte();
            this.incPC(2);
        }
    }

    @instruction("EOR", "dpg", 3)
    private inst_0x45() {
        this.opEOR(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("LSR", "dpg", 5)
    private inst_0x46() {
        this.opLSR(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("EOR", "dil", 6) // new to 65816
    private inst_0x47() {
        this.opEOR(this.DirectPageIndirectLongAddr);
        this.incPC();
    }

    @instruction("PHA", "stk", 3)
    private inst_0x48() {
        if(this.p & this.MS) {
            this.stPush(this.a);
        }
        else {
            this.stPushWord(this.a);
        }
    }

    @instruction("EOR", "imm", 2)
    private inst_0x49() {
        this.opEOR(this.ImmediateAddr);
        this.incPC(2 - ((this.p & this.MS) >> 5));
    }

    @instruction("LSR", "acc", 2)
    private inst_0x4a() {
        this.opLSR(null);
    }

    @instruction("PHK", "stk", 3) // new to 65816
    private inst_0x4b() {
        this.stPush(this.pbr);
    }

    @instruction("JMP", "abs", 3)
    private inst_0x4c() {
        this.pc = this.OperandWord();
    }

    @instruction("EOR", "abs", 4)
    private inst_0x4d() {
        this.opEOR(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("LSR", "abs", 6)
    private inst_0x4e() {
        this.opLSR(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("EOR", "abl", 5) // new to 65816
    private inst_0x4f() {
        this.opEOR(this.AbsoluteLongAddr);
        this.incPC(3);
    }

    @instruction("BVC", "pcr", 2, 2)
    private inst_0x50() {
        this.bCLR(this.OVERFLOW);
    }

    @instruction("EOR", "diy", 5, 1)
    private inst_0x51() {
        this.opEOR(this.DirectPageIndirectYAddr);
        this.incPC();
    }

    @instruction("EOR", "dpi", 5)
    private inst_0x52() {
        this.opEOR(this.DirectPageIndirectAddr);
        this.incPC();
    }

    @instruction("EOR", "siy", 7) // new to 65816
    private inst_0x53() {
        this.opEOR(this.StackRelIndirectYAddr);
        this.incPC();
    }

    @instruction("MVN", "blk", 7) // new to 65816
    private inst_0x54() {
        // MVN handles interrupts by not incrementing pc until A == $ffff
        // thus like the 65816 it completes the current byte transfer before
        // breaking for the interrupt and then returns
        // X is source, Y is dest starting addresses; A is bytes to move - 1
        // Operand lsb is dest dbr, msb is source
        var c;

        if(this.p & this.MS) {
            c = (this.b << this.BYTE_WIDTH) + this.a;
        }
        else {
            c = this.a;
        }

        if(c != 0xffff) {
            this.opMVB(1);
            this.pc -= 1; // move pc back to the MVP instruction
        }
        else {
            this.dbr = this.OperandByte();
            this.incPC(2);
        }
    }

    @instruction("EOR", "dpx", 4)
    private inst_0x55() {
        this.opEOR(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("LSR", "dpx", 6)
    private inst_0x56() {
        this.opLSR(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("EOR", "dly", 6) // new to 65816
    private inst_0x57() {
        this.opEOR(this.DirectPageIndirectLongYAddr);
        this.incPC();
    }

    @instruction("CLI", "imp", 2)
    private inst_0x58() {
        this.pCLR(this.INTERRUPT);
    }

    @instruction("EOR", "aby", 4, 1)
    private inst_0x59() {
        this.opEOR(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("PHY", "stk", 3)
    private inst_0x5a() {
        if((this.p & this.IRS) || this.mode) {
            this.stPush(this.y);
        }
        else {
            this.stPushWord(this.y);
        }
    }

    @instruction("TCD", "imp", 2) // new to 65816
    private inst_0x5b() {
        if(this.p & this.MS) {
            // A is 8 bit, hidden B is transfered as well
            this.dpr = (this.b << this.BYTE_WIDTH) + this.a;
        }
        else {
            // A is 16 bit
            this.dpr = this.a;
        }

        this.FlagsNZWord(this.dpr);
    }

    @instruction("JML", "abl", 4)  // new to 65816
    private inst_0x5c() {
        const pbr = this.ByteAt((this.pbr << this.ADDR_WIDTH) + this.pc + 2);
        this.pc = this.OperandWord();
        this.pbr = pbr;
    }

    @instruction("EOR", "abx", 4, 1)
    private inst_0x5d() {
        this.opEOR(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("LSR", "abx", 7)
    private inst_0x5e() {
        this.opLSR(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("EOR", "alx", 5) // new to 65816
    private inst_0x5f() {
        this.opEOR(this.AbsoluteLongXAddr);
        this.incPC(3);
    }

    @instruction("RTS", "stk", 6)
    private inst_0x60() {
        this.pc = this.stPopWord();
        this.incPC();
    }

    @instruction("ADC", "dix", 6)
    private inst_0x61() {
        this.opADC(this.DirectPageIndirectXAddr);
        this.incPC();
    }

    @instruction("PER", "spc", 6) // new to 65816
    private inst_0x62() {
        this.stPushWord((this.pc + this.OperandWord()) & this.addrMask);
        this.incPC(2);
    }

    @instruction("ADC", "str", 4) // new to 65816
    private inst_0x63() {
        this.opADC(this.StackRelAddr);
        this.incPC();
    }

    @instruction("STZ", "dpg", 3)
    private inst_0x64() {
        this.opSTZ(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("ADC", "dpg", 3)
    private inst_0x65() {
        this.opADC(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("ROR", "dpg", 5)
    private inst_0x66() {
        this.opROR(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("ADC", "dil", 6) // new to 65816
    private inst_0x67() {
        this.opADC(this.DirectPageIndirectLongAddr);
        this.incPC();
    }

    @instruction("PLA", "stk", 4)
    private inst_0x68() {
        if(this.p & this.MS) {
            this.a = this.stPop();
            this.FlagsNZ(this.a);
        }
        else {
            this.a = this.stPopWord();
            this.FlagsNZWord(this.a);
        }
    }

    @instruction("ADC", "imm", 2)
    private inst_0x69() {
        this.opADC(this.ImmediateAddr);
        this.incPC(2 - ((this.p & this.MS) >> 5));
    }

    @instruction("ROR", "acc", 2)
    private inst_0x6a() {
        this.opROR(null);
    }

    @instruction("RTL", "stk", 6) // new to 65816
    private inst_0x6b() {
        this.pc = this.stPopWord();
        this.pbr = this.stPop();
        this.incPC();
    }

    @instruction("JMP", "abi", 5)
    private inst_0x6c() {
        // 65C02 and 65816 don't have the 6502 page wrap bug
        const operand = this.OperandWord();

        // operand indirection wraps at bank 0 boundary
        if(operand == 0xffff) {
            this.pc = (this.ByteAt(0x0000) << this.BYTE_WIDTH) + this.ByteAt(operand);
        }
        else {
            this.pc = this.WordAt(operand);
        }
    }

    @instruction("ADC", "abs", 4)
    private inst_0x6d() {
        this.opADC(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("ROR", "abs", 6)
    private inst_0x6e() {
        this.opROR(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("ADC", "abl", 5) // new to 65816
    private inst_0x6f() {
        this.opADC(this.AbsoluteLongAddr);
        this.incPC(3);
    }

    @instruction("BVS", "pcr", 2, 2)
    private inst_0x70() {
        this.bSET(this.OVERFLOW);
    }

    @instruction("ADC", "diy", 5, 1)
    private inst_0x71() {
        this.opADC(this.DirectPageIndirectYAddr);
        this.incPC();
    }

    @instruction("ADC", "dpi", 5)
    private inst_0x72() {
        this.opADC(this.DirectPageIndirectAddr);
        this.incPC();
    }

    @instruction("ADC", "siy", 7) // new to 65816
    private inst_0x73() {
        this.opADC(this.StackRelIndirectYAddr);
        this.incPC();
    }

    @instruction("STZ", "dpx", 4)
    private inst_0x74() {
        this.opSTZ(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("ADC", "dpx", 4)
    private inst_0x75() {
        this.opADC(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("ROR", "dpx", 6)
    private inst_0x76() {
        this.opROR(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("ADC", "dly", 6) // new to 65816
    private inst_0x77() {
        this.opADC(this.DirectPageIndirectLongYAddr);
        this.incPC();
    }

    @instruction("SEI", "imp", 2)
    private inst_0x78() {
        this.pSET(this.INTERRUPT);
    }

    @instruction("ADC", "aby", 4, 1)
    private inst_0x79() {
        this.opADC(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("PLY", "stk", 4)
    private inst_0x7a() {
        if((this.p & this.IRS) || this.mode) {
            this.y = this.stPop();
            this.FlagsNZ(this.y);
        }
        else {
            this.y = this.stPopWord();
            this.FlagsNZWord(this.y);
        }
    }

    @instruction("TDC", "imp", 2) // new to 65816
    private inst_0x7b() {
        if(this.p & this.MS) {
            // A is 8 bit, hidden B is set to high byte
            this.b = this.dpr >> this.BYTE_WIDTH;
            this.a = this.dpr & this.byteMask;
        }
        else {
            // A is 16 bit
            this.a = this.dpr;
        }

        this.FlagsNZWord(this.dpr);
    }

    @instruction("JMP", "aix", 6)
    private inst_0x7c() {
        this.pc = this.AbsoluteIndirectXAddr();
    }

    @instruction("ADC", "abx", 4, 1)
    private inst_0x7d() {
        this.opADC(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("ROR", "abx", 7)
    private inst_0x7e() {
        this.opROR(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("ADC", "alx", 5) // new to 65816
    private inst_0x7F() {
        this.opADC(this.AbsoluteLongXAddr);
        this.incPC(3);
    }

    @instruction("BRA", "pcr", 1, 1)
    private inst_0x80() {
        this.ProgramCounterRelAddr();
    }

    @instruction("STA", "dix", 6)
    private inst_0x81() {
        this.opSTA(this.DirectPageIndirectXAddr);
        this.incPC();
    }

    @instruction("BRL", "prl", 4) // new to 65816
    private inst_0x82() {
        this.ProgramCounterRelLongAddr();
    }

    @instruction("STA", "str", 4) // new to 65816
    private inst_0x83() {
        this.opSTA(this.StackRelAddr);
        this.incPC();
    }

    @instruction("STY", "dpg", 3)
    private inst_0x84() {
        this.opSTY(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("STA", "dpg", 3)
    private inst_0x85() {
        this.opSTA(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("STX", "dpg", 3)
    private inst_0x86() {
        this.opSTX(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("STA", "dil", 6) // new to 65816
    private inst_0x87() {
        this.opSTA(this.DirectPageIndirectLongAddr);
        this.incPC();
    }

    @instruction("DEY", "imp", 2)
    private inst_0x88() {
        this.y -= 1;
        if((this.p & this.IRS) || this.mode) {
            this.y &= this.byteMask;
            this.FlagsNZ(this.y);
        }
        else {
            this.y &= this.addrMask;
            this.FlagsNZWord(this.y);
        }
    }

    @instruction("BIT", "imm", 2)
    private inst_0x89() {
        var tbyte;

        // *** TODO: consider using opBIT using { ***
        // p = this.p
        // this.opBIT(this.ImmediateAddr);
        // This instruction (BIT #$12) does not use opBIT because in the
        // immediate mode, BIT only affects the Z flag.
        if(this.p & this.MS) {
            tbyte = this.OperandByte();
        }
        else {
            tbyte = this.OperandWord();
        }
        this.p &= ~(this.ZERO);
        if((this.a & tbyte) == 0) {
            this.p |= this.ZERO;
        }
        this.incPC(2 - ((this.p & this.MS) >> 5));
    }

    @instruction("TXA", "imp", 2)
    private inst_0x8a() {
        // let's be explicit on mode here because interrupts can affect BREAK flag
        // which is the same as IRS, result is the same though, transfer lsb
        if((this.p & this.MS) && this.isCLR(this.IRS) && (this.mode == 0)) {
        // if this.p & this.MS and this.isCLR(this.IRS) {
            // A is 8 bit and X is 16 bit
            this.a = this.x & this.byteMask;
        }
        else {
            // A and X both 8 bit, or both 16 bit, or A is 16 and X is 8
            this.a = this.x;
        }

        if(this.p & this.MS) {
            this.FlagsNZ(this.a);
        }
        else {
            this.FlagsNZWord(this.a);
        }
    }

    @instruction("PHB", "stk", 3) // new to 65816
    private inst_0x8B() {
        this.stPush(this.dbr);
    }

    @instruction("STY", "abs", 4)
    private inst_0x8c() {
        this.opSTY(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("STA", "abs", 4)
    private inst_0x8d() {
        this.opSTA(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("STX", "abs", 4)
    private inst_0x8e() {
        this.opSTX(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("STA", "abl", 5) // new to 65816
    private inst_0x8F() {
        this.opSTA(this.AbsoluteLongAddr);
        this.incPC(3);
    }

    @instruction("BCC", "pcr", 2, 2)
    private inst_0x90() {
        this.bCLR(this.CARRY);
    }

    @instruction("STA", "diy", 6)
    private inst_0x91() {
        this.opSTA(this.DirectPageIndirectYAddr);
        this.incPC();
    }

    @instruction("STA", "dpi", 5)
    private inst_0x92() {
        this.opSTA(this.DirectPageIndirectAddr);
        this.incPC();
    }

    @instruction("STA", "siy", 7) // new to 65816
    private inst_0x93() {
        this.opSTA(this.StackRelIndirectYAddr);
        this.incPC();
    }

    @instruction("STY", "dpx", 4)
    private inst_0x94() {
        this.opSTY(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("STA", "dpx", 4)
    private inst_0x95() {
        this.opSTA(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("STX", "dpy", 4)
    private inst_0x96() {
        this.opSTX(this.DirectPageYAddr);
        this.incPC();
    }

    @instruction("STA", "dly", 6) // new to 65816
    private inst_0x97() {
        this.opSTA(this.DirectPageIndirectLongYAddr);
        this.incPC();
    }

    @instruction("TYA", "imp", 2)
    private inst_0x98() {
        // let's be explicit on mode here because interrupts can affect BREAK flag
        // which is the same as IRS, result is the same though, transfer lsb
        if((this.p & this.MS) && this.isCLR(this.IRS) && (this.mode == 0)) {
        // if this.p & this.MS and this.isCLR(this.IRS) {
            // A is 8 bit and Y is 16 bit
            this.a = this.y & this.byteMask;
        }
        else {
            // A and Y both 8 bit, or both 16 bit, or A is 16 and Y is 8
            this.a = this.y;
        }

        if(this.p & this.MS) {
            this.FlagsNZ(this.a);
        }
        else {
            this.FlagsNZWord(this.a);
        }
    }

    @instruction("STA", "aby", 5)
    private inst_0x99() {
        this.opSTA(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("TXS", "imp", 2)
    private inst_0x9a() {
        if(this.mode) {
            this.sp = this.x;
        }
        else {
            if((this.p & this.IRS) || this.mode) {
                // sp high byte is zero
                this.sp = this.x & this.byteMask;
            }
            else {
                this.sp = this.x;
            }
        }
    }

    @instruction("TXY", "imp", 2) // new to 65816
    private inst_0x9b() {
        this.y = this.x;
        if((this.p & this.IRS) || this.mode) {
            this.FlagsNZ(this.y);
        }
        else {
            this.FlagsNZWord(this.y);
        }
    }

    @instruction("STZ", "abs", 4)
    private inst_0x9c() {
        this.opSTZ(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("STA", "abx", 5)
    private inst_0x9d() {
        this.opSTA(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("STZ", "abx", 5)
    private inst_0x9e() {
        this.opSTZ(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("STA", "alx", 5) // new to 65816
    private inst_0x9f() {
        this.opSTA(this.AbsoluteLongXAddr);
        this.incPC(3);
    }

    @instruction("LDY", "imm", 2)
    private inst_0xa0() {
        this.opLDY(this.ImmediateAddr);
        this.incPC(2 - (((this.p & this.IRS) >> 4) || this.mode));
    }

    @instruction("LDA", "dix", 6)
    private inst_0xa1() {
        this.opLDA(this.DirectPageIndirectXAddr);
        this.incPC();
    }

    @instruction("LDX", "imm", 2)
    private inst_0xa2() {
        this.opLDX(this.ImmediateAddr);
        this.incPC(2 - (((this.p & this.IRS) >> 4) || this.mode));
    }

    @instruction("LDA", "str", 4) // new to 65816
    private inst_0xa3() {
        this.opLDA(this.StackRelAddr);
        this.incPC();
    }

    @instruction("LDY", "dpg", 3)
    private inst_0xa4() {
        this.opLDY(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("LDA", "dpg", 3)
    private inst_0xa5() {
        this.opLDA(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("LDX", "dpg", 3)
    private inst_0xa6() {
        this.opLDX(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("LDA", "dil", 6) // new to 65816
    private inst_0xa7() {
        this.opLDA(this.DirectPageIndirectLongAddr);
        this.incPC();
    }

    @instruction("TAY", "imp", 2)
    private inst_0xa8() {
        // need to be explicit on mode here because interrupts can affect BREAK flag which is the same as IRS
        if((this.p & this.MS) && this.isCLR(this.IRS) && (this.mode == 0)) {
            // A is 8 bit and Y is 16 bit, hidden B is transfered as well
            this.y = (this.b << this.BYTE_WIDTH) + this.a;
        }
        else if(this.isCLR(this.MS) && this.isSET(this.IRS)) {
            // A is 16 bit and Y is 8 bit
            this.y = this.a & this.byteMask;
        }
        else {
            // A and Y both 8 bit, or both 16 bit
            // *** this also works in emulation mode during an interrupt (p bit 4 is cleared) ***
            this.y = this.a;
        }

        if((this.p & this.IRS) || this.mode) {
            this.FlagsNZ(this.y);
        }
        else {
            this.FlagsNZWord(this.y);
        }
    }

    @instruction("LDA", "imm", 2)
    private inst_0xa9() {
        this.opLDA(this.ImmediateAddr);
        this.incPC(2 - ((this.p & this.MS) >> 5));
    }

    @instruction("TAX", "imp", 2)
    private inst_0xaa() {
        // need to be explicit on mode here because interrupts can affect BREAK flag which is the same as IRS
        if((this.p & this.MS) && this.isCLR(this.IRS) && (this.mode == 0)) {
            // A is 8 bit and X is 16 bit, hidden B is transfered as well
            this.x = (this.b << this.BYTE_WIDTH) + this.a;
        }
        else if(this.isCLR(this.MS) && this.isSET(this.IRS)) {
            // A is 16 bit and X is 8 bit
            this.x = this.a & this.byteMask;
        }
        else {
            // A and X both 8 bit, or both 16 bit
            // *** this also works in emulation mode during an interrupt (p bit 4 is cleared) ***
            this.x = this.a;
        }

        if((this.p & this.IRS) || this.mode) {
            this.FlagsNZ(this.x);
        }
        else {
            this.FlagsNZWord(this.x);
        }
    }

    @instruction("PLB", "stk", 4) // new to 65816
    private inst_0xab() {
        this.dbr = this.stPop();
    }

    @instruction("LDY", "abs", 4)
    private inst_0xac() {
        this.opLDY(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("LDA", "abs", 4)
    private inst_0xad() {
        this.opLDA(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("LDX", "abs", 4)
    private inst_0xae() {
        this.opLDX(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("LDA", "abl", 5) // new to 65816
    private inst_0xaf() {
        this.opLDA(this.AbsoluteLongAddr);
        this.incPC(3);
    }

    @instruction("BCS", "pcr", 2, 2)
    private inst_0xb0() {
        this.bSET(this.CARRY);
    }

    @instruction("LDA", "diy", 5, 1)
    private inst_0xb1() {
        this.opLDA(this.DirectPageIndirectYAddr);
        this.incPC();
    }

    @instruction("LDA", "dpi", 5)
    private inst_0xb2() {
        this.opLDA(this.DirectPageIndirectAddr);
        this.incPC();
    }

    @instruction("LDA", "siy", 7) // new to 65816
    private inst_0xb3() {
        this.opLDA(this.StackRelIndirectYAddr);
        this.incPC();
    }

    @instruction("LDY", "dpx", 4)
    private inst_0xb4() {
        this.opLDY(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("LDA", "dpx", 4)
    private inst_0xb5() {
        this.opLDA(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("LDX", "dpy", 4)
    private inst_0xb6() {
        this.opLDX(this.DirectPageYAddr);
        this.incPC();
    }

    @instruction("LDA", "dly", 6) // new to 65816
    private inst_0xb7() {
        this.opLDA(this.DirectPageIndirectLongYAddr);
        this.incPC();
    }

    @instruction("CLV", "imp", 2)
    private inst_0xb8() {
        this.pCLR(this.OVERFLOW);
    }

    @instruction("LDA", "aby", 4, 1)
    private inst_0xb9() {
        this.opLDA(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("TSX", "imp", 2)
    private inst_0xba() {
        if((this.p & this.IRS) || this.mode) {
            this.x = this.sp & this.byteMask;
            this.FlagsNZ(this.x);
        }
        else {
            this.x = this.sp;
            this.FlagsNZWord(this.x);
        }
    }

    @instruction("TYX", "imp", 2) // new to 65816
    private inst_0xbb() {
        this.x = this.y;
        if((this.p & this.IRS) || this.mode) {
            this.FlagsNZ(this.x);
        }
        else {
            this.FlagsNZWord(this.x);
        }
    }

    @instruction("LDY", "abx", 4, 1)
    private inst_0xbc() {
        this.opLDY(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("LDA", "abx", 4, 1)
    private inst_0xbd() {
        this.opLDA(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("LDX", "aby", 4, 1)
    private inst_0xbe() {
        this.opLDX(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("LDA", "alx", 5) // new to 65816
    private inst_0xbf() {
        this.opLDA(this.AbsoluteLongXAddr);
        this.incPC(3);
    }

    @instruction("CPY", "imm", 2)
    private inst_0xc0() {
        this.opCMP(this.ImmediateAddr, this.y, this.IRS);
        this.incPC(2 - (((this.p & this.IRS) >> 4) || this.mode));
    }

    @instruction("CMP", "dix", 6)
    private inst_0xc1() {
        this.opCMP(this.DirectPageIndirectXAddr, this.a, this.MS);
        this.incPC();
    }

    @instruction("REP", "imm", 3) // new to 65816
    private inst_0xc2() {
        const operand = this.OperandByte();
        let mask = this.CARRY;

        while(mask) {
//            if mask & operand and not (this.mode and (mask & this.BREAK or mask & this.UNUSED)) {
//                if mask == this.MS and this.isSET(this.MS) {
//                    // A 8 => 16, set A = b a
//                    this.a = (this.b << this.BYTE_WIDTH) + this.a
//                    this.b = 0
//                this.pCLR(mask)

            // *** TODO: consider reworking SEP also to make conditionals clearer ***
            if(mask & operand) {
                if(this.mode) {
                    // can't change BREAK or UNUSED flags in emulation mode
                    if(!(mask & this.BREAK) || (mask & this.UNUSED)) {
                        this.pCLR(mask);
                    }
                }
                else {
                    if((mask == this.MS) && this.isSET(this.MS)) {
                        // A 8 => 16, set A = b a
                        this.a = (this.b << this.BYTE_WIDTH) + this.a;
                        this.b = 0;
                    }
                    this.pCLR(mask);
                }
            }

            mask = (mask << 1) & this.byteMask;
        }
        this.incPC();
    }

    @instruction("CMP", "str", 4) // new to 65816
    private inst_0xc3() {
        this.opCMP(this.StackRelAddr, this.a, this.MS);
        this.incPC();
    }

    @instruction("CPY", "dpg", 3)
    private inst_0xc4() {
        this.opCMP(this.DirectPageAddr, this.y, this.IRS);
        this.incPC();
    }

    @instruction("CMP", "dpg", 3)
    private inst_0xc5() {
        this.opCMP(this.DirectPageAddr, this.a, this.MS);
        this.incPC();
    }

    @instruction("DEC", "dpg", 5)
    private inst_0xc6() {
        this.opDECR(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("CMP", "dil", 6) // new to 65816
    private inst_0xc7() {
        this.opCMP(this.DirectPageIndirectLongAddr, this.a, this.MS);
        this.incPC();
    }

    @instruction("INY", "imp", 2)
    private inst_0xc8() {
        this.y += 1;
        if((this.p & this.IRS) || this.mode) {
            this.y &= this.byteMask;
            this.FlagsNZ(this.y);
        }
        else {
            this.y &= this.addrMask;
            this.FlagsNZWord(this.y);
        }
    }

    @instruction("CMP", "imm", 2)
    private inst_0xc9() {
        this.opCMP(this.ImmediateAddr, this.a, this.MS);
        this.incPC(2 - ((this.p & this.MS) >> 5));
    }

    @instruction("DEX", "imp", 2)
    private inst_0xca() {
        this.x -= 1;
        if((this.p & this.IRS) || this.mode) {
            this.x &= this.byteMask;
            this.FlagsNZ(this.x);
        }
        else {
            this.x &= this.addrMask;
            this.FlagsNZWord(this.x);
        }
    }

    @instruction("WAI", 'imp', 3)
    private inst_0xcb() {
        this.waiting = true;
    }

    @instruction("CPY", "abs", 4)
    private inst_0xcc() {
        this.opCMP(this.AbsoluteAddr, this.y, this.IRS);
        this.incPC(2);
    }

    @instruction("CMP", "abs", 4)
    private inst_0xcd() {
        this.opCMP(this.AbsoluteAddr, this.a, this.MS);
        this.incPC(2);
    }

    @instruction("DEC", "abs", 3)
    private inst_0xce() {
        this.opDECR(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("CMP", "abl", 5) // new to 65816
    private inst_0xcf() {
        this.opCMP(this.AbsoluteLongAddr, this.a, this.MS);
        this.incPC(3);
    }

    @instruction("BNE", "pcr", 2, 2)
    private inst_0xd0() {
        this.bCLR(this.ZERO);
    }

    @instruction("CMP", "diy", 5, 1)
    private inst_0xd1() {
        this.opCMP(this.DirectPageIndirectYAddr, this.a, this.MS);
        this.incPC();
    }

    @instruction("CMP", 'dpi', 5)
    private inst_0xd2() {
        this.opCMP(this.DirectPageIndirectAddr, this.a, this.MS);
        this.incPC();
    }

    @instruction("CMP", "siy", 7) // new to 65816
    private inst_0xd3() {
        this.opCMP(this.StackRelIndirectYAddr, this.a, this.MS);
        this.incPC();
    }

    @instruction("PEI", "ski", 6) // new to 65816
    private inst_0xd4() {
        const addr = this.WordAt(this.dpr + this.OperandByte()); // in Bank 0
        this.stPushWord(addr);
        this.incPC();
    }

    @instruction("CMP", "dpx", 4)
    private inst_0xd5() {
        this.opCMP(this.DirectPageXAddr, this.a, this.MS);
        this.incPC();
    }

    @instruction("DEC", "dpx", 6)
    private inst_0xd6() {
        this.opDECR(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("CMP", "dly", 6) // new to 65816
    private inst_0xd7() {
        this.opCMP(this.DirectPageIndirectLongYAddr, this.a, this.MS);
        this.incPC();
    }

    @instruction("CLD", "imp", 2)
    private inst_0xd8() {
        this.pCLR(this.DECIMAL);
    }

    @instruction("CMP", "aby", 4, 1)
    private inst_0xd9() {
        this.opCMP(this.AbsoluteYAddr, this.a, this.MS);
        this.incPC(2);
    }

    @instruction("PHX", "stk", 3)
    private inst_0xda() {
        if((this.p & this.IRS) || this.mode) {
            this.stPush(this.x);
        }
        else {
            this.stPushWord(this.x);
        }
    }

    @instruction("STP", "imp", 3) // new to 65816
    private inst_0xdb() {
        // *** TODO: need to implement stop the processor ***
        // *** and wait for reset pin to be pulled low    ***
        // *** for now just wait ***
        this.waiting = true;
    }

    @instruction("JML", "ail", 6)  // new to 65816
    private inst_0xdc() {
        var pbr;
        const operand = this.OperandWord();

        // operand indirection wraps at bank 0 boundary
        if(operand == 0xffff) {
            pbr = this.ByteAt(0x0001);
            this.pc = (this.ByteAt(0x0000) << this.BYTE_WIDTH) + this.ByteAt(operand);
        }
        else if(operand == 0xfffe) {
            pbr = this.ByteAt(0x0000);
            this.pc = this.WordAt(operand);
        }
        else {
            pbr = this.ByteAt(operand + 2);
            this.pc = this.WordAt(operand);
        }

        this.pbr = pbr;
    }

    @instruction("CMP", "abx", 4, 1)
    private inst_0xdd() {
        this.opCMP(this.AbsoluteXAddr, this.a, this.MS);
        this.incPC(2);
    }

    @instruction("DEC", "abx", 7)
    private inst_0xde() {
        this.opDECR(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("CMP", "alx", 5) // new to 65816
    private inst_0xdf() {
        this.opCMP(this.AbsoluteLongXAddr, this.a, this.MS);
        this.incPC(3);
    }

    @instruction("CPX", "imm", 2)
    private inst_0xe0() {
        this.opCMP(this.ImmediateAddr, this.x, this.IRS);
        this.incPC(2 - (((this.p & this.IRS) >> 4) || this.mode));
    }

    @instruction("SBC", "dix", 6)
    private inst_0xe1() {
        this.opSBC(this.DirectPageIndirectXAddr);
        this.incPC();
    }

    @instruction("SEP", "imm", 3) // new to 65816
    private inst_0xe2() {
        const operand = this.OperandByte();
        let mask = this.CARRY;
        while(mask) {
            // can't change BREAK or UNUSED flags in emulation mode
            if ((mask & operand) && !(this.mode && ((mask & this.BREAK) || (mask & this.UNUSED)))) {
                if((mask == this.MS) && this.isCLR(this.MS)) {
                    // A 16 => 8, save B, mask A high byte
                    this.b = (this.a >> this.BYTE_WIDTH) & this.byteMask;
                    this.a = this.a & this.byteMask;
                }
                else if((mask == this.IRS) && this.isCLR(this.IRS)) {
                    // X,Y 16 => 8, set high byte to zero
                    this.x = this.x & this.byteMask;
                    this.y = this.y & this.byteMask;
                }
                this.pSET(mask);
            }
            mask = (mask << 1) & this.byteMask;
        }
        this.incPC();
    }

    @instruction("SBC", "str", 4) // new to 65816
    private inst_0xe3() {
        this.opSBC(this.StackRelAddr);
        this.incPC();
    }

    @instruction("CPX", "dpg", 3)
    private inst_0xe4() {
        this.opCMP(this.DirectPageAddr, this.x, this.IRS);
        this.incPC();
    }

    @instruction("SBC", "dpg", 3)
    private inst_0xe5() {
        this.opSBC(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("INC", "dpg", 5)
    private inst_0xe6() {
        this.opINCR(this.DirectPageAddr);
        this.incPC();
    }

    @instruction("SBC", "dil", 6) // new to 65816
    private inst_0xe7() {
        this.opSBC(this.DirectPageIndirectLongAddr);
        this.incPC();
    }

    @instruction("INX", "imp", 2)
    private inst_0xe8() {
        this.x += 1;
        if((this.p & this.IRS) || this.mode) {
            this.x &= this.byteMask;
            this.FlagsNZ(this.x);
        }
        else {
            this.x &= this.addrMask;
            this.FlagsNZWord(this.x);
        }
    }

    @instruction("SBC", "imm", 2)
    private inst_0xe9() {
        this.opSBC(this.ImmediateAddr);
        this.incPC(2 - ((this.p & this.MS) >> 5));
    }

    @instruction("NOP", "imp", 2)
    private inst_0xea() {
        //pass
    }

    @instruction("XBA", "imp", 3) // new to 65816
    private inst_0xeb() {
        var b;
        const a = this.a & this.byteMask;

        if(this.p & this.MS) { // 8 bit
            this.a = this.b;
            this.b = b = a;
        }
        else { // 16 bits
            b = (this.a >> this.BYTE_WIDTH) & this.byteMask;
            this.a = (a << this.BYTE_WIDTH) + b;
        }

        // *** I don't think B is relevant w/ 16-bit A so I don't
        // maintain a hidden B in this mode ***

        this.FlagsNZ(b);
    }

    @instruction("CPX", "abs", 4)
    private inst_0xec() {
        this.opCMP(this.AbsoluteAddr, this.x, this.IRS);
        this.incPC(2);
    }

    @instruction("SBC", "abs", 4)
    private inst_0xed() {
        this.opSBC(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("INC", "abs", 6)
    private inst_0xee() {
        this.opINCR(this.AbsoluteAddr);
        this.incPC(2);
    }

    @instruction("SBC", "abl", 5) // new to 65816
    private inst_0xef() {
        this.opSBC(this.AbsoluteLongAddr);
        this.incPC(3);
    }

    @instruction("BEQ", "pcr", 2, 2)
    private inst_0xf0() {
        this.bSET(this.ZERO);
    }

    @instruction("SBC", "diy", 5, 1)
    private inst_0xf1() {
        this.opSBC(this.DirectPageIndirectYAddr);
        this.incPC();
    }

    @instruction("SBC", "dpi", 5)
    private inst_0xf2() {
        this.opSBC(this.DirectPageIndirectAddr);
        this.incPC();
    }

    @instruction("SBC", "siy", 7) // new to 65816
    private inst_0xf3() {
        this.opSBC(this.StackRelIndirectYAddr);
        this.incPC();
    }

    @instruction("PEA", "ska", 5) // new to 65816
    private inst_0xf4() {
        this.stPushWord(this.OperandWord());
        this.incPC(2);
    }

    @instruction("SBC", "dpx", 4)
    private inst_0xf5() {
        this.opSBC(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("INC", "dpx", 6)
    private inst_0xf6() {
        this.opINCR(this.DirectPageXAddr);
        this.incPC();
    }

    @instruction("SBC", "dly", 6) // new to 65816
    private inst_0xf7() {
        this.opSBC(this.DirectPageIndirectLongYAddr);
        this.incPC();
    }

    @instruction("SED", "imp", 2)
    private inst_0xf8() {
        this.pSET(this.DECIMAL);
    }

    @instruction("SBC", "aby", 4, 1)
    private inst_0xf9() {
        this.opSBC(this.AbsoluteYAddr);
        this.incPC(2);
    }

    @instruction("PLX", "stk", 4)
    private inst_0xfa() {
        if((this.p & this.IRS) || this.mode) {
            this.x = this.stPop();
            this.FlagsNZ(this.x);
        }
        else {
            this.x = this.stPopWord();
            this.FlagsNZWord(this.x);
        }
    }

    @instruction("XCE", "imp", 2) // new to 65816
    private inst_0xfb() {
        // 65816 Programming Manual, pg 423, describes these action as
        // only happening when actually switching modes.
        // I verified on the W65C265SXB that the registers, M and X don't
        // change if XCE is executed called in native mode with carry cleared
        // (native => native).  I couldn't test emulation => emulation
        // becuase the W65C265SXB monitor doesn't seem to work in emulation mode.
        // *** TODO: verify emulation => emulation transfer on 65816 ***
        if(this.mode && this.isCLR(this.CARRY)) { // emul => native
            this.pSET(this.MS);
            this.pSET(this.IRS);
            this.pSET(this.CARRY);
            this.mode = 0;
            this.sp = 0x100 + this.sp;
        }
        else if(!this.mode && this.isSET(this.CARRY)) { // native => emul
            this.pSET(this.BREAK);
            this.pSET(this.UNUSED);
            this.pCLR(this.CARRY);
            this.b = (this.a >> this.BYTE_WIDTH) & this.byteMask;
            this.a = this.a & this.byteMask;
            this.x = this.x & this.byteMask;
            this.y = this.y & this.byteMask;
            this.sp = (this.sp & this.byteMask);
            this.mode = 1;
        }
    }

    @instruction("JSR", "aix", 8) // new to 65816
    private inst_0xfc() {
        this.stPushWord((this.pc + 1) & this.addrMask);
        this.pc = this.AbsoluteIndirectXAddr();
    }

    @instruction("SBC", "abx", 4, 1)
    private inst_0xfd() {
        this.opSBC(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("INC", "abx", 7)
    private inst_0xfe() {
        this.opINCR(this.AbsoluteXAddr);
        this.incPC(2);
    }

    @instruction("SBC", "alx", 5) // new to 65816
    private inst_0xff() {
        this.opSBC(this.AbsoluteLongXAddr);
        this.incPC(3);
    }
}
