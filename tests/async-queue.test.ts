import assert from "node:assert/strict";
import test from "node:test";
import { AsyncQueue } from "../src/core/async-queue.js";

test("AsyncQueue 按顺序消费并在 close 后结束", async () => {
  const queue = new AsyncQueue<number>();
  queue.push(1);
  queue.push(2);
  queue.close();

  const values: number[] = [];
  for await (const value of queue) values.push(value);

  assert.deepEqual(values, [1, 2]);
});

test("AsyncQueue 会把 fail(error) 传播给 consumer", async () => {
  const queue = new AsyncQueue<number>();
  const expected = new Error("boom");
  queue.fail(expected);

  await assert.rejects(async () => {
    for await (const _value of queue) {
      // 不应进入这里。
    }
  }, expected);
});
