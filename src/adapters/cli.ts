#!/usr/bin/env node
/** CLI entry point (`qa-ticket-generator run --repo o/r --pr 12 --dry-run`). Wired in M2 by the control session. */
import { notImplemented } from '../core/stub';

export async function main(argv: string[]): Promise<number> {
  void argv;
  return notImplemented('adapters/cli');
}

void main(process.argv.slice(2));
