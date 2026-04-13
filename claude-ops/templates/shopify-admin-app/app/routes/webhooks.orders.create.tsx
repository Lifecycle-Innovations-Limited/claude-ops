import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`, {
    orderId: payload.id,
    totalPrice: payload.total_price,
  });

  // TODO: Process new order — sync to your system, trigger fulfillment, etc.

  return new Response();
};
