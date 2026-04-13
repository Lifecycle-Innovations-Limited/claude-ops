import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`, {
    fulfillmentId: payload.id,
    orderId: payload.order_id,
    status: payload.status,
    trackingNumber: payload.tracking_number,
  });

  // TODO: Handle fulfillment creation — notify customer, update status, etc.

  return new Response();
};
