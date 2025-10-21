// api/create-checkout-session.js

import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const CURRENCY = (process.env.CURRENCY || "usd").toLowerCase();

const SUCCESS_URL =
  process.env.SUCCESS_URL ||
  "https://evermois.com/pages/stripe-success?session_id={CHECKOUT_SESSION_ID}";
const CANCEL_URL = process.env.CANCEL_URL || "https://evermois.com/cart";

const ORIGINS = (process.env.ALLOWED_ORIGINS || "https://evermois.com,https://www.evermois.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DEFAULT_SHIPPING_RATE_ID = process.env.DEFAULT_SHIPPING_RATE_ID || "";
const SHIPPING_COUNTRIES = (process.env.SHIPPING_COUNTRIES || "US,CA,GB,AU,DE")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const LOCALE = "en"; // ✅ 强制英文
const BILLING_COLLECTION = process.env.BILLING_COLLECTION || "auto";

// ✅ CORS域校验
function pickOrigin(req) {
  const origin = req.headers.origin || "";
  if (ORIGINS.includes("*")) return "*";
  return ORIGINS.includes(origin) ? origin : ORIGINS[0];
}

export default async function handler(req, res) {
  const allowOrigin = pickOrigin(req);

  // ✅ 处理预检请求（CORS）
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return res.status(204).end();
  }

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { items = [] } = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: "No items" });
    }

    // ✅ Stripe 价格使用前端传递的 unitPrice（需是折扣后、number类型）
    const line_items = items.map((it, index) => {
      const price = parseFloat(it.unitPrice);
      if (!price || isNaN(price)) {
        throw new Error(`❌ Invalid price for item[${index}]: ${it.unitPrice}`);
      }

      return {
        quantity: it.quantity || 1,
        price_data: {
          currency: CURRENCY,
          unit_amount: Math.round(price * 100),
          product_data: {
            name: it.title || "Product",
            metadata: {
              variantId: String(it.variantId || ""),
            },
          },
        },
      };
    });

    // ✅ 创建 Stripe Checkout 会话（语言英文，允许客户输入折扣码，但不自动套用）
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card", "afterpay_clearpay", "link"], // ✅ 无 Klarna

      line_items,

      locale: LOCALE, // ✅ 支付页面为英文
      billing_address_collection: BILLING_COLLECTION,
      automatic_tax: { enabled: true },

      shipping_address_collection: {
        allowed_countries: SHIPPING_COUNTRIES,
      },
      ...(DEFAULT_SHIPPING_RATE_ID
        ? { shipping_options: [{ shipping_rate: DEFAULT_SHIPPING_RATE_ID }] }
        : {}),

      // ✅ 只允许客户在页面输入折扣码（如 BUY1GET1FREE），我们不自动使用 discounts
      allow_promotion_codes: true,

      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error("❌ create-checkout-session error:", error);
    return res.status(500).json({ error: "create session failed" });
  }
}
