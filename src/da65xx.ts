/* eslint-disable @typescript-eslint/naming-convention */

// da65xx.ts implements Microsoft's Debug Adapter Protocol (DAP) to interface
// between the VS Code debugging UI and the EE65xx execution engine.

import {
    Logger, logger,
    LoggingDebugSession, Event, ContinuedEvent,
    InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
    InvalidatedEvent,
    Thread, StackFrame, Scope, Source, Handles, Breakpoint, MemoryEvent, ThreadEvent, Variable
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { basename } from 'path-browserify';
import { Subject } from 'await-notify';
import * as base64 from 'base64-js';
import * as fs from 'fs';
import { TextEncoder, TextDecoder } from 'node:util';
import * as path from 'path';

import { EE65xx } from './ee65xx';
import { Registers } from './registers';
import { SourceMap, ISourceMap } from './sourcemap';
import { toHexString } from './util';
import { MPU65816 } from './mpu65816';

interface IBreakpoint {
    id: number;
    line: number;
    address: number;
    verified: boolean;
    condition?: string;
    hitCondition?: string;
    logMessage?: string;
}

interface IRuntimeBreakpoint {
    address: number;
    hitCondition: string;
    hits: number;
}

interface IRuntimeStackFrame {
    index: number;
    name: string;
    file: string;
    line: number;
    column: number;
    instruction: number;
    nextaddress: number;
}

/**
 * This interface describes the db65xx specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the db65xx extension.
 * The interface should always match this schema.
 */
interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    /** An absolute path to the "program" to debug. */
    program: string;
    /** Automatically stop target after launch. If not specified, target does not stop. */
    stopOnEntry?: boolean;
    /** enable logging the Debug Adapter Protocol */
    trace?: boolean;
    /** run without debugging */
    noDebug?: boolean;
    /** if specified, results in a simulated compile error in launch. */
    compileError?: 'default' | 'show' | 'hide';
    /** An absolute path to the working directory. */
    cwd?: string;
    args?: {
        sbin: string,       // source binary
        src?: string,       // source code directory
        listing?: string,   // listing, map and symbol files directory
        acia?: string,      // address of ACIA (in hex)
        via?: string,       // address of VIA (in hex)
        fbin?: string       // Forth binary to load at startup
    }
}

interface IAttachRequestArguments extends ILaunchRequestArguments { }

interface IStack {
    start: () => number;
    length: () => number;
    name: string;
    value: () => string;
//    top: () => number;       // top of stack (will limit display)
    reference: string;
    memoryRef: any;
    size: number;
}

export class Debug65xxSession extends LoggingDebugSession {

    // the 65816 execution engine and the MPU's registers
    private ee65xx: EE65xx;
    private registers!: Registers;
    private sourceMap!: SourceMap;

    private _variableHandles = new Handles<any>();
    private scopes = new Map<string, number>;
    private stacks = new Map<string, IStack>();

    // we don't support multiple threads, so we can use a hardcoded ID for the default thread
    private static threadID = 1;

    private program!: string;
    private cwd!: string;
    private src!: string;   // source directory

    // source, data and function breakpoints
    private breakpoints = new Map<number, IBreakpoint[]>();
    private dataBreakpoints = new Map<string, string>();
    // *** TODO: could map function breakpoints by source but likely makes for cumbersome input. ***
//    private functionBreakpoints = new Map<string, IBreakpoint[]>();
    private functionBreakpoints = new Map<string, IBreakpoint>();
    private hitConditionBreakpoints = new Map<number, IRuntimeBreakpoint>();

    // since we want to send breakpoint events, we will assign an id to every event
    // so that the frontend can match events with breakpoints.
    private breakpointId = 1;

    // identify if we have an extended call stack
    // if so, callFrames will be added to stackFrames on stackTraceRequest
    private inCall: boolean = false;
    private callFrames: IRuntimeStackFrame[] = [];

    private _configurationDone = new Subject();

    private _valuesInHex = true;
    private _addressesInHex = true;

    private _useInvalidatedEvent = false;
    private _useMemoryEvent = false;

    private namedExceptions: string | undefined;
    private opcodeExceptions: string | undefined;

    // *******************************************************************************************

    public constructor() {
        super("db65xx.txt");

        // this debugger does not use zero-based lines and columns
        this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(true);

        // create 65816 execution engine
        this.ee65xx = new EE65xx(this);

        // setup event handlers
//        this.ee65xx.on('stopOnBreakpoint', () => {
//            this.sendEvent(new StoppedEvent('breakpoint', Debug65xxSession.threadID));
//        });
//        this.ee65xx.on('stopOnDataBreakpoint', () => {
//            this.sendEvent(new StoppedEvent('data breakpoint', Debug65xxSession.threadID));
//        });
//        this.ee65xx.on('breakpointValidated', (bp: IBreakpoint) => {
//            this.sendEvent(new BreakpointEvent('changed', { verified: bp.verified, id: bp.id } as DebugProtocol.Breakpoint));
//        });
//        this.ee65xx.on('stopOnException', (exception) => {
//            if (exception) {
//                this.sendEvent(new StoppedEvent(`exception(${exception})`, Debug65xxSession.threadID));
//            } else {
//                this.sendEvent(new StoppedEvent('exception', Debug65xxSession.threadID));
//            }
//        });
        this.ee65xx.on('stopOnEntry', () => {
            this.sendEvent(new StoppedEvent('entry', Debug65xxSession.threadID));
        });
        this.ee65xx.on('stopOnPause', () => {
            if (!this.ee65xx.mpu.waiting) {
                this.sendEvent(new StoppedEvent('pause', Debug65xxSession.threadID));
            }
            else {
                const se = new StoppedEvent('pause', Debug65xxSession.threadID);
                (se as DebugProtocol.StoppedEvent).body.description = 'Paused, waiting for input';
                this.sendEvent(se);
            }
        });
        this.ee65xx.on('stopOnStep', () => {
            this.sendEvent(new StoppedEvent('step', Debug65xxSession.threadID));
        });
        this.ee65xx.on('exited', () => {
            this.sendEvent(new TerminatedEvent());
        });
    }


    // *******************************************************************************************
    // protected DAP Requests

    // provide debug adapter capabilities to VS Code
    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

        if (args.supportsInvalidatedEvent) {
            this._useInvalidatedEvent = true;
        }

        // VS Code doesn't issue this capability, but it does support it
        if (args.supportsMemoryEvent) {
            this._useMemoryEvent = true;
        }

        // build and return the capabilities of this debug adapter:
        response.body = response.body || {};

        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsEvaluateForHovers = true;
        response.body.supportsDataBreakpoints = true;       // add data breakpoints via context menu on certain register variables
        response.body.supportsFunctionBreakpoints = true;   // add functional breakpoints in Breakpoints pane

        response.body.supportsSetVariable = true;       // VS Code adds Set Value to Variables view context menu
        response.body.supportsSetExpression = true;     // VS Code adds Set Value to Watchs view context menu (otherwise, if both of these are true it doesn't seem to do anything even if a Variable's evaluateName property is set)

        response.body.supportsReadMemoryRequest = true;     // view binary data in hex editor w/ memoryReference
        response.body.supportsWriteMemoryRequest = true;    // modify binary data in hex editor w/ memoryReference

        response.body.supportsLoadedSourcesRequest = true;  // adds the Loaded Scripts Explorer to debug pane (shows a list of modules ease of opening in editor without leaving debug view)
        response.body.supportSuspendDebuggee = true;        // via Pause Request
        response.body.supportTerminateDebuggee = true;

