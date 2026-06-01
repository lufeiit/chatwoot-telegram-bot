/**
 * 按 key 划分的 FIFO 互斥锁。
 *
 * 设计目标：
 *  - 同 key 任务严格串行；
 *  - 排队公平（先入队先执行），避免唤醒风暴；
 *  - 任意一个 task throw 不阻塞队列其余任务；
 *  - 任务完成后自动清理空队列，避免 Map 膨胀。
 */
export class KeyedMutex {
    private tails = new Map<string, Promise<void>>();

    async runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
        const prev = this.tails.get(key) ?? Promise.resolve();

        // 链式排队：当前 task 在 prev 完成后才开始；其余 waiter 会接在我之后。
        let release!: () => void;
        const slot = new Promise<void>((resolve) => { release = resolve; });
        const myTail = prev.then(() => slot);
        this.tails.set(key, myTail);

        try {
            await prev;
            return await task();
        } finally {
            release();
            // 仅在自己是当前尾巴时才清理，避免误删后来者
            if (this.tails.get(key) === myTail) {
                this.tails.delete(key);
            }
        }
    }
}
