import { describe, it, expect } from 'vitest';
import { KeyedMutex } from '../mutex';

describe('KeyedMutex', () => {
    it('serializes tasks with the same key in FIFO order', async () => {
        const m = new KeyedMutex();
        const order: number[] = [];
        const tasks = [10, 30, 5, 20, 0].map((delay, i) =>
            m.runExclusive('k', async () => {
                await new Promise((r) => setTimeout(r, delay));
                order.push(i);
            })
        );
        await Promise.all(tasks);
        expect(order).toEqual([0, 1, 2, 3, 4]);
    });

    it('runs tasks with different keys concurrently', async () => {
        const m = new KeyedMutex();
        const start = Date.now();
        await Promise.all([
            m.runExclusive('a', () => new Promise((r) => setTimeout(r, 60))),
            m.runExclusive('b', () => new Promise((r) => setTimeout(r, 60))),
            m.runExclusive('c', () => new Promise((r) => setTimeout(r, 60))),
        ]);
        const elapsed = Date.now() - start;
        // 60ms each, concurrent → ~60ms total; serial would be ~180ms
        expect(elapsed).toBeLessThan(150);
    });

    it('does not deadlock if a task throws', async () => {
        const m = new KeyedMutex();
        const order: string[] = [];
        const p1 = m.runExclusive('k', async () => {
            order.push('1-start');
            throw new Error('boom');
        }).catch(() => order.push('1-caught'));
        const p2 = m.runExclusive('k', async () => {
            order.push('2');
        });
        await Promise.all([p1, p2]);
        expect(order).toEqual(['1-start', '1-caught', '2']);
    });

    it('returns the task value', async () => {
        const m = new KeyedMutex();
        const result = await m.runExclusive('k', async () => 42);
        expect(result).toBe(42);
    });

    it('cleans up empty queues', async () => {
        const m = new KeyedMutex();
        await m.runExclusive('k', async () => { /* noop */ });
        // Internal: tails map should drop the entry after the last task
        const tails = (m as unknown as { tails: Map<string, unknown> }).tails;
        expect(tails.has('k')).toBe(false);
    });
});
