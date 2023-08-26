import { CONFIG_KEYS, KEY_NOSTR_PRIVATE_KEY } from "./consts";

import { NostrFetcher } from "nostr-fetch";
import { getPublicKey, nip19 } from "nostr-tools";
import { Nip07, Event as NostrEvent } from "nostr-typedef";
import * as vscode from "vscode";
import { currUnixtime } from "./utils";

const defaultBootstrapRelays = ["wss://relay.damus.io", "wss://relayable.org"];

export class NostrMetadataRepository {
  #ctx: vscode.ExtensionContext;
  #nostrFetcher: NostrFetcher;

  #profile: Record<string, unknown> = {};
  #relaysFromEvents: Nip07.GetRelayResult = {};
  #userStatus = new UserStatus();

  private constructor(ctx: vscode.ExtensionContext, nf: NostrFetcher) {
    this.#ctx = ctx;
    this.#nostrFetcher = nf;
  }

  static async init(ctx: vscode.ExtensionContext, nf: NostrFetcher) {
    const repo = new NostrMetadataRepository(ctx, nf);
    await repo.resync();
    return repo;
  }

  get relays(): Nip07.GetRelayResult {
    const res = { ...this.#relaysFromEvents };

    for (const wr of getExtensionConfig<string[]>(
      CONFIG_KEYS.additionalWriteRelays
    ) ?? []) {
      res[wr] = {
        read: res[wr]?.read ?? false,
        write: true,
      };
    }
    return res;
  }

  async updatePrivateKey(privkey: string) {
    return this.#ctx.secrets.store(KEY_NOSTR_PRIVATE_KEY, privkey);
  }

  async getPrivateKey(): Promise<string | undefined> {
    return this.#ctx.secrets.get(KEY_NOSTR_PRIVATE_KEY);
  }

  async isPrivatekeySet(): Promise<boolean> {
    return (await this.getPrivateKey()) !== undefined;
  }

  async getPublicKey(): Promise<string | undefined> {
    const privkey = await this.getPrivateKey();
    if (privkey === undefined) {
      return undefined;
    }
    return getPublicKey(privkey);
  }

  get profile() {
    return this.#profile;
  }

  get userStatus() {
    return this.#userStatus.value;
  }

  updateUserStatus(status: string, expiration?: number) {
    this.#userStatus.update(status, expiration);
  }

  async resync() {
    const pubkey = await this.getPublicKey();
    if (pubkey === undefined) {
      console.log("private key is not set");
      return;
    }

    console.log("started resync-ing nostr metadata repo");

    const bootstrapRelays =
      getExtensionConfig<string[]>(CONFIG_KEYS.bootstrapRelays) ??
      defaultBootstrapRelays;

    await Promise.all([
      this.resyncProfileAndRelays(bootstrapRelays, pubkey),
      this.resyncUserStatus(bootstrapRelays, pubkey),
    ]);

    console.log("finished resync-ing nostr metadata repo");
  }

  private async resyncProfileAndRelays(
    bootstrapRelays: string[],
    pubkey: string
  ) {
    const relayListEvs: NostrEvent[] = [];
    const evIter = this.#nostrFetcher.fetchLastEventPerKey(
      "kinds",
      { keys: [0, 3, 10002], relayUrls: bootstrapRelays },
      { authors: [pubkey] }
    );
    for await (const { key: kind, event } of evIter) {
      console.log(kind, event);
      switch (kind) {
        case 0:
          this.#profile =
            event !== undefined
              ? (JSON.parse(event.content) as Record<string, unknown>)
              : {};
          break;
        case 3:
        case 10002:
          if (event !== undefined) {
            relayListEvs.push(event);
          }
          break;
      }
    }
    this.#relaysFromEvents = parseRelayList(relayListEvs);
  }

  private async resyncUserStatus(bootstrapRelays: string[], pubkey: string) {
    const statusEv = await this.#nostrFetcher.fetchLastEvent(
      bootstrapRelays,
      { kinds: [30315], authors: [pubkey], "#d": ["general"] },
      {}
    );
    if (statusEv === undefined) {
      this.#userStatus.update("");
      return;
    }

