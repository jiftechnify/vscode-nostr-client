import { describe, expect, it } from "vitest";
import { parseHashtags } from "./nostr";

describe("parseHashtags", () => {
  it("parses single hashtag", () => {
    const content = "Hello #world";
    const hashtags = parseHashtags(content);
    expect(hashtags).toEqual(["world"]);
  });

  it("parses multiple hashtags", () => {
    const content = "Hello #world #Nostr #Zap";
    const hashtags = parseHashtags(content);
    expect(hashtags).toEqual(["world", "Nostr", "Zap"]);
  });

  it("parses hashtags mixed with normal text", () => {
    const content = "Hello #Nostr Make #Zap";
    const hashtags = parseHashtags(content);
    expect(hashtags).toEqual(["Nostr", "Zap"]);
  });

  it("parses hashtag split with zenkaku space", () => {
    const content = "こんにちは　#全角　#スペース";
    const hashtags = parseHashtags(content);
    expect(hashtags).toEqual(["全角", "スペース"]);
  });
});
