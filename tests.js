'use strict';

const _ = require('lodash');
const sos = require('./sos.js');
const OS = sos.OS;

global.jcon = (...args) => (console.log(JSON.stringify(...args)));

function* printer() {
    jcon(1); yield;
    jcon(2); yield;
}

class Monitor extends OS.Process {
    //! Generator function
    *run(memory) {
        jcon(this.pid);
        jcon(memory);

        //yield* super.run(); // causes error

        jcon('m1');
        yield new OS.INT.Yield(_.random(0,100));
        jcon('m2');

        yield* printer();
        memory.x = memory.x || 0;
        ++memory.x;

        jcon(this.children);

        if(this.children.length > 0) {
            const hook = yield new OS.INT.Inject(this.children[0]);
            console.log('!!! child of %s = %s', this.pid, JSON.stringify(hook));
        }

        if(memory.x % 3 === 0 && this.children.length < 1)
            yield new OS.INT.Fork(OS.INT.POWER.MEDIUM, Monitor);
    }//*/

    /*/! Non-generator function
    run(memory) {
        jcon(memory);
        jcon('m1');
        jcon(this.test);
        jcon(this.children);
    }//*/
}

OS.register(Monitor);

(function main() {
    console.log("Hello!");
    console.log("os =", sos);

    sos.sandbox(()=>{
        let Memory = {};
        const ticks = 5;
        for(let time = 0; time < ticks; ++time) {
            OS.init(Memory, time);
            OS.core("M10", 10, Monitor);
            OS.core("M50", 50, Monitor);
            OS.execute();
            Memory = JSON.parse(JSON.stringify(Memory));
        }
        //console.log(sos.Kernel().dump());
    });
})();