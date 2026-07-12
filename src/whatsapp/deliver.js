import { isJidGroup } from 'baileys';
import { nullLogger } from '../core/log.js';

/**
 * Proactive delivery: the ONE path every unattended send takes - scheduled messages and scheduled
 * AI instructions. It enforces the same activation gate as inbound commands (never
 * post into a group the owner has not authorized - directly, or via its community umbrella), and it
 * runs a `kind: 'ai'` job back through the dispatcher as a synthetic addressed message carrying the
 * SAME facts a live message would: chat, level, and crucially the parent community. Without that
 * last fact the dispatcher's own activation gate re-runs blind and silently swallows the job in a
 * sub-group that is active only under its community umbrella - a one-shot job would be consumed
 * without ever posting. Extracted from the composition root so this glue is unit-testable;
 * everything it touches is injected.
 *
 * The return value follows the scheduler's delivery protocol: `false` DECLINES (the destination is
 * currently ineligible - the job stays pending, never counted fired); any other value means the job
 * fired (even if it produced nothing to post).
 *
 * @param {{
 *   send: (chatId: string, message: string) => unknown,
 *   communityOf: (chatId: string) => Promise<string | undefined>,
 *   isActiveVia: (chatId: string, communityId?: string) => boolean,
 *   handle: (msg: object) => Promise<string | false | undefined>,
 *   requireActivation?: boolean,
 *   log?: import('../core/log.js').Logger,
 * }} deps
 * @returns {(chatId: string, text: string, job?: object) => Promise<unknown>}
 */
export function createDeliver({ send, communityOf, isActiveVia, handle, requireActivation = true, log = nullLogger }) {
  return async function deliver(chatId, text, job) {
    const group = isJidGroup(chatId);
    // The chat's parent community, when it has one: the activation gate below AND the synthetic AI
    // message both need it, so the dispatcher's umbrella check always agrees with this one.
    const communityId = group ? await communityOf(chatId) : undefined;
    // Proactive sends must respect the same activation gate as inbound commands: never post into a
    // group the owner has not authorized (or has deactivated, or removed the bot from). The rule
    // (active directly OR via the community umbrella) is activation.isActiveVia - the same one the
    // dispatcher's inbound gate consults, injected, not re-derived here. Private chats have no
    // activation entry and are never gated. Off when activation is not required.
    if (requireActivation && group && !isActiveVia(chatId, communityId)) {
      log.info('skip scheduled send to an inactive group', { chatId });
      return false; // DECLINE: signal the scheduler this was not delivered, so it leaves the job pending
    }
    // An AI job carries an INSTRUCTION, not fixed text: run it as the owner who scheduled it, through
    // the SAME dispatcher a live message uses (a synthetic addressed message flagged `scheduled`),
    // then post whatever it produced. All guards re-run; chat mode is forced on; sensitive commands
    // are skipped.
    if (job?.kind === 'ai') {
      const reply = await handle({
        text,
        sender: job.createdBy,
        chatId,
        // Community chats (the announcement chat and its sub-groups) live-classify as 'community',
        // and the dispatcher keys the chat's own data namespace on the level - a 'group' label here
        // would read/write group:<id> while live use of the same chat uses community:<id>.
        level: group ? (communityId ? 'community' : 'group') : 'private',
        addressed: true,
        scheduled: true,
        ...(communityId ? { community: communityId } : {}),
      });
      // `false` from the dispatcher means the AI layer was UNAVAILABLE (daily cap spent, provider
      // throttled/down) - the instruction never ran, so decline: the job stays pending and retries,
      // instead of a one-shot being consumed with no output.
      if (reply === false) {
        log.info('scheduled AI job deferred - the AI layer is unavailable', { chatId });
        return false;
      }
      if (!reply) return true; // it fired but produced nothing to post - advance the job (don't retry)
      return send(chatId, reply);
    }
    return send(chatId, text);
  };
}
