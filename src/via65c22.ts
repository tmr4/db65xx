/* eslint-disable @typescript-eslint/naming-convention */

import { MPU65816 } from './mpu65816';
import { Interrupts } from './interrupts';
import { ObsMemory } from './obsmemory';
import { TextEncoder, TextDecoder } from 'node:util';

var kbhit: boolean = false;
var lastChar: string = '';
var bufIndex: number = 0;
function getLastChar(): string {
    if (kbhit) {
        if (lastChar.length > 1) {
            // pasted input or fast typer
            // send out buffer one character at a time
            if (bufIndex < lastChar.length - 1) {
                return lastChar[bufIndex++];
            }
            else {
                // last character, reset everything and
                // send last character
                bufIndex = 0;
                kbhit = false;
                return lastChar[lastChar.length - 1];
            }
        }
        else {
            kbhit = false;
            return lastChar;
        }
    }
    return '';
}
export function setLastChar(char: string) {
    // convert unicode to ascii
    switch (char) {
        case '\x7f':     // unicode backspace
            char = new TextDecoder().decode(Buffer.from('\x08'));
            break;
        case '\x1b':    // unicode escape
            char = new TextDecoder().decode(Buffer.from('\x1b'));
            break;
        default:
            break;
    }

    if (!kbhit) {
        lastChar = char;
        kbhit = true;
    }
}

export class VIA {
    static SR = 4;
    static SET_CLEAR = 128;
    mpu: MPU65816;
    int: Interrupts;
    VIA_SR: number;
    VIA_IFR: number;
    VIA_IER: number;
    escape: boolean;
    enabled: boolean;
    oldenabled: boolean;
    name: string;
//    static terminal: Terminal;

//    public constructor(start_addr: number, mpu: MPU65816, interrupt: Interrupts, obsMemory: ObsMemory, terminal: Terminal) {
    public constructor(start_addr: number, mpu: MPU65816, interrupt: Interrupts, obsMemory: ObsMemory) {
        this.mpu = mpu;
        this.int = interrupt;

        this.VIA_SR  = start_addr + 0x0a;   // shift register
        this.VIA_IFR = start_addr + 0x0d;   // interrupt flags register
        this.VIA_IER = start_addr + 0x0e;   // interrupt enable register
        this.escape = false;

        this.enabled = false;
        this.oldenabled = false;
//        VIA.terminal = terminal;

        this.name = 'VIA';

        // init
        this.reset();

        this.install_interrupts(obsMemory);
    }

    private install_interrupts(obsMemory: ObsMemory) {
        obsMemory.subscribeToWrite(this.VIA_IER, (value: number): void => {
            var timeoutId: string | number | NodeJS.Timeout | undefined = -1;
            var buf: string = '';

            if (value & VIA.SET_CLEAR) {
                // enable interrupts
                if (value & VIA.SR) {
                    this.enabled = true;
                    this.oldenabled = this.int.enabled;
                    this.int.enabled = true;

                    //            if (!debugSet()) {
                    if (false) {
                        const self = this;
                        const readline = require('readline');
                        readline.emitKeypressEvents(process.stdin);
                        process.stdin.setRawMode(true);
                        process.stdin.resume();
                        process.stdin.on('keypress', function (chunk, key) {
                            if (key.name === 'escape') {
                                // handle escape key
                                self.escape = true;
                            }
                            else if ((key.name === 'q') && key.meta) {
                                // if pressed quickly enough, we can get key.name = 'esc q' with key.meta set to true
                                // set escape and lastChar
                                self.escape = true;
                                setLastChar('q');
                            }
                            else {
                                // allow for pasted input by using a timeout on input
                                // if another key isn't detected within 3 ms then this
                                // will be sent on to VIA.lastChar, otherwise it will
                                // be accumulated in a buffer to be sent at the end of
                                // pasted stream

                                // add key to input buffer
                                buf += chunk;

                                // reset the timer for each new input received
                                if (timeoutId !== -1) {
                                    clearTimeout(timeoutId);
                                }

                                // send the input to a function after a certain amount of time has passed
                                // the delay can be adjusted to allow longer pasted input
                                // *** TODO: this isn't a universal solution as the pasted input is not
                                // buffered and thus the pasted input must be processed within the delay ***
                                timeoutId = setTimeout(() => {
                                    // handle input and clear buffer
                                    setLastChar(buf);
                                    buf = '';
                                }, 15); // adjust delay as needed to process pasted input, this also depends on the step interval in childp.ts
                            }
                        });
                    }
                }
            }
            else {
                // disable interrupts
                this.enabled = false;
                this.int.enabled = this.oldenabled;
            }
        });

        obsMemory.subscribeToRead(this.VIA_SR, (address: number): number => {
            var byte: number = 0;
            const char: string = getLastChar();
            if (char !== '') {
                const utf8Encode = new TextEncoder();
                byte = utf8Encode.encode(char)[0];
                if (this.escape) {
                    this.escape = false;
                    if ((byte === 0x51) || (byte === 0x71)) {
                        this.int.end();
                    }
                }
                else {
                    if (byte === 0x1b) {
                        this.escape = true;
                        byte = 0;
                    }
                    else {
                        this.mpu.memory[this.VIA_IFR] &= 0xfb;
                    }
                }
            }

            return byte;
        });
    }

    private reset() {
        this.mpu.memory[this.VIA_IER] = 0;
        this.mpu.memory[this.VIA_IFR] = 0;
    }

    //def irq() {
        //return (IFR6 and IER6) or (IFR5 and IER5) or (IFR4 and IER4) or (IFR3 and IER3) or (IFR2 and IER2) or (IFR1 and IER1) or (IFR0 and IER0)
        //return (this.mpu.memory[this.VIA_IFR] and this.SR) and ((this.mpu.memory[this.VIA_IER] and this.SR))
    //}

    public SR_thread() {
        const mpu = this.mpu;
        if((mpu.IRQ_pin === true) && ((mpu.p & mpu.INTERRUPT) === 0)) {
            if (kbhit) {
//            if (false) {
                mpu.memory[this.VIA_IFR] |= 0x04;
                mpu.IRQ_pin = false;
            }
        }
    }
}
