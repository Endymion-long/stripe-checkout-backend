import Stripe from "stripe";
import axios from "axios";

const stripe = new Stripe(process.env.STIRPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY);
const SHOP_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const CURRENCY = process.env.CURRENCY || "usd";

export const config = {
  api: { bodyParser: false },
};

function readRawBody(req) {
  return new Promise((resolve) => {
    let data = Buffer.from("");
    req.on("data", (chunk) => (data = Buffer.concat([data, chunk])));
    req.on("end", () => resolve(data));
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const raw = await readRawBody(req);
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, process.env.WEBHOOK_SECRET);
  } catch (e) {
    console.error("Invalid signature", e.message);
    return res.status(400).send("Bad signature");
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    try {
      const li = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
      const orderLineItems = li.data.map((x) => ({
        title: x.description,
        quantity: x.quantity,
        price: (x.amount_subtotal / x.quantity / 100).toFixed(2),
      }));

      const payload = {
        order: {
          email: session.customer_details?.email,
          financial_status: "paid",
          currency: (session.currency || CURRENCY).toUpperCase(),
          total_price: (session.amount_total / 100).toFixed(2),
          shipping_address: {
            first_name: session.customer_details?.name?.split(" ")?.[0] || "",
            last_name: session.customer_details?.name?.split(" ")?.slice(1).join(" ") || "",
            address1: session.customer_details?.address?.line1 || "",
            address2: session.customer_details?.address?.line2 || "",
            city: session.customer_details?.address?.city || "",
            country: session.customer_details?.address?.country || "",
            zip: session.customer_details?.address?.postal_code || "",
            phone: session.customer_details?.phone || "",
          },
          line_items: orderLineItems,
          note: `Stripe session: ${session.id} | PM: ${session.payment_method_types?.join(",")}`,
        },
      };

      const url = `https://${SHOP_DOMAIN}/admin/api/2024-10/orders.json`;
      await axios.post(url, payload, {
        headers: { "X-Shopify-Access-Token": ADMIN_TOKEN },
      });

    } catch (e) {
      console.error("Create order failed", e?.response?.data || e.message);
    }
  }

  res.status(200).end();
}