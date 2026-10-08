class FifoQueue<T> {
  private readonly incoming: T[] = [];
  private readonly outgoing: T[] = [];

  get length(): number {
    // 两个栈都可能有元素：dequeue 会把 incoming 倒进 outgoing，
    // 只看 incoming 会把还没消费的 outgoing 元素漏掉
    return this.incoming.length + this.outgoing.length;
  }

  enqueue(value: T): void {
    this.incoming.push(value);
  }

  /**
   * 双栈队列 O(1) 优于单数组 O(n²)
   *
   * incoming = [1,2,3] outgoing = []
   * 转移：pop 3,2,1 -> outgoing = [3,2,1]
   * pop -> 1 剩下 outgoing = [3,2]
   * 再 enqueue 4 -> incoming = [4]
   * dequeue -> pop() -> 2
   * dequeue -> pop() -> 3
   * dequeue -> outgoing 空 -> 转移 incoming=[4] -> outgoing=[4] -> pop() -> 4 ✔
   */
  dequeue(): T | undefined {
    if (this.outgoing.length === 0) {
      while (this.incoming.length > 0) {
        this.outgoing.push(this.incoming.pop()!);
      }
    }

    return this.outgoing.pop();
  }
}

// Generic event stream class for async iteration
export class EventStream<T> implements AsyncIterable<T> {
  private readonly queue = new FifoQueue<T>();
  private readonly waiting = new FifoQueue<
    (value: IteratorResult<T>) => void
  >();

  private done = false;
  private readonly isComplete: (event: T) => boolean;

  constructor(isComplete: (event: T) => boolean) {
    this.isComplete = isComplete;
  }

  push(event: T): void {
    if (this.done) return;

    if (this.isComplete(event)) {
      this.done = true;
    }

    // Deliver to waiting consumer or queue it
    const waiter = this.waiting.dequeue();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.enqueue(event);
    }
  }

  end(): void {
    this.done = true;

    // Notify all waiting consumers that we're done
    while (this.waiting.length > 0) {
      const waiter = this.waiting.dequeue()!;
      waiter({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.dequeue()!;
      } else if (this.done) {
        return;
      } else {
        const result = await new Promise<IteratorResult<T>>(resolve => {
          this.waiting.enqueue(resolve);
        });
        if (result.done) return;
        yield result.value;
      }
    }
  }
}
