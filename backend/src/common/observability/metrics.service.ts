import { Injectable } from '@nestjs/common';

type Labels = Record<string, string>;

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly durations = new Map<string, { count: number; totalMs: number }>();

  increment(name: string, labels: Labels = {}) {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  observe(name: string, durationMs: number, labels: Labels = {}) {
    const key = this.key(name, labels);
    const current = this.durations.get(key) ?? { count: 0, totalMs: 0 };
    current.count += 1;
    current.totalMs += Math.max(0, durationMs);
    this.durations.set(key, current);
  }

  toPrometheus(): string {
    const lines: string[] = [];
    for (const [key, value] of this.counters) lines.push(`${key} ${value}`);
    for (const [key, value] of this.durations) {
      const separator = key.indexOf('{');
      const name = separator < 0 ? key : key.slice(0, separator);
      const labels = separator < 0 ? '' : key.slice(separator);
      lines.push(`${name}_count${labels} ${value.count}`);
      lines.push(`${name}_sum${labels} ${value.totalMs}`);
    }
    return `${lines.join('\n')}\n`;
  }

  private key(name: string, labels: Labels) {
    const safeName = name.replace(/[^a-zA-Z0-9_:]/g, '_');
    const safeLabels = Object.entries(labels)
      .filter(([key, value]) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) && value.length <= 100)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}="${value.replace(/[^a-zA-Z0-9_.:-]/g, '_')}"`)
      .join(',');
    return safeLabels ? `${safeName}{${safeLabels}}` : safeName;
  }
}