        // possible future capabilities
        // Instruction breakpoints (a breakpoint at a memory location)
        // are available through the disassembly view.  These breakpoints
        // could be useful for Forth code (disassembly of that should be
        // fairly formulaic).
//        response.body.supportsDisassembleRequest = true;    // add "Open Disassembly View to call stack and editor context menus.  Active if instructionPointerReference is defined."
//        response.body.supportsSteppingGranularity = true;   // seems to be set to instruction when in Disassembly View, unclear otherwise.  Can be used by step instructions to indicate you're in Disassembly View
//        response.body.supportsInstructionBreakpoints = true;  // available in Disassembly View

        // Note that condition, hitCondition and logMessage can all be set at once.
        // VS Code doesn't process or act on any of these other than passing them on to the debug adapter.
        // Note that these can be set in a source file before the debug adapter is started and can always
        // be set from the editor breakpoint context menu (which appears alway active regardless of these settings
        // unlike the Breakpoint pane edit icon (and context menu item) which is only active when supportsConditionalBreakpoints is true).
        response.body.supportsConditionalBreakpoints = true;  // enables Edit Condition in Breakpoint view (but it's appears to be always enabled in editor breakpoint context menu)
        response.body.supportsHitConditionalBreakpoints = true;  // if true sends hitCondition (if set) to setBreakPointsRequest, otherwise it isn't even if hitCondition is set
        response.body.supportsLogPoints = true;  // if true sends logMessage (if set) to setBreakPointsRequest, otherwise it isn't even if hitCondition is set (also sends hitCondition if set even if supportsHitConditionalBreakpoints is false)

        // step back is possible if we save state after each step, but this could bog down the execution engine
//        response.body.supportsStepBack = true;      // activates step back and reverse buttons (there are no corresponding Run menu items)

//        response.body.supportsValueFormattingOptions = true;  // *** TODO: test this *** not sure this does anything in VS Code

        // Exceptions aren't natural for a working 65xx program but could be configured for certain unused opcodes
        // (less useful for the 65816 but could be configured for certain opcodes)
        // these do nothing alone without their corresponding Request functions
        response.body.supportsExceptionFilterOptions = true;  // enables exception breakpoint filters
        response.body.exceptionBreakpointFilters = [    // adds these options to Breakpoint pane regardless if above are true
            {
                filter: 'namedExceptions',
                label: "Instructions",
                description: `Break on instruction mnemonic`,
                default: false,
                supportsCondition: true,
                conditionDescription: `Enter instruction mnemonics separated by a comma`
            },
            {
                filter: 'opcodeExceptions',
                label: "Opcodes",
                description: 'Break on opcode',
                default: false,
                supportsCondition: true,
                conditionDescription: `Enter opcodes separated by a comma`
            }
        ];

        //response.body.supportsExceptionInfoRequest = true;  // Retrieves the details of the exception that caused this event to be raised, not clear when this is used

        // see: https://microsoft.github.io/debug-adapter-protocol/specification#Types_ExceptionOptions for definition
        // see: https://code.visualstudio.com/updates/v1_11#_extension-authoring
        // and: https://github.com/microsoft/vscode-mono-debug/blob/main/src/typescript/extension.ts#L90
        // for example usage
        //response.body.supportsExceptionOptions = true;


        // for full list see: https://microsoft.github.io/debug-adapter-protocol/specification#Types_Capabilities
        // supportsModulesRequest seems like it could be useful but VS Code doesn't support it
        //response.body.supportsModulesRequest = true; // VS Code doesn't support

        // this activates the "Step Into Target" editor context menu item which then calls
        // stepInTargetsRequest to reveal a sub context menu with possible step in targets
        // on that line.  This seems of little utility for me.
        // Note that the Step In button and Run menu item are not affected by this
        //response.body.supportsStepInTargetsRequest = true;

        // make VS Code support completion in REPL
//        response.body.supportsCompletionsRequest = true; // in REPL (see mock-debug)
//        response.body.completionTriggerCharacters = [".", "["];
//        response.body.supportsBreakpointLocationsRequest = true;

        this.sendResponse(response);

        // This debug adapter can't accept configuration requests like 'setBreakpoint' yet,
        // Function breakpoints require a symbol map and in the future data breakpoints may
        // require a processor to be identified to determine valid register breakpoints.
        //this.sendEvent(new InitializedEvent());
    }

    // Called at the end of the configuration sequence.
    // Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
        super.configurationDoneRequest(response, args);

        // notify the launchRequest that configuration has finished
        this._configurationDone.notify();
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
        //console.log(`disconnectRequest suspend: ${args.suspendDebuggee}, terminate: ${args.terminateDebuggee}`);
        this.ee65xx.end();
    }

//    protected async attachRequest(response: DebugProtocol.AttachResponse, args: IAttachRequestArguments) {
//        return this.launchRequest(response, args);
//    }

    // Prepare source map, initialize 65816 execution engine and create variable pane view
    // this is the first request that includes information on the debugee and thus are able to load
    // the source files to enable us to validate breakpoints
    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {

        // stop the buffered logging if 'trace' is not set
        logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

        let sbin = '';
        let fbin = '';
        let acia: number | undefined;
        let via: number | undefined;
        let binBase = '';
        let list = '';
        let extension = '';

        this.program = args.program;
        if (args.cwd === undefined) {
            this.cwd = path.dirname(this.program);
        } else {
            this.cwd = args.cwd;
        }

        if (args.args) {
            const args0 = args.args[0];

            sbin = args0.sbin;
            fbin = args0.fbin;
            acia = parseInt(args0.acia);
            via = parseInt(args0.via);

            const extension = path.extname(args0.sbin);
            binBase = path.basename(args0.sbin, extension);

            if (args0.src) {
                this.src = args0.src;
            } else {
                this.src = this.cwd;
            }
            if (args0.list) {
                list = args0.list;
            } else {
                list = this.cwd;
            }
        } else {
            extension = path.extname(this.program);
            binBase = path.basename(this.program, extension);
            sbin = path.join(this.cwd, binBase + '.bin');
            this.src = this.cwd;
            list = this.cwd;
        }

        // prepare source map
        this.sourceMap = new SourceMap(this.src, list, binBase, extension);

        // start 65816 execution engine
        this.ee65xx.start(sbin, fbin, acia, via, !!args.stopOnEntry, !args.noDebug);
        const mpu = this.ee65xx.mpu;
        const memory = this.ee65xx.obsMemory.memory;

        // create MPU registers and flags breakdown
        this.registers = new Registers(mpu);

        // register the 65816 scopes
        this.registerScopes(mpu, memory, fbin);

        // VS Code will end the configuration sequence by calling 'configurationDone' request.
        this.sendEvent(new InitializedEvent());

        // wait 1 second until configuration has finished (and configurationDoneRequest has been called)
        // *** TODO: do we need more time if more breakpoints area added? ***
        await this._configurationDone.wait(1000);

        this.sendResponse(response);
    }

    // *** VS Code requires "setBreakPointsRequest" capitalization here ***
