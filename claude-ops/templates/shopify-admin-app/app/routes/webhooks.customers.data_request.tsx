import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} compliance webhook for ${shop}`, {
    customerId: payload.customer?.id,
    email: payload.customer?.email,
  });

  // MANDATORY: Respond to customer data request within 30 days.
  // Return all stored data for this customer.
  // See: https://shopify.dev/docs/apps/build/privacy-law-compliance

  return new Response();
};
