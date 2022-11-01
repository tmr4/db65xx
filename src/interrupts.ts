import { VIA } from './via65c22';
import { ACIA } from './acia65c51';
import { MPU65816 } from './mpu65816';
import { ObsMemory } from './obsmemory';
import { EE65xx } from './ee65xx';

export class Interrupts {
    ee65xx: EE65xx;
    mpu: MPU65816;
    via: VIA | null;
    acia: ACIA | null;
    enabled: boolean;

//    private terminal: Terminal;

    public constructor(ee65xx: EE65xx, mpu: MPU65816) {
        this.ee65xx = ee65xx;
        this.mpu = mpu;
        this.via = null;
        this.acia = null;
        this.enabled = false;
    }

    public end() {
        this.ee65xx.end();
    }

    public addVIA(addr: number, obsMemory: ObsMemory) {
//        this.via = new VIA(addr, this.mpu, this, obsMemory, this.terminal);
        this.via = new VIA(addr, this.mpu, this, obsMemory);
    }

    public addACIA(addr: number, filename: string, obsMemory: ObsMemory) {
//        this.acia = new ACIA(addr, filename, this.mpu, this, obsMemory, this.terminal);
        this.acia = new ACIA(addr, filename, this.mpu, this, obsMemory);
    }

    // poll devices and trip an interrupt if appropriate
    public trip() {
        // Must have sufficient delay to allow interrupts and input
        // to be processed.  Threading and cycle counts proved
        // ineffective for this.  Threading took about 2.5 minutes
        // to start up and had very slow pasted input because threads
        // don't run concurrently in CPython and yielding with sleep
        // wasn't fine tuned enough.  Cycle counts worked well for
        // startup but not for pastes as the time to processing input
        // is variable and the circular input buffer is easily overflown.
        // Using the processor wait state is a good trade off.  It
        // gives a reasonable pasted input experience and only slightly
        // delays startup.  Note using the waiting state as a delay isn't
        // the fasted method for responding to input (I believe it doesn't
        // take advantage of the internal buffers) but it is reasonably
        // efficient. Start up with a tuned cycle count delay was about
        // 12 seconds.  It's about 17 seconds using waiting.  The difference
        // is processing the WAI instructions which are forced with this method
        // but never needed using a cycle count delay because at startup
        // the input is already buffered (i.e, available without waiting).
        // Cycle count delays also affected each interrupt, that is, the
        // VIA delay would affect the ACIA delay, even though keyboard
        // input isn't expected during start up.
        if(this.mpu.waiting) {

            if ((this.acia !== null) && this.acia.enabled) {
                this.acia.dataT_thread();
            }

            if((this.via !== null) && this.via.enabled) {
                if ((this.acia !== null) && !this.acia.enabled) {
                    this.via.SR_thread();
                }
            }
        }
    }
}
