import { bytesToHex } from "@noble/hashes/utils";
import * as nip19 from "nostr-tools/nip19";
import type { Nip07, Event as NostrEvent } from "nostr-typedef";

import { currUnixtime } from "./utils";

export class UserStatus {
  #status = "";
  #linkUrl = "";
  #expiration: number | undefined;
  #expTimer: NodeJS.Timeout | undefined;

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

export const parseRelayList = (evs: NostrEvent[]): Nip07.GetRelayResult => {
  const relayListEvs = evs.filter((ev) => [3, 10002].includes(ev.kind));
  if (relayListEvs.length === 0) {
    return {};
  }
  const latest = relayListEvs.sort((a, b) => b.created_at - a.created_at)[0] as NostrEvent;

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

export const parseRelayListInKind3 = (ev: NostrEvent): Nip07.GetRelayResult => {
  try {
    return JSON.parse(ev.content) as Nip07.GetRelayResult; // TODO: schema validation
  } catch (err) {
    console.error("failed to parse kind 3 event:", err);
    return {};
  }
};

export const parseRelayListInKind10002 = (ev: NostrEvent): Nip07.GetRelayResult => {
  const res: Nip07.GetRelayResult = {};

  for (const t of ev.tags.filter((t) => t.length >= 2 && t[0] === "r")) {
    const [, url, relayType] = t as [string, string, string | undefined];

    switch (relayType) {
      case undefined:
        res[url] = { read: true, write: true };
        break;
      case "read":
        res[url] = { read: true, write: false };
        break;
      case "write":
        res[url] = { read: false, write: true };
        break;
      default:
        console.warn("invalid relay type in kind 10002 event:", relayType);
        undefined;
    }
  }

  return res;
};

export const getTagValue = (ev: NostrEvent, name: string): string => ev.tags.find((t) => t[0] === name)?.[1] ?? "";

export const getExpiration = (ev: NostrEvent): number | undefined => {
  const expStr = getTagValue(ev, "expiration");
  if (expStr === "") {
    return undefined;
  }
  const exp = Number(expStr);
  return !Number.isNaN(exp) ? exp : undefined;
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
        return bytesToHex(res.data);
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

export const parseHashtags = (content: string): string[] => {
  const tags = [];
  let rest = content;

  while (true) {
    const hashIdx = rest.indexOf("#");
    if (hashIdx === -1) {
      break;
    }

    const afterHash = rest.slice(hashIdx + 1);
    // TODO: consider other puctuations as tag terminators
    const spaceIdx = afterHash.search(/\s/);
    if (spaceIdx === -1) {
      tags.push(afterHash);
      break;
    }
    tags.push(afterHash.slice(0, spaceIdx));
    rest = afterHash.slice(spaceIdx + 1);
  }
  return tags;
};
