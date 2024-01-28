import * as vscode from "vscode";

import { rxNostrAdapter } from "@nostr-fetch/adapter-rx-nostr";
import { NostrFetcher } from "nostr-fetch";
import { getPublicKey } from "nostr-tools";
import { EventParameters, Nip07, Event as NostrEvent } from "nostr-typedef";
import { RxNostr, createRxForwardReq, createRxNostr, getSignedEvent, uniq, verify } from "rx-nostr";
import { filter } from "rxjs";

import { CONFIG_KEYS } from "./const";
import {
  UserStatus,
  getExpiration,
  getTagValue,
  parseHashtags,
  parseRelayList,
  parseRelayListInKind10002,
  parseRelayListInKind3,
} from "./nostr";
import { currUnixtime, currUnixtimeMilli } from "./utils";

const SECRET_STORE_KEYS = {
  nostrPrivateKey: "nostr-priv-key",
};

const GLOBAL_STATE_KEYS = {
  metadataCache: "nostrMetadataCache",
  updatePrivateKeyLock: "updatePrivateKeyLock",
};

const defaultBootstrapRelays = ["wss://relay.nostr.band", "wss://relayable.org"];

const metadataCacheMaxAge = 12 * 60 * 60 * 1000; // 12hr

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

  // states sync-ed with relays
  #metaLastUpdated: number = 0; // unixtime in millisecond
  #profile: Record<string, unknown> = {};
  #relaysFromEvents: Nip07.GetRelayResult = {};
  #userStatus = new UserStatus();

  #isPrivateKeyUpdateInitiator = false;

  private constructor(ctx: vscode.ExtensionContext) {
    this.#ctx = ctx;
    this.#rxNostr = createRxNostr();
    this.#nostrFetcher = NostrFetcher.withCustomPool(rxNostrAdapter(this.#rxNostr));
  }

  static async init(ctx: vscode.ExtensionContext) {
    const sys = new NostrSystem(ctx);

    await sys.restoreMetadataFromCache();

    const syncMetadata = currUnixtimeMilli() - sys.#metaLastUpdated > metadataCacheMaxAge;
    await sys.syncStatesWithRelays({ syncMetadata });

    await sys.startStatesSyncSubscription();
    sys.listenPrivateKeyChange();

    return sys;
  }

  /* key pair */
  async updatePrivateKey(privkey: string) {
    // acquire lock to update private key
    // note: this is "loose" lock.  a guarantee that only one instance can update key is not perfect.
    if (this.#ctx.globalState.get(GLOBAL_STATE_KEYS.updatePrivateKeyLock) !== undefined) {
      console.warn("updatePrivateKey: private key is being updated by another instance. abort");
      return;
    }

    console.log("started updating private key");
    try {
      await this.#ctx.globalState.update(GLOBAL_STATE_KEYS.updatePrivateKeyLock, true);
      this.#isPrivateKeyUpdateInitiator = true;

      await this.#ctx.secrets.store(SECRET_STORE_KEYS.nostrPrivateKey, privkey);

      // initiator of key update is in charge of updating global cache
      await this.clearStates();
      await this.clearGlobalCache();
      await this.syncStatesWithRelays({ syncMetadata: true });
      await this.saveMetadataToCache();

      console.log("finished updating private key");
    } finally {
      // release lock
      await this.#ctx.globalState.update(GLOBAL_STATE_KEYS.updatePrivateKeyLock, undefined);
    }
  }

  async clearPrivateKey() {
    // acquire lock to update private key
    // note: this is "loose" lock.  a guarantee that only one instance can update key is not perfect.
    if (this.#ctx.globalState.get(GLOBAL_STATE_KEYS.updatePrivateKeyLock) !== undefined) {
      console.warn("clearPrivateKey: private key is being updated by another instance. abort");
      return;
    }

    console.log("started clearing private key");
    try {
      await this.#ctx.globalState.update(GLOBAL_STATE_KEYS.updatePrivateKeyLock, true);
      this.#isPrivateKeyUpdateInitiator = true;

      await this.#ctx.secrets.delete(SECRET_STORE_KEYS.nostrPrivateKey);

      // initiator of key update is in charge of clearing global cache
      await this.clearStates();
      await this.clearGlobalCache();

      console.log("finished clearing private key");
    } finally {
      // release lock
      await this.#ctx.globalState.update(GLOBAL_STATE_KEYS.updatePrivateKeyLock, undefined);
    }
  }

  async getPrivateKey(): Promise<string | undefined> {
    return this.#ctx.secrets.get(SECRET_STORE_KEYS.nostrPrivateKey);
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

  private listenPrivateKeyChange() {
    this.#ctx.secrets.onDidChange(async (ev) => {
      if (ev.key === SECRET_STORE_KEYS.nostrPrivateKey) {
        if (!this.#isPrivateKeyUpdateInitiator) {
          // instances which are not the initiator should update only states of itself
          console.log("clearing and refetching states due to private key update");
          await this.clearStates();
          await this.syncStatesWithRelays({ syncMetadata: true }); // this is noop if key is cleared
        } else {
          console.log("resetting #isPrivateKeyUpdateInitiator");
          this.#isPrivateKeyUpdateInitiator = false;
        }
      }
    });
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

    const hashtags = parseHashtags(content);
    const tTags = hashtags.map((tag) => ["t", tag]);

    const ev = {
      kind: 1,
      content,
      tags: [...tTags],
    };
    await this.publishEvent(ev);
  }

  get profile() {
    return this.#profile;
  }

  get relays(): Nip07.GetRelayResult {
    const res = { ...this.#relaysFromEvents };

    for (const wr of getExtensionConfig<string[]>(CONFIG_KEYS.additionalWriteRelays) ?? []) {
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
  async updateUserStatus({ status, linkUrl, expiration: exp }: UserStatusProps) {
    const ev = {
      kind: 30315,
      content: status,
      tags: [
        ["d", "general"],
        ...(linkUrl !== "" ? [["r", linkUrl]] : []),
        ...(exp !== undefined ? [["expiration", String(exp)]] : []),
      ],
    };
    await this.publishEvent(ev);
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
            this.#profile = JSON.parse(event.content) as Record<string, unknown>;
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
      readRelays = getExtensionConfig<string[]>(CONFIG_KEYS.bootstrapRelays) ?? defaultBootstrapRelays;
      relayConfig = Object.fromEntries(readRelays.map((rurl) => [rurl, { read: true, write: false }]));
    }
    await this.#rxNostr.switchRelays(relayConfig);

    await this.syncMetadataBody(readRelays, pubkey);

    this.#metaLastUpdated = currUnixtimeMilli();
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
          this.#profile = event !== undefined ? (JSON.parse(event.content) as Record<string, unknown>) : {};
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
    const cache = this.#ctx.globalState.get<SerializedMetadataCache>(GLOBAL_STATE_KEYS.metadataCache);
    console.log("got metadata cache:", cache);
    if (cache === undefined) {
      return;
    }
    if (this.#metaLastUpdated >= cache.lastUpdated) {
      // having data newer than cache
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

  private async clearStates() {
    console.log("clearing internal states...");

    // disconnect from relays
    await this.#rxNostr.switchRelays({});

    // clear all states
    this.#profile = {};
    this.#relaysFromEvents = {};
    this.#userStatus.clear();
  }

  private async clearGlobalCache() {
    console.log("clearing global metadata cache...");

    await this.#ctx.globalState.update(GLOBAL_STATE_KEYS.metadataCache, undefined);
  }

  dispose() {
    this.#nostrFetcher.shutdown();
    this.#rxNostr.dispose();
  }
}

const getExtensionConfig = <T>(section: string): T | undefined => {
  return vscode.workspace.getConfiguration().get<T>(section);
};
