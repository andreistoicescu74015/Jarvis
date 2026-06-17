/**
 * Outbox: a persisted FIFO of proactive messages waiting to go out, paced by the send
 * budget. Instead of blasting every recipient at once, `broadcast` enqueues one entry per
 * recipient; the background drain then releases them over time, never faster than the
 * budget allows, so a large broadcast spreads out and never bursts. Pure over the KV store
 * (ADR-0002), like the scheduler, so the queue survives restarts.
 *
 * An entry: `{ command, chatId, text }` stored under an incrementing numeric id.
 *
 * @param {import('../store/index.js').Store} store
 */
export function createOutbox(store) {
  const items = store.scoped('outbox'); // id -> { command, chatId, text }; plus '#seq'
  const SEQ = '#seq';

  const nextId = () => {
    const n = Number(items.get(SEQ) ?? 0) + 1;
    items.set(SEQ, n);
    return n;
  };

  /** Queue contents in FIFO (id) order; the `#seq` counter is not an entry. */
  const all = () =>
    items
      .list()
      .filter((e) => e.key !== SEQ)
      .map((e) => ({ id: Number(e.key), ...e.value }))
      .sort((a, b) => a.id - b.id);

  /** Append messages to the queue. `list` = `[{ chatId, text }]`, all tagged with `command`. */
  function enqueue(command, list) {
    for (const { chatId, text } of list ?? []) items.set(String(nextId()), { command, chatId, text });
  }

  const pending = () => all();

  /**
   * Release queued messages in order, each only if the budget allows it now; stop at the
   * first one the budget blocks (it waits for the next window). A delivery failure is
   * swallowed and the entry dropped - best-effort, never a retry storm.
   *
   * @param {{ deliver: (chatId: string, text: string) => unknown, budget?: { canSend: Function, record: Function }, at?: number }} opts
   * @returns {Promise<{ sent: number, remaining: number }>}
   */
  async function drain({ deliver, budget, at } = {}) {
    let sent = 0;
    for (const item of all()) {
      if (budget && !budget.canSend(item.command, at)) break;
      // Record the slot BEFORE delivering: a failed send still consumes its budget slot, so
      // a disconnected moment drops at most one queued message per window and the rest stay
      // queued - rather than the whole queue draining-and-dropping in a single pass.
      if (budget) budget.record(item.command, at);
      try {
        await deliver(item.chatId, item.text);
        sent++;
      } catch {
        /* best-effort: drop and move on */
      }
      items.delete(String(item.id));
    }
    return { sent, remaining: all().length };
  }

  return { enqueue, pending, drain };
}
