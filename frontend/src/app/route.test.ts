import { describe, expect, it } from "vitest";
import { formatRoute, parseRoute } from "./route";

describe("parseRoute", () => {
  it("parses empty and new-chat hashes as valid routes with null sessionId", () => {
    expect(parseRoute("")).toEqual({ sessionId: null });
    expect(parseRoute("#")).toEqual({ sessionId: null });
    expect(parseRoute("#/")).toEqual({ sessionId: null });
    expect(parseRoute("#/new")).toEqual({ sessionId: null });
  });

  it("parses valid session routes with numeric parameters including step=0", () => {
    const route = parseRoute(
      "#/s/demo_s_order?m=demo_m_order&v=1&view=check&check=demo_chk_demo_order_v1_1&p=NoCancelledExecution&step=0",
    );
    expect(route).toEqual({
      sessionId: "demo_s_order",
      modelId: "demo_m_order",
      version: 1,
      view: "check",
      check: "demo_chk_demo_order_v1_1",
      property: "NoCancelledExecution",
      step: 0,
    });
    expect(formatRoute(route)).toBe(
      "#/s/demo_s_order?m=demo_m_order&v=1&view=check&check=demo_chk_demo_order_v1_1&p=NoCancelledExecution&step=0",
    );
  });

  it("decodes valid percent-encoded session IDs", () => {
    expect(parseRoute("#/s/my%20session%2B1")).toEqual({
      sessionId: "my session+1",
      modelId: undefined,
      version: undefined,
      view: undefined,
      check: undefined,
      property: undefined,
      step: undefined,
    });
  });

  it("handles malformed percent-encoding without throwing URIError", () => {
    const badPath = parseRoute("#/s/%");
    expect(badPath.sessionId).toBeNull();
    expect(badPath.error?.code).toBe("invalid_encoding");

    const badUtf8 = parseRoute("#/s/%E0%A4%A");
    expect(badUtf8.sessionId).toBeNull();
    expect(badUtf8.error?.code).toBe("invalid_encoding");

    const badQuery = parseRoute("#/s/demo_s_order?m=%");
    expect(badQuery.sessionId).toBe("demo_s_order");
    expect(badQuery.error?.code).toBe("invalid_encoding");
  });

  it.each(["0", "-1", "abc", "1.5", "", "99999999999999999999999"])(
    "rejects invalid version parameter v=%s",
    (raw) => {
      const route = parseRoute(`#/s/demo_s_order?m=demo_m_order&v=${raw}`);
      expect(route.sessionId).toBe("demo_s_order");
      expect(route.error?.code).toBe("invalid_param");
    },
  );

  it.each(["-1", "abc", "2.5", "", "99999999999999999999999"])(
    "rejects invalid step parameter step=%s",
    (raw) => {
      const route = parseRoute(`#/s/demo_s_order?m=demo_m_order&v=1&step=${raw}`);
      expect(route.sessionId).toBe("demo_s_order");
      expect(route.error?.code).toBe("invalid_param");
    },
  );

  it("rejects malformed paths", () => {
    expect(parseRoute("#/s/").error?.code).toBe("invalid_path");
    expect(parseRoute("#/s/%20").error?.code).toBe("invalid_path");
    expect(parseRoute("#/s/a/b").error?.code).toBe("invalid_path");
    expect(parseRoute("#/unknown").error?.code).toBe("invalid_path");
  });
});
