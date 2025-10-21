// api/create-checkout-session.js
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const CURRENCY = (process.env.CURRENCY || "usd").toLowerCase();

const SUCCESS_URL = process.env.SUCCESS_URL || "https://evermois.com/pages/stripe-success?session_id={CHECKOUT_SESSION_ID}";
const CANCEL_URL = process.env.CANCEL_URL || "https://evermois.com/cart";

const ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "https://evermois.com")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const DEFAULT_SHIPPING_RATE_ID = process.env.DEFAULT_SHIPPING_RATE_ID || "";
const SHIPPING_COUNTRIES = (process.env.SHIPPING_COUNTRIES || "US,CA,GB,AU,DE")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const LOCALE = "en"; // ✅ 强制为英文
const BILLING_COLLECTION = process.env.BILLING_COLLECTION || "auto";

function pickOrigin(req) {
  const origin = req.headers.origin || "";
  if (ORIGINS.includes("*")) return "*";
  return ORIGINS.includes(origin) ? origin : ORIGINS[0] || "*";
}

export default async function handler(req, res) {
  const allowOrigin = pickOrigin(req);

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
    const { items = [] } = req.body; // 前端需传：[{ variantId, quantity, unitPrice, title }]
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items" });
    }

    // ✅ 直接使用前端传递的最终价格（含折扣）
    const line_items = items.map(it => ({
      quantity: it.quantity || 1,
      price_data: {
        currency: CURRENCY,
        unit_amount: Math.round(parseFloat(it.unitPrice) * 100), // ✅ Shopify 折扣后价格
        product_data: {
          name: it.title || "Product",
          metadata: {
            variantId: String(it.variantId || "")
          }
        }
      }
    }));

    // ✅ 创建 Session（无折扣参数、无 Klarna）
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card", "afterpay_clearpay", "link"], // ✅ 无 klarna
      line_items,

      locale: LOCALE, // ✅ 强制英文
      billing_address_collection: BILLING_COLLECTION,
      automatic_tax: { enabled: true },

      shipping_address_collection: {
        allowed_countries: SHIPPING_COUNTRIES,
      },
      ...(DEFAULT_SHIPPING_RATE_ID
        ? { shipping_options: [{ shipping_rate: DEFAULT_SHIPPING_RATE_ID }] }
        : {}),

      allow_promotion_codes: true, // ✅ 用户可自己输入折扣码（但不强制使用 Stripe 自动折扣）

      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
    });

    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("❌ create-checkout-session error:", e);
    return res.status(500).json({ error: "create session failed" });
  }
}
