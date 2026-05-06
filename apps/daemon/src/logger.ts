import type { Logger } from '@claw/core';

export class ConsoleLogger implements Logger {
  constructor(private skill: string) {}

  info(msg: string, fields?: Record<string, unknown>): void {
    console.log(`[${this.skill}] ${msg}`, fields ?? '');
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    console.warn(`[${this.skill}] WARN ${msg}`, fields ?? '');
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    console.error(`[${this.skill}] ERROR ${msg}`, fields ?? '');
  }
}