    console.log(statusEv);

    const exp = getExpiration(statusEv);
    this.#userStatus.update(statusEv.content, exp);
    return;
  }

  async clear() {
    await this.#ctx.secrets.delete(KEY_NOSTR_PRIVATE_KEY);

    // clear all metadata
    this.#profile = {};
    this.#relaysFromEvents = {};
    this.#userStatus.clear();
  }

  dispose() {
    this.#nostrFetcher.shutdown();
  }
}

class UserStatus {
  #status: string = "";
  #expTimer: NodeJS.Timeout | undefined;

  get value() {
    return this.#status;
  }

  update(status: string, expiration?: number) {
    this.#status = status;

    if (this.#expTimer !== undefined) {
      clearTimeout(this.#expTimer);
    }

    if (expiration === undefined) {
      return;
    }

    const dur = expiration - currUnixtime();
    if (dur <= 0) {
      // already expired!
      this.#status = "";
    }
    this.#expTimer = setTimeout(() => {
      console.log("user status expired:", this.#status);
      this.#status = "";
    }, dur * 1000);
  }

  clear() {
    this.#status = "";
    if (this.#expTimer !== undefined) {
      clearTimeout(this.#expTimer);
      this.#expTimer = undefined;
    }
  }
}

const getExtensionConfig = <T>(section: string): T | undefined => {
  return vscode.workspace.getConfiguration().get<T>(section);
};

const parseRelayList = (evs: NostrEvent[]): Nip07.GetRelayResult => {
  const relayListEvs = evs.filter((ev) => [3, 10002].includes(ev.kind));
  if (relayListEvs.length === 0) {
    return {};
  }
  const latest = relayListEvs.sort(
    (a, b) => b.created_at - a.created_at
  )[0] as NostrEvent;

  switch (latest.kind) {
    case 3:
      return parseRelayListInKind3(latest);
    case 10002:
      return parseRelayListInKind10002(latest);
    default:
      console.error("parseRelayList: unreachable");
      return {};
  }
};

const parseRelayListInKind3 = (ev: NostrEvent): Nip07.GetRelayResult => {
  try {
    return JSON.parse(ev.content) as Nip07.GetRelayResult; // TODO: schema validation
  } catch (err) {
    console.error("failed to parse kind 3 event:", err);
    return {};
  }
};

const parseRelayListInKind10002 = (ev: NostrEvent): Nip07.GetRelayResult => {
  const res: Nip07.GetRelayResult = {};

  ev.tags
    .filter((t) => t.length >= 2 && t[0] === "r")
    .forEach((t) => {
      const [, url, relayType] = t as [string, string, string | undefined];

      if (relayType === undefined) {
        res[url] = { read: true, write: true };
      } else {
        switch (relayType) {
          case "read":
            res[url] = { read: true, write: false };
            return;
          case "write":
            res[url] = { read: false, write: true };
            return;
          default:
            console.warn("invalid relay type in kind 10002 event:", relayType);
            undefined;
        }
      }
    });

  return res;
};

const getExpiration = (ev: NostrEvent): number | undefined => {
  const s = ev.tags.find((t) => t[0] === "expiration")?.[1] ?? undefined;
  if (s === undefined) {
    return undefined;
  }
  const exp = Number(s);
  return !isNaN(exp) ? exp : undefined;
};

const regexp32BytesHexStr = /^[a-f0-9]{64}$/;

// if `pk` is ...
// - bech32-encoded private key ("nsec1...`), validate and convert to hex string.
// - hex string of 32 byte data, leave it as is.
// - otherwise, return `undefined`.
export const toHexPrivateKey = (pk: string): string | undefined => {
  if (pk.startsWith("nsec1")) {
    try {
      const res = nip19.decode(pk);
      if (res.type === "nsec") {
        return res.data;
      }
      console.log("toHexPrivateKey: unexpected decode result");
      return undefined;
    } catch (err) {
      console.error(err);
      return undefined;
    }
  }
  return regexp32BytesHexStr.test(pk) ? pk : undefined;
};
