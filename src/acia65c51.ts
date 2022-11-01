/* eslint-disable @typescript-eslint/naming-convention */
import { MPU65816 } from './mpu65816';
import { ObsMemory } from './obsmemory';
import { Interrupts } from './interrupts';
//import { debugSet, send } from './childp';
import * as fs from 'fs';
import { terminalWrite } from './terminal';

export class ACIA {
    // acia status register flags
    INTERRUPT = 128; // interrupt has occured, read status register to clear
    DSREADY = 64;
    DCDETECT = 32;
    TDREMPTY = 16;
    RDRFULL = 8; // receiver data register full
    OVERRUN = 4;
    FRAMING = 2;
    PARITY = 1;

    name: string;
    mpu: MPU65816;
    int: Interrupts;
    RDATAR: number;
    TDATAR: number;
    STATUSR: number;
    COMDR: number;
    escape: boolean;
    block: boolean;
    bbuffer: Uint8Array;
    blockFile: Uint8Array;
    bcount: number;
    block_file: string;
    status_reg: number;
    control_reg: number;
    command_reg: number;
    enabled: boolean;
    oldenabled: boolean;
//    static terminal: Terminal;

//    public constructor(start_addr: number, filename: string, mpu: MPU65816, interrupt: Interrupts, obsMemory: ObsMemory, terminal: Terminal) {
    public constructor(start_addr: number, filename: string, mpu: MPU65816, interrupt: Interrupts, obsMemory: ObsMemory) {
        this.name = 'ACIA';
         this.mpu = mpu;
        this.int = interrupt;
        this.RDATAR = start_addr;
        this.TDATAR = start_addr;
        this.STATUSR = start_addr + 1;
        this.COMDR = start_addr + 2;
        this.escape = false;
        this.block = false;
        this.bbuffer = new Uint8Array;
        this.blockFile = new Uint8Array;
        this.bcount = 1024;
        this.block_file = filename;
        this.status_reg = 0;
        this.control_reg = 0;
        this.command_reg = 0;
        this.enabled = false;
        this.oldenabled = false;
//        ACIA.terminal = terminal;

        // init
        this.reset();

        this.install_interrupts(obsMemory);

        this.loadBlockFile(filename);
    }

    private install_interrupts(obsMemory: ObsMemory) {
        obsMemory.subscribeToWrite(this.TDATAR, (value: number): void => {
            if (this.escape) {
                if (value === 0x42) {
                    // signal block load if block file is available
                    if (this.block_file !== null) {
                        this.block = true;
                    }
                }
                else if (this.block) {
                    // load the block indicated by value
                    this.bbuffer = this.blockFile.subarray(value * 1024, value * 1024 + 1024);
                    this.dataT_enable();

                    this.block = false;
                    this.escape = false;
                }
                else {
                    terminalWrite(String.fromCharCode(0x1b) + String.fromCharCode(value));
                    this.escape = false;
                }
            }
            else {
                if (value === 0x1b) {
                    // signal that we're in an escape sequence
                    this.escape = true;
                }
                else {
                    //            if (debugSet()) {
                    if (true) {
                        terminalWrite(String.fromCharCode(value));
                    }
                    else {
                        if (value === 0xd) {     // is CR
                            process.stdout.write('\r\n');
                        }
                        else {
                            process.stdout.write(String.fromCharCode(value));
                        }
                    }
                }
            }
        });

        obsMemory.subscribeToRead(this.RDATAR, (address: number): number => {
            if (this.bcount >= 1024) {
                return 0;
            }
            else {
                const byte = this.bbuffer[this.bcount];
                this.bcount += 1;
                this.status_reg &= 0x77; // clear Receiver Data Register Full flag (bit 3) status register
                return byte;
            }
        });

        obsMemory.subscribeToWrite(this.STATUSR, (value: number): void => {
            this.reset();
        });
        obsMemory.subscribeToRead(this.STATUSR, (address: number): number => {
            const tmp = this.status_reg;
            this.status_reg &= 0x7f; // clear interrupt flag (bit 7) in status register
            return tmp;
        });
    }

    private reset() {
        this.status_reg = 0;
        this.control_reg = 0;
        // this.command_reg = 0
    }

    public dataT_thread() {
        const mpu =  this.mpu;
        if(this.bcount < 1024) {
            if((mpu.IRQ_pin === true) && ((mpu.p & mpu.INTERRUPT) === 0)) {
                mpu.IRQ_pin = false;
                this.status_reg |= 0x88; // set Receiver Data Register Full flag (bit 3) status register
            }
        }
        else {
            this.enabled = false;
             this.int.enabled = this.oldenabled;
        }
    }

    public dataT_enable() {
        this.enabled = true;
        this.oldenabled =  this.int.enabled;
        this.int.enabled = true;
        this.bcount = 0;
    }

    // load block file
    private loadBlockFile(file: string): void {
        this.blockFile = new Uint8Array(fs.readFileSync(file));
    }
}
