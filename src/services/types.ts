import type { ZulipClient, ZulipMessage, ZulipReactionEvent } from "../zulip.js";
import type { Config } from "../config.js";

export interface ServiceContext {
  client: ZulipClient;
  config: Config;
  botEmail: string;
  botUserId: number;
}

export interface ServiceCommand {
  /** How to invoke, e.g. "task --own-topic" */
  usage: string;
  /** Short description of what it does. */
  description: string;
}

export interface Service {
  /** Unique service name (used for SERVICE_{NAME} env toggle). */
  name: string;

  /** Short description shown at startup. */
  description: string;

  /** Whether the service is active when no env override exists. */
  defaultEnabled: boolean;

  /** Structured command list for help display. */
  commands?: ServiceCommand[];

  /** Called once after the service is loaded. */
  init?(ctx: ServiceContext): Promise<void>;

  /**
   * Handle an @-mention message before Claude sees it.
   * Return true to indicate the message was handled (Claude is skipped).
   */
  onMessage?(msg: ZulipMessage, ctx: ServiceContext): Promise<boolean>;

  /** Handle a reaction add/remove event. */
  onReaction?(
    event: ZulipReactionEvent,
    ctx: ServiceContext,
  ): Promise<void>;
}
