import { describe, expect, it } from "vitest";
import { parseHashtags } from "./nostr";

describe("parseHashtags", () => {
  it("parses hashtags", () => {
    const content = "Hello #world";
    const hashtags = parseHashtags(content);
    expect(hashtags).toEqual(["world"]);
  });
});
