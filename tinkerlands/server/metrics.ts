/** Minimal Prometheus text-format metrics. */
export class Metrics {
  readonly counters = new Map<string, number>();
  readonly gauges = new Map<string, () => number>();
  private readonly tickBuckets = [5, 10, 20, 33, 66, 100];
  private readonly tickCounts = new Array<number>(this.tickBuckets.length + 1).fill(0);
  private tickSum = 0;
  private tickCount = 0;

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  gauge(name: string, read: () => number): void {
    this.gauges.set(name, read);
  }

  observeTick(ms: number): void {
    this.tickSum += ms;
    this.tickCount++;
    let i = this.tickBuckets.findIndex((b) => ms <= b);
    if (i < 0) i = this.tickBuckets.length;
    this.tickCounts[i]++;
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, value] of this.counters) {
      lines.push(`# TYPE tinkerlands_${name} counter`, `tinkerlands_${name} ${value}`);
    }
    for (const [name, read] of this.gauges) {
      lines.push(`# TYPE tinkerlands_${name} gauge`, `tinkerlands_${name} ${read()}`);
    }
    lines.push('# TYPE tinkerlands_tick_duration_ms histogram');
    let cumulative = 0;
    this.tickBuckets.forEach((b, i) => {
      cumulative += this.tickCounts[i];
      lines.push(`tinkerlands_tick_duration_ms_bucket{le="${b}"} ${cumulative}`);
    });
    cumulative += this.tickCounts[this.tickBuckets.length];
    lines.push(`tinkerlands_tick_duration_ms_bucket{le="+Inf"} ${cumulative}`);
    lines.push(`tinkerlands_tick_duration_ms_sum ${this.tickSum}`);
    lines.push(`tinkerlands_tick_duration_ms_count ${this.tickCount}`);
    const mem = process.memoryUsage();
    lines.push('# TYPE process_resident_memory_bytes gauge', `process_resident_memory_bytes ${mem.rss}`);
    return lines.join('\n') + '\n';
  }
}
