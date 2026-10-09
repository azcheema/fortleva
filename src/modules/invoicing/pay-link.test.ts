import { describe, expect, it } from "vitest";

import { PAY_LINK_HOSTS, payLinkUrl } from "@/config";

/**
 * WHERE A "PAY NOW" LINK MAY POINT (Phase 4 slice 109; founder decision C79
 * (f)): the payment services' own hosts, exactly. A link on an invoice is a
 * way to divert a payment, so every lookalike is refused. The database's CHECK
 * (`invoice_pay_link`) is the second fence — `send.dbtest.ts` drives it with
 * the same shapes.
 */

describe("payLinkUrl", () => {
  it("admits Stripe's and PayPal's own payment pages", () => {
    for (const ok of [
      "https://buy.stripe.com/test_7sI5n9aBc",
      "https://buy.stripe.com/7sI5n9aBc1dE",
      "https://invoice.stripe.com/i/acct_1AbC/live_YWNjdF8x",
      "https://www.paypal.com/ncp/payment/ABCD1234",
      "https://www.paypal.com/invoice/p/#INV2-ABCD-EFGH",
      "https://paypal.com/paypalme/naxdor/1250",
      "https://paypal.me/naxdor/1250SEK",
      "https://www.paypal.me/naxdor",
      "HTTPS://BUY.STRIPE.COM/abc",
    ]) {
      expect(payLinkUrl(ok), ok).not.toBeNull();
    }
  });

  it("stores the parsed link — the host lower-cased, nothing else invented", () => {
    expect(payLinkUrl("HTTPS://BUY.STRIPE.COM/abc")?.href).toBe("https://buy.stripe.com/abc");
    expect(payLinkUrl("https://paypal.me")?.href).toBe("https://paypal.me/");
  });

  it("refuses every other place, and every trick that dresses one up as Stripe or PayPal", () => {
    for (const bad of [
      "http://buy.stripe.com/abc",
      "https://evil.example/buy.stripe.com",
      "https://buy.stripe.com.evil.example/abc",
      "https://buy.stripe.com@evil.example/abc",
      "https://user:pass@buy.stripe.com/abc",
      "https://buy.stripe.com:8443/abc",
      "https://stripe.com/abc",
      // PayPal's legacy buttons carry a return address their author chose.
      "https://www.paypal.com/cgi-bin/webscr?cmd=_xclick&return=https://evil.example",
      "https://www.paypal.com/",
      "https://paypal.com/signin",
      // A Checkout Session dies within a day: never a link fixed at issue.
      "https://checkout.stripe.com/c/pay/cs_live_a1B2#fidkdWxOYHwnPyd1",
      "https://pay.stripe.com.example/abc",
      "https://evilpaypal.me/x",
      "https://paypal.me.evil.example/x",
      "https://xn--pypal-4ve.com/x",
      "https://www.paypa1.com/x",
      "https://203.0.113.7/x",
      "https:\\\\evil.example\\@buy.stripe.com",
      "https://buy.stripe.com/abc def",
      "https://buy.stripe.com/abc\n",
      "\thttps://buy.stripe.com/abc",
      "https://buy.stripe.com/\u0000abc",
      "javascript:alert(1)//buy.stripe.com",
      "//buy.stripe.com/abc",
      "buy.stripe.com/abc",
      "",
      `https://buy.stripe.com/${"a".repeat(500)}`,
    ]) {
      expect(payLinkUrl(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("is a closed list of exact hosts — no suffix matching", () => {
    for (const host of PAY_LINK_HOSTS) expect(host).toMatch(/^[a-z0-9.-]+$/);
    expect(payLinkUrl("https://x.buy.stripe.com/abc")).toBeNull();
    expect(payLinkUrl(42 as unknown as string)).toBeNull();
  });
});
