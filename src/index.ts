import { loadConfig } from "./config.js";
import { initZulip } from "./zulip.js";
import type { ZulipClient, ZulipMessageEvent } from "./zulip.js";
import { handleMessage } from "./bot.js";
import type { Config } from "./config.js";

const BACKOFF_MS = 5000;

async function registerQueue(client: ZulipClient) {
  const result = await client.queues.register({
    event_types: ["message"],
  });
  console.log(`Registered event queue: ${result.queue_id}`);
  return { queueId: result.queue_id, lastEventId: result.last_event_id };
}

async function eventLoop(
  client: ZulipClient,
  botEmail: string,
  config: Config,
): Promise<void> {
  let { queueId, lastEventId } = await registerQueue(client);

  while (true) {
    try {
      const response = await client.events.retrieve({
        queue_id: queueId,
        last_event_id: lastEventId,
      });

      for (const event of response.events) {
        lastEventId = event.id;

        if (event.type === "message") {
          // Fire-and-forget: handle concurrently, don't block the event loop
          handleMessage(
            client,
            botEmail,
            event as ZulipMessageEvent,
            config,
          ).catch((err) => {
            console.error("Unhandled error in handleMessage:", err);
          });
        }
      }
    } catch (err: unknown) {
      const errorMsg =
        err instanceof Error ? err.message : String(err);

      // Re-register queue if it expired
      if (errorMsg.includes("BAD_EVENT_QUEUE_ID")) {
        console.warn("Event queue expired, re-registering...");
        ({ queueId, lastEventId } = await registerQueue(client));
        continue;
      }

      console.error(`Event loop error: ${errorMsg}`);
      console.log(`Backing off ${BACKOFF_MS}ms before retrying...`);
      await sleep(BACKOFF_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const config = loadConfig();
  console.log("Starting Zulip Claude bot...");
  console.log(`  Realm: ${config.zulipRealm}`);
  console.log(`  CWD:   ${config.claudeCwd}`);

  const { client, botEmail, botName } = await initZulip(config);
  console.log(`  Bot:   ${botName} (${botEmail})`);

  await eventLoop(client, botEmail, config);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
