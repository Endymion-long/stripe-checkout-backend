// api/webhooks-stripe.js
import Stripe from "stripe";

// Vercel/Node: 读取原始请求体，供 Stripe 验签
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || process.env.STIRPE_SECRET_KEY);

async function createShopifyOrderFromSession(session) {
  // 拉取完整 line_items，并取我们写入的 variantId
  const full = await stripe.checkout.sessions.retrieve(session.id, {
    expand: ["line_items.data.price.product"],
  });

  const items = [];
  for (const li of full?.line_items?.data || []) {
    const variantId = li?.price?.product?.metadata?.variantId;
    const qty = li?.quantity || 1;
    if (variantId) items.push({ variant_id: Number(variantId), quantity: qty });
  }

  const sd = session.shipping_details || {};
  const addr = sd.address || {};
  const [first = ""] = (sd.name || "").split(" ");
  const last = (sd.name || "").split(" ").slice(1).join(" ");

  const payload = {
    order: {
      email: session.customer_details?.email || "",
      financial_status: "paid",
      currency: (session.currency || "usd").toUpperCase(),
      line_items: items,
      shipping_address: {
        first_name: first,
        last_name: last,
        address1: addr.line1 || addr.line_1 || "",
        address2: addr.line2 || addr.line_2 || "",
        city: addr.city || "",
        province: addr.state || addr.province || "",
        country: addr.country || "",
        zip: addr.postal_code || addr.zip || "",
        phone: session.customer_details?.phone || "",
      },
      note: `Stripe session: ${session.id}`,
    },
  };

  const resp = await fetch(
    `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-07/orders.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
      },
      body: JSON.stringify(payload),
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    console.error("Shopify order create failed:", resp.status, text);
    throw new Error(`Shopify order create failed: ${resp.status}`);
  }

  const data = await resp.json();
  console.log("Shopify order created:", data?.order?.id);
  return data?.order;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const signature = req.headers["stripe-signature"];
  let event;

  try {
    const raw = await getRawBody(req);
    event = stripe.webhooks.constructEvent(raw, signature, process.env.WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      await createShopifyOrderFromSession(session);
    }
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error("Webhook handler error:", e?.message || e);
    return res.status(500).json({ error: "webhook handler failed" });
  }
}
