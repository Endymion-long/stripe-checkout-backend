import Stripe from "stripe";
import { getVariant, lookupShopifyDiscount } from "./_lib/shopify.js";

const stripe = new Stripe(process.env.STIRPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY);
const CURRENCY = process.env.CURRENCY || "usd";

async function ensureStripePromotionForShopifyCode(code, priceRule) {
  const { value_type, value, prerequisite_subtotal_range } = priceRule;

  // Already exists?
  const existing = await stripe.promotionCodes.list({ code, limit: 1 });
  if (existing.data?.[0]) return existing.data[0].id;

  let coupon;
  if (value_type === "percentage") {
    coupon = await stripe.coupons.create({ percent_off: Math.abs(parseFloat(value)), duration: "once" });
  } else if (value_type === "fixed_amount") {
    coupon = await stripe.coupons.create({
      amount_off: Math.round(Math.abs(parseFloat(value)) * 100),
      currency: CURRENCY,
      duration: "once",
    });
  } else {
    return null;
  }

  const restrictions = {};
  if (prerequisite_subtotal_range?.greater_than_or_equal_to) {
    restrictions.minimum_amount = Math.round(parseFloat(prerequisite_subtotal_range.greater_than_or_equal_to) * 100);
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
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { items = [], promo } = req.body; // items: [{variantId, quantity}]
    if (!items.length) return res.status(400).json({ error: "No items" });

    // Build line_items from Shopify prices
    const line_items = [];
    for (const it of items) {
      const v = await getVariant(it.variantId);
      line_items.push({
        quantity: it.quantity,
        price_data: {
          currency: CURRENCY,
          unit_amount: Math.round(parseFloat(v.price) * 100),
          product_data: {
            name: v.title,
            metadata: { variantId: String(it.variantId), shopify_product_id: String(v.product_id) },
          },
        },
      });
    }

    let discounts;
    if (promo) {
      const found = await lookupShopifyDiscount(promo);
      if (found?.priceRule) {
        const promoId = await ensureStripePromotionForShopifyCode(promo, found.priceRule);
        if (promoId) discounts = [{ promotion_code: promoId }];
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card", "afterpay_clearpay", "klarna", "link"],
      line_items,
      automatic_tax: { enabled: true },
      shipping_address_collection: { allowed_countries: ["US", "CA", "GB", "AU", "DE"] },
      shipping_options: process.env.DEFAULT_SHIPPING_RATE_ID
        ? [{ shipping_rate: process.env.DEFAULT_SHIPPING_RATE_ID }]
        : undefined,
      discounts,
      success_url: "https://yourdomain.com/checkout/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://yourdomain.com/checkout/cancel",
    });

    res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("create session error", e?.response?.data || e.message);
    res.status(500).json({ error: "create session failed" });
  }
}