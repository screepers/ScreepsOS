# ScreepsOS

## Screeps/Serializable Operating System (SOS)

Lightweight generator-based OS.

* desined to be serializable and restorable from plain memory (no RPC or `eval` calls)
* control flow can be modified by built-in "system calls", which are special objects can be yielded from process loop
* kernel supports generators `*run() {}` and ordinary `run() {}` process loop functions
* adjustable scheduler and secure memory management (every process has its own isolated memory)

## Implemented SYSCALLs:

SYSCALL | Description
--- | ---
`yield new Yield();` | allows scheduler to interrupt process to be continue later this tick
`yield new Sleep(10);` | stops process execution for several ticks
`yield new Fork(priority, class);` | runs new child process
`yield new Inject(pid);` | allows to modify child processes memory
`yield new Kill();` | kills process
`yield new Reboot();` | finishes current tick execution
`yield new Priority(newVal);` | requests for new priority value

To be continued...
