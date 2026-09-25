import { describe, expect, it } from "vitest";
import { releaseTarballSpecs } from "../../src/management/releaseSource.js";

describe("GitHub release source", () => {
  it("names the npm-packed main and platform relay tarballs of one release", () => {
    expect(releaseTarballSpecs("0.4.25-orbital.1", "linux-x64-gnu", "Fazeplant/ccodex")).toEqual([
      "https://github.com/Fazeplant/ccodex/releases/download/v0.4.25-orbital.1/gkorepanov-ccodex-0.4.25-orbital.1.tgz",
      "https://github.com/Fazeplant/ccodex/releases/download/v0.4.25-orbital.1/gkorepanov-ccodex-relay-linux-x64-gnu-0.4.25-orbital.1.tgz",
    ]);
  });

  it("rejects platforms without a relay package", () => {
    expect(() => releaseTarballSpecs("0.4.25-orbital.1", "linux-x64-musl")).toThrow(/no relay package/u);
  });
});
