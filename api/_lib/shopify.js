import axios from "axios";

const SHOP_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

export async function getVariant(variantId) {
  const url = `https://${SHOP_DOMAIN}/admin/api/2024-10/variants/${variantId}.json`;
  const res = await axios.get(url, {
    headers: { "X-Shopify-Access-Token": ADMIN_TOKEN },
  });
  return res.data.variant; // {price, title, product_id ...}
}

export async function lookupShopifyDiscount(code) {
  try {
    const lookup = await axios.get(
      `https://${SHOP_DOMAIN}/admin/api/2024-10/discount_codes/lookup.json?code=${encodeURIComponent(code)}`,
      { headers: { "X-Shopify-Access-Token": ADMIN_TOKEN } }
    );
    const priceRuleId = lookup.data?.discount_code?.price_rule_id;
    if (!priceRuleId) return null;

    const pr = await axios.get(
      `https://${SHOP_DOMAIN}/admin/api/2024-10/price_rules/${priceRuleId}.json`,
      { headers: { "X-Shopify-Access-Token": ADMIN_TOKEN } }
    );
    return { priceRule: pr.data.price_rule, discountCode: lookup.data.discount_code };
  } catch {
    return null;
  }
}