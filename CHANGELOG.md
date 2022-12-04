# Change Log

## 0.0.12

- Bug fix: problem finding source files on startup

## 0.0.11

- Added support for debugging cc65 C source files
- Added C-based hello world example project
- Added chess program example project
- Bug fix: problem breaking on macros used more than once

## 0.0.10

- Set breakpoints within and single step into multi-instruction macros

## 0.0.9

- Added functional tests
- Bug fix: corrected 6502 decimal mode ADC/SBC

## 0.0.8

- Added support for `BBR0-7` and `BBS0-7` instructions on the 65C02 microprocessor
- Execution of an invalid opcode throws an exception
- Added interrupt driven I/O example project
- Bug fix: problem setting memory address 0

## 0.0.7

- Added support for the 65C02 and 6502 microprocessors

## 0.0.6a

- Added link to 32-bit floating-point example project
- Bug fix: fixed waiting for terminal input

## 0.0.6

- More intuitive status register display
- Set status register with labels
- Added terminal input buffer
- Added input/output address launch arguments
- Added input buffer to `hello world` example
- Bug fix: properly stopped execution engine on terminate

## 0.0.5

- Enhanced expression evaluation:
  - Register labals can be used
  - single quoted character, e.g. `'x'`, recognized as its ascii byte equivalent

## 0.0.4

- Enhanced expression evaluation
- Added the `[]` array operator

## 0.0.3

- Debug Console now functional
- Expressions can be used in Watch pane

## 0.0.2

- Added logpoints

## 0.0.1

- Added `Launch with args` configuration for "Hello World" example
- Updated Readme to reflect Marketplace extension usage

## 0.0.0

- Initial commit