//    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
//    protected async setBreakpointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
        const actualBreakpoints: DebugProtocol.Breakpoint[] = [];
        const fileId = this.sourceMap.getSourceId(args.source.path as string);
        const breakpoints = args.breakpoints || [];

        // clear all breakpoints for this file
        this.clearBreakpoints(fileId);

        // set and verify source breakpoints
        for (const [i, bp] of breakpoints.entries()) {
            const { verified, line, id } = this.setBreakpoint(fileId, bp);
            const dbp = new Breakpoint(verified, this.convertDebuggerLineToClient(line)) as DebugProtocol.Breakpoint;
            dbp.id = id;
            actualBreakpoints.push(dbp);
        }

        // send back the actual breakpoint positions
        response.body = {
            breakpoints: actualBreakpoints
        };

        this.sendResponse(response);
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

        // execution engine doesn't support multiple threads so just return a dummy thread
        response.body = {
            threads: [
                new Thread(Debug65xxSession.threadID, "debug 65816")
            ]
        };
        this.sendResponse(response);
    }

    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
        // *** TODO: seems like we should be able to consolidate some of this ***
        const frames: IRuntimeStackFrame[] = [];
        const pos = this.sourceMap.get(this.registers.address);

        if (pos !== undefined) {
            const stackFrame: IRuntimeStackFrame = {
                index: 0,
                name: pos.instruction,
                file: this.sourceMap.getSourceFile(pos.fileId),
//                line: pos.line, // *** TODO: we should fix up line # when it's not in source map ***
                line: pos.sourceLine,
                column: 0,
                instruction: pos.address,
                nextaddress: 0
            };

            frames.push(stackFrame);
        }

        if (this.inCall) {
            this.callFrames.forEach(frame => { frames.push(frame); });
        }

        const stk = {
            frames: frames,
            count: this.inCall ? this.callFrames.length + 1 : 1
        };

        response.body = {
            stackFrames: stk.frames.map((f, ix) => {
                // fix up source file path
                const sf: DebugProtocol.StackFrame = new StackFrame(f.index, f.name, this.createSource(f.file), this.convertDebuggerLineToClient(f.line));
                sf.moduleId = f.file;
                sf.column = 0;
                if (typeof f.instruction === 'number') {
                    const address = this.formatAddress(f.instruction, 6);
                    sf.name = `${address} ${f.name}`;
                    sf.instructionPointerReference = address;
                }
                // sf.presentationHint = 'subtle'; // displayed in italic
                // sf.presentationHint = 'label'; // displayed in italic without line/column info

                return sf;
            }),
            // 4 options for 'totalFrames':
            //omit totalFrames property: 	// VS Code has to probe/guess. Should result in a max. of two requests
            totalFrames: stk.count			// stk.count is the correct size, should result in a max. of two requests
            //totalFrames: 1000000 			// not the correct size, should result in a max. of two requests
            //totalFrames: endFrame + 20 	// dynamically increases the size with every requested chunk, results in paging
        };
        this.sendResponse(response);
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

        response.body = {
            scopes: [
                new Scope("Registers", this.scopes.get('registers')!, false),
                new Scope("Stacks", this.scopes.get('stacks')!, false),
//                new Scope("Locals", this.scopes.get('locals')!, false),
//                new Scope("Globals", this.scopes.get('globals')!, true)
            ]
        };
        this.sendResponse(response);
    }

    // write data to memoryReference from hex editor window (writes on save)
    protected async writeMemoryRequest(response: DebugProtocol.WriteMemoryResponse, { data, memoryReference, offset = 0 }: DebugProtocol.WriteMemoryArguments) {
        const decoded = base64.toByteArray(data);
        const memory = this.ee65xx.obsMemory.memory;
        const address = parseInt(memoryReference, 16);
        const start = address + offset;
        //const end = start + decoded.length;

        if (decoded.length > 0) {
            for (let i = 0; i < decoded.length; i++) {
                memory[i + start] = decoded[i];
            }
            response.body = { bytesWritten: decoded.length };
        } else {
            response.body = { bytesWritten: 0 };
        }

        this.sendResponse(response);
        this.sendEvent(new InvalidatedEvent(['variables']));
    }

    // read memoryReference and present in a hex editor window
    protected async readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, { offset = 0, count, memoryReference }: DebugProtocol.ReadMemoryArguments) {
        const memory = this.ee65xx.obsMemory.memory;
//        const address = Math.trunc(parseInt(memoryReference, 16) / 16);
        const address = parseInt(memoryReference, 16);
        const start = Math.min(address + offset, memory.length);
        const end = Math.min(start + count, memory.length);

        if (count > 0 && memory) {
            response.body = {
                address: `0x${memoryReference}`,
                data: base64.fromByteArray(memory.slice(start, end)),
                unreadableBytes: count - memory.length
            };
        } else {
            response.body = {
                address: offset.toString(),
                data: '',
                unreadableBytes: count
            };
        }
        this.sendResponse(response);
    }

    // send Variable information to the UI
    protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {

        const variables: DebugProtocol.Variable[] = [];
        const ref = args.variablesReference;
        const scope = this._variableHandles.get(ref);

        if (scope === 'registers') {
            for (const reg of Object.entries(this.registers.registers)) {
                const name = reg[0];
                const value = reg[1];
                variables.push({
                    name: name,
                    value: name === 'P' ? (value as number).toString(2).padStart(8, '0') : this.formatNumber(value),
                    type: 'register',
                    evaluateName: name,
                    variablesReference: name === 'P' ? this.scopes.get('flags')! : 0
                });
            }
        } else if (scope === 'flags') {
            for (const reg of Object.entries(this.registers.p)) {
                const name = reg[0];
                const value = reg[1];
                variables.push({
                    name: name,
                    value: this.formatNumber(value),
                    type: 'integer',
                    variablesReference: 0
                });
            }
        } else if (scope?.includes('stack')) {
            if (scope === 'stacks') {
                // stacks summary
                this.stacks.forEach(stack => {
                    variables.push({
                        name: stack.name,
                        value: stack.value(),
                        type: 'stack',
                        variablesReference: this.scopes.get(stack.reference) ?? 0,
                        memoryReference: stack.start().toString(16)
                    });
                });
            } else {
                // specific stack summary
                const stack = this.stacks.get(scope);
                const start = stack!.start();
                const length = stack!.length();
                for (let i = 0; i < length; i += 16) {
                    variables.push({
                        name: (start + i).toString(16),
                        value: toHexString(stack!.memoryRef.slice(start + i, start + i + Math.min(length, 16)), stack!.size),
                        variablesReference: (start + i) * 16 + Math.min(length, 0xf),
                        memoryReference: (start + i).toString(16)
                    });
                }
            }
//        } else if (scope === 'locals') {
//            // *** TODO: consider adding ***
//            let lSymbol = this.getLocalSymbols();
//            lSymbol.forEach( ls => {
//                variables.push({
//                    name: ls.name,
//                    value: toHexString(this.ee65xx.obsMemory.memory[ls.address]),
//                    variablesReference: 0,
//                });
//            });
//        } else if (scope === 'globals') {
//            // *** TODO: consider adding ***
//            let lSymbol = this.getLocalSymbols();
//            lSymbol.forEach( ls => {
//                variables.push({
//                    name: ls.name,
//                    value: toHexString(this.ee65xx.obsMemory.memory[ls.address]),
//                    variablesReference: 0,
//                });
//            });
//        } else if (scope === 'buffer') {
//            // *** TODO: consider adding something similar to stacks to get different view and hex editor
//            // access.  Can a context memu command similar to toggle formating to add a memory range.  ***
        } else if (ref > 0) {
            var start = 0;
            var end = 0;

            if (args.filter && args.filter === 'indexed') {
                // paged memory request
                if (args.start !== undefined) {
                    // remove paged memory flag ($10000000) from variablesReference
                    start = (ref & 0xfffffff) + args.start;
                }
                if (args.count) {
                    end = start + args.count;
                }
            } else {
                // get general memory requests (16 byte chunks)
                // ref = (address * 16) + count
                // *** TODO: this can overlap with variable handles for low memory ranges ***

                start = Math.trunc(ref / 16);
                end = start + (ref & 0xf);
            }

            for (let i = start; i < end; i++) {
                variables.push({
                    name: i.toString(16),
                    value: this.formatNumber(this.ee65xx.obsMemory.memory[i]),
                    variablesReference: 0
                });
            }
        }

        response.body = {
            variables: variables
        };
        this.sendResponse(response);
    }

    // set the referenced variable to the requested value
    protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {

        var variable: DebugProtocol.Variable;
        const ref = args.variablesReference;
        const scope = this._variableHandles.get(ref);
        var name = args.name;
        var value = parseInt(args.value);

        if (scope === 'registers') {
            value = value & (this.ee65xx.mpu.mode ? 0xff : 0xffff);
            this.registers.setRegister(name, value);
        } else if (scope === 'flags') {
            value = value === 0 ? 0 : 1;
            this.registers.setFlag(name, value);
        } else if (ref > 0) {
            //            let address = Math.trunc(ref / 16);
            const address = parseInt(args.name, 16);
            const memoryReference = Math.trunc(args.variablesReference / 16);
            //            value = value & (this.ee65xx.mpu.mode ? 0xff : 0xffff);
            value = value & 0xff;
            this.ee65xx.obsMemory.memory[address] = value;

            // update other elements of UI for change
            // update paged variables (summary values)
            if (this._useInvalidatedEvent) {
                this.sendEvent(new InvalidatedEvent(['variables']));
            }

            // update hex editor window if displayed
            // *** TODO: VS Code is not issuing a supportsMemoryEvent so for
            // now we'll set this as always true.
            // For issue tracking see: https://github.com/microsoft/vscode-mock-debug/issues/78 ***
//            if (this._useMemoryEvent) {
            if (true) {
                // memoryReference here needs to be the memoryReference of the hex editor window,
                // not the reference of the memory changed
                // VSCode seems to know which location to update without setting offset to the address
//            this.sendEvent(new MemoryEvent(memoryReference.toString(16), address, 1));
                this.sendEvent(new MemoryEvent(memoryReference.toString(16), 0, 1));
            }
        } else { // *** TODO: what needs to be here for unsupported set? ***
            //name = '';
            //value = ;
        }

        // Mock-Debug version with interesting ways of finding variables
//        const container = this._variableHandles.get(args.variablesReference);
//        const rv = container === 'locals'
//            ? this.ee65xx.getLocalVariable(args.name)
//            : container === 'register'
//            ? this.ee65xx.getRegisterVariable(args.name)
//            : container instanceof RuntimeVariable && container.value instanceof Array
//            ? container.value.find(v => v.name === args.name)
//            : undefined;
//
//        if (rv) {
//            rv.value = this.convertToRuntime();
//            response.body = this.convertFromRuntime(rv);
//
//            if (rv.memory && rv.reference) {
//                this.sendEvent(new MemoryEvent(String(rv.reference), 0, rv.memory.length));
//            }
//        }

        variable = {
            name: args.name,
            value: value.toString(16),
            variablesReference: 0
        };

        response.body = variable;

        this.sendResponse(response);
    }

    // pause execution
    protected pauseRequest(response: DebugProtocol.PauseResponse): void {
        this.ee65xx.pause();
        this.sendResponse(response);
    }

    // continue execution, clear call stack if any
    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
        // clear out any in call stack frames
        // *** TODO: consider getting stack frames from runtime, but this seems like more work than it's worth ***
        this.inCall = false;
        this.callFrames = [];
        this.ee65xx.continue();
        this.sendResponse(response);
    }

    // execute the current line, stepping over JSR or JSL subroutines
    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
        const mpu = this.ee65xx.mpu;
        if (!mpu.waiting) {
            const opCode = mpu.opCode;
            if ((opCode === 0x20) || (opCode === 0x22)) {
                // step over JSR and JSL
                // *** TODO: we can use this to set up call stack ***
                const address = this.registers.address + ((opCode === 0x22) ? 4 : 3);
                this.ee65xx.stepTo(address);
            }
            else {
                // take top frame from call stack if we're returning from a subroutine
                if ((opCode === 0x60) || (opCode === 0x6B)) {
                    this.callFrames.shift();
                    if (this.callFrames.length === 0) {
                        this.inCall = false;
                    }
                }
                this.ee65xx.step(true);
            }
            this.sendResponse(response);
        }
        else {
            this.sendResponse(response);
            const se = new StoppedEvent('pause', Debug65xxSession.threadID);
            (se as DebugProtocol.StoppedEvent).body.description = 'Paused, waiting for input';
            this.sendEvent(se);
        }
    }

    // execute the current line, stepping into any JSR or JSL subroutines
    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
        const mpu = this.ee65xx.mpu;
        if (!mpu.waiting) {
            const opCode = mpu.opCode;
            if ((opCode === 0x20) || (opCode === 0x22)) {
                const pos = this.sourceMap.get(this.registers.address);
                if (pos !== undefined) {
                    // set up stackframe for step into JSR and JSL
                    const nextAddress = pos.address + ((opCode === 0x22) ? 4 : 3);
                    const frame: IRuntimeStackFrame = {
                        index: 1,
                        name: pos.instruction,
                        file: this.sourceMap.getSourceFile(pos.fileId),
                        line: pos.sourceLine,
                        column: 0,
                        instruction: pos.address,
                        nextaddress: nextAddress
                    };
                    if (this.inCall) {
                        const frames: IRuntimeStackFrame[] = [];
                        frames.push(frame);
                        this.callFrames.forEach(frame => { frames.push(frame); });
                        this.callFrames = frames;
                    }
                    else {
                        this.callFrames.push(frame);
                    }
                    this.inCall = true;
                }
            }
            else if ((opCode === 0x60) || (opCode === 0x6B)) {
                this.callFrames.shift();
                if (this.callFrames.length === 0) {
                    this.inCall = false;
                }
            }

            this.ee65xx.step(true);
            this.sendResponse(response);
        }
        else {
            this.sendResponse(response);
            const se = new StoppedEvent('pause', Debug65xxSession.threadID);
            (se as DebugProtocol.StoppedEvent).body.description = 'Paused, waiting for input';
            this.sendEvent(se);
        }
    }

    // continue execution until we're out of the current call frame into the next, or single step if one doesn't exist
    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
        if (!this.ee65xx.mpu.waiting) {
            if (this.inCall) {
                this.ee65xx.stepTo(this.callFrames[0].nextaddress);
                this.callFrames.shift();
                if (this.callFrames.length === 0) {
                    this.inCall = false;
                }
            }
            else {
                this.ee65xx.step(true);
            }
            this.sendResponse(response);
        }
        else {
            this.sendResponse(response);
            const se = new StoppedEvent('pause', Debug65xxSession.threadID);
            (se as DebugProtocol.StoppedEvent).body.description = 'Paused, waiting for input';
            this.sendEvent(se);
        }
    }

    // process Watch and Hover variable requests and limited debug console REPL requests
    protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
        var result = '';
        var ref = 0;
        var mref: string | undefined = undefined;
        var iv: number | undefined = undefined;

        switch (args.context) {
            case 'repl':
                // convert any symbols to their addresses
                const exp = this.expSymbolToAddress(args.expression);
                const value = this.expEval(exp);
                if (value !== undefined) {
                    result = value.toString();
                } else {
                    //response.success = false;
                    result = '???';
                }
                break;

            case 'watch':
            case 'hover':
                let symbol = this.sourceMap.getSymbol(args.expression);
                const mem = this.ee65xx.obsMemory.memory;

                if (symbol) {
                    switch (symbol.size) {
                        case 1:
                            result = mem[symbol.address].toString(16);
                            break;
                        case 2:
                            result = (mem[symbol.address] + (mem[symbol.address + 1] << 8)).toString(16);
                            break;
                        case 4:
                            result = (mem[symbol.address] +
                                (mem[symbol.address + 1] << 8) +
                                (mem[symbol.address + 2] << 16) +
                                (mem[symbol.address + 3] << 24)).toString(16);
                            break;
                        default:
                            result = toHexString(mem.slice(symbol.address, symbol.address + symbol.size));
                            //result = toHexString(mem.slice(symbol.address, symbol.address + 10));
                            if (args.context === 'watch') {
                                ref = 0x10000000 + symbol.address;
                                //ref = (symbol.address * 16) + Math.min(symbol.size, 0xff);
                                // *** TODO: paged variables will not display the View Binary Data icon
                                // see: https://github.com/microsoft/vscode-mock-debug/issues/78.
                                // Have to have a variable represent this in an expanded view.  Consider adding. ***
                                //mref = symbol.address.toString(16);
                                iv = symbol.size; // using indexedVariables triggers VS Code's paged variable interface
                            }
                            break;
                    }
                    if (args.context === 'hover') {
                        result = symbol.address.toString(16) + ': ' + result;
                    }
                } else if (args.expression.includes(':')) {
                    // check for a valid memory range
                    // *** note hovering will never end up here as it won't capture a ':' ***
                    const range = args.expression.split(':');
                    if (range.length === 2) {
                        const start = parseInt(range[0]);
                        const end = parseInt(range[1]);
                        if (end >= start) {
                            result = toHexString(mem.slice(start, end + 1));
                            // display as paged memory
                            // I don't want to create a handle for every memory range and
                            // we need a way to handle a memory range that starts with 0.
                            // variablesReference must be > 0 and < $7fffffff.  Since the
                            // 65816 can only reference $1000000 bytes of memory, we'll
                            // use $10000000 as a flag for a paged memory request
                            ref = 0x10000000 + start;
                            // *** TODO: see note above about watch memref ***
                            //mref = start.toString(16);
                            iv = end - start + 1;
                        }
                    }
                } else if (!isNaN(parseInt(args.expression))) {
                    result = mem[parseInt(args.expression)].toString(16);
                } else {
                    response.success = false;
                    break;
                }
                break;

            default:
                // just return address of symbol if found
                symbol = this.sourceMap.getSymbol(args.expression);
                if (symbol !== undefined) {
                    result = symbol.address.toString();
                } else {
                    response.success = false;
                }
                break;
        }

        if (response.success === true) {
            response.body = {
                result: result,
                variablesReference: ref,
                memoryReference: mref,
                indexedVariables: iv
            };
        }

        this.sendResponse(response);
    }

    // set value of a Watch variable
    // (also used if supportsSetVariable is false and a Variable's evaluateName property is set)
    protected setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments): void {

        if (args.expression.startsWith('$')) {
            const rv = this.scopes.get(args.expression.slice(1));
            if (rv) {
                //rv.value = this.convertToRuntime(args.value);
                response.body = { value: '0xea' };
                this.sendResponse(response);
            } else {
                this.sendErrorResponse(response, {
                    id: 1002,
                    format: `variable '{lexpr}' not found`,
                    variables: { lexpr: args.expression },
                    showUser: true
                });
            }
        } else {
            this.sendErrorResponse(response, {
                id: 1003,
                format: `'{lexpr}' not an assignable expression`,
                variables: { lexpr: args.expression },
                showUser: true
            });
        }
    }

    // check if a data breakpoint is valid
    protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): void {

        response.body = {
            dataId: null,
            description: "cannot set a data breakpoint here",
            accessTypes: undefined,
            canPersist: false
        };

        // verify valid data breakpoint and only set if not set already
        // we only support write access and we'll break just prior to, not after, the write access
        if (args.variablesReference && args.name && !this.dataBreakpoints.get(args.name)) {
            const v = this._variableHandles.get(args.variablesReference);
            if (v === 'registers') {
                switch (args.name) {
                    case 'B':
                    case 'D':
                    case 'K':
                    case 'X':
                    case 'Y':
                        response.body.dataId = args.name;
                        response.body.description = args.name;
                        response.body.accessTypes = ["write"];  // we only support change access
                        response.body.canPersist = true;
                        break;
                    default:
                        break;
                }
            }
        }

        this.sendResponse(response);
    }

    // set a data breakpoint
    protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): void {

        // clear all data breakpoints
        this.clearAllDataBreakpoints();

        response.body = {
            breakpoints: []
        };

        for (const dbp of args.breakpoints) {
            const ok = this.setDataBreakpoint(dbp.dataId, dbp.accessType || 'write');
            response.body.breakpoints.push({
                verified: ok,
                id: this.breakpointId++
            });
        }

        this.sendResponse(response);
    }

    // set a function breakpoint
    // both address and function names are supported
    // *** DAP requires "BreakPoints" capitalization here ***
    protected setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments, request?: DebugProtocol.Request): void {
    //protected setFunctionBreakpointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments, request?: DebugProtocol.Request): void {
        const actualBreakpoints: DebugProtocol.Breakpoint[] = [];

        // clear all function breakpoints for this file
        //this.clearFuctionBreakpoints(fileId);
        this.clearFuctionBreakpoints();

        // set and verify function breakpoint locations
        // *** note that VS Code is sending more properties than indicated by DAP, such as enabled, id and data (only on second time through)
        args.breakpoints.forEach((bp) => {
            const { verified, line, id } = this.setFunctionBreakpoint(bp);
            const dbp = new Breakpoint(verified, line) as DebugProtocol.Breakpoint;
            dbp.id = id;
            actualBreakpoints.push(dbp);
        });

        // send back the actual breakpoint positions
        response.body = {
            breakpoints: actualBreakpoints
        };

        this.sendResponse(response);
    }

    // use exception breakpoints to break on instruction mnemonics and opcodes
    // *** VS Code requires "setExceptionBreakPointsRequest" capitalization here ***
    protected async setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments): Promise<void> {

        let namedExceptions: string | undefined = undefined;
        let opcodeExceptions: string | undefined = undefined;

        if (args.filterOptions) {
            for (const filterOption of args.filterOptions) {
                switch (filterOption.filterId) {
                    case 'namedExceptions':
                        namedExceptions = filterOption.condition;
                        break;
                    case 'opcodeExceptions':
                        opcodeExceptions = filterOption.condition;
                        break;
                }
            }
        }

        this.setExceptionsFilters(namedExceptions, opcodeExceptions);

        this.sendResponse(response);
    }

    // use the Loaded Script Explorer for source files
    protected loadedSourcesRequest(response: DebugProtocol.LoadedSourcesResponse, args: DebugProtocol.LoadedSourcesArguments): void {
        const sources: DebugProtocol.Source[] = [];

        for (const file of this.sourceMap.getSourceFiles()) {
            sources.push(this.createSource(file));
        }

        response.body = {
            sources: sources
        };
        this.sendResponse(response);
    }

    // disassemble code snippet when a source file can't be found for the program location
    // *** to come ***
    protected disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments) {

        const baseAddress = parseInt(args.memoryReference);
        const offset = args.instructionOffset || 0;
        const count = args.instructionCount;

        const isHex = args.memoryReference.startsWith('0x');
        const pad = isHex ? args.memoryReference.length - 2 : args.memoryReference.length;

//        const loc = this.createSource(this.sourceFile);

        const lastLine = -1;
        const instructions: DebugProtocol.DisassembledInstruction[] = [];

//        const instructions = this.disassemble(baseAddress + offset, count).map(instruction => {
//            const address = instruction.address.toString(isHex ? 16 : 10).padStart(pad, '0');
//            const instr: DebugProtocol.DisassembledInstruction = {
//                address: isHex ? `0x${address}` : `${address}`,
//                instruction: instruction.instruction
//            };
//            // if instruction's source starts on a new line add the source to instruction
//            if (instruction.line !== undefined && lastLine !== instruction.line) {
//                lastLine = instruction.line;
//                instr.location = loc;
//                instr.line = this.convertDebuggerLineToClient(instruction.line);
//            }
//            return instr;
//        });

        response.body = {
            instructions: instructions
        };
        this.sendResponse(response);
    }

    // *** this probably doesn't have much use ***
