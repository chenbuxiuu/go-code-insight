import type { CancellationToken } from 'vscode';

/** FIFO concurrency limiter; queued jobs whose token is cancelled are skipped. */
export class Limiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(public max: number) {}

  async run<T>(fn: () => Promise<T>, token?: CancellationToken): Promise<T | undefined> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active++;
    }
    try {
      if (token?.isCancellationRequested) {
        return undefined;
      }
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) {
        next(); // hand the slot over directly
      } else {
        this.active--;
      }
    }
  }
}
