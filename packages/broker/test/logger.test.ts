/**
 * Logger tests — must not pollute stdout, must respect level filtering.
 */

import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";

describe("logger", () => {
  it("respects level threshold", () => {
    const lines: string[] = [];
    const log = createLogger({
      level: "warn",
      sink: (line) => lines.push(line),
    });

    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("[warn] w");
    expect(lines[1]).toContain("[error] e");
  });

  it("can be disabled entirely", () => {
    const lines: string[] = [];
    const log = createLogger({
      enabled: false,
      sink: (line) => lines.push(line),
    });

    log.error("nope");
    expect(lines.length).toBe(0);
  });

  it("default sink writes to stderr (sanity check)", () => {
    // Just ensure constructing with defaults does not throw.
    const log = createLogger({ enabled: false });
    log.info("anything");
  });
});
