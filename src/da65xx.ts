/* eslint-disable @typescript-eslint/naming-convention */

// da65xx.ts implements Microsoft's Debug Adapter Protocol (DAP) to interface
// between the VS Code debugging UI and the EE65xx execution engine.

import {
    Logger, logger,
    LoggingDebugSession, Event, ContinuedEvent, ExitedEvent,
    InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
    InvalidatedEvent,
    Thread, StackFrame, Scope, Source, Handles, Breakpoint, MemoryEvent, ThreadEvent, Variable
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { Subject } from 'await-notify';
import * as base64 from 'base64-js';
import * as path from 'path';
import { TextEncoder } from 'node:util';

import { EE65xx } from './ee65xx';
import { Registers } from './registers';
import { Symbols, ISymbol } from './symbols';
import { SourceMap } from './sourcemap';
import { toHexString, getMemValue, setMemValue, hasMatchedBrackets, findClosingBracket } from './util';
import { MPU65XX } from './mpu65xx';
import { terminalClear } from './terminal';

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

export interface IRuntimeStackFrame {
    index: number;          // frame index
    name: string;           // text of instruction on line stripped of comments (asm) or function name (C)
    file: string;           // file path
    fileId?: number;        // file id
    scope?: number;         // scope id for C functions, undefined otherwise
    sp?: number;            // C stack pointer associated with this scope
                            // *** the --all-cdecl compiler option has to be used to properly view local
                            //     variables in C function.  With this option the stack pointer is set on
                            //     entry to the function.  Otherwise, the first parameter is passed in
                            //     registers and pushed to the stack on entry, changing the stack pointer.
                            //     The easiest way to handle this is to force the cdecl calling convention
                            //     for debugging.  The main drownside is somewhat larger code, which shouldn't
                            //     be a problem for debugging.  See https://github.com/cc65/wiki/wiki/Parameter-passing-and-calling-conventions#the-fastcall-calling-convention
                            //     for more information.
    line: number;           // source line #
    address: number;        // address associated with this line
    nextAddress?: number;   // the address following: (asm) jsr/jsl*; (C) function call
                            // * this might not reflect actual return if return address is modified on stack
                            // *** TODO: consider how to reflect this possibility ***
    firstAddress?: number;  // (C) the first address in this stack frame; (asm) always 0
    lastAddress?: number;   // (C) the last address in this stack frame; (asm) always 0
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
        cpu?: string,       // '65816' default | '65802' | '65C02' | 6502
        sbin: string,       // source binary
        src?: string,       // source code directory
        listing?: string,   // listing, map and symbol files directory
        acia?: string,      // address of ACIA
        via?: string,       // address of VIA
        fbin?: string,      // Forth binary to load at startup
        input?: string,     // address of input
        output?: string     // address of ouput
    }
}

interface IAttachRequestArguments extends ILaunchRequestArguments { }

