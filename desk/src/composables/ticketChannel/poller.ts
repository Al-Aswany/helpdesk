/**
 * Bounded read-only polling for outbound state.
 *
 * It runs only while `shouldPoll()` is true, backs off, pauses while the tab is
 * hidden, gives up after `maxMs`, and keeps at most one timer. It never sends:
 * `fetch` is a read. `stop()` is safe to call repeatedly (navigation, unmount).
 *
 * No Vue and no aliases, so it runs under `node --test`.
 */
export const POLL_DELAYS_MS = [2000, 2000, 3000, 5000, 8000, 10000, 15000];
export const POLL_MAX_MS = 10 * 60 * 1000;

export interface PollerDeps {
  fetch(): Promise<unknown>;
  shouldPoll(): boolean;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  isVisible?(): boolean;
  delays?: number[];
  maxMs?: number;
}

export class BoundedPoller {
  private deps: PollerDeps;
  private handle: unknown = null;
  private startedAt = 0;
  private attempt = 0;
  private running = false;
  private busy = false;
  exhausted = false;

  constructor(deps: PollerDeps) {
    this.deps = deps;
  }

  /** Begin a polling cycle, or keep the current one. Never adds a second timer. */
  start() {
    if (this.running) return;
    if (!this.deps.shouldPoll()) return;
    this.running = true;
    this.exhausted = false;
    this.attempt = 0;
    this.startedAt = this.deps.now();
    this.schedule();
  }

  /** Restart the cycle from the first delay, e.g. after a new submission. */
  restart() {
    this.stop();
    this.start();
  }

  stop() {
    this.running = false;
    if (this.handle !== null) {
      this.deps.clearTimer(this.handle);
      this.handle = null;
    }
  }

  get active() {
    return this.running;
  }

  private delay() {
    const delays = this.deps.delays ?? POLL_DELAYS_MS;
    return delays[Math.min(this.attempt, delays.length - 1)] ?? 15000;
  }

  private schedule() {
    if (!this.running || this.handle !== null) return;
    this.handle = this.deps.setTimer(() => {
      this.handle = null;
      void this.tick();
    }, this.delay());
  }

  private async tick() {
    if (!this.running) return;
    if (!this.deps.shouldPoll()) {
      this.stop();
      return;
    }
    if (this.deps.now() - this.startedAt > (this.deps.maxMs ?? POLL_MAX_MS)) {
      this.exhausted = true;
      this.stop();
      return;
    }
    this.attempt += 1;
    const visible = this.deps.isVisible ? this.deps.isVisible() : true;
    if (visible && !this.busy) {
      this.busy = true;
      try {
        await this.deps.fetch();
      } catch {
        // A failed read is retried on the next tick.
      } finally {
        this.busy = false;
      }
    }
    if (!this.running) return;
    if (!this.deps.shouldPoll()) {
      this.stop();
      return;
    }
    this.schedule();
  }
}
