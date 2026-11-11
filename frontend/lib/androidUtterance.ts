/** Android continuous results are segments, not complete conversational turns. */
export class AndroidUtterance {
  private committed: string[] = [];
  private partial = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private lastActivity = 0;
  private hadPartial = false;

  constructor(
    private readonly onReady: (text: string) => void,
    private readonly quietMs = 3000,
  ) {}

  get text(): string {
    return [...this.committed, this.partial].filter(Boolean).join(" ").trim();
  }

  speechStarted(): void {
    if (this.closed) return;
    this.clearTimer();
    this.lastActivity = Date.now();
  }

  result(text: string, final: boolean): string {
    if (this.closed) return this.text;
    const value = text.trim();
    if (!value) return this.text;
    this.lastActivity = Date.now();
    if (final) {
      // Repeated final without a new partial is a duplicate notification.
      if (this.hadPartial || this.committed[this.committed.length - 1] !== value) this.committed.push(value);
      this.partial = "";
      this.hadPartial = false;
    } else {
      this.partial = value;
      this.hadPartial = true;
    }
    this.clearTimer();
    this.timer = setTimeout(() => this.finish(), this.quietMs);
    return this.text;
  }

  serviceEnded(): boolean {
    // Only a completed quiet interval can turn an unexpected native end
    // into a completed utterance. Never send a freshly interrupted partial.
    if (this.text && Date.now() - this.lastActivity >= this.quietMs) {
      this.finish();
      return true;
    }
    this.cancel();
    return false;
  }

  cancel(): void {
    this.closed = true;
    this.clearTimer();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    if (this.text) this.onReady(this.text);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
