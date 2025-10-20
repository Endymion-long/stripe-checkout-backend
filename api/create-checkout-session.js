// api/create-checkout-session.js
import Stripe from "stripe";
import { getVariant, lookupShopifyDiscount } from "./_lib/shopify.js";

// ---------- Config from ENV ----------
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || process.env.STIRPE_SECRET_KEY);
const CURRENCY = (process.env.CURRENCY || "usd").toLowerCase();

// 回跳地址（务必为 https 绝对地址；success_url 必须包含 {CHECKOUT_SESSION_ID}）
const SUCCESS_URL =
  process.env.SUCCESS_URL ||
  "https://evermois.com/pages/stripe-success?session_id={CHECKOUT_SESSION_ID}";
const CANCEL_URL = process.env.CANCEL_URL || "https://evermois.com/cart";

// 允许的前端来源（多个域名用逗号）
// 例：ALLOWED_ORIGINS="https://evermois.com,https://www.evermois.com,https://evermois.myshopify.com"
const ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// 运费（可选）：在 Stripe Dashboard 建好 Shipping rate，拿到 shr_xxx 放到 DEFAULT_SHIPPING_RATE_ID
const DEFAULT_SHIPPING_RATE_ID = process.env.DEFAULT_SHIPPING_RATE_ID || "";

// 可运国家（ISO 两位代码，逗号分隔），没配就用一个常用集合
const SHIPPING_COUNTRIES = (process.env.SHIPPING_COUNTRIES ||
  "US,CA,GB,AU,DE,FR,IT,ES,NL,SE,DK,IE,AT,BE")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// 结账页语言/地址收集策略（可按需改）
const LOCALE = process.env.CHECKOUT_LOCALE || "en";        // 'auto' | 'en' | 'de' | ...
const BILLING_COLLECTION = process.env.BILLING_COLLECTION || "auto"; // 'auto' or 'required'

// ---------- Helpers ----------
function pickOrigin(req) {
  const origin = req.headers.origin || "";
  if (ORIGINS.includes("*")) return "*";
  return ORIGINS.includes(origin) ? origin : ORIGINS[0] || "*";
}

// 仅支持“百分比 / 固定减 + 最低金额”的基础折扣；复杂规则需后端自算
async function ensureStripePromotionForShopifyCode(code, priceRule) {
  const { value_type, value, prerequisite_subtotal_range } = priceRule;

  // 已存在则直接用
  const existing = await stripe.promotionCodes.list({ code, limit: 1 });
  if (existing.data?.[0]) return existing.data[0].id;

  let coupon;
  if (value_type === "percentage") {
    coupon = await stripe.coupons.create({
      percent_off: Math.abs(parseFloat(value)),
      duration: "once",
    });
  } else if (value_type === "fixed_amount") {
    coupon = await stripe.coupons.create({
      amount_off: Math.round(Math.abs(parseFloat(value)) * 100), // cents
      currency: CURRENCY,
      duration: "once",
    });
  } else {
    return null; // 其它复杂规则：不映射
  }

  const restrictions = {};
  if (prerequisite_subtotal_range?.greater_than_or_equal_to) {
    restrictions.minimum_amount = Math.round(
      parseFloat(prerequisite_subtotal_range.greater_than_or_equal_to) * 100
    );
    restrictions.minimum_amount_currency = CURRENCY;
  }

  const promo = await stripe.promotionCodes.create({
    code,
    coupon: coupon.id,
    ...(Object.keys(restrictions).length ? { restrictions } : {}),
  });
  return promo.id;
}

// ---------- Route Handler ----------
export default async function handler(req, res) {
  const allowOrigin = pickOrigin(req);

  // CORS 预检
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return res.status(204).end();
  }

  // CORS for actual response
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { items = [], promo } = req.body; // items: [{ variantId, quantity }]
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items" });
    }

    // 1) 按 Shopify 变体实价构建 line_items
    const line_items = [];
    for (const it of items) {
      if (!it?.variantId || !it?.quantity) continue;
      const v = await getVariant(it.variantId); // { price, title, product_id, ... }
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
    if (!line_items.length) {
      return res.status(400).json({ error: "Invalid items" });
    }

    // 2) 折扣映射（可选）
    let discounts;
    if (promo) {
      const found = await lookupShopifyDiscount(promo);
      if (found?.priceRule) {
        const promoId = await ensureStripePromotionForShopifyCode(promo, found.priceRule);
        if (promoId) discounts = [{ promotion_code: promoId }];
      }
    }

    // 3) 创建 Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      // Apple Pay / Google Pay 属于 card 的 wallet，会自动显示
      payment_method_types: ["card", "afterpay_clearpay", "link"],
      line_items,

      // 体验/合规
      locale: LOCALE,
      billing_address_collection: BILLING_COLLECTION,
      automatic_tax: { enabled: true },

      // 运送/地址
      shipping_address_collection: { allowed_countries: SHIPPING_COUNTRIES },
      shipping_options: DEFAULT_SHIPPING_RATE_ID ? [{ shipping_rate: DEFAULT_SHIPPING_RATE_ID }] : undefined,

      // 折扣（可能为空）
      discounts,

      // 回跳
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
    });

    // 返回跳转链接
    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("create-checkout-session error:", e?.raw || e?.message || e);
    return res.status(500).json({ error: "create session failed" });
  }
}
