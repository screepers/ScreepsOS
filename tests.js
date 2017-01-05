'use strict';

const _ = require('lodash');
const OS = require('./sos.js').OS;

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

        memory.x = (memory.x || 0) + 1;

        jcon(this.children);

        if(this.children.length > 0) {
            const hook = yield new OS.INT.Inject(this.children[0]);
            console.log(`!!! child of ${this.pid} = ${JSON.stringify(hook)}`);
        }

        if(memory.x % 3 === 2 && this.children.length < 1)
            yield new OS.INT.Fork(OS.INT.POWER.MEDIUM, Monitor);

        if(memory.x % 5 === 4 && this.parent != 0)
            yield new OS.INT.Kill();
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
    OS.sandbox(()=>{
        let Memory = '{}';
        const ticks = 10;
        for(let time = 0; time < ticks; ++time) {
            Memory = JSON.parse(Memory);
            OS.init(Memory, time);
            OS.core("M10", 10, Monitor);
            OS.core("M50", 50, Monitor);
            OS.execute();
            console.log(OS.ps());
            Memory = JSON.stringify(Memory);
        }
    });
})();