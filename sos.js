'use strict';

const _ = require('lodash');

const utils = {
    isGenerator: ((obj) => ('function' == typeof obj.next && 'function' == typeof obj.throw)),
    isGeneratorFunction: ((obj) => {
        const ctor = obj.constructor;
        return !ctor ? false :
            ('GeneratorFunction' === ctor.name || 'GeneratorFunction' === ctor.displayName) ? true :
            utils.isGenerator(ctor.prototype);
    }),
    isConvertibleToGF: ((obj) => (utils.isGeneratorFunction(obj) || (typeof obj == 'function'))),
    generify: ((g) => (
        utils.isGeneratorFunction(g) ? g : (function*(...args) { return g(...args) })
    )),
    unrollGenerator: ((f, ...args) => {
        const g = utils.isGenerator(f) ? f :
            utils.isGeneratorFunction(f) ? f(...args) :
            utils.generify(f)(...args);
        for(let step of g) {}
    }),
    functionByName: ((name, context) => {
        const namespaces = name.split('.');
        const func = namespaces.pop();
        for(let i = 0; i < namespaces.length; ++i)
            context = context[namespaces[i]];
        return context[func];
    })
};

/// Common OS errors
class OSError extends Error {}

/// Critical errors, throwing will cause Kernel reboot
class OSCriticalError extends OSError {}

/// Base class for OS processes, must be inherited from.
class Process {
    /// Creates 'Process' from given POD object
    constructor(pod) {
        if(pod && pod.chs_ !== undefined) _.assignIn(this, pod); // "revive"
        else this.chs_  = []; // newly created
    }

    /// Returns list of child processes' PIDs
    get children() { return this.chs_.slice(0); }

    /// Default generator, example, uses for missed (not registered) Process classes detection
    *run(memory) { throw new OSError('Abstract Process.*run() was called'); }
}

/**
 * Base class and namespace of OS's "interrupts".
 * Return or yield "new Interrupt.<INT>()" inside Process will cause special actions.
 */
class Interrupt {
    /// Predefined percent powers for some actions
    static get POWER() { return { LOW: 10, MEDIUM: 50, HIGH: 90 }; }
}

/// Allows to interrupt process to be continued later this tick. Has no result.
Interrupt.Yield = class extends Interrupt {
    constructor(density) { super(); this.density = density || Interrupt.POWER.MEDIUM; }; };

/// Finishes execution at current tick and make it sleep for 'ticks'. Has no result.
Interrupt.Sleep = class extends Interrupt {
    constructor(ticks) { super(); this.ticks = ticks || 1; }; };

/// Creates new process (will start next tick). Result: child PID.
Interrupt.Fork = class extends Interrupt {
    constructor(priority, type, ...args) { super(); this.spares = [priority, type, ...args]; }; };

/// Requests access to child process memory. Result: reference to child memory.
Interrupt.Inject = class extends Interrupt {
    constructor(pid) { super(); this.cpid = pid; }; };

/// Kills the current process. Has no result, 'yield' won't return.
Interrupt.Kill = class extends Interrupt {
    constructor() { super(); }; };

/// Reboots kernel. Has no result, 'yield' wont return.
Interrupt.Reboot = class extends Interrupt {
    constructor() { super(); }; };

/**
 * Main Kernel's singleton. Explicitly extended below.
 * Can be accesses by "Kernel()" or constructed as "new Kernel".
 */
const Kernel = (()=>{
    let instance;
    return function Construct() {
        if(instance) return instance;
        if(this && this.constructor === Construct) instance = this;
        return new Construct();
    };
})();

/// Returns "true" and handles error if its OS'es one, "false" otherwise.
function handleError(err) {
    if(err instanceof OSError) {
        console.log('OS error: %s %s', JSON.stringify(err), err.stack);
        return !(err instanceof OSCriticalError) || Kernel().reboot() || true;
    }
    return false;
}

/**
 * Registers given class to be used at current runtime:
 * @param type - Process class
 */
Kernel.prototype.register = (type) => ((Kernel().types || (Kernel().types = {}))[type.name] = type);

/// Initializes kernel's storage, allows execution
Kernel.prototype.init = (storage, time) => {
    this.executed_ = false;
    this.memory = storage.kernel_ || (storage.kernel_ = {});
    this.memory.t = time || 1 + (this.memory.t || 0);
    console.log('Kernel constructed (st = %s)', JSON.stringify(this.memory));
};

Kernel.prototype.reboot = () => (this.executed_ = true);

Kernel.prototype.dump = () => (JSON.stringify(this));

/**
 * Full table of existing processes:
 * [pid, priority, typeName, process, memory]
 */
