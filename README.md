# ScreepsOS [![Build Status](https://travis-ci.org/Mototroller/ScreepsOS.svg?branch=master)](https://travis-ci.org/Mototroller/ScreepsOS)

## Screeps/Serializable Operating System (SOS)

Lightweight generator-based OS.

* desined to be serializable and restorable from plain memory (no RPC or `eval` calls)
* control flow can be modified by built-in "interrupts", which are special objects can be yielded from process loop
* kernel supports generators `*run() {}` and ordinary `run() {}` process loop functions
* adjustable scheduler and sequred memory management (every process has its own isolated memory)

## Implemented Interrupts:

Interrupt call | Function
--- | ---
`yield new OS.INT.Yield(density);` | allows scheduler to interrupt process to be continuet later this tick
`yield new OS.INT.Sleep();` | stops process execution till next tick
`yield new OS.INT.Fork(priority, class);` | runs new child process
`yield new OS.INT.Inject(pid);` | allows to modify child processes memory
`yield new OS.INT.Kill();` | kills process
`yield new OS.INT.Reboot();` | finishes current tick execution

To be continued...
