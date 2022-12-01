/* eslint-disable eqeqeq */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import { TextEncoder } from 'node:util';

import { MPU65XX } from './mpu65xx';
import { MPU6502 } from './mpu6502';
import { MPU65C02 } from './mpu65c02';
import { MPU65816 } from './mpu65816';
import { ObsMemory } from './obsmemory';
import { Interrupts } from './interrupts';
import { terminalStart, terminalDispose, getcWaiting, putc, getc } from './terminal';
import { Debug65xxSession } from './da65xx';

// *******************************************************************************************
// 65xx Execution Engine

// EE65xx is a 65xx execution engine with debugging support.
// it "executes" a 65xx binary and sends events to the debug adapter informing it
// of key debugging events.  The debug adapter "follows along" with a CA65 listing
// file (*.lst), simulating "running" through the source code line-by-line.  EE65xx
// exposes several methods allowing the debug adapter to control the simulation.
// EE65xx supports typical stepping and breakpoint functionality as the core of the
// "debugging support".
// EE65xx is completely independent from VS Code and the
// Debug Adapter and can be run as a standalone simulator without debugging.
export class EE65xx extends EventEmitter {

    private continueID!: NodeJS.Timeout;
    private isBreak: boolean = false;
    private isDebug!: boolean;
    private da65xx: Debug65xxSession;

    private dbInt!: Interrupts;
    //aciaAddr!: number;
    //viaAddr!: number;

    public mpu!: MPU65XX; //MPU6502 | MPU65C02 | MPU65816;

    //private getcAddr: number;
    //private putcAddr: number;
    public obsMemory!: ObsMemory;

    public constructor(da65xx: Debug65xxSession) {
        super();

        //this.getcAddr = getcAddr;
        //this.putcAddr = putcAddr;
        this.da65xx = da65xx;
    }


    // *******************************************************************************************
    // public program control methods

    // Start executing the given program
    public start(cpu: string = '65816', bsource: string = '', fsource: string = '', aciaAddr: number | undefined, viaAddr: number | undefined, stopOnEntry: boolean = true, debug: boolean = true, input?: number, output?: number): void {

        terminalStart('65xx Debug', viaAddr ? true : false); // start debug terminal if not already started
        this.isDebug = debug;

        this.loadBinary(bsource, cpu);

        switch(cpu) {
            case '6502':
                this.mpu = new MPU6502(this, this.obsMemory.obsMemory);
                break;
            case '65C02':
                this.mpu = new MPU65C02(this, this.obsMemory.obsMemory);
                break;
            case '65816':
            default:
                this.mpu = new MPU65816(this, this.obsMemory.obsMemory);
                break;
        }

        this.mpu.reset();

        if (viaAddr) {
            //this.viaAddr = viaAddr;
            if (!this.dbInt) {
                this.dbInt = new Interrupts(this, this.mpu);
            }
            this.dbInt.addVIA(viaAddr, this.obsMemory);
        } else if (input !== undefined) {
            this.obsMemory.subscribeToRead(input, getc);
        } else {
            this.obsMemory.subscribeToRead(0xf004, getc);
        }

        if (aciaAddr) {
            //this.aciaAddr = aciaAddr;
            if (!this.dbInt) {
                this.dbInt = new Interrupts(this, this.mpu);
            }
            this.dbInt.addACIA(aciaAddr, fsource, this.obsMemory);
        } else if (output !== undefined) {
            this.obsMemory.subscribeToWrite(output, putc);
        } else {
            this.obsMemory.subscribeToWrite(0xf001, putc);
        }

        // *** TODO: continue doesn't make any sense here we need something similar to loop in childp ***
        if (debug) {
            if (!stopOnEntry) {
                this.continue();
            }
            else {
                this.sendEvent('stopOnEntry');
            }
        } else {
            this.continue();
        }
    }

    // inform da65xx of user or other exit request
    public exit(code: number) {
        this.sendEvent('exitRequest', code);
    }

    // stop run loop and dispose of integrated VS Code terminal
    public terminate() {
        this.pause('stopOnTerminate');
        terminalDispose();
    }

    // Continue execution to address or until we hit a breakpoint
    public stepTo(address: number, event: string = 'stopOnStep') {

        // take a single step to get over a breakpoint
        this.step(false);

        while (address !== (this.mpu.pc + (this.mpu.pbr << 16))) {
            if (this.da65xx?.checkBP()) {
                return;
            }
            this.step(false);
        }
        this.sendEvent(event);
    }

    // Execute the current line.
    // Returns true if execution sent out a stopped event and needs to stop.
    public step(stopOnStep: boolean): boolean {
        //let mpu = this.mpu;

        if (this.dbInt && this.dbInt.enabled) {
            this.dbInt.trip();
        }
        this.mpu.step();

        if (stopOnStep) {
            this.sendEvent('stopOnStep');
        }

        // continue
        return false;
    }

    // stop current and future run loops
    public pause(msg: string) {
        clearInterval(this.continueID);
        this.isBreak = true;     // force step loop to exit
        this.sendEvent(msg);
        //this.isBreak = false;
    }

    // continue execution of source code
    public continue() {
        // run at 10 ms intervals to avoid blocking
        this.continueID = setInterval(() => { this.run(); }, 10);
    }


    // *******************************************************************************************
    // private helper methods

    // load binary and initialize memory as observable
    private loadBinary(file: string, cpu: string): void {
        this.obsMemory = new ObsMemory(fs.readFileSync(file), cpu);
    }

    // run source code for a given number of steps
    private run() {
        // are we waiting for input?
        let waiting = this.mpu.waiting || getcWaiting();
        let count = 0;

        // Take 100000 steps every interval except when we're waiting for input.
        // Reduce steps when we're waiting for input to avoid CPU churn.
        // In sFroth, we're in the next_keyboard_buffer_char loop (about 16 steps)
        // when we're waiting for input.  Similarly, in hello_world, we're in the
        // get char loop (similar in length).
        // These values seem to give good performance/idle cpu.
        let steps = waiting ? 20 : 100000;

        // take a single step to get over a breakpoint
        this.step(false);

        while (count++ < steps && !this.isBreak) {
            if (this.isDebug && this.da65xx?.checkBP()) {
                clearInterval(this.continueID);
                this.isBreak = true;     // force step loop to exit
                break;
            } else if (waiting && (steps === 100000)) {
                // reduce steps if we've shifted to waiting during run loop
                // this should further reduce churn but at the cost of responsiveness
                // *** TODO: evaluate and tune these if necessary ***
                steps = 1000; // 20 causes long startup
            }
            this.step(false);
            waiting = this.mpu.waiting || getcWaiting();
        }
        count = 0;
        this.isBreak = false;
    }

    private sendEvent(event: string, ...args: any[]): void {
        setTimeout(() => {
            this.emit(event, ...args);
        }, 0);
    }
}
