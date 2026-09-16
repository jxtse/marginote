import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "proper-lockfile";

/** One serving process per canonical vault, including non-persistent sessions. */
export class VaultLease {
  private readonly controller = new AbortController();
  private releaseLock: (() => Promise<void>) | null = null;
  private released: Promise<void> | null = null;
  readonly signal: AbortSignal = this.controller.signal;

  private constructor(readonly root: string) {}

  static async acquire(path: string): Promise<VaultLease> {
    await mkdir(path, { recursive: true });
    const root = await realpath(path);
    const directory = join(root, ".marginote");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await realpath(directory) !== directory) throw new Error("Runtime directory must not be a symlink");
    const lease = new VaultLease(root);
    try {
      lease.releaseLock = await lock(root, {
        lockfilePath: join(directory, "runtime.lock"),
        stale: 120_000,
        update: 5_000,
        retries: 0,
        onCompromised: error => lease.controller.abort(error),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
        throw new Error(`A Marginote runtime already owns ${root}. Use its existing URL. After a crash, wait up to two minutes before restarting.`);
      }
      throw error;
    }
    return lease;
  }

  release(): Promise<void> {
    return this.released ??= (async () => {
      // A compromised lock is no longer ours; never remove a successor's lock.
      if (!this.signal.aborted) await this.releaseLock?.();
      this.releaseLock = null;
    })();
  }
}