//    protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments) {
//        response.body = {
//            exceptionId: 'Exception ID',
//            description: 'This is a descriptive description of the exception.',
//            breakMode: 'always',
//            details: {
//                message: 'Message contained in the exception.',
//                typeName: 'Short type name of the exception object',
//                stackTrace: 'stack frame 1\nstack frame 2',
//            }
//        };
//        this.sendResponse(response);
//    }

    // *** Currently all displayed values are in hex.  I've left this here for info.
    // in package.json
    //"debug/variables/context": [
    //    {
    //        "command": "extension.db65xx.toggleFormatting",
    //        "when": "debugType == '65816' && debugProtocolVariableMenuContext == 'simple'"
    //    }
    // the when line needs to be
    //        "when": "debugType == '65816'"
    // to show the menu item in my version, perhaps because I have data breakpoints
    // see: https://github.com/microsoft/vscode/issues/105810
    // with: https://github.com/microsoft/vscode-mock-debug/blob/f4b0e37cfd0cb1653c82a26bdab4910c87489713/src/mockDebug.ts#L302
    // and: https://github.com/microsoft/vscode-mock-debug/blob/f4b0e37cfd0cb1653c82a26bdab4910c87489713/package.json#L83
    // for idea on how to allow individual items to be displayed as hex or decimal
    protected customRequest(command: string, response: DebugProtocol.Response, args: any) {
        if (command === 'toggleFormatting') {
            this._valuesInHex = !this._valuesInHex;
            if (this._useInvalidatedEvent) {
                this.sendEvent(new InvalidatedEvent(['variables']));
            }
            this.sendResponse(response);
        } else {
            super.customRequest(command, response, args);
        }
    }


    // *******************************************************************************************
    // public methods

    // check if a breakpoint has been hit
    // Currently breakpoints can be set on valid source code lines and cettain
    // registers (see code below).
    public checkBP(): boolean {
        const address = this.registers.address;
        const fileId = this.sourceMap.get(address)?.fileId;

        // is there a source breakpoint at this address?
        // *** TODO: It would be nice to be able to set a source breakpoint on a
        // given memory address but can only be set on an valid line in the source
        // file through normal UI mechanisms (and thus can't be sent on Forth code
        // in the data area).  We could add the specific capability, like the
        // ToggleFormatting context menu or debug window REPL in Mock-Debug, or perhaps
        // a somewhat hack like a local "address" variable that when set adds a source
        // or data breakpoint.  This might also work well with instruction breakpoints
        // but those only work in disassembly view and thus have their own
        // implementation issues.  For now I accomplish this with function breakpoints. ***
        const breakpoints = fileId !== undefined ? this.breakpoints.get(fileId) : undefined;
        if (breakpoints) {
            const bps = breakpoints.filter(bp => bp.address === address);
            if (bps.length > 0) {
                let isCondition: number | undefined = 0;
                let isHitCondition: number | undefined = 0;

                // check on conditions
                if (bps[0].condition) {
                    isCondition = this.expEval(bps[0].condition);
                }
                if (bps[0].hitCondition) {
                    const hitCondition = this.expEval(bps[0].hitCondition);
                    const hcbp = this.hitConditionBreakpoints.get(address);

                    if (hcbp) {
                        hcbp.hits++;
                        if (hcbp.hits === hitCondition) {
                            isHitCondition = 1;
                        }
                    }
                }

                // we've hit a source breakpoint if either condition is met or
                // if both conditions are undefined
                if (isCondition || isHitCondition || (!bps[0].condition && !bps[0].hitCondition)) {

                    // evaluate and print message to debug console if a log point is set
                    if (bps[0].logMessage) {
                        // evaluate {} section of message if any
                        const msg = bps[0].logMessage.replace(/(\{.*\})/g, (match, exp) => {
                            const nexp = this.expSymbolToAddress(exp.slice(1, -1));
                            const value = this.expEval(nexp);
                            return value ? value.toString() : '{???}';
                        });
                        const e: DebugProtocol.OutputEvent = new OutputEvent(msg + '\n', 'console');

                        e.body.source = this.createSource(this.sourceMap.getSourceFile(fileId));
                        const line = this.sourceMap.get(address)?.sourceLine;
                        if(line) {
                            e.body.line = this.convertDebuggerLineToClient(line);
                        }
                        this.sendEvent(e);
                        return false;
                    } else {
                        this.sendEvent(new StoppedEvent('stopOnBreakpoint', Debug65xxSession.threadID));
                        return true;
                    }
                }
            }
        }

        // is there a data breakpoint relevant to the instruction at this address?
        if (this.dataBreakpoints.size) {
            // Only write access to the X, Y, K, B and D registers are considered.
            // *** TODO: It would be nice to be able to set a data breakpoint on a
            // memory address.  It looks like you can only set a data breakpoint
            // in VS Code on an item in the Variables pane of the UI through normal
            // UI mechanisms, thus we'd have to add this capability.  Consider
            // adding capability here. ***
            const pos = this.sourceMap.get(address);
            const inst = pos?.instruction;
            let access: string | undefined;
            const reg_write: RegExp[] = [];
            let name = '';
            let accessType: string | undefined;
            let matches0: RegExpExecArray | null;

            // The UI labels these breakpoints as break on change but below only consider
            // that the value may have changed with the instruction *** TODO: consider updating ***
            reg_write.push(/^(dex|inx|ldx|plx|tax|tsx|tyx)/ig); // X register
            reg_write.push(/^(dey|iny|ldy|ply|tay|txy)/ig);     // Y
            reg_write.push(/^(jsl|rtl|jml)/ig);                 // K (program bank) *** TODO: I don't consider jmp forms of long addressing ***
            reg_write.push(/^(plb)/ig);                         // B (data bank)
            reg_write.push(/^(pld|tcd)/ig);                     // D (direct page)
            reg_write.forEach((r) => {
                if (inst && (matches0 = r.exec(inst))) {
                    access = 'write';
                    name = matches0[0].slice(-1).toUpperCase();
                    accessType = this.dataBreakpoints.get(name);
                }
            });

            if (access && accessType && accessType.indexOf(access) >= 0) {
                this.sendEvent(new StoppedEvent('stopOnDataBreakpoint', Debug65xxSession.threadID));
                return true;
            }
        }

        // is there a function breakpoint at this address?
        //        const functionBreakpoints = this.functionBreakpoints.get(source);
        //        if (functionBreakpoints) {
        //            const bps = functionBreakpoints.filter(bp => bp.address === address);
        //            if (bps.length > 0) {
        //                this.sendEvent(new StoppedEvent('stopOnFunctionBreakpoint', Debug65xxSession.threadID));
        //                return true;
        //            }
        //        }
        //        this.functionBreakpoints.forEach((bp, name) => {
        // for different Map iterators see:
        // https://www.javascripttutorial.net/es6/javascript-map/
        for (const [name, bp] of this.functionBreakpoints.entries()) {
            if (bp.address === address) {
                let isCondition: number | undefined = 0;
                let isHitCondition: number | undefined = 0;

                // check on conditions
                // TODO: logMessage is not available for function breakpoints, consider adding ***
                //if (bp.logMessage) {
                //    // eslint-disable-next-line no-console
                //    console.log(bp.logMessage);
                //    return false;
                //}
                if (bp.condition) {
                    isCondition = this.expEval(bp.condition);
                }
                if (bp.hitCondition) {
                    const hitCondition = this.expEval(bp.hitCondition);
                    const hcbp = this.hitConditionBreakpoints.get(address);

                    if (hcbp) {
                        hcbp.hits++;
                        if (hcbp.hits === hitCondition) {
                            isHitCondition = 1;
                        }
                    }
                }

                // we've hit a function breakpoint if either condition is met or
                // if both conditions are undefined
                if (isCondition || isHitCondition || (!bp.condition && !bp.hitCondition)) {
                    this.sendEvent(new StoppedEvent('stopOnFunctionBreakpoint', Debug65xxSession.threadID));
                    return true;
                }
            }
        }

        // is there a named or opcode exception?
        if (this.namedExceptions) {
            const exception = this.namedExceptions;
//            let inst = this.sourceMap.get(address)?.instruction.slice(0, 3);
            const inst = this.sourceMap.get(address)?.instruction.split(' ');
            // *** TODO: might consider case sensitivity ***
            if (inst && exception?.includes(inst[0])) {
                this.sendEvent(new StoppedEvent(inst[0], Debug65xxSession.threadID));
                return true;
            }
        }
        if (this.opcodeExceptions) {
            const opcode = this.ee65xx.obsMemory.memory[address];
            if (opcode) {
                const brkCodes = this.opcodeExceptions.split(',');
                if (brkCodes) {
                    for (const brkCode of brkCodes.values()) {
                        if (opcode === parseInt(brkCode, 16)) {
                            this.sendEvent(new StoppedEvent(opcode.toString(16), Debug65xxSession.threadID));
                            return true;
                        }
                    }
                }
            }
        }

        return false;
    }


    // *******************************************************************************************
    // private factors

    private registerScopes(mpu: MPU65816, memory: Uint8Array, fbin: string) {
        this.scopes.set('registers', this._variableHandles.create('registers'));
        this.scopes.set('flags', this._variableHandles.create('flags'));
        //this.scopes.set('locals', this._variableHandles.create('locals'));
        //this.scopes.set('globals', this._variableHandles.create('globals'));

        // register stacks
        // the stacks container and each separate stack must be added to scopes
        // to activate the UI's paging capability.  Just create a _variableHandles
        // if you only want a summary.
        this.scopes.set('stacks', this._variableHandles.create('stacks'));
        this.scopes.set('hwstack', this._variableHandles.create('hwstack'));
        this.stacks.set('hwstack', {
            name: 'HW',
            start: () => { return mpu.sp + 1 + (mpu.mode ? 0x100 : 0); },
            //            top: () => { return mpu.sp | (mpu.sp < 0x1000 ? 0xff : 0xfff) + 1}, // *** TODO: this is a hack but works for my system ***
            length: () => {
                let length = 0;
                const top = (mpu.sp | (mpu.sp < 0x1000 ? 0xff : 0xfff)) + 1 + (mpu.mode ? 0x100 : 0);
                const start = mpu.sp + 1 + (mpu.mode ? 0x100 : 0);
                if (top > start) {
                    length = top - start;
                }
                return length;
            },
            value: () => {
                const top = (mpu.sp | (mpu.sp < 0x1000 ? 0xff : 0xfff)) + 1 + (mpu.mode ? 0x100 : 0);
                const start = mpu.sp + 1 + (mpu.mode ? 0x100 : 0);
                const length = top - start;
                if (length > 0) {
                    //                    return toHexString(memory.slice(start, start + Math.min(16, length)), 8)
                    return toHexString(memory.slice(start, start + length), 8);
                } else {
                    return '';
                }
            },
            reference: 'hwstack',
            memoryRef: memory,
            size: 8
        });

        // add Forth stacks if we're using Forth
        if (fbin) {
            // we use the X register as the Forth data and return stack pointers as well as the
            // floating-point stack pointer.  The X register is also used as an index register
            // on occasion.  We'll use a hardcoded stack range for now (*** TODO: link to config file)
            // The floating-point and forth return stack pointers are their respective
            // variables when X isn't in their range, otherwise X represents the most current
            // pointer.  It isn't as easy with the Forth data stack as it's pointer is pushed
            // to the hardware stack when X is used for something else (*** TODO: reconsider this ***).
            // accurately as we can compare the value of the X register to the
            // stack memory ranges
            const FDSSIZE = 0x1000;
            const FRSSIZE = 0x800;
            const FPSSIZE = 0x100; // this isn't officially defined
            const FPSPo = 0x800;
            const FRSPo = FPSPo + FRSSIZE;
            const FDSPo = FRSPo + FDSSIZE;

            this.scopes.set('fdstack', this._variableHandles.create('fdstack'));
            this.stacks.set('fdstack', {
                name: 'FD',
                start: () => { return mpu.x; },
                //            top: () => { return mpu.sp | (mpu.sp < 0x1000 ? 0xff : 0xfff) + 1 }, // *** TODO: this is a hack but works for my system ***
                length: () => {
                    let length = 0;
                    const top = FDSPo;
                    const start = mpu.x;
                    if (top > start) {
                        length = top - start;
                    }
                    return length;
                },
                value: () => {
                    const top = FDSPo;
                    const start = mpu.x;
                    const length = top - start;
                    if (length > 0) {
                        //                    return toHexString(memory.slice(start, start + Math.min(16, length)), 16)
                        return toHexString(memory.slice(start, start + length), 16);
                    } else {
                        return '';
                    }
                },
                reference: 'fdstack',
                memoryRef: memory,
                size: 16
            });
            this.scopes.set('fpstack', this._variableHandles.create('fpstack'));
            this.stacks.set('fpstack', {
                name: 'FP',
                start: () => {
                    const x = mpu.x;
                    var sPointer: number;

                    // does X point to the floating-point stack?
                    if ((x <= FPSPo) && (x > (FPSPo - FPSSIZE))) {
                        // yes, use it as stack pointer
                        sPointer = x;
                    }
                    else {
                        // no, use FPSP
                        sPointer = memory[2] + (memory[3] << 8);
                    }
                    return sPointer;
                },
                //            top: () => { return mpu.sp | (mpu.sp < 0x1000 ? 0xff : 0xfff) + 1 }, // *** TODO: this is a hack but works for my system ***
                length: () => {
                    let length = 0;
                    const top = FPSPo; // *** TODO: probably should create a code symbol for this, can get from code source though ***
                    const start = memory[2] + (memory[3] << 8);
                    if (top > start) {
                        length = top - start;
                    }
                    return length;
                },
                value: () => {
                    const top = FPSPo;
                    const start = memory[2] + (memory[3] << 8);
                    const length = top - start;
                    if (length > 0) {
                        //                    return toHexString(memory.slice(start, start + Math.min(24, length)), 32)
                        return toHexString(memory.slice(start, start + length), 32);
                    } else {
                        return '';
                    }
                },
                reference: 'fpstack',
                memoryRef: memory,
                size: 64
            });
        }
    }

    // Set breakpoint in file at given line
    private setBreakpoint(fileId: number | undefined, sbp: DebugProtocol.SourceBreakpoint): IBreakpoint {
        const line = this.convertClientLineToDebugger(sbp.line);
        const bp: IBreakpoint = { verified: false, line, id: this.breakpointId++, address: 0, logMessage: sbp.logMessage };

        if (fileId !== undefined) {
            let bps = this.breakpoints.get(fileId);
            if (!bps) {
                bps = new Array<IBreakpoint>();
                this.breakpoints.set(fileId, bps);
            }

            // check if breakpoint is on a valid line
            const bpAddress = this.sourceMap.getRev(fileId, bp.line);

            // if so, set it as valid and update its address
            if (bpAddress) {
                bp.verified = true;
                bp.address = bpAddress;

                // convert symbols to their addresses
                // if condition and/or hitCondition are set
                if (sbp.condition) {
                    bp.condition = this.expSymbolToAddress(sbp.condition);
                }
                if (sbp.hitCondition) {
                    bp.hitCondition = this.expSymbolToAddress(sbp.hitCondition);

                    const hcbp = this.hitConditionBreakpoints.get(bpAddress);
                    if (!hcbp) {
                        this.hitConditionBreakpoints.set(bpAddress, { address: bpAddress, hitCondition: sbp.hitCondition, hits: 0 });
                    } else {
                        // reset runtime breakpoint if hit condition changed
                        if (hcbp.hitCondition !== sbp.hitCondition) {
                            hcbp.hitCondition = sbp.hitCondition;
                            hcbp.hits = 0;
                        }
                    }
                }
            }
            bps.push(bp);
        }
        return bp;
    }

    // Clear breakpoint in file at given line
    // source is assumed to be normaized
    //    public clearBreakpoint(path: string, line: number): IBreakpoint | undefined {
    //        const bps = this.breakpoints.get(this.normalizePathAndCasing(path));
    //        if (bps) {
    //            const index = bps.findIndex(bp => bp.line === line);
    //            if (index >= 0) {
    //                const bp = bps[index];
    //                bps.splice(index, 1);
    //                return bp;
    //            }
    //        }
    //        return undefined;
    //    }

    // Clear all breakpoints in file
    // source is assumed to be normaized
    private clearBreakpoints(fileId: number | undefined): void {
        if (fileId !== undefined) {
            this.breakpoints.delete(fileId);
        }
    }

    // Verify breakpoints in given file
    private verifyBreakpoints(fileId: number): void {
        const bps = this.breakpoints.get(fileId);
        if (bps) {
            //            this.loadSource(source);
            bps.forEach(bp => {
                //                if (!bp.verified && bp.line < this.sourceLines.length) {
                if (!bp.verified) {
                    // we're only validating breakpoints from our source files
                    // check if breakpoint is on a valid line
                    const bpAddress = this.sourceMap.getRev(fileId, bp.line);

                    // if so, set it as valid and update its address
                    if (bpAddress) {
                        bp.verified = true;
                        bp.address = bpAddress;
                        this.sendEvent(new BreakpointEvent('changed', { verified: bp.verified, id: bp.id } as DebugProtocol.Breakpoint));
                    }
                }
            });
        }
    }

    private setDataBreakpoint(address: string, accessType: 'read' | 'write' | 'readWrite'): boolean {

        const x = accessType === 'readWrite' ? 'read write' : accessType;

        // verify register
        // *** I believe dataBreakpointInfoRequest handles data breakpoint verification so we
        // don't need a separate verify method or to send a breakpoint event similar to above. ***
        switch (address) {
            case 'B':
            case 'D':
            case 'K':
            case 'X':
            case 'Y':
                break;
            default:
                return false;
        }

        const t = this.dataBreakpoints.get(address);
        if (t) {
            if (t !== x) {
                this.dataBreakpoints.set(address, 'read write');
            }
        } else {
            this.dataBreakpoints.set(address, x);
        }
        return true;
    }

    private clearAllDataBreakpoints(): void {
        this.dataBreakpoints.clear();
    }

    // Clear all function breakpoints in file
    // source is assumed to be normaized
    //    private clearFuctionBreakpoints(source: string): void {
    private clearFuctionBreakpoints(): void {
        this.functionBreakpoints.clear();
    }

    // Set funtion breakpoint in file at given address
    private setFunctionBreakpoint(fbp: DebugProtocol.FunctionBreakpoint): IBreakpoint {
        const bp: IBreakpoint = { verified: false, line: 0, id: this.breakpointId++, address: 0 };
        //let bps = this.functionBreakpoints.get(fileId);
        //if (!bps) {
        //    bps = new Array<IBreakpoint>();
        //    this.functionBreakpoints.set(fileId, bps);
        //}
        //bps.push(bp);

        // function breakpoints can be either an address or a source symbol
        // if a symbol is given then we'll attempt to convert it into an address
        // for the breakpoint
        let bpAddress: number | undefined = parseInt(fbp.name);
        if (isNaN(bpAddress)) {
            bpAddress = this.sourceMap.getSymbolAddress(fbp.name);
        }
        if (bpAddress) {
            bp.verified = true;
            bp.address = bpAddress;

            // check if address is a valid source line
            // *** TODO: condider making line undefined to flag the need to disassemble binary ***
            const bpline = this.sourceMap.get(bpAddress)?.sourceLine;
            if (bpline) {
                bp.line = bpline;
            }

            // convert symbols to their addresses
            // if condition and/or hitCondition are set
            if (fbp.condition) {
                bp.condition = this.expSymbolToAddress(fbp.condition);
            }
            if (fbp.hitCondition) {
                bp.hitCondition = this.expSymbolToAddress(fbp.hitCondition);

                const hcbp = this.hitConditionBreakpoints.get(bpAddress);
                if (!hcbp) {
                    this.hitConditionBreakpoints.set(bpAddress, { address: bpAddress, hitCondition: fbp.hitCondition, hits: 0 });
                } else {
                    // reset runtime breakpoint if hit condition changed
                    if ( hcbp.hitCondition !== fbp.hitCondition) {
                        hcbp.hitCondition = fbp.hitCondition;
                        hcbp.hits = 0;
                    }
                }
            }

            this.functionBreakpoints.set(fbp.name, bp);
        }

        return bp;
    }

    // Verify function breakpoints in given file
    private verifyFunctionBreakpoints(name: string, address: number): void {

        // is name a function breakpoint?
        const bp = this.functionBreakpoints.get(name);
        if (bp) {
            // *** TODO: do we have anything else to validate for function breakpoints? ***
            if (!bp.verified) {

                // check if name is a recognized symbol
                let bpAddress = this.sourceMap.getSymbolAddress(name);

                // if so, set it as valid and update its address
                if (!bpAddress) {
                    if (parseInt(name) === address) {
                        bpAddress = address;
                    } else {
                        return;
                    }
                }
                const bpline = this.sourceMap.get(bpAddress)?.sourceLine;
                if (bpline) {
                    bp.verified = true;
                    bp.address = bpAddress;
                    bp.line = bpline;
                    this.sendEvent(new BreakpointEvent('changed', { verified: bp.verified, id: bp.id } as DebugProtocol.Breakpoint));
                }
            }
        }
    }

