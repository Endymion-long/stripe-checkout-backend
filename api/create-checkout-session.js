// api/create-checkout-session.js
import Stripe from "stripe";
import { getVariant } from "./_lib/shopify.js"; // ✅ 用于后端兜底拿变体价格

const stripe   = new Stripe(process.env.STRIPE_SECRET_KEY);
const CURRENCY = (process.env.CURRENCY || "usd").toLowerCase();

const SUCCESS_URL =
  process.env.SUCCESS_URL ||
  "https://evermois.com/pages/stripe-success?session_id={CHECKOUT_SESSION_ID}";
const CANCEL_URL  = process.env.CANCEL_URL || "https://evermois.com/cart";

const ORIGINS = (process.env.ALLOWED_ORIGINS || "https://evermois.com,https://www.evermois.com")
  .split(",").map(s => s.trim()).filter(Boolean);

const DEFAULT_SHIPPING_RATE_ID = process.env.DEFAULT_SHIPPING_RATE_ID || "";
const SHIPPING_COUNTRIES = (process.env.SHIPPING_COUNTRIES || "US,CA,GB,AU,DE")
  .split(",").map(s => s.trim()).filter(Boolean);

const LOCALE = "en";                         // ✅ 强制英文
const BILLING_COLLECTION = process.env.BILLING_COLLECTION || "auto";

// —— CORS —— //
function pickOrigin(req){
  const origin = req.headers.origin || "";
  if (ORIGINS.includes("*")) return "*";
  return ORIGINS.includes(origin) ? origin : ORIGINS[0] || "*";
}

// —— 价格规范化：数字/字符串/带逗号小数都能处理 —— //
function normalizeUnitPrice(v){
  if (v === 0) return 0;
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string"){
    const cleaned = v
      .replace(/[^\d,.\-]/g, "")  // 去掉货币符号、空格
      .replace(",", ".");         // 欧式逗号小数转点
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export default async function handler(req, res){
  const allowOrigin = pickOrigin(req);

  // 预检
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
    const { items = [] } = req.body; // 前端理想传：[{ variantId, quantity, unitPrice, title }]
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items" });
    }

    console.log("🟢 incoming items:", JSON.stringify(items));

    const line_items = [];
    for (let i = 0; i < items.length; i++){
      const it = items[i] || {};
      const variantId = it.variantId;
      let quantity = parseInt(it.quantity, 10);
      if (!Number.isFinite(quantity) || quantity <= 0) quantity = 1;

      // 1) 优先用前端传来的折扣后单价
      let unitPrice = normalizeUnitPrice(it.unitPrice);

      // 2) 如果前端没传或解析失败 → 后端兜底：查 Shopify 变体原价
      if (unitPrice == null) {
        if (!variantId) throw new Error(`❌ item[${i}] missing variantId and unitPrice`);
        const v = await getVariant(variantId);
        if (!v?.price) throw new Error(`❌ item[${i}] fallback failed: variant ${variantId} has no price`);
        unitPrice = parseFloat(v.price); // v.price 是字符串（单位：元）
        console.log(`ℹ️ item[${i}] fallback price from Shopify variant:`, unitPrice);
      }

      if (!Number.isFinite(unitPrice)) {
        throw new Error(`❌ Invalid price for item[${i}]: ${it.unitPrice}`);
      }

      const unitAmount = Math.round(unitPrice * 100); // 转为分的整数
      if (!Number.isFinite(unitAmount)) {
        throw new Error(`❌ Invalid unit_amount for item[${i}]: ${unitAmount}`);
      }

      line_items.push({
        quantity,
        price_data: {
          currency: CURRENCY,
          unit_amount: unitAmount,
          product_data: {
            name: it.title || "Product",
            metadata: {
              variantId: String(variantId || ""),
            },
          },
        },
      });
    }

    // 创建 Session（✅ 无 Klarna，✅ 英文，✅ 支持用户在页面输入促销码）
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card", "afterpay_clearpay", "link"], // ✅ 无 klarna；Apple/Google Pay 属于 card

      line_items,

      locale: LOCALE, // ✅ 全英文
      billing_address_collection: BILLING_COLLECTION,
      automatic_tax: { enabled: true },

      shipping_address_collection: { allowed_countries: SHIPPING_COUNTRIES },
      ...(DEFAULT_SHIPPING_RATE_ID
        ? { shipping_options: [{ shipping_rate: DEFAULT_SHIPPING_RATE_ID }] }
        : {}),

      allow_promotion_codes: true, // ✅ 让客户输入 BUY1GET1FREE

      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
    });

    console.log("✅ stripe session created:", session.id);
    return res.status(200).json({ url: session.url });

  } catch (e) {
    console.error("❌ create-checkout-session error:", e?.raw || e);
    return res.status(500).json({ error: "create session failed" });
  }
}
