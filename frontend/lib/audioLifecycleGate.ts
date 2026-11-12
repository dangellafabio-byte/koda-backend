/** Serializes idle audio work against the complete voice turn. */
export class AudioLifecycleGate {
  private revision = 0;
  private owner: number | null = null;
  private pending: Promise<void> = Promise.resolve();
  private voiceDone: Promise<void> = Promise.resolve();
  get voiceBusy(): boolean { return this.owner !== null; }
  invalidate(): void { this.revision++; }
  claimVoice(): {ready: Promise<void>; release: () => void} | null {
    if (this.voiceBusy) return null;
    const owner = ++this.revision;
    this.owner = owner;
    let resolveVoice!: () => void;
    this.voiceDone = new Promise<void>(resolve => { resolveVoice = resolve; });
    return { ready: this.pending, release: () => {
      if (this.owner === owner) this.owner = null;
      resolveVoice();
    }};
  }
  runIdle(allowed: () => boolean, operation: (current: () => boolean) => Promise<void>): Promise<void> {
    const revision = this.revision, voiceDone = this.voiceDone;
    const current = () => revision === this.revision && !this.voiceBusy && allowed();
    const job = this.pending.then(() => voiceDone).then(async () => {
      if (current()) await operation(current);
    });
    this.pending = job.catch(() => {});
    return job;
  }
}
