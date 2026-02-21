export class RoundRobin<Type> {
    readonly capacity: number;
    front: number;
    size: number;
    queue: Type[];

    constructor(capacity: number) {
        this.capacity = capacity;
        this.front = 0;
        this.size = 0;
        this.queue = new Array(capacity);
    }

    next() {
        if (this.size <= 0) return null;
        this.size--;
        return this.queue[this.front++ % this.capacity];
    }

    get(index: number) {
        return this.queue[(this.front + index) % this.capacity];
    }

    append(item: Type) {
        if (this.size >= this.capacity) {
            this.front = (this.front + 1) % this.capacity;
            this.size--; // evict oldest, then re-add below
        }
        this.queue[(this.front + this.size++) % this.capacity] = item;
    }

    clear() {
        this.front = 0;
        this.size = 0;
    }
}
