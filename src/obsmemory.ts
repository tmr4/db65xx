
export class ObsMemory {
    public memory: Uint8Array;
    public obsMemory: Uint8Array;

    // callback maps
    // These need to be static since there is no way to
    // pass an instance to the get/set methods
    // *** TODO: verify this ***
    static writeCallbacks = new Map<string | symbol, (number) => void>();
    static readCallbacks = new Map<string | symbol, (number) => number>();

    public constructor(bytes: Uint8Array) {
//        this.memory = new Uint8Array(bytes);
        // alocate 4 banks of memory
        // need to copy bytes over, if we don't memory doesn't expand as we access it
        // as it does in Python (? is this true?)
        // *** TODO: look for a more efficient way to do this ***
        this.memory = new Uint8Array(0x40000);
        for(let i = 0; i < 0x40000; i++) {
            if(bytes[i]  !== undefined) {
                this.memory[i] = bytes[i];
            }
            else {
                this.memory[i] = 0;
            }
        }
        this.obsMemory = new Proxy(this.memory, {
            set: function(target: Uint8Array, property: string | symbol, value: any, receiver: any): boolean {
                if(ObsMemory.writeCallbacks.has(property)) {
                    const callback = ObsMemory.writeCallbacks.get(property);
                    if(callback !== undefined) {
                        callback(value);
                    }
                }
                else {
                    target[property] = value;
                }
                return true;
            },
            get: function(target: Uint8Array, property: string | symbol, receiver: any): any {
                if(ObsMemory.readCallbacks.has(property)) {
                    const callback = ObsMemory.readCallbacks.get(property);
                    if(callback !== undefined) {
                        return callback(property);
                    }
                }
                return target[property];
            }
        });
    }

    public subscribeToWrite(address: number, callback: (number) => void) {
        ObsMemory.writeCallbacks.set(address.toString(), callback);
    }
    public subscribeToRead(address: number, callback: (number) => number) {
        ObsMemory.readCallbacks.set(address.toString(), callback);
    }
}







// from py65
//from collections import defaultdict
//
//
//class ObservableMemory:
//    def __init__(self, subject=None, addrWidth=16):
//        self.physMask = 0xffff
//        if addrWidth > 16:
//            # even with 32-bit address space, model only 256k memory
//            self.physMask = 0x3ffff
//
//        if subject is None:
//            subject = (self.physMask + 1) * [0x00]
//        self._subject = subject
//
//        self._read_subscribers = defaultdict(list)
//        self._write_subscribers = defaultdict(list)
//
//    def __setitem__(self, address, value):
//        if isinstance(address, slice):
//            r = range(*address.indices(self.physMask + 1))
//            for n, v in zip(r, value):
//                self[n] = v
//            return
//
//        address &= self.physMask
//        callbacks = self._write_subscribers[address]
//
//        for callback in callbacks:
//            result = callback(address, value)
//            if result is not None:
//                value = result
//
//        self._subject[address] = value
//
//    def __getitem__(self, address):
//        if isinstance(address, slice):
//            r = range(*address.indices(self.physMask + 1))
//            return [ self[n] for n in r ]
//
//        address &= self.physMask
//        callbacks = self._read_subscribers[address]
//        final_result = None
//
//        for callback in callbacks:
//            result = callback(address)
//            if result is not None:
//                final_result = result
//
//        if final_result is None:
//            return self._subject[address]
//        else:
//            return final_result
//
//    def __getattr__(self, attribute):
//        return getattr(self._subject, attribute)
//
//    def subscribe_to_write(self, address_range, callback):
//        for address in address_range:
//            address &= self.physMask
//            callbacks = self._write_subscribers.setdefault(address, [])
//            if callback not in callbacks:
//                callbacks.append(callback)
//
//    def subscribe_to_read(self, address_range, callback):
//        for address in address_range:
//            address &= self.physMask
//            callbacks = self._read_subscribers.setdefault(address, [])
//            if callback not in callbacks:
//                callbacks.append(callback)
//
//    def write(self, start_address, bytes):
//        start_address &= self.physMask
//        self._subject[start_address:start_address + len(bytes)] = bytes
//
//from collections import defaultdict


//class ObservableMemory {
//    physMask: number;
//    _subject: [] | null;
//    _read_subscribers: any;
//    _write_subscribers: any;
//
//    public constructor(subject=null, addrWidth=16) {
//        this.physMask = 0xffff
//        if(addrWidth > 16) {
//            // even with 32-bit address space, model only 256k memory
//            this.physMask = 0x3ffff
//        }
//        if(subject === null) {
//            this._subject = [];
//        }
//        this._subject = subject
//
//        this._read_subscribers = []
//        this._write_subscribers = []
//    }
//
//    private __setitem__(address, value) {
//        if(isinstance(address, slice)) {
//            let r = range(*address.indices(this.physMask + 1))
//            for(n, v in zip(r, value)) {
//                this[n] = v
//            }
//            return
//        }
//
//        address &= this.physMask
//        callbacks = this._write_subscribers[address]
//
//        for(callback in callbacks) {
//            let result = callback(address, value)
//            if(result !== null) {
//                value = result
//            }
//        }
//
//        this._subject[address] = value
//    }
//
//    private __getitem__(address) {
//        if(isinstance(address, slice)) {
//            r = range(*address.indices(this.physMask + 1))
//            return [ self[n] for n in r ]
//        }
//
//        address &= this.physMask
//        callbacks = this._read_subscribers[address]
//        final_result = null
//
//        for(callback in callbacks) {
//            let result = callback(address)
//            if(result !== null) {
//                final_result = result
//            }
//        }
//
//        if(final_result === null) {
//            return this._subject[address]
//        }
//        else {
//            return final_result
//        }
//    }
//
//    private __getattr__(attribute) {
//        return getattr(this._subject, attribute)
//    }
//
//    public subscribe_to_write(address_range, callback) {
//        for(address in address_range) {
//            address &= this.physMask
//            callbacks = this._write_subscribers.setdefault(address, [])
//            if(callback not in callbacks) {
//                callbacks.append(callback)
//            }
//        }
//    }
//
//    public subscribe_to_read(address_range, callback) {
//        for(address in address_range) {
//            address &= this.physMask
//            callbacks = this._read_subscribers.setdefault(address, [])
//            if(callback not in callbacks) {
//                callbacks.append(callback)
//            }
//        }
//    }
//
//    private write(start_address, bytes) {
//        start_address &= this.physMask
//        this._subject[start_address {start_address + len(bytes)] = bytes
//    }
//}


// Argument of type
//'{ set: (target: Uint8Array, property: string | symbol, value: any, receiver: any) => boolean; }'
// is not assignable to parameter of type
//'(target: Uint8Array, property: string | symbol, value: any, receiver: any) => boolean'
//Type
//'{ set: (target: Uint8Array, property: string | symbol, value: any, receiver: any) => boolean; }'
// provides no match for the signature
//'(target: Uint8Array, property: string | symbol, value: any, receiver: any): boolean'.
