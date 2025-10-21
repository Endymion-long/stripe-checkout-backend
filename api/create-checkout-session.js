// api/create-checkout-session.js
import Stripe from "stripe";
import { getVariant } from "./_lib/shopify.js";

const stripe   = new Stripe(process.env.STRIPE_SECRET_KEY || process.env.STIRPE_SECRET_KEY);
const CURRENCY = (process.env.CURRENCY || "usd").toLowerCase();

const SUCCESS_URL = process.env.SUCCESS_URL ||
  "https://evermois.com/pages/stripe-success?session_id={CHECKOUT_SESSION_ID}";
const CANCEL_URL  = process.env.CANCEL_URL  || "https://evermois.com/cart";

// 允许的前端来源（供 CORS）
const ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "*")
  .split(",").map(s => s.trim()).filter(Boolean);

// 物流与结账体验
const DEFAULT_SHIPPING_RATE_ID = process.env.DEFAULT_SHIPPING_RATE_ID || "";
const SHIPPING_COUNTRIES = (process.env.SHIPPING_COUNTRIES ||
  "US,CA,GB,AU,DE,FR,IT,ES,NL,SE,DK,IE,AT,BE")
  .split(",").map(s => s.trim()).filter(Boolean);

const LOCALE = process.env.CHECKOUT_LOCALE || "auto";
const BILLING_COLLECTION = process.env.BILLING_COLLECTION || "auto";

function pickOrigin(req) {
  const origin = req.headers.origin || "";
  if (ORIGINS.includes("*")) return "*";
  return ORIGINS.includes(origin) ? origin : ORIGINS[0] || "*";
}

export default async function handler(req, res) {
  const allowOrigin = pickOrigin(req);

  // 预检
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return res.status(204).end();
  }

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { items = [] } = req.body; // 不再接收 promo
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "No items" });

    // 变体价格 -> line_items
    const line_items = [];
    for (const it of items) {
      if (!it?.variantId || !it?.quantity) continue;
      const v = await getVariant(it.variantId);            // 取 Shopify 变体实时价格
      const unitAmount = Math.round(parseFloat(v.price) * 100);
      line_items.push({
        quantity: it.quantity,
        price_data: {
          currency: CURRENCY,
          unit_amount: unitAmount,
          product_data: {
            name: v.title,
            metadata: {
              variantId: String(it.variantId),
              shopify_product_id: String(v.product_id),
            },
          },
        },
      });
    }
    if (!line_items.length) return res.status(400).json({ error: "Invalid items" });

    // 创建 Session（✅只允许用户在页面输入优惠码）
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card", "afterpay_clearpay", "link"], // Apple Pay/Google Pay 属于 card wallet
      line_items,

      // 体验/合规
      locale: LOCALE,
      billing_address_collection: BILLING_COLLECTION,
      automatic_tax: { enabled: true },

      // 收货地址/运费
      shipping_address_collection: { allowed_countries: SHIPPING_COUNTRIES },
      ...(DEFAULT_SHIPPING_RATE_ID
        ? { shipping_options: [{ shipping_rate: DEFAULT_SHIPPING_RATE_ID }] }
        : {}),

      // ✅ 只打开优惠码输入框，不预设任何折扣
      allow_promotion_codes: true,

      // 回跳
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
    });

    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("create-checkout-session error:", e?.raw || e?.message || e);
    return res.status(500).json({ error: "create session failed" });
  }
}
