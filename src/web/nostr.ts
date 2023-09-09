import * as vscode from "vscode";

import { rxNostrAdapter } from "@nostr-fetch/adapter-rx-nostr";
import { NostrFetcher } from "nostr-fetch";
import { getPublicKey, nip19 } from "nostr-tools";
import { EventParameters, Nip07, Event as NostrEvent } from "nostr-typedef";
import {
  RxNostr,
  createRxForwardReq,
  createRxNostr,
  getSignedEvent,
  uniq,
  verify,
} from "rx-nostr";
import { filter } from "rxjs";

import { currUnixtime } from "./utils";

const KEY_NOSTR_PRIVATE_KEY = "nostr-priv-key";

const CONFIG_KEYS = {
  bootstrapRelays: "nostrClient.bootstrapRelays",
  additionalWriteRelays: "nostrClient.additionalWriteRelays",
};

const GLOBAL_STATE_KEYS = {
  metadataCache: "nostrMetadataCache",
};

const defaultBootstrapRelays = [
  "wss://relay.nostr.band",
  "wss://relayable.org",
];

const metadataCacheMaxAge = 12 * 60 * 60; // 12hr

type UserStatusProps = {
  status: string;
  linkUrl: string;
  expiration: number | undefined;
};

type SerializedMetadataCache = {
  lastUpdated: number;
  profile: Record<string, unknown>;
  relays: Nip07.GetRelayResult;
};

export class NostrSystem {
  #ctx: vscode.ExtensionContext;
  #rxNostr: RxNostr;
  #nostrFetcher: NostrFetcher;
  #sentEventIds: Set<string> = new Set();

  // account metadata
  #metaLastUpdated: number = 0;
  #profile: Record<string, unknown> = {};
  #relaysFromEvents: Nip07.GetRelayResult = {};

  // other states
  #userStatus = new UserStatus();

  private constructor(ctx: vscode.ExtensionContext) {
    this.#ctx = ctx;
    this.#rxNostr = createRxNostr();
    this.#nostrFetcher = NostrFetcher.withCustomPool(
      rxNostrAdapter(this.#rxNostr)
    );
  }

  static async init(ctx: vscode.ExtensionContext) {
    const sys = new NostrSystem(ctx);

    await sys.restoreMetadataFromCache();

    const syncMetadata =
      currUnixtime() - sys.#metaLastUpdated > metadataCacheMaxAge;
    await sys.syncStatesWithRelays({ syncMetadata });

    await sys.startStatesSyncSubscription();

    return sys;
  }

  /* key pair */
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

