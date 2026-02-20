import { loadConfig } from "./config.js";
import { initDatabase } from "./db.js";
import { initZulip } from "./zulip.js";
import type {
  ZulipClient,
  ZulipMessageEvent,
  ZulipReactionEvent,
} from "./zulip.js";
import { handleMessage } from "./bot.js";
import type { Config } from "./config.js";
import { createZulipMcpServer } from "./zulip-tools.js";
import { loadServices } from "./services/loader.js";
import type { Service, ServiceContext } from "./services/types.js";

const BACKOFF_MS = 5000;

async function registerQueue(client: ZulipClient) {
  const result = await client.queues.register({
    event_types: ["message", "reaction"],
  });
  console.log(`Registered event queue: ${result.queue_id}`);
  return { queueId: result.queue_id, lastEventId: result.last_event_id };
}

async function eventLoop(
  services: Service[],
  ctx: ServiceContext,
): Promise<void> {
  let { queueId, lastEventId } = await registerQueue(ctx.client);

  const zulipMcp = createZulipMcpServer(ctx.client);
  console.log("  Zulip MCP tools: enabled");

  while (true) {
    try {
      const response = await ctx.client.events.retrieve({
        queue_id: queueId,
        last_event_id: lastEventId,
      });

      for (const event of response.events) {
        lastEventId = event.id;

        if (event.type === "message") {
          handleMessage(
            event as ZulipMessageEvent,
            services,
            ctx,
            zulipMcp,
          ).catch((err) => {
            console.error("Unhandled error in handleMessage:", err);
          });
        }

        if (event.type === "reaction") {
          const reactionEvent = event as ZulipReactionEvent;
          for (const svc of services) {
            if (!svc.onReaction) continue;
            svc.onReaction(reactionEvent, ctx).catch((err) => {
              console.error(`[${svc.name}] error in onReaction:`, err);
            });
          }
        }
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (errorMsg.includes("BAD_EVENT_QUEUE_ID")) {
        console.warn("Event queue expired, re-registering...");
        ({ queueId, lastEventId } = await registerQueue(ctx.client));
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

  const { client, botEmail, botName, botUserId } = await initZulip(config);
  console.log(`  Bot:   ${botName} (${botEmail})`);

  initDatabase(config.dbPath);
  console.log(`  DB:    ${config.dbPath}`);

  const ctx: ServiceContext = { client, config, botEmail, botUserId };

  console.log("Loading services...");
  const services = await loadServices(ctx);
  console.log(`  ${services.length} service(s) active`);

  await eventLoop(services, ctx);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
