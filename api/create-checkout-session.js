// api/create-checkout-session.js
import Stripe from "stripe";
import { getVariant, lookupShopifyDiscount } from "./_lib/shopify.js";

// 兼容写法：优先 STRIPE_SECRET_KEY
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || process.env.STIRPE_SECRET_KEY);
const CURRENCY = process.env.CURRENCY || "usd";

/**
 * 允许跨域的来源（逗号分隔）:
 * 例：ALLOWED_ORIGINS="https://evemois.com,https://www.evemois.com,https://evemois.myshopify.com"
 * 调试也可先用 * ，但上线务必改成你的域名
 */
const ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function pickOrigin(req) {
  const origin = req.headers.origin || "";
  if (ORIGINS.includes("*")) return "*";
  return ORIGINS.includes(origin) ? origin : ORIGINS[0] || "*";
}

/** 将 Shopify 的简单折扣（百分比 / 固定减 + 最低门槛）映射为 Stripe Promotion Code */
async function ensureStripePromotionForShopifyCode(code, priceRule) {
  const { value_type, value, prerequisite_subtotal_range } = priceRule;

  // 已存在就复用
  const existing = await stripe.promotionCodes.list({ code, limit: 1 });
  if (existing.data?.[0]) return existing.data[0].id;

  // 仅支持两类基础优惠：百分比 或 固定金额（一次性）
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
    return null; // 复杂规则不映射（需要后端自算）
  }

  // 最低订单金额（可选）
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

export default async function handler(req, res) {
  const allowOrigin = pickOrigin(req);

  // 处理 CORS 预检
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return res.status(204).end();
  }

  // 正式响应也加 CORS
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { items = [], promo } = req.body; // items: [{variantId, quantity}]
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items" });
    }

    // 1) 以 Shopify 价格为准构建 line_items
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
            // 把变体信息放 metadata，便于后续 webhook 精确回写/扣库存
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

    // 2) 处理折扣：把可映射的 Shopify 折扣转成 Stripe Promotion Code
    let discounts;
    if (promo) {
      const found = await lookupShopifyDiscount(promo);
      if (found?.priceRule) {
        const promoId = await ensureStripePromotionForShopifyCode(promo, found.priceRule);
        if (promoId) discounts = [{ promotion_code: promoId }];
      }
      // 查不到或不支持的规则：忽略（也可返回提示由你决定）
    }

    // 3) 创建 Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card", "afterpay_clearpay", "klarna", "link"], // Apple Pay/Google Pay 属于 card wallet，会自动显示
      line_items,
      automatic_tax: { enabled: true },
      shipping_address_collection: { allowed_countries: ["US", "CA", "GB", "AU", "DE"] },
      shipping_options: process.env.DEFAULT_SHIPPING_RATE_ID
        ? [{ shipping_rate: process.env.DEFAULT_SHIPPING_RATE_ID }]
        : undefined,
      discounts, // 可能为空
      // ↓ 把你的成功/取消页换成你的域名
      success_url: "https://yourdomain.com/checkout/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://yourdomain.com/checkout/cancel",
    });

    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("create session error", e?.response?.data || e.message);
    return res.status(500).json({ error: "create session failed" });
  }
}