  private async publishEvent(ev: EventParameters<number>) {
    const privkey = await this.getPrivateKey();
    if (privkey === undefined) {
      console.error("private key is not set");
      return;
    }

    // record the id of event about to send
    const signed = await getSignedEvent(ev, privkey);
    this.#sentEventIds.add(signed.id);

    console.log("sending event: %O", ev);
    this.#rxNostr.send(signed).subscribe((packet) => {
      console.log(packet);
    });
  }

  async postText(content: string) {
    const privkey = await this.getPrivateKey();
    if (privkey === undefined) {
      console.error("private key is not set");
      return;
    }

    const ev = {
      kind: 1,
      content,
    };
    this.publishEvent(ev);
  }

  get profile() {
    return this.#profile;
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

  get relayStates() {
    return this.#rxNostr.getAllRelayState();
  }

  get userStatus() {
    return this.#userStatus.value;
  }
  async updateUserStatus({
    status,
    linkUrl,
    expiration: exp,
  }: UserStatusProps) {
    const ev = {
      kind: 30315,
      content: status,
      tags: [
        ["d", "general"],
        ...(linkUrl !== "" ? [["r", linkUrl]] : []),
        ...(exp !== undefined ? [["expiration", String(exp)]] : []),
      ],
    };
    this.publishEvent(ev);
    this.#userStatus.update(status, linkUrl, exp);
  }

  /* subscription for states syncronization */
  private async startStatesSyncSubscription() {
    const pubkey = await this.getPublicKey();
    if (pubkey === undefined) {
      console.log("private key is not set");
      return;
    }

    const req = createRxForwardReq();
    this.#rxNostr
      .use(req)
      .pipe(
        verify(),
        uniq(),
        filter(({ event }) => !this.#sentEventIds.has(event.id)) // filter out events sent by this client
      )
      .subscribe(async ({ event }) => {
        console.log("received from relays", event);

        let relayListUpdated = false;
        switch (event.kind) {
          case 0:
            this.#profile = JSON.parse(event.content) as Record<
              string,
              unknown
            >;
            break;

          case 3:
            // TODO: update follow list
            this.#relaysFromEvents = parseRelayListInKind3(event);
            relayListUpdated = true;
            break;

          case 10002:
            this.#relaysFromEvents = parseRelayListInKind10002(event);
            relayListUpdated = true;
            break;

          case 30315: {
            const linkUrl = getTagValue(event, "r");
            const expiration = getExpiration(event);
            this.#userStatus.update(event.content, linkUrl, expiration);
            break;
          }
        }

        if (relayListUpdated) {
          await this.#rxNostr.switchRelays(this.relays);
        }
      });

    const now = currUnixtime();
    req.emit([
      { kinds: [0, 3, 10002], authors: [pubkey], since: now },
      { kinds: [30315], authors: [pubkey], "#d": ["general"], since: now },
    ]);
  }

  /* oneshot data syncronization */
  async syncStatesWithRelays({ syncMetadata }: { syncMetadata: boolean }) {
    const pubkey = await this.getPublicKey();
    if (pubkey === undefined) {
      console.log("private key is not set");
      return;
    }

    if (syncMetadata) {
      await this.syncMetadataWithRelays(pubkey);
    }
    await this.syncUserStatusWithRelays(pubkey);
  }

  private async syncMetadataWithRelays(pubkey: string) {
    console.log("started sync-ing nostr metadata with relays");

    let relayConfig = this.relays;
    let readRelays = Object.entries(relayConfig)
      .filter(([_, { read }]) => read)
      .map(([rurl, _]) => rurl);
    if (readRelays.length === 0) {
      // use bootstrap relays if user has no read relays
      readRelays =
        getExtensionConfig<string[]>(CONFIG_KEYS.bootstrapRelays) ??
        defaultBootstrapRelays;
      relayConfig = Object.fromEntries(
        readRelays.map((rurl) => [rurl, { read: true, write: false }])
      );
    }
    await this.#rxNostr.switchRelays(relayConfig);

    await this.syncMetadataBody(readRelays, pubkey);

    this.#metaLastUpdated = currUnixtime();
    await this.saveMetadataToCache();
    console.log("finished sync-ing nostr metadata with relays");
  }

  private async syncMetadataBody(relays: string[], pubkey: string) {
    const relayListEvs: NostrEvent[] = [];
    const evIter = this.#nostrFetcher.fetchLastEventPerKey(
      "kinds",
      { keys: [0, 3, 10002], relayUrls: relays },
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
    await this.#rxNostr.switchRelays(this.relays);
  }

  private async syncUserStatusWithRelays(pubkey: string) {
    console.log("started sync-ing user status with relays");

    const readRelays = Object.entries(this.#relaysFromEvents)
      .filter(([_, { read }]) => read)
      .map(([rurl, _]) => rurl);

    const statusEv = await this.#nostrFetcher.fetchLastEvent(
      readRelays,
      { kinds: [30315], authors: [pubkey], "#d": ["general"] },
      {}
    );

    console.log("user status event:", statusEv);
    if (statusEv === undefined) {
      this.#userStatus.clear();
      return;
    }

    const linkUrl = getTagValue(statusEv, "r");
    const expiration = getExpiration(statusEv);
    this.#userStatus.update(statusEv.content, linkUrl, expiration);

    console.log("finished sync-ing user status with relays");
    return;
  }

  /* lifecycle */
  private async restoreMetadataFromCache() {
    const cache = this.#ctx.globalState.get<SerializedMetadataCache>(
      GLOBAL_STATE_KEYS.metadataCache
    );
    console.log("metadata cache:", cache);
    if (cache === undefined) {
      return;
    }
    this.#metaLastUpdated = cache.lastUpdated;
    this.#profile = cache.profile;
    this.#relaysFromEvents = cache.relays;

    if (Object.getOwnPropertyNames(this.#relaysFromEvents).length > 0) {
      await this.#rxNostr.switchRelays(this.#relaysFromEvents);
    }
  }

  async saveMetadataToCache() {
    const cache = {
      lastUpdated: this.#metaLastUpdated,
      profile: this.#profile,
      relays: this.#relaysFromEvents,
    };

    console.log("saving metadata to cache: %O", cache);
    await this.#ctx.globalState.update(GLOBAL_STATE_KEYS.metadataCache, {
      lastUpdated: this.#metaLastUpdated,
      profile: this.#profile,
      relays: this.#relaysFromEvents,
    });
  }

  async clear() {
    // clear private key
    await this.#ctx.secrets.delete(KEY_NOSTR_PRIVATE_KEY);

    // disconnect from relays
    this.#rxNostr.switchRelays({});

    // clear all states
    this.#profile = {};
    this.#relaysFromEvents = {};
    this.#userStatus.clear();

    // clear metadata cache
    await this.#ctx.globalState.update(
      GLOBAL_STATE_KEYS.metadataCache,
      undefined
    );
  }

  dispose() {
    this.#nostrFetcher.shutdown();
    this.#rxNostr.dispose();
  }
}

class UserStatus {
  #status: string = "";
  #linkUrl: string = "";
  #expiration: number | undefined;
  #expTimer: number | undefined;

  get value() {
    return {
      status: this.#status,
      linkUrl: this.#linkUrl,
      expiration: this.#expiration,
    };
  }

  update(status: string, linkUrl: string, expiration?: number) {
    this.#status = status;
    this.#linkUrl = linkUrl;
    this.#expiration = expiration;

    this.resetExpTimer();
  }

  clear() {
    this.#status = "";
    this.#linkUrl = "";
    this.#expiration = undefined;
    if (this.#expTimer !== undefined) {
      clearTimeout(this.#expTimer);
      this.#expTimer = undefined;
    }
  }

  private resetExpTimer() {
    if (this.#expTimer !== undefined) {
      clearTimeout(this.#expTimer);
      this.#expTimer = undefined;
    }
    if (this.#expiration === undefined) {
      return;
    }

    const dur = this.#expiration - currUnixtime();
    if (dur <= 0) {
      // already expired!
      this.#status = "";
      this.#linkUrl = "";
      this.#expiration = undefined;

      return;
    }
    this.#expTimer = setTimeout(() => {
      console.log("user status expired:", this.#status);
      this.clear();
    }, dur * 1000);
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

const getTagValue = (ev: NostrEvent, name: string): string =>
  ev.tags.find((t) => t[0] === name)?.[1] ?? "";

const getExpiration = (ev: NostrEvent): number | undefined => {
  const expStr = getTagValue(ev, "expiration");
  if (expStr === "") {
    return undefined;
  }
  const exp = Number(expStr);
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
