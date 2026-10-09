import { Actor, log } from 'apify';

import { normalizeInput } from './input.js';
import { shouldChargeForStatus } from './result.js';
import { EMAIL_CHECKED_EVENT, runVerification } from './run.js';

await Actor.main(async () => {
    const input = normalizeInput(await Actor.getInput());
    await runVerification(input, {
        log,
        openDataset: (id) => Actor.openDataset(id),
        openKeyValueStore: (id) => Actor.openKeyValueStore(id),
        pushResult: (item) => pushCheckedEmail(item),
    });
});

/**
 * Save every address. Charge `email-checked` only for a determined status
 * (valid, invalid, risky, disposable). unknown is stored and not charged,
 * whether the cause was DNS or SMTP.
 * @param {Record<string, unknown>} item
 */
async function pushCheckedEmail(item) {
    if (!shouldChargeForStatus(String(item.status))) {
        await Actor.pushData(item);
        return { eventChargeLimitReached: false };
    }
    try {
        const pricing = Actor.getChargingManager()?.getPricingInfo?.();
        if (pricing?.isPayPerEvent) {
            return await Actor.pushData(item, EMAIL_CHECKED_EVENT);
        }
    } catch (error) {
        log.warning(`Pricing check failed (${error.message}). Saving this address without a charge event.`);
    }
    await Actor.pushData(item);
    return { eventChargeLimitReached: false };
}