Kernel.prototype.table = () => (this.memory.table || (this.memory.table = {}));

/// Returns first available free PID
Kernel.prototype.getFreePID = () => {
    this.keysList = this.keysList || _.chain(Kernel().table()).keys().sortBy(k => +k).value();
    for(let i = 1;; ++i) {
        const idx = i-1;
        if(i != this.keysList[idx]) {
            this.keysList.splice(idx, 0, i);
            return i;
        }
    }
};

function createProcess(pid, priority, type, ...ctorArgs) {
    const table = Kernel().table();
    if(table[pid]) throw new OSError('PID already occupied');
    let process;
    try { process = new type(...ctorArgs); }
    catch(err) {
        if(!handleError(err)) throw err;
        return false;
    }
    if(!(process instanceof Process)) throw new OSError('Cant create Process (incompatible type)');
    if(!utils.isConvertibleToGF(process.run)) throw new OSError('Process.run is not a valid function(*)');
    table[pid] = [pid, priority, type.name, process, {}];
    return true;
}

/// Runs core (permanent) process with given name if doesn't exists
Kernel.prototype.core = (name, priority, type, ...ctorArgs) => {
    if(name == 0) throw new OSError('Deprecated PID(0) for core processes');
    if(Kernel().table()[name]) return;
    createProcess(name, priority, type, ...ctorArgs);
};

/// Modifies table's entry and constructs Process by POD if it's necessary
function revive(entry) {
    const process = entry[3];
    if(!(process instanceof Process))
        entry[3] = new (Kernel().types[entry[2]] || Process)(process);
    return entry;
}

/**
 * Processes schedule entries.
 * @param task: [priority,entry,generator,done]
 */
function handleProcess(task) {
    const [p,e,g,] = task; // priority/entry/generator/done
    const INT = Interrupt;
    try {
        let interrupt = false;
        do {
            const result = g.next();
            const ret = result.value;
            if(ret instanceof INT) {
                switch(ret.constructor) {
                    case INT.Yield:
                        interrupt = (ret.density + p/2) < _.random(0,100);
                        break;
                    case INT.Sleep: // TODO: timing
                        interrupt = true;
                        break;
                    case INT.Fork: // TODO: child PID to generator
                        const newPID = Kernel().getFreePID();
                        if(createProcess(newPID, ...ret.spares))
                            e[3].chs_.push(newPID);
                        break;
                    case INT.Inject: // TODO
                        break;
                    case INT.Kill: // TODO: more abstract
                        result.done = true;
                        delete Kernel().table()[e[0]];
                        break;
                    case INT.Reboot:
                        Kernel().reboot();
                        interrupt = true;
                        break;
                }
            }
            task[3] = result.done;
            interrupt = interrupt || result.done;
        } while(!interrupt);
    } catch(err) {
        task[3] = true;
        if(!handleError(err))
            throw err;
    }
}

Kernel.prototype.execute = () => {
    const executed = () => (this.executed_);
    const complete = () => (this.executed_ = true);
    if(executed()) return;

    const rp = 10; // shuffle power coefficient: priority ~ priority + [-rp,+rp]
    const adjPriority = (p) => (Math.round(_.random(-rp, +rp)*(50 - Math.abs(p - 50))/50.0) + p);

    // [pid, priority, typeName, process, memory]
    const schedule = _.chain(Kernel().table())
        .map((entry) => ([
            adjPriority(entry[1]),          // randomized priority
            revive(entry),                  // table entry reference
            utils.generify(entry[3].run)(entry[4]), // generator
            false                           // done
        ]))
        .sortBy((obj) => (-obj[0]))
        .value();

    // Here schedule is sorted and prepared for execution

    while(!executed()) {
        _.forEach(schedule, task => handleProcess(task));
        _.remove(schedule, s => s[3]);
        if(schedule.length === 0) complete();
    }
};

/**
 * Wraps OS calls by bulletproof shell.
 * @param f - function to be executed.
 */
const environment = (f) => {
    try {
        f();
    } catch(err) {
        if(!handleError(err)) {
            console.log('### Kernel panic: OS terminated for current tick ###');
            console.log('%s %s', JSON.stringify(err), err.stack);
        } else {
            console.log('+++ Kernel warning: OS has handle some serious error +++');
            console.log('%s %s', JSON.stringify(err), err.stack);
        }
    }
};

module.exports = (()=>{
    return {
        utils:      utils,
        Process:    Process,
        Interrupt:  Interrupt,
        INT:        Interrupt, // alias
        Kernel:     Kernel,
        environment:environment
    };
})();