// represents hardware or software stack in Variables pane
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

    // the 65xx execution engine and the MPU's registers
    private ee65xx!: EE65xx;
    private registers!: Registers;

    // source and symbol maps
    private sourceMap!: SourceMap;
    private symbols!: Symbols;
    private cSymbols!: Map<string, ISymbol>;
    private cScopes!: Map<number, ISymbol[]>;

    // C function and assembly procedure entry/exit addresses
    private functions!: Map<string, ISymbol>;
    private procedures!: Map<string, ISymbol>;
    private entryPoints = new Map<number, string>();
    private exitPoints = new Map<number, string>();
    private basicCallStack = false;

    // autogenerated call stack
    // The runtime stack is generated from C function and assembly procedure entry
    // and exit points during each "step", or in basicCallStack directly in the
    // step request methods.
    private runtimeStack: IRuntimeStackFrame[] = [];
    private inStartup: boolean;

    // UI call stack
    // This is the call stack last displayed in the UI.  It is recreated each time
    // the UI asks for a stack trace (usually on a pause).  It can differ from the
    // runtime stack when we've stopped in a C file's autogenerated assembly source.
    // In this case the call stack will have an extra stack frame so this source
    // is available to the UI.  Stepping functions refer to the top of the stack
    // to control the stepping behavior relative to the source without having to
    // dereference the current position again each step to determine the source file.
    private callStack: IRuntimeStackFrame[] = [];
    private callbackFrame!: IRuntimeStackFrame;
    private callbackAddr = 0;

    // identify if we are in a JSR/JSL during stepping, if so, extra assembler
    // stackFrames have been added to the call stack to the level indicated
    private inCall: number = 0;

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

        // create 65xx execution engine
        //this.createExecutionEngine();
        this.ee65xx = new EE65xx(this);

        this.inStartup = true;
    }

    // *******************************************************************************************
    // protected DAP Request methods

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

        // DAP and VS Code offer several options to terminate and restart a debugging session
        // depending on the capabilities set during configuration.  Currently, termination only
        // involves disposing of the integrated terminal and since the user may have modified
        // read only memory and since I don't store launch args, it's easiest to take the simple
        // approach and let VS Code handle the restart by setting the following four options to false.

        // two step stop, terminateRequest called on stop button prior to disconnectRequest
        // if supportsRestartRequest is false and this is true, restart button calls terminateRequest w/ restart=true, but no other args
        response.body.supportsTerminateRequest = false;

        response.body.supportSuspendDebuggee = false;        // suspendDebuggee property sent with disconnectRequest (I haven't seen this sent w/ disconnectRequest)
        response.body.supportTerminateDebuggee = false;      // terminateDebuggee property sent with disconnectRequest (set true on restart button, assuming supportsRestartRequest is false)

        // if true, restart button calls restartRequest w/ original launch args
        // otherwise restart button performs a restart sequence, with calls to:
        //  1. terminateRequest (if active) with the restart property set to true
        //  2. disconnectRequest with the restart property set to true
        //  3. launchRequest with original launch args
        response.body.supportsRestartRequest = false;

        response.body.supportsDataBreakpoints = true;       // add data breakpoints via context menu on certain register variables
        response.body.supportsFunctionBreakpoints = true;   // add functional breakpoints in Breakpoints pane
        response.body.supportsLogPoints = true;             // sends logMessage (if set) to setBreakPointsRequest, otherwise it isn't even if hitCondition is set (also sends hitCondition if set even if supportsHitConditionalBreakpoints is false)

        // Note that condition, hitCondition and logMessage can all be set at once.
        // VS Code doesn't process or act on any of these other than passing them on to the debug adapter.
        // Note that these can be set in a source file before the debug adapter is started and can always
        // be set from the editor breakpoint context menu (which appears alway active regardless of these settings
        // unlike the Breakpoint pane edit icon (and context menu item) which is only active when supportsConditionalBreakpoints is true).
        response.body.supportsConditionalBreakpoints = true;  // enables Edit Condition in Breakpoint view (but it's appears to be always enabled in editor breakpoint context menu)
        response.body.supportsHitConditionalBreakpoints = true;  // if true sends hitCondition (if set) to setBreakPointsRequest, otherwise it isn't even if hitCondition is set

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

        response.body.supportsSetVariable = true;       // VS Code adds Set Value to Variables view context menu
        response.body.supportsSetExpression = true;     // VS Code adds Set Value to Watchs view context menu (otherwise, if both of these are true it doesn't seem to do anything even if a Variable's evaluateName property is set)

        response.body.supportsReadMemoryRequest = true;     // view binary data in hex editor w/ memoryReference
        response.body.supportsWriteMemoryRequest = true;    // modify binary data in hex editor w/ memoryReference

        response.body.supportsLoadedSourcesRequest = true;  // adds the Loaded Scripts Explorer to debug pane (shows a list of modules ease of opening in editor without leaving debug view)
        response.body.supportsEvaluateForHovers = true;

        // possible future capabilities
        // Instruction breakpoints (a breakpoint at a memory location)
        // are available through the disassembly view.  These breakpoints
        // could be useful for Forth code (disassembly of that should be
        // fairly formulaic).
        //response.body.supportsDisassembleRequest = true;    // add "Open Disassembly View to call stack and editor context menus.  Active if instructionPointerReference is defined."
        //response.body.supportsSteppingGranularity = true;   // seems to be set to instruction when in Disassembly View, unclear otherwise.  Can be used by step instructions to indicate you're in Disassembly View
        //response.body.supportsInstructionBreakpoints = true;  // available in Disassembly View

        // step back is possible if we save state after each step, but this could bog down the execution engine
        //response.body.supportsStepBack = true;      // activates step back and reverse buttons (there are no corresponding Run menu items)

        //response.body.supportsValueFormattingOptions = true;  // *** TODO: test this *** not sure this does anything in VS Code

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
        //response.body.supportsCompletionsRequest = true; // in REPL (see mock-debug)
        //response.body.completionTriggerCharacters = [".", "["];
        //response.body.supportsBreakpointLocationsRequest = true;

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

    // called before disconnectRequest on stop button if supportsTerminateRequest is true
    // called on restart button if supportsRestartRequest is false (no launch arguments included)
    protected terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request): void {
        if (args.restart) {
            //
        } else {
            //
        }
        this.sendResponse(response);
    }

    // called on stop button or on TerminatedEvent
    // also called on restart if supportsRestartRequest is false, then kicks off launchRequest
    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
        if (args.restart) {
            // stop execution engine's run loop
            this.ee65xx.terminate(false);

            // clean up da65xx and ee65xx in preparation for restart
            // VS Code will call launchRequest again to restart
            //this.createExecutionEngine();
            this.ee65xx = new EE65xx(this);

            // registers, sourceMap and symbols are reset in launchRequest

            this.functions.clear();
            this.procedures.clear();
            this.entryPoints.clear();
            this.exitPoints.clear();
            this.basicCallStack = false;

            this.runtimeStack = [];
            this.inStartup = true;

            this.callStack = [];

            this.inCall = 0;

            this._variableHandles = new Handles<any>();
            this.scopes.clear();
            this.stacks.clear();

            Debug65xxSession.threadID = 1;

            this.program = '';
            this.cwd = '';
            this.src = '';

            this.breakpoints.clear();
            this.dataBreakpoints.clear();
            this.functionBreakpoints.clear();
            this.hitConditionBreakpoints.clear();

            this.breakpointId = 1;

            this._valuesInHex = true;
            this._addressesInHex = true;

            this.namedExceptions = undefined;
            this.opcodeExceptions = undefined;

            terminalClear();

        } else {
            //
            this.ee65xx.terminate(true);
            this.sendEvent(new StoppedEvent('pause', Debug65xxSession.threadID));
        }

        this.sendResponse(response);
    }

    // called on restart button if supportsRestartRequest is true (launch arguments included)
    protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }

    //protected async attachRequest(response: DebugProtocol.AttachResponse, args: IAttachRequestArguments) {
    //    return this.launchRequest(response, args);
    //}

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
        let input: number | undefined;
        let output: number | undefined;
        let binBase = '';
        let list = '';
        let extension = '';
        let cpu = '65816';

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
            input = parseInt(args0.input);
            output = parseInt(args0.output);

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
            if (args0.cpu) {
                cpu = args0.cpu;
            }
        } else {
            extension = path.extname(this.program);
            binBase = path.basename(this.program, extension);
            sbin = path.join(this.cwd, binBase + '.bin');
            this.src = this.cwd;
            list = this.cwd;
        }

        // start 65xx execution engine
        this.ee65xx.start(cpu, sbin, fbin, acia, via, !!args.stopOnEntry, !args.noDebug, input, output);
        const mpu = this.ee65xx.mpu;
        const memory = this.ee65xx.obsMemory.memory;

        // create MPU registers and flags breakdown
        this.registers = new Registers(mpu);

        // prepare source map
        this.sourceMap = new SourceMap(this.src, list, binBase, extension, memory, this.registers);
        this.symbols = this.sourceMap.symbols;
        this.cSymbols = this.sourceMap.cSymbols;
        this.cScopes = this.sourceMap.cScopes;
        this.functions = this.sourceMap.functions;
        this.procedures = this.sourceMap.procedures;

        // create assembly procedure and C function entry/exit maps
        // The runtime call stack is created by tracking function and procedure (routines) entries and
        // exits.  This assumes a routine is only entered and exited at it's starting and exit addresses
        // and that the exit is a single opcode instruction (eg RTS) so we're able to tell that we're at
        // its exit address at the step that executes the end of the routine.
        // cc65 seems to conform to this for autogenerated assembly (though I haven't confirmed that
        // this is universal).  There is no such requirement for assembly procedures though, so we have
        // to enforce it here.  Without this we have no means to step out of a routine as we can't
        // really tell that we've stepped to the end of the procedure.

        // process assembly procedures first
        for (const [name, sym] of this.procedures.entries()) {
            if (sym.address && sym.size) {
                const exit = sym.address + sym.size - 1;
                const exitOpcode = mpu.memory[exit];
                if ((exitOpcode === 0x60) || (exitOpcode === 0x6B)) {
                    // *** TODO: consider ways to force a single exit point for procedures
                    // until then we won't adjust the return stack for procedures ***
                    //this.entryPoints.set(sym.address, name);
                    //this.exitPoints.set(exit, name);
                }
            }
        }

        // process C functions entry/exit
        // this will overwrite any equivalent autogenerated assembly procedures at those addresses
        // *** TODO: this puts C frames on stack when stepping through assembly,
        //     do we need separate assembly/C entry/exit? ***
        for (const [name, csym] of this.functions.entries()) {
            if (csym.address && csym.size) {
                this.entryPoints.set(csym.address, name);
                this.exitPoints.set(csym.address + csym.size - 1, name);
            }
        }

        if ((this.entryPoints.size === 0) && (this.exitPoints.size === 0)) {
            this.basicCallStack = true;
        }

        // register the 65xx scopes
        this.registerScopes(mpu, memory, fbin);

        // VS Code will end the configuration sequence by calling 'configurationDone' request.
        this.sendEvent(new InitializedEvent());

        // wait 1 second until configuration has finished (and configurationDoneRequest has been called)
        // *** TODO: do we need more time if more breakpoints are added? ***
        await this._configurationDone.wait(1000);

        this.sendResponse(response);
        if (!!args.stopOnEntry && !args.noDebug) {
            // initialize runtimeStack
            this.manageCallStackEntry(mpu.address);

            this.sendEvent(new StoppedEvent('entry', Debug65xxSession.threadID));
        }
    }

    // *** VS Code requires "setBreakPointsRequest" capitalization here ***
    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
        const actualBreakpoints: DebugProtocol.Breakpoint[] = [];
        const fileId = this.sourceMap.getSourceId(args.source.path as string);
        const breakpoints = args.breakpoints || [];

        // clear all breakpoints for this file
        this.clearBreakpoints(fileId);

        // set and verify source breakpoints for file
        for (const [i, bp] of breakpoints.entries()) {
            actualBreakpoints.push(this.setBreakpoint(fileId, bp));
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

    // create callStack from runtimeStack
    // Note that logic here must reflect that VS Code may call stackTraceRequest multiple times.
    // I create and put stackFrame on top of the callStack each pass to accomodate this behavior.
    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
        const pos = this.sourceMap.get(this.registers.address);
        let stackFrame: IRuntimeStackFrame | undefined = undefined;

        if (pos !== undefined) {
            const file = this.sourceMap.getSourceFile(pos.fileId);
            const topFrame = this.runtimeStack[0];

            // if we're in the same file as the top runtime stack frame then we
            // only need to update the source line and current address unless
            // we're using a basicCallStack which is always added in stackFrame
            if (topFrame && (topFrame.fileId === pos.fileId) && !this.basicCallStack) {
                // update address and line of top stack frame
                topFrame.address = pos.address;
                topFrame.line = pos.sourceLine;
            } else {
                // If the top runtime stack file and current position file aren't equal then
                // we have stopped outside the runtime stack source and have to add a stack frame
                // for the UI to display the source properly.  We don't add this to runtimeStack
                // because there is no logic to remove it when we return from what got us here.

                // also basicCallStack always uses stackFrame for it's top stack frame because
                // it is not maintained separately
                stackFrame = {
                    index: 9999,
                    name: pos.instruction,
                    file: file,
                    line: pos.sourceLine,
                    address: pos.address,
                };
            }
        } else {
            // Position is undefined so we're at an address w/o source.
            // If this is at startup, attempt to step to a main function,
            // otherwise add a stackframe indicating no source available.
            if (this.inStartup) {
                const symbol = this.functions.get("main");

                // step to main function if ther is one
                // *** this assumes the startup code calls the main function ***
                if (symbol && symbol.address) {
                    // symbol.address is known and has been set programatically
                    // so we can use the synchronous stepTo without worry
                    const addr = this.ee65xx.stepTo(symbol.address);

                    if (addr !== symbol.address) {
                        const pos = this.sourceMap.get(this.registers.address);

                        // we're not at the main function, either we've hit
                        // a breakpoint in some user startup code prior to
                        // getting to the main function
                        if (pos !== undefined) {
                            const file = this.sourceMap.getSourceFile(pos.fileId);
                            stackFrame = {
                                index: 9999,
                                name: pos.instruction,
                                file: file,
                                line: pos.sourceLine,
                                address: pos.address,
                            };
                        } else {
                            // or we have a problem (we shouldn't get here)
                        }
                    }
                }

                // for our purposes, startup is complete after we've attempted
                // to go to the main function.  VS Code will normally call
                // stackTraceRequest more than once so more refinement here
                // would either be overwritten or require more logic
                this.inStartup = false;
            } else {
                stackFrame = {
                    index: 9999,
                    name: "no source available",
                    file: '',
                    line: 0,
                    address: this.ee65xx.mpu.address
                };
            }
        }

        this.callStack = this.runtimeStack.slice();    // we just want a copy
        if (stackFrame) {
            // *** TODO: frame index likely off here, does it matter? ***
            this.callStack.unshift(stackFrame);
        }

        response.body = {
            stackFrames: this.callStack.map((f, ix) => {
                // fix up source file path
                const sf: DebugProtocol.StackFrame = new StackFrame(f.index, f.name, this.createSource(f.file), this.convertDebuggerLineToClient(f.line));
                sf.moduleId = f.file;
                sf.column = 0;
                //sf.name = f.name;
                if (f.file.endsWith(".c")) {
                //    sf.name = f.name;
                } else {
                    const address = this.formatAddress(f.address, 6);
                    sf.name = `${address} ${f.name}`;
                    sf.instructionPointerReference = address;
                }
                // sf.presentationHint = 'subtle'; // displayed in italic
                // sf.presentationHint = 'label'; // displayed in italic without line/column info

                return sf;
            }),
            // 4 options for 'totalFrames':
            //omit totalFrames property: 	// VS Code has to probe/guess. Should result in a max. of two requests
            //totalFrames: stk.count			// stk.count is the correct size, should result in a max. of two requests
            //totalFrames: 1000000 			// not the correct size, should result in a max. of two requests
            //totalFrames: endFrame + 20 	// dynamically increases the size with every requested chunk, results in paging
            totalFrames: this.callStack.length // stk.count is the correct size, should result in a max. of two requests

        };
        this.sendResponse(response);
    }

    // send Variable pane scopes to UI according to the runtime stack
    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
        const rts = this.runtimeStack.length;
        const index = args.frameId;
        const scopes: Scope[] = [];

        scopes.push(new Scope("Registers", this.scopes.get('registers')!, false));
        scopes.push(new Scope("Stacks", this.scopes.get('stacks')!, false));
        if (rts > index) {
            const scope = this.runtimeStack[rts - index - 1].scope;
            const name = this.runtimeStack[rts - index - 1].name;
            if (scope !== undefined) {
                scopes.push(new Scope("Local: " + name, this.scopes.get('locals' + scope.toString())!, false));
            }
        }

        // TODO: consider adding globals ***
        // new Scope("Globals", this.scopes.get('globals')!, true)

        response.body = {
            scopes: scopes
        };
        this.sendResponse(response);
    }

    // write data to memoryReference from hex editor window (writes on save)
    protected async writeMemoryRequest(response: DebugProtocol.WriteMemoryResponse, { data, memoryReference, offset = 0 }: DebugProtocol.WriteMemoryArguments) {
        const decoded = base64.toByteArray(data);
        const memory = this.ee65xx.obsMemory.memory;
        const address = parseInt(memoryReference, 16);
        const start = address + offset;

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
                    //value: name === 'P' ? (value as number).toString(2).padStart(8, '0') : this.formatNumber(value),
                    value: name === 'P' ? this.registers.status() : this.formatNumber(value),
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

                // prepare our own paged reference to control display
                for (let i = 0; i < length; i += 16) {
                    variables.push({
                        name: (start + i).toString(16),
                        value: toHexString(stack!.memoryRef.slice(start + i, start + i + Math.min(length, 16)), stack!.size),

                        // display as paged memory, up to 16 bytes at a time
                        // I don't want to create a handle for every memory range and
                        // we need a way to handle a memory range that starts with 0.
                        // variablesReference must be > 0 and < $7fffffff.  Since the
                        // 65816 can only reference $1000000 bytes of memory, we'll
                        // use $10000000 as a flag for a paged memory request
                        // The specific reference is start address * 16 + page length
                        variablesReference: 0x10000000 + (start + i) * 16 + Math.min(length, 0xf),

                        // activate hex editor icon
                        memoryReference: (start + i).toString(16)
                    });
                }
            }
        } else if (scope && (scope as string).startsWith('locals')) {
            const sc = parseInt((scope as string).slice(6));
            const sp = this.scopeToSP(sc);

            if ((sp !== undefined) && (sc !== undefined)) {
                const lSymbols = this.cScopes.get(sc);
                if (lSymbols) {
                    const mem = this.ee65xx.obsMemory.memory;
                    lSymbols.forEach(ls => {
                        variables.push({
                            name: ls.name,
                            value: getMemValue(mem, sp + ls.offset! + (this.ee65xx.mpu.dbr << 16), ls.size!).toString(16),
                            variablesReference: 0,
                        });
                    });
                }
            }
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
        } else if (ref >= 0x10000000) {
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

                start = Math.trunc((ref & 0xfffffff) / 16);
                end = start + ((ref & 0xfffffff) & 0xf);
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

    private getSP(): number | undefined {
        const sym = this.symbols.get("sp");
        let sp: number | undefined = undefined;
        if (sym) {
            const addr = sym.address;
            if (addr !== undefined) {
                sp = (this.ee65xx.obsMemory.memory[addr + 1] << 8) + this.ee65xx.obsMemory.memory[addr];
            }
        }
        return sp;
    }
    private scopeToSP(scope: number): number | undefined {
        let sp: number | undefined = undefined;
        for (const [index, frame] of this.runtimeStack.entries()) {
            if (frame.scope === scope) {
                sp = frame.sp;
                break;
            }
        }
        return sp;
    }
    private getLocalSym(name: string, syms: ISymbol[]): ISymbol | undefined {
        let lsym: ISymbol | undefined = undefined;
        for (const [index, sym] of syms.entries()) {
            if (sym.name === name) {
                lsym = sym;
                break;
            }
        }
        return lsym;
    }

    // set the referenced variable to the requested value
    protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {

        var variable: DebugProtocol.Variable;
        const ref = args.variablesReference;
        const scope = this._variableHandles.get(ref);
        var name = args.name;
        const x = this.expEval(args.value);
        let value: number | undefined = undefined;

        if (typeof x === 'number') {

            if (scope === 'registers') {
                this.registers.setRegister(name, x);

                // inform VS Code UI of needed updates
                if ((name === 'PC') || (name === 'K')) {
                    // program counter or program bank register has changed
                    // force update in UI by issuing a continued and a new stopped event
                    this.sendEvent(new ContinuedEvent(Debug65xxSession.threadID));
                    this.sendEvent(new StoppedEvent('stopOnPCUpdate', Debug65xxSession.threadID));
                } else if (name === 'P') {
                    // status register has changed, force UI to update registers and flags
                    // *** TODO: consider limiting this update for change to M or X flags ***
                    if (this._useInvalidatedEvent) {
                        // *** we lose the current line highlight in the editor if we invalidate
                        // just the registers and flags scopes; this doesn't happen if we
                        // invalidate the entire Variables area ***
                        //this.sendEvent(new InvalidatedEvent(['registers', 'flags']));
                        this.sendEvent(new InvalidatedEvent(['variables']));
                    }
                }

                // get actual updated register value
                value = this.registers.getRegister(name);
            } else if (scope === 'flags') {
                this.registers.setFlag(name, x);

                // inform VS Code UI of needed updates
                // status register has changed, force UI to update registers and flags
                // w/o this the status register top level line will be incorrect at a minimum
                // *** TODO: consider limiting this update to only if a change occured ***
                if (this._useInvalidatedEvent) {
                    // *** we lose the current line highlight in the editor if we invalidate
                    // just the registers and flags scopes; this doesn't happen if we
                    // invalidate the entire Variables area ***
                    //this.sendEvent(new InvalidatedEvent(['registers', 'flags']));
                    this.sendEvent(new InvalidatedEvent(['variables']));
                }

                // get actual updated flag value
                value = this.registers.getFlag(name);
            } else if (scope && (scope as string).startsWith('locals')) {
                const sc = parseInt((scope as string).slice(6));
                const sp = this.scopeToSP(sc);

                if ((sp !== undefined) && (sc !== undefined)) {
                    const lSymbols = this.cScopes.get(sc);
                    if (lSymbols) {
                        const mem = this.ee65xx.obsMemory.memory;
                        const ls = this.getLocalSym(args.name, lSymbols);
                        if (ls) {
                            setMemValue(x, mem, sp + ls.offset!, ls.size!);
                            value = x;
                        }
                    }
                }
            } else if (ref < 0x10000000) {
                // can't change stack summary
                // *** TODO: consider if this is worthwhile or how to remove "Set Value" menu item ***
            } else if (ref >= 0x10000000) {
                //const address = Math.trunc(ref / 16);
                const address = parseInt(args.name, 16);
                const ref = args.variablesReference & 0xfffffff;
                const memoryReference = Math.trunc(ref / 16);

                // currently we're only changing bytes here, limit entry to a byte
                // *** TODO: this needs updated if we add symbols to Variables pane ***
                //value = x & (this.ee65xx.mpu.mode ? 0xff : 0xffff);
                value = x & 0xff;
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
                //if (this._useMemoryEvent) {
                if (true) {
                    // memoryReference here needs to be the memoryReference of the hex editor window,
                    // not the reference of the memory changed
                    // VSCode seems to know which location to update without setting offset to the address
                    //this.sendEvent(new MemoryEvent(memoryReference.toString(16), address, 1));
                    this.sendEvent(new MemoryEvent(memoryReference.toString(16), 0, 1));
                }
            }

            // Mock-Debug version with interesting ways of finding variables
            //const container = this._variableHandles.get(args.variablesReference);
            //const rv = container === 'locals'
            //    ? this.ee65xx.getLocalVariable(args.name)
            //    : container === 'register'
            //    ? this.ee65xx.getRegisterVariable(args.name)
            //    : container instanceof RuntimeVariable && container.value instanceof Array
            //    ? container.value.find(v => v.name === args.name)
            //    : undefined;
            //
            //if (rv) {
            //    rv.value = this.convertToRuntime();
            //    response.body = this.convertFromRuntime(rv);
            //    if (rv.memory && rv.reference) {
            //        this.sendEvent(new MemoryEvent(String(rv.reference), 0, rv.memory.length));
            //    }
            //}

            if (typeof value === 'number') {
                variable = {
                    name: args.name,
                    value: value.toString(16),
                    variablesReference: 0
                };

                response.body = variable;
            } else {
                response.success = false;
            }
        } else if ((scope === 'registers') && (name === 'P')) {
            // allow setting status register with characters
            this.registers.setSatusRegister(args.value);

            // inform VS Code UI of needed updates
            // status register has changed, force UI to update registers and flags
            // *** TODO: consider limiting this update to only if a change occured ***
            if (this._useInvalidatedEvent) {
                // *** we lose the current line highlight in the editor if we invalidate
                // just the registers and flags scopes; this doesn't happen if we
                // invalidate the entire Variables area ***
                //this.sendEvent(new InvalidatedEvent(['registers', 'flags']));
                this.sendEvent(new InvalidatedEvent(['variables']));
            }

            // get actual updated register value
            value = this.registers.getRegister(name);
        } else {
            response.success = false;
        }

        this.sendResponse(response);
    }

    // pause execution
    // *** (note that the response must be sent before the stopped event) ***
    protected pauseRequest(response: DebugProtocol.PauseResponse): void {
        this.sendResponse(response);
        this.ee65xx.pause();
        if (!this.ee65xx.mpu.waiting) {
            this.sendEvent(new StoppedEvent('pause', Debug65xxSession.threadID));
        }
        else {
            const se = new StoppedEvent('pause', Debug65xxSession.threadID);
            (se as DebugProtocol.StoppedEvent).body.description = 'Paused, waiting for input';
            this.sendEvent(se);
        }
    }

    // continue execution
    // if we have a basic call stack, clear it
    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
        if (this.basicCallStack) {
            // clear basic call stack
            this.runtimeStack = [];
        }

        this.ee65xx.continue();
        this.sendResponse(response);
    }

    // execute the current line, stepping over C functions and JSR or JSL subroutines
    // *** (note that the response must be sent before the stopped event) ***
    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
        const mpu = this.ee65xx.mpu;
        if (!mpu.waiting) {
            const frame = this.callStack[0];

            if (frame.file.endsWith(".c")) {
                // in C code, step over the current line

                // we need to step over the current C code line
                // we'll do this by stepping until we come to another C code line but there
                // is no guarantee that we'll ever get there (we could end up in a assembly
                // loop for example).  Thus send the UI response now.  Otherwise UI will be
                // unresponsive if we get stuck in loop.
                this.sendResponse(response);

                if ((frame.firstAddress !== undefined) && (frame.lastAddress !== undefined)) {
                    if (mpu.address === frame.lastAddress!) {
                        // we're at the end of the current function so we can't
                        // step any further within it
                        if (frame.name === "main") {
                            // we're at end of main, just step into exit code
                            this.ee65xx.step();
                            this.sendEvent(new StoppedEvent('step', Debug65xxSession.threadID));
                        } else {
                            // else step to next C instruction
                            this.ee65xx.continueUntil(this.stepToNextC);
                        }
                    } else {
                        this.callbackFrame = frame;
                        this.ee65xx.continueUntil(this.stepToFrame);
                    }
                }
            } else {
                const opCode = mpu.opCode;

                // we're stepping through other source code
                // step over JSR and JSL
                // note that we'll break if we hit a breakpoint
                if ((opCode === 0x20) || (opCode === 0x22)) {
                    let address = mpu.address + ((opCode === 0x22) ? 4 : 3);
                    // address is known and has been set programatically
                    // so we can use the synchronous stepTo without worry
                    address = this.ee65xx.stepTo(address);
                    if (mpu.address !== address) {
                        this.sendResponse(response);
                        this.sendEvent(new StoppedEvent('stopOnBreakpoint', Debug65xxSession.threadID));
                        return;
                    }
                } else {
                    // just take a single step

                    // take top frame from call stack if we're have a
                    // basic call stack and are returning from a subroutine (RTS and RTL)
                    if ((opCode === 0x60) || (opCode === 0x6B) && this.basicCallStack) {
                        if (this.inCall) {
                            this.inCall--;
                            this.runtimeStack.shift();
                        }
                    }
                    this.ee65xx.step();
                }
                this.sendResponse(response);
                this.sendEvent(new StoppedEvent('step', Debug65xxSession.threadID));
            }
        }
        else {
            this.sendResponse(response);
            this.sendWaitingForInput();
        }
    }

    private sendWaitingForInput() {
        const se = new StoppedEvent('pause', Debug65xxSession.threadID);
        (se as DebugProtocol.StoppedEvent).body.description = 'Paused, waiting for input';
        this.sendEvent(se);
    }

    // execute the current line, stepping into C function or JSR or JSL subroutines
    // *** (note that the response must be sent before the stopped event) ***
    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
        const mpu = this.ee65xx.mpu;
        if (!mpu.waiting) {
            const ofile = this.callStack[0].file;
            if (ofile.endsWith(".c")) {
                // we're in a C file, step into can be stepping into a C function
                // or assembly code.  If the former, a single step will leave us
                // within the autogenerated assembly source, if available.  We need
                // multiple steps to step through the C function call boilerplate
                // and get to the C function.  If the latter, a single step takes
                // us there and we'll be in a different file.

                // take a single step
                this.ee65xx.step();

                const pos = this.sourceMap.get(mpu.address);
                const nfile = pos ? this.sourceMap.getSourceFile(pos.fileId) : "";

                // if the original file and the new file are the same then we're
                // done, because this won't happen with a C function.
                // Otherwise, we have more work to do.
                //if (nfile !== ofile) {
                if (pos && pos.fileId !== this.callStack[0].fileId) {
                    const oext = path.extname(ofile);
                    const obasename = path.basename(ofile, oext);
                    const next = path.extname(nfile);
                    const nbasename = path.basename(nfile, next);

                    // we need to step to the next C instruction if the base names
                    // are the same or if we're now in code without a source file
                    if ((nfile === '') || (nbasename === obasename)) {
                        this.sendResponse(response);
                        this.ee65xx.continueUntil(this.stepToNextC);
                        return;
                    }
                }
            } else {
                // we're not in a C file, just take a single step

                // adjust basic call stack if stepping into or out of a routine
                if (this.basicCallStack) {
                    const opCode = mpu.opCode;
                    if ((opCode === 0x20) || (opCode === 0x22)) {
                        const pos = this.sourceMap.get(this.registers.address);
                        if (pos !== undefined) {
                            // set up stackframe for step into JSR and JSL
                            const nextAddress = pos.address + ((opCode === 0x22) ? 4 : 3);
                            this.inCall++;
                            this.runtimeStack.unshift({
                                index: this.runtimeStack.length,
                                name: pos.instruction,
                                file: this.sourceMap.getSourceFile(pos.fileId),
                                fileId: pos.fileId,
                                line: pos.sourceLine,
                                address: pos.address,
                                nextAddress: nextAddress
                            });
                        }
                    }
                    else if ((opCode === 0x60) || (opCode === 0x6B)) {
                        this.runtimeStack.shift();
                        if (this.inCall) {
                            this.inCall--;
                            this.runtimeStack.shift();
                        }
                    }
                }

                this.ee65xx.step();
            }
            this.sendResponse(response);
            this.sendEvent(new StoppedEvent('step', Debug65xxSession.threadID));
        }
        else {
            this.sendResponse(response);
            this.sendWaitingForInput();
        }
    }

    // continue execution until we're out of the current call frame, otherwise single step
    // *** (note that the response must be sent before the stopped event) ***
    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
        if (!this.ee65xx.mpu.waiting) {
            // The runtime stack will always have at least one frame if we have something
            // to step out of.  Note that we cannot step out of the last runtime frame
            // (for example the C main function or reset vector subroutine).
            const topFrame = this.runtimeStack[0];

            // do we have something to step out of?
            if (topFrame) {
                if (this.basicCallStack) {
                    const nextAddress = topFrame.nextAddress;

                    // step to next address if we have one
                    if (nextAddress !== undefined) {
                        // nextAddress is known and has been set programatically
                        // so we can use the synchronous stepTo without worry
                        const addr = this.ee65xx.stepTo(nextAddress);
                        if (addr !== nextAddress) {
                            this.sendResponse(response);
                            this.sendEvent(new StoppedEvent('stopOnBreakpoint', Debug65xxSession.threadID));
                            return;
                        } else {
                            this.runtimeStack.shift();
                            this.inCall--;
                        }
                    } else {
                        // otherwise, take a single step
                        this.ee65xx.step();
                    }
                }
                else {
                    const rlen = this.runtimeStack.length;
                    const clen = this.callStack.length;

                    // if the runtime and call stacks are the same length and > 1
                    // then we simply need to continue to the next runtime stack
                    if ((rlen === clen) && ((rlen + clen) > 2)) {
                        this.callbackFrame = this.runtimeStack[1];
                        this.sendResponse(response);
                        this.ee65xx.continueUntil(this.stepToFrame);
                        return;
                    } else if (clen > rlen) {
                        // if the call stack is longer than the runtime stack then
                        // we can just return to the top of the runtime stack
                        this.callbackFrame = topFrame;
                        this.sendResponse(response);
                        this.ee65xx.continueUntil(this.stepToFrame);
                        return;
                    } else {
                        // otherwise just take a single step per our code type
                        if (topFrame.file.endsWith(".c")) {
                            if (topFrame.name === 'main') {
                                if (topFrame.address !== topFrame.lastAddress!) {
                                    const addr = this.ee65xx.stepTo(topFrame.lastAddress!);
                                    // take another step to exit the main function if we've
                                    // made it to it's last address, otherwise we've stopped
                                    // early on a breakpoint
                                    if (addr === topFrame.lastAddress!) {
                                        this.ee65xx.step();
                                    } else {
                                        this.sendResponse(response);
                                        this.sendEvent(new StoppedEvent('stopOnBreakpoint', Debug65xxSession.threadID));
                                        return;
                                    }
                                } else {
                                    // just take a single step if we're at the end of the main function
                                    // (this allows us to step through exit code)
                                    this.ee65xx.step();
                                }
                            } else {
                                // step to next C statement in current function
                                this.sendResponse(response);
                                //this.ee65xx.continueUntil(this.stepToNextC);
                                this.callbackFrame = topFrame;
                                this.ee65xx.continueUntil(this.stepToFrame);
                                return;
                            }
                        } else {
                            this.ee65xx.step();
                        }
                    }
                }
            } else {
                // otherwise, take a single step
                this.ee65xx.step();
            }
            this.sendResponse(response);
            this.sendEvent(new StoppedEvent('step', Debug65xxSession.threadID));
        }
        else {
            this.sendResponse(response);
            this.sendWaitingForInput();
        }
    }

    // process Watch and Hover variable requests and limited debug console REPL requests
    protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
        var result = '';
        var ref = 0;
        var mref: string | undefined = undefined;
        var iv: number | undefined = undefined;
        let expr = args.expression;

        switch (args.context) {
            case 'repl':
                // do we have an assignment expression?
                // parse expression into:
                // (\b[A-z]+[A-z0-9]*\b)      symbol
                // (?:\s*)                  optional whitespace (not captured)
                // (={1})                   one equals sign
                // (?:\s*)                  optional whitespace (not captured)
                // (.*)                     right hand side of expression
                const regExp = /(\b[A-z]+[A-z0-9]*\b)(?:\s*)(={1})(?:\s*)(.*)/;
                const match: RegExpExecArray | null = regExp.exec(args.expression);
                if (match && (match[2] === '=') && (match.length === 4)) {
                    // convert any symbols in the right hand side to their addresses
                    const value = this.expEval(match[3]);
                    if (typeof value === 'number') {
                        this.symbols.setValue(match[1], value);
                        result = value.toString(16);

                        // inform VS Code UI of needed updates
                        if ((match[1] === 'PC') || (match[1] === 'K')) {
                            // program counter or program bank register has changed
                            // force update in UI by issuing a continued and a new stopped event
                            this.sendEvent(new ContinuedEvent(Debug65xxSession.threadID));
                            this.sendEvent(new StoppedEvent('stopOnPCUpdate', Debug65xxSession.threadID));
                        } else if (match[1] === 'P') {
                            // status register has changed, for UI to update variables
                            if (this._useInvalidatedEvent) {
                                this.sendEvent(new InvalidatedEvent(['variables']));
                            }
                        }
                    } else {
                        result = '???';
                    }
                    break;
                }

                // else fall through to evaluate expression

            case 'hover':
                // cc65 C variables are represent internally prefixed with a '_'
                if ((args.context === 'hover') && this.callStack[0].file.endsWith('.c')) {
                    expr = '_' + expr;
                }
                // fall through to evaluate hover

            case 'watch':
                const symbol = this.symbols.get(expr);

                if (symbol) {
                    let symString = this.symbols.getString(expr);
                    if (symString) {
                        result = symString;
                    }

                    // do some special formating if we have a memory symbol
                    const size = symbol.size;
                    let address = symbol.address;
                    if ((address !== undefined) && size) {
                        // we must add the DBR to the address of C global variables outside of Bank 0 as the debug file won't include this
                        // as such, the symbol string value changes as well
                        // *** TODO: the startWith('_') check is incomplete as user may have a global variable starting with it
                        //           we really need to check the second character too ***
                        if (this.callStack[0].file.endsWith('.c') && this.ee65xx.mpu.dbr > 0 && expr.startsWith('_')) {
                            address += this.ee65xx.mpu.dbr << 16;
                            symString = this.ee65xx.obsMemory.memory[address].toString(16);
                            result = symString;
                        }
                        if (args.context === 'hover') {
                            result = address.toString(16) + ': ' + symString;
                        } else if (args.context === 'watch') {
                            if (size > 4) {
                                ref = 0x10000000 + address;
                                //ref = (address * 16) + Math.min(size, 0xff);
                                // *** TODO: paged variables will not display the View Binary Data icon
                                // see: https://github.com/microsoft/vscode-mock-debug/issues/78.
                                // Have to have a variable represent this in an expanded view.  Consider adding. ***
                                //mref = address.toString(16);
                                iv = size; // using indexedVariables triggers VS Code's paged variable interface
                            }
                        }
                    }
                } else if (args.expression.startsWith('[') && args.expression.endsWith(']') && args.expression.slice(1, -1).includes(':')) {
                    // we have a memory array request, [start:end]
                    // *** note hovering will never end up here as it won't capture a '[' or ']' ***
                    const exp = args.expression.slice(1, -1);

                    // check for a valid memory range
                    const range = exp.split(':');
                    if (range.length === 2) {
                        const start = this.expEval(range[0]);
                        const end = this.expEval(range[1]);
                        if ((typeof start === 'number') && (typeof end === 'number') && (end >= start)) {
                            const mem = this.ee65xx.obsMemory.memory;

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
                            break;
                        }
                    }
                    result = '???';
                } else {
                    // try to evaluate as an expression
                    const value = this.expEval(args.expression);
                    if (typeof value === 'number') {
                        result = value.toString(16);
                    } else {
                        if (args.context === 'hover') {
                            response.success = false;
                        } else {
                            result = '???';
                        }
                    }
                }
                break;

            default:
                // *** TODO: how do we get here? ***
                response.success = false;
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

        const symbol = this.symbols.get(args.expression);
        if (symbol) {
            const value = this.expEval(args.value);
            if (typeof value === 'number') {
                this.symbols.setValue(args.expression, value);
                response.body = { value: args.value };
                this.sendResponse(response);
            } else {
                this.sendErrorResponse(response, {
                    id: 1003,
                    format: `'{lexpr}' not an assignable expression`,
                    variables: { lexpr: args.value },
                    showUser: true
                });
            }
        } else {
            this.sendErrorResponse(response, {
                id: 1002,
                format: `variable '{lexpr}' not found`,
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
    // stepping request callbacks
    //
    // Methods that return true and send the UI a 'step' StoppedEvent when the
    // condition has been met and false otherwise.
    //
    // Separate stepping methods are possible but the benefit
    // of these callbacks is that we can use the execution engine's run method
    // and avoid UI lock up if we get stuck in a loop stepping to a particular
    // point in the code.
    //
    // Callback use: *** to come ***

    // Used to step to the next C statement
    // Returns true when current position is within a C file.
    // *** Assumes top of call stack is a valid C function (has firstAddress and
    // lastAddress) and that we're not at the end of the function (we can't step
    // further within the function). ***
    private stepToNextC(): boolean {
        const mpu = this.ee65xx.mpu;
        const pos = this.sourceMap.get(mpu.address);
        const file = pos ? this.sourceMap.getSourceFile(pos.fileId) : "";

        if (file.endsWith(".c")) {
            this.sendEvent(new StoppedEvent('step', Debug65xxSession.threadID));
            return true;
        }

        return false;
    }

    // Used to step to a stack frame (not necessarily it's start)
    // Returns true when current position is within callbackFrame.
    // This can be used to step over a C statement by setting callbackFrame
    // to the top call stack frame prior to calling the execution engine's
    // continueUntil method or to step out of a C function or assembly
    // routine by setting callbackFrame to the top runtime stack frame prior
    // to calling the execution engine's continueUntil method.
    // *** For stepping over, this assumes that we're not at the end of the
    // function (otherwise we can't step further within the function). ***
    // *** Assumes callbackFrame is valid and has been set prior to calling
    // the execution engine's continueUntil method . ***
    private stepToFrame(): boolean {
        const addr = this.ee65xx.mpu.address;
        const frame = this.callbackFrame;
        const pos = this.sourceMap.get(addr);
        const file = pos ? this.sourceMap.getSourceFile(pos.fileId) : "";

        // we're within callbackFrame when the mpu address is between the
        // frame's first and last addresses and the files are the same.
        // The file is key, because if we've stopped in a C function's
        // auto-generated assembly source code the address criterion will
        // already be satisfied.
        //if (file === frame.file) {
        if (pos && pos.fileId === frame.fileId) {
            if ((addr >= frame.firstAddress!) && (addr <= frame.lastAddress!)) {
                this.sendEvent(new StoppedEvent('step', Debug65xxSession.threadID));
                return true;
            }
        }
        return false;
    }

    // Used to step to a specific address
    // Returns true when current position is at callbackAddr.
    // *** callbackAddr set to desired address prior to calling continueUntil. ***
    private stepToAddr(): boolean {
        if (this.ee65xx.mpu.address === this.callbackAddr) {
            this.sendEvent(new StoppedEvent('step', Debug65xxSession.threadID));
            return true;
        }
        return false;
    }


    // *******************************************************************************************
    // public methods

    // check if a breakpoint has been hit
    // Currently breakpoints can be set on valid source code lines and cettain
    // registers (see code below).
    public checkBP(address: number): boolean {
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
                let isCondition: number | string | undefined = 0;
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
                            const value = this.expEval(exp.slice(1, -1));
                            return value ? value.toString(16) : '{???}';
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
                let isCondition: number | string | undefined = 0;
                let isHitCondition: number | string | undefined = 0;

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
            const exception = this.namedExceptions.toLowerCase();
//            let inst = this.sourceMap.get(address)?.instruction.slice(0, 3);
            const inst = this.sourceMap.get(address)?.instruction.split(' ');
            // *** TODO: might consider case sensitivity ***
            if (inst && exception?.includes(inst[0].toLowerCase())) {
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

    // update call stack if we've just entered a C function or assembly procedure
    public manageCallStackEntry(address: number) {
        const sourceMap = this.sourceMap.get(address);
        const fileId = sourceMap?.fileId;
        const entry = this.entryPoints.get(address);
        const rstack = this.runtimeStack;
        const rlen = rstack.length;

        if (entry) {
            let routine = this.functions.get(entry);
            if (!routine) {
                routine = this.procedures.get(entry);
            }

            if(routine !== undefined) {
                const start = address;
                const end = start! + routine.size! - 1;

                rstack.unshift({
                    index: rlen,
                    name: entry,
                    file: this.sourceMap.getSourceFile(fileId),
                    fileId: fileId,
                    scope: routine.scope,
                    sp: this.getSP(),
                    line: sourceMap!.sourceLine,
                    address: start,
                    firstAddress: start,
                    lastAddress: end
                });
            }
        } else if (sourceMap && (rlen > 0) && (fileId === rstack[0].fileId)) {
            // update top runtime stack frame if we're still in it
            if ((address > rstack[0].firstAddress!) && (address < rstack[0].lastAddress!)) {
                rstack[0].address = address;
                rstack[0].line = sourceMap!.sourceLine;
            }
        }
    }

    // update C stack if we've just exited a C function  or assembly procedure
    public manageCallStackExit(address: number) {
        const exit = this.exitPoints.get(address);

        // *** TODO: we can do some error checking here ***
        if (exit) {
            this.runtimeStack.shift();
        }
    }

    public exit(code: number) {
        // inform UI we've exited (this doesn't seem to affect anything else)
        this.sendEvent(new ExitedEvent(code));

        // inform UI that debugging has terminated, this initiates a
        // disconnectRequest which will terminate the execution engine
        // (we don't do that here because the stop button also calls disconnectRequest)
        this.sendEvent(new TerminatedEvent());
    }

    // *** TODO: consider adding exception code ***
    public stoppedOnException() {
        this.sendEvent(new StoppedEvent('exception', Debug65xxSession.threadID));
    }

    // *******************************************************************************************
    // private methods: startup factors and DAP Request related methods

    //private createExecutionEngine() {
        //this.ee65xx = new EE65xx(this);
        // setup event handlers
        // *** DA request responses are supposed to be sent before stopped events so it is
        // easier sending stop events directly from within DA65xx rather than passing them
        // on from EE65xx ***
        //this.ee65xx.on('stopOnEntry', () => {
        //    this.sendEvent(new StoppedEvent('entry', Debug65xxSession.threadID));
        //});
        //this.ee65xx.on('stopOnPause', () => {
        //    if (!this.ee65xx.mpu.waiting) {
        //        this.sendEvent(new StoppedEvent('pause', Debug65xxSession.threadID));
        //    }
        //    else {
        //        const se = new StoppedEvent('pause', Debug65xxSession.threadID);
        //        (se as DebugProtocol.StoppedEvent).body.description = 'Paused, waiting for input';
        //        this.sendEvent(se);
        //    }
        //});
        //this.ee65xx.on('stopOnStep', () => {
        //    this.sendEvent(new StoppedEvent('step', Debug65xxSession.threadID));
        //});
        //this.ee65xx.on('stopOnTerminate', () => {
        //    this.sendEvent(new StoppedEvent('pause', Debug65xxSession.threadID));
        //});
        //this.ee65xx.on('stopOnException', () => {
        //    this.sendEvent(new StoppedEvent('exception', Debug65xxSession.threadID));
        //});
        //this.ee65xx.on('exitRequest', (code: number) => {
        //    // inform UI we've exited (this doesn't seem to affect anything else)
        //    this.sendEvent(new ExitedEvent(code));
        //    // inform UI that debugging has terminated, this initiates a
        //    // disconnectRequest which will terminate the execution engine
        //    // (we don't do that here because the stop button also calls disconnectRequest)
        //    this.sendEvent(new TerminatedEvent());
        //});
    //}

    //private registerScopes(mpu: MPU65816, memory: Uint8Array, fbin: string) {
    private registerScopes(mpu: MPU65XX, memory: Uint8Array, fbin: string) {
        this.scopes.set('registers', this._variableHandles.create('registers'));
        this.scopes.set('flags', this._variableHandles.create('flags'));
        for (const [key, csym] of this.cScopes.entries()) {
            this.scopes.set('locals' + key.toString(), this._variableHandles.create('locals' + key.toString()));
        }
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
    private setBreakpoint(fileId: number | undefined, sbp: DebugProtocol.SourceBreakpoint): DebugProtocol.Breakpoint {
        const line = this.convertClientLineToDebugger(sbp.line);
        const bp: IBreakpoint = { verified: false, line, id: this.breakpointId++, address: 0, logMessage: sbp.logMessage };

        if (fileId !== undefined) {
            let bps = this.breakpoints.get(fileId);
            if (!bps) {
                bps = new Array<IBreakpoint>();
                this.breakpoints.set(fileId, bps);
            }

            // check if breakpoint is on a valid line
            const bpAddress = this.sourceMap.getRev(fileId, line);

            // if so, set it as valid and update its address
            if (bpAddress) {
                bp.verified = true;
                bp.address = typeof bpAddress === 'number' ? bpAddress : bpAddress[0];

                if (sbp.hitCondition) {
                    bp.hitCondition = sbp.hitCondition;

                    const hcbp = this.hitConditionBreakpoints.get(bp.address);
                    if (!hcbp) {
                        this.hitConditionBreakpoints.set(bp.address, { address: bp.address, hitCondition: sbp.hitCondition, hits: 0 });
                    } else {
                        // reset runtime breakpoint if hit condition changed
                        if (hcbp.hitCondition !== sbp.hitCondition) {
                            hcbp.hitCondition = sbp.hitCondition;
                            hcbp.hits = 0;
                        }
                    }
                }
                if (sbp.condition) {
                    bp.condition = sbp.condition;
                }
                bps.push(bp);

                // add breakpoints for other addresses if this breakpoint is associated with multiple addresses
                if (typeof bpAddress !== 'number') {
                    for (let i = 1; i < bpAddress.length; i++) {
                        const abp: IBreakpoint = { verified: true, line, id: this.breakpointId, address: bpAddress[i], logMessage: sbp.logMessage };
                        if (sbp.hitCondition) {
                            abp.hitCondition = sbp.hitCondition;
                            const addr = bpAddress[i];

                            const hcbp = this.hitConditionBreakpoints.get(addr);
                            if (!hcbp) {
                                this.hitConditionBreakpoints.set(addr, { address: addr, hitCondition: sbp.hitCondition, hits: 0 });
                            } else {
                                // reset runtime breakpoint if hit condition changed
                                if (hcbp.hitCondition !== sbp.hitCondition) {
                                    hcbp.hitCondition = sbp.hitCondition;
                                    hcbp.hits = 0;
                                }
                            }
                        }
                        if (sbp.condition) {
                            abp.condition = sbp.condition;
                        }
                        bps.push(abp);
                    }
                }
            }
        }

        return { verified: bp.verified, line: sbp.line, id: bp.id };
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
                        if (typeof bpAddress === 'number') {
                            bp.address = bpAddress;
                        } else {

                        }
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
            bpAddress = this.symbols.getAddress(fbp.name);
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

            if (fbp.condition) {
                bp.condition = fbp.condition;
            }
            if (fbp.hitCondition) {
                bp.hitCondition = fbp.hitCondition;

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
                let bpAddress = this.symbols.getAddress(name);

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

    private expEval(exp: string): number | string | undefined {
        const mem = this.ee65xx.obsMemory.memory;
        let result: number | string | undefined;
        let sexp = '';
        const utf8Encode = new TextEncoder();

        if (!hasMatchedBrackets(exp)) {
            // can't work with unmatched bracket
            return undefined;
        }

        // replace any character references with their ascii decoded byte equivalent
        exp = exp.replace(/(?:')(.{1})(?:')/g, (match, c) => {
            return utf8Encode.encode(c)[0].toString();
        });

        // handle complex array expressions: sym[exp] or a memory reference, [exp]
        // where exp includes arrays
        let start = exp.indexOf('[');
        let end = start >= 0 ? findClosingBracket(exp, start) : -1;
        let hasArrayRef = (start >= 0) && (end >= 0);

        while (hasArrayRef) {
            // evaluate any array references subexpressions
            sexp = exp.substring(start + 1, end);

            // does subexpression contain any array references?
            result = this.expEval(sexp);
            if (result !== undefined) {
                exp = exp.replace(sexp, result.toString());
            } else {
                return undefined;
            }

            start = exp.indexOf('[', start + 1);
            end = start >= 0 ? findClosingBracket(exp, start) : -1;
            hasArrayRef = (start >= 0) && (end >= 0);
        }

        // handle simple arrays: sym[exp] or a memory reference, [exp]
        // where exp doesn't include arrays
        start = exp.indexOf('[');
        end = start >= 0 ? findClosingBracket(exp, start) : -1;
        hasArrayRef = (start >= 0) && (end >= 0);

        while (hasArrayRef) {
            // evaluate any array references
            sexp = exp.substring(0, end + 1);

            result = sexp.replace(/(\b[A-z]+[A-z0-9]*\b)*(?:\[)(.*)(?:\])/g, (match, sym, exp) => {
                // we have an array reference
                // evaluate exp
                const value = this.expEval(exp);

                if (typeof value === 'number') {
                    const symbol = this.symbols.get(sym);
                    const symAddress = symbol ? symbol.address : 0;
                    return mem[(symAddress ?? 0) + value].toString();
                } else {
                    return '???';
                }
            });

            if (result.includes('???')) {
                return undefined;
            } else {
                exp = exp.replace(sexp, result);
            }

            start = exp.indexOf('[');
            end = start >= 0 ? findClosingBracket(exp, start) : -1;
            hasArrayRef = (start >= 0) && (end >= 0);
        }

        // replace symbols in expression with their values
        exp = exp.replace(/(\b[A-z]+[A-z0-9]*\b)/g, (match, sym) => {
            const value = this.symbols.getValue(sym);
            if (typeof value === 'number') {
                return value;
            } else {
                return sym;
            }
        });

        // evaluate the expression
        try {
            result = Function(`"use strict";return (${exp})`)();

            if (typeof result === 'boolean') {
                return result ? 1 : 0;
            }
            return result;
        }
        catch (err) {
            return undefined;
        }
    }


    // *******************************************************************************************
    // private helper methods

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
