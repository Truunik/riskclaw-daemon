import { createHash } from 'node:crypto';
import type { StorageAdapter, StorageKind } from '@claw/core';

export class MockStorage implements StorageAdapter {
  private store = new Map<string, Uint8Array>();

  async put(blob: Uint8Array, _kind: StorageKind): Promise<string> {
    const root = '0x' + createHash('sha256').update(blob).digest('hex');
    this.store.set(root, blob);
    return root;
  }

  async get(root: string): Promise<Uint8Array> {
    const b = this.store.get(root);
    if (!b) throw new Error(`unknown root ${root}`);
    return b;
  }
}
