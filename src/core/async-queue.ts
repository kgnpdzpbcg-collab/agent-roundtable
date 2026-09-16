/**
 * 一个很小的异步队列，用来把 app-server 主动推送的事件桥接为 AsyncIterable。
 * producer 负责 push，consumer 可以直接用 for await...of 顺序消费。
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];

  private closed = false;
  private failure: unknown;

  push(value: T): void {
    if (this.closed || this.failure !== undefined) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
    }

    this.values.push(value);
  }

  close(): void {
    if (this.closed || this.failure !== undefined) {
      return;
    }

    this.closed = true;
    this.flushTerminalState();
  }

  fail(error: unknown): void {
    if (this.closed || this.failure !== undefined) {
      return;
    }

    this.failure = error;
    this.flushTerminalState();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
    };
  }

  private next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) {
      return Promise.resolve({ value, done: false });
    }

    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }

    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /**
   * close/fail 时只结束当前已经在等待的 consumer。
   * 队列里已经排好的值仍会先按顺序被消费，之后才结束或抛错。
   */
  private flushTerminalState(): void {
    if (this.values.length > 0) {
      return;
    }

    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (this.failure !== undefined) {
        waiter.reject(this.failure);
      } else {
        waiter.resolve({ value: undefined, done: true });
      }
    }
  }
}
