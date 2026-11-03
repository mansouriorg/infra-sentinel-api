import { Injectable } from '@nestjs/common';
import type { LiveEvent } from './monitor.types';

type Listener = (event: LiveEvent) => void;
type Tap = (orgId: string, event: LiveEvent) => void;

@Injectable()
export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly taps = new Set<Tap>();

  tap(listener: Tap): () => void {
    this.taps.add(listener);
    return () => {
      this.taps.delete(listener);
    };
  }

  subscribe(orgId: string, listener: Listener): () => void {
    let set = this.listeners.get(orgId);
    if (!set) {
      set = new Set();
      this.listeners.set(orgId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(orgId);
    };
  }

  publish(orgId: string, event: LiveEvent): void {
    for (const tap of [...this.taps]) {
      try {
        tap(orgId, event);
      } catch {
        this.taps.delete(tap);
      }
    }
    const set = this.listeners.get(orgId);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        set.delete(listener);
      }
    }
  }

  listenerCount(orgId: string): number {
    return this.listeners.get(orgId)?.size ?? 0;
  }
}
