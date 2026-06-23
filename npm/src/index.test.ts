// Parity suite: every case mirrors a test in the Rust crate's src/trie.rs, so
// the native TS port stays byte-identical to the canonical implementation.
import { describe, expect, it } from "vitest";

import { isKnownSuffix, lookup, pslData, registrableDomain } from "./index.js";

describe("lookup", () => {
  it("resolves a simple .com domain", () => {
    const info = lookup("example.com");
    expect(info).toEqual({ suffix: "com", registrableDomain: "example.com", known: true });
  });

  it("resolves a nested co.uk domain", () => {
    const info = lookup("www.example.co.uk");
    expect(info?.suffix).toBe("co.uk");
    expect(info?.registrableDomain).toBe("example.co.uk");
  });

  it("strips subdomains down to eTLD+1", () => {
    const info = lookup("deep.sub.example.com");
    expect(info?.suffix).toBe("com");
    expect(info?.registrableDomain).toBe("example.com");
  });

  it("returns no registrable domain for a bare TLD", () => {
    const info = lookup("com");
    expect(info?.suffix).toBe("com");
    expect(info?.registrableDomain).toBeUndefined();
  });

  it("returns undefined for empty input", () => {
    expect(lookup("")).toBeUndefined();
  });

  it("accepts a single trailing dot (FQDN root)", () => {
    expect(lookup("example.com.")?.suffix).toBe("com");
  });

  it("rejects multiple trailing dots", () => {
    expect(lookup("example.com..")).toBeUndefined();
  });

  it("is case-insensitive", () => {
    expect(lookup("Example.COM")?.suffix).toBe("com");
  });

  it("lowercases the registrable domain", () => {
    expect(lookup("WWW.Example.CO.UK")?.registrableDomain).toBe("example.co.uk");
  });
});

describe("wildcard and exception rules", () => {
  it("matches a wildcard rule (*.ck)", () => {
    const info = lookup("example.foo.ck");
    expect(info).toEqual({ suffix: "foo.ck", registrableDomain: "example.foo.ck", known: true });
  });

  it("honors an exception rule (!www.ck)", () => {
    const info = lookup("www.ck");
    expect(info?.suffix).toBe("ck");
    expect(info?.registrableDomain).toBe("www.ck");
  });

  it("does not let a non-boundary exact child shadow the wildcard", () => {
    // *.futurecms.at with "ex" present as a path child but not a boundary.
    const info = lookup("ex.futurecms.at");
    expect(info?.suffix).toBe("ex.futurecms.at");
    expect(info?.registrableDomain).toBeUndefined();
    expect(info?.known).toBe(true);
  });

  it("matches a deeper wildcard under an exact child", () => {
    const info = lookup("site.test.ex.futurecms.at");
    expect(info?.suffix).toBe("test.ex.futurecms.at");
    expect(info?.registrableDomain).toBe("site.test.ex.futurecms.at");
    expect(info?.known).toBe(true);
  });
});

describe("invalid and sentinel input", () => {
  it("rejects a leading dot", () => {
    expect(lookup(".example.com")).toBeUndefined();
  });

  it("rejects consecutive dots", () => {
    expect(lookup("example..com")).toBeUndefined();
  });

  it("rejects wildcard sentinel labels in input", () => {
    expect(lookup("*.ck")).toBeUndefined();
    expect(lookup("foo.*.ck")).toBeUndefined();
  });

  it("rejects exception sentinel labels in input", () => {
    expect(lookup("!www.ck")).toBeUndefined();
  });
});

describe("unknown suffixes", () => {
  it("falls back to the implicit * rule for unknown TLDs", () => {
    // `.invalid` is permanently reserved (RFC 2606), so it can never appear in
    // a future PSL update and make this expectation flaky.
    const info = lookup("example.invalid");
    expect(info?.suffix).toBe("invalid");
    expect(info?.registrableDomain).toBe("example.invalid");
    expect(info?.known).toBe(false);
  });
});

describe("helpers", () => {
  it("registrableDomain strips the subdomain", () => {
    expect(registrableDomain("sub.example.com")).toBe("example.com");
    expect(registrableDomain("com")).toBeUndefined();
  });

  it("isKnownSuffix reflects PSL membership", () => {
    expect(isKnownSuffix("example.com")).toBe(true);
    expect(isKnownSuffix("")).toBe(false);
  });
});

describe("pslData", () => {
  it("returns the embedded binary trie blob", () => {
    const data = pslData();
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.length).toBeGreaterThan(50_000);
    // Root node flags byte: not a suffix boundary.
    expect(data[0]! & 1).toBe(0);
  });

  it("returns a defensive copy (mutation does not affect lookups)", () => {
    const a = pslData();
    a.fill(0xff);
    expect(lookup("example.com")?.suffix).toBe("com");
  });
});
