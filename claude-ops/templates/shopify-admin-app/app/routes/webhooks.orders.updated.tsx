import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`, {
    orderId: payload.id,
    financialStatus: payload.financial_status,
    fulfillmentStatus: payload.fulfillment_status,
  });

  // TODO: Handle order updates — status changes, cancellations, refunds, etc.

  return new Response();
};