//    private disassemble(address: number, instructionCount: number): RuntimeDisassembledInstruction[] {
    private disassemble(address: number, instructionCount: number): string {

//        const instructions: RuntimeDisassembledInstruction[] = [];
//
//        for (let a = address; a < address + instructionCount; a++) {
//            if (a >= 0 && a < this.instructions.length) {
//                instructions.push({
//                    address: a,
//                    instruction: this.instructions[a].name,
//                    line: this.instructions[a].line
//                });
//            } else {
//                instructions.push({
//                    address: a,
//                    instruction: 'nop'
//                });
//            }
//        }

//        return instructions;
        return 'instructions';
    }

    private setExceptionsFilters(namedException: string | undefined, opcodeExceptions: string | undefined): void {
        this.namedExceptions = namedException;
        this.opcodeExceptions = opcodeExceptions;
    }


    // *******************************************************************************************
    // private helper methods

    // replace symbol in expression with it's adddress
    // for example if putc = $f001, then the expression
    // 'putc == 5' becomes '"61441" == 5'
    private expSymbolToAddress(exp: string): string {
        const nexp = exp.replace(/(\b[A-z]+[A-z0-9]*)/g, (match, sym) => {
            const address = this.sourceMap.getSymbolAddress(sym);
            return address ? '\"' + address.toString() + '\"' : sym;
        });

        return nexp;
    }

    // evaluate an experssion and return its value
    // dereferencing any addresses in an expression
    // for example if address $f001 = 5 then the
    // expression '"61441" == 5' returns true
    private expEval(exp: string): number | undefined {
        // regexp w/o quotes (?<=")([0-9]+)(?=")
        const nexp = exp.replace(/("[0-9]+")/g, (match, sym) => {
            const address = parseInt(sym.slice(1, -1));
            return this.ee65xx.obsMemory.memory[address].toString();
        });

        try {
            const result = Function(`"use strict";return (${nexp})`)();

            if (typeof result === 'boolean') {
                return result ? 1 : 0;
            }
            return result;
        }
        catch (err) {
            return undefined;
        }
    }

    private formatAddress(x: number, pad = 8) {
//        return this._addressesInHex ? '0x' + x.toString(16).padStart(pad, '0') : x.toString(10);
        return this._addressesInHex ? x.toString(16).padStart(pad, '0') : x.toString(10);
    }

    private formatNumber(x: number): string {
//        return this._valuesInHex ? '0x' + x.toString(16) : x.toString(10);
        return this._valuesInHex ? x.toString(16) : x.toString(10);
    }

    private createSource(source: string): Source {
        return new Source(path.basename(source), source);
    }

}
