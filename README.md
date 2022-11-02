# db65xx
VS Code assembly language debugger for the 65C02 and 65816 microprocessors.

![Screenshot of db65xx debugger](https://trobertson.site/wp-content/uploads/2022/10/db65816.png)

# Features
* Runs a program from reset vector, optionally stopping on entry
* Supports multi-file programs
* Can set launch arguments for program
* Follow along with execution directly in assembly source files
* Control program execution with continue/pause, single step, step-into, step-over,  step-out and run-to-cursor
* Five types of breakpoints:
    * Source: set directly in assembly source files; stops execution when that line is reached
    * Function: set on function name or memory address; stops execution when that function is entered or memory address is reached during program execution
    * Data: set on X, Y, K, B and D register; stops execution when a write access to these registers is made
    * Instruction mnemonic or opcode (opcode allows a break even if there is no supporting source code)
    * Logpoints: don't break when hit, but print a text message to the debug console.  Can include expressions to be evaluated within curly braces ('{}').
* Set break conditions and/or hit count on source and function breakpoints and logpoints
* Registers and hardware stack displayed in Variables pane and can be modified when program is paused
* Watch pane functional for program symbols and memory addresses (not expressions) and the values of these can be changed when the program is paused
* Variable/watch changes highlighted after each step and on execution pause
* Drill down on variables/watches that represent a memory range (variable ranges can be opened in a separate hex editor window allowing modification of the memory range)
* Symbol address and value displayed when hovering over a symbol in source code
* Call stack displayed when stepping through program.  Clicking on an entry opens the source code in an editor at that line.  On continue, call stack collapses stack to current instruction.
* Integrated terminal window for input/output with default read/write addresses at $f004 and $f001 respectively.
* Source files listed in debug pane Loaded Scripts Explorer

# Requirements
db65xx is a VS Code extension (under development) that simulates Western Design Center's [65C02](https://www.wdc65xx.com/wdc/documentation/w65c02s.pdf) *(to come)* and [65C816](https://www.wdc65xx.com/wdc/documentation/w65c816s.pdf) microprocessors.  The extension implements Microsoft's Debug Adapter Protocol to communicate with the VS Code debugging frontend and translates UI commands to control an execution engine simulating the selected processor.  The execution engine "runs" a binary file of the assembled code and can be used independently of the debugging extension.

The extension monitors the execution engine activity and translates its state into various elements to be displayed in the VS Code UI.  To do so, it uses various debug files produced during source code assembly.  The extension works with [cc65](https://github.com/cc65/cc65) files to produce an address map between the assembly source files and the assembled binary.  If not otherwise specified it assumes file extensions as follows:
* binary: `.bin`
* debug: `.dbg`
* listing:  `.lst`
* map:      `.map`
* symbol:   `.sym`
* source: `same as debugged file, as referenced in debug file or '.s' otherwise`

See the cc65 documentation on how to produce these files.  It shouldn't be difficult to modify the extension to create a mapping for other extensions or 65xx assemblers.

# Debug Adapter and Execution Engine
Class DA65xx in the da65xx.ts module, implements Microsoft's [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/) (DAP) to interface between the VS Code debugging UI and an execution engine.  The debug adapter performs all other aspects of debugging from maintaining the current program location in a source file to examining simulated memory to provide the UI with symbol values.  The debug adapter also maintains information on all breakpoints and provides a method that the execution engine calls each step to check if a breakpoint has been hit.

Class EE65xx, in the ee65xx.ts module, is a 65xx execution engine with limited debugging support.  It "executes" a 65xx binary instruction by instruction in "steps" and sends events to the debug adapter informing it of certain events.  The debug adapter "follows along" with a source file, simulating "running" through the source code line-by-line.  It does this by preparing a mapping of the source code line to binary address using information from the debug files provided.

EE65xx exposes several methods allowing the debug adapter to control the simulation.  EE65xx supports typical stepping functionality as the core of its "debugging support", but relies exclusively on the debug adapter for other debugging activities, such as maintaining breakpoints and variable requests.  To check if a breakpoint has been hit for example, the execution engine checks with the debug adapter each step.  EE65xx is completely independent from VS Code and the Debug Adapter and can be run as a standalone simulator without debugging.  It can also be run within VS Code without debugging.

The core of the execution engine is a Typescript port of the core of my [py65816](https://github.com/tmr4/py65816) Python simulator package.  The Python version has been tested with unit tests covering about 98% of the code (see the link for limitations).  Similar tests have not been made on the Typescript core but it has successfully passed a significant set of higher-level functional tests.  I don't plan on porting the Python unit tests as its code base is significantly larger than just the core alone.  As always, use at your own risk.

I plan to port the [65C02 core](https://github.com/tmr4/py65816/blob/main/py65816/devices/db_mpu65c02.py) my Python simulator package at some point.  These are based on Mike Naberezny's [py65](https://github.com/mnaberez/py65), a great 65C02 simulator.  Check out [ThirdPartyNotices](https://github.com/tmr4/db65xx/ThirdPartyNotices.txt) for its license and those of other's works that made this VS Code extension possible.

# Installation
The [db65xx VS Code extension](https://marketplace.visualstudio.com/items?itemName=TRobertson.db65xx) is available in the Visual Studio Marketplace and is the easiest way to add the extension to your system.  If you'd like to see how the extension works or modify it, clone this repository and open it in VS Code.  Open a terminal and type `install npm`.  You should be then be ready to run the hello world example.  To use the extension with your own files, add a default launch configuration with the `Run - Add Configuration...` menu item.

# Hello World Example
I've included a very simple "hello world" example project in the [wp](https://github.com/tmr4/db65xx/tree/main/wp) folder.  To run it with the marketplace extension, copy the `wp` folder, open it in VS Code, open `hello_world.s` and press `F5`.  The program should pause at the start of the reset subroutine.

![Screenshot of db65xx debugger](https://trobertson.site/wp-content/uploads/2022/10/hello_world.png)

To run the "hello world" example from a cloned repository, open the debug adapter extension project in VS Code and press `F5` to start debugging.  VS Code will open a new window where you can run the hello world example.  Open hello_world.s, make sure "Debug File" is selected in the VS Code debug pane and press `F5`.

# Use
The db65xx extension implements many of VS Code's debugging capabilities.  See [Debugging](https://code.visualstudio.com/docs/editor/debugging) for an overview of using the VS Code debugging interface.  In some cases, db65xx behaves slightly differently than standard:
* In addition to named function breakpoints, you can add an address as a function breakpoint.  This is especially useful to set a breakpoint at a location where a source file isn't available.  The address can be entered as either a decimal or hex value (enter hex with a 0x prefix).
* Data breakpoints can be set on the `X`, `Y`, `K`, `B` and `D` registers for write access only.  Data breakpoints for the other Variable pane items and for read access are not available.  Execution will break at an instruction that will write to one of the supported registers.  Note that unlike a normal data breakpoint, db65xx breaks at the instruction regardless if the value in the register will actually change.
* I use VS Code's exception breakpoint functionality to implement instruction mnemonic and opcode breakpoints.  You can add multiple instructions or opcodes separated by commas.  Currently, instruction entries are case sensitive and compared to the actual source code, so `CLC` and `clc` are two distinct instructions.  In addition, you can break on macros by entering the macro name as an instruction breakpoint.
* Watches can be set for symbols that are in the debug file.  The value of watched symbols can be changed via the `Set Value` context menu item.  Watches can also be set by memory address.  Enter the address either in decimal or hex (enter hex with a 0x prefix).  Memory ranges can also be watched.  Enter a memory range as the starting and ending address separated with a colon, such as start:end.  Memory ranges can be drilled down and individual address values changed with the `Set Value` menu item.
* Make sure to check the context menu in each area of the debugger to see what options are available.  This is the only way to access many of VS Code's debugging functions.
* Unless launched with arguments specifying the source files (not discussed here), db65xx assumes the binary file to run is in the same directory and has the same name as the file being debugged, but with a `.bin` extension.  Maps are created to inform the UI of the line number in the source file corresponding to the current program counter and of symbol addresses.  The ld65 debug file (with the same name as the file being debugged, but with a `.dbg` extension and in the same directory) is use, if available, to produce these maps.  If the debug file or any of the source files it references are not available, the listing, symbol and mapping files produced by ca65 and ld65 are used.  If these aren't available, your binary will still run but the VS Code UI will not be able to follow along, show or set variables, or set or stop at breakpoints.

# Status and Limitations
1. This is a work in progress and will likely remain so.  I use it in debugging my 65816 Forth operating system.  I make no claims to its usability or suitability for your uses.  Coding is just a hobby for me, so take care.  Much of the code hasn't been rigorously tested, is without error checking and is likely inefficient.  Still, hopefully it will help others get past the limited documentation regarding VS Code's implementation of Microsoft's DAP.  Another good starting point for that is Microsoft's [Mock-Debug](https://github.com/Microsoft/vscode-mock-debug) which was the starting point for this project.
2. The installation steps noted above are all you should need to do if your system is set up like mine.  There may be other setup steps you need to take if you don't have all of the prerequisite software installed already.  In addition to installing [VS Code](https://code.visualstudio.com/) and recommended extensions, the only other thing I had to install to run the hello world example from a cloned repository on a fairly clean PC was [NodeJS](https://learn.microsoft.com/en-us/windows/dev-environment/javascript/nodejs-on-windows).
3. The db65xx extension comes with a basic 65xx assembly language syntax highlighting.  You can use it my selecting the `65xx` language mode. You might want to use another 65xx language extension for a more enhanced debugging experience.  Search for 6502 in VS Code's extensions marketplace.
4. You can use defined symbols in conditional breakpoint and logpoint expressions.  These haven't been extensively tested.  Registers cannot be used in expressions.  I'll likely add this feature soon but I'll likely take an approach where they will hide symbols with the same name.
5. Conditional expressions are ignored on instruction and opcode breakpoints.  I may add these within curly braces ('{}') as with logpoints.
6. I haven't tried db65xx with a 65C02-based binary but it should work as long as none of the 65C02 specific instructions are used (and assuming your code doesn't rely on other differences between the two processors).  I also haven't tried using C code with cc65.  It doesn't support the 65816.  I suppose it would be possible to link in 65C02 C-based object files to a 65816 project and I assume the ld65 debug file would map to the proper C source file.  I'd like to know the result if you try it out.
7. more to come...
