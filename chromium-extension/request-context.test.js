import { describe, expect, it } from "vitest";

import {
  RequestContextStore,
  mergeSessionCookies,
  sanitizeRequestHeaders,
  serializeRequestBody,
} from "./request-context.js";

describe("sanitizeRequestHeaders", () => {
  it("preserves reproducibility headers while removing transport-managed headers", () => {
    expect(
      sanitizeRequestHeaders([
        { name: "User-Agent", value: "Browser UA" },
        { name: "referer", value: "https://app.example/watch" },
        { name: "Authorization", value: "Bearer token" },
        { name: "X-Signed-Request", value: "yes" },
        { name: "Host", value: "cdn.example" },
        { name: "Content-Length", value: "12" },
        { name: "Connection", value: "keep-alive" },
      ])
    ).toEqual({
      "User-Agent": "Browser UA",
      Referer: "https://app.example/watch",
      Authorization: "Bearer token",
      "X-Signed-Request": "yes",
    });
  });

  it("rejects invalid names, pseudo headers, and values containing newlines", () => {
    expect(
      sanitizeRequestHeaders([
        { name: ":authority", value: "example.com" },
        { name: "Bad Header", value: "x" },
        { name: "X-Test", value: "ok\r\nInjected: yes" },
      ])
    ).toEqual({});
  });
});

describe("serializeRequestBody", () => {
  it("serializes formData as an application/x-www-form-urlencoded body", () => {
    expect(
      serializeRequestBody({ formData: { query: ["hello world"], tag: ["a", "b"] } })
    ).toEqual({
      encoding: "utf8",
      content_type: "application/x-www-form-urlencoded",
      data: "query=hello+world&tag=a&tag=b",
      byte_length: 29,
      truncated: false,
    });
  });

  it("serializes raw upload bytes without losing binary data", () => {
    expect(
      serializeRequestBody({ raw: [{ bytes: new Uint8Array([0, 255, 16]).buffer }] })
    ).toEqual({
      encoding: "base64",
      content_type: null,
      data: "AP8Q",
      byte_length: 3,
      truncated: false,
    });
  });

  it("marks an oversized body unavailable instead of sending a partial request", () => {
    expect(
      serializeRequestBody({ raw: [{ bytes: new Uint8Array([1, 2, 3, 4]).buffer }] }, 3)
    ).toEqual({
      encoding: "unavailable",
      content_type: null,
      data: null,
      byte_length: 4,
      truncated: true,
    });
  });
});

describe("mergeSessionCookies", () => {
  it("replaces a stale captured cookie header with current URL-scoped cookies", () => {
    expect(
      mergeSessionCookies(
        { Cookie: "sid=old", Referer: "https://app.example/watch" },
        [
          { name: "sid", value: "fresh", path: "/media" },
          { name: "csrf", value: "abc", path: "/" },
        ]
      )
    ).toEqual({
      Cookie: "sid=fresh; csrf=abc",
      Referer: "https://app.example/watch",
    });
  });
});

describe("RequestContextStore", () => {
  it("correlates method, body, actual headers, and a redirected final URL", () => {
    let now = 1_000;
    const store = new RequestContextStore({ now: () => now, maxEntries: 10 });
    store.onBeforeRequest({
      requestId: "r1",
      tabId: 7,
      frameId: 2,
      method: "POST",
      url: "https://app.example/export",
      initiator: "https://app.example",
      documentUrl: "https://app.example/report",
      requestBody: { formData: { format: ["csv"] } },
    });
    store.onBeforeSendHeaders({
      requestId: "r1",
      requestHeaders: [
        { name: "User-Agent", value: "Browser UA" },
        { name: "Referer", value: "https://app.example/report" },
        { name: "Cookie", value: "sid=abc" },
      ],
    });
    now += 10;
    store.onBeforeRedirect({
      requestId: "r1",
      url: "https://app.example/export",
      redirectUrl: "https://cdn.example/signed/file.csv",
    });

    expect(store.findBest("https://cdn.example/signed/file.csv", 7)).toMatchObject({
      request_id: "r1",
      request_method: "POST",
      tab_id: 7,
      frame_id: 2,
      url: "https://cdn.example/signed/file.csv",
      original_url: "https://app.example/export",
      initiator: "https://app.example",
      document_url: "https://app.example/report",
      headers: {
        "User-Agent": "Browser UA",
        Referer: "https://app.example/report",
        Cookie: "sid=abc",
      },
      request_body: {
        encoding: "utf8",
        data: "format=csv",
      },
    });
  });

  it("expires old contexts and bounds retained entries", () => {
    let now = 0;
    const store = new RequestContextStore({ now: () => now, ttlMs: 100, maxEntries: 2 });
    for (let i = 0; i < 3; i += 1) {
      now += 1;
      store.onBeforeRequest({ requestId: `r${i}`, tabId: 1, frameId: 0, method: "GET", url: `https://e.test/${i}` });
    }
    expect(store.size).toBe(2);
    now = 200;
    expect(store.findBest("https://e.test/2", 1)).toBeNull();
    expect(store.size).toBe(0);
  });
});
