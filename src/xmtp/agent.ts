import { Agent, createUser, createSigner } from "@xmtp/agent-sdk";
import { parseMessage, serializeMessage, type ProtocolMessage } from "./messages.js";
import type { Hex } from "../ceremony/types.js";

const DM_ONLY_TYPES = new Set(["dkg/round2"]);

export type MessageHandler = (
  msg: ProtocolMessage,
  reply: (response: ProtocolMessage) => Promise<void>,
  sendDm: (toAddress: Hex, msg: ProtocolMessage) => Promise<void>,
  isDm: boolean,
) => Promise<void>;

export class ChorusAgent {
  readonly name: string;
  private agent: Agent | null = null;
  private handlers = new Map<string, MessageHandler>();

  constructor(
    readonly walletKey: Hex,
    name: string,
    private dbPath?: string,
  ) {
    this.name = name;
  }

  on(messageType: string, handler: MessageHandler): void {
    this.handlers.set(messageType, handler);
  }

  async start(): Promise<void> {
    const user = createUser(this.walletKey);
    const signer = createSigner(user);
    this.agent = await Agent.create(signer, {
      dbPath: this.dbPath,
    });

    this.agent.on("text", async (ctx) => {
      if (!ctx.isText()) return;
      const raw = ctx.message.content;
      if (typeof raw !== "string") return;

      let msg: ProtocolMessage;
      try {
        msg = parseMessage(raw);
      } catch {
        return;
      }

      const isDm = ctx.isDm();

      // drop DM-only message types arriving via group
      if (DM_ONLY_TYPES.has(msg.type) && !isDm) {
        console.warn(`[${this.name}] dropped ${msg.type} from group (DM-only)`);
        return;
      }

      const handler = this.handlers.get(msg.type);
      if (!handler) return;

      const sendText = async (response: ProtocolMessage) => {
        await ctx.conversation.sendText(serializeMessage(response));
      };

      const reply = async (response: ProtocolMessage) => {
        await sendText(response);
        await this.selfDeliver(response, sendText);
      };

      const sendDm = async (toAddress: Hex, dmMsg: ProtocolMessage) => {
        const dm = await this.agent!.createDmWithAddress(toAddress);
        await dm.sendText(serializeMessage(dmMsg));
      };

      await handler(msg, reply, sendDm, isDm);
    });

    this.agent.on("start", () => {
      console.log(`[${this.name}] started - ${this.agent!.address}`);
    });

    await this.agent.start();
  }

  private async selfDeliver(
    msg: ProtocolMessage,
    sendText: (response: ProtocolMessage) => Promise<void>,
  ): Promise<void> {
    const handler = this.handlers.get(msg.type);
    if (!handler) return;

    const reply = async (response: ProtocolMessage) => {
      await sendText(response);
      await this.selfDeliver(response, sendText);
    };

    const sendDm = async (toAddress: Hex, dmMsg: ProtocolMessage) => {
      const dm = await this.agent!.createDmWithAddress(toAddress);
      await dm.sendText(serializeMessage(dmMsg));
    };

    await handler(msg, reply, sendDm, false);
  }

  async sendToGroup(groupId: string, msg: ProtocolMessage): Promise<void> {
    if (!this.agent) throw new Error("agent not started");
    const ctx = await this.agent.getConversationContext(groupId);
    if (ctx) {
      await ctx.conversation.sendText(serializeMessage(msg));
    }
    const sendText = async (response: ProtocolMessage) => {
      const c = await this.agent!.getConversationContext(groupId);
      if (c) await c.conversation.sendText(serializeMessage(response));
    };
    await this.selfDeliver(msg, sendText);
  }

  async createGroup(peerAddresses: Hex[], groupName: string): Promise<string> {
    if (!this.agent) throw new Error("agent not started");
    const group = await this.agent.createGroupWithAddresses(peerAddresses, {
      groupName,
      groupDescription: "FROST signing committee",
    });
    return group.id;
  }

  get address(): string {
    if (!this.agent) throw new Error("agent not started");
    return this.agent.address!;
  }

  async stop(): Promise<void> {
    if (this.agent) await this.agent.stop();
  }
}
