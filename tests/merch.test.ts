import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultMerchStoreUrl,
  isStakeWarsOwnerUsername,
  merchNavItemForUser,
  normalizeMerchStoreUrl
} from "../src/shared/merch.ts";

test("merch store URL falls back to the official Shopify subdomain", () => {
  assert.equal(normalizeMerchStoreUrl(undefined), defaultMerchStoreUrl);
  assert.equal(normalizeMerchStoreUrl(""), defaultMerchStoreUrl);
  assert.equal(normalizeMerchStoreUrl("not a url"), defaultMerchStoreUrl);
});

test("merch store URL accepts configured HTTP(S) URLs and removes trailing slash", () => {
  assert.equal(normalizeMerchStoreUrl("https://shop.example.com/"), "https://shop.example.com");
  assert.equal(normalizeMerchStoreUrl("http://localhost:3001/"), "http://localhost:3001");
});

test("merch navigation is visible for authenticated users", () => {
  assert.equal(isStakeWarsOwnerUsername("NathanielRakel@GMAIL.com"), true);
  assert.equal(isStakeWarsOwnerUsername("player@example.com"), false);
  assert.equal(merchNavItemForUser("nathanielrakel@gmail.com", "https://gear.stakewars.ai/")?.url, defaultMerchStoreUrl);
  assert.equal(merchNavItemForUser("player@example.com", "https://gear.stakewars.ai")?.url, defaultMerchStoreUrl);
  assert.equal(merchNavItemForUser(null, "https://gear.stakewars.ai"), null);
});
