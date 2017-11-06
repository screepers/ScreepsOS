'use strict';

/// Lightweight PriorityQueue (binary max heap) 
const PriorityQueue = (()=>{

    const _private = Symbol();
    
    function bubbleUp(pos) {
        const _this = this[_private];
        
        const data = _this.data;
        const comp = _this.comp;
        const item = data[pos];

        while(pos > 0) {
            const parent_pos = (pos - 1) >> 1;
            const current = data[parent_pos];

            if(comp(item, current) >= 0)
                break;

            data[pos] = current;
            pos = parent_pos;
        }

        data[pos] = item;
    }

    function bubbleDown(pos) {
        const _this = this[_private];
        
        const data = _this.data;
        const comp = _this.comp;
        const half = _this.size >> 1;
        const item = data[pos];

        while(pos < half) {
            let l_pos = (pos << 1) + 1;
            const r_pos = l_pos + 1;
            let best = data[l_pos];

            if(r_pos < _this.size && comp(data[r_pos], best) < 0) {
                l_pos = r_pos;
                best = data[r_pos];
            }
            
            if(comp(best, item) >= 0)
                break;

            data[pos] = best;
            pos = l_pos;
        }

        data[pos] = item;
    }
    
    
    class PriorityQueue {
        
        /// Default Max Heap comparator (by value) 
        static get valueComp() {
            return (a, b) => (a < b ? 1 : a > b ? -1 : 0); }
        
        /// @returns Max Heap objects comparator by given key-property
        static keyComp(keyField) {
            return (a, b) => PriorityQueue.valueComp(a[keyField], b[keyField]); }
        
        
        constructor(comp) {
            const _this = {};
            Object.defineProperty(this, _private, { value: _this });
            //this[_private] = {};
            
            this.clear();
            this[_private].comp = comp || PriorityQueue.valueComp;
        }
        
        push(item) {
            const _this = this[_private];
            _this.data.push(item);
            _this.size++;
            bubbleUp.call(this, _this.size - 1);
            return item;
        }

        pop() {
            const _this = this[_private];
            
            if(_this.size === 0)
                return undefined;
            
            const data = _this.data;
            const top = data[0];
            _this.size--;
            
            if(_this.size > 0) {
                data[0] = data[_this.size];
                bubbleDown.call(this, 0);
            }
            
            data.pop();
            return top;
        }
        
        top() {
            const _this = this[_private];
            return _this.data[0];
        }
        
        clear() {
            const _this = this[_private];
            _this.data = [];
            _this.size = 0;
        }
    }
    
    return PriorityQueue;
})();

(module || {}).exports = {
    PriorityQueue: PriorityQueue
